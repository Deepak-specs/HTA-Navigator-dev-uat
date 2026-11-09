"""
Offline tests - no Neo4j, no LLM gateway needed.

    python -m pytest tests -q          (or)          python tests/test_offline.py

Uses the real extraction code and the crawler's zin_sinks.LocalSink against
sample_data/ (PDFs in sample_data/zin, metas in sample_data/zin_json/meta).
The LLM and Neo4j are replaced by in-memory fakes, so this checks the
plumbing, the change detection and the API-compatible node shape.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from hta_ingest.config import PROMPT_VERSION, Settings, TRANSLATION_VERSION  # noqa: E402
from hta_ingest.graph import doc_id_for, legacy_metadata_string  # noqa: E402
from hta_ingest.llm import LLMResult  # noqa: E402
from hta_ingest.pipeline import DocumentProcessor, plan_work  # noqa: E402
from hta_ingest.source import SourceReader  # noqa: E402
from hta_ingest.summarise import Summariser  # noqa: E402
from hta_ingest.summary_schema import API_FIELDS, validate_summary  # noqa: E402
from hta_ingest.translate import MARKER_RE, Translator  # noqa: E402

SAMPLE_ROOT = ROOT / "sample_data"


# --------------------------------------------------------------------------- #
class FakeLLM:
    """'Translates' by tagging each page; returns a canned summary JSON."""

    def __init__(self, bad_first_summary=False, drop_marker_once=False, truncate_over=None):
        self.calls = 0
        self.bad_first_summary = bad_first_summary
        self.drop_marker_once = drop_marker_once
        self.truncate_over = truncate_over

    def complete(self, system, user, max_tokens=8192, temperature=0.0):
        self.calls += 1
        if system.startswith("You are a professional Dutch-to-English"):
            if self.truncate_over and len(user) > self.truncate_over:
                return LLMResult(user[: self.truncate_over], "max_tokens")
            out = MARKER_RE.sub(lambda m: f"⟦PAGE {m.group(1)}⟧\nEN:", user)
            if self.drop_marker_once and len(MARKER_RE.findall(user)) > 1:
                self.drop_marker_once = False
                out = MARKER_RE.sub("", out, count=1)
            return LLMResult(out if MARKER_RE.search(user) else "EN:" + user, "end_turn")
        if self.bad_first_summary:
            self.bad_first_summary = False
            return LLMResult('{"therapy_area": "Hematology"}', "end_turn")
        return LLMResult(json.dumps({
            "title": "Test title", "document_type": "Product assessment",
            "therapy_area": "Rare Diseases", "decision_outcome_detail": "Positive with Conditions",
            "dossier_categories": ["Clinical Value Pharmaco therapeutic", "Pharmaco-economic",
                                   "Budget Impact"],
            "dossier_category": "Clinical Value Pharmaco therapeutic",
            "decision_date": "2008-02-25", "summary": "A summary.",
            "price_per_unit": "€4,600.00 per 300 mg vial", "tags": ["a", "b"],
        }), "end_turn")

    def stats(self):
        return {"calls": self.calls}


class FakeStore:
    def __init__(self):
        self.t, self.s = {}, {}

    def load_state(self):
        return {v["blob_name"]: {"blob_name": v["blob_name"], "id": k, "sha256": v.get("sha256"),
                                 "status": v.get("status"),
                                 "translation_version": v.get("translation_version"),
                                 "prompt_version": self.s.get(k, {}).get("prompt_version")}
                for k, v in self.t.items()}

    def load_cached_translation(self, doc_id, sha):
        t = self.t.get(doc_id)
        if t and t.get("translation_sha256") == sha and t.get("pages_en"):
            return t["pages_en"]
        return None

    def write_translation(self, *, doc_id, meta, container, sha256, pages_nl, pages_en,
                          page_count, low_text_pages):
        self.t[doc_id] = {
            "blob_name": meta.blob_name, "sha256": sha256, "translation_sha256": sha256,
            "translation_version": TRANSLATION_VERSION, "pages_en": pages_en,
            "status": "TRANSLATED",
            "rawJson": json.dumps({"extracted_text": "\n\n".join(pages_en),
                                   "metadata": legacy_metadata_string(
                                       meta.blob_name, container, sha256, meta.source_url)}),
        }

    def write_summary(self, *, doc_id, summary, model):
        self.s[doc_id] = {**summary, "prompt_version": PROMPT_VERSION}
        self.t[doc_id]["status"] = "SUMMARISED"

    def mark_status(self, *, doc_id, meta, container, status, stage=None, error=None, sha256=None):
        self.t.setdefault(doc_id, {"blob_name": meta.blob_name, "sha256": sha256})
        self.t[doc_id].update(status=status, failed_stage=stage, error=error)


def _reader():
    s = Settings.from_env().with_overrides(sink="local", root=str(SAMPLE_ROOT))
    return SourceReader(s)


def _processor(reader, store, llm):
    return DocumentProcessor(reader=reader, store=store, translator=Translator(llm, 9000),
                             summariser=Summariser(llm), container="test-1709", model="fake")


# --------------------------------------------------------------------------- #
def test_inventory_reads_samples():
    metas = _reader().list_metas()
    assert len(metas) == 3, [m.blob_name for m in metas]
    assert all(m.sha256 for m in metas)


def test_end_to_end_and_change_detection():
    reader, store, llm = _reader(), FakeStore(), FakeLLM(bad_first_summary=True)
    metas = reader.list_metas()
    work = plan_work(metas, store.load_state())
    assert [r for _, r in work] == ["NEW"] * 3

    proc = _processor(reader, store, llm)
    results = [proc.process(m, r) for m, r in work]
    assert all(r["outcome"] == "SUMMARISED" for r in results), results

    # second run: nothing to do
    assert plan_work(metas, store.load_state()) == []

    # a changed PDF (new sha in its meta) is picked up again
    metas[0].sha256 = "0" * 64
    assert [r for _, r in plan_work(metas, store.load_state())] == ["CHANGED"]

    # ids are deterministic from the blob name
    for m in metas:
        assert doc_id_for(m.blob_name) in store.s


def test_api_regex_recovers_blob_name():
    """function_app.py: apoc.text.regexGroups(raw.metadata, "'name':\\s*'([^']+)'")"""
    blob = "2008-02-25__eculizumab-soliris__eculizumab.pdf"
    meta_str = legacy_metadata_string(blob, "test-1709", "abc", "https://x/y?a='b'")
    m = re.search(r"'name':\s*'([^']+)'", meta_str)
    assert m and m.group(1) == blob


def test_translation_page_alignment_and_recovery():
    pages = ["pagina een", "", "pagina drie", "pagina vier"]
    out = Translator(FakeLLM(drop_marker_once=True), 9000).translate_pages(pages)
    assert out[1] == "" and all(out[i].startswith("EN:") for i in (0, 2, 3)), out
    long_pages = ["a" * 5000, "b" * 5000]
    out = Translator(FakeLLM(truncate_over=6000), 20000).translate_pages(long_pages)
    assert all(o.startswith("EN:") for o in out), [o[:10] for o in out]


def test_validation_rules():
    clean, errs = validate_summary(
        {"therapy_area": "rare diseases", "document_type": "System or methodology advice",
         "decision_outcome_detail": "Not applicable", "dossier_categories": [],
         "dossier_category": "No Category", "summary": "x", "id": "2020022675",
         "decision_date": "2021-02-30"},
        doc_id="abc", meta_title="T", meta_issued="2021-05-04T10:00:00Z")
    assert clean["therapy_area"] == "Rare Diseases"
    assert clean["decision_outcome"] == "Under Review"          # API keeps 4 values
    assert clean["decision_outcome_detail"] == "Not applicable"
    assert clean["zin_case_number"] == "2020022675" and clean["id"] == "abc"
    assert clean["decision_date"] == "2021-05-04"               # fallback to publication date
    assert any("real date" in e for e in errs)
    assert set(API_FIELDS) <= set(clean)


def test_extraction_keeps_numbers():
    reader = _reader()
    m = next(x for x in reader.list_metas() if "eculizumab" in x.blob_name)
    from hta_ingest.extract import extract_pdf
    text = "\n".join(extract_pdf(reader.get_pdf(m.blob_name)).pages)
    assert "€4.600,00" in text and "7,37/100" in text and "patiënten" in text
    assert not re.search(r"Pagina \d+ van \d+", text)


if __name__ == "__main__":
    import logging
    logging.basicConfig(level=logging.WARNING)
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print("PASS", name)
