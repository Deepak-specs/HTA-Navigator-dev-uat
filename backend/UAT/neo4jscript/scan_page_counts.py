"""
scan_page_counts.py
===================
Read-only page-count scan of the PDF corpus in blob storage, with an optional
offline mirror.

Nothing is written to blob storage or Neo4j, and no LLM is called. Each PDF is
downloaded, its page count read out of the document structure, and the result
written to a CSV along with a cost forecast for the ingest.

    python scan_page_counts.py                       # scan only
    python scan_page_counts.py --limit 30            # quick sample
    python scan_page_counts.py --workers 12          # faster, more bandwidth
    python scan_page_counts.py --mirror-root pdfs    # keep the downloads

--mirror-root writes a LocalSink layout:

    <root>/zin/<blob_name>                       the PDF
    <root>/zin_json/meta/<blob_name>.meta.json   its metadata

which is exactly what run_ingest.py reads with --sink local, so the whole
ingest can then run from disk:

    python run_ingest.py --all --sink local --root pdfs --concurrency 3

The metadata costs no extra download -- list_metas() has already fetched it.
Mirroring is resumable: a PDF already on disk with the expected size is not
fetched again.

Cost model, fitted to the 6 Oct pilot at --concurrency 3:

    seconds per document  ~=  78 + 5.4 * pages

Fitted on the 22-page and 156-page documents; it predicted the 20-page and
40-page documents to within 2%. Per-page cost falls as documents grow because
the fixed per-document overhead is amortised.
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import os
import statistics
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from hta_ingest.config import Settings
from hta_ingest.source import META_PREFIX, META_SUFFIX, SourceReader, _long

# ─── Cost model, from the 6 Oct pilot ────────────────────────────────────────
FIXED_SECONDS    = 78.0   # per document, regardless of length
SECONDS_PER_PAGE = 5.4
# Measured at --concurrency 3: 249.3s mean duration against 103.4s wall clock
# per document. You do not get 3x; contention costs about 20%.
EFFECTIVE_CONCURRENCY = 2.41

PAGE_BANDS = [
    ("1-25",     1,    25),
    ("26-50",    26,   50),
    ("51-100",   51,   100),
    ("101-200",  101,  200),
    ("201-500",  201,  500),
    ("500+",     501,  10**9),
]


def predicted_seconds(pages: int) -> float:
    return FIXED_SECONDS + SECONDS_PER_PAGE * pages


def hhmm(seconds: float) -> str:
    h, m = divmod(int(seconds + 0.5) // 60, 60)
    return f"{h}h {m:02d}m"


def _write_atomic(path: Path, body: bytes) -> None:
    r"""Write via a .part file so an interrupted run leaves no half file.

    ZIN blob names run long, so every path goes through the \\?\ prefix that
    LocalSink uses -- without it these fail on Windows.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".part")
    with open(_long(tmp), "wb") as fh:
        fh.write(body)
    os.replace(_long(tmp), _long(path))


