"""
zin_advies_ingest.py
====================
Sink-aware ingestion of Zorginstituut Nederland (ZIN) HTA PDFs.
Writes to LocalSink or AzureBlobSink -- selected via --sink flag.

Blob layout in Azure (default containers):

  hta-navigator-preprod/           <- PDFs, flat namespace
      2008-02-25__adalimumab-humira-...__gvs-advies-adalimumab.pdf
      ...

  jsonoutput-preprod/     <- all JSON artefacts
      meta/<pdf-name>.meta.json
      runs/<run-id>.json                   (ingest run manifest)

Usage
-----
    # Azure (default)
    python zin_advies_ingest.py --url-file advies_urls.jsonl

    # Local (for testing)
    python zin_advies_ingest.py --sink local --root C:\\hta --url-file advies_urls.jsonl
"""

from __future__ import annotations

import argparse
import asyncio
import dataclasses
import hashlib
import json
import logging
import os
import re
import sys
import urllib.parse
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

import httpx
from bs4 import BeautifulSoup
from tenacity import (
    retry, retry_if_exception_type, stop_after_attempt, wait_exponential,
)

from zin_sinks import Sink, build_sink, add_sink_args

log = logging.getLogger("zin.ingest")

BASE = "https://www.zorginstituutnederland.nl"
USER_AGENT = os.environ.get(
    "ZIN_USER_AGENT",
    "HTA-Ingest/1.0 (+contact: your.name@yourcompany.com)",
)

PDF_HREF_RE = re.compile(
    r"/site/binaries/site-content/collections/documents/.+?\.pdf$", re.I
)
DETAIL_URL_RE = re.compile(r"/documenten/(\d{4})/(\d{2})/(\d{2})/([^/?#]+)")

MAX_FILENAME = 180
META_PREFIX = "meta/"        # subprefix inside the JSON container
RUNS_PREFIX = "runs/"


# --------------------------------------------------------------------------- #
@dataclasses.dataclass
class Publication:
    page_url: str
    title: str = ""
    issued: str | None = None
    modified: str | None = None
    information_type: str | None = None


@dataclasses.dataclass
class PdfAsset:
    pdf_url: str
    publication: Publication
    filename: str
    etag: str | None = None
    last_modified: str | None = None
    content_length: int | None = None
    sha256: str | None = None


# --------------------------------------------------------------------------- #
def slugify(s: str) -> str:
    s = s.replace("+", "-").replace(" ", "-").lower()
    s = re.sub(r"[^a-z0-9._-]", "-", s)
    s = re.sub(r"-{2,}", "-", s).strip("-.")
    return s


def flat_filename_for(pdf_url: str, pub: Publication) -> str:
    m = DETAIL_URL_RE.search(pub.page_url)
    if m:
        y, mo, d, pub_slug = m.groups()
        date_part = f"{y}-{mo}-{d}"
        pub_slug = slugify(pub_slug)
    else:
        date_part = (pub.issued or "unknown")[:10]
        pub_slug = slugify(pub.title or "unknown")[:60] or "unknown"

    pdf_path = urllib.parse.unquote(urllib.parse.urlparse(pdf_url).path)
    pdf_base = pdf_path.rsplit("/", 1)[-1]
    if not pdf_base.lower().endswith(".pdf"):
        pdf_base += ".pdf"
    stem = slugify(pdf_base[:-4]) or "document"

    filename = f"{date_part}__{pub_slug}__{stem}.pdf"
    if len(filename) <= MAX_FILENAME:
        return filename

    tag = hashlib.sha1(f"{pub.page_url}|{pdf_url}".encode()).hexdigest()[:10]
    fixed = len(date_part) + 4 + 11 + len(stem) + 4
    remaining = MAX_FILENAME - fixed
    if remaining < 10:
        stem = stem[:max(20, MAX_FILENAME - fixed + remaining - 20)]
        remaining = MAX_FILENAME - (len(date_part) + 4 + 11 + len(stem) + 4)
    pub_slug_short = pub_slug[:max(10, remaining)]
    return f"{date_part}__{pub_slug_short}-{tag}__{stem}.pdf"


