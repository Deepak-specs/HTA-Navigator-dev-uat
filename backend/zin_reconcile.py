# """
# zin_reconcile.py
# ================
# Post-run reconciliation for the ZIN ingestion pipeline.

# Compares three independent sources of truth:

#   1. RSS discovery   -- the JSONL produced by zin_discovery.py
#   2. Sitemap         -- freshly fetched from /sitemap.xml (+ nested indices)
#   3. Local disk      -- .meta.json sidecar files under <root>/zin/

# and emits:

#   * a human-readable summary to the console + log file
#   * a machine-readable JSON block appended to the run manifest

# Discrepancy classes
# -------------------
#   MISSING_FROM_RSS       in sitemap (Advies) but not in RSS output
#                          -> RSS sweep has a gap; investigate
#   MISSING_FROM_SITEMAP   in RSS but not in sitemap
#                          -> usually benign (sitemap lag), logged as INFO
#   MISSING_ON_DISK        in RSS but no local PDF meta references it
#                          -> download failed or detail page had no PDF
#   ORPHAN_ON_DISK         local PDF whose source_page is not in RSS
#                          -> stale file (publication delisted / renamed)

# Usage
# -----
#     # standalone (after both discovery + ingest have run)
#     python zin_reconcile.py \
#         --root C:\\hta \
#         --url-file advies_urls.jsonl \
#         --information-type Advies

#     # integrated: called automatically from run_pipeline.py
# """

# from __future__ import annotations

# import argparse
# import asyncio
# import json
# import logging
# import os
# import re
# import sys
# from dataclasses import dataclass, field, asdict
# from datetime import datetime, timezone
# from pathlib import Path

# import httpx
# from bs4 import BeautifulSoup

# log = logging.getLogger("zin.reconcile")

# BASE = "https://www.zorginstituutnederland.nl"
# USER_AGENT = "HTA-Ingest-Reconcile/1.0 (+contact: your.name@yourcompany.com)"

# DETAIL_URL_RE = re.compile(r"/documenten/\d{4}/\d{2}/\d{2}/[^/?#]+")


# # --------------------------------------------------------------------------- #
# @dataclass
# class ReconciliationReport:
#     run_at: str
#     information_type: str
#     rss_count: int = 0
#     sitemap_total_count: int = 0
#     sitemap_documenten_count: int = 0
#     local_pdf_count: int = 0
#     local_publications_count: int = 0

#     # discrepancy buckets
#     missing_from_rss: list[str] = field(default_factory=list)
#     missing_from_sitemap: list[str] = field(default_factory=list)
#     missing_on_disk: list[str] = field(default_factory=list)
#     orphan_on_disk: list[str] = field(default_factory=list)

#     # severity: OK | WARN | FAIL
#     severity: str = "OK"
#     notes: list[str] = field(default_factory=list)

#     def summary_stats(self) -> dict[str, int]:
#         return {
#             "rss_count": self.rss_count,
#             "sitemap_documenten_count": self.sitemap_documenten_count,
#             "local_pdf_count": self.local_pdf_count,
#             "local_publications_count": self.local_publications_count,
#             "missing_from_rss": len(self.missing_from_rss),
#             "missing_from_sitemap": len(self.missing_from_sitemap),
#             "missing_on_disk": len(self.missing_on_disk),
#             "orphan_on_disk": len(self.orphan_on_disk),
#         }


# # --------------------------------------------------------------------------- #
# def _load_rss_urls(path: Path) -> set[str]:
#     urls: set[str] = set()
#     with open(path, "r", encoding="utf-8") as f:
#         for line in f:
#             line = line.strip()
#             if not line:
#                 continue
#             try:
#                 d = json.loads(line)
#             except json.JSONDecodeError:
#                 continue
#             u = d.get("page_url") or d.get("url")
#             if u:
#                 urls.add(u.rstrip("/"))
#     return urls


# def _load_local_publications(doc_dir: Path) -> tuple[int, set[str]]:
#     """
#     Return (pdf_count, set_of_source_page_urls) from *.meta.json sidecars.
#     """
#     pdf_count = 0
#     pages: set[str] = set()
#     if not doc_dir.exists():
#         return 0, pages
#     for meta_path in doc_dir.glob("*.pdf.meta.json"):
#         pdf_count += 1
#         try:
#             with open(meta_path, "r", encoding="utf-8") as f:
#                 md = json.load(f)
#             src = (md.get("source_page") or "").rstrip("/")
#             if src:
#                 pages.add(src)
#         except Exception as exc:  # noqa: BLE001
#             log.warning("cannot read %s: %s", meta_path.name, exc)
#     return pdf_count, pages