def process(reader: SourceReader, meta, mirror_root: Path | None) -> dict:
    """Page-count one document, optionally mirroring it. Never raises."""
    blob = meta.blob_name
    row = {"blob_name": blob, "pages": 0, "size_bytes": 0,
           "predicted_seconds": 0.0, "mirrored": "", "error": ""}

    pdf_path = (mirror_root / "zin" / blob) if mirror_root else None

    try:
        # Resume: trust a mirrored file that is already the full size.
        data = None
        if pdf_path is not None and os.path.exists(_long(pdf_path)):
            existing = os.path.getsize(_long(pdf_path))
            if existing > 0:
                with open(_long(pdf_path), "rb") as fh:
                    data = fh.read()
                row["mirrored"] = "cached"

        if data is None:
            data = reader.get_pdf(blob)
            if pdf_path is not None:
                _write_atomic(pdf_path, data)
                meta_path = mirror_root / "zin_json" / META_PREFIX.rstrip("/") / f"{blob}{META_SUFFIX}"
                _write_atomic(meta_path, json.dumps(meta.raw, ensure_ascii=False).encode("utf-8"))
                row["mirrored"] = "new"

        row["size_bytes"] = len(data)

        from pypdf import PdfReader as Pdf
        pdf = Pdf(io.BytesIO(data))
        # A published document is often flagged encrypted but opens on an empty
        # password; that still yields a usable page count.
        if getattr(pdf, "is_encrypted", False):
            try:
                pdf.decrypt("")
            except Exception:  # noqa: BLE001
                pass
        row["pages"] = len(pdf.pages)
        row["predicted_seconds"] = round(predicted_seconds(row["pages"]), 1)
    except Exception as exc:  # noqa: BLE001
        row["error"] = f"{type(exc).__name__}: {exc}"[:200]
    return row


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--limit", type=int, help="scan at most N documents")
    ap.add_argument("--workers", type=int, default=8, help="parallel downloads (default 8)")
    ap.add_argument("--out", default="page_counts.csv", help="CSV path (default page_counts.csv)")
    ap.add_argument("--top", type=int, default=25, help="how many of the largest to list (default 25)")
    ap.add_argument("--mirror-root", help="also save PDFs + metadata here in LocalSink layout")
    a = ap.parse_args(argv)

    mirror_root = Path(a.mirror_root).resolve() if a.mirror_root else None

    settings = Settings.from_env()
    reader = SourceReader(settings)

    print("Listing documents...", flush=True)
    metas = reader.list_metas()
    if a.limit:
        metas = metas[:a.limit]
    print(f"{len(metas)} documents, {a.workers} parallel downloads", flush=True)
    if mirror_root:
        print(f"mirroring to {mirror_root}", flush=True)
    print(flush=True)

    rows: list[dict] = []
    started = time.time()

    # Written incrementally so an interrupted scan still leaves usable data.
    with open(a.out, "w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(
            fh, fieldnames=["blob_name", "pages", "size_bytes",
                            "predicted_seconds", "mirrored", "error"])
        writer.writeheader()

        with ThreadPoolExecutor(max_workers=a.workers) as pool:
            futures = [pool.submit(process, reader, m, mirror_root) for m in metas]
            for done, future in enumerate(as_completed(futures), start=1):
                row = future.result()
                rows.append(row)
                writer.writerow(row)
                fh.flush()
                if done % 25 == 0 or done == len(metas):
                    rate = done / max(1e-9, time.time() - started)
                    left = (len(metas) - done) / max(1e-9, rate)
                    print(f"  {done}/{len(metas)}  ({rate:.1f}/s, ~{hhmm(left)} left)", flush=True)

    ok = [r for r in rows if not r["error"] and r["pages"] > 0]
    bad = [r for r in rows if r["error"] or r["pages"] == 0]

    print(f"\nScanned {len(rows)} documents in {hhmm(time.time() - started)}")
    print(f"  readable        : {len(ok)}")
    print(f"  unreadable      : {len(bad)}   (likely scanned -> NEEDS_OCR, no LLM cost)")
    print(f"  CSV written to  : {a.out}")
    if mirror_root:
        fresh = sum(1 for r in rows if r["mirrored"] == "new")
        cached = sum(1 for r in rows if r["mirrored"] == "cached")
        print(f"  mirrored        : {fresh} downloaded, {cached} already on disk")
        print(f"  offline ingest  : python run_ingest.py --all --sink local "
              f"--root {a.mirror_root} --concurrency 3")

    if not ok:
        print("\nNothing readable to forecast.")
        return 1

    pages = [r["pages"] for r in ok]
    print("\nPages")
    print(f"  total           : {sum(pages):,}")
    print(f"  mean            : {statistics.mean(pages):.1f}")
    print(f"  median          : {statistics.median(pages):.0f}")
    print(f"  largest         : {max(pages):,}")
    print(f"  corpus size     : {sum(r['size_bytes'] for r in rows) / 1024 / 1024:.0f} MB")

    serial = sum(r["predicted_seconds"] for r in ok)
    print(f"\nForecast  (all {len(ok)} readable documents; subtract any already ingested)")
    print(f"  total processing: {hhmm(serial)}")
    for label, factor in (("concurrency 3 (measured 2.41x)", EFFECTIVE_CONCURRENCY),
                          ("if 4-5 reaches 3.0x", 3.0),
                          ("if it reaches 3.5x", 3.5)):
        print(f"  {label:<32}: {hhmm(serial / factor)}")

    print("\nWhere the time goes")
    print(f"  {'band':<10}{'docs':>6}{'pages':>10}{'hours':>9}{'share':>8}")
    for label, lo, hi in PAGE_BANDS:
        band = [r for r in ok if lo <= r["pages"] <= hi]
        if not band:
            continue
        secs = sum(r["predicted_seconds"] for r in band)
        print(f"  {label:<10}{len(band):>6}{sum(r['pages'] for r in band):>10,}"
              f"{secs / 3600:>9.1f}{secs / serial * 100:>7.0f}%")

    print(f"\nLargest {a.top} documents")
    print(f"  {'pages':>6}{'est.':>9}   blob")
    for r in sorted(ok, key=lambda r: -r["pages"])[:a.top]:
        print(f"  {r['pages']:>6}{r['predicted_seconds'] / 60:>8.0f}m   {r['blob_name'][:88]}")

    if bad:
        print(f"\nUnreadable ({len(bad)}) - these cost nothing and land as NEEDS_OCR")
        for r in bad[:15]:
            print(f"  {r['blob_name'][:80]}  {r['error'][:60]}")
        if len(bad) > 15:
            print(f"  ... and {len(bad) - 15} more (see {a.out})")

    return 0


if __name__ == "__main__":
    sys.exit(main())
