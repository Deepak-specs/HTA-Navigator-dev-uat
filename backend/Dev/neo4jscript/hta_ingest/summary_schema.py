"""
summary_schema.py
=================
The summary contract.

API_FIELDS are exactly what function_app.py's read_neo4j() returns to the UI,
with the POC's allowed values -- so /rulings, /therapy-areas, /decision-outcomes
and /dossier-categories keep working unchanged.

NEW fields carry the richer information without changing the API:
  document_type            what kind of publication this is
  dossier_categories       ALL dossier types covered (one PDF can hold several)
  decision_outcome_detail  like decision_outcome, plus "Not applicable"
  zin_case_number          ZIN's own case/reference number (the POC stored this in "id")

PICO fields carry the research question the assessment was framed around, where
the document states one. They are deliberately separate from patient_population
and comparator: those are descriptive prose the POC API already returns, while a
stated PICO is a specific construct and is often narrower. pico_stated lets the
UI say "not stated in this document" instead of inferring one.
"""
from __future__ import annotations

import datetime as _dt
import re

THERAPY_AREAS = ["Oncology", "Dermatology", "Neurology", "Rare Diseases",
                 "Cardiology", "Immunology", "others"]
DECISION_OUTCOMES = ["Positive", "Positive with Conditions", "Negative", "Under Review"]
DECISION_OUTCOME_DETAIL = DECISION_OUTCOMES + ["Not applicable"]
DOSSIER_CATEGORIES = ["Clinical Value Pharmaco therapeutic", "Budget Impact",
                      "Pharmaco-economic", "No Category"]
DOCUMENT_TYPES = [
    "Product assessment",            # a specific medicine / intervention
    "System or methodology advice",  # e.g. GVS clustering, frameworks, procedures
    "Package advice (general)",      # insured-package questions not tied to one product
    "Other",
]

# The 21 fields function_app.read_neo4j() reads (plus zin_reference, kept from the POC)
API_FIELDS = [
    "id", "title", "therapy_area", "drug_name", "manufacturer", "decision_type",
    "dossier_category", "decision_date", "decision_outcome", "summary", "full_text",
    "indication", "comparator", "price_per_unit", "annual_cost", "patient_population",
    "clinical_evidence", "cost_effectiveness", "budget_impact", "key_considerations",
    "tags", "zin_reference",
]
NEW_FIELDS = ["document_type", "dossier_categories", "decision_outcome_detail",
              "zin_case_number",
              # PICO (summary-v2). Must be listed here or graph.write_summary
              # drops them: it builds node properties from API_FIELDS + NEW_FIELDS.
              "pico_stated", "pico_population", "pico_intervention",
              "pico_comparator", "pico_outcomes", "pico_source"]

_STRING_FIELDS = [
    "title", "drug_name", "manufacturer", "decision_type", "summary", "indication",
    "comparator", "price_per_unit", "annual_cost", "patient_population",
    "clinical_evidence", "cost_effectiveness", "budget_impact", "zin_reference",
    "zin_case_number",
    "pico_population", "pico_intervention", "pico_comparator", "pico_source",
]
_LIST_FIELDS = ["key_considerations", "tags", "pico_outcomes"]
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _clean_str(v):
    if v is None:
        return None
    if isinstance(v, (list, dict)):
        return None
    s = str(v).strip()
    return None if s.lower() in ("", "null", "none", "n/a") else s


def _clean_list(v):
    if v is None:
        return None
    if isinstance(v, str):
        v = [v]
    if not isinstance(v, list):
        return None
    out = [str(x).strip() for x in v if x is not None and str(x).strip()]
    return out or None


def _match(value, allowed):
    """Case-insensitive match against an allowed list; returns canonical value or None."""
    if value is None:
        return None
    s = str(value).strip().lower()
    for a in allowed:
        if a.lower() == s:
            return a
    return None


