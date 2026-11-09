#----------------------------------------------------#
"""
zin_reconcile.py
================
Sink-aware reconciliation. Compares:
  1. RSS discovery JSONL (from JSON container blob or local file)
  2. Sitemap (fetched fresh from zorginstituutnederland.nl)
  3. Actual PDFs in the PDF container / local folder

Emits a report to console + writes reports/<run-id>.json to JSON container.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import re
import sys
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from pathlib import Path

import httpx
from bs4 import BeautifulSoup

from zin_sinks import Sink, build_sink, add_sink_args

log = logging.getLogger("zin.reconcile")

BASE = "https://www.zorginstituutnederland.nl"
USER_AGENT = "HTA-Reconcile/1.0 (+contact: deepak.sinha@astrazeneca.com)"
DETAIL_URL_RE = re.compile(r"/documenten/\d{4}/\d{2}/\d{2}/[^/?#]+")
META_PREFIX = "meta/"


@dataclass
class ReconciliationReport:
    run_at: str
    information_type: str
    rss_count: int = 0
    sitemap_documenten_count: int = 0
    pdf_count: int = 0
    publications_with_pdf: int = 0
    missing_from_rss: list[str] = field(default_factory=list)
    missing_from_sitemap: list[str] = field(default_factory=list)
    missing_on_disk: list[str] = field(default_factory=list)
    orphan_on_disk: list[str] = field(default_factory=list)
    severity: str = "OK"
    notes: list[str] = field(default_factory=list)

    def summary_stats(self) -> dict:
        return {
            "rss_count": self.rss_count,
            "sitemap_documenten_count": self.sitemap_documenten_count,
            "pdf_count": self.pdf_count,
            "publications_with_pdf": self.publications_with_pdf,
            "missing_from_rss": len(self.missing_from_rss),
            "missing_from_sitemap": len(self.missing_from_sitemap),
            "missing_on_disk": len(self.missing_on_disk),
            "orphan_on_disk": len(self.orphan_on_disk),
        }


def _load_rss_urls(sink: Sink, source: str) -> set[str]:
    p = Path(source)
    text = p.read_text(encoding="utf-8") if p.exists() else sink.get_text(source)
    if not text:
        raise FileNotFoundError(f"url-file '{source}' not found in sink or disk")
    urls = set()
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            d = json.loads(line)
        except json.JSONDecodeError:
            continue
        u = d.get("page_url") or d.get("url")
        if u:
            urls.add(u.rstrip("/"))
    return urls


def _load_pipeline_publications(sink: Sink) -> tuple[int, set[str]]:
    pdf_names = {b.name for b in sink.list_pdfs()}
    pages: set[str] = set()
    for m in sink.list_json(prefix=META_PREFIX):
        pdf_name = m.name[len(META_PREFIX):-len(".meta.json")]
        if pdf_name not in pdf_names:
            continue
        md = sink.get_json(m.name) or {}
        src = (md.get("source_page") or "").rstrip("/")
        if src:
            pages.add(src)
    return len(pdf_names), pages


async def _fetch_sitemap(client: httpx.AsyncClient) -> set[str]:
    to_visit = [f"{BASE}/sitemap.xml", f"{BASE}/sitemap_index.xml"]
    visited, found = set(), set()
    while to_visit:
        url = to_visit.pop(0)
        if url in visited:
            continue
        visited.add(url)
        try:
            r = await client.get(url, timeout=60.0)
            if r.status_code != 200:
                continue
        except httpx.HTTPError:
            continue
        soup = BeautifulSoup(r.text, "xml")
        for sm in soup.find_all("sitemap"):
            loc = sm.find("loc")
            if loc and loc.text.strip() not in visited:
                to_visit.append(loc.text.strip())
        for u in soup.find_all("url"):
            loc = u.find("loc")
            if loc:
                href = loc.text.strip().rstrip("/")
                if DETAIL_URL_RE.search(href):
                    found.add(href)
        await asyncio.sleep(0.2)
    log.info("sitemap: %d /documenten/ URLs", len(found))
    return found


async def reconcile(sink: Sink, url_source: str,
                    information_type: str) -> ReconciliationReport:
    report = ReconciliationReport(
        run_at=datetime.now(timezone.utc).isoformat(timespec="seconds"),
        information_type=information_type,
    )

    rss = _load_rss_urls(sink, url_source)
    report.rss_count = len(rss)
    log.info("RSS discovery: %d URLs", report.rss_count)

    pdf_count, local_pages = _load_pipeline_publications(sink)
    report.pdf_count = pdf_count
    report.publications_with_pdf = len(local_pages)
    log.info("sink: %d PDFs across %d unique publications",
             pdf_count, len(local_pages))

    async with httpx.AsyncClient(
        headers={"User-Agent": USER_AGENT}, follow_redirects=True
    ) as client:
        sitemap = await _fetch_sitemap(client)
    report.sitemap_documenten_count = len(sitemap)

    report.missing_from_rss = sorted(sitemap - rss)
    report.missing_from_sitemap = sorted(rss - sitemap)
    report.missing_on_disk = sorted(rss - local_pages)
    report.orphan_on_disk = sorted(local_pages - rss)

    if report.missing_on_disk:
        report.severity = "WARN"
        report.notes.append(
            f"{len(report.missing_on_disk)} publications discovered by RSS "
            f"have no PDF in the sink -- re-run ingest to retry."
        )
    if report.missing_from_rss:
        if len(report.missing_from_rss) > max(5, report.rss_count * 0.02):
            report.severity = "FAIL"
            report.notes.append(
                f"{len(report.missing_from_rss)} sitemap URLs missing from RSS "
                f"-- sweep may have gaps."
            )
        else:
            report.notes.append(
                f"{len(report.missing_from_rss)} sitemap URLs missing from RSS "
                f"-- within noise threshold (non-Advies types)."
            )
    if report.orphan_on_disk:
        report.notes.append(
            f"{len(report.orphan_on_disk)} sink PDFs correspond to "
            f"publications no longer in RSS."
        )
    if not report.notes:
        report.notes.append("All three sources are consistent. Clean run.")

    return report


def print_report(r: ReconciliationReport) -> None:
    print()
    print("=" * 72)
    print(f" ZIN RECONCILIATION REPORT   [{r.severity}]")
    print(f" run_at:            {r.run_at}")
    print(f" information_type:  {r.information_type}")
    print("-" * 72)
    print(f" RSS discovered:            {r.rss_count:>6}")
    print(f" Sitemap /documenten/ URLs: {r.sitemap_documenten_count:>6}")
    print(f" PDFs in sink:              {r.pdf_count:>6}")
    print(f" Publications with a PDF:   {r.publications_with_pdf:>6}")
    print("-" * 72)
    print(f" Missing from RSS:      {len(r.missing_from_rss):>6}")
    print(f" Missing from sitemap:  {len(r.missing_from_sitemap):>6}")
    print(f" Missing on disk:       {len(r.missing_on_disk):>6}")
    print(f" Orphan on disk:        {len(r.orphan_on_disk):>6}")
    print("-" * 72)
    for n in r.notes:
        print(f"  * {n}")
    print("=" * 72)
    for label, items in [
        ("MISSING_FROM_RSS", r.missing_from_rss),
        ("MISSING_ON_DISK", r.missing_on_disk),
        ("ORPHAN_ON_DISK", r.orphan_on_disk),
    ]:
        if items:
            print(f"\n[{label}] first {min(10, len(items))} of {len(items)}:")
            for u in items[:10]:
                print(f"  - {u}")
    print()


def main() -> int:
    ap = argparse.ArgumentParser(description="Reconcile ZIN pipeline")
    add_sink_args(ap)
    ap.add_argument("--url-file", required=True)
    ap.add_argument("--information-type", default="Advies")
    ap.add_argument("--out", default=None,
                    help="blob name for JSON report (default: reports/<ts>.json)")
    ap.add_argument("-v", "--verbose", action="store_true")
    a = ap.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if a.verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(name)-14s %(message)s",
    )
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("azure").setLevel(logging.WARNING)

    sink = build_sink(a)
    log.info("sink: %s", sink.describe())

    report = asyncio.run(reconcile(sink, a.url_file, a.information_type))
    print_report(report)

    out_name = a.out or (
        f"reports/{datetime.now(timezone.utc).strftime('%Y-%m-%dT%H%M%SZ')}.json"
    )
    sink.put_json(out_name, asdict(report))
    log.info("wrote report -> %s (in JSON container)", out_name)

    return 0 if report.severity != "FAIL" else 2


if __name__ == "__main__":
    sys.exit(main())