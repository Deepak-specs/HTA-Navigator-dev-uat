"""
zin_advies_to_local.py
======================
Flat-folder ingestion of Zorginstituut Nederland (ZIN) HTA PDFs.
All PDFs land directly in <root>/zin/ with collision-free filenames of the form:

    YYYY-MM-DD__<publication-slug>__<original-pdf-filename>.pdf

This layout mirrors Azure Blob Storage's flat namespace, so when we switch
from local to blob storage the filenames become blob names 1:1 with no
restructuring.

Install
-------
    pip install httpx beautifulsoup4 tenacity lxml

Usage
-----
    python zin_discovery.py --information-type Advies --out advies_urls.jsonl
    python zin_advies_to_local.py --root C:\\hta --url-file advies_urls.jsonl
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
    retry,
    retry_if_exception_type,
    stop_after_attempt,
    wait_exponential,
)

log = logging.getLogger("zin")

BASE = "https://www.zorginstituutnederland.nl"

USER_AGENT = os.environ.get(
    "ZIN_USER_AGENT",
    "HTA-Ingest-Local/1.0 (+contact: your.name@yourcompany.com)",
)

PDF_HREF_RE = re.compile(
    r"/site/binaries/site-content/collections/documents/.+?\.pdf$", re.I
)

# Extract YYYY / MM / DD / slug from a ZIN detail-page URL
DETAIL_URL_RE = re.compile(
    r"/documenten/(\d{4})/(\d{2})/(\d{2})/([^/?#]+)"
)

MAX_FILENAME = 180  # keep well below the 255-byte NTFS limit


# --------------------------------------------------------------------------- #
@dataclasses.dataclass(frozen=True)
class Config:
    root: Path
    information_type: str = "Advies"
    prefix: str = "zin"
    concurrency: int = 4
    request_delay: float = 0.25
    dry_run: bool = False
    force_recheck: bool = False
    url_file: Path | None = None

    @property
    def doc_dir(self) -> Path:
        # Flat: everything under <root>/zin/
        return self.root / self.prefix

    @property
    def index_file(self) -> Path:
        return self.root / f"{self.prefix}_index.json"

    @property
    def runs_dir(self) -> Path:
        return self.root / f"{self.prefix}_runs"


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
    filename: str            # flat, collision-free
    etag: str | None = None
    last_modified: str | None = None
    content_length: int | None = None
    sha256: str | None = None


# --------------------------------------------------------------------------- #
# Filename helpers
# --------------------------------------------------------------------------- #
def slugify(s: str) -> str:
    s = s.replace("+", "-").replace(" ", "-").lower()
    s = re.sub(r"[^a-z0-9._-]", "-", s)
    s = re.sub(r"-{2,}", "-", s).strip("-.")
    return s


def _win_long(path: Path) -> str:
    p = str(path.resolve())
    if os.name == "nt" and not p.startswith("\\\\?\\"):
        return "\\\\?\\" + p
    return p


def _mkdir(path: Path) -> None:
    os.makedirs(_win_long(path), exist_ok=True)


def flat_filename_for(pdf_url: str, pub: Publication) -> str:
    """
    Produce a collision-free flat filename:
        YYYY-MM-DD__<pub-slug>__<pdf-basename>.pdf

    If the total length would exceed MAX_FILENAME, truncate the middle segment
    (publication slug) and append a short SHA-1 tag to preserve uniqueness.
    """
    # 1. Date + publication slug from the detail-page URL
    m = DETAIL_URL_RE.search(pub.page_url)
    if m:
        year, month, day, pub_slug = m.groups()
        date_part = f"{year}-{month}-{day}"
        pub_slug = slugify(pub_slug)
    else:
        # Fallback: date from RSS issued, slug from title
        date_part = (pub.issued or "unknown")[:10]
        pub_slug = slugify(pub.title or "unknown")[:60] or "unknown"

    # 2. Original PDF basename (last URL segment)
    pdf_path = urllib.parse.unquote(urllib.parse.urlparse(pdf_url).path)
    pdf_base = pdf_path.rsplit("/", 1)[-1]
    if not pdf_base.lower().endswith(".pdf"):
        pdf_base += ".pdf"
    stem, ext = pdf_base[:-4], ".pdf"
    stem = slugify(stem) or "document"

    filename = f"{date_part}__{pub_slug}__{stem}{ext}"

    if len(filename) <= MAX_FILENAME:
        return filename

    # Too long -- truncate middle (pub_slug) and add a stable hash
    tag = hashlib.sha1(f"{pub.page_url}|{pdf_url}".encode("utf-8")).hexdigest()[:10]
    # Budget: date(10) + 2*"__"(4) + tag(11 incl dash) + stem + ext
    fixed = len(date_part) + 4 + 11 + len(stem) + len(ext)
    remaining = MAX_FILENAME - fixed
    if remaining < 10:
        # stem itself is too long -- truncate it too
        stem = stem[: max(20, MAX_FILENAME - (len(date_part) + 4 + 11 + len(ext) + 20))]
        remaining = MAX_FILENAME - (len(date_part) + 4 + 11 + len(stem) + len(ext))
    pub_slug_short = pub_slug[: max(10, remaining)]
    return f"{date_part}__{pub_slug_short}-{tag}__{stem}{ext}"


# --------------------------------------------------------------------------- #
# Load publications from JSONL
# --------------------------------------------------------------------------- #
def load_publications_from_file(path: Path, information_type: str) -> list[Publication]:
    pubs: list[Publication] = []
    with open(_win_long(path), "r", encoding="utf-8") as f:
        for line in f:
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
            pubs.append(
                Publication(
                    page_url=url,
                    title=d.get("title", "") or "",
                    issued=d.get("issued"),
                    information_type=information_type,
                )
            )
    log.info("loaded %d publications from %s", len(pubs), path)
    return pubs


# --------------------------------------------------------------------------- #
# Detail-page PDF resolver
# --------------------------------------------------------------------------- #
class PdfResolver:
    def __init__(self, client: httpx.AsyncClient, cfg: Config):
        self.client = client
        self.cfg = cfg

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
            tag = soup.find("meta", attrs={"name": name})
            return tag.get("content") if tag else None

        pub.issued = meta("DCTERMS.issued") or pub.issued
        pub.modified = meta("DCTERMS.modified") or pub.modified
        if not pub.title:
            pub.title = (meta("DCTERMS.title") or "").split(" | ")[0]

        assets: list[PdfAsset] = []
        seen: set[str] = set()
        for a in soup.find_all("a", href=True):
            href = a["href"]
            if not PDF_HREF_RE.search(urllib.parse.urlparse(href).path):
                continue
            full = href if href.startswith("http") else BASE + href
            if full in seen:
                continue
            seen.add(full)
            assets.append(
                PdfAsset(
                    pdf_url=full,
                    publication=pub,
                    filename=flat_filename_for(full, pub),
                )
            )
        return assets


# --------------------------------------------------------------------------- #
# Local state (flat: single sidecar index file + in-folder .meta.json per PDF)
# --------------------------------------------------------------------------- #
class LocalState:
    META_SUFFIX = ".meta.json"

    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.docs: dict[str, dict[str, str]] = {}   # filename -> meta
        self.hashes: dict[str, str] = {}            # sha256 -> filename

    def load(self) -> None:
        _mkdir(self.cfg.doc_dir)
        _mkdir(self.cfg.runs_dir)

        for pdf_path in self.cfg.doc_dir.glob("*.pdf"):
            self.docs[pdf_path.name] = self._read_meta(pdf_path)
            sha = self.docs[pdf_path.name].get("sha256")
            if sha:
                self.hashes[sha] = pdf_path.name

        log.info(
            "state: %d existing PDFs, %d known content hashes",
            len(self.docs), len(self.hashes),
        )

    def _read_meta(self, pdf_path: Path) -> dict[str, str]:
        mp = pdf_path.with_suffix(pdf_path.suffix + self.META_SUFFIX)
        if not mp.exists():
            return {}
        try:
            with open(_win_long(mp), "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return {}


# --------------------------------------------------------------------------- #
# Ingest
# --------------------------------------------------------------------------- #
class Ingestor:
    def __init__(self, client: httpx.AsyncClient, state: LocalState, cfg: Config):
        self.client = client
        self.state = state
        self.cfg = cfg
        self.sem = asyncio.Semaphore(cfg.concurrency)
        self.stats = dict(new=0, updated=0, skipped=0, dup_content=0, failed=0)
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
                log.error("FAILED %s -> %s", asset.pdf_url, exc)
            finally:
                self._processed += 1
                if self._processed % 25 == 0 or self._processed == self._total:
                    log.info("progress: %d/%d  stats=%s",
                             self._processed, self._total, self.stats)
                await asyncio.sleep(self.cfg.request_delay)

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
            log.debug("HEAD failed for %s (%s) -- will GET", asset.pdf_url, exc)

        if existing and not self.cfg.force_recheck:
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
            if not self.cfg.dry_run:
                self._write_meta(asset, existing)
            return

        if asset.sha256 in self.state.hashes and not existing:
            # Same bytes already stored under another name (rare, but possible)
            canonical = self.state.hashes[asset.sha256]
            self.stats["dup_content"] += 1
            log.info("content duplicate of %s -- skipping %s",
                     canonical, asset.filename)
            return

        if self.cfg.dry_run:
            self.stats["updated" if existing else "new"] += 1
            log.info("[dry-run] would %s %s (%d bytes)",
                     "update" if existing else "write",
                     asset.filename, len(body))
            return

        self._write_pdf(asset, body)
        self._write_meta(asset, existing)
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

    def _abs_pdf(self, asset: PdfAsset) -> Path:
        return self.cfg.doc_dir / asset.filename

    def _write_pdf(self, asset: PdfAsset, body: bytes) -> None:
        p = self._abs_pdf(asset)
        _mkdir(p.parent)
        tmp = p.with_suffix(p.suffix + ".part")
        with open(_win_long(tmp), "wb") as f:
            f.write(body)
        os.replace(_win_long(tmp), _win_long(p))

    def _metadata(self, asset: PdfAsset, prev: dict[str, str] | None) -> dict[str, str]:
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

    def _write_meta(self, asset: PdfAsset, prev: dict[str, str] | None) -> None:
        p = self._abs_pdf(asset)
        mp = p.with_suffix(p.suffix + LocalState.META_SUFFIX)
        with open(_win_long(mp), "w", encoding="utf-8") as f:
            json.dump(self._metadata(asset, prev), f, indent=2, ensure_ascii=False)


# --------------------------------------------------------------------------- #
# Orchestration
# --------------------------------------------------------------------------- #
async def run(cfg: Config) -> dict[str, int]:
    headers = {
        "User-Agent": USER_AGENT,
        "Accept-Language": "nl,en",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    }
    limits = httpx.Limits(max_connections=cfg.concurrency + 4)

    async with httpx.AsyncClient(headers=headers, timeout=90.0, limits=limits) as client:
        state = LocalState(cfg)
        state.load()

        if not cfg.url_file:
            log.error("no --url-file given; run zin_discovery.py first")
            return dict(failed=1)

        pubs = load_publications_from_file(cfg.url_file, cfg.information_type)
        if not pubs:
            log.error("url-file %s is empty", cfg.url_file)
            return dict(failed=1)

        log.info("resolving PDFs from %d detail pages…", len(pubs))
        resolver = PdfResolver(client, cfg)
        sem = asyncio.Semaphore(cfg.concurrency)
        resolved = 0

        async def resolve(p: Publication) -> list[PdfAsset]:
            nonlocal resolved
            async with sem:
                try:
                    assets = await resolver.find_pdfs(p)
                except Exception as exc:  # noqa: BLE001
                    log.warning("detail page failed %s: %s", p.page_url, exc)
                    assets = []
                finally:
                    resolved += 1
                    if resolved % 50 == 0:
                        log.info("resolved %d/%d detail pages", resolved, len(pubs))
                    await asyncio.sleep(cfg.request_delay)
                return assets

        groups = await asyncio.gather(*(resolve(p) for p in pubs))
        assets = [a for group in groups for a in group]

        # Deduplicate by filename (same publication may appear twice in JSONL)
        unique: dict[str, PdfAsset] = {}
        for a in assets:
            unique.setdefault(a.filename, a)
        assets = list(unique.values())

        log.info("found %d unique PDF assets across %d publications",
                 len(assets), len(pubs))

        ing = Ingestor(client, state, cfg)
        ing.set_total(len(assets))
        await asyncio.gather(*(ing.process(a) for a in assets))

        if not cfg.dry_run:
            manifest = {
                "run_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "information_type": cfg.information_type,
                "publications": len(pubs),
                "pdf_assets": len(assets),
                "stats": ing.stats,
            }
            stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H%M%SZ")
            run_file = cfg.runs_dir / f"{stamp}.json"
            with open(_win_long(run_file), "w", encoding="utf-8") as f:
                json.dump(manifest, f, indent=2)

        log.info("done: %s", ing.stats)
        return ing.stats


def main(argv: Iterable[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description="Ingest ALL ZIN HTA PDFs into a flat local folder"
    )
    ap.add_argument("--root", default=os.environ.get("ZIN_ROOT", "./zin_data"))
    ap.add_argument("--information-type", default="Advies")
    ap.add_argument("--url-file", type=Path, required=True,
                    help="JSONL file produced by zin_discovery.py")
    ap.add_argument("--concurrency", type=int, default=4)
    ap.add_argument("--delay", type=float, default=0.25)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--force-recheck", action="store_true")
    ap.add_argument("-v", "--verbose", action="store_true")
    a = ap.parse_args(list(argv) if argv is not None else None)

    logging.basicConfig(
        level=logging.DEBUG if a.verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(message)s",
    )
    logging.getLogger("httpx").setLevel(logging.WARNING)

    cfg = Config(
        root=Path(a.root).resolve(),
        information_type=a.information_type,
        concurrency=a.concurrency,
        request_delay=a.delay,
        url_file=a.url_file.resolve(),
        dry_run=a.dry_run,
        force_recheck=a.force_recheck,
    )
    log.info("root:     %s", cfg.root)
    log.info("doc_dir:  %s   (flat)", cfg.doc_dir)
    log.info("url-file: %s", cfg.url_file)
    stats = asyncio.run(run(cfg))
    return 1 if stats.get("failed") else 0


if __name__ == "__main__":
    sys.exit(main())