# """
# run_pipeline.py
# ===============
# End-to-end orchestrator for the ZIN HTA ingestion pipeline.

# Runs three phases with unified audit logging:

#   1. DISCOVERY     zin_discovery.py       -> advies_urls.jsonl
#   2. INGEST        zin_advies_ingest.py -> PDFs + meta on Azure
#   3. RECONCILE     zin_reconcile.py       -> discrepancy report

# Every run produces:

#   <root>/zin_runs/<RUN_ID>.log        full timestamped log (INFO+)
#   <root>/zin_runs/<RUN_ID>.json       machine-readable audit manifest

# Usage
# -----
#     python run_pipeline.py --root C:\\hta --information-type Advies

#     # skip discovery if you already have a fresh URL file
#     python run_pipeline.py --root C:\\hta --url-file advies_urls.jsonl --skip-discovery

# Exit codes
# ----------
#     0  clean run, no discrepancies above threshold
#     1  ingest had failures
#     2  reconciliation FAIL severity (data integrity issue)
# """

"""
run_pipeline.py
===============
End-to-end ZIN pipeline: Discovery -> Ingest -> Reconcile.
All outputs land in Azure Blob Storage (or local disk with --sink local).

Artefacts produced per run (in JSON container):

  advies_urls.jsonl                       (overwritten each run)
  discovery/<run-id>.json                 (discovery summary)
  meta/<pdf-name>.meta.json               (one per PDF)
  runs/<run-id>.json                      (full pipeline manifest)
  logs/<run-id>.log                       (uploaded at end of run)
  reports/<run-id>.json                   (reconciliation report)

Usage
-----
    az login    # once
    python run_pipeline.py --information-type Advies

    # Local uat
    python run_pipeline.py 
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys
import tempfile
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import zin_discovery
import zin_advies_ingest as zin_ingest
import zin_reconcile
from zin_sinks import build_sink, add_sink_args


# --------------------------------------------------------------------------- #
def _setup_logging(local_log_path: Path, verbose: bool) -> logging.FileHandler:
    local_log_path.parent.mkdir(parents=True, exist_ok=True)
    root = logging.getLogger()
    root.setLevel(logging.DEBUG if verbose else logging.INFO)
    fmt = logging.Formatter(
        "%(asctime)s %(levelname)-7s %(name)-18s %(message)s"
    )
    ch = logging.StreamHandler(sys.stdout)
    ch.setFormatter(fmt); ch.setLevel(logging.INFO)
    root.addHandler(ch)
    fh = logging.FileHandler(local_log_path, mode="w", encoding="utf-8")
    fh.setFormatter(fmt); fh.setLevel(logging.DEBUG if verbose else logging.INFO)
    root.addHandler(fh)
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("azure").setLevel(logging.WARNING)
    return fh


# --------------------------------------------------------------------------- #
async def _run_discovery(sink, url_blob, information_type, since, delay):
    log = logging.getLogger("pipeline.discovery")
    log.info("PHASE 1: Discovery")

    import httpx
    from datetime import datetime as _dt
    headers = {"User-Agent": zin_discovery.USER_AGENT, "Accept-Language": "nl,en"}
    async with httpx.AsyncClient(
        headers=headers, timeout=60.0, follow_redirects=True
    ) as client:
        field_name = await zin_discovery.detect_date_field(client, information_type)
        if not field_name:
            log.error("no usable date facet detected")
            return {"success": False, "count": 0}
        cfg = zin_discovery.Sweep(
            information_type=information_type,
            date_field=field_name,
            start=_dt.strptime(since, "%Y-%m-%d").date(),
            delay=delay,
        )
        pubs = await zin_discovery.sweep(client, cfg)

    lines = [
        json.dumps({"page_url": p.page_url, "title": p.title,
                    "issued": p.issued}, ensure_ascii=False)
        for p in sorted(pubs, key=lambda x: x.page_url)
    ]
    sink.put_text(url_blob, "\n".join(lines) + "\n",
                  content_type="application/x-ndjson; charset=utf-8")
    log.info("wrote %d publication URLs -> %s", len(pubs), url_blob)
    return {"success": True, "count": len(pubs),
            "date_field": field_name, "since": since,
            "url_blob": url_blob}


async def _run_ingest(sink, url_blob, information_type, concurrency, delay):
    log = logging.getLogger("pipeline.ingest")
    log.info("PHASE 2: Ingest")
    stats = await zin_ingest.run(
        sink=sink, url_source=url_blob,
        information_type=information_type,
        concurrency=concurrency, delay=delay,
    )
    log.info("ingest stats: %s", {k: v for k, v in stats.items()
                                   if k != "failures_detail"})
    return stats


async def _run_reconcile(sink, url_blob, information_type):
    log = logging.getLogger("pipeline.reconcile")
    log.info("PHASE 3: Reconciliation")
    report = await zin_reconcile.reconcile(sink, url_blob, information_type)
    zin_reconcile.print_report(report)
    return report


# --------------------------------------------------------------------------- #
async def _amain(a: argparse.Namespace) -> int:
    run_id = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H%M%SZ")

    # Log to a temp file first, upload at the very end
    tmp_log = Path(tempfile.gettempdir()) / f"zin_pipeline_{run_id}.log"
    handler = _setup_logging(tmp_log, a.verbose)

    pl = logging.getLogger("pipeline")
    pl.info("=" * 72)
    pl.info(" ZIN Pipeline run_id=%s", run_id)
    pl.info(" information_type=%s", a.information_type)
    pl.info("=" * 72)

    sink = build_sink(a)
    pl.info("sink: %s", sink.describe())

    manifest = {
        "run_id": run_id,
        "started_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "information_type": a.information_type,
        "sink": sink.describe(),
        "phases": {},
    }

    url_blob = a.url_file or f"{a.information_type.lower()}_urls.jsonl"
    exit_code = 0

    # PHASE 1
    if a.skip_discovery:
        existing = sink.get_text(url_blob)
        if not existing:
            pl.error("--skip-discovery but %s not found in sink", url_blob)
            handler.close()
            return 2
        n = sum(1 for line in existing.splitlines() if line.strip())
        pl.info("skipping discovery, reusing %s (%d URLs)", url_blob, n)
        manifest["phases"]["discovery"] = {"skipped": True, "count": n,
                                           "url_blob": url_blob}
    else:
        d = await _run_discovery(sink, url_blob, a.information_type,
                                 a.since, a.delay)
        manifest["phases"]["discovery"] = d
        if not d.get("success"):
            manifest["outcome"] = "DISCOVERY_FAILED"
            manifest["ended_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
            sink.put_json(f"runs/{run_id}.json", manifest)
            handler.close()
            return 2

    # PHASE 2
    ingest_stats = await _run_ingest(
        sink, url_blob, a.information_type, a.concurrency, a.delay,
    )
    manifest["phases"]["ingest"] = ingest_stats
    if ingest_stats.get("failed", 0) > 0:
        exit_code = max(exit_code, 1)

    # PHASE 3
    report = await _run_reconcile(sink, url_blob, a.information_type)
    manifest["phases"]["reconciliation"] = {
        **report.summary_stats(),
        "severity": report.severity,
        "notes": report.notes,
        "sample_missing_on_disk": report.missing_on_disk[:20],
        "sample_missing_from_rss": report.missing_from_rss[:20],
        "sample_orphan_on_disk": report.orphan_on_disk[:20],
    }
    sink.put_json(f"reports/{run_id}.json", asdict(report))
    if report.severity == "FAIL":
        exit_code = max(exit_code, 2)

    # Finalise manifest
    manifest["ended_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    manifest["outcome"] = {0: "OK", 1: "INGEST_FAILURES",
                           2: "RECONCILE_FAIL"}[exit_code]

    sink.put_json(f"runs/{run_id}.json", manifest)

    pl.info("=" * 72)
    pl.info(" PIPELINE OUTCOME: %s", manifest["outcome"])
    pl.info(" run_id:   %s", run_id)
    pl.info(" manifest: runs/%s.json", run_id)
    pl.info(" ingest:   %s", {k: v for k, v in ingest_stats.items()
                              if k != "failures_detail"})
    pl.info(" recon:    severity=%s  %s",
            report.severity, report.summary_stats())
    pl.info("=" * 72)

    # Flush + upload the log file itself
    handler.flush()
    handler.close()
    logging.getLogger().removeHandler(handler)
    try:
        log_text = tmp_log.read_text(encoding="utf-8")
        sink.put_text(f"logs/{run_id}.log", log_text,
                      content_type="text/plain; charset=utf-8")
    except Exception as exc:  # noqa: BLE001
        print(f"WARNING: failed to upload log file: {exc}", file=sys.stderr)

    return exit_code


def main() -> int:
    ap = argparse.ArgumentParser(
        description="ZIN end-to-end ingestion pipeline (Azure Blob by default)"
    )
    add_sink_args(ap)
    ap.add_argument("--information-type", default="Advies")
    ap.add_argument("--url-file", default=None,
                    help="blob name in JSON container (default: <type>_urls.jsonl)")
    ap.add_argument("--since", default="2008-01-01")
    ap.add_argument("--skip-discovery", action="store_true")
    ap.add_argument("--concurrency", type=int, default=4)
    ap.add_argument("--delay", type=float, default=0.25)
    ap.add_argument("-v", "--verbose", action="store_true")
    a = ap.parse_args()
    return asyncio.run(_amain(a))


if __name__ == "__main__":
    sys.exit(main())