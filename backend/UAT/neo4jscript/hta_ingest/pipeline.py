"""
pipeline.py
===========
meta inventory -> change detection -> download -> extract -> translate -> summarise -> Neo4j

Every document is independent: a failure is recorded on its node
(status FAILED, failed_stage, error) and the run carries on. Re-running is
always safe and only picks up NEW, CHANGED or previously failed documents.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import logging
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

from .config import (PIPELINE_VERSION, PROMPT_VERSION, TRANSLATION_VERSION,
                     Settings)
from .extract import ExtractedDoc, LOW_TEXT_PAGE_CHARS, clean_pages, extract_pdf
from .graph import doc_id_for

log = logging.getLogger("hta.pipeline")


# --------------------------------------------------------------------------- #
# Planning
# --------------------------------------------------------------------------- #
def plan_work(metas, state: dict, *, force=False, resummarise=False,
              retranslate=False, retry_ocr=False) -> list[tuple[object, str]]:
    work = []
    for m in metas:
        st = state.get(m.blob_name)
        if st is None:
            reason = "NEW"
        elif force:
            reason = "FORCE"
        elif m.sha256 and st.get("sha256") and st["sha256"] != m.sha256:
            reason = "CHANGED"
        elif st.get("status") == "NEEDS_OCR":
            reason = "RETRY_OCR" if retry_ocr else None
        elif st.get("status") != "SUMMARISED":
            reason = "RETRY"
        elif retranslate and st.get("translation_version") != TRANSLATION_VERSION:
            reason = "RETRANSLATE"
        elif resummarise and st.get("prompt_version") != PROMPT_VERSION:
            reason = "RESUMMARISE"
        else:
            reason = None
        if reason:
            work.append((m, reason))
    return work


def select_metas(metas, names=None, match=None):
    if names:
        wanted = set(names)
        found = [m for m in metas if m.blob_name in wanted]
        missing = wanted - {m.blob_name for m in found}
        for n in sorted(missing):
            log.warning("no meta file for requested name: %s", n)
        metas = found
    if match:
        terms = [t.lower() for t in match]
        metas = [m for m in metas if any(t in m.blob_name.lower() for t in terms)]
    return metas


# --------------------------------------------------------------------------- #
# Processing one document
# --------------------------------------------------------------------------- #
class DocumentProcessor:
    def __init__(self, *, reader, store, translator, summariser, container: str,
                 model: str | None, ocr=None):
        self.reader = reader
        self.store = store
        self.translator = translator
        self.summariser = summariser
        self.container = container
        self.model = model
        # An OcrReader, or None to keep the original behaviour of stopping at
        # NEEDS_OCR. Supplied only when --retry-ocr or OCR_ENABLED is set.
        self.ocr = ocr

    def process(self, meta, reason: str) -> dict:
        t0 = time.time()
        doc_id = doc_id_for(meta.blob_name)
        result = {"blob_name": meta.blob_name, "id": doc_id, "reason": reason}
        stage = "download"
        sha = meta.sha256
        try:
            pdf = self.reader.get_pdf(meta.blob_name)
            sha = hashlib.sha256(pdf).hexdigest()
            if meta.sha256 and sha != meta.sha256:
                log.warning("%s: PDF sha256 differs from its meta file (PDF updated "
                            "after the meta was written?) - using the PDF's", meta.blob_name)

            stage = "extract"
            ex = extract_pdf(pdf)
            result.update(pages=ex.page_count, chars_nl=ex.total_chars)
            if ex.needs_ocr:
                # No text layer. With OCR available the pages are read from
                # the image and the document carries on through translate and
                # summarise exactly like any other; without it, it stops here
                # as before.
                if self.ocr is None:
                    self.store.mark_status(doc_id=doc_id, meta=meta, container=self.container,
                                           status="NEEDS_OCR", stage="extract", sha256=sha,
                                           error=f"only {ex.total_chars} characters of text; "
                                                 "probably a scanned PDF")
                    result.update(outcome="NEEDS_OCR", seconds=round(time.time() - t0, 1))
                    return result

                stage = "ocr"
                log.info("%s: no text layer, reading %d pages by OCR",
                         meta.blob_name, ex.page_count)
                ocr_pages = self.ocr.read_pdf(pdf)
                ex = ExtractedDoc(
                    pages=clean_pages(ocr_pages),
                    page_count=len(ocr_pages),
                    low_text_pages=[i + 1 for i, p in enumerate(ocr_pages)
                                    if len(p.strip()) < LOW_TEXT_PAGE_CHARS],
                )
                result.update(pages=ex.page_count, chars_nl=ex.total_chars, source="ocr")

                # A scan the model could not read either is a genuine failure,
                # not a silent empty document.
                if ex.needs_ocr:
                    self.store.mark_status(doc_id=doc_id, meta=meta, container=self.container,
                                           status="NEEDS_OCR", stage="ocr", sha256=sha,
                                           error=f"OCR recovered only {ex.total_chars} "
                                                 "characters; page images may be unreadable")
                    result.update(outcome="NEEDS_OCR", seconds=round(time.time() - t0, 1))
                    return result

            stage = "translate"
            pages_en = None
            if reason not in ("FORCE", "RETRANSLATE"):
                cached = self.store.load_cached_translation(doc_id, sha)
                if cached and len(cached) == ex.page_count:
                    pages_en = cached
                    result["translation"] = "cached"
            if pages_en is None:
                pages_en = self.translator.translate_pages(ex.pages)
                self.store.write_translation(
                    doc_id=doc_id, meta=meta, container=self.container, sha256=sha,
                    pages_nl=ex.pages, pages_en=pages_en, page_count=ex.page_count,
                    low_text_pages=ex.low_text_pages)
                result["translation"] = "new"
            result["chars_en"] = sum(len(p) for p in pages_en)

            stage = "summarise"
            summary = self.summariser.summarise(doc_id, meta, pages_en)
            self.store.write_summary(doc_id=doc_id, summary=summary, model=self.model)
            result.update(outcome="SUMMARISED", title=summary.get("title"),
                          therapy_area=summary.get("therapy_area"),
                          decision_outcome=summary.get("decision_outcome_detail"),
                          dossier_categories=summary.get("dossier_categories"))
        except Exception as exc:  # noqa: BLE001 - one document must never stop the run
            log.exception("%s: FAILED at %s", meta.blob_name, stage)
            result.update(outcome="FAILED", failed_stage=stage,
                          error=f"{type(exc).__name__}: {exc}"[:500])
            try:
                self.store.mark_status(doc_id=doc_id, meta=meta, container=self.container,
                                       status="FAILED", stage=stage,
                                       error=result["error"], sha256=sha)
            except Exception:  # noqa: BLE001
                log.exception("%s: could not record failure in Neo4j", meta.blob_name)
        result["seconds"] = round(time.time() - t0, 1)
        return result


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #
def build_arg_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(
        description="Ingest ZIN PDFs (blob storage) into Neo4j: translate NL->EN and summarise")
    sel = ap.add_argument_group("what to process (one of these is required)")
    sel.add_argument("--all", action="store_true", help="every document that is new/changed/failed")
    sel.add_argument("--names", nargs="+", help="exact blob names")
    sel.add_argument("--match", nargs="+", help="blob names containing any of these words")
    sel.add_argument("--inventory", action="store_true",
                     help="only compare meta files and PDFs in storage; no Neo4j, no LLM")
    ap.add_argument("--limit", type=int, help="process at most N documents")
    ap.add_argument("--dry-run", action="store_true", help="show the plan, change nothing")
    ap.add_argument("--force", action="store_true", help="reprocess even if up to date")
    ap.add_argument("--resummarise", action="store_true",
                    help=f"redo summaries made with an older prompt (current {PROMPT_VERSION})")
    ap.add_argument("--retranslate", action="store_true",
                    help=f"redo translations from an older version (current {TRANSLATION_VERSION})")
    ap.add_argument("--retry-ocr", action="store_true", help="retry documents marked NEEDS_OCR")
    ap.add_argument("--concurrency", type=int, help="parallel documents (default INGEST_CONCURRENCY or 2)")
    ap.add_argument("--sink", choices=["local", "azure"], help="override ZIN_SINK")
    ap.add_argument("--root", help="local root for --sink local (override ZIN_ROOT)")
    ap.add_argument("--manifest-to-sink", action="store_true",
                    help="also upload the run manifest to <json container>/runs/ "
                         "(needs write access)")
    ap.add_argument("-v", "--verbose", action="store_true")
    return ap


def _setup_logging(verbose: bool, log_file: Path) -> None:
    log_file.parent.mkdir(parents=True, exist_ok=True)
    fmt = logging.Formatter("%(asctime)s %(levelname)-7s %(name)-15s %(message)s")
    root = logging.getLogger()
    root.setLevel(logging.DEBUG if verbose else logging.INFO)
    ch = logging.StreamHandler(sys.stdout)
    ch.setFormatter(fmt)
    fh = logging.FileHandler(log_file, encoding="utf-8")
    fh.setFormatter(fmt)
    root.addHandler(ch)
    root.addHandler(fh)
    for noisy in ("azure", "neo4j", "botocore", "urllib3", "httpx"):
        logging.getLogger(noisy).setLevel(logging.WARNING)


def run_inventory(reader) -> int:
    metas = reader.list_metas()
    pdfs = reader.list_pdf_names()
    meta_names = {m.blob_name for m in metas}
    no_pdf = sorted(meta_names - pdfs)
    no_meta = sorted(pdfs - meta_names)
    no_sha = [m.blob_name for m in metas if not m.sha256]
    print(f"\nmeta files : {len(metas)}\nPDFs       : {len(pdfs)}")
    print(f"meta without PDF : {len(no_pdf)}")
    for n in no_pdf[:20]:
        print(f"   {n}")
    print(f"PDF without meta : {len(no_meta)}  (these will NOT be ingested)")
    for n in no_meta[:20]:
        print(f"   {n}")
    print(f"meta without sha256 : {len(no_sha)}\n")
    return 0


def main(argv=None) -> int:
    a = build_arg_parser().parse_args(argv)
    if not (a.all or a.names or a.match or a.inventory):
        print("Choose what to process: --all, --names ..., --match ... or --inventory")
        return 2

    run_id = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H%M%SZ")
    runs_dir = Path("ingest_runs")
    _setup_logging(a.verbose, runs_dir / f"{run_id}.log")

    settings = Settings.from_env().with_overrides(sink=a.sink, root=a.root,
                                                   concurrency=a.concurrency)
    from .source import SourceReader
    reader = SourceReader(settings)
    if a.inventory:
        return run_inventory(reader)

    from .graph import GraphStore
    store = GraphStore(settings)
    try:
        missing = store.check_schema()
        if missing:
            log.error("Neo4j constraints missing: %s. Run `python neo4j_admin.py setup` first.",
                      ", ".join(missing))
            return 2

        metas = select_metas(reader.list_metas(), a.names, a.match)
        state = store.load_state()
        work = plan_work(metas, state, force=a.force, resummarise=a.resummarise,
                         retranslate=a.retranslate, retry_ocr=a.retry_ocr)
        if a.limit:
            work = work[:a.limit]
        log.info("selected %d meta files; %d need processing", len(metas), len(work))
        for m, reason in work:
            log.info("  %-11s %s", reason, m.blob_name)
        if a.dry_run or not work:
            return 0

        from .llm import BedrockLLM
        from .summarise import Summariser
        from .translate import Translator
        llm = BedrockLLM(settings)

        # --retry-ocr implies OCR: asking to retry scanned documents without
        # the means to read them would just re-mark them NEEDS_OCR.
        ocr = None
        if a.retry_ocr or settings.ocr_enabled:
            from .ocr import OcrReader
            ocr = OcrReader(llm, dpi=settings.ocr_dpi, workers=settings.ocr_workers,
                            max_pages=settings.ocr_max_pages or None)
            log.info("OCR enabled (%d dpi, %d page workers)",
                     settings.ocr_dpi, settings.ocr_workers)

        proc = DocumentProcessor(
            reader=reader, store=store,
            translator=Translator(llm, max_chars=settings.translate_chunk_chars),
            summariser=Summariser(llm, max_chars=settings.max_summary_chars),
            container=settings.pdf_container, model=settings.bedrock_model,
            ocr=ocr)

        results = []
        started = datetime.now(timezone.utc).isoformat(timespec="seconds")
        with ThreadPoolExecutor(max_workers=max(1, settings.concurrency)) as ex:
            futures = {ex.submit(proc.process, m, r): m for m, r in work}
            for i, fut in enumerate(as_completed(futures), 1):
                res = fut.result()
                results.append(res)
                log.info("[%d/%d] %-10s %s (%ss)", i, len(work), res.get("outcome"),
                         res["blob_name"], res.get("seconds"))

        counts = {}
        for r in results:
            counts[r.get("outcome")] = counts.get(r.get("outcome"), 0) + 1
        manifest = {
            "run_id": run_id, "started_at": started,
            "ended_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "pipeline_version": PIPELINE_VERSION, "translation_version": TRANSLATION_VERSION,
            "prompt_version": PROMPT_VERSION, "source": reader.sink.describe(),
            "neo4j": settings.neo4j_uri, "counts": counts, "llm": llm.stats(),
            "documents": sorted(results, key=lambda r: r["blob_name"]),
        }
        mpath = runs_dir / f"{run_id}.json"
        mpath.write_text(json.dumps(manifest, indent=2, ensure_ascii=False), encoding="utf-8")
        if a.manifest_to_sink:
            try:
                reader.sink.put_json(f"runs/ingest-{run_id}.json", manifest)
            except Exception as exc:  # noqa: BLE001
                log.warning("could not upload manifest to storage: %s", exc)
        log.info("DONE %s  llm=%s  manifest=%s", counts, llm.stats(), mpath)
        return 1 if counts.get("FAILED") else 0
    finally:
        store.close()