def meta_blob_name(pdf_name: str) -> str:
    return f"{META_PREFIX}{pdf_name}.meta.json"


# --------------------------------------------------------------------------- #
def load_publications_from_source(
    source: str | Path, sink: Sink, information_type: str,
) -> list[Publication]:
    """
    URL list can come from:
      - a local JSONL file path
      - a blob name inside the JSON container (e.g. 'advies_urls.jsonl')
    """
    text: str | None = None
    p = Path(source)
    if p.exists():
        text = p.read_text(encoding="utf-8")
        log.info("loaded url-file from local disk: %s", p)
    else:
        text = sink.get_text(str(source))
        if text:
            log.info("loaded url-file from JSON container blob: %s", source)

    if not text:
        raise FileNotFoundError(
            f"url-file '{source}' not found locally or in JSON container"
        )

    pubs: list[Publication] = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            d = json.loads(line)
        except json.JSONDecodeError as exc:
            log.warning("skipping malformed line: %s", exc)
            continue
        url = d.get("page_url") or d.get("url")
        if not url:
            continue
        pubs.append(Publication(
            page_url=url,
            title=d.get("title") or "",
            issued=d.get("issued"),
            information_type=information_type,
        ))
    log.info("parsed %d publications from url-file", len(pubs))
    return pubs


# --------------------------------------------------------------------------- #
class PdfResolver:
    def __init__(self, client: httpx.AsyncClient):
        self.client = client

    @retry(
        stop=stop_after_attempt(4),
        wait=wait_exponential(multiplier=1, min=2, max=30),
        retry=retry_if_exception_type((httpx.TransportError, httpx.HTTPStatusError)),
        reraise=True,
    )
    async def _get(self, url: str) -> httpx.Response:
        r = await self.client.get(url)
        if r.status_code in (429, 500, 502, 503, 504):
            r.raise_for_status()
        return r

    async def find_pdfs(self, pub: Publication) -> list[PdfAsset]:
        r = await self._get(pub.page_url)
        r.raise_for_status()
        soup = BeautifulSoup(r.text, "html.parser")

        def meta(name: str) -> str | None:
            t = soup.find("meta", attrs={"name": name})
            return t.get("content") if t else None

        pub.issued = meta("DCTERMS.issued") or pub.issued
        pub.modified = meta("DCTERMS.modified") or pub.modified
        if not pub.title:
            pub.title = (meta("DCTERMS.title") or "").split(" | ")[0]

        assets, seen = [], set()
        for a in soup.find_all("a", href=True):
            href = a["href"]
            if not PDF_HREF_RE.search(urllib.parse.urlparse(href).path):
                continue
            full = href if href.startswith("http") else BASE + href
            if full in seen:
                continue
            seen.add(full)
            assets.append(PdfAsset(
                pdf_url=full, publication=pub,
                filename=flat_filename_for(full, pub),
            ))
        return assets


# --------------------------------------------------------------------------- #
class State:
    """Loads existing PDF + meta inventory from the sink."""
    def __init__(self, sink: Sink):
        self.sink = sink
        self.docs: dict[str, dict] = {}
        self.hashes: dict[str, str] = {}

    def load(self) -> None:
        pdf_names = {b.name for b in self.sink.list_pdfs()}
        metas = self.sink.list_json(prefix=META_PREFIX)
        for m in metas:
            pdf_name = m.name[len(META_PREFIX):-len(".meta.json")]
            if pdf_name not in pdf_names:
                continue
            md = self.sink.get_json(m.name) or {}
            self.docs[pdf_name] = md
            sha = md.get("sha256")
            if sha:
                self.hashes[sha] = pdf_name
        log.info("state: %d existing PDFs, %d known content hashes",
                 len(self.docs), len(self.hashes))