def validate_summary(raw: dict, *, doc_id: str, meta_title: str | None = None,
                     meta_issued: str | None = None) -> tuple[dict, list[str]]:
    """
    Returns (clean_summary, errors). `errors` non-empty means the model
    must be asked again. Harmless issues are repaired silently.
    """
    errors: list[str] = []
    if not isinstance(raw, dict):
        return {}, ["top-level JSON value must be an object"]

    out: dict = {"id": doc_id, "full_text": None}
    for f in _STRING_FIELDS:
        out[f] = _clean_str(raw.get(f))
    for f in _LIST_FIELDS:
        out[f] = _clean_list(raw.get(f))

    # ZIN case number: the POC prompt put it in "id"; accept both
    if not out["zin_case_number"]:
        out["zin_case_number"] = _clean_str(raw.get("id")) if raw.get("id") != doc_id else None

    ta = _match(raw.get("therapy_area"), THERAPY_AREAS)
    if not ta:
        errors.append(f"therapy_area must be one of {THERAPY_AREAS}, got {raw.get('therapy_area')!r}")
    out["therapy_area"] = ta

    dt = _match(raw.get("document_type"), DOCUMENT_TYPES)
    if not dt:
        errors.append(f"document_type must be one of {DOCUMENT_TYPES}, got {raw.get('document_type')!r}")
    out["document_type"] = dt

    detail = _match(raw.get("decision_outcome_detail") or raw.get("decision_outcome"),
                    DECISION_OUTCOME_DETAIL)
    if not detail:
        errors.append(f"decision_outcome_detail must be one of {DECISION_OUTCOME_DETAIL}, "
                      f"got {raw.get('decision_outcome_detail')!r}")
    out["decision_outcome_detail"] = detail
    # API field keeps the POC's four values; "Not applicable" maps to the POC behaviour
    out["decision_outcome"] = detail if detail in DECISION_OUTCOMES else (
        "Under Review" if detail else None)

    cats_raw = raw.get("dossier_categories")
    if isinstance(cats_raw, str):
        cats_raw = [cats_raw]
    cats: list[str] = []
    bad_cats = []
    for c in cats_raw or []:
        m = _match(c, DOSSIER_CATEGORIES[:-1])
        if m and m not in cats:
            cats.append(m)
        elif not m and str(c).strip().lower() != "no category":
            bad_cats.append(c)
    if bad_cats:
        errors.append(f"dossier_categories may only contain {DOSSIER_CATEGORIES[:-1]}, got {bad_cats}")
    out["dossier_categories"] = cats

    primary = _match(raw.get("dossier_category"), DOSSIER_CATEGORIES)
    if not primary:
        primary = cats[0] if cats else None
    if primary == "No Category" and cats:
        primary = cats[0]
    if primary and primary != "No Category" and primary not in cats:
        cats.insert(0, primary)
    if not primary:
        primary = "No Category"
    out["dossier_category"] = primary

    d = _clean_str(raw.get("decision_date"))
    if d:
        if not _DATE_RE.match(d):
            errors.append(f"decision_date must be YYYY-MM-DD or null, got {d!r}")
            d = None
        else:
            try:
                _dt.date.fromisoformat(d)
            except ValueError:
                errors.append(f"decision_date is not a real date: {d!r}")
                d = None
    if not d and meta_issued and _DATE_RE.match(meta_issued[:10]):
        d = meta_issued[:10]           # fall back to ZIN's publication date
    out["decision_date"] = d

    # pico_stated is authoritative when the model supplies a boolean; otherwise
    # it is derived, so the flag can never claim a PICO that carries no content.
    raw_stated = raw.get("pico_stated")
    has_parts = any(out.get(f) for f in
                    ("pico_population", "pico_intervention", "pico_comparator"))
    if isinstance(raw_stated, bool):
        out["pico_stated"] = raw_stated and has_parts
    elif isinstance(raw_stated, str):
        out["pico_stated"] = raw_stated.strip().lower() in ("true", "yes", "1") and has_parts
    else:
        out["pico_stated"] = has_parts
    if not out["pico_stated"]:
        for f in ("pico_population", "pico_intervention", "pico_comparator",
                  "pico_outcomes", "pico_source"):
            out[f] = None

    if not out["summary"]:
        errors.append("summary is required (2-4 sentences)")
    if not out["title"]:
        out["title"] = meta_title

    return out, errors
