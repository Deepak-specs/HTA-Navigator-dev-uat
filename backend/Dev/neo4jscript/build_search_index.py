"""
build_search_index.py
=====================
Populates the Azure AI Search index from Neo4j, one chunk per page.

WHY THIS EXISTS
    Neo4j holds all 873 documents and 48,084 pages, but the search index held
    a single 2008 ruling as 20 chunks -- nothing in the codebase ever wrote to
    it. Two things read it, and both were effectively blind:

        search_input()        /api/search-input        the AI answer
        find_similar_rulings()/api/rulings/{id}/similar  "Similar rulings"

    Everything else in the app reads Neo4j directly, which is why the ruling
    list, facets and detail pages looked healthy throughout.

WHAT IT WRITES
    The index schema is fixed and this script matches it exactly:

        id            "<doc_id>-p<page>"  -- deterministic, so a re-run merges
                                             rather than duplicating
        content       the page text
        contentVector 3072-dim embedding (text-embedding-3-large)
        title         the English summary title
        source        the blob name, VERBATIM

    `source` carries two jobs in function_app.py and must not be reformatted:
    generate_blob_sas_url() builds the citation link from it, and
    find_matched_ruling_ids() joins it against the 'name' inside each
    TranslatedDocuments.rawJson metadata blob to decide which rulings the
    answer actually cited. All 873 nodes carry a parseable name.

ENGLISH, NOT DUTCH
    The old 20 chunks held Dutch text. Queries arrive in English and the UI is
    English, so this indexes `pages_en`. Cross-lingual retrieval against Dutch
    was a needless handicap; the Dutch original is still one click away on the
    ruling page.

USAGE
    python build_search_index.py --dry-run          # plan only, no writes
    python build_search_index.py --limit 5          # a few documents first
    python build_search_index.py                    # the whole corpus
    python build_search_index.py --force            # re-embed everything

Resumable: a document whose chunk count already matches is skipped, so an
interrupted run can simply be restarted.
"""
from __future__ import annotations

import argparse
import logging
import os
import sys
import time
import tomllib
from concurrent.futures import ThreadPoolExecutor, as_completed

log = logging.getLogger("hta.index")

# text-embedding-3-large accepts 8191 tokens. Capping the characters keeps a
# rare very long page from failing the batch; HTA pages sit far below it.
MAX_CHARS_PER_CHUNK = 8000
DEFAULT_EMBED_BATCH = 64       # inputs per embeddings call
DEFAULT_UPLOAD_BATCH = 200     # documents per index upload


# --------------------------------------------------------------------------- #
# Config
# --------------------------------------------------------------------------- #
def load_search_config(path: str) -> dict:
    """The search and embedding settings live in backend/config.toml.

    hta_ingest.Settings covers Neo4j and Bedrock but knows nothing about Azure
    AI Search, so those values are read from the same file function_app.py
    uses -- keeping one source of truth rather than a second copy in .env.
    """
    with open(path, "rb") as fh:
        cfg = tomllib.load(fh)
    flat: dict = {}

    def walk(d):
        for k, v in d.items():
            walk(v) if isinstance(v, dict) else flat.__setitem__(k, v)

    walk(cfg)
    missing = [k for k in ("search_endpoint", "search_key", "index_name",
                           "AZ_GATEWAY_URL", "AZ_API_KEY", "EMBED_API_VERSION",
                           "EMBED_MODEL") if not flat.get(k)]
    if missing:
        raise SystemExit(f"config.toml is missing: {', '.join(missing)}")
    return flat


# --------------------------------------------------------------------------- #
# Neo4j
# --------------------------------------------------------------------------- #
def fetch_documents(session, match=None, limit=None):
    """blob_name, id, title and the English pages, newest first."""
    # The WHERE has to sit against the main MATCH. Placed after the OPTIONAL
    # MATCH it binds to that instead, which filters nothing and merely makes
    # `s` null -- the whole corpus comes back regardless of --match.
    cypher = """
    MATCH (t:TranslatedDocuments)-[:HAS_PAGES]->(p:DocumentPages)
    WHERE ($match IS NULL OR toLower(t.blob_name) CONTAINS toLower($match))
    OPTIONAL MATCH (t)-[:HAS_SUMMARY]->(s:SummaryDocuments)
    RETURN t.blob_name AS blob, t.id AS id,
           coalesce(s.title, t.blob_name) AS title,
           coalesce(s.decision_date, '') AS date,
           p.pages_en AS pages
    ORDER BY date DESC
    """
    if limit:
        cypher += " LIMIT $limit"
    return list(session.run(cypher, match=match, limit=limit))