# # --------------------------------------------------------------------------- #
# async def _fetch_sitemap(client: httpx.AsyncClient) -> set[str]:
#     """
#     Recursively walk sitemap.xml + any nested <sitemap> indices.
#     Returns the FULL set of URLs found under any /documenten/YYYY/MM/DD/ path
#     (all information types, not just Advies -- filtering to Advies happens
#     later via the RSS set intersection).
#     """
#     to_visit = [
#         f"{BASE}/sitemap.xml",
#         f"{BASE}/sitemap_index.xml",
#     ]
#     visited: set[str] = set()
#     found: set[str] = set()

#     while to_visit:
#         url = to_visit.pop(0)
#         if url in visited:
#             continue
#         visited.add(url)
#         try:
#             r = await client.get(url, timeout=60.0)
#             if r.status_code != 200:
#                 log.debug("sitemap %s -> %s", url, r.status_code)
#                 continue
#         except httpx.HTTPError as exc:
#             log.debug("sitemap fetch failed %s: %s", url, exc)
#             continue

#         soup = BeautifulSoup(r.text, "xml")

#         for sm in soup.find_all("sitemap"):
#             loc = sm.find("loc")
#             if loc and loc.text.strip() not in visited:
#                 to_visit.append(loc.text.strip())

#         for u in soup.find_all("url"):
#             loc = u.find("loc")
#             if not loc:
#                 continue
#             href = loc.text.strip().rstrip("/")
#             if DETAIL_URL_RE.search(href):
#                 found.add(href)

#         await asyncio.sleep(0.2)

#     log.info("sitemap: %d /documenten/ URLs collected", len(found))
#     return found


# # --------------------------------------------------------------------------- #
# async def reconcile(
#     root: Path,
#     url_file: Path,
#     information_type: str = "Advies",
# ) -> ReconciliationReport:
#     report = ReconciliationReport(
#         run_at=datetime.now(timezone.utc).isoformat(timespec="seconds"),
#         information_type=information_type,
#     )

#     # 1. RSS discovery snapshot
#     rss = _load_rss_urls(url_file)
#     report.rss_count = len(rss)
#     log.info("RSS discovery: %d URLs", report.rss_count)

#     # 2. Local disk snapshot
#     doc_dir = root / "zin"
#     pdf_count, local_pages = _load_local_publications(doc_dir)
#     report.local_pdf_count = pdf_count
#     report.local_publications_count = len(local_pages)
#     log.info(
#         "local disk: %d PDFs across %d unique publications",
#         pdf_count, len(local_pages),
#     )

#     # 3. Sitemap snapshot
#     headers = {"User-Agent": USER_AGENT, "Accept-Language": "nl,en"}
#     async with httpx.AsyncClient(headers=headers, follow_redirects=True) as client:
#         sitemap = await _fetch_sitemap(client)
#     report.sitemap_total_count = len(sitemap)
#     report.sitemap_documenten_count = len(sitemap)

#     # 4. Discrepancy analysis
#     #    Sitemap covers ALL publication types, so we intersect against RSS
#     #    to find truly missing items. A pub present in RSS but not sitemap
#     #    is *usually* benign (sitemap lag or trailing-slash noise).
#     report.missing_from_rss = sorted(sitemap - rss - _known_non_advies(sitemap, rss))
#     report.missing_from_sitemap = sorted(rss - sitemap)
#     report.missing_on_disk = sorted(rss - local_pages)
#     report.orphan_on_disk = sorted(local_pages - rss)

#     # 5. Severity
#     if report.missing_on_disk:
#         report.severity = "WARN"
#         report.notes.append(
#             f"{len(report.missing_on_disk)} publications discovered by RSS "
#             f"have no PDF on disk -- likely download failures or detail "
#             f"pages with no PDF attachment. Re-run the ingest to retry."
#         )
#     if report.missing_from_rss:
#         # only WARN if the count is meaningful vs sitemap noise
#         if len(report.missing_from_rss) > max(5, report.rss_count * 0.02):
#             report.severity = "FAIL"
#             report.notes.append(
#                 f"{len(report.missing_from_rss)} sitemap URLs are missing "
#                 f"from RSS discovery -- the sweep may have gaps. Investigate."
#             )
#         else:
#             report.notes.append(
#                 f"{len(report.missing_from_rss)} sitemap URLs missing from "
#                 f"RSS -- within noise threshold, likely non-Advies types."
#             )
#     if report.orphan_on_disk:
#         report.notes.append(
#             f"{len(report.orphan_on_disk)} local PDFs correspond to "
#             f"publications no longer in RSS -- likely delisted or renamed."
#         )

