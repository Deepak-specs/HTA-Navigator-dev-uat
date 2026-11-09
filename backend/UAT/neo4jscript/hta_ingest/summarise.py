"""
summarise.py
============
English text -> validated structured summary (see summary_schema.py).

* Metadata from the crawler (title, publication date, source page) is given
  to the model as context, so it does not have to guess them.
* The source keeps Dutch number notation; the prompt converts amounts to
  English notation under explicit rules and forbids adding currency symbols
  that are not in the text.
* Invalid output gets ONE corrective retry with the validation errors.
* Documents longer than MAX_SUMMARY_CHARS are first condensed part by part
  into factual notes, then summarised from the notes.
"""
from __future__ import annotations

import json
import logging
import re

from .summary_schema import (DECISION_OUTCOME_DETAIL, DOCUMENT_TYPES,
                             DOSSIER_CATEGORIES, THERAPY_AREAS, validate_summary)

log = logging.getLogger("hta.summarise")

SYSTEM = """You are an expert HTA analyst for Zorginstituut Nederland (ZIN; before 2014 \
called CVZ). You write precise, factual summaries of ZIN publications for regulatory \
affairs professionals. You respond with ONE JSON object only - no markdown, no commentary."""

SCHEMA_TEXT = f"""{{
  "title": string,                       // concise English title of the publication
  "zin_case_number": string | null,      // ZIN/CVZ case or reference number if stated
  "document_type": one of {json.dumps(DOCUMENT_TYPES)},
  "therapy_area": one of {json.dumps(THERAPY_AREAS)},
  "drug_name": string | null,            // INN (Brand®) where applicable
  "manufacturer": string | null,
  "decision_type": string | null,        // e.g. "GVS advice (Appendix 2 conditions)", "Cost-effectiveness assessment"
  "dossier_categories": array of zero or more of {json.dumps(DOSSIER_CATEGORIES[:-1])},
  "dossier_category": one of {json.dumps(DOSSIER_CATEGORIES)},   // the MAIN one
  "decision_date": "YYYY-MM-DD" | null,
  "decision_outcome_detail": one of {json.dumps(DECISION_OUTCOME_DETAIL)},
  "summary": string,                     // 2-4 sentences
  "indication": string | null,
  "comparator": string | null,
  "price_per_unit": string | null,
  "annual_cost": string | null,
  "patient_population": string | null,
  "clinical_evidence": string | null,
  "cost_effectiveness": string | null,
  "budget_impact": string | null,
  "key_considerations": array of strings | null,   // 3-8 items
  "tags": array of strings | null,                 // 5-15 short keywords
  "zin_reference": string | null,        // "Our reference" / "Ons kenmerk" if stated
  "pico_stated": true | false,           // true ONLY if the document sets out a research question / PICO
  "pico_population": string | null,      // P - the population the question is framed around
  "pico_intervention": string | null,    // I - the intervention assessed
  "pico_comparator": string | null,      // C - what it is compared against in that question
  "pico_outcomes": array of strings | null,  // O - the endpoints assessed, one per item
  "pico_source": string | null           // where it is stated, e.g. "section 3.2 Therapeutic value"
}}"""

RULES = """Rules:
1. Use only information in the document. If something is not stated, use null. Never guess.
2. NUMBERS: the text keeps Dutch notation - "." separates thousands and "," is the decimal
   separator ("€ 4.600,00" = four thousand six hundred euros; "7,37" = seven point three seven).
   In your output write amounts in English notation ("€4,600.00", "7.37").
   Copy a currency symbol ONLY if it appears with that amount in the text; never add one.
   Keep the unit and basis stated in the text, e.g. "€4,600.00 per 300 mg vial
   (pharmacy purchase price excl. VAT)".
3. A PDF can contain several reports (e.g. a pharmacotherapeutic report, a cost-effectiveness
   assessment and a budget impact / cost forecast). List every dossier type covered in
   "dossier_categories":
     - "Clinical Value Pharmaco therapeutic": therapeutic value / farmacotherapeutisch rapport
     - "Pharmaco-economic": cost-effectiveness, doelmatigheid(stoets), ICER / QALY analyses
     - "Budget Impact": kostenprognose, budget impact analysis, expected total costs
   "dossier_category" is the main one, or "No Category" if none applies.
4. If the document contains a later addendum or update (e.g. "Toevoeging per 2 februari 2015"),
   the outcome and summary must reflect the MOST RECENT position; mention the change.
5. decision_outcome_detail:
     "Positive"                 - reimbursement / inclusion advised without restrictions
     "Positive with Conditions" - advised with conditions, restrictions, price reduction,
                                  or temporary/conditional inclusion
     "Negative"                 - advised against inclusion / not considered rational therapy
     "Under Review"             - assessment explicitly still ongoing
     "Not applicable"           - no product decision (system/methodology advice, frameworks)
6. therapy_area: pick the closest; use "others" for system advice or areas not listed.
7. decision_date: the date of the advice/decision letter if stated, else the committee
   meeting date, else null.
8. "summary": 2-4 sentences in plain English stating what was assessed, the conclusion and why.
9. PICO. Dutch assessments state the research question as "de onderzoeksvraag", "PICO",
   "vraagstelling", or as an explicit population / intervention / comparator / outcome
   breakdown, usually in the therapeutic value or cost-effectiveness chapter.
     - Set "pico_stated": true ONLY when the document actually frames such a question.
       Copy what it says; do not assemble a PICO from scattered facts, and do not reuse
       "patient_population" or "comparator" to fill the gaps.
     - System advice, package advice and policy reports normally have no PICO. For those
       set "pico_stated": false and leave every pico_* field null.
     - "pico_outcomes" lists the endpoints as separate items, e.g.
       ["overall survival", "progression-free survival", "quality of life"].
     - "pico_source" names the section or heading it was taken from, so a reader can check it.
10. document_type. Decide on what the document ASSESSES, not on what it is called.
   Many product assessments are titled "pakketadvies" or "GVS-advies"; the title is
   not the test. Ask: does this document assess ONE named medicine or intervention?
     "Product assessment"           - yes: one named medicine/intervention is assessed,
                                      whatever the document calls itself. A pakketadvies
                                      or GVS-advies about a single product belongs here.
     "System or methodology advice" - GVS clustering, assessment frameworks, procedures,
                                      methodology or system-level advice.
     "Package advice (general)"     - insured-package questions NOT tied to one product:
                                      the annual pakketadvies, or advice covering a whole
                                      care category (physiotherapy, medical devices, diet).
     "Other"                        - none of the above.
11. Return ONLY the JSON object, with double quotes, matching the schema exactly."""