# --------------------------------------------------------------------------- #
# Indexing
# --------------------------------------------------------------------------- #
class Indexer:
    def __init__(self, cfg, *, embed_batch, upload_batch, force):
        import httpx
        from azure.core.credentials import AzureKeyCredential
        from azure.search.documents import SearchClient
        from openai import AzureOpenAI

        self.cfg = cfg
        self.embed_batch = embed_batch
        self.upload_batch = upload_batch
        self.force = force
        self.model = cfg["EMBED_MODEL"]

        self.search = SearchClient(
            endpoint=cfg["search_endpoint"],
            index_name=cfg["index_name"],
            credential=AzureKeyCredential(cfg["search_key"]),
        )
        # pip_system_certs.pth patches the ssl module at interpreter start to
        # read the Windows certificate store. requests and urllib3 cope with
        # it -- which is why Bedrock and Azure Search work -- but httpx, which
        # the openai SDK uses, recurses to death inside
        # SSLContext.verify_mode. Giving the SDK its own unverified client
        # avoids building a context at all. The AZ gateway is already called
        # without verification elsewhere in this pipeline, so this matches the
        # existing posture rather than loosening it.
        self.openai = AzureOpenAI(
            api_key=cfg["AZ_API_KEY"],
            api_version=cfg["EMBED_API_VERSION"],
            azure_endpoint=cfg["AZ_GATEWAY_URL"],
            http_client=httpx.Client(verify=False, timeout=120.0),
        )
        self.chunks_written = 0
        self.embed_calls = 0

    # ------------------------------------------------------------------ #
    def purge(self) -> int:
        """Delete every document in the index.

        The 20 chunks that were there before this script existed use a plain
        uuid as their key, while this script keys on "<doc_id>-p<page>". They
        would therefore not be overwritten, leaving that one 2008 ruling
        indexed twice -- once as stale Dutch text, once as English. Clearing
        first avoids a duplicate that would surface as a repeated citation.
        """
        ids = []
        for r in self.search.search(search_text="*", select=["id"], top=100000):
            ids.append({"id": r["id"]})
        if not ids:
            return 0
        for i in range(0, len(ids), self.upload_batch):
            self.search.delete_documents(documents=ids[i:i + self.upload_batch])

        # Deletes are eventually consistent. Without this wait the first
        # existing_count() calls can still see the documents just removed and
        # skip those blobs as "already indexed" -- which is how the one-page
        # summary document was left out of the first full build.
        for _ in range(30):
            time.sleep(1)
            if (self.search.search(search_text="*", top=0,
                                   include_total_count=True).get_count() or 0) == 0:
                break
        else:
            log.warning("index still reports documents after the purge; "
                        "some may be skipped as already indexed")
        return len(ids)

    def upload(self, docs: list[dict]) -> None:
        """Upload a batch, retrying whatever the service reports as failed.

        merge_or_upload_documents does NOT raise on a partial failure. It
        returns one result per document, and a throttled one comes back with
        succeeded=False and status 503, expecting the caller to retry. The
        first full build ignored those results and silently lost chunks from
        18 documents -- 174 of 185 pages on the worst. Anything still failing
        after the backoff is raised, so the document is reported FAILED rather
        than recorded as complete.
        """
        pending = docs
        for attempt in range(5):
            results = self.search.merge_or_upload_documents(documents=pending)
            failed = {r.key for r in results if not r.succeeded}
            if not failed:
                return
            pending = [d for d in pending if d["id"] in failed]
            log.debug("retrying %d throttled chunks (attempt %d)", len(pending), attempt + 1)
            time.sleep(2 ** attempt)
        raise RuntimeError(f"{len(pending)} chunks still rejected after 5 attempts")

    def existing_count(self, blob: str) -> int:
        """How many chunks the index already holds for this document."""
        escaped = blob.replace("'", "''")        # OData string escaping
        try:
            res = self.search.search(
                search_text="*", filter=f"source eq '{escaped}'",
                top=0, include_total_count=True)
            return res.get_count() or 0
        except Exception as exc:                                   # noqa: BLE001
            log.warning("count failed for %s: %s", blob[:60], exc)
            return 0

    def embed(self, texts: list[str]) -> list[list[float]]:
        vectors: list[list[float]] = []
        for i in range(0, len(texts), self.embed_batch):
            batch = texts[i:i + self.embed_batch]
            resp = self.openai.embeddings.create(input=batch, model=self.model)
            self.embed_calls += 1
            vectors.extend(d.embedding for d in resp.data)
        return vectors

    # ------------------------------------------------------------------ #
    def index_document(self, rec) -> dict:
        blob, doc_id = rec["blob"], rec["id"]
        title, pages = rec["title"], rec["pages"] or []
        out = {"blob": blob, "chunks": 0, "skipped": False, "error": ""}

        wanted = [(n, (t or "").strip()[:MAX_CHARS_PER_CHUNK])
                  for n, t in enumerate(pages, start=1) if (t or "").strip()]
        if not wanted:
            out["skipped"] = True
            return out

        if not self.force and self.existing_count(blob) == len(wanted):
            out["skipped"] = True
            return out

        try:
            vectors = self.embed([t for _, t in wanted])
            docs = [{
                "id":            f"{doc_id}-p{n}",
                "content":       text,
                "contentVector": vec,
                "title":         title,
                "source":        blob,      # verbatim -- see the module docstring
                "page_number":   n,
            } for (n, text), vec in zip(wanted, vectors)]

            for i in range(0, len(docs), self.upload_batch):
                self.upload(docs[i:i + self.upload_batch])
            out["chunks"] = len(docs)
            self.chunks_written += len(docs)
        except Exception as exc:                                   # noqa: BLE001
            out["error"] = f"{type(exc).__name__}: {exc}"[:220]
        return out