#     if not report.notes:
#         report.notes.append("All three sources are consistent. Clean run.")

#     return report


# def _known_non_advies(sitemap: set[str], rss: set[str]) -> set[str]:
#     """
#     Sitemap contains every publication type (Standpunt, Rapport, Nieuwsbericht,
#     etc.). Without fetching every detail page just to read its DCTERMS meta,
#     we cannot cheaply prove which sitemap URLs are Advies. So we adopt a
#     conservative approach: treat the *difference* as potentially non-Advies
#     and let the severity threshold filter noise.

#     This function is a placeholder for future refinement (e.g., cached
#     per-URL type index). For now returns an empty set -- all missing URLs
#     are surfaced and the noise threshold in reconcile() handles it.
#     """
#     return set()


# # --------------------------------------------------------------------------- #
# def print_report(report: ReconciliationReport) -> None:
#     print()
#     print("=" * 72)
#     print(f" ZIN RECONCILIATION REPORT   [{report.severity}]")
#     print(f" run_at:            {report.run_at}")
#     print(f" information_type:  {report.information_type}")
#     print("-" * 72)
#     print(f" RSS discovered:            {report.rss_count:>6}")
#     print(f" Sitemap /documenten/ URLs: {report.sitemap_documenten_count:>6}")
#     print(f" Local PDFs on disk:        {report.local_pdf_count:>6}")
#     print(f" Local unique publications: {report.local_publications_count:>6}")
#     print("-" * 72)
#     print(f" Missing from RSS:      {len(report.missing_from_rss):>6}  "
#           f"(sitemap has, RSS did not)")
#     print(f" Missing from sitemap:  {len(report.missing_from_sitemap):>6}  "
#           f"(RSS has, sitemap did not)")
#     print(f" Missing on disk:       {len(report.missing_on_disk):>6}  "
#           f"(RSS has, no local PDF)")
#     print(f" Orphan on disk:        {len(report.orphan_on_disk):>6}  "
#           f"(local PDF, no RSS entry)")
#     print("-" * 72)
#     for n in report.notes:
#         print(f"  * {n}")
#     print("=" * 72)

#     # Show up to 10 examples of each non-empty discrepancy bucket
#     for label, items in [
#         ("MISSING_FROM_RSS", report.missing_from_rss),
#         ("MISSING_ON_DISK", report.missing_on_disk),
#         ("ORPHAN_ON_DISK", report.orphan_on_disk),
#     ]:
#         if items:
#             print(f"\n[{label}] first {min(10, len(items))} of {len(items)}:")
#             for u in items[:10]:
#                 print(f"  - {u}")
#     print()


# # --------------------------------------------------------------------------- #
# def main() -> int:
#     ap = argparse.ArgumentParser(description="Reconcile ZIN pipeline outputs")
#     ap.add_argument("--root", required=True, type=Path)
#     ap.add_argument("--url-file", required=True, type=Path)
#     ap.add_argument("--information-type", default="Advies")
#     ap.add_argument("--out", type=Path, default=None,
#                     help="write JSON report here (defaults to stdout only)")
#     ap.add_argument("-v", "--verbose", action="store_true")
#     a = ap.parse_args()

#     logging.basicConfig(
#         level=logging.DEBUG if a.verbose else logging.INFO,
#         format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
#     )
#     logging.getLogger("httpx").setLevel(logging.WARNING)

#     report = asyncio.run(reconcile(a.root, a.url_file, a.information_type))
#     print_report(report)

#     if a.out:
#         with open(a.out, "w", encoding="utf-8") as f:
#             json.dump(asdict(report), f, indent=2, ensure_ascii=False)
#         log.info("wrote report -> %s", a.out)

#     return 0 if report.severity != "FAIL" else 2


# if __name__ == "__main__":
#     sys.exit(main())

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