def _meta_block(meta) -> str:
    return (
        "Publication metadata (from zorginstituutnederland.nl, reliable):\n"
        f"- Dutch title: {meta.title or 'unknown'}\n"
        f"- Published: {(meta.doc_issued or 'unknown')[:10]}\n"
        f"- Web page: {meta.source_page or 'unknown'}\n"
        f"- File: {meta.blob_name}\n"
    )


def parse_json_object(text: str) -> dict:
    s = text.strip()
    s = re.sub(r"^```[a-zA-Z0-9_-]*\s*", "", s)
    s = re.sub(r"\s*```$", "", s)
    first, last = s.find("{"), s.rfind("}")
    if first == -1 or last < first:
        raise ValueError("no JSON object in model output")
    return json.loads(s[first:last + 1])


class Summariser:
    def __init__(self, llm, max_chars: int = 300_000, notes_part_chars: int = 120_000):
        self.llm = llm
        self.max_chars = max_chars
        self.notes_part_chars = notes_part_chars

    # ------------------------------------------------------------------ #
    def summarise(self, doc_id: str, meta, pages_en: list[str]) -> dict:
        text = "\n\n".join(f"[Page {i + 1}]\n{p}" for i, p in enumerate(pages_en) if p.strip())
        if len(text) > self.max_chars:
            log.info("%s: %d chars -> condensing into notes first", meta.blob_name, len(text))
            text = self._condense(meta, pages_en)
            source_label = "Condensed factual notes from the full document"
        else:
            source_label = "Document (English translation)"

        prompt = (
            f"{_meta_block(meta)}\n{source_label}:\n<<<\n{text}\n>>>\n\n"
            f"Return a JSON object with this schema:\n{SCHEMA_TEXT}\n\n{RULES}"
        )
        res = self.llm.complete(SYSTEM, prompt, max_tokens=4096, temperature=0.1)
        clean, errors = self._check(res.text, doc_id, meta)
        if not errors:
            return clean

        log.info("%s: summary invalid (%s) -> corrective retry", meta.blob_name, errors)
        retry_prompt = (
            f"{prompt}\n\nYour previous answer was:\n{res.text[:6000]}\n\n"
            f"It has these problems:\n- " + "\n- ".join(errors) +
            "\n\nReturn the corrected JSON object only."
        )
        res2 = self.llm.complete(SYSTEM, retry_prompt, max_tokens=4096, temperature=0.0)
        clean, errors = self._check(res2.text, doc_id, meta)
        if errors:
            raise ValueError("summary failed validation after retry: " + "; ".join(errors))
        return clean

    def _check(self, text: str, doc_id: str, meta) -> tuple[dict, list[str]]:
        try:
            raw = parse_json_object(text)
        except (ValueError, json.JSONDecodeError) as exc:
            return {}, [f"output is not valid JSON ({exc})"]
        return validate_summary(raw, doc_id=doc_id, meta_title=meta.title,
                                meta_issued=meta.doc_issued)

    # ------------------------------------------------------------------ #
    def _condense(self, meta, pages_en: list[str]) -> str:
        parts, cur, size = [], [], 0
        for i, p in enumerate(pages_en):
            block = f"[Page {i + 1}]\n{p}"
            if cur and size + len(block) > self.notes_part_chars:
                parts.append("\n\n".join(cur))
                cur, size = [], 0
            cur.append(block)
            size += len(block)
        if cur:
            parts.append("\n\n".join(cur))

        notes = []
        for n, part in enumerate(parts, 1):
            prompt = (
                f"{_meta_block(meta)}\nPart {n} of {len(parts)} of the document:\n<<<\n{part}\n>>>\n\n"
                "Write factual notes (max ~1200 words) capturing everything relevant to an HTA "
                "summary: products, indications, comparators, outcomes and conclusions, prices and "
                "costs (copy numbers exactly as written, with their units), dates, reference "
                "numbers, conditions and any later updates. Cite page numbers like (p. 4). "
                "Plain text bullets only."
            )
            res = self.llm.complete(
                "You extract precise factual notes from HTA documents.", prompt,
                max_tokens=3000, temperature=0.0)
            notes.append(f"--- Notes for part {n} ---\n{res.text.strip()}")
        return "\n\n".join(notes)