# --------------------------------------------------------------------------- #
class Ingestor:
    def __init__(self, client: httpx.AsyncClient, sink: Sink, state: State,
                 concurrency: int, delay: float, dry_run: bool, force: bool):
        self.client = client
        self.sink = sink
        self.state = state
        self.sem = asyncio.Semaphore(concurrency)
        self.delay = delay
        self.dry_run = dry_run
        self.force = force
        self.stats = dict(new=0, updated=0, skipped=0, dup_content=0, failed=0)
        self.failures: list[dict] = []
        self._processed = 0
        self._total = 0

    def set_total(self, n: int) -> None:
        self._total = n

    async def process(self, asset: PdfAsset) -> None:
        async with self.sem:
            try:
                await self._process(asset)
            except Exception as exc:  # noqa: BLE001
                self.stats["failed"] += 1
                self.failures.append({
                    "filename": asset.filename,
                    "pdf_url": asset.pdf_url,
                    "page_url": asset.publication.page_url,
                    "error": f"{type(exc).__name__}: {exc}",
                })
                log.error("FAILED %s -> %s", asset.pdf_url, exc)
            finally:
                self._processed += 1
                if self._processed % 25 == 0 or self._processed == self._total:
                    log.info("progress: %d/%d  stats=%s",
                             self._processed, self._total, self.stats)
                await asyncio.sleep(self.delay)

    async def _process(self, asset: PdfAsset) -> None:
        existing = self.state.docs.get(asset.filename)

        try:
            head = await self.client.head(asset.pdf_url, follow_redirects=True)
            head.raise_for_status()
            asset.etag = head.headers.get("etag")
            asset.last_modified = head.headers.get("last-modified")
            cl = head.headers.get("content-length")
            asset.content_length = int(cl) if cl and cl.isdigit() else None
        except Exception as exc:
            log.debug("HEAD failed for %s (%s)", asset.pdf_url, exc)

        if existing and not self.force:
            unchanged = (
                asset.etag and existing.get("source_etag") == asset.etag
            ) or (
                asset.last_modified
                and existing.get("source_last_modified") == asset.last_modified
                and str(asset.content_length) == existing.get("source_length")
            )
            if unchanged:
                self.stats["skipped"] += 1
                return

        body = await self._download(asset.pdf_url)
        asset.sha256 = hashlib.sha256(body).hexdigest()

        if existing and existing.get("sha256") == asset.sha256:
            self.stats["skipped"] += 1
            if not self.dry_run:
                self.sink.put_json(meta_blob_name(asset.filename),
                                   self._metadata(asset, existing))
            return

        if asset.sha256 in self.state.hashes and not existing:
            canonical = self.state.hashes[asset.sha256]
            self.stats["dup_content"] += 1
            log.info("content duplicate of %s -- skipping %s",
                     canonical, asset.filename)
            return

        if self.dry_run:
            self.stats["updated" if existing else "new"] += 1
            log.info("[dry-run] would %s %s (%d bytes)",
                     "update" if existing else "write",
                     asset.filename, len(body))
            return

        self.sink.put_pdf(asset.filename, body)
        self.sink.put_json(meta_blob_name(asset.filename),
                           self._metadata(asset, existing))
        self.state.hashes[asset.sha256] = asset.filename
        self.state.docs[asset.filename] = self._metadata(asset, existing)
        self.stats["updated" if existing else "new"] += 1
        log.info("%s %s (%d bytes)",
                 "UPDATED" if existing else "NEW",
                 asset.filename, len(body))

    @retry(
        stop=stop_after_attempt(4),
        wait=wait_exponential(multiplier=1, min=2, max=30),
        retry=retry_if_exception_type((httpx.TransportError, httpx.HTTPStatusError)),
        reraise=True,
    )
    async def _download(self, url: str) -> bytes:
        r = await self.client.get(url, follow_redirects=True)
        r.raise_for_status()
        ct = r.headers.get("content-type", "")
        if "pdf" not in ct and not r.content.startswith(b"%PDF"):
            raise ValueError(f"not a PDF (content-type={ct!r})")
        return r.content

    def _metadata(self, asset: PdfAsset, prev: dict | None) -> dict:
        p = asset.publication
        now = datetime.now(timezone.utc).isoformat(timespec="seconds")
        md = {
            "filename": asset.filename,
            "source_url": asset.pdf_url,
            "source_page": p.page_url,
            "source_etag": asset.etag or "",
            "source_last_modified": asset.last_modified or "",
            "source_length": str(asset.content_length or ""),
            "sha256": asset.sha256 or "",
            "hta_body": "ZIN",
            "hta_country": "NL",
            "information_type": p.information_type or "",
            "doc_issued": (p.issued or "")[:64],
            "doc_modified": (p.modified or "")[:64],
            "title": (p.title or "")[:512],
            "ingested_at": now,
            "rights": "CC0-1.0",
            "first_seen": (prev or {}).get("first_seen") or now,
        }
        return {k: v for k, v in md.items() if v}