# --------------------------------------------------------------------------- #
def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", default=None, help="path to backend/config.toml")
    ap.add_argument("--match", help="only blob names containing this text")
    ap.add_argument("--limit", type=int, help="only the first N documents")
    ap.add_argument("--force", action="store_true", help="re-embed even if already indexed")
    ap.add_argument("--purge", action="store_true",
                    help="delete every document in the index first (use once, for the "
                         "initial build, to clear the legacy chunks)")
    ap.add_argument("--dry-run", action="store_true", help="show the plan, write nothing")
    ap.add_argument("--workers", type=int, default=4, help="parallel documents (default 4)")
    ap.add_argument("--embed-batch", type=int, default=DEFAULT_EMBED_BATCH)
    ap.add_argument("--upload-batch", type=int, default=DEFAULT_UPLOAD_BATCH)
    ap.add_argument("-v", "--verbose", action="store_true")
    a = ap.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if a.verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(name)-15s %(message)s")
    # azure-core logs every response's headers at INFO, which buries the
    # progress lines under a few thousand lines of noise.
    for noisy in ("azure.core.pipeline.policies.http_logging_policy",
                  "azure", "httpx", "openai", "urllib3"):
        logging.getLogger(noisy).setLevel(logging.WARNING)

    here = os.path.dirname(os.path.abspath(__file__))
    cfg_path = a.config or os.path.normpath(os.path.join(here, "..", "..", "config.toml"))
    cfg = load_search_config(cfg_path)
    log.info("config    : %s", cfg_path)
    log.info("index     : %s on %s", cfg["index_name"], cfg["search_endpoint"])
    log.info("embedding : %s", cfg["EMBED_MODEL"])

    from hta_ingest.config import Settings
    from neo4j import GraphDatabase

    settings = Settings.from_env()
    driver = GraphDatabase.driver(
        settings.neo4j_uri, auth=(settings.neo4j_user, settings.neo4j_password))

    with driver.session(database=settings.neo4j_database) as ses:
        records = fetch_documents(ses, match=a.match, limit=a.limit)
        docs = [{"blob": r["blob"], "id": r["id"], "title": r["title"],
                 "pages": r["pages"]} for r in records]

    total_pages = sum(len([p for p in (d["pages"] or []) if (p or "").strip()]) for d in docs)
    log.info("documents : %d   pages with text: %s", len(docs), f"{total_pages:,}")

    if a.dry_run:
        for d in docs[:10]:
            n = len([p for p in (d["pages"] or []) if (p or "").strip()])
            log.info("  %4d pages  %s", n, d["blob"][:84])
        if len(docs) > 10:
            log.info("  ... and %d more", len(docs) - 10)
        log.info("dry run -- nothing written")
        driver.close()
        return 0

    indexer = Indexer(cfg, embed_batch=a.embed_batch,
                      upload_batch=a.upload_batch, force=a.force)

    if a.purge:
        log.warning("purging the index before building ...")
        removed = indexer.purge()
        log.warning("purged %s documents", f"{removed:,}")

    started = time.time()
    done = skipped = failed = 0
    with ThreadPoolExecutor(max_workers=max(1, a.workers)) as pool:
        futures = {pool.submit(indexer.index_document, d): d for d in docs}
        for i, fut in enumerate(as_completed(futures), 1):
            r = fut.result()
            if r["error"]:
                failed += 1
                log.error("[%d/%d] FAILED %s: %s", i, len(docs), r["blob"][:70], r["error"])
            elif r["skipped"]:
                skipped += 1
            else:
                done += 1
            if i % 25 == 0 or i == len(docs):
                rate = i / max(1e-9, time.time() - started)
                left = (len(docs) - i) / max(1e-9, rate)
                log.info("[%d/%d] indexed=%d skipped=%d failed=%d chunks=%s (~%dm left)",
                         i, len(docs), done, skipped, failed,
                         f"{indexer.chunks_written:,}", int(left / 60))

    driver.close()
    log.info("DONE indexed=%d skipped=%d failed=%d chunks=%s embed_calls=%d in %.1fm",
             done, skipped, failed, f"{indexer.chunks_written:,}",
             indexer.embed_calls, (time.time() - started) / 60)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
