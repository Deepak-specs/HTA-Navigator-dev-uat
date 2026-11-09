"""
build_search_index.py
=====================
Populates the Azure AI Search index from what the ingest pipeline already wrote
to Neo4j. One search document per page:

    (:TranslatedDocuments)-[:HAS_PAGES]->(:DocumentPages {pages_en})
        -> {id, content, contentVector, title, source, page_number}

Reusing the translated pages means no PDF is re-parsed and no page is
re-translated -- that work is already paid for and sitting in the graph.

    python build_search_index.py --all --dry-run     # plan only, embeds nothing
    python build_search_index.py --all --limit 1     # one document, end to end
    python build_search_index.py --match eculizumab
    python build_search_index.py --all               # everything not yet indexed

Every setting comes from config.toml next to this script: the Neo4j connection,
the search endpoint/key/index, and the AZ gateway used for embeddings.

Embedding calls cost money. A dry run is free; a real run embeds every page it
has not already indexed, so start with --limit 1.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

import toml

HERE = Path(__file__).resolve().parent
API_VERSION = "2024-07-01"

# text-embedding-3-large accepts ~8191 tokens. Pages are normally far smaller;
# this only guards against a pathological page and keeps the call from failing.
MAX_EMBED_CHARS = 24000

# 3072 floats serialise to roughly 24 KB, so 100 documents stays well inside the
# service's 16 MB request ceiling.
UPLOAD_BATCH = 100

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except (AttributeError, OSError):
    pass


def load_config() -> dict:
    path = HERE / "config.toml"
    if not path.exists():
        sys.exit(f"config.toml not found next to this script ({path})")
    cfg = toml.load(path)
    needed = ["NEO4J_URI", "NEO4J_USER", "NEO4J_PASSWORD",
              "search_endpoint", "search_key", "index_name",
              "AZ_API_KEY", "AZ_GATEWAY_URL", "EMBED_API_VERSION", "EMBED_MODEL"]
    missing = [k for k in needed if not cfg.get(k)]
    if missing:
        sys.exit(f"config.toml is missing: {', '.join(missing)}")
    return cfg


# --------------------------------------------------------------------------- #
# Neo4j: what has been ingested
# --------------------------------------------------------------------------- #
def fetch_documents(cfg: dict, names, match, limit):
    from neo4j import GraphDatabase

    where, params = [], {}
    if names:
        where.append("t.blob_name IN $names")
        params["names"] = list(names)
    if match:
        where.append("ANY(w IN $match WHERE toLower(t.blob_name) CONTAINS toLower(w))")
        params["match"] = list(match)
    clause = ("WHERE " + " AND ".join(where)) if where else ""

    cypher = f"""
        MATCH (t:TranslatedDocuments)-[:HAS_PAGES]->(p:DocumentPages)
        {clause}
        RETURN t.id AS id, t.blob_name AS blob_name, t.title_nl AS title,
               t.status AS status, p.pages_en AS pages_en
        ORDER BY t.blob_name
    """
    driver = GraphDatabase.driver(
        cfg["NEO4J_URI"], auth=(cfg["NEO4J_USER"], cfg["NEO4J_PASSWORD"]))
    try:
        driver.verify_connectivity()
        records, _, _ = driver.execute_query(
            cypher, params, database_=cfg.get("NEO4J_DATABASE", "neo4j"), routing_="r")
        docs = [r.data() for r in records]
    finally:
        driver.close()

    if limit:
        docs = docs[:limit]
    return docs


# --------------------------------------------------------------------------- #
# Azure AI Search
# --------------------------------------------------------------------------- #
def existing_ids(cfg: dict) -> set[str]:
    """Every key already in the index, read in pages of 1000."""
    ep, key, name = cfg["search_endpoint"].rstrip("/"), cfg["search_key"], cfg["index_name"]
    found, skip = set(), 0
    while True:
        body = json.dumps({"search": "*", "select": "id", "top": 1000, "skip": skip}).encode()
        req = urllib.request.Request(
            f"{ep}/indexes/{name}/docs/search?api-version={API_VERSION}",
            data=body, headers={"api-key": key, "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                page = json.loads(r.read().decode())
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", "replace")[:200]
            sys.exit(f"Could not read the index: HTTP {exc.code}\n  {body}")
        rows = page.get("value", [])
        found.update(d["id"] for d in rows if d.get("id"))
        if len(rows) < 1000:
            return found
        skip += 1000
        if skip >= 100000:   # the service's paging ceiling
            print("   WARNING: stopped scanning existing ids at 100,000")
            return found


def chunk_id(doc_id: str, page_no: int) -> str:
    # Search keys allow letters, digits, underscore, dash and equals. The Neo4j
    # id is a uuid, so it is already safe.
    return f"{doc_id}_p{page_no}"


def plan(docs, already: set[str], force: bool):
    """-> [(doc, [(chunk_id, page_no, text), ...])], skipping pages already indexed."""
    out = []
    for d in docs:
        pages = d.get("pages_en") or []
        chunks = []
        for i, text in enumerate(pages, start=1):
            if not text or not text.strip():
                continue                       # blank page, nothing to embed
            cid = chunk_id(d["id"], i)
            if cid in already and not force:
                continue
            chunks.append((cid, i, text.strip()))
        if chunks:
            out.append((d, chunks))
    return out


def embed(client, model: str, text: str) -> list[float]:
    if len(text) > MAX_EMBED_CHARS:
        text = text[:MAX_EMBED_CHARS]
    # One page per call, matching the pattern function_app.py already uses
    # successfully against this gateway.
    resp = client.embeddings.create(input=text, model=model)
    return resp.data[0].embedding


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sel = ap.add_argument_group("what to index (one is required)")
    sel.add_argument("--all", action="store_true", help="every translated document")
    sel.add_argument("--names", nargs="+", help="exact blob names")
    sel.add_argument("--match", nargs="+", help="blob names containing any of these words")
    ap.add_argument("--limit", type=int, help="at most N documents")
    ap.add_argument("--dry-run", action="store_true",
                    help="show the plan; embeds nothing and uploads nothing")
    ap.add_argument("--force", action="store_true",
                    help="re-embed and overwrite pages that are already indexed")
    a = ap.parse_args()
    if not (a.all or a.names or a.match):
        print("Choose what to index: --all, --names ... or --match ...")
        return 2

    cfg = load_config()
    print(f"Neo4j  : {cfg['NEO4J_URI']}")
    print(f"Search : {cfg['search_endpoint']} / {cfg['index_name']}")
    print(f"Embed  : {cfg['EMBED_MODEL']} via {cfg['AZ_GATEWAY_URL']}\n")

    docs = fetch_documents(cfg, a.names, a.match, a.limit)
    if not docs:
        print("No matching documents in Neo4j. Has the ingest pipeline run?")
        return 1

    already = existing_ids(cfg)
    print(f"{len(docs)} document(s) selected; {len(already)} page(s) already in the index\n")

    work = plan(docs, already, a.force)
    total_chunks = sum(len(c) for _, c in work)
    for d, chunks in work:
        print(f"  {len(chunks):4d} page(s)  {d['blob_name'][:88]}")
    if not work:
        print("  nothing to do - every page is already indexed (use --force to rebuild)")
        return 0
    print(f"\n{total_chunks} page(s) to embed and upload")

    if a.dry_run:
        print("\n--dry-run: nothing was embedded or uploaded.")
        return 0

    from openai import AzureOpenAI
    from azure.core.credentials import AzureKeyCredential
    from azure.search.documents import SearchClient

    openai_client = AzureOpenAI(api_key=cfg["AZ_API_KEY"],
                                api_version=cfg["EMBED_API_VERSION"],
                                azure_endpoint=cfg["AZ_GATEWAY_URL"])
    search_client = SearchClient(endpoint=cfg["search_endpoint"],
                                 index_name=cfg["index_name"],
                                 credential=AzureKeyCredential(cfg["search_key"]))

    print()
    t0, done, failed, batch = time.time(), 0, 0, []
    for d, chunks in work:
        for cid, page_no, text in chunks:
            try:
                vector = embed(openai_client, cfg["EMBED_MODEL"], text)
            except Exception as exc:   # noqa: BLE001 - one page must not stop the run
                failed += 1
                print(f"   ERROR embedding {d['blob_name'][:50]} p{page_no}: "
                      f"{type(exc).__name__}: {exc}")
                continue
            batch.append({
                "id": cid,
                "content": text,
                "contentVector": vector,
                "title": d.get("title") or d["blob_name"],
                "source": d["blob_name"],
                "page_number": page_no,
            })
            done += 1
            if len(batch) >= UPLOAD_BATCH:
                search_client.upload_documents(documents=batch)
                batch = []
            if done % 25 == 0:
                print(f"   {done}/{total_chunks} pages ({time.time() - t0:.0f}s)")
    if batch:
        search_client.upload_documents(documents=batch)

    print(f"\nIndexed {done} page(s) in {time.time() - t0:.0f}s"
          + (f"; {failed} failed" if failed else ""))
    print("The index updates asynchronously - allow a few seconds before querying.")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