# --------------------------------------------------------------------------- #
async def run(sink: Sink, url_source: str, information_type: str,
              concurrency: int, delay: float,
              dry_run: bool = False, force: bool = False) -> dict:
    headers = {"User-Agent": USER_AGENT, "Accept-Language": "nl,en",
               "Accept": "text/html,application/xml,*/*;q=0.8"}
    limits = httpx.Limits(max_connections=concurrency + 4)

    async with httpx.AsyncClient(headers=headers, timeout=90.0, limits=limits) as client:
        state = State(sink)
        state.load()

        pubs = load_publications_from_source(url_source, sink, information_type)
        if not pubs:
            return dict(failed=1, reason="empty url-file")

        log.info("resolving PDFs from %d detail pages...", len(pubs))
        resolver = PdfResolver(client)
        sem = asyncio.Semaphore(concurrency)
        resolved = 0

        async def resolve(p: Publication) -> list[PdfAsset]:
            nonlocal resolved
            async with sem:
                try:
                    a = await resolver.find_pdfs(p)
                except Exception as exc:
                    log.warning("detail page failed %s: %s", p.page_url, exc)
                    a = []
                finally:
                    resolved += 1
                    if resolved % 50 == 0:
                        log.info("resolved %d/%d detail pages",
                                 resolved, len(pubs))
                    await asyncio.sleep(delay)
                return a

        groups = await asyncio.gather(*(resolve(p) for p in pubs))
        assets = [a for g in groups for a in g]

        unique: dict[str, PdfAsset] = {}
        for a in assets:
            unique.setdefault(a.filename, a)
        assets = list(unique.values())
        log.info("found %d unique PDF assets across %d publications",
                 len(assets), len(pubs))

        ing = Ingestor(client, sink, state,
                       concurrency, delay, dry_run, force)
        ing.set_total(len(assets))
        await asyncio.gather(*(ing.process(a) for a in assets))

        result = dict(ing.stats)
        result["publications"] = len(pubs)
        result["pdf_assets"] = len(assets)
        result["failures_detail"] = ing.failures
        log.info("done: %s", ing.stats)
        return result


# --------------------------------------------------------------------------- #
def main(argv: Iterable[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Ingest ZIN HTA PDFs to a sink")
    add_sink_args(ap)
    ap.add_argument("--information-type", default="Advies")
    ap.add_argument("--url-file", required=True,
                    help="local path OR blob name in JSON container")
    ap.add_argument("--concurrency", type=int, default=4)
    ap.add_argument("--delay", type=float, default=0.25)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--force-recheck", action="store_true")
    ap.add_argument("-v", "--verbose", action="store_true")
    a = ap.parse_args(list(argv) if argv is not None else None)

    logging.basicConfig(
        level=logging.DEBUG if a.verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(name)-14s %(message)s",
    )
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("azure").setLevel(logging.WARNING)

    sink = build_sink(a)
    log.info("sink: %s", sink.describe())

    stats = asyncio.run(run(
        sink, a.url_file, a.information_type,
        a.concurrency, a.delay, a.dry_run, a.force_recheck,
    ))
    return 1 if stats.get("failed") else 0


if __name__ == "__main__":
    sys.exit(main())