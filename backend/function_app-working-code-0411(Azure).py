# function_app.py
import logging, os, uuid, traceback, json, time, logging, toml, re, io, threading
import boto3
from botocore.config import Config
import asyncio
import azure.functions as func
from typing import Optional, List, Dict, Any
from azure.functions import HttpRequest, HttpResponse
import azure.functions as func
from neo4j import GraphDatabase
app = func.FunctionApp()
from dotenv import load_dotenv
from pydantic import BaseModel, Field, ConfigDict
from datetime import datetime, timezone
from enum import Enum
from openai import OpenAI
from azure.search.documents import SearchClient
from azure.core.credentials import AzureKeyCredential
from openai import AzureOpenAI
from azure.search.documents.models import VectorizedQuery
from urllib.parse import urlparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from azure.identity import DefaultAzureCredential
from azure.storage.blob import BlobServiceClient, ContentSettings
from azure.keyvault.secrets import SecretClient


# =============================================================================
# Configuration  (Sr 99)
# -----------------------------------------------------------------------------
# config.toml used to be loaded bare at import time, so a missing or malformed
# file took the whole function app down before a single route was registered —
# every endpoint returned a host-level error with nothing useful in it.
#
# Now: the file is optional, and every setting falls back to an environment
# variable of the same name. A missing setting surfaces as a 500 on the one
# route that needs it, with the key named, instead of killing the app.
# =============================================================================

CONFIG_PATH = os.getenv("HTA_CONFIG_PATH", "config.toml")

KEY_VAULT_URL = os.getenv("KEY_VAULT_URL", "https://nl-hta-navigatoruksdevkv.vault.azure.net/")
_kv_client = None
_kv_cache: Dict[str, Optional[str]] = {}

def _get_kv_client():
    global _kv_client
    if _kv_client is None and KEY_VAULT_URL:
        try:
            _kv_client = SecretClient(vault_url=KEY_VAULT_URL, credential=DefaultAzureCredential())
        except Exception as e:
            print(f"[config] Key Vault client could not be created: {type(e).__name__}: {e}")
    return _kv_client

def _kv_secret(key: str) -> Optional[str]:
    """Reads NAME_WITH_UNDERSCORES from Key Vault as NAME-WITH-DASHES."""
    if key in _kv_cache:
        return _kv_cache[key]
    value = None
    client = _get_kv_client()
    if client:
        try:
            value = client.get_secret(key.replace("_", "-")).value
        except Exception as e:
            print(f"[config] Key Vault: '{key}' not resolved ({type(e).__name__})")
    _kv_cache[key] = value
    return value

def _load_config(path: str) -> Dict[str, Any]:
    try:
        loaded = toml.load(path)
        print(f"[config] loaded {len(loaded)} keys from {path}")
        return loaded
    except FileNotFoundError:
        print(f"[config] {path} not found — falling back to environment variables")
        return {}
    except Exception as e:
        print(f"[config] {path} could not be parsed ({e}) — falling back to environment variables")
        return {}

config = _load_config(CONFIG_PATH)

_MISSING_SETTINGS: List[str] = []

def cfg(key: str, default: Any = None, required: bool = True) -> Any:
    value = config.get(key) or os.getenv(key) or _kv_secret(key) or default
    if required and (value is None or value == ""):
        if key not in _MISSING_SETTINGS:
            _MISSING_SETTINGS.append(key)
        return None
    return value

def require_settings(*keys: str) -> Optional[str]:
    absent = [k for k in keys if not (config.get(k) or os.getenv(k) or _kv_secret(k))]
    if absent:
        return f"Service is not configured: missing {', '.join(absent)}"
    return None

embedding_deployment = cfg("embedding_deployment", required=False)
index_name           = cfg("index_name")
search_endpoint      = cfg("search_endpoint")
search_key           = cfg("search_key")

NEO4J_URI      = cfg("NEO4J_URI")
NEO4J_USER     = cfg("NEO4J_USER")
NEO4J_PASSWORD = cfg("NEO4J_PASSWORD")

CONTAINER_SAS_URL   = cfg("CONTAINER_SAS_URL")
BLOB_ACCOUNT_URL    = cfg("BLOB_ACCOUNT_URL")
BLOB_CONTAINER_NAME = cfg("BLOB_CONTAINER_NAME")

# Container for user-uploaded dossier-review files (Sr 17). Falls back to the
# existing container so an unset value does not break the upload route.
DOSSIER_UPLOAD_CONTAINER = cfg(
    "DOSSIER_UPLOAD_CONTAINER", BLOB_CONTAINER_NAME, required=False
)

# ── AZ AI Gateway — Azure OpenAI (Embeddings) ─────────────────────────────────
AZ_GATEWAY_URL    = cfg("AZ_GATEWAY_URL")
AZ_API_KEY        = cfg("AZ_API_KEY")
EMBED_API_VERSION = cfg("EMBED_API_VERSION")
EMBED_MODEL       = cfg("EMBED_MODEL")

# ── AZ AI Gateway — Bedrock (Claude Sonnet 4) ─────────────────────────────────
BEDROCK_GATEWAY_URL = cfg("BEDROCK_GATEWAY_URL")
BEDROCK_API_KEY     = cfg("BEDROCK_API_KEY")
BEDROCK_REGION      = cfg("BEDROCK_REGION")
BEDROCK_MODEL       = cfg("BEDROCK_MODEL")

if _MISSING_SETTINGS:
    print(f"[config] WARNING unresolved settings: {', '.join(_MISSING_SETTINGS)}")

if BEDROCK_API_KEY:
    os.environ["AWS_BEARER_TOKEN_BEDROCK"] = BEDROCK_API_KEY

# Client construction is guarded for the same reason as the settings above: an
# absent credential must not prevent the module importing and the routes
# registering. Routes that need a client check `require_settings()` first.

def _build_az_openai_client():
    if not (AZ_API_KEY and AZ_GATEWAY_URL and EMBED_API_VERSION):
        print("[config] Azure OpenAI client not constructed — embedding settings incomplete")
        return None
    try:
        return AzureOpenAI(
            api_key        = AZ_API_KEY,
            api_version    = EMBED_API_VERSION,
            azure_endpoint = AZ_GATEWAY_URL,
        )
    except Exception as e:
        print(f"[config] Azure OpenAI client construction failed: {e}")
        return None

def _build_bedrock_client():
    if not (BEDROCK_API_KEY and BEDROCK_GATEWAY_URL and BEDROCK_REGION):
        print("[config] Bedrock client not constructed — Bedrock settings incomplete")
        return None
    try:
        return boto3.client(
            region_name           = BEDROCK_REGION,
            service_name          = "bedrock-runtime",
            endpoint_url          = BEDROCK_GATEWAY_URL,
            aws_access_key_id     = BEDROCK_GATEWAY_URL,
            aws_secret_access_key = BEDROCK_API_KEY,
            config                = Config(retries={"max_attempts": 0}),
        )
    except Exception as e:
        print(f"[config] Bedrock client construction failed: {e}")
        return None

az_openai_client = _build_az_openai_client()
bedrock_client   = _build_bedrock_client()


# =============================================================================
# Blob logging helper
# =============================================================================

def upload_log_to_blob(log_content: list, function_name: str):
    try:
        credential       = DefaultAzureCredential()
        service_client   = BlobServiceClient(account_url=BLOB_ACCOUNT_URL, credential=credential)
        container_client = service_client.get_container_client(BLOB_CONTAINER_NAME)
        log_filename     = (
            f"{function_name}/"
            f"log-{datetime.utcnow().strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:6]}.txt"
        )
        log_text   = "\n".join(log_content).encode("utf-8")
        log_buffer = io.BytesIO(log_text)
        blob_client = container_client.get_blob_client(log_filename)
        blob_client.upload_blob(
            data=log_buffer,
            overwrite=True,
            content_settings=ContentSettings(content_type="text/plain; charset=utf-8"),
        )
        print(f"[BlobLog] Log uploaded to: {log_filename}")
        return log_filename
    except Exception as e:
        print(f"[BlobLog] Failed to upload log: {e}")
        return None


def ts() -> str:
    return datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]


# =============================================================================
# Pydantic Models
# =============================================================================

class StatusCheck(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id:          str      = Field(default_factory=lambda: str(uuid.uuid4()))
    client_name: str
    timestamp:   datetime = Field(default_factory=lambda: datetime.now(timezone.utc))

class StatusCheckCreate(BaseModel):
    client_name: str

class HTARuling(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id:               str
    title:            str
    therapy_area:     str
    drug_name:        str
    manufacturer:     str
    decision_type:    str
    dossier_category: str
    decision_date:    str
    decision_outcome: str
    summary:          str
    full_text:        str
    indication:       str
    comparator:       str
    price_per_unit:        Optional[str] = None
    annual_cost:           Optional[str] = None
    patient_population:    Optional[str] = None
    clinical_evidence:     str
    cost_effectiveness:    str
    budget_impact:         str
    key_considerations:    List[str]
    tags:                  List[str]
    zin_reference:         str

class RulingSummaryRequest(BaseModel):
    ruling_id: str

class RulingSummaryResponse(BaseModel):
    ruling_id:    str
    ai_summary:   str
    key_points:   List[str]
    generated_at: str

class QAGenerateRequest(BaseModel):
    ruling_ids: List[str]
    context:    Optional[str] = ""

class PredictedQuestion(BaseModel):
    question:           str
    importance:         str
    suggested_response: str

class QAGenerateResponse(BaseModel):
    questions:    List[PredictedQuestion]
    generated_at: str

class InsightsData(BaseModel):
    total_rulings:          int
    positive_decisions:     int
    negative_decisions:     int
    conditional_decisions:  int
    under_review_decisions: int = 0
    # Sr 11 — the denominator outcome shares are taken over, so Dashboard and
    # Insights cannot disagree.
    denominator_published:  int = 0
    shares_pct:             dict = Field(default_factory=dict)
    therapy_area_breakdown: dict
    conditional_rate_by_area: dict = Field(default_factory=dict)   # Sr 8
    monthly_trends:         List[dict]
    quarterly_trends:       List[dict] = Field(default_factory=list)  # Sr 9
    comparison:             dict = Field(default_factory=dict)        # Sr 10
    # Sr 7 — `avg_review_time_days` removed: it averaged gaps between
    # consecutive decision dates, which is publication cadence, not review
    # duration, and no submission date exists to compute the real figure.
    assessment_time:        dict = Field(default_factory=dict)
    corpus_current_to:      Optional[str] = None                      # Sr 12
    top_manufacturers:      List[dict]


THERAPY_AREAS     = ["Oncology","Dermatology","Neurology","Rare Diseases","Cardiology","Immunology","others"]
DECISION_TYPES    = ["Reimbursement Recommendation","Reassessment","Extension of Indication","Price Review"]
DECISION_OUTCOMES = ["Positive","Positive with Conditions","Negative","Under Review"]
DOSSIER_CATEGORY  = ["Clinical Value Pharmaco therapeutic","Budget Impact","Pharmaco-economic","No Category"]

# ── Sr 13 — category options with design labels ───────────────────────────────
# `value` is what Neo4j stores and what filters must be built from; `label` is
# what redesign_7 shows; `code` is what generate_qa's dossier prompts expect.
#
# CROSS_DOSSIER_REVIEW is a *review mode*, not a stored value — it is what the
# user selects when their research question spans more than one dossier
# component. It must never be used as a `dossier_category` filter, because it
# matches nothing in Neo4j and silently returns an empty result set. Clients
# read `is_review_mode` to keep it out of queries.
# Mirrored in frontend/src/lib/dossierCategories.js — keep the two in step.
CROSS_DOSSIER_REVIEW = "Cross-dossier Review"

DOSSIER_CATEGORY_OPTIONS = [
    {"value": "Clinical Value Pharmaco therapeutic", "label": "Pharmacotherapeutic Dossier",
     "code": "FT",  "is_review_mode": False},
    {"value": "Pharmaco-economic",                   "label": "Pharmacoeconomic Dossier",
     "code": "FE",  "is_review_mode": False},
    {"value": "Budget Impact",                       "label": "Budget Impact Dossier",
     "code": "BIA", "is_review_mode": False},
    {"value": "No Category",                         "label": "Uncategorised",
     "code": None,  "is_review_mode": False},
    {"value": CROSS_DOSSIER_REVIEW,                  "label": CROSS_DOSSIER_REVIEW,
     "code": None,  "is_review_mode": True},
]


# =============================================================================
# CORS helpers
# =============================================================================

_ALLOWED_ORIGINS = [
    o.strip()
    for o in os.getenv("CORS_ORIGINS", "http://localhost:3000").split(",")
    if o.strip()
]

def _pick_origin(req: HttpRequest) -> str:
    origin = req.headers.get("Origin")
    if origin and origin in _ALLOWED_ORIGINS:
        return origin
    return _ALLOWED_ORIGINS[0] if _ALLOWED_ORIGINS else "*"

def _cors_headers(req: HttpRequest) -> Dict[str, str]:
    return {"Access-Control-Allow-Origin": _pick_origin(req), "Vary": "Origin"}

def _cors_preflight_headers(req: HttpRequest) -> Dict[str, str]:
    return {
        "Access-Control-Allow-Origin":  _pick_origin(req),
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Vary": "Origin",
    }

pattern = re.compile(r'[^a-zA-Z0-9\s]')

def clean_text(text):
    text = pattern.sub('', text)
    text = re.sub(r'\s+', ' ', text).strip()
    return text


# =============================================================================
# Neo4j helpers
# =============================================================================

def get_driver():
    return GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))

# Fields projected out of a SummaryDocuments node, shared by the full-corpus
# read and the single-node read so the two can never drift.
RULING_FIELDS = [
    "id","title","therapy_area","drug_name","manufacturer",
    "decision_type","dossier_category","decision_date","decision_outcome",
    "summary","full_text","indication","comparator","price_per_unit",
    "annual_cost","patient_population","clinical_evidence",
    "cost_effectiveness","budget_impact","key_considerations","tags",
    "zin_reference",
    # Properties the current ingestion writes that the original field list
    # predates. `dossier_categories` (plural) is a list: a ruling can span more
    # than one dossier component, which the singular cannot express.
    # `zin_case_number` is now the populated reference — `zin_reference` exists
    # in rawJson but is blank.
    "zin_case_number","dossier_categories","decision_outcome_detail",
    "document_type",
    # PICO (summary-v2). The research question the assessment was framed
    # around, where the publication states one. Most do not: pico_stated is
    # false far more often than true, and the UI says so rather than
    # inferring a PICO from scattered facts.
    "pico_stated","pico_population","pico_intervention","pico_comparator",
    "pico_outcomes","pico_source",
]

# Subset returned by list endpoints — everything the result rows and facets
# need, and nothing that costs a full-text transfer per ruling (Sr 30).
#
# pico_stated travels with the list so Ruling Search can filter on it. It is a
# boolean, not the PICO text — the six pico_* fields stay on the detail read
# only, so the list does not carry a research question per ruling.
RULING_LIST_FIELDS = [
    "id","title","therapy_area","drug_name","manufacturer",
    "decision_type","dossier_category","decision_date","decision_outcome",
    "summary","pico_stated",
    # Every dossier component a ruling covers — the Dossier type facet counts
    # and filters on this list, not on the single primary `dossier_category`.
    "dossier_categories",
]


def _node_to_ruling(node) -> Dict[str, Any]:
    """Projects a Neo4j node, backfilling absent fields from its rawJson blob."""
    item = {k: node.get(k) for k in RULING_FIELDS}
    raw  = node.get("rawJson")
    if isinstance(raw, str):
        try:
            raw_obj = json.loads(raw)
            if isinstance(raw_obj, dict):
                for k in RULING_FIELDS:
                    if item.get(k) is None and k in raw_obj:
                        item[k] = raw_obj[k]
        except json.JSONDecodeError:
            pass

    # ── Schema reconciliation ─────────────────────────────────────────────
    # The ingestion renamed `zin_reference` to `zin_case_number`; the old key
    # survives in rawJson but is empty, so a plain backfill finds nothing and
    # the source-document card renders blank. Map it explicitly.
    if not item.get("zin_reference") and item.get("zin_case_number"):
        item["zin_reference"] = item["zin_case_number"]

    # A ruling spanning several dossier components now carries the list in
    # `dossier_categories`; keep the singular populated for existing filters.
    cats = item.get("dossier_categories")
    if isinstance(cats, list) and cats and not item.get("dossier_category"):
        item["dossier_category"] = cats[0]

    return item


def _ruling_categories(r: Dict[str, Any]) -> List[str]:
    """All dossier types a ruling covers — never empty.

    Facets and filters count a ruling once under EACH type in its
    `dossier_categories` list. The "No Category" rulings store an empty list
    `[]`, so an empty or missing list falls back to the primary
    `dossier_category`. Mirrored by rulingCategories() in
    frontend/src/lib/savedSearches.js — keep the two in step.
    """
    cats = r.get("dossier_categories")
    if isinstance(cats, list) and any(cats):
        return [c for c in cats if c]
    return [r.get("dossier_category") or "No Category"]


# ── Corpus cache (Sr 31) ──────────────────────────────────────────────────────
# `read_neo4j()` fetches every SummaryDocuments node including `full_text`, and
# five endpoints call it — so a single page load could pull the whole corpus
# several times over. The redesign adds facet counts, per-area conditional rates
# and quarterly aggregates on top of that, which would multiply the cost again.
#
# A short process-local TTL cache is enough: the index refreshes once each
# weekday morning, so a few minutes of staleness is invisible, and Azure
# Functions keeps a warm worker alive long enough for the cache to pay off.
# Set HTA_CORPUS_CACHE_TTL=0 to disable.

_CORPUS_CACHE_TTL = int(cfg("HTA_CORPUS_CACHE_TTL", 300, required=False) or 0)
_corpus_cache: Dict[str, Any] = {"data": None, "at": 0.0}
_corpus_lock = threading.Lock()


def invalidate_corpus_cache() -> None:
    with _corpus_lock:
        _corpus_cache["data"] = None
        _corpus_cache["at"]   = 0.0


# How much translated document text to carry per ruling (chars).
#
# `full_text` is not written by the ingestion — the property key does not exist
# in the database at all. The real text lives at
# (TranslatedDocuments)-[:HAS_PAGES]->(DocumentPages).pages_en, around 56k chars
# across ~20 pages per ruling. Holding all of that for a full corpus would be
# tens of megabytes in a function worker, so an excerpt is pulled instead.
#
# It matters because `_score_ruling_relevance` and the Insights prompt both read
# `full_text`: with it empty they were scoring and summarising on title and
# summary alone, discarding the document itself.
FULL_TEXT_EXCERPT_CHARS = 4000


def _fetch_text_excerpts(session) -> Dict[str, str]:
    """id -> leading excerpt of the translated document text."""
    excerpts: Dict[str, str] = {}
    try:
        cypher = """
        MATCH (t:TranslatedDocuments)-[:HAS_PAGES]->(p:DocumentPages)
        RETURN t.id AS id, p.pages_en[0..3] AS head
        """
        for rec in session.run(cypher):
            head = rec["head"]
            if isinstance(head, list):
                text = "\n\n".join(str(x) for x in head if x)
            else:
                text = str(head or "")
            if text.strip():
                excerpts[rec["id"]] = text[:FULL_TEXT_EXCERPT_CHARS]
    except Exception as e:
        # Non-fatal: rulings simply keep whatever full_text they already had.
        print(f"[corpus] text excerpt fetch failed: {e}")
    return excerpts


def read_neo4j(force: bool = False):
    now = time.time()
    if not force and _CORPUS_CACHE_TTL > 0:
        cached = _corpus_cache.get("data")
        if cached is not None and (now - _corpus_cache.get("at", 0.0)) < _CORPUS_CACHE_TTL:
            return cached

    try:
        print("read_neo4j called.........")
        driver = get_driver()
        out    = []
        cypher = "MATCH (s:SummaryDocuments) RETURN s;"
        with driver.session() as session:
            for rec in session.run(cypher):
                out.append(_node_to_ruling(rec["s"]))

            # One extra query for the whole corpus, not one per ruling, and the
            # result is cached alongside it.
            excerpts = _fetch_text_excerpts(session)
            if excerpts:
                filled = 0
                for r in out:
                    if not r.get("full_text") and r.get("id") in excerpts:
                        r["full_text"] = excerpts[r["id"]]
                        filled += 1
                print(f"[corpus] text excerpt attached to {filled}/{len(out)} rulings")

        if _CORPUS_CACHE_TTL > 0:
            with _corpus_lock:
                _corpus_cache["data"] = out
                _corpus_cache["at"]   = time.time()
        return out
    except Exception as e:
        print(str(e))
        print("Error details..", traceback.format_exc())
        # Serve a stale copy rather than an empty corpus — an empty list renders
        # as "0 rulings" everywhere, which looks like data loss to the user.
        stale = _corpus_cache.get("data")
        return stale if stale is not None else []


# ── Imposed conditions (Sr 15) ────────────────────────────────────────────────
# The detail page needs the operative conditions attached to a conditional
# approval, numbered, as distinct items. The corpus has no such field, so they
# are derived from the text we do hold.
#
# IMPORTANT: this is extraction, not inference. Anything that does not look like
# a stated condition is left out rather than guessed at, and `source` records
# where each item came from so the UI can be honest about provenance. Rulings
# that are not conditional return an empty list.

_CONDITION_LABELS = [
    (re.compile(r"\b(prior|previous)\s+(therapy|treatment)|stabilis|stabiliz|ACE inhibitor|ARB\b", re.I),
     "Prior therapy"),
    (re.compile(r"\binitiat|\bin hospital\b|hospital[- ]only|specialist|cardiologist|outpatient clinic", re.I),
     "Initiation setting"),
    (re.compile(r"\bregistr(y|ation)\b|real[- ]world data|follow[- ]up data", re.I),
     "Registry participation"),
    (re.compile(r"\bprice (arrangement|agreement)\b|financial arrangement|confidential|discount|rebate", re.I),
     "Financial arrangement"),
    (re.compile(r"\bre-?assess|review after|revaluat", re.I),
     "Re-assessment"),
    (re.compile(r"\bstart.{0,5}stop\b|stopping criteri|discontinu", re.I),
     "Start/stop criteria"),
]


def _label_condition(text: str) -> str:
    for pattern, label in _CONDITION_LABELS:
        if pattern.search(text):
            return label
    return "Condition"


def _derive_conditions(ruling: Dict[str, Any]) -> List[Dict[str, Any]]:
    outcome = (ruling.get("decision_outcome") or "")
    if "condition" not in outcome.lower():
        return []

    items: List[Dict[str, Any]] = []
    seen: set = set()

    def add(text: str, source: str) -> None:
        clean = re.sub(r"\s+", " ", str(text or "")).strip(" .;")
        if len(clean) < 20:
            return
        key = clean.lower()[:120]
        if key in seen:
            return
        seen.add(key)
        items.append({
            "n":      len(items) + 1,
            "label":  _label_condition(clean),
            "text":   clean,
            "source": source,
        })

    # key_considerations is the closest thing the corpus has to a condition list.
    considerations = ruling.get("key_considerations")
    if isinstance(considerations, list):
        for entry in considerations:
            add(entry, "key_considerations")
    elif isinstance(considerations, str) and considerations.strip():
        for entry in re.split(r"[\n;]|(?:^|\s)[-•*]\s", considerations):
            add(entry, "key_considerations")

    # Sentences in the summary that state a condition explicitly.
    summary = ruling.get("summary") or ""
    for sentence in re.split(r"(?<=[.!?])\s+", summary):
        if re.search(r"\b(provided that|on condition|subject to|only if|must be|conditional upon)\b",
                     sentence, re.I):
            add(sentence, "summary")

    return items


def _source_pages(ruling_id: str) -> Dict[str, Any]:
    """Original Dutch and translated English page text (Sr 15 / Sr 56).

    The source rulings are Dutch and the app shows an English rendering, with no
    way to see the original — which matters when the text is quoted in a
    submission.

    SCHEMA NOTE. An earlier version of this looked for `dutch_text`,
    `original_text`, `source_text` and friends on TranslatedDocuments. None of
    those properties exist. The page text lives one hop further out:

        (TranslatedDocuments {id})-[:HAS_PAGES]->(DocumentPages)

    with `pages_nl` and `pages_en` as parallel lists of per-page strings. Both
    are returned so the detail view can show them side by side and line up a
    translated passage against its original.
    """
    out: Dict[str, Any] = {"nl": None, "en": None, "page_count": 0}
    try:
        driver = get_driver()
        cypher = """
        MATCH (t:TranslatedDocuments {id: $id})-[:HAS_PAGES]->(p:DocumentPages)
        RETURN p.pages_nl AS nl, p.pages_en AS en
        LIMIT 1
        """
        with driver.session() as session:
            rec = session.run(cypher, id=ruling_id).single()
            if not rec:
                return out

            def join(pages) -> Optional[str]:
                if isinstance(pages, list):
                    parts = [str(p) for p in pages if p and str(p).strip()]
                    return "\n\n".join(parts) if parts else None
                if isinstance(pages, str) and pages.strip():
                    return pages
                return None

            nl, en = rec["nl"], rec["en"]
            out["nl"] = join(nl)
            out["en"] = join(en)
            out["page_count"] = len(nl) if isinstance(nl, list) else (len(en) if isinstance(en, list) else 0)
    except Exception as e:
        print(f"_source_pages failed for id={ruling_id}: {e}")
    return out


def read_neo4j_one(ruling_id: str) -> Optional[Dict[str, Any]]:
    """Single ruling by id (Sr 14).

    `get_ruling` used to pull all 487 nodes and linear-scan them to return one.
    This matches on the id in Cypher instead. Falls back to the cached corpus if
    the direct read finds nothing, so ids that only exist inside rawJson still
    resolve.
    """
    try:
        driver = get_driver()
        cypher = "MATCH (s:SummaryDocuments {id: $id}) RETURN s LIMIT 1;"
        with driver.session() as session:
            for rec in session.run(cypher, id=ruling_id):
                return _node_to_ruling(rec["s"])
    except Exception as e:
        print(f"read_neo4j_one failed for id={ruling_id}: {e}")
        print("Error details..", traceback.format_exc())

    return next((r for r in read_neo4j() if r.get("id") == ruling_id), None)

def read_neo4j_translatedDocuments(ruling_id):
    try:
        print("read_neo4j_translatedDocuments called.........")
        driver = get_driver()
        with driver.session() as session:
            query  = "MATCH (d:TranslatedDocuments) WHERE d.id = $id RETURN d"
            result = session.run(query, id=ruling_id)
            for record in result:
                node = record["d"]
                return node
        return []
    except Exception as e:
        print(str(e))
        print("Error details..", traceback.format_exc())
        return []

def read_neo4j_filename(ruling_id):
    print("read_neo4j_filename called........")
    driver = get_driver()
    with driver.session() as session:
        query = """
        MATCH (n:TranslatedDocuments {id: $id})
        WITH apoc.convert.fromJsonMap(n.rawJson) AS raw
        RETURN apoc.text.regexGroups(raw.metadata, "'name':\\\\s*'([^']+)'")[0][1] AS name
        """
        result = session.run(query, id=ruling_id)
        for record in result:
            filename = record['name']
            return filename


# =============================================================================
# Enum definitions
# =============================================================================

class TherapyAreaEnum(str, Enum):
    oncology      = "Oncology"
    dermatology   = "Dermatology"
    neurology     = "Neurology"
    rare_diseases = "Rare Diseases"
    cardiology    = "Cardiology"
    immunology    = "Immunology"
    others        = "others"

class DecisionOutcomeEnum(str, Enum):
    positive                 = "Positive"
    positive_with_conditions = "Positive with Conditions"
    negative                 = "Negative"
    under_review             = "Under Review"

class DossierCategoryEnum(str, Enum):
    clinical_value_pharmaco_therapeutic = "Clinical Value Pharmaco therapeutic"
    budget_impact                       = "Budget Impact"
    pharmaco_economic                   = "Pharmaco-economic"
    nocategory                          = "No Category"

class HTADetailedResponse(BaseModel):
    id:               Optional[str] = Field(None, description="Document or case identifier")
    title:            Optional[str] = None
    therapy_area:     TherapyAreaEnum
    drug_name:        Optional[str] = None
    manufacturer:     Optional[str] = None
    decision_type:    Optional[str] = Field(None, description="e.g., Reimbursement Recommendation")
    dossier_category: DossierCategoryEnum
    decision_date:    Optional[str] = Field(None, description="YYYY-MM-DD if present")
    decision_outcome: DecisionOutcomeEnum
    summary:          Optional[str] = None
    full_text:        Optional[str] = None
    indication:       Optional[str] = None
    comparator:       Optional[str] = None
    price_per_unit:        Optional[str] = None
    annual_cost:           Optional[str] = None
    patient_population:    Optional[str] = None
    clinical_evidence:     Optional[str] = None
    cost_effectiveness:    Optional[str] = None
    budget_impact:         Optional[str] = None
    key_considerations:    Optional[List[str]] = None
    tags:                  Optional[List[str]] = None
    zin_reference:         Optional[str] = None

    class Config:
        use_enum_values = True


# =============================================================================
# UserMessage helper
# =============================================================================

class UserMessage:
    def __init__(self, role: str, content: str):
        if role not in ("system", "user", "assistant", "tool"):
            raise ValueError("role must be one of: system | user | assistant | tool")
        self.role    = role
        self.content = content

    def to_dict(self) -> dict:
        return {"role": self.role, "content": self.content}


# =============================================================================
# AI helpers
# =============================================================================

def get_ai_summary(context: str) -> HTADetailedResponse:
    system_message = (
        "You are an expert HTA analyst for Zorginstituut Nederland. "
        "Provide concise, professional summaries of HTA rulings for regulatory affairs professionals. "
        "Respond ONLY with a single JSON object that conforms exactly to the requested schema. "
        "Do not include any commentary before or after the JSON."
    )

    prompt = f"""
    Analyze the following HTA document and return ONLY a JSON object with these fields.
    If a field is not present in the document, either omit it or set it to null. Do not hallucinate.

    Document:
    {context}

    Return JSON with the following keys and types:

    {{
    "id": string | null,
    "title": string | null,
    "therapy_area": one of ["Oncology","Dermatology","Neurology","Rare Diseases","Cardiology","Immunology","others"],
    "drug_name": string | null,
    "manufacturer": string | null,
    "decision_type": string | null,
    "decision_date": string | null,
    "decision_outcome": one of ["Positive","Positive with Conditions","Negative","Under Review"],
    "dossier_category": one of ["Clinical Value Pharmaco therapeutic", "Budget Impact", "Pharmaco-economic", "No Category"]
    "summary": string | null,
    "full_text": string | null,
    "indication": string | null,
    "comparator": string | null,
    "price_per_unit": string | null,
    "annual_cost": string | null,
    "patient_population": string | null,
    "clinical_evidence": string | null,
    "cost_effectiveness": string | null,
    "budget_impact": string | null,
    "key_considerations": [string] | null,
    "tags": [string] | null,
    "zin_reference": string | null
    }}

    Strict requirements:
    - Use only information explicitly present in the document.
    - "therapy_area" must be exactly one of the allowed values above.
    - "decision_outcome" must be exactly one of the allowed values above.
    - "dossier_category" must be exactly one of the allowed values above.
    - If the decision date is present, format as YYYY-MM-DD; otherwise use null.
    - Keep "summary" to 2-4 clear sentences.
    - Return ONLY the JSON object, with double quotes around keys/strings.
    """

    bedrock_request = {
        "modelId":  BEDROCK_MODEL,
        "system":   [{"text": system_message}],
        "messages": [{"role": "user", "content": [{"text": prompt}]}],
        "inferenceConfig": {"temperature": 0, "maxTokens": 4000},
    }

    try:
        resp = bedrock_client.converse(**bedrock_request)
    except Exception as e:
        raise ValueError(f"Bedrock converse call failed: {e}") from e

    raw_content = None
    try:
        raw_content = resp["output"]["message"]["content"][0]["text"]
    except (KeyError, IndexError, TypeError) as parse_err:
        raise ValueError(f"Failed to extract text from Bedrock response: {parse_err}") from parse_err

    if not raw_content:
        raise ValueError("Model returned no content.")

    clean = raw_content.strip()
    if clean.startswith("```"):
        clean = clean.split("```", 2)[1]
        if clean.startswith("json"):
            clean = clean[4:]
        clean = clean.rsplit("```", 1)[0].strip()

    try:
        parsed = json.loads(clean)
    except json.JSONDecodeError:
        raise ValueError(f"Model did not return valid JSON: {raw_content[:500]}")

    return HTADetailedResponse(**parsed)


# =============================================================================
# Per-dossier prompt builder
# =============================================================================

DOSSIER_CONFIGS = {
    "FT": {
        "name": "Pharmacotherapeutic Dossier (FT)",
        "code": "FT",
        "framework": """
### PHARMACOTHERAPEUTIC DOSSIER (FT)
**Purpose:** Evaluates whether the new therapy demonstrates added therapeutic value within the Dutch healthcare context.

**Assessment Categories:**

**1.1 Disease Context & Unmet Medical Need**
  - What is the clinical course of the disease?
  - Is there a clearly demonstrated unmet medical need?
  - What are the incidence and prevalence in the Netherlands?
  - How severe and progressive is the disease?

**1.2 Positioning in the Treatment Pathway**
  - What is the current standard of care in the Netherlands?
  - Is the proposed PICO aligned with Dutch clinical guidelines?
  - Where does this therapy fit in the treatment pathway?
  - Is the chosen comparator appropriate?

**1.3 Favorable Effects (Clinical Benefit)**
  - What are the primary and secondary efficacy endpoints?
  - Is the magnitude of clinical benefit statistically and clinically significant?
  - Are study populations representative of the Dutch patient population?

**1.4 Unfavorable Effects (Safety Profile)**
  - What are the most clinically significant adverse events?
  - How does the safety profile compare to standard of care?
  - What is the discontinuation rate due to adverse events?

**1.5 Experience and Applicability**
  - Is there sufficient real-world evidence to support findings?
  - Are trial conditions applicable to Dutch clinical practice?

**1.6 Evidence-to-Conclusion**
  - Does the therapy meet the "state of the science and practice" standard?
  - Is the overall benefit-risk balance favorable?
  - What is the certainty of evidence?
""",
    },
    "BIA": {
        "name": "Budget Impact Dossier (BIA)",
        "code": "BIA",
        "framework": """
### BUDGET IMPACT DOSSIER (BIA)
**Purpose:** Evaluates the financial impact of introducing the new intervention to the Dutch healthcare system.

**Assessment Categories:**

**2.1 Disease Context & Current Treatment Landscape**
  - What is the clinical course and how does it affect healthcare resource utilization?
  - What medicines are currently used and what are their associated costs?

**2.2 Assumptions Used in the Budget Impact**
  - What is the estimated eligible patient population and how was this derived?
  - What assumptions are made regarding off-label use and treatment switching?
  - What market penetration rates are assumed over the 3-year horizon?
  - What is the assumed average dosage, treatment duration, and cost per patient per year?
  - Are BIA assumptions consistent with the pharmacoeconomic model?

**2.3 Calculation of the Budget Impact**
  - What are the projected total incremental costs for Years 1, 2, and 3?
  - What is the net budget impact after accounting for substitution?
  - How sensitive are projections to changes in key assumptions?
  - Are cost calculations transparent and based on Dutch-specific data?
""",
    },
    "FE": {
        "name": "Pharmacoeconomic Dossier (FE)",
        "code": "FE",
        "framework": """
### PHARMACOECONOMIC DOSSIER (FE)
**Purpose:** Evaluates the cost-effectiveness of the new intervention relative to the comparator, following Dutch pharmacoeconomic guidelines.

**Assessment Categories:**

**3.1 Outline of the Economic Evaluation**
  - What PICO is used in the economic model?
  - Is the chosen model structure appropriate for the disease?
  - Is the time horizon sufficient to capture all relevant costs and effects?

**3.2 Methods and Model Inputs**
  - What clinical input data are used and are they from the pivotal trial?
  - What assumptions are made regarding extrapolation of survival curves?
  - What utility values are used and are they from a Dutch population?
  - What cost inputs are included and are they based on Dutch unit costs?

**3.3 Results, Discussion, and Conclusion**
  - What is the base-case ICER (EUR/QALY) and how does it compare to the threshold?
  - What disease-severity threshold is applied and is the justification well-supported?
  - What are the key drivers of uncertainty in the ICER?
  - What do scenario analyses reveal about robustness of the cost-effectiveness conclusion?
""",
    },
}

# Total ruling text given to each dossier prompt. generate_qa splits it evenly
# across the selected rulings, so every ruling is read. It used to be 8,000
# chars in total, which with several rulings left the model reading mostly the
# first one while the questions were attributed across all of them.
#
# Raised 48,000 -> 150,000 when the FACTS blocks were added. The ceiling is
# applied TWICE — once per ruling as `per_ruling_chars` in generate_qa, then
# again over the joined result by _truncate_context below — so anything added
# to the ruling blocks eats into it and silently cuts the tail rulings unless
# the ceiling moves with it.
#
# Cost: three dossier prompts run in parallel, each carrying the full context,
# so input tokens are roughly 3x this figure per generation. Override without
# a code change if that lands wrong.
MAX_RULING_CHARS = int(cfg("HTA_MAX_RULING_CHARS", 150000, required=False) or 150000)

# How much of the user's uploaded dossier reaches the prompt as [D1]. It was
# 8,000 while DOSSIER_EXTRACT_LIMIT stores 60,000, so 87% of the document the
# user uploaded was being extracted, stored, and then never shown to the model.
# This rides in user_context, which _truncate_context never touches, so it is
# a separate budget from MAX_RULING_CHARS above.
MAX_DOSSIER_CHARS = int(cfg("HTA_MAX_DOSSIER_CHARS", 24000, required=False) or 24000)

def _truncate_context(text: str) -> str:
    s = str(text)
    if len(s) > MAX_RULING_CHARS:
        return s[:MAX_RULING_CHARS] + "\n\n[Document truncated for brevity]"
    return s


# The structured fields worth naming to the model, in the order a reviewer
# would read them. These come off SummaryDocuments and are already loaded on
# every generation request: read_neo4j() projects through _node_to_ruling(),
# which copies all of RULING_FIELDS. generate_qa used to take `title` and
# `decision_date` and discard the other thirty.
_FACT_LABELS = [
    ("drug_name",               "Drug"),
    ("manufacturer",            "Manufacturer"),
    ("indication",              "Indication"),
    ("comparator",              "Comparator"),
    ("patient_population",      "Population"),
    ("decision_outcome_detail", "Outcome"),
    ("document_type",           "Document type"),
    ("dossier_categories",      "Dossier categories"),
]

_EMPTY_VALUES = {"", "none", "null", "n/a", "not stated", "unknown"}


def _ruling_facts(summary: Dict[str, Any]) -> str:
    """A short labelled block of one ruling's structured fields, or "".

    Why this exists: without it the model has to re-derive the comparator and
    population from the translated prose, which it does inconsistently and
    cannot cite. Naming them lets a generated question reference the actual
    comparator the committee assessed.

    Empty fields are omitted rather than printed blank — a label with no value
    spends context and invites the model to fill it in.
    """
    if not summary:
        return ""

    lines = []
    for key, label in _FACT_LABELS:
        val = summary.get(key)
        if isinstance(val, (list, tuple)):
            val = ", ".join(str(v).strip() for v in val if v)
        val = str(val).strip() if val is not None else ""
        if val and val.lower() not in _EMPTY_VALUES:
            lines.append(f"{label}: {val}")

    # PICO is gated on pico_stated, and the false branch is deliberate. The
    # ingest validator nulls every pico_* field when the flag is false, so
    # saying "none" outright is what stops the model assembling a research
    # question the publication never framed. Verified: zero of 873 documents
    # carry a partial PICO.
    if summary.get("pico_stated"):
        parts = []
        for key, letter in (("pico_population",   "P"),
                            ("pico_intervention", "I"),
                            ("pico_comparator",   "C")):
            val = summary.get(key)
            if val and str(val).strip():
                parts.append(f"{letter}: {str(val).strip()}")
        outcomes = summary.get("pico_outcomes")
        if isinstance(outcomes, (list, tuple)) and any(outcomes):
            parts.append("O: " + ", ".join(str(o).strip() for o in outcomes if o))
        if parts:
            source = summary.get("pico_source")
            cite   = f"  [stated in {source}]" if source else ""
            lines.append("Research question (PICO) — " + " | ".join(parts) + cite)
    else:
        lines.append(
            "Research question (PICO): not stated — this publication does not "
            "frame one. Do not infer a PICO for this ruling."
        )

    return "--- FACTS ---\n" + "\n".join(lines) + "\n--- END FACTS ---" if lines else ""

def _build_single_dossier_prompt(dossier_code: str, rulings_context: str, user_context: str) -> str:
    cfg               = DOSSIER_CONFIGS[dossier_code]
    truncated_context = _truncate_context(rulings_context)
    return f"""
    You are a senior HTA reviewer for a Zorginstituut Nederland (ZIN) submission review preparing
    an early feedback pack for an HTA submitter. Your goal is to proactively surface likely questions,
    objections, and concerns that HTA bodies may raise, grounded in precedents from past HTA rulings
    in comparable configurations {cfg['framework']}
    Your output should help the submitter anticipate evidence gaps, methodological critiques,
    and payer-relevant issues.

    ## RULING DOCUMENTS
    Each ruling starts with a header such as "=== [R1] ... ===". Use these references.

    Each ruling may carry a "--- FACTS ---" block before its text. Those are the
    structured fields extracted from the published assessment: treat them as
    authoritative and prefer them over anything you infer from the prose. Name the
    comparator, population and outcome from the FACTS where a question turns on
    them, and cite the ruling as usual.

    Where a ruling's FACTS say the research question is "not stated", that is a
    verified absence, not missing data — the publication does not frame a PICO.
    Do not construct one for that ruling.
    {truncated_context}

    ## ADDITIONAL CONTEXT FROM USER
    May contain a "[D1] THE SUBMITTER'S OWN DOSSIER" block and/or a
    "[D2] THE USER'S SUPPORTING DOCUMENT" block. Both are valid sources: draw on
    them and cite them as [D1] or [D2] respectively. They are the user's own
    documents, so never attribute their contents to one of the rulings above,
    and never conflate the two with each other.
    {user_context if user_context else "None provided."}

    ## INSTRUCTIONS
    Generate 8-10 predicted questions that ZIN assessors are likely to raise for the {cfg['name']}.
    For each question provide:
    - The predicted question
    - Importance level: high / medium / low
    - A suggested response strategy (2-3 sentences maximum, grounded in the sources)
    - source_ruling_refs: the reference(s) the question is based on, e.g. ["R2"] or ["D1"]

    ## STRICT OUTPUT RULES
    - Generate EXACTLY 8-10 questions (not more, not fewer)
    - Each suggested_response must be 2-3 sentences MAXIMUM
    - Use ONLY information from the sources above — the rulings and, where present,
      the submitter's [D1] dossier
    - NEVER write a reference label such as R1, R2 or D1 inside `question` or
      `suggested_response`; they are internal and meaningless to the reader.
      NAME the source in prose instead, using the drug or subject from its header:
      "in the zanubrutinib assessment ZIN accepted ...", "your dossier states ...".
      Do NOT retreat to a vague "previous ZIN assessments have ..." — an unnamed
      precedent cannot be checked against the ruling you cite, and someone
      preparing a submission has to be able to verify every claim.
    - Where a ruling supports a point, give the specific finding ZIN actually
      reached — the figure, the condition, the reasoning — not a general tendency.
    - Do NOT hallucinate data, statistics, or clinical outcomes not present in the documents
    - Importance must be exactly one of: high, medium, low
    - source_ruling_refs must contain only references that appear above (R1, R2 … and D1
      where present), most relevant first; list more than one only if the question
      genuinely draws on several. A question drawn from the dossier must cite D1, not
      a ruling.
    - Return ONLY valid JSON — no markdown fences, no commentary

    ## OUTPUT FORMAT
    Return ONLY this JSON object:
    {{
    "dossier_name": "{cfg['name']}",
    "dossier_code": "{cfg['code']}",
    "predicted_questions": [
        {{
        "question": "<Predicted question ZIN assessors are likely to ask>",
        "importance": "high" | "medium" | "low",
        "suggested_response": "<2-3 sentences; name any source in prose (e.g. \"the zanubrutinib assessment\"), never R1/R2/D1>",
        "source_ruling_refs": ["R1"]
        }}
    ]
    }}
    """

def generate_single_dossier(dossier_code: str, node: Any, user_context: str) -> Optional[dict]:
    try:
        prompt         = _build_single_dossier_prompt(dossier_code, node, user_context)
        system_message = (
            "You are an expert HTA analyst for Zorginstituut Nederland. "
            "Return ONLY valid JSON as instructed. No markdown, no commentary."
        )
        bedrock_request = {
            "modelId":  BEDROCK_MODEL,
            "system":   [{"text": system_message}],
            "messages": [{"role": "user", "content": [{"text": prompt}]}],
            "inferenceConfig": {"temperature": 0, "maxTokens": 4000},
        }
        resp        = bedrock_client.converse(**bedrock_request)
        raw_content = None
        try:
            raw_content = resp["output"]["message"]["content"][0]["text"]
        except (KeyError, IndexError, TypeError) as parse_err:
            print(f"[generate_single_dossier] Failed to extract text for {dossier_code}: {parse_err}")

        if not raw_content:
            print(f"[generate_single_dossier] LLM returned no content for {dossier_code}")
            return None

        clean = raw_content.strip()
        if clean.startswith("```"):
            clean = clean.split("```", 2)[1]
            if clean.startswith("json"):
                clean = clean[4:]
            clean = clean.rsplit("```", 1)[0].strip()

        return json.loads(clean)

    except json.JSONDecodeError as json_err:
        print(f"[generate_single_dossier] JSON parse failed for {dossier_code}: {json_err}")
        return None
    except Exception as e:
        print(f"[generate_single_dossier] Failed for {dossier_code}: {e}")
        print(traceback.format_exc())
        return None

def run_dossier_generation_parallel(node: Any, user_context: str, dossier_codes: list, max_workers: int = 3) -> list:
    dossiers = []
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        future_to_code = {
            executor.submit(generate_single_dossier, code, node, user_context): code
            for code in dossier_codes
        }
        for future in as_completed(future_to_code):
            code = future_to_code[future]
            try:
                result = future.result()
                if result:
                    dossiers.append(result)
                    print(f"[DossierGen] Completed: {code}")
                else:
                    print(f"[DossierGen] No result returned for: {code}")
            except Exception as e:
                print(f"[DossierGen] Worker failed for {code}: {e}")

    order = {code: i for i, code in enumerate(dossier_codes)}
    dossiers.sort(key=lambda d: order.get(d.get("dossier_code", ""), 99))
    return dossiers


# =============================================================================
# Off-topic guard for search_input
# Prevents the RAG pipeline from running on non-HTA queries, which was causing
# misleading "Cited Sources" to appear for completely unrelated questions.
# =============================================================================

_HTA_KEYWORDS = {
    "hta", "zin", "ruling", "rulings", "reimbursement", "dossier",
    "icer", "qaly", "pharmacoeconomic", "cost-effectiveness",
    "cost effectiveness", "budget impact", "clinical evidence",
    "therapy area", "indication", "comparator", "manufacturer",
    "drug", "medicine", "treatment", "patient", "clinical",
    "oncology", "rare disease", "neurology", "cardiology",
    "immunology", "dermatology", "assessment", "submission",
    "extrapolation", "utility", "subgroup", "indirect comparison",
    "nma", "maic", "survival", "endpoint", "trial", "rct",
    "single arm", "sensitivity analysis", "markov",
    "partitioned survival", "qol", "eq-5d", "willingness to pay",
    "wtp", "threshold", "price", "conditional", "positive",
    "negative", "decision", "advice", "acp", "zorginstituut",
    "nederland", "dutch", "netherlands", "avacopan", "tavneos",
    "avelumab", "bavencio", "osimertinib", "tagrisso",
    "reimbursement condition", "pay for performance",
    "risk sharing", "health technology", "pharmacotherapy",
    "formulary", "package", "gvs", "zvw",
}

_OFF_TOPIC_PATTERNS = [
    r"\b(toaster|fridge|refrigerator|microwave|oven|dishwasher|washing\s*machine|blender|kettle)\b",
    r"\b(recipe|cook|bake|ingredient|meal|food|restaurant|cuisine|chef)\b",
    r"\b(joke|funny|laugh|humor|humour|comedy|meme|prank)\b",
    r"\b(movie|film|song|music|celebrity|actor|actress|singer|band|album)\b",
    r"\b(weather|temperature|forecast|rain|snow|sunny|cloudy|humidity)\b",
    r"\b(love|relationship|dating|marriage|divorce|romance|breakup|crush)\b",
    r"\b(game|gaming|video\s*game|chess|poker|lottery|casino|gamble)\b",
    r"\b(dog|cat|bird|fish|pet|puppy|kitten|hamster|rabbit)\b",
    r"\b(planet|star|galaxy|universe|alien|space\s*travel|astronaut|nasa)\b",
    r"\b(football|soccer|basketball|tennis|cricket|rugby|baseball|golf|sport)\b",
    r"\b(stock|crypto|bitcoin|ethereum|nft|forex|trading|investment)\b(?!.*\b(health|medical|drug|pharma)\b)",
    r"\b(poem|poetry|story|fiction|novel|essay|write\s*me\s*a)\b",
    r"\b(translate|translation)\b(?!.*\b(dutch|netherlands|zin|hta)\b)",
    r"\b(what\s+does\s+.{1,30}\s+sound\s+like|conversation\s+between)\b",
    r"\b(how\s+to\s+make|how\s+to\s+cook|how\s+to\s+bake|how\s+to\s+fix\s+a)\b",
]

_COMPILED_OFF_TOPIC = [re.compile(p, re.IGNORECASE) for p in _OFF_TOPIC_PATTERNS]


def _is_off_topic(query: str) -> bool:
    """
    Returns True only when the query is unambiguously unrelated to HTA/ZIN.
    Deliberately permissive — when in doubt, returns False (let RAG run).

    Stage 1: Any HTA keyword present → on-topic immediately (fast exit).
    Stage 2: Explicit off-topic pattern match → off-topic.
    Stage 3: Default → on-topic (allow through).
    """
    if not query or not query.strip():
        return True

    lower = query.lower()

    # Stage 1 — HTA keyword fast-path: any HTA term → on-topic
    for kw in _HTA_KEYWORDS:
        if kw in lower:
            return False

    # Stage 2 — explicit off-topic patterns
    for pattern_compiled in _COMPILED_OFF_TOPIC:
        if pattern_compiled.search(lower):
            return True

    # Stage 3 — default: allow through
    return False


# Signals that the LLM itself used to indicate it could not answer.
# When detected, sources are suppressed to prevent misleading citations.
#
# These are graded, because the previous flat substring list classified good
# answers as refusals. It contained the bare phrases "the provided context" and
# "not related to", which are ordinary wording in a *successful* answer:
# "Based on the provided context, three rulings were rejected on comparator
# choice" matched, and the answer plus all five citations were thrown away and
# replaced with "I could not find relevant information".

# The sentence the prompt explicitly asks for, plus unambiguous variants. A
# match anywhere in the answer is a refusal.
_REFUSAL_EXACT = (
    "could not find a clear answer",
)

# First-person refusals. Also unambiguous wherever they appear.
_REFUSAL_STRONG = (
    "i don't have enough information",
    "i do not have enough information",
    "i cannot answer",
    "i can't answer",
    "i am unable to answer",
    "i'm unable to answer",
)

# Phrases that signal a refusal only when they appear in the answer's FIRST
# SENTENCE. A good answer may well note a gap after saying something useful —
# "ZIN rejected the comparator. The context does not give the final ICER." —
# and that is still an answer worth keeping. A genuine refusal leads with it.
_REFUSAL_LEADING = (
    "no relevant information",
    "provided context does not",
    "provided context doesn't",
    "provided context contains no",
    "context does not contain",
    "context doesn't contain",
    "context does not include",
    "context doesn't include",
    "does not include any information about",
    "doesn't include any information about",
)

# Cap for an answer that never terminates its first sentence.
_REFUSAL_LEAD_CHARS = 200


def _first_sentence(text: str) -> str:
    match = re.search(r"[.!?](\s|$)", text)
    return text[:match.start() + 1] if match else text[:_REFUSAL_LEAD_CHARS]


def _is_refusal(answer: str) -> tuple:
    """Did the model decline to answer, rather than answer?

    Returns (is_refusal, matched_signal) so the caller can log *why* an answer
    was suppressed — the old code logged only that it had been.
    """
    text = (answer or "").lower().strip()
    if not text:
        return True, "<empty answer>"
    for sig in _REFUSAL_EXACT + _REFUSAL_STRONG:
        if sig in text:
            return True, sig
    lead = _first_sentence(text)
    for sig in _REFUSAL_LEADING:
        if sig in lead:
            return True, f"{sig} (in first sentence)"
    # Deliberately biased towards keeping the answer: wrongly suppressing one
    # destroys a correct result and all its citations, while wrongly keeping a
    # refusal only shows an unhelpful sentence the user can read for themselves.
    return False, ""

_OFF_TOPIC_RESPONSE = {
    "result": (
        "This search tool is designed for ZIN HTA rulings, reimbursement decisions, "
        "pharmacoeconomic assessments, and related healthcare topics. "
        "Your question does not appear to be related to these topics.\n\n"
        "Please ask about HTA submissions, ZIN rulings, clinical evidence, "
        "cost-effectiveness analyses, budget impact, or specific drugs and therapy areas."
    ),
    "sources":            [],
    "matched_ruling_ids": [],
    "matched_rulings":    [],
    "off_topic":          True,
    "no_results":         False,
}


# =============================================================================
# Dossier Review uploads  (Sr 17 / Sr 18)
# =============================================================================
# A user attaches a dossier, or one section of it, to a research question in
# Ruling Search. Navigator extracts its text, suggests a review category from
# the question, and carries both into the Q&A generator.
#
# Storage: DOSSIER_UPLOAD_CONTAINER, deliberately separate from the log
# container so customer documents and diagnostics can carry different retention
# and access policies. Auth is the function app's managed identity, matching
# upload_log_to_blob rather than the SAS pattern used for public ruling PDFs.

DOSSIER_MAX_BYTES      = 20 * 1024 * 1024      # 20 MB, as the design states
DOSSIER_EXTRACT_LIMIT  = 60_000                # chars kept for prompting
DOSSIER_ALLOWED_EXT    = {".pdf", ".docx", ".doc", ".txt", ".md"}


def _dossier_container_client():
    credential = DefaultAzureCredential()
    service    = BlobServiceClient(account_url=BLOB_ACCOUNT_URL, credential=credential)
    return service.get_container_client(DOSSIER_UPLOAD_CONTAINER)


def _extract_pdf_text(data: bytes) -> tuple:
    """Returns (text, page_count). Never raises — unreadable PDFs yield ''."""
    try:
        from pypdf import PdfReader
        reader = PdfReader(io.BytesIO(data))
        pages  = []
        for page in reader.pages:
            try:
                pages.append(page.extract_text() or "")
            except Exception:
                pages.append("")
        return "\n\n".join(pages), len(reader.pages)
    except Exception as e:
        print(f"[dossier] PDF extraction failed: {e}")
        return "", 0


def _extract_docx_text(data: bytes) -> tuple:
    try:
        import docx
        document = docx.Document(io.BytesIO(data))
        parts    = [p.text for p in document.paragraphs if p.text and p.text.strip()]
        for table in document.tables:
            for row in table.rows:
                cells = [c.text.strip() for c in row.cells if c.text and c.text.strip()]
                if cells:
                    parts.append(" | ".join(cells))
        return "\n".join(parts), 0
    except Exception as e:
        print(f"[dossier] DOCX extraction failed: {e}")
        return "", 0


def _extract_dossier_text(filename: str, data: bytes) -> tuple:
    """Dispatch on extension. Returns (text, page_count, note)."""
    ext = os.path.splitext(filename or "")[1].lower()
    if ext == ".pdf":
        text, pages = _extract_pdf_text(data)
        note = "" if text.strip() else "No selectable text found — the PDF may be a scan."
        return text, pages, note
    if ext in (".docx", ".doc"):
        text, _ = _extract_docx_text(data)
        if not text.strip() and ext == ".doc":
            return "", 0, "Legacy .doc could not be read. Save it as .docx and re-upload."
        return text, 0, "" if text.strip() else "No text found in the document."
    if ext in (".txt", ".md"):
        for encoding in ("utf-8", "utf-16", "latin-1"):
            try:
                return data.decode(encoding), 0, ""
            except (UnicodeDecodeError, LookupError):
                continue
        return "", 0, "Could not decode the text file."
    return "", 0, f"Unsupported file type '{ext}'."


def _parse_multipart(req: func.HttpRequest) -> tuple:
    """Returns (filename, data, fields) from a multipart body.

    Azure Functions' Python worker exposes files via `req.files`, but that is
    not populated for every content type, so this falls back to parsing the raw
    body with the stdlib `email` parser.
    """
    fields: Dict[str, str] = dict(req.params or {})

    try:
        files = getattr(req, "files", None)
        if files:
            for key in files:
                item = files[key]
                name = getattr(item, "filename", None)
                if name:
                    try:
                        form = getattr(req, "form", None) or {}
                        fields.update({k: form[k] for k in form})
                    except Exception:
                        pass
                    return name, item.stream.read() if hasattr(item, "stream") else item.read(), fields
    except Exception as e:
        print(f"[dossier] req.files unavailable: {e}")

    content_type = req.headers.get("Content-Type") or req.headers.get("content-type") or ""
    body = req.get_body() or b""
    if "multipart/form-data" not in content_type.lower() or not body:
        return None, b"", fields

    try:
        import email
        from email.policy import default as email_default
        raw = b"Content-Type: " + content_type.encode() + b"\r\nMIME-Version: 1.0\r\n\r\n" + body
        message = email.message_from_bytes(raw, policy=email_default)
        filename, data = None, b""
        for part in message.iter_parts():
            part_name = part.get_param("name", header="content-disposition")
            part_file = part.get_filename()
            if part_file:
                filename = part_file
                data     = part.get_payload(decode=True) or b""
            elif part_name:
                try:
                    fields[part_name] = part.get_payload(decode=True).decode("utf-8", "replace")
                except Exception:
                    pass
        return filename, data, fields
    except Exception as e:
        print(f"[dossier] multipart parse failed: {e}")
        return None, b"", fields


def _load_dossier_review(upload_id: str) -> Optional[Dict[str, Any]]:
    """Reads a stored upload's metadata and extracted text, or None.

    Shared by the fetch route (Sr 18) and by the Q&A / search routes that fold
    the dossier text into their prompts.
    """
    try:
        container = _dossier_container_client()
        blob      = container.get_blob_client(f"dossier-review/{upload_id}/extracted.json")
        if not blob.exists():
            return None
        return json.loads(blob.download_blob().readall().decode("utf-8"))
    except Exception as e:
        print(f"[dossier] load failed for {upload_id}: {e}")
        return None


def dossier_review_context(upload_id: Optional[str], limit: int = 12_000) -> str:
    """Prompt-ready excerpt of an uploaded dossier, or '' when unavailable.

    Returns a plain string so callers can concatenate it without having to
    handle a missing or unreadable upload.
    """
    if not upload_id:
        return ""
    meta = _load_dossier_review(upload_id)
    if not meta:
        return ""
    text = (meta.get("text") or "").strip()
    if not text:
        return ""
    return text[:limit]


# ── Shared embedding helper (Sr 16 / Sr 24) ──────────────────────────────────
# `search_input` defined its own `embed_texts` closure; similar-rulings needs the
# same call, so it lives here rather than being written twice.

def embed_text(text: str) -> Optional[List[float]]:
    if not az_openai_client or not text or not text.strip():
        return None
    try:
        resp = az_openai_client.embeddings.create(input=text, model=EMBED_MODEL)
        return resp.data[0].embedding
    except Exception as e:
        # The type matters: a RecursionError or TypeError is a local fault, an
        # APIConnectionError really is the gateway. str(e) alone hid that.
        print(f"[embed] failed: {type(e).__name__}: {e}")
        print(traceback.format_exc())
        return None


def _similarity_from_score(score: Optional[float]) -> int:
    """Azure Search @search.score for a vector query → a 0-100 percentage.

    The service returns a cosine-derived score in (0, 1] where 1 is identical.
    We present it as a percentage because the design shows "94% similar"; the
    mapping is monotonic, so ordering is faithful even though the absolute
    number is only indicative.
    """
    try:
        return max(0, min(100, round(float(score) * 100)))
    except (TypeError, ValueError):
        return 0


def find_similar_rulings(ruling: Dict[str, Any], top_n: int = 3) -> List[Dict[str, Any]]:
    """Rulings most like this one, by vector similarity over the search index.

    Precedent matching is the reason people open a ruling at all. Falls back to
    a therapy-area/outcome heuristic when the vector path is unavailable, so the
    panel degrades rather than disappearing.
    """
    corpus  = read_neo4j()
    self_id = ruling.get("id")
    seed    = " ".join(filter(None, [
        ruling.get("title"), ruling.get("indication"),
        ruling.get("comparator"), (ruling.get("summary") or "")[:1200],
    ])).strip()

    vector = embed_text(seed) if (seed and search_endpoint and search_key) else None

    if vector:
        try:
            client = SearchClient(
                endpoint=search_endpoint, index_name=index_name,
                credential=AzureKeyCredential(search_key),
            )
            vq = VectorizedQuery(
                vector=vector, k_nearest_neighbors=max(12, top_n * 5),
                fields="contentVector", kind="vector",
            )
            hits = list(client.search(search_text=None, vector_queries=[vq],
                                      select=["content", "source"]))

            # Index chunks are keyed by source file, so map each hit back onto a
            # ruling before deduplicating — several chunks share one ruling.
            by_title = {
                (r.get("title") or "").lower().strip(): r
                for r in corpus if r.get("title")
            }
            out, seen = [], {self_id}
            for h in hits:
                source = (h.get("source") or "").lower()
                source = re.sub(r"\.[^.]+$", "", source)
                source = re.sub(r"[_\-\s]+", " ", source).strip()
                match = None
                for title, r in by_title.items():
                    if not title:
                        continue
                    if title in source or source in title:
                        match = r
                        break
                    drug = (r.get("drug_name") or "").lower().strip()
                    if drug and len(drug) > 3 and drug in source:
                        match = r
                        break
                if not match or match.get("id") in seen:
                    continue
                seen.add(match.get("id"))
                out.append({
                    "id":             match.get("id"),
                    "title":          match.get("title"),
                    "outcome":        match.get("decision_outcome"),
                    "therapy_area":   match.get("therapy_area"),
                    "decision_date":  match.get("decision_date"),
                    "similarity_pct": _similarity_from_score(h.get("@search.score")),
                    "basis":          "vector",
                })
                if len(out) >= top_n:
                    break
            if out:
                return out
        except Exception as e:
            print(f"[similar] vector search failed, falling back: {e}")

    # ── Heuristic fallback ───────────────────────────────────────────────────
    # Same therapy area scores highest, then shared outcome, then recency.
    # `basis` is returned so the UI can avoid showing a precise-looking
    # percentage for what is really a rule of thumb.
    area    = (ruling.get("therapy_area") or "").lower()
    outcome = (ruling.get("decision_outcome") or "").lower()
    scored  = []
    for r in corpus:
        if r.get("id") == self_id:
            continue
        score = 0
        if area and (r.get("therapy_area") or "").lower() == area:
            score += 60
        if outcome and (r.get("decision_outcome") or "").lower() == outcome:
            score += 25
        if (r.get("indication") or "").lower() == (ruling.get("indication") or "").lower() and r.get("indication"):
            score += 15
        if score:
            scored.append((score, r))
    scored.sort(key=lambda t: (t[0], t[1].get("decision_date") or ""), reverse=True)
    return [{
        "id":             r.get("id"),
        "title":          r.get("title"),
        "outcome":        r.get("decision_outcome"),
        "therapy_area":   r.get("therapy_area"),
        "decision_date":  r.get("decision_date"),
        "similarity_pct": score,
        "basis":          "heuristic",
    } for score, r in scored[:top_n]]


def _infer_dossier_category(question: str) -> str:
    """Suggests a review category from the research question.

    Mirrors inferDossierCategory in frontend/src/lib/dossierCategories.js: a
    question matching more than one component is genuinely cross-dossier, which
    is what that fourth category exists for.
    """
    q = (question or "").strip()
    if not q:
        return CROSS_DOSSIER_REVIEW
    hits = []
    if re.search(r"budget|uptake|penetration|population size|financial impact|volume|eligible patients", q, re.I):
        hits.append("Budget Impact")
    if re.search(r"icer|cost.?effect|cost per|economic|qaly|utilit|threshold|incremental cost|price arrangement", q, re.I):
        hits.append("Pharmaco-economic")
    if re.search(r"comparator|clinical|therapeutic|endpoint|pico|efficac|safety|subgroup|trial|evidence|guideline", q, re.I):
        hits.append("Clinical Value Pharmaco therapeutic")
    return hits[0] if len(hits) == 1 else CROSS_DOSSIER_REVIEW


# =============================================================================
# Azure Function Routes
# =============================================================================

# -----------------------------------------------------------------------------
# GET /api/rulings
# -----------------------------------------------------------------------------
@app.function_name(name="get_rulings")
@app.route(route="rulings", methods=["GET", "OPTIONS"], auth_level=func.AuthLevel.ANONYMOUS)
def get_rulings(req: HttpRequest) -> HttpResponse:
    log_content = []
    try:
        log_content.append(f"[{ts()}] INFO  [get_rulings] Function invoked | method={req.method}")
        if req.method == "OPTIONS":
            upload_log_to_blob(log_content, "get_rulings")
            return HttpResponse("", status_code=204, headers=_cors_preflight_headers(req))

        therapy_area:     Optional[str] = req.params.get("therapy_area")
        decision_type:    Optional[str] = req.params.get("decision_type")
        decision_outcome: Optional[str] = req.params.get("decision_outcome")
        dossier_category: Optional[str] = req.params.get("dossier_category")
        search:           Optional[str] = req.params.get("search")
        year:             Optional[str] = req.params.get("year")

        # ── Sr 30 — paging, projection and server-side date range ─────────
        # The endpoint returned all ~490 rulings on every call and the frontend
        # filtered years in the browser. These are additive and all optional, so
        # existing callers that pass nothing keep the previous behaviour.
        date_from: Optional[str] = req.params.get("decision_date_from")
        date_to:   Optional[str] = req.params.get("decision_date_to")

        def _int_param(name: str, default: Optional[int]) -> Optional[int]:
            raw = req.params.get(name)
            if raw is None or raw == "":
                return default
            try:
                return max(0, int(raw))
            except ValueError:
                return default

        limit  = _int_param("limit",  None)
        offset = _int_param("offset", 0) or 0

        # `fields=all` opts into the heavy payload (full_text and the long
        # narrative fields); the default is the list projection.
        fields_param = (req.params.get("fields") or "").strip().lower()
        if fields_param in ("", "list", "default"):
            projection = RULING_LIST_FIELDS
        elif fields_param == "all":
            projection = RULING_FIELDS
        else:
            requested  = [f.strip() for f in fields_param.split(",") if f.strip()]
            projection = [f for f in requested if f in RULING_FIELDS] or RULING_LIST_FIELDS
            if "id" not in projection:
                projection = ["id"] + projection

        rulings = read_neo4j()
        log_content.append(f"[{ts()}] INFO  [get_rulings] Neo4j returned {len(rulings)} rulings")

        if therapy_area:
            rulings = [r for r in rulings if (r.get("therapy_area") or "").lower() == therapy_area.lower()]
        if decision_type:
            rulings = [r for r in rulings if (r.get("decision_type") or "").lower() == decision_type.lower()]
        if decision_outcome:
            rulings = [r for r in rulings if (r.get("decision_outcome") or "").lower() == decision_outcome.lower()]
        if dossier_category:
            dc = dossier_category.lower()
            rulings = [r for r in rulings
                       if any(c.lower() == dc for c in _ruling_categories(r))]
        if search:
            sl = search.lower()
            rulings = [
                r for r in rulings
                if sl in (r.get("title") or "").lower()
                or sl in (r.get("drug_name") or "").lower()
                or sl in (r.get("manufacturer") or "").lower()
                or sl in (r.get("summary") or "").lower()
            ]
        if year:
            rulings = [r for r in rulings if str(year) in (r.get("decision_date") or "")]

        # Lexicographic comparison is correct for ISO-8601 dates, and the
        # bounds are inclusive. Rulings with no usable date are excluded when a
        # range is requested rather than silently kept.
        if date_from:
            rulings = [r for r in rulings
                       if (r.get("decision_date") or "")[:10] >= date_from[:10]]
        if date_to:
            rulings = [r for r in rulings
                       if (r.get("decision_date") or "") and (r.get("decision_date") or "")[:10] <= date_to[:10]]

        matched = len(rulings)
        if offset:
            rulings = rulings[offset:]
        if limit is not None:
            rulings = rulings[:limit]

        log_content.append(
            f"[{ts()}] INFO  [get_rulings] matched={matched} returned={len(rulings)} "
            f"offset={offset} limit={limit} fields={len(projection)}"
        )

        payload = [{k: r.get(k) for k in projection} for r in rulings]

        log_content.append(f"[{ts()}] INFO  [get_rulings] Returning {len(payload)} rulings")
        upload_log_to_blob(log_content, "get_rulings")

        # The response body stays a bare JSON array so every existing caller
        # (Dashboard, Search, Q&A, Insights all do `res.data || []`) keeps
        # working unchanged. Paging metadata rides in headers instead of
        # wrapping the array in an envelope.
        headers = dict(_cors_headers(req))
        headers.update({
            "X-Total-Matched":  str(matched),
            "X-Result-Offset":  str(offset),
            "X-Result-Count":   str(len(payload)),
            "Access-Control-Expose-Headers":
                "X-Total-Matched, X-Result-Offset, X-Result-Count",
        })
        return HttpResponse(
            json.dumps(payload, ensure_ascii=False),
            status_code=200, mimetype="application/json", headers=headers,
        )
    except Exception as e:
        log_content.append(f"[{ts()}] ERROR [get_rulings] {e}\n{traceback.format_exc()}")
        upload_log_to_blob(log_content, "get_rulings")
        return HttpResponse(
            json.dumps({"error": "Internal Server Error"}),
            status_code=500, mimetype="application/json", headers=_cors_headers(req),
        )


# -----------------------------------------------------------------------------
# GET /api/insights
# -----------------------------------------------------------------------------
@app.function_name(name="get_insights")
@app.route(route="insights", methods=["GET", "OPTIONS"], auth_level=func.AuthLevel.ANONYMOUS)
def get_insights(req: HttpRequest) -> HttpResponse:
    log_content = []
    try:
        log_content.append(f"[{ts()}] INFO  [get_insights] Function invoked | method={req.method}")
        if req.method == "OPTIONS":
            upload_log_to_blob(log_content, "get_insights")
            return HttpResponse("", status_code=204, headers=_cors_preflight_headers(req))

        rulings = read_neo4j()
        log_content.append(f"[{ts()}] INFO  [get_insights] Neo4j returned {len(rulings)} rulings")

        total        = len(rulings)
        positive     = len([r for r in rulings if r.get("decision_outcome") == "Positive"])
        negative     = len([r for r in rulings if r.get("decision_outcome") == "Negative"])
        conditional  = len([r for r in rulings if "Conditions" in (r.get("decision_outcome") or "")])
        under_review = sum(1 for r in rulings if (r.get("decision_outcome") or "").strip() == "Under Review")

        therapy_breakdown: Dict[str, int] = {}
        for r in rulings:
            area = r.get("therapy_area", "Unknown")
            therapy_breakdown[area] = therapy_breakdown.get(area, 0) + 1

        monthly_map: Dict[str, Dict[str, Any]] = {}
        for r in rulings:
            raw_date = r.get("decision_date") or ""
            if not raw_date or len(raw_date) < 7:
                continue
            try:
                dt = datetime.strptime(raw_date[:7], "%Y-%m")
            except ValueError:
                continue
            month_key = dt.strftime("%b %Y")
            if month_key not in monthly_map:
                monthly_map[month_key] = {"positive": 0, "negative": 0, "conditional": 0, "_sort": dt}
            outcome = (r.get("decision_outcome") or "").strip()
            if outcome == "Positive":
                monthly_map[month_key]["positive"] += 1
            elif outcome == "Negative":
                monthly_map[month_key]["negative"] += 1
            elif "Conditions" in outcome:
                monthly_map[month_key]["conditional"] += 1

        monthly_trends = [
            {"month": k, "positive": v["positive"], "negative": v["negative"], "conditional": v["conditional"]}
            for k, v in sorted(monthly_map.items(), key=lambda kv: kv[1]["_sort"])
        ]

        mfr_count: Dict[str, int] = {}
        for r in rulings:
            mfr = r.get("manufacturer", "Unknown")
            mfr_count[mfr] = mfr_count.get(mfr, 0) + 1

        # `manufacturer` is not written by the current ingestion — the property
        # key does not exist in the database — so every ruling falls back to
        # "Unknown" and the list becomes a single meaningless row. Filter it so
        # callers get an empty list they can render as "not available", rather
        # than a confident-looking "Unknown: 800".
        #
        # The computation is kept rather than deleted: if the pipeline starts
        # populating manufacturer, this starts working again with no change.
        all_manufacturers = [
            {"name": k, "count": v}
            for k, v in sorted(mfr_count.items(), key=lambda x: x[1], reverse=True)
            if k and k != "Unknown"
        ]
        top_manufacturers = all_manufacturers[:5]

        # ── RTM 5.6 — manufacturer performance ────────────────────────────
        # "Which manufacturer has the most successful submissions in a given
        # year, and how that changes over time."
        #
        # Success = positive or positive-with-conditions, over published
        # decisions. A conditional approval IS a successful submission — the
        # product is reimbursed — so counting only unconditional positives
        # would understate every manufacturer in a corpus where conditions are
        # the norm.
        #
        # MIN_SUBMISSIONS guards the headline: without it a manufacturer with a
        # single positive ruling shows 100% and tops the table ahead of one with
        # 40 submissions at 70%. The threshold is returned so the UI can state it.
        MIN_SUBMISSIONS_FOR_RANK = 3

        mfr_stats: Dict[str, Dict[str, Any]] = {}
        for r in rulings:
            name = (r.get("manufacturer") or "").strip()
            if not name or name.lower() == "unknown":
                continue
            outcome = (r.get("decision_outcome") or "").strip()
            if outcome == "Under Review":
                continue  # not yet a result, so not a success or a failure
            year = (r.get("decision_date") or "")[:4]
            year = year if re.fullmatch(r"\d{4}", year or "") else None

            m = mfr_stats.setdefault(name, {
                "name": name, "published": 0, "positive": 0,
                "conditional": 0, "negative": 0, "by_year": {},
            })
            m["published"] += 1
            if outcome == "Positive":        m["positive"]    += 1
            elif "Conditions" in outcome:    m["conditional"] += 1
            elif outcome == "Negative":      m["negative"]    += 1

            if year:
                y = m["by_year"].setdefault(year, {"published": 0, "successful": 0})
                y["published"] += 1
                if outcome == "Positive" or "Conditions" in outcome:
                    y["successful"] += 1

        def _rate(successful: int, published: int) -> Optional[float]:
            return round((successful / published) * 100, 1) if published else None

        manufacturer_rows = []
        for m in mfr_stats.values():
            successful = m["positive"] + m["conditional"]
            manufacturer_rows.append({
                "name":         m["name"],
                "published":    m["published"],
                "successful":   successful,
                "positive":     m["positive"],
                "conditional":  m["conditional"],
                "negative":     m["negative"],
                "success_rate": _rate(successful, m["published"]),
                "by_year": {
                    yr: {**v, "success_rate": _rate(v["successful"], v["published"])}
                    for yr, v in sorted(m["by_year"].items())
                },
            })
        manufacturer_rows.sort(
            key=lambda x: (x["success_rate"] or 0, x["published"]), reverse=True
        )

        # Who led each year, among manufacturers meeting the threshold.
        leader_by_year: Dict[str, Any] = {}
        years_seen = sorted({yr for m in mfr_stats.values() for yr in m["by_year"]})
        for yr in years_seen:
            eligible = [
                {
                    "name": m["name"],
                    "published": m["by_year"][yr]["published"],
                    "successful": m["by_year"][yr]["successful"],
                    "success_rate": _rate(m["by_year"][yr]["successful"],
                                          m["by_year"][yr]["published"]),
                }
                for m in mfr_stats.values()
                if yr in m["by_year"]
                and m["by_year"][yr]["published"] >= MIN_SUBMISSIONS_FOR_RANK
            ]
            if eligible:
                eligible.sort(key=lambda x: (x["success_rate"], x["published"]), reverse=True)
                leader_by_year[yr] = eligible[0]

        manufacturer_performance = {
            # Explicit, so the UI shows an honest unavailable state instead of
            # an empty card that looks broken.
            "available": bool(manufacturer_rows),
            "reason": "" if manufacturer_rows else (
                "The ingestion does not currently populate a manufacturer for any "
                "ruling, so submission performance cannot be attributed."
            ),
            "min_submissions_for_rank": MIN_SUBMISSIONS_FOR_RANK,
            "manufacturers":  manufacturer_rows[:15],
            "leader_by_year": leader_by_year,
            "years":          years_seen,
        }

        # ── Sr 7 — `avg_review_time_days` removed ─────────────────────────
        # It averaged the gap between consecutive decision dates across the
        # whole corpus, which measures how often ZIN publishes, not how long an
        # assessment takes. Over ~490 rulings in six years that lands near a
        # handful of days and reads as obviously broken, which cost the rest of
        # the screen its credibility.
        #
        # A real submission-to-decision duration cannot be derived from the data
        # we hold: SummaryDocuments carries `decision_date` and no submission or
        # acceptance date. Rather than ship a corrected-looking version of a
        # number we cannot compute, the metric is gone. `assessment_time` states
        # that explicitly so the UI can render an honest empty state instead of
        # a zero. Populate `submission_date` during ingestion to restore it.
        assessment_time = {
            "available": False,
            "reason": (
                "Not derivable: the corpus records decision dates only, with no "
                "submission or acceptance date to measure from."
            ),
            "median_months": None,
        }

        # ── Sr 11 — stated denominator ────────────────────────────────────
        # Outcome shares are taken over *published* decisions, excluding rulings
        # still under review. Previously Dashboard divided by the full total and
        # Insights did not, so the two screens disagreed. One field, named, used
        # by both.
        published = total - under_review
        def share(n: int) -> float:
            return round((n / published) * 100, 1) if published else 0.0

        # ── Sr 8 — conditional rate per therapy area ──────────────────────
        # The rate, not the volume: "conditional approval is the default in every
        # area except cardiology and dermatology" is the claim a market-access
        # lead acts on, and a count list cannot support it.
        area_stats: Dict[str, Dict[str, int]] = {}
        for r in rulings:
            area    = r.get("therapy_area") or "Unknown"
            outcome = (r.get("decision_outcome") or "").strip()
            bucket  = area_stats.setdefault(area, {"total": 0, "published": 0, "conditional": 0,
                                                   "negative": 0, "positive": 0})
            bucket["total"] += 1
            if outcome == "Under Review":
                continue
            bucket["published"] += 1
            if "Conditions" in outcome:
                bucket["conditional"] += 1
            elif outcome == "Negative":
                bucket["negative"] += 1
            elif outcome == "Positive":
                bucket["positive"] += 1

        conditional_rate_by_area = {
            area: {
                **counts,
                "rate": round((counts["conditional"] / counts["published"]) * 100, 1)
                        if counts["published"] else 0.0,
            }
            for area, counts in sorted(
                area_stats.items(),
                key=lambda kv: (kv[1]["conditional"] / kv[1]["published"]) if kv[1]["published"] else 0,
                reverse=True,
            )
        }

        # ── Sr 9 — quarterly trends ───────────────────────────────────────
        # Monthly buckets over a corpus this size are mostly noise; the design
        # charts conditional share by quarter. `monthly_trends` is kept so
        # nothing already consuming it breaks.
        quarter_map: Dict[str, Dict[str, Any]] = {}
        for r in rulings:
            raw_date = r.get("decision_date") or ""
            if len(raw_date) < 7:
                continue
            try:
                dt = datetime.strptime(raw_date[:7], "%Y-%m")
            except ValueError:
                continue
            q_key = f"Q{((dt.month - 1) // 3) + 1} {dt.strftime('%y')}"
            q     = quarter_map.setdefault(q_key, {
                "quarter": q_key, "total": 0, "published": 0,
                "conditional": 0, "negative": 0, "positive": 0,
                "_sort": (dt.year, (dt.month - 1) // 3),
            })
            outcome = (r.get("decision_outcome") or "").strip()
            q["total"] += 1
            if outcome == "Under Review":
                continue
            q["published"] += 1
            if "Conditions" in outcome:
                q["conditional"] += 1
            elif outcome == "Negative":
                q["negative"] += 1
            elif outcome == "Positive":
                q["positive"] += 1

        quarterly_trends = []
        for q in sorted(quarter_map.values(), key=lambda v: v["_sort"]):
            pub = q["published"]
            quarterly_trends.append({
                "quarter":           q["quarter"],
                "total":             q["total"],
                "published":         pub,
                "conditional":       q["conditional"],
                "negative":          q["negative"],
                "positive":          q["positive"],
                "conditional_share": round((q["conditional"] / pub) * 100, 1) if pub else 0.0,
                "negative_share":    round((q["negative"]    / pub) * 100, 1) if pub else 0.0,
            })

        # ── Sr 10 — prior-period comparison ───────────────────────────────
        # Replaces the hardcoded "▲ 4.1 pts vs 2025" strings in the frontend.
        # Compares the most recent N months against the N before them, so the
        # deltas move with the data.
        def _window(months: int, offset: int = 0):
            dated = []
            for r in rulings:
                raw = r.get("decision_date") or ""
                if len(raw) < 7:
                    continue
                try:
                    dated.append((datetime.strptime(raw[:7], "%Y-%m"), r))
                except ValueError:
                    continue
            if not dated:
                return []
            newest = max(d for d, _ in dated)
            end    = newest.year * 12 + newest.month - (offset * months)
            start  = end - months
            return [r for d, r in dated if start < (d.year * 12 + d.month) <= end]

        def _shares(subset):
            pub = [r for r in subset
                   if (r.get("decision_outcome") or "").strip() != "Under Review"]
            n = len(pub)
            if not n:
                return {"total": len(subset), "published": 0,
                        "positive_pct": None, "conditional_pct": None, "negative_pct": None}
            cnt = lambda f: sum(1 for r in pub if f((r.get("decision_outcome") or "").strip()))
            return {
                "total":           len(subset),
                "published":       n,
                "positive_pct":    round(cnt(lambda o: o == "Positive")      / n * 100, 1),
                "conditional_pct": round(cnt(lambda o: "Conditions" in o)    / n * 100, 1),
                "negative_pct":    round(cnt(lambda o: o == "Negative")      / n * 100, 1),
            }

        COMPARE_MONTHS = 12
        current_w  = _shares(_window(COMPARE_MONTHS, 0))
        previous_w = _shares(_window(COMPARE_MONTHS, 1))

        def _delta(key):
            a, b = current_w.get(key), previous_w.get(key)
            return round(a - b, 1) if (a is not None and b is not None) else None

        comparison = {
            "window_months": COMPARE_MONTHS,
            "current":       current_w,
            "previous":      previous_w,
            "delta": {
                "positive_pct":    _delta("positive_pct"),
                "conditional_pct": _delta("conditional_pct"),
                "negative_pct":    _delta("negative_pct"),
                "total":           current_w["total"] - previous_w["total"],
            },
        }

        # ── Sr 12 — corpus currency ───────────────────────────────────────
        # The top bar claimed "Rulings current to <today>", which asserts
        # freshness the app never checked. This is the latest decision date we
        # actually hold.
        valid_dates = sorted(
            d for d in (r.get("decision_date") or "" for r in rulings) if len(d) >= 7
        )
        corpus_current_to   = valid_dates[-1] if valid_dates else None
        corpus_earliest     = valid_dates[0]  if valid_dates else None

        # Rulings added in the trailing 30 days of the corpus, for the Total tile.
        added_recent = 0
        if corpus_current_to and len(corpus_current_to) >= 7:
            try:
                newest = datetime.strptime(corpus_current_to[:7], "%Y-%m")
                cutoff = newest.year * 12 + newest.month - 1
                added_recent = sum(
                    1 for r in rulings
                    if len((r.get("decision_date") or "")) >= 7
                    and (lambda d: d.year * 12 + d.month > cutoff)(
                        datetime.strptime(r["decision_date"][:7], "%Y-%m")
                    )
                )
            except ValueError:
                added_recent = 0

        payload = {
            "total_rulings":          total,
            "positive_decisions":     positive,
            "negative_decisions":     negative,
            "under_review_decisions": under_review,
            "conditional_decisions":  conditional,

            # Sr 11 — one denominator, shared by Dashboard and Insights.
            "denominator_published":  published,
            "shares_pct": {
                "positive":    share(positive),
                "conditional": share(conditional),
                "negative":    share(negative),
            },

            "therapy_area_breakdown":   therapy_breakdown,   # kept: volume per area
            "conditional_rate_by_area": conditional_rate_by_area,  # Sr 8

            "monthly_trends":    monthly_trends,
            "quarterly_trends":  quarterly_trends,           # Sr 9
            "comparison":        comparison,                 # Sr 10

            "assessment_time":   assessment_time,            # Sr 7
            "corpus_current_to": corpus_current_to,          # Sr 12
            "corpus_earliest":   corpus_earliest,
            "added_recent":      added_recent,

            "top_manufacturers": top_manufacturers,
            "all_manufacturers": all_manufacturers,
            "manufacturer_performance": manufacturer_performance,   # RTM 5.6
        }

        log_content.append(
            f"[{ts()}] INFO  [get_insights] total={total} published={published} "
            f"quarters={len(quarterly_trends)} areas={len(conditional_rate_by_area)} "
            f"current_to={corpus_current_to}"
        )
        upload_log_to_blob(log_content, "get_insights")
        return HttpResponse(
            json.dumps(payload, ensure_ascii=False),
            status_code=200, mimetype="application/json", headers=_cors_headers(req),
        )
    except Exception as e:
        log_content.append(f"[{ts()}] ERROR [get_insights] {e}\n{traceback.format_exc()}")
        upload_log_to_blob(log_content, "get_insights")
        return HttpResponse(
            json.dumps({"error": "Internal Server Error"}),
            status_code=500, mimetype="application/json", headers=_cors_headers(req),
        )


# -----------------------------------------------------------------------------
# GET /api/therapy-areas
# -----------------------------------------------------------------------------
@app.function_name(name="get_therapy_areas")
@app.route(route="therapy-areas", methods=["GET", "OPTIONS"], auth_level=func.AuthLevel.ANONYMOUS)
def get_therapy_areas(req: HttpRequest) -> HttpResponse:
    try:
        if req.method == "OPTIONS":
            return HttpResponse("", status_code=204, headers=_cors_preflight_headers(req))
        return func.HttpResponse(
            json.dumps(THERAPY_AREAS, ensure_ascii=False),
            status_code=200, mimetype="application/json", headers=_cors_headers(req),
        )
    except Exception as e:
        return func.HttpResponse(
            json.dumps({"error": "Internal Server Error"}),
            status_code=500, mimetype="application/json", headers=_cors_headers(req),
        )


# -----------------------------------------------------------------------------
# GET /api/decision-outcomes
# -----------------------------------------------------------------------------
@app.function_name(name="get_decision_outcomes")
@app.route(route="decision-outcomes", methods=["GET", "OPTIONS"], auth_level=func.AuthLevel.ANONYMOUS)
def get_decision_outcomes(req: HttpRequest) -> HttpResponse:
    try:
        if req.method == "OPTIONS":
            return HttpResponse("", status_code=204, headers=_cors_preflight_headers(req))
        return func.HttpResponse(
            json.dumps(DECISION_OUTCOMES, ensure_ascii=False),
            status_code=200, mimetype="application/json", headers=_cors_headers(req),
        )
    except Exception as e:
        return func.HttpResponse(
            json.dumps({"error": "Internal Server Error"}),
            status_code=500, mimetype="application/json", headers=_cors_headers(req),
        )


# -----------------------------------------------------------------------------
# GET /api/dossier-categories
# -----------------------------------------------------------------------------
@app.function_name(name="get_dossier_categories")
@app.route(route="dossier-categories", methods=["GET", "OPTIONS"], auth_level=func.AuthLevel.ANONYMOUS)
def get_dossier_categories(req: HttpRequest) -> HttpResponse:
    """Sr 13 — categories as objects, with the review mode flagged.

    The endpoint used to return four bare strings whose wording does not match
    the design ("Pharmaco-economic" vs "Pharmacoeconomic Dossier"). Rather than
    rename the Neo4j values — which are node properties, mirrored in
    DossierCategoryEnum and string-matched inside generate_qa — each entry now
    carries both forms.

    `shape=legacy` returns the original flat array for any caller not yet
    updated.
    """
    try:
        if req.method == "OPTIONS":
            return HttpResponse("", status_code=204, headers=_cors_preflight_headers(req))

        if (req.params.get("shape") or "").lower() == "legacy":
            return func.HttpResponse(
                json.dumps(DOSSIER_CATEGORY, ensure_ascii=False),
                status_code=200, mimetype="application/json", headers=_cors_headers(req),
            )

        return func.HttpResponse(
            json.dumps(DOSSIER_CATEGORY_OPTIONS, ensure_ascii=False),
            status_code=200, mimetype="application/json", headers=_cors_headers(req),
        )
    except Exception as e:
        return func.HttpResponse(
            json.dumps({"error": "Internal Server Error"}),
            status_code=500, mimetype="application/json", headers=_cors_headers(req),
        )


# -----------------------------------------------------------------------------
# POST /api/dossier-review/upload   (Sr 17)
# -----------------------------------------------------------------------------
@app.function_name(name="upload_dossier_review")
@app.route(route="dossier-review/upload", methods=["POST", "OPTIONS"],
           auth_level=func.AuthLevel.ANONYMOUS)
def upload_dossier_review(req: func.HttpRequest) -> func.HttpResponse:
    log_content = []
    try:
        log_content.append(f"[{ts()}] INFO  [dossier_upload] invoked | method={req.method}")
        if req.method == "OPTIONS":
            return func.HttpResponse("", status_code=204, headers=_cors_preflight_headers(req))

        missing = require_settings("BLOB_ACCOUNT_URL")
        if missing:
            upload_log_to_blob(log_content, "dossier_upload")
            return func.HttpResponse(
                json.dumps({"detail": missing}),
                status_code=503, mimetype="application/json", headers=_cors_headers(req),
            )

        filename, data, fields = _parse_multipart(req)
        question = (fields.get("question") or "").strip()

        if not filename or not data:
            return func.HttpResponse(
                json.dumps({"detail": "No file was received. Send it as multipart/form-data."}),
                status_code=400, mimetype="application/json", headers=_cors_headers(req),
            )

        ext = os.path.splitext(filename)[1].lower()
        if ext not in DOSSIER_ALLOWED_EXT:
            return func.HttpResponse(
                json.dumps({"detail": f"Use a PDF, Word or plain-text file. '{ext}' is not supported."}),
                status_code=415, mimetype="application/json", headers=_cors_headers(req),
            )

        if len(data) > DOSSIER_MAX_BYTES:
            return func.HttpResponse(
                json.dumps({"detail": "The dossier file must be 20 MB or smaller.",
                            "size_bytes": len(data), "max_bytes": DOSSIER_MAX_BYTES}),
                status_code=413, mimetype="application/json", headers=_cors_headers(req),
            )

        upload_id = uuid.uuid4().hex
        text, page_count, note = _extract_dossier_text(filename, data)
        truncated = len(text) > DOSSIER_EXTRACT_LIMIT
        text      = text[:DOSSIER_EXTRACT_LIMIT]

        suggested = _infer_dossier_category(question)

        # Original and extracted text are stored under one prefix per upload, so
        # a retention rule can target the whole lot by path.
        try:
            container = _dossier_container_client()
            prefix    = f"dossier-review/{upload_id}"
            safe_name = re.sub(r"[^A-Za-z0-9._-]", "_", filename)[:120]
            container.get_blob_client(f"{prefix}/original/{safe_name}").upload_blob(
                io.BytesIO(data), overwrite=True,
                content_settings=ContentSettings(content_type="application/octet-stream"),
            )
            meta = {
                "upload_id": upload_id, "filename": filename,
                "size_bytes": len(data), "page_count": page_count,
                "question": question, "suggested_category": suggested,
                "extracted_chars": len(text), "truncated": truncated,
                "uploaded_at": datetime.now(timezone.utc).isoformat(),
                "text": text,
            }
            container.get_blob_client(f"{prefix}/extracted.json").upload_blob(
                io.BytesIO(json.dumps(meta, ensure_ascii=False).encode("utf-8")),
                overwrite=True,
                content_settings=ContentSettings(content_type="application/json; charset=utf-8"),
            )
        except Exception as blob_err:
            log_content.append(f"[{ts()}] ERROR [dossier_upload] blob write failed: {blob_err}")
            upload_log_to_blob(log_content, "dossier_upload")
            return func.HttpResponse(
                json.dumps({"detail": "Could not store the uploaded file.",
                            "container": DOSSIER_UPLOAD_CONTAINER}),
                status_code=502, mimetype="application/json", headers=_cors_headers(req),
            )

        log_content.append(
            f"[{ts()}] INFO  [dossier_upload] stored id={upload_id} file={filename} "
            f"bytes={len(data)} pages={page_count} chars={len(text)} cat={suggested}"
        )
        upload_log_to_blob(log_content, "dossier_upload")

        return func.HttpResponse(
            json.dumps({
                "upload_id":          upload_id,
                "filename":           filename,
                "size_bytes":         len(data),
                "size_kb":            max(1, round(len(data) / 1024)),
                "page_count":         page_count,
                "extracted_chars":    len(text),
                "truncated":          truncated,
                "suggested_category": suggested,
                # Surfaced so the UI can say "stored, but no text could be read"
                # instead of implying the dossier will inform generation.
                "note":               note,
                "text_available":     bool(text.strip()),
            }, ensure_ascii=False),
            status_code=200, mimetype="application/json", headers=_cors_headers(req),
        )

    except Exception as e:
        log_content.append(f"[{ts()}] ERROR [dossier_upload] {e}\n{traceback.format_exc()}")
        upload_log_to_blob(log_content, "dossier_upload")
        return func.HttpResponse(
            json.dumps({"error": "Internal Server Error", "detail": str(e)}),
            status_code=500, mimetype="application/json", headers=_cors_headers(req),
        )


# -----------------------------------------------------------------------------
# GET /api/dossier-review/{upload_id}   (Sr 18)
# -----------------------------------------------------------------------------
@app.function_name(name="get_dossier_review")
@app.route(route="dossier-review/{upload_id}", methods=["GET", "OPTIONS"],
           auth_level=func.AuthLevel.ANONYMOUS)
def get_dossier_review(req: func.HttpRequest) -> func.HttpResponse:
    try:
        if req.method == "OPTIONS":
            return func.HttpResponse("", status_code=204, headers=_cors_preflight_headers(req))

        upload_id = (req.route_params.get("upload_id") or "").strip()
        if not re.fullmatch(r"[0-9a-f]{32}", upload_id):
            return func.HttpResponse(
                json.dumps({"detail": "Invalid upload_id"}),
                status_code=400, mimetype="application/json", headers=_cors_headers(req),
            )

        meta = _load_dossier_review(upload_id)
        if meta is None:
            return func.HttpResponse(
                json.dumps({"detail": "Upload not found"}),
                status_code=404, mimetype="application/json", headers=_cors_headers(req),
            )

        # The extracted text can be large; callers ask for it explicitly.
        if (req.params.get("include_text") or "").lower() not in ("1", "true", "yes"):
            meta = {k: v for k, v in meta.items() if k != "text"}

        return func.HttpResponse(
            json.dumps(meta, ensure_ascii=False),
            status_code=200, mimetype="application/json", headers=_cors_headers(req),
        )
    except Exception as e:
        print(f"[dossier] fetch failed: {e}")
        return func.HttpResponse(
            json.dumps({"error": "Internal Server Error", "detail": str(e)}),
            status_code=500, mimetype="application/json", headers=_cors_headers(req),
        )


# -----------------------------------------------------------------------------
# GET /api/rulings/{ruling_id}
# -----------------------------------------------------------------------------
@app.function_name(name="get_ruling")
@app.route(route="rulings/{ruling_id}", methods=["GET", "OPTIONS"], auth_level=func.AuthLevel.ANONYMOUS)
def get_ruling(req: func.HttpRequest) -> func.HttpResponse:
    log_content = []
    try:
        log_content.append(f"[{ts()}] INFO  [get_ruling] Function invoked | method={req.method}")
        if req.method == "OPTIONS":
            upload_log_to_blob(log_content, "get_ruling")
            return func.HttpResponse("", status_code=204, headers=_cors_preflight_headers(req))

        ruling_id: Optional[str] = req.route_params.get("ruling_id")
        if not ruling_id:
            upload_log_to_blob(log_content, "get_ruling")
            return func.HttpResponse(
                json.dumps({"detail": "ruling_id is required"}),
                status_code=400, mimetype="application/json", headers=_cors_headers(req),
            )

        # Sr 14 — matched on the id in Cypher. This used to read all 487 nodes,
        # including every full_text, and linear-scan them to return one.
        ruling = read_neo4j_one(ruling_id)
        if not ruling:
            log_content.append(f"[{ts()}] INFO  [get_ruling] No node for id={ruling_id}")
            upload_log_to_blob(log_content, "get_ruling")
            return func.HttpResponse(
                json.dumps({"detail": "Ruling not found"}),
                status_code=404, mimetype="application/json", headers=_cors_headers(req),
            )

        rulings_filename = read_neo4j_filename(ruling_id)
        log_content.append(f"rulings_filename: {rulings_filename}")

        def generate_blob_sas_url(blob_name: str) -> str:
            try:
                parsed         = urlparse(CONTAINER_SAS_URL)
                account_url    = f"{parsed.scheme}://{parsed.netloc}"
                container_name = parsed.path.lstrip("/").split("/")[0]
                sas_token      = parsed.query
                return f"{account_url}/{container_name}/{blob_name}?{sas_token}"
            except Exception as e:
                log_content.append(f"[{ts()}] WARN  [get_ruling] SAS URL failed: {e}")
                return None

        ruling["file_url"] = generate_blob_sas_url(rulings_filename) if rulings_filename else None

        # Sr 15 — fields the redesigned detail page needs. `conditions` is a
        # distinct concept from `key_considerations`: the operative conditions
        # attached to a conditional approval, not the committee's remarks.
        ruling["conditions"] = _derive_conditions(ruling)

        pages = _source_pages(ruling_id)
        ruling["dutch_text"]   = pages["nl"]
        ruling["english_text"] = pages["en"]
        ruling["page_count"]   = ruling.get("page_count") or pages["page_count"]
        ruling["verified_at"]  = ruling.get("verified_at") or ruling.get("decision_date")

        log_content.append(
            f"[{ts()}] INFO  [get_ruling] Returning id={ruling_id} | "
            f"conditions={len(ruling['conditions'])} | dutch={bool(ruling['dutch_text'])}"
        )
        upload_log_to_blob(log_content, "get_ruling")
        return func.HttpResponse(
            json.dumps(ruling, ensure_ascii=False),
            status_code=200, mimetype="application/json", headers=_cors_headers(req),
        )
    except Exception as e:
        log_content.append(f"[{ts()}] ERROR [get_ruling] {e}\n{traceback.format_exc()}")
        upload_log_to_blob(log_content, "get_ruling")
        return func.HttpResponse(
            json.dumps({"error": "Internal Server Error"}),
            status_code=500, mimetype="application/json", headers=_cors_headers(req),
        )


# -----------------------------------------------------------------------------
# GET /api/search/facets   (Sr 28)
# -----------------------------------------------------------------------------
@app.function_name(name="get_search_facets")
@app.route(route="search/facets", methods=["GET", "OPTIONS"],
           auth_level=func.AuthLevel.ANONYMOUS)
def get_search_facets(req: HttpRequest) -> HttpResponse:
    """Facet counts for a query-scoped corpus.

    Search computes these in the browser today, which works only because the
    whole corpus is shipped to it. This is the server-side equivalent, and the
    prerequisite for moving Ruling Search to real pagination (Sr 30) without
    losing the counts that stop people clicking into an empty result set.

    Counts are independent per facet group — the standard approach — so each
    group shows what you would get by selecting that value alone, with the other
    groups' selections still applied.
    """
    try:
        if req.method == "OPTIONS":
            return HttpResponse("", status_code=204, headers=_cors_preflight_headers(req))

        q          = (req.params.get("q") or "").strip().lower()
        sel_areas  = [a for a in (req.params.get("therapy_areas") or "").split(",") if a]
        sel_out    = [o for o in (req.params.get("outcomes") or "").split(",") if o]
        sel_doss   = [d for d in (req.params.get("dossier_categories") or "").split(",") if d]
        sel_doss   = [d for d in sel_doss if d != CROSS_DOSSIER_REVIEW]
        year_from  = (req.params.get("year_from") or "").strip()
        year_to    = (req.params.get("year_to") or "").strip()

        rulings = read_neo4j()

        def match_q(r) -> bool:
            if not q:
                return True
            return any(q in (r.get(f) or "").lower()
                       for f in ("title", "drug_name", "manufacturer", "summary"))

        def match_year(r) -> bool:
            y = (r.get("decision_date") or "")[:4]
            if year_from and (not y or y < year_from): return False
            if year_to   and (not y or y > year_to):   return False
            return True

        base = [r for r in rulings if match_q(r) and match_year(r)]

        def tally(field: str, skip_selection: List[str]) -> Dict[str, int]:
            out: Dict[str, int] = {}
            for r in base:
                if sel_areas and field != "therapy_area" and (r.get("therapy_area") or "") not in sel_areas:
                    continue
                if sel_out and field != "decision_outcome" and (r.get("decision_outcome") or "") not in sel_out:
                    continue
                if sel_doss and field != "dossier_category" and not any(c in sel_doss for c in _ruling_categories(r)):
                    continue
                # A ruling counts once under EACH dossier type it covers, so
                # these counts can add up to more than `matched`.
                values = _ruling_categories(r) if field == "dossier_category" else [r.get(field)]
                for v in values:
                    if v:
                        out[v] = out.get(v, 0) + 1
            return out

        years: Dict[str, int] = {}
        for r in base:
            y = (r.get("decision_date") or "")[:4]
            key = y if re.fullmatch(r"\d{4}", y or "") else "Unknown"
            years[key] = years.get(key, 0) + 1

        return HttpResponse(
            json.dumps({
                "matched":          len(base),
                "therapy_area":     tally("therapy_area", sel_areas),
                "decision_outcome": tally("decision_outcome", sel_out),
                "dossier_category": tally("dossier_category", sel_doss),
                "year":             dict(sorted(years.items(), reverse=True)),
            }, ensure_ascii=False),
            status_code=200, mimetype="application/json", headers=_cors_headers(req),
        )
    except Exception as e:
        print(f"[facets] {e}")
        return HttpResponse(
            json.dumps({"error": "Internal Server Error", "detail": str(e)}),
            status_code=500, mimetype="application/json", headers=_cors_headers(req),
        )


# -----------------------------------------------------------------------------
# POST /api/feedback/qa   (Sr 29)
# -----------------------------------------------------------------------------
@app.function_name(name="qa_feedback")
@app.route(route="feedback/qa", methods=["POST", "OPTIONS"],
           auth_level=func.AuthLevel.ANONYMOUS)
def qa_feedback(req: func.HttpRequest) -> func.HttpResponse:
    """Records feedback on a generated question or answer.

    QAGenerator.jsx has posted here since the feature was written, but the route
    did not exist — every call 404'd and was swallowed by a bare `catch`, so the
    "Report an error" affordance captured nothing.

    Each submission is written as its own blob under `qa-feedback/<date>/`, which
    is append-only, needs no schema, and gives the evaluation set a natural
    partition to read by date.
    """
    try:
        if req.method == "OPTIONS":
            return func.HttpResponse("", status_code=204, headers=_cors_preflight_headers(req))

        try:
            body = req.get_json()
        except ValueError:
            return func.HttpResponse(
                json.dumps({"detail": "Invalid JSON body"}),
                status_code=400, mimetype="application/json", headers=_cors_headers(req),
            )

        feedback_type = (body.get("feedbackType") or body.get("feedback_type") or "").strip()
        if feedback_type not in ("positive", "negative"):
            return func.HttpResponse(
                json.dumps({"detail": "feedbackType must be 'positive' or 'negative'"}),
                status_code=400, mimetype="application/json", headers=_cors_headers(req),
            )

        record = {
            "id":            uuid.uuid4().hex,
            "received_at":   datetime.now(timezone.utc).isoformat(),
            "feedback_type": feedback_type,
            "question":      body.get("question"),
            "answer":        body.get("answer"),
            "ruling_ids":    body.get("rulingIds") or body.get("ruling_ids") or [],
            "dossier_code":  body.get("dossierCode") or body.get("dossier_code"),
            "theme":         body.get("theme"),
            "importance":    body.get("importance"),
            "mode":          body.get("mode"),
            "issues":        body.get("issues") or [],
            "comment":       body.get("comment"),
            "client_ts":     body.get("timestamp"),
        }

        day  = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        name = f"qa-feedback/{day}/{record['id']}.json"
        try:
            container = _dossier_container_client()
            container.get_blob_client(name).upload_blob(
                io.BytesIO(json.dumps(record, ensure_ascii=False).encode("utf-8")),
                overwrite=True,
                content_settings=ContentSettings(content_type="application/json; charset=utf-8"),
            )
        except Exception as blob_err:
            # Feedback must never block the user, so a storage failure is logged
            # and reported honestly rather than raised at them.
            print(f"[qa_feedback] store failed: {blob_err}")
            return func.HttpResponse(
                json.dumps({"stored": False, "detail": "Feedback could not be stored."}),
                status_code=202, mimetype="application/json", headers=_cors_headers(req),
            )

        return func.HttpResponse(
            json.dumps({"stored": True, "id": record["id"]}),
            status_code=201, mimetype="application/json", headers=_cors_headers(req),
        )
    except Exception as e:
        print(f"[qa_feedback] {e}")
        return func.HttpResponse(
            json.dumps({"error": "Internal Server Error", "detail": str(e)}),
            status_code=500, mimetype="application/json", headers=_cors_headers(req),
        )


# -----------------------------------------------------------------------------
# GET /api/rulings/{ruling_id}/similar   (Sr 16 / Sr 59 / Sr 61)
# -----------------------------------------------------------------------------
@app.function_name(name="get_similar_rulings")
@app.route(route="rulings/{ruling_id}/similar", methods=["GET", "OPTIONS"],
           auth_level=func.AuthLevel.ANONYMOUS)
def get_similar_rulings(req: func.HttpRequest) -> func.HttpResponse:
    log_content = []
    try:
        if req.method == "OPTIONS":
            return func.HttpResponse("", status_code=204, headers=_cors_preflight_headers(req))

        ruling_id = (req.route_params.get("ruling_id") or "").strip()
        if not ruling_id:
            return func.HttpResponse(
                json.dumps({"detail": "ruling_id is required"}),
                status_code=400, mimetype="application/json", headers=_cors_headers(req),
            )

        ruling = read_neo4j_one(ruling_id)
        if not ruling:
            return func.HttpResponse(
                json.dumps({"detail": "Ruling not found"}),
                status_code=404, mimetype="application/json", headers=_cors_headers(req),
            )

        try:
            top_n = max(1, min(10, int(req.params.get("top_n", 3))))
        except ValueError:
            top_n = 3

        similar = find_similar_rulings(ruling, top_n=top_n)

        # Sr 61 — precedent watch. Strictly "later rulings in the same therapy
        # area and indication", which is what the data supports. We deliberately
        # do NOT claim conditions were relaxed: detecting that reliably would
        # need a structured comparison of condition text we do not have.
        this_date = (ruling.get("decision_date") or "")[:10]
        later = [
            s for s in similar
            if (s.get("decision_date") or "")[:10] > this_date and this_date
        ]

        payload = {
            "ruling_id":      ruling_id,
            "similar":        similar,
            "precedent_watch": {
                "has_later": bool(later),
                "count":     len(later),
                "rulings":   later,
                "note": (
                    f"{len(later)} later ruling{'s' if len(later) != 1 else ''} in this area "
                    f"may bear on how this one is read. Check {'them' if len(later) != 1 else 'it'} "
                    f"before citing this advice."
                ) if later else "",
            },
            "basis": similar[0]["basis"] if similar else None,
        }

        log_content.append(
            f"[{ts()}] INFO  [similar] id={ruling_id} n={len(similar)} "
            f"basis={payload['basis']} later={len(later)}"
        )
        upload_log_to_blob(log_content, "get_similar_rulings")
        return func.HttpResponse(
            json.dumps(payload, ensure_ascii=False),
            status_code=200, mimetype="application/json", headers=_cors_headers(req),
        )
    except Exception as e:
        log_content.append(f"[{ts()}] ERROR [similar] {e}\n{traceback.format_exc()}")
        upload_log_to_blob(log_content, "get_similar_rulings")
        return func.HttpResponse(
            json.dumps({"error": "Internal Server Error", "detail": str(e)}),
            status_code=500, mimetype="application/json", headers=_cors_headers(req),
        )


# -----------------------------------------------------------------------------
# POST /api/rulings/{ruling_id}/summarize
# -----------------------------------------------------------------------------
@app.function_name(name="summarize_ruling")
@app.route(
    route="rulings/{ruling_id}/summarize",
    methods=["POST", "OPTIONS"],
    auth_level=func.AuthLevel.ANONYMOUS,
)
async def summarize_ruling(req: func.HttpRequest) -> func.HttpResponse:
    log_content = []
    try:
        log_content.append(f"[{ts()}] INFO  [summarize_ruling] Function invoked | method={req.method}")
        if req.method == "OPTIONS":
            upload_log_to_blob(log_content, "summarize_ruling")
            return func.HttpResponse("", status_code=204, headers=_cors_preflight_headers(req))

        ruling_id: Optional[str] = req.route_params.get("ruling_id")
        if not ruling_id:
            upload_log_to_blob(log_content, "summarize_ruling")
            return func.HttpResponse(
                json.dumps({"detail": "ruling_id is required"}),
                status_code=400, mimetype="application/json", headers=_cors_headers(req),
            )

        rulings = read_neo4j()
        ruling  = next((r for r in rulings if r.get("id") == ruling_id), None)
        if not ruling:
            upload_log_to_blob(log_content, "summarize_ruling")
            return func.HttpResponse(
                json.dumps({"detail": "Ruling not found"}),
                status_code=404, mimetype="application/json", headers=_cors_headers(req),
            )

        ai_result = await get_ai_summary(ruling)
        payload   = {
            "ruling_id":    ruling_id,
            "ai_summary":   ai_result.get("ai_summary"),
            "key_points":   ai_result.get("key_points"),
            "generated_at": datetime.now(timezone.utc).isoformat(),
        }

        upload_log_to_blob(log_content, "summarize_ruling")
        return func.HttpResponse(
            json.dumps(payload, ensure_ascii=False),
            status_code=200, mimetype="application/json", headers=_cors_headers(req),
        )
    except Exception as e:
        log_content.append(f"[{ts()}] ERROR [summarize_ruling] {e}\n{traceback.format_exc()}")
        upload_log_to_blob(log_content, "summarize_ruling")
        return func.HttpResponse(
            json.dumps({"error": "Internal Server Error"}),
            status_code=500, mimetype="application/json", headers=_cors_headers(req),
        )

# -----------------------------------------------------------------------------added on 0408
# POST /api/qa/search-generate  — with hallucination guard
# FIXES APPLIED:
#   1. Off-topic query detection gate before LLM call
#   2. Relevance pre-screening of rulings using keyword overlap scoring
#   3. Prompt updated to allow model to signal irrelevance and return empty
#   4. Minimum relevance threshold — returns empty if no rulings score above it
#   5. maxTokens kept at 8000
# -----------------------------------------------------------------------------

# ── HTA domain keywords for relevance pre-screening ──────────────────────────
HTA_DOMAIN_KEYWORDS = {
    # Clinical / efficacy
    "efficacy", "effectiveness", "clinical", "trial", "evidence", "endpoint",
    "survival", "outcome", "benefit", "harm", "safety", "adverse", "event",
    "randomised", "randomized", "placebo", "comparator", "subgroup", "analysis",
    "extrapolation", "utility", "qaly", "quality", "life", "hrqol", "patient",
    "population", "indication", "disease", "treatment", "therapy", "drug",
    "medicine", "medicinal", "product", "dose", "dosage", "regimen",
    # Pharmacoeconomic
    "cost", "icer", "threshold", "pharmacoeconomic", "economic", "model",
    "cost-effectiveness", "budget", "impact", "reimbursement", "pricing",
    "price", "reduction", "negotiation", "manufacturer", "submission",
    "dossier", "bia", "cea", "sensitivity", "uncertainty", "scenario",
    # ZIN / HTA process
    "zin", "hta", "ruling", "assessment", "appraisal", "committee", "advice",
    "recommendation", "conditional", "positive", "negative", "decision",
    "zorginstituut", "nederland", "dutch", "netherlands", "package",
    "formulary", "gvs", "zvw", "sluis", "horizon", "scanning",
    # Methodological
    "indirect", "comparison", "network", "meta", "analysis", "nma", "maic",
    "ste", "matching", "adjusted", "indirect", "single", "arm", "real",
    "world", "evidence", "rwe", "registry", "observational",
}

MIN_KEYWORD_OVERLAP_SCORE = 1   # at least 1 HTA keyword must appear in query
MIN_RELEVANT_RULINGS      = 1   # at least 1 ruling must score above threshold
RULING_RELEVANCE_THRESHOLD = 0.05  # fraction of query tokens that overlap with ruling text


def _query_is_hta_relevant(query: str) -> bool:
    """
    Returns True if the query contains at least one HTA domain keyword.
    This is a fast, zero-cost gate before any LLM call.
    """
    tokens = set(re.sub(r"[^a-z0-9\s]", "", query.lower()).split())
    overlap = tokens & HTA_DOMAIN_KEYWORDS
    return len(overlap) >= MIN_KEYWORD_OVERLAP_SCORE


def _score_ruling_relevance(query_tokens: set, ruling: dict) -> float:
    """
    Returns a simple keyword overlap score between the query and a ruling.
    Score = number of query tokens found in the ruling text / len(query_tokens).
    """
    if not query_tokens:
        return 0.0
    ruling_text = " ".join([
        (ruling.get("title")        or ""),
        (ruling.get("summary")      or ""),
        (ruling.get("indication")   or ""),
        (ruling.get("therapy_area") or ""),
        (ruling.get("full_text")    or "")[:500],
    ]).lower()
    ruling_tokens = set(re.sub(r"[^a-z0-9\s]", "", ruling_text).split())
    overlap = query_tokens & ruling_tokens
    return len(overlap) / len(query_tokens)


def _filter_relevant_rulings(query: str, rulings: list, top_n: int = 40) -> list:
    """
    Scores each ruling against the query and returns the top_n most relevant.
    Rulings scoring below RULING_RELEVANCE_THRESHOLD are excluded entirely.
    """
    query_tokens = set(re.sub(r"[^a-z0-9\s]", "", query.lower()).split())
    # Remove very common stop words that would inflate scores
    stop_words = {
        "what", "when", "how", "does", "the", "a", "an", "is", "are", "was",
        "were", "has", "have", "had", "will", "would", "could", "should",
        "this", "that", "these", "those", "and", "or", "but", "in", "on",
        "at", "to", "for", "of", "with", "by", "from", "about", "which",
        "who", "why", "can", "do", "be", "it", "its", "not", "no", "if",
    }
    query_tokens -= stop_words

    scored = []
    for ruling in rulings:
        score = _score_ruling_relevance(query_tokens, ruling)
        if score >= RULING_RELEVANCE_THRESHOLD:
            scored.append((score, ruling))

    scored.sort(key=lambda x: x[0], reverse=True)
    return [r for _, r in scored[:top_n]]


@app.function_name(name="search_generate_qa")
@app.route(
    route="qa/search-generate",
    methods=["POST", "OPTIONS"],
    auth_level=func.AuthLevel.ANONYMOUS,
)
def search_generate_qa(req: func.HttpRequest) -> func.HttpResponse:
    log_content = []
    try:
        start_time = time.time()
        log_content.append(f"[{ts()}] INFO  [search_generate_qa] Function invoked | method={req.method}")

        if req.method == "OPTIONS":
            upload_log_to_blob(log_content, "search_generate_qa")
            return func.HttpResponse("", status_code=204, headers=_cors_preflight_headers(req))

        try:
            body = req.get_json()
        except ValueError:
            upload_log_to_blob(log_content, "search_generate_qa")
            return func.HttpResponse(
                json.dumps({"detail": "Invalid JSON body"}),
                status_code=400, mimetype="application/json", headers=_cors_headers(req),
            )

        query        = (body.get("query")        or "").strip()
        user_context = (body.get("context")      or "").strip()
        dossier_type = (body.get("dossier_type") or "").strip().upper()
        indication   = (body.get("indication")   or "").strip().lower()

        # Sr 23 — scope generation to the rulings the user actually ticked in
        # Ruling Search, instead of re-deriving a set from the query alone.
        selected_ruling_ids = [r for r in (body.get("ruling_ids") or []) if r]

        # Sr 21 — the dossier attached to this research question.
        dossier_upload_id = (body.get("dossier_review_upload_id") or "").strip() or None
        dossier_excerpt   = dossier_review_context(dossier_upload_id, limit=6000)

        log_content.append(
            f"[{ts()}] INFO  [search_generate_qa] query='{query}' | "
            f"dossier_type='{dossier_type}' | indication='{indication}' | "
            f"context_len={len(user_context)}"
        )

        if not query:
            upload_log_to_blob(log_content, "search_generate_qa")
            return func.HttpResponse(
                json.dumps({"detail": "query must not be empty"}),
                status_code=400, mimetype="application/json", headers=_cors_headers(req),
            )

        # ── FIX 1: Off-topic query gate ───────────────────────────────────
        # Reject queries that contain zero HTA domain keywords before any
        # expensive Neo4j or LLM call is made.
        # ── Sr 32 — advisory, not a gate ──────────────────────────────────
        # This used to reject outright any query containing no word from
        # HTA_DOMAIN_KEYWORDS, which contradicts the v2.4 promise of "one
        # unrestricted free-text ruling search". A keyword list cannot decide
        # what is a legitimate research question: "Novartis precedents since
        # 2024" or "what did the committee say about Entresto" contain no listed
        # keyword and are perfectly good queries.
        #
        # The query now runs regardless. `scope_advisory` is returned so the UI
        # can note that the question looks outside ZIN's subject matter, and the
        # evidence-based gate below — whether any ruling actually scores above
        # the relevance threshold — remains the thing that can return empty.
        scope_advisory = None
        if not _query_is_hta_relevant(query):
            scope_advisory = (
                "This question does not use HTA terminology, so the results may be thin. "
                "Terms such as comparator, cost-effectiveness, budget impact or therapeutic "
                "value usually retrieve more."
            )
            log_content.append(
                f"[{ts()}] INFO  [search_generate_qa] No HTA keyword in query — proceeding with advisory: '{query}'"
            )

        # ── Fetch all rulings from Neo4j ──────────────────────────────────
        neo4j_start = time.time()
        rulings     = read_neo4j()
        log_content.append(
            f"[{ts()}] INFO  [search_generate_qa] Neo4j returned {len(rulings)} rulings "
            f"| duration={time.time()-neo4j_start:.2f}s"
        )

        rulings_total = len(rulings)

        # ── Optional filter: dossier_type ─────────────────────────────────
        if dossier_type:
            rulings = [
                r for r in rulings
                if dossier_type in (r.get("dossier_category") or "").upper()
                or dossier_type in (r.get("decision_type")    or "").upper()
            ]
            log_content.append(
                f"[{ts()}] INFO  [search_generate_qa] After dossier_type filter: {len(rulings)} rulings"
            )

        # ── Optional filter: indication / therapy area ────────────────────
        if indication:
            rulings = [
                r for r in rulings
                if indication in (r.get("therapy_area") or "").lower()
                or indication in (r.get("indication")   or "").lower()
                or indication in (r.get("title")        or "").lower()
            ]
            log_content.append(
                f"[{ts()}] INFO  [search_generate_qa] After indication filter: {len(rulings)} rulings"
            )

        rulings_searched = len(rulings)

        if rulings_searched == 0:
            upload_log_to_blob(log_content, "search_generate_qa")
            return func.HttpResponse(
                json.dumps({
                    "questions": [],
                    "meta": {
                        "rulings_searched": 0,
                        "rulings_matched":  0,
                        "rulings_total":    rulings_total,
                    },
                }),
                status_code=200, mimetype="application/json", headers=_cors_headers(req),
            )

        # ── FIX 2: Relevance-scored ruling selection ───────────────────────
        # Replace the naive first-40 slice with scored, threshold-filtered
        # selection so only genuinely relevant rulings reach the LLM.
        if selected_ruling_ids:
            chosen = [r for r in rulings if r.get("id") in set(selected_ruling_ids)]
            if chosen:
                rulings = chosen
                rulings_searched = len(rulings)
                log_content.append(
                    f"[{ts()}] INFO  [search_generate_qa] Scoped to {len(chosen)} user-selected ruling(s)"
                )

        # A set the user picked deliberately is not re-filtered for relevance —
        # they have already decided these are the precedents that matter.
        relevant_rulings = (rulings if selected_ruling_ids and rulings
                            else _filter_relevant_rulings(query, rulings, top_n=40))

        log_content.append(
            f"[{ts()}] INFO  [search_generate_qa] Relevance filter: "
            f"{len(relevant_rulings)} / {rulings_searched} rulings passed threshold"
        )

        # ── FIX 3: Minimum relevant rulings gate ──────────────────────────
        # If no rulings pass the relevance threshold, return empty rather
        # than sending irrelevant content to the LLM.
        if len(relevant_rulings) < MIN_RELEVANT_RULINGS:
            log_content.append(
                f"[{ts()}] WARN  [search_generate_qa] No rulings passed relevance threshold for query: '{query}'"
            )
            upload_log_to_blob(log_content, "search_generate_qa")
            return func.HttpResponse(
                json.dumps({
                    "questions": [],
                    "meta": {
                        "rulings_searched": rulings_searched,
                        "rulings_matched":  0,
                        "rulings_total":    rulings_total,
                        "off_topic":        False,
                        "scope_advisory":   scope_advisory,
                        "message":          (
                            "No rulings in the corpus matched this question closely enough to "
                            "generate from. Try rephrasing, or using terms such as ICER, "
                            "cost-effectiveness, clinical evidence or budget impact."
                        ),
                    },
                }),
                status_code=200, mimetype="application/json", headers=_cors_headers(req),
            )

        # ── Build ruling context from relevant rulings only ───────────────
        MAX_CHARS_PER_RULING = 300
        ruling_excerpts = "\n\n---\n\n".join([
            f"Ruling: {r.get('title', 'N/A')}\n"
            f"Therapy Area: {r.get('therapy_area', 'N/A')}\n"
            f"Decision Outcome: {r.get('decision_outcome', 'N/A')}\n"
            f"Dossier Category: {r.get('dossier_category', 'N/A')}\n"
            f"Summary: {(r.get('summary') or '')[:MAX_CHARS_PER_RULING]}"
            for r in relevant_rulings
        ])

        log_content.append(
            f"[{ts()}] INFO  [search_generate_qa] Built ruling context | "
            f"rulings_in_context={len(relevant_rulings)}"
        )

        # ── FIX 4: Updated prompt with explicit off-topic exit path ───────
        context_block = f"\nAdditional context from user: {user_context}" if user_context else ""
        # Sr 21 — the user's own dossier informs what they are asking about, but
        # is explicitly not evidence: it must never be cited as precedent.
        if dossier_excerpt:
            context_block += (
                "\n\n--- USER'S OWN DOSSIER (context only, NOT evidence, never cite it) ---\n"
                f"{dossier_excerpt}\n--- END USER DOSSIER ---"
            )
        filter_block  = ""
        if dossier_type:
            filter_block += f"\nFiltered to dossier type: {dossier_type}"
        if indication:
            filter_block += f"\nFiltered to indication/therapy area: {indication}"

        prompt = f"""You are a senior HTA reviewer specialising in Zorginstituut Nederland (ZIN) assessments.

A dossier team has asked the following question about ZIN ruling precedents:
"{query}"{context_block}{filter_block}

Below are summaries from {len(relevant_rulings)} ZIN rulings that were identified as relevant
to the query (out of {rulings_searched} rulings searched, {rulings_total} total in database).

IMPORTANT — RELEVANCE CHECK:
Before generating any output, assess whether the query is genuinely asking about
HTA methodology, ZIN assessment criteria, clinical evidence, cost-effectiveness,
budget impact, reimbursement, or related topics.

If the query is NOT related to HTA or ZIN ruling topics (e.g. it asks about
software behaviour, UI interactions, general knowledge, or anything unrelated
to pharmaceutical HTA), you MUST return:
{{"questions": [], "meta": {{"off_topic": true, "message": "Query is not related to HTA or ZIN ruling topics."}}}}

Only proceed to generate questions if the query is genuinely HTA-relevant.

RULING DATABASE EXCERPTS:
{ruling_excerpts}

If the query IS HTA-relevant, generate 6-8 evidence-based insights as predicted
questions ZIN assessors are likely to raise. For each insight provide:
- A specific, actionable question ZIN is likely to ask
- Importance level based on how frequently and critically it appears across rulings
- A suggested response strategy grounded in the ruling evidence
- A practical recommendation for what the dossier team should prepare
- An estimated frequency (how many of the {len(relevant_rulings)} rulings raise this concern)
- source_rulings: list ALL ruling titles where this concern appears

STRICT OUTPUT RULES:
- Generate EXACTLY 6-8 questions OR return the off_topic response above
- Base ALL content strictly on the provided ruling summaries — do NOT hallucinate
- Importance must be exactly one of: high, medium, low
- suggested_response must be 2-3 sentences maximum
- recommendation must be 1-2 sentences maximum
- Return ONLY valid JSON — no markdown fences, no commentary outside the JSON

Return ONLY this JSON object:
{{
  "questions": [
    {{
      "question": "<Specific question ZIN assessors are likely to ask>",
      "importance": "high" | "medium" | "low",
      "theme": "therapeutic value" | "study design" | "comparator" | "budget impact" | "conditions" | "cross-dossier",
      "dossier_category": "Clinical Value Pharmaco therapeutic" | "Pharmaco-economic" | "Budget Impact",
      "suggested_response": "<2-3 sentence response strategy grounded in ruling evidence>",
      "recommendation": "<1-2 sentence recommendation for dossier preparation>",
      "frequency": <integer — number of rulings where this concern appears>,
      "seen_in_count": <integer — how many of the rulings above raise this concern>,
      "source_rulings": [
        {{"title": "<ruling title>", "section": "<section reference such as 3.2 if stated, else null>", "year": "<YYYY if known, else null>"}}
      ]
    }}
  ]
}}

THEME must be exactly one of the six listed values — it is used to group the
output, so an unlisted value breaks the grouping.
DOSSIER_CATEGORY must be one of the three listed values, chosen by which
dossier component the question belongs to.
SEEN_IN_COUNT must never exceed the number of rulings supplied above."""

        log_content.append(f"[{ts()}] INFO  [search_generate_qa] Calling Claude Sonnet 4 via Bedrock")
        llm_start = time.time()

        system_message = (
            "You are an expert HTA analyst for Zorginstituut Nederland. "
            "You only answer questions related to HTA methodology, ZIN assessments, "
            "clinical evidence evaluation, cost-effectiveness, budget impact, and "
            "reimbursement decisions. "
            "If a query is unrelated to these topics, return the off_topic JSON response. "
            "Return ONLY valid JSON as instructed. No markdown, no commentary."
        )

        bedrock_request = {
            "modelId":  BEDROCK_MODEL,
            "system":   [{"text": system_message}],
            "messages": [{"role": "user", "content": [{"text": prompt}]}],
            "inferenceConfig": {"temperature": 0.2, "maxTokens": 8000},
        }

        try:
            resp = bedrock_client.converse(**bedrock_request)
        except Exception as bedrock_err:
            log_content.append(f"[{ts()}] ERROR [search_generate_qa] Bedrock call failed: {bedrock_err}")
            upload_log_to_blob(log_content, "search_generate_qa")
            return func.HttpResponse(
                json.dumps({"detail": f"LLM call failed: {str(bedrock_err)}"}),
                status_code=500, mimetype="application/json", headers=_cors_headers(req),
            )

        log_content.append(
            f"[{ts()}] INFO  [search_generate_qa] Bedrock completed | "
            f"duration={time.time()-llm_start:.2f}s"
        )

        raw_content = None
        try:
            raw_content = resp["output"]["message"]["content"][0]["text"]
        except (KeyError, IndexError, TypeError) as parse_err:
            log_content.append(f"[{ts()}] ERROR [search_generate_qa] Failed to extract text: {parse_err}")
            upload_log_to_blob(log_content, "search_generate_qa")
            return func.HttpResponse(
                json.dumps({"detail": "Failed to parse LLM response"}),
                status_code=500, mimetype="application/json", headers=_cors_headers(req),
            )

        if not raw_content:
            log_content.append(f"[{ts()}] ERROR [search_generate_qa] LLM returned empty content")
            upload_log_to_blob(log_content, "search_generate_qa")
            return func.HttpResponse(
                json.dumps({"detail": "LLM returned no content"}),
                status_code=500, mimetype="application/json", headers=_cors_headers(req),
            )

        # ── Strip markdown fences ─────────────────────────────────────────
        clean = raw_content.strip()
        if clean.startswith("```"):
            clean = clean.split("```", 2)[1]
            if clean.startswith("json"):
                clean = clean[4:]
            clean = clean.rsplit("```", 1)[0].strip()

        # ── Parse JSON ────────────────────────────────────────────────────
        try:
            parsed    = json.loads(clean)
            questions = parsed if isinstance(parsed, list) else parsed.get("questions", [])
        except json.JSONDecodeError as json_err:
            log_content.append(
                f"[{ts()}] ERROR [search_generate_qa] JSON parse failed: {json_err} | "
                f"raw={raw_content[:500]}"
            )
            upload_log_to_blob(log_content, "search_generate_qa")
            return func.HttpResponse(
                json.dumps({"detail": f"LLM returned invalid JSON: {str(json_err)}"}),
                status_code=500, mimetype="application/json", headers=_cors_headers(req),
            )

        # ── FIX 5: Handle off_topic signal returned by the LLM ────────────
        # The LLM may return the off_topic structure even if the keyword gate
        # passed — this handles borderline cases the keyword gate missed.
        if isinstance(parsed, dict) and parsed.get("meta", {}).get("off_topic"):
            log_content.append(
                f"[{ts()}] WARN  [search_generate_qa] LLM signalled off_topic for query: '{query}'"
            )
            upload_log_to_blob(log_content, "search_generate_qa")
            return func.HttpResponse(
                json.dumps({
                    "questions": [],
                    "meta": {
                        "rulings_searched": rulings_searched,
                        "rulings_matched":  0,
                        "rulings_total":    rulings_total,
                        "off_topic":        True,
                        "message":          parsed.get("meta", {}).get(
                            "message",
                            "Query is not related to HTA or ZIN ruling topics."
                        ),
                    },
                }),
                status_code=200, mimetype="application/json", headers=_cors_headers(req),
            )

        # ── Count real distinct cited ruling titles ────────────────────────
        all_cited_titles = {
            src.get("title", "").strip()
            for q   in questions
            for src in (q.get("source_rulings") or [])
            if src.get("title", "").strip()
        }
        rulings_matched = len(all_cited_titles)

        log_content.append(
            f"[{ts()}] INFO  [search_generate_qa] Complete | "
            f"questions={len(questions)} | "
            f"rulings_matched={rulings_matched} | "
            f"total_time={time.time()-start_time:.2f}s"
        )
        log_content.append(f"Questions: {json.dumps(questions, ensure_ascii=False)}")
        upload_log_to_blob(log_content, "search_generate_qa")

        return func.HttpResponse(
            json.dumps({
                "questions": questions,
                "meta": {
                    "rulings_searched": rulings_searched,
                    "rulings_matched":  rulings_matched,
                    "rulings_total":    rulings_total,
                    "scope_advisory":   scope_advisory,   # Sr 32
                },
            }, ensure_ascii=False),
            status_code=200, mimetype="application/json", headers=_cors_headers(req),
        )

    except Exception as e:
        log_content.append(f"[{ts()}] ERROR [search_generate_qa] {e}\n{traceback.format_exc()}")
        upload_log_to_blob(log_content, "search_generate_qa")
        return func.HttpResponse(
            json.dumps({"error": "Internal Server Error", "detail": str(e)}),
            status_code=500, mimetype="application/json", headers=_cors_headers(req),
        )

# -----------------------------------------------------------------------------
# POST /api/qa/generate
# -----------------------------------------------------------------------------
@app.function_name(name="generate_qa")
@app.route(
    route="qa/generate",
    methods=["POST", "OPTIONS"],
    auth_level=func.AuthLevel.ANONYMOUS,
)
def generate_qa(req: func.HttpRequest) -> func.HttpResponse:
    log_content = []
    try:
        start_time = time.time()
        log_content.append(f"[{ts()}] INFO  [generate_qa] Function invoked | method={req.method}")

        if req.method == "OPTIONS":
            upload_log_to_blob(log_content, "generate_qa")
            return func.HttpResponse(
                "",
                status_code=204,
                headers={
                    "Access-Control-Allow-Origin":  _pick_origin(req),
                    "Access-Control-Allow-Methods": "POST, OPTIONS",
                    "Access-Control-Allow-Headers": "Content-Type, Authorization",
                    "Vary": "Origin",
                },
            )

        try:
            body = req.get_json()
        except ValueError:
            upload_log_to_blob(log_content, "generate_qa")
            return func.HttpResponse(
                json.dumps({"detail": "Invalid JSON body"}),
                status_code=400, mimetype="application/json", headers=_cors_headers(req),
            )

        ruling_ids   = body.get("ruling_ids")
        user_context = body.get("context", "")
        log_content.append(f"[{ts()}] INFO  [generate_qa] ruling_ids={ruling_ids}")

        if not ruling_ids:
            upload_log_to_blob(log_content, "generate_qa")
            return func.HttpResponse(
                json.dumps({"detail": "ruling_ids must not be empty"}),
                status_code=400, mimetype="application/json", headers=_cors_headers(req),
            )

        # ── Sr 19 — generate across ALL selected rulings ───────────────────
        # This used to read `ruling_ids[0]` and discard the rest, while the UI
        # let the user tick up to ten. The whole premise of the redesign is
        # generating across a chosen precedent set, so every id is now fetched
        # and their documents concatenated into one context.
        #
        # Cost note: context grows roughly linearly with the number of rulings,
        # so MAX_RULINGS_PER_GENERATION caps it. _truncate_context then trims
        # whatever still exceeds the model budget.
        MAX_RULINGS_PER_GENERATION = 10
        selected_ids = [r for r in ruling_ids if r][:MAX_RULINGS_PER_GENERATION]

        neo4j_start = time.time()
        documents, resolved_ids, missing_ids = [], [], []
        for rid in selected_ids:
            node = read_neo4j_translatedDocuments(rid)
            if not node:
                missing_ids.append(rid)
                continue
            resolved_ids.append(rid)
            documents.append(node)
        log_content.append(
            f"[{ts()}] INFO  [generate_qa] Neo4j fetch duration={time.time()-neo4j_start:.2f}s | "
            f"resolved={len(resolved_ids)} missing={len(missing_ids)}"
        )

        if not documents:
            upload_log_to_blob(log_content, "generate_qa")
            return func.HttpResponse(
                json.dumps({"detail": "None of the selected rulings could be read.",
                            "missing_ruling_ids": missing_ids}),
                status_code=404, mimetype="application/json", headers=_cors_headers(req),
            )

        # Each ruling is labelled [R1], [R2] … so the model can say which ruling
        # each question comes from; the labels are mapped back to rulings below.
        # The text budget is split evenly, so every selected ruling is read
        # (the English text from rawJson rather than the raw node repr).
        by_id = {r.get("id"): r for r in read_neo4j()}
        per_ruling_chars = max(2000, MAX_RULING_CHARS // max(1, len(documents)) - 200)

        def _ruling_text(doc) -> str:
            raw = doc.get("rawJson") if hasattr(doc, "get") else None
            if isinstance(raw, str):
                try:
                    text = (json.loads(raw) or {}).get("extracted_text")
                    if text:
                        return str(text)
                except (json.JSONDecodeError, AttributeError):
                    pass
            return str(doc)

        ruling_refs: Dict[str, Dict[str, Any]] = {}
        blocks = []
        for i, (rid, doc) in enumerate(zip(resolved_ids, documents)):
            ref     = f"R{i + 1}"
            summary = by_id.get(rid) or {}
            title   = summary.get("title") or rid
            year    = (summary.get("decision_date") or "")[:4] or None
            ruling_refs[ref] = {"ruling_id": rid, "title": title, "year": year}
            # The structured fields go above the prose, and their length comes
            # out of this ruling's text allowance rather than on top of it, so
            # the total context stays within MAX_RULING_CHARS and the second
            # pass in _truncate_context cannot cut the tail rulings.
            facts = _ruling_facts(summary)
            text_budget = max(1000, per_ruling_chars - len(facts))
            text = _ruling_text(doc)
            if len(text) > text_budget:
                text = text[:text_budget] + "\n[Ruling text truncated]"
            header = f"=== [{ref}] RULING {i+1} of {len(documents)} — {title} ==="
            blocks.append(
                f"{header}\n{facts}\n\n{text}" if facts else f"{header}\n{text}"
            )
        node = "\n\n".join(blocks)

        # ── Sr 21 — the dossier attached in Ruling Search ──────────────────
        # Stays in user_context rather than moving into the [R..] blocks: that
        # placement is proven to work (a test dossier produced 9 of 9 questions
        # grounded in it) and, unlike rulings_context, user_context is never
        # passed through _truncate_context, so it cannot be squeezed out.
        #
        # What changes is attribution. It used to be labelled "never cite it",
        # which left the model with dossier-derived questions and only ruling
        # references to attribute them to — so a question about the dossier's
        # own ICER came back sourced to an unrelated ZIN package advice. It is
        # now a citable [D1], carrying ruling_id = None so the UI shows it as
        # the user's document rather than a published ruling.
        dossier_upload_id = (body.get("dossier_review_upload_id") or "").strip() or None
        dossier_meta      = _load_dossier_review(dossier_upload_id) if dossier_upload_id else None
        dossier_text      = ((dossier_meta or {}).get("text") or "").strip()[:MAX_DOSSIER_CHARS]
        dossier_name      = (dossier_meta or {}).get("filename") or "your dossier"
        if dossier_text:
            user_context = (
                f"{user_context}\n\n"
                f"--- [D1] THE SUBMITTER'S OWN DOSSIER — {dossier_name} ---\n"
                "This is the user's own submission document, not a published ZIN ruling. "
                "Use it, and cite it as [D1] for any question drawn from it. Never attribute "
                "its contents to a ruling.\n"
                f"{dossier_text}\n--- END [D1] ---"
            ).strip()
            ruling_refs["D1"] = {
                "ruling_id":  None,            # not a corpus ruling
                "title":      dossier_name,
                "year":       None,
                "is_dossier": True,
            }

        # ── The Q&A page's own upload, as [D2] ─────────────────────────────
        # A second, separate slot from the Ruling Search dossier above: the UI
        # offers it for a clinical summary, study report or draft section. It
        # is deliberately its own reference rather than replacing [D1], because
        # the two can both be attached and a question may draw on either.
        #
        # Same budget as [D1] and the same placement in user_context, which
        # _truncate_context never trims — so with both attached the worst case
        # is 2 x MAX_DOSSIER_CHARS of supporting documents.
        context_upload_id = (body.get("context_upload_id") or "").strip() or None
        context_meta      = _load_dossier_review(context_upload_id) if context_upload_id else None
        context_text      = ((context_meta or {}).get("text") or "").strip()[:MAX_DOSSIER_CHARS]
        context_name      = (context_meta or {}).get("filename") or "your document"
        if context_text:
            user_context = (
                f"{user_context}\n\n"
                f"--- [D2] THE USER'S SUPPORTING DOCUMENT — {context_name} ---\n"
                "This is a document the user attached on the Q&A page, not a published "
                "ZIN ruling. Use it, and cite it as [D2] for any question drawn from it. "
                "Never attribute its contents to a ruling.\n"
                f"{context_text}\n--- END [D2] ---"
            ).strip()
            ruling_refs["D2"] = {
                "ruling_id":  None,
                "title":      context_name,
                "year":       None,
                "is_dossier": True,
            }

        # ── Sr 20 — explicit dossier categories ────────────────────────────
        # Which dossiers to generate used to be inferred by string-matching the
        # free-text context box, so a user who happened to write "budget" got a
        # different result from one who did not. The client now says outright.
        requested = body.get("dossier_categories") or body.get("dossier_codes") or []
        dossier_codes = []
        for entry in requested:
            code = (entry or "").strip().upper()
            if code in DOSSIER_CONFIGS:
                dossier_codes.append(code)
                continue
            match = next(
                (o["code"] for o in DOSSIER_CATEGORY_OPTIONS
                 if o["code"] and (o["value"].lower() == str(entry).lower()
                                   or o["label"].lower() == str(entry).lower())),
                None,
            )
            if match and match not in dossier_codes:
                dossier_codes.append(match)

        if not dossier_codes:
            # No explicit request — generate all three rather than guessing.
            dossier_codes = ["FT", "BIA", "FE"]

        log_content.append(
            f"[{ts()}] INFO  [generate_qa] Dossiers to generate: {dossier_codes} | "
            f"rulings_in_context={len(documents)} | dossier_upload={bool(dossier_text)} | "
            f"context_upload={bool(context_text)}"
        )

        dossier_gen_start = time.time()
        dossiers = run_dossier_generation_parallel(
            node=node,
            user_context=user_context,
            dossier_codes=dossier_codes,
            max_workers=len(dossier_codes),
        )

        # Map each question's [Rn] references back to the ruling it came from.
        # Unknown references are dropped; with a single ruling there is nothing
        # to choose between, so it is attributed directly.
        unattributed = 0
        # Which references the questions actually drew on. Attaching a document
        # and having nothing cite it is a normal outcome — it means the model
        # found nothing in it bearing on these questions — but it is
        # indistinguishable from "silently ignored" unless we report it.
        used_refs: set = set()
        for d in dossiers:
            for q in d.get("predicted_questions", []) or []:
                refs = []
                for ref in (q.pop("source_ruling_refs", None) or []):
                    ref = str(ref).strip().strip("[]").upper()
                    if ref in ruling_refs and ref not in refs:
                        refs.append(ref)
                if not refs and len(ruling_refs) == 1:
                    refs = list(ruling_refs)
                if not refs:
                    unattributed += 1
                used_refs.update(refs)
                q["source_rulings"] = [ruling_refs[r] for r in refs]

        total_q_count = sum(len(d.get("predicted_questions", [])) for d in dossiers)
        log_content.append(
            f"[{ts()}] INFO  [generate_qa] Parallel generation complete | "
            f"dossiers={len(dossiers)} | questions={total_q_count} | "
            f"duration={time.time()-dossier_gen_start:.2f}s"
        )
        log_content.append(f"Predicted Questions and Answers: {dossiers}")

        payload = {
            "dossiers":     dossiers,
            "generated_at": datetime.now(timezone.utc).isoformat(),
            # Sr 19 — the UI states what the generation actually covered, so a
            # ruling that could not be read is visible rather than silently
            # dropped.
            "meta": {
                "rulings_requested":  len(ruling_ids),
                "rulings_used":       len(resolved_ids),
                "ruling_ids_used":    resolved_ids,
                "missing_ruling_ids": missing_ids,
                "dossier_codes":      dossier_codes,
                "used_dossier_review": bool(dossier_text),
                # Reported separately so the UI can warn when a file the user
                # attached on this page did not make it into the prompt — the
                # same guard that already exists for [D1].
                "used_context_upload": bool(context_text),
                "questions_without_ruling": unattributed,
                # What was actually read, so the UI can confirm on success
                # rather than only warning on failure. chars is the text that
                # reached the prompt after the MAX_DOSSIER_CHARS cap, which is
                # the honest number — pages is the whole document.
                "attachments": [
                    a for a in (
                        {"ref": "D1", "name": dossier_name,
                         "chars": len(dossier_text),
                         "pages": (dossier_meta or {}).get("page_count")} if dossier_text else None,
                        {"ref": "D2", "name": context_name,
                         "chars": len(context_text),
                         "pages": (context_meta or {}).get("page_count")} if context_text else None,
                    ) if a
                ],
                # Read but not drawn on. Distinguishes "the model found nothing
                # relevant in it" from "it never arrived", which otherwise look
                # identical to the user.
                "refs_uncited": sorted(set(ruling_refs) - used_refs),
                "refs_used":    sorted(used_refs),
            },
        }

        log_content.append(f"[{ts()}] INFO  [generate_qa] Total time={time.time()-start_time:.2f}s")
        upload_log_to_blob(log_content, "generate_qa")
        return func.HttpResponse(
            json.dumps(payload, ensure_ascii=False),
            status_code=200, mimetype="application/json", headers=_cors_headers(req),
        )

    except Exception as e:
        log_content.append(f"[{ts()}] ERROR [generate_qa] {e}\n{traceback.format_exc()}")
        upload_log_to_blob(log_content, "generate_qa")
        return func.HttpResponse(
            json.dumps({"error": "Internal Server Error", "detail": str(e)}),
            status_code=500, mimetype="application/json", headers=_cors_headers(req),
        )



# -----------------------------------------------------------------------------
# POST /api/search-input — with off-topic guard + post-generation refusal check
# -----------------------------------------------------------------------------
@app.function_name(name="search_input")
@app.route(
    route="search-input",
    methods=["POST", "OPTIONS"],
    auth_level=func.AuthLevel.ANONYMOUS,
)
def search_input(req: func.HttpRequest) -> func.HttpResponse:
    log_content = []
    try:
        log_content.append(f"[{ts()}] INFO  [search_input] Function invoked | method={req.method}")

        if req.method == "OPTIONS":
            upload_log_to_blob(log_content, "search_input")
            return func.HttpResponse("", status_code=204, headers=_cors_preflight_headers(req))

        try:
            data = req.get_json()
        except ValueError:
            data = {}

        query_data = data.get("query", "")
        query      = clean_text(query_data)

        # ── Sr 24 — scope the answer to the user's active filters ─────────
        # The synthesis used to run over the whole index regardless of what the
        # result list was filtered to, so "Answer across these 42 rulings" was
        # not a true statement. Filters are optional; absent, behaviour is
        # unchanged.
        filters = data.get("filters") or {}
        f_areas    = [a for a in (filters.get("therapy_areas")     or []) if a]
        f_outcomes = [o for o in (filters.get("outcomes")          or []) if o]
        f_dossiers = [d for d in (filters.get("dossier_categories") or []) if d]
        # Cross-dossier Review is a review mode, not a stored value — filtering
        # on it would match nothing. It is stripped before it reaches the query.
        f_dossiers = [d for d in f_dossiers if d != CROSS_DOSSIER_REVIEW]
        f_year_from = (filters.get("year_from") or "").strip()
        f_year_to   = (filters.get("year_to")   or "").strip()

        # Sr 21 — the dossier the user attached in Ruling Search.
        dossier_upload_id = (data.get("dossier_review_upload_id") or "").strip() or None
        dossier_text      = dossier_review_context(dossier_upload_id, limit=6000)

        log_content.append(
            f"[{ts()}] INFO  [search_input] raw_query='{query_data[:120]}' | cleaned='{query[:120]}' | "
            f"filters areas={len(f_areas)} outcomes={len(f_outcomes)} dossiers={len(f_dossiers)} "
            f"years={f_year_from or '*'}..{f_year_to or '*'} | dossier_upload={bool(dossier_text)}"
        )

        # ── STAGE 1: Off-topic guard ──────────────────────────────────────
        # Runs before embedding — zero token cost.
        # Prevents misleading "Cited Sources" for unrelated questions.
        if _is_off_topic(query):
            log_content.append(
                f"[{ts()}] INFO  [search_input] Off-topic detected — returning refusal | query='{query[:80]}'"
            )
            upload_log_to_blob(log_content, "search_input")
            return func.HttpResponse(
                json.dumps(_OFF_TOPIC_RESPONSE, ensure_ascii=False),
                status_code=200,
                mimetype="application/json",
                headers=_cors_headers(req),
            )

        # ── STAGE 2: Embed + vector search ───────────────────────────────
        search_client = SearchClient(
            endpoint   = search_endpoint,
            index_name = index_name,
            credential = AzureKeyCredential(search_key),
        )

        # Why the detail: the exception type and traceback used to go only to
        # stdout, while the blob log kept just str(e). Read back later, a local
        # RecursionError and a real gateway outage looked identical.
        embed_error = {}

        def embed_texts(texts: list) -> list:
            try:
                vectors = []
                for t in texts:
                    resp = az_openai_client.embeddings.create(input=t, model=EMBED_MODEL)
                    vectors.append(resp.data[0].embedding)
                return vectors
            except Exception as e:
                embed_error["type"] = type(e).__name__
                embed_error["msg"]  = str(e)
                log_content.append(
                    f"[{ts()}] WARN  [search_input] Embedding failed: "
                    f"{type(e).__name__}: {e}"
                )
                for tb_line in traceback.format_exc().splitlines()[-40:]:
                    log_content.append("[traceback] " + tb_line)
                # No upload here: the caller's handler writes the log once, so a
                # single failure stops producing two separate blob records.
                return None

        query_vector = embed_texts([query])
        if not query_vector:
            raise ValueError(
                "Embedding generation failed "
                f"({embed_error.get('type', 'unknown')}: "
                f"{embed_error.get('msg', 'no client, or empty query')})"
            )
        query_vector = query_vector[0]

        vector_query = VectorizedQuery(
            vector=query_vector, k_nearest_neighbors=5, fields="contentVector", kind="vector"
        )
        results = search_client.search(
            search_text=None, vector_queries=[vector_query],
            select=["content", "source", "page_number"],
        )
        hits = list(results)
        log_content.append(f"[{ts()}] INFO  [search_input] Vector search hits={len(hits)}")

        # ── STAGE 3: Post-retrieval thin-context check ────────────────────
        # If retrieved chunks are too thin, the query likely matched on noise.
        # Return a clean "no results" rather than passing near-empty context
        # to the LLM, which produces confusing refusals with fake citations.
        total_content_chars = sum(len(h.get("content") or "") for h in hits)
        log_content.append(
            f"[{ts()}] INFO  [search_input] Total content chars across hits: {total_content_chars}"
        )

        if total_content_chars < 150:
            log_content.append(
                f"[{ts()}] INFO  [search_input] Retrieved context too thin ({total_content_chars} chars) "
                f"— returning no-results response"
            )
            upload_log_to_blob(log_content, "search_input")
            return func.HttpResponse(
                json.dumps({
                    "result": (
                        "No relevant information was found in the ZIN ruling database for your query. "
                        "Try rephrasing your question or searching for a specific drug name, "
                        "therapy area, or assessment methodology."
                    ),
                    "sources":            [],
                    "matched_ruling_ids": [],
                    "matched_rulings":    [],
                    "off_topic":          False,
                    "no_results":         True,
                }, ensure_ascii=False),
                status_code=200,
                mimetype="application/json",
                headers=_cors_headers(req),
            )

        # ── STAGE 4: Build context + sources ─────────────────────────────
        def generate_blob_sas_url(blob_name: str, page_number: int = None) -> str:
            try:
                parsed         = urlparse(CONTAINER_SAS_URL)
                account_url    = f"{parsed.scheme}://{parsed.netloc}"
                container_name = parsed.path.lstrip("/").split("/")[0]
                sas_token      = parsed.query
                blob_url       = f"{account_url}/{container_name}/{blob_name}?{sas_token}"
                if page_number:
                    blob_url += f"#page={page_number}"
                return blob_url
            except Exception as e:
                log_content.append(f"[{ts()}] WARN  [search_input] SAS URL failed: {e}")
                return None

        def build_context_and_sources(hits: list, max_chars: int = 12000) -> tuple:
            parts, sources, seen_urls = [], [], {}
            for i, h in enumerate(hits, start=1):
                src         = h.get("source") or h.get("title") or ""
                snippet     = h.get("content") or ""
                page_number = h.get("page_number")
                page_label  = f"Page {page_number}" if page_number else "Page unknown"
                parts.append(f"[Chunk {i}] Source: {src} ({page_label})\n{snippet}")
                file_url = generate_blob_sas_url(src, page_number) if src else None
                if file_url and file_url not in seen_urls:
                    seen_urls[file_url] = True
                    sources.append({"file": src, "page_number": page_number, "url": file_url})
            ctx = "\n\n".join(parts)
            if len(ctx) > max_chars:
                ctx = ctx[:max_chars]
            return ctx, sources

        context, sources = build_context_and_sources(hits)

        # ── STAGE 5: RAG answer generation ───────────────────────────────
        def trim_to_sentence(text: str, limit: int = 420) -> str:
            """Cut at the last sentence end inside `limit`, else a word boundary.

            A hard character cut leaves the excerpt hanging mid-phrase ("- the
            average…"), which reads as though the ruling text is corrupt rather
            than merely abridged. Falling back to a word boundary keeps the
            worst case tidy when a page carries no sentence end at all, which
            happens with tables and headed lists.
            """
            s = " ".join((text or "").split())
            if len(s) <= limit:
                return s
            window = s[:limit]
            # rfind over the three terminators, taking whichever sits latest.
            cut = max(window.rfind(". "), window.rfind("? "), window.rfind("! "))
            # Only honour a sentence end past the half-way mark; a very early
            # full stop (an abbreviation, a reference number) would throw most
            # of the excerpt away.
            if cut >= limit // 2:
                return s[:cut + 1]
            # Same guard on the word boundary: a single very long run of
            # characters (an unspaced table row) would otherwise leave a
            # handful of characters standing in for the whole excerpt.
            cut = window.rfind(" ")
            return (s[:cut] if cut >= limit // 2 else window).rstrip(" ,;:-") + "…"

        def rank_hits_by_source(hits: list) -> list:
            """One entry per distinct source, in the order the search ranked it.

            A ruling usually matches on several pages. The best-matching page is
            the one worth reporting, so each source keeps its highest score and
            the chunk that earned it.

            Why this exists: the previous version put hit sources into a SET,
            which discarded the ranking before anything downstream could use it.
            Search.jsx sorts results by the order of the ids returned here, so
            "Sort: most relevant" was preserving an order that carried no
            relevance at all.
            """
            ordered = []
            by_source = {}
            for h in hits:
                src = (h.get("source") or "").strip()
                if not src:
                    continue
                # @search.score rides on every hit even though `select` does not
                # name it. Absent only if the service stops returning it.
                score = h.get("@search.score")
                score = float(score) if score is not None else 0.0
                existing = by_source.get(src)
                if existing is None:
                    entry = {
                        "source":      src,
                        "score":       score,
                        "page_number": h.get("page_number"),
                        "snippet":     (h.get("content") or "").strip(),
                    }
                    by_source[src] = entry
                    ordered.append(entry)
                elif score > existing["score"]:
                    existing.update(
                        score=score,
                        page_number=h.get("page_number"),
                        snippet=(h.get("content") or "").strip(),
                    )
            return ordered

        def resolve_ruling_ids(ranked: list) -> dict:
            """Map blob name -> ruling id for the given sources.

            An indexed lookup rather than a scan. `blob_name` carries a
            uniqueness constraint (hta_translated_blob) and build_search_index
            stores `source` as the blob name verbatim, so the two line up
            exactly — `neo4j_admin.py verify` section 7 reports 873/873 with
            0 mismatches. The old code walked all 873 nodes and parsed each
            node's rawJson with APOC to recover the same string.
            """
            names = [r["source"] for r in ranked]
            if not names:
                return {}
            cypher = """
            MATCH (t:TranslatedDocuments)
            WHERE t.blob_name IN $names
            RETURN t.blob_name AS blob_name, t.id AS id
            """
            out = {}
            with get_driver().session() as session:
                for rec in session.run(cypher, names=names):
                    if rec["blob_name"] and rec["id"]:
                        out[rec["blob_name"]] = rec["id"]
            return out

        def find_matched_rulings(hits: list) -> list:
            """Ranked [{ruling_id, score, relative, rank, page_number, snippet}].

            `relative` is the score as a percentage of the top hit's, which is
            what the UI shows. A raw vector score is not a "% match" on any
            scale a reader would recognise, so presenting it as one would imply
            a precision it does not have.
            """
            try:
                ranked = rank_hits_by_source(hits)
                if not ranked:
                    return []

                by_blob = resolve_ruling_ids(ranked)
                unresolved = [r["source"] for r in ranked if r["source"] not in by_blob]
                if unresolved:
                    # Exact matching replaced a substring comparison. If this
                    # ever fires, the two naming schemes have drifted and the
                    # fallback below is what keeps results appearing.
                    log_content.append(
                        f"[{ts()}] WARN  [search_input] {len(unresolved)} hit source(s) did not "
                        f"resolve by blob_name: {unresolved[:3]}"
                    )
                    by_blob.update(resolve_unmatched_by_substring(unresolved))

                top = max((r["score"] for r in ranked), default=0.0) or 0.0
                out, position = [], 0
                for r in ranked:
                    rid = by_blob.get(r["source"])
                    if not rid:
                        continue
                    position += 1
                    out.append({
                        "ruling_id":   rid,
                        "score":       round(r["score"], 4),
                        "relative":    round((r["score"] / top) * 100, 1) if top else None,
                        "rank":        position,
                        "page_number": r["page_number"],
                        # Trimmed here rather than in the UI so the payload does
                        # not carry a full page per ruling, and cut at a
                        # sentence end so it does not read as truncated text.
                        "snippet":     trim_to_sentence(r["snippet"]),
                    })
                return out
            except Exception as e:
                log_content.append(f"[{ts()}] WARN  [search_input] Ruling matching failed: {e}")
                return []

        def resolve_unmatched_by_substring(sources: list) -> dict:
            """Fallback for sources that do not match a blob_name exactly.

            This is the old behaviour, kept only for the sources that need it:
            a full scan is too expensive to run for every search, but it is the
            right thing to fall back to rather than silently dropping a result.
            """
            try:
                cypher = """
                MATCH (t:TranslatedDocuments)
                RETURN t.id AS id, t.blob_name AS blob_name
                """
                out = {}
                with get_driver().session() as session:
                    for rec in session.run(cypher):
                        name = (rec["blob_name"] or "").strip()
                        if not name or not rec["id"]:
                            continue
                        for src in sources:
                            if src in out:
                                continue
                            if name in src or src in name:
                                out[src] = rec["id"]
                return out
            except Exception as e:
                log_content.append(f"[{ts()}] WARN  [search_input] substring fallback failed: {e}")
                return {}

        def find_matched_ruling_ids(hits: list) -> list:
            try:
                return [m["ruling_id"] for m in find_matched_rulings(hits)]
            except Exception as e:
                log_content.append(f"[{ts()}] WARN  [search_input] Ruling matching failed: {e}")
                return []

        system_message = (
            "You are a helpful assistant specialising in ZIN HTA rulings and "
            "Dutch healthcare reimbursement decisions. "
            "Use ONLY the provided context to answer the user question. "
            "Do NOT mention chunk numbers, chunk references, source file names, "
            "or page numbers in your answer. "
            "Write a clean, natural, well-formatted answer only. "
            "If the answer is not clearly present in the context, respond with exactly: "
            "'I could not find a clear answer to this question in the available ZIN rulings.' "
            "Do NOT speculate, infer, or fabricate information not present in the context."
        )
        # Sr 21 — the user's own dossier, when one is attached in Ruling Search.
        # Labelled distinctly from the ZIN context and explicitly excluded as a
        # source of fact, so the model cannot cite the manufacturer's own
        # document as if it were published precedent.
        dossier_block = ""
        if dossier_text:
            dossier_block = (
                "\n\nThe user has also attached their own draft dossier, below. "
                "Use it ONLY to understand what they are asking about — their drug, "
                "indication, comparator and assumptions. It is NOT evidence and must "
                "NOT be cited or treated as a ZIN ruling.\n"
                f"--- USER DOSSIER (not evidence) ---\n{dossier_text}\n--- END USER DOSSIER ---"
            )

        user_prompt = (
            "Answer the user question using only the context below.\n"
            "Do NOT include chunk numbers, source file names, or page references.\n"
            "Write a clean, natural, well-formatted answer only.\n"
            "If the context does not clearly contain the answer, respond with: "
            "'I could not find a clear answer to this question in the available ZIN rulings.'\n\n"
            f"Context:\n{context}{dossier_block}\n\nUser question: {query}"
        )

        bedrock_request = {
            "modelId":  BEDROCK_MODEL,
            "system":   [{"text": system_message}],
            "messages": [{"role": "user", "content": [{"text": user_prompt}]}],
            "inferenceConfig": {"temperature": 0.1, "maxTokens": 800},
        }
        resp    = bedrock_client.converse(**bedrock_request)
        content = ""
        try:
            content = resp["output"]["message"]["content"][0]["text"]
        except (KeyError, IndexError, TypeError) as parse_err:
            log_content.append(f"[{ts()}] WARN  [search_input] Bedrock parse failed: {parse_err}")

        # ── STAGE 6: Post-generation refusal detection ────────────────────
        # If Claude signals it couldn't find relevant content, suppress the
        # sources list entirely to prevent misleading citations being shown.
        # This is the direct fix for the original reported bug.
        answer_is_refusal, refusal_signal = _is_refusal(content)
        print(f"[search_input] raw answer: {content[:300]!r} | refusal={answer_is_refusal}")
        # Sr 100 — a refusal suppresses the CITATIONS, not the RANKING. These
        # are different claims: `sources` are cited beneath an answer, so they
        # must go when there is no answer to cite them under. `matched_rulings`
        # is the retrieval result — the vector search did match those rulings
        # and did score them, whether or not the model could write a synthesis
        # over them. Discarding it turned every refusal into a silent collapse
        # from semantic search to keyword matching: the result list stayed full,
        # the relevance scores vanished, the ordering reverted to newest-first,
        # and nothing told the user why.
        effective_sources  = [] if answer_is_refusal else sources
        # Computed once. matched_ruling_ids is derived from it rather than
        # resolved separately, so the two can never disagree about order.
        matched_rulings    = find_matched_rulings(hits)
        matched_ruling_ids = [m["ruling_id"] for m in matched_rulings]


        # ── Sr 24 — restrict matches to the filtered set ──────────────────
        # The search index stores chunks keyed by source file and carries no
        # therapy area, outcome or date, so an OData filter is not possible.
        # Matched rulings are therefore reconciled against the corpus here, and
        # anything outside the user's active filters is dropped — so the count
        # the UI reports describes the set the user is actually looking at.
        has_filters = any([f_areas, f_outcomes, f_dossiers, f_year_from, f_year_to])
        filtered_out = 0
        if matched_ruling_ids and has_filters:
            by_id = {r.get("id"): r for r in read_neo4j()}

            def _passes(rid) -> bool:
                r = by_id.get(rid)
                if not r:
                    return False
                if f_areas and (r.get("therapy_area") or "") not in f_areas:
                    return False
                if f_outcomes and (r.get("decision_outcome") or "") not in f_outcomes:
                    return False
                if f_dossiers and (r.get("dossier_category") or "") not in f_dossiers:
                    return False
                year = (r.get("decision_date") or "")[:4]
                if f_year_from and (not year or year < f_year_from):
                    return False
                if f_year_to and (not year or year > f_year_to):
                    return False
                return True

            kept = [rid for rid in matched_ruling_ids if _passes(rid)]
            filtered_out = len(matched_ruling_ids) - len(kept)
            matched_ruling_ids = kept
            # Filter the rich list through the same predicate, then renumber:
            # rank is a position in what the user is shown, so leaving gaps
            # after a filter would read as missing results.
            matched_rulings = [m for m in matched_rulings if m["ruling_id"] in set(kept)]
            for i, m in enumerate(matched_rulings, start=1):
                m["rank"] = i
            log_content.append(
                f"[{ts()}] INFO  [search_input] Filter scope dropped {filtered_out} matched ruling(s)"
            )

        # ── Sr 25 — stated confidence ─────────────────────────────────────
        # Derived from how much grounded material the answer actually rests on,
        # so the user can calibrate rather than guess. The design marks fewer
        # than five comparable precedents as low confidence.
        source_count = len(effective_sources)
        if answer_is_refusal or source_count == 0:
            confidence = "none"
        elif source_count >= 5 and total_content_chars >= 4000:
            confidence = "high"
        elif source_count >= 3:
            confidence = "moderate"
        else:
            confidence = "low"

        if answer_is_refusal:
            log_content.append(
                f"[{ts()}] INFO  [search_input] LLM signalled it couldn't answer "
                f"(matched: {refusal_signal!r}) — suppressing {len(sources)} "
                f"source(s) to prevent misleading citations"
            )
            # The model's own words, so a false positive can be told apart from
            # a genuine refusal when reading the log back. Previously this went
            # to stdout only, which is gone by the time anyone looks.
            log_content.append(
                f"[{ts()}] INFO  [search_input] suppressed answer was: {content[:400]!r}"
            )
            # Replace the LLM's verbose refusal with a clean, consistent
            # message. Sr 100 — the wording no longer claims nothing was
            # found, because the ranked rulings below are now still returned:
            # what failed is the synthesis, not the retrieval.
            content = (
                "No summary could be written for this question — the wording did "
                "not give enough to answer from. The rulings below are still the "
                "closest matches in the corpus, ranked by relevance; open them, or "
                "rephrase as a question about a specific drug, therapy area, "
                "outcome or assessment method."
            )

        log_content.append(
            f"[{ts()}] INFO  [search_input] Complete | "
            f"answer_len={len(content)} | sources={len(effective_sources)} | "
            f"matched_rulings={len(matched_ruling_ids)} | "
            f"answer_was_refusal={answer_is_refusal}"
        )
        upload_log_to_blob(log_content, "search_input")

        return func.HttpResponse(
            json.dumps({
                "result":             content,
                "sources":            effective_sources,
                "matched_ruling_ids": matched_ruling_ids,
                # Same rulings, same order, with the evidence for the ranking:
                # relative score, position, and the page-chunk that matched.
                # matched_ruling_ids stays as it was — Search.jsx and the Q&A
                # handoff both read it, and neither should have to change.
                "matched_rulings":    matched_rulings,
                "off_topic":          False,
                "no_results":         False,
                # Sr 100 — retrieval succeeded, synthesis did not. The UI shows
                # the ranked rulings with a note instead of an answer.
                "no_synthesis":       answer_is_refusal,
                # Sr 25 — so the UI can show "High confidence · 42 sources"
                # rather than presenting every answer with equal weight.
                "confidence":         confidence,
                "source_count":       source_count,
                # Sr 24 — how many grounded matches the active filters excluded.
                "filtered_out":       filtered_out,
                "scoped_by_filters":  has_filters,
                "used_dossier_review": bool(dossier_text),
            }, ensure_ascii=False),
            status_code=200,
            mimetype="application/json",
            headers=_cors_headers(req),
        )

    except Exception as e:
        log_content.append(f"[{ts()}] ERROR [search_input] {e}\n{traceback.format_exc()}")
        upload_log_to_blob(log_content, "search_input")
        return func.HttpResponse(
            json.dumps({"error": "Internal Server Error", "detail": str(e)}),
            status_code=500, mimetype="application/json", headers=_cors_headers(req),
        )


# -----------------------------------------------------------------------------
# POST /api/insights/analyse
# -----------------------------------------------------------------------------
# Scope fix (follows Sr 26 / Sr 27).
#
# The previous version picked MAX_RULINGS = 60 rulings by equal-weight keyword
# overlap (`_filter_relevant_rulings`, threshold 0.05, so almost every ruling
# qualified) and asked the model to count from those 60. "How has the
# conditional approval rate in cardiology changed since 2022?" was answered
# from 60 mostly 2008–2020 rulings that happened to contain the word
# "conditional"; the model then reported the 2022+ cardiology rulings it was
# never shown as absent from the database, with "high" confidence.
#
# Now:
#   1. Scope   — therapy area and years are read from the question (therapy
#                area falls back to the open session's), and the WHOLE corpus
#                is filtered by them in code.
#   2. Numbers — counts, outcome shares and the year trend are computed in code
#                over EVERY matching ruling and handed to the model as fixed
#                facts. No sampling limit applies to them.
#   3. Text    — up to IA_MAX_CONTEXT_RULINGS of the matching rulings (most
#                relevant first, newest breaking ties) are given to the model as
#                excerpts for the qualitative findings. This cap limits what the
#                model reads, never what it counts.
#   4. Honesty — confidence follows how many published rulings match;
#                citations are the rulings the model says it used, checked
#                against what it was given; trend_data is always computed.
#   5. Empty   — if the period asked about holds no rulings but the area does
#      period    ("cardiology since 2022" when the latest is 2020), the answer
#                says so first and then describes the area's full record, with
#                low confidence. Only a scope with no rulings at all returns
#                the "no rulings match" message without calling the model.
#
# Dates are read from any common layout and therapy areas are matched
# case-insensitively through synonym groups, so a label or date-format
# variant cannot silently empty the scope. `scope` in the response reports
# the area's size, its latest decision and how many of its rulings are undated.
#
# Everything in this section is used only by this endpoint. The shared helpers
# it used to call (`_filter_relevant_rulings` and friends) are unchanged, so
# the Q&A routes behave exactly as before.
#
# Response fields are unchanged for the Insights page, with three additions:
#   rulings_matched      rulings inside the question's scope (= rulings_analysed)
#   rulings_in_context   how many of those the model read as text excerpts
#   scope                the filters applied, for display or debugging
# -----------------------------------------------------------------------------

IA_MAX_CONTEXT_RULINGS = 60    # text excerpts the model reads — NOT a cap on the statistics
IA_MAX_CHARS           = 350   # characters per text field in each excerpt
IA_MAX_CITATIONS       = 8

# Therapy-area names and close synonyms that scope a question to an area.
# Deliberately conservative: disease names (myeloma, psoriasis, heart-failure
# drugs…) are NOT mapped, because the corpus may file them under another area.
# They steer the relevance ranking instead of excluding rulings.
_IA_AREA_TERMS: Dict[str, List[str]] = {
    "cardiology":    ["cardiolog", "cardiac", "cardiovascular", "heart"],
    "oncology":      ["oncolog", "cancer", "tumour", "tumor"],
    "neurology":     ["neurolog"],
    "dermatology":   ["dermatolog", "skin"],
    "immunology":    ["immunolog", "autoimmun"],
    "rare diseases": ["rare disease", "orphan"],
}

# Words that say nothing about WHICH rulings are relevant — grammar, plus the
# analytical vocabulary of the question itself ("rate", "changed", "trend").
# Outcome words are covered by the computed statistics, not by ranking.
_IA_STOP_WORDS = {
    "what", "when", "how", "does", "did", "the", "a", "an", "is", "are", "was",
    "were", "has", "have", "had", "will", "would", "could", "should", "this",
    "that", "these", "those", "and", "or", "but", "in", "on", "at", "to", "for",
    "of", "with", "by", "from", "about", "which", "who", "why", "can", "do",
    "be", "it", "its", "not", "no", "if", "than", "then", "there", "their",
    "any", "all", "most", "more", "less", "per", "into", "across", "within",
    "rate", "rates", "change", "changed", "changes", "changing", "since",
    "trend", "trends", "often", "frequency", "frequently", "pattern",
    "patterns", "over", "time", "year", "years", "last", "past", "recent",
    "recently", "between", "after", "before", "until", "number", "many",
    "much", "percentage", "proportion", "share", "zin", "ruling", "rulings",
    "decision", "decisions", "approval", "approvals", "approved", "outcome",
    "outcomes", "submission", "submissions", "trigger", "triggers",
}


def _ia_year(ruling: Dict[str, Any]) -> Optional[int]:
    """Decision year from any common date layout: 2026-03-19, 19-03-2026,
    19/03/2026, "March 2026", or a Neo4j date object."""
    m = re.search(r"(?<!\d)((?:19|20)\d{2})(?!\d)", str(ruling.get("decision_date") or ""))
    return int(m.group(1)) if m else None


def _ia_outcome(ruling: Dict[str, Any]) -> str:
    """Same classification as GET /api/insights, so the numbers agree."""
    o = (ruling.get("decision_outcome") or "").strip()
    if o == "Under Review":
        return "under_review"
    if o == "Positive":
        return "positive"
    if o == "Negative":
        return "negative"
    if "Conditions" in o:
        return "conditional"
    return "other"


def _ia_mentions(text: str, term: str) -> bool:
    return re.search(r"\b" + re.escape(term), text) is not None


def _ia_detect_areas(text: str, corpus_areas: List[str]) -> List[str]:
    """Therapy areas (as spelled in the corpus) that `text` refers to.

    Matching is case-insensitive and goes through the synonym groups in both
    directions, so "cardiology" in a question also finds an area the corpus
    spells "cardiology", "Cardiovascular" or "Cardiology & vascular"."""
    t = (text or "").lower()
    asked_groups = {
        g for g, terms in _IA_AREA_TERMS.items()
        if any(_ia_mentions(t, term) for term in [g] + terms)
    }
    found = []
    for area in corpus_areas:
        key = area.strip().lower()
        if key in ("", "unknown", "other", "others"):
            continue
        area_groups = {
            g for g, terms in _IA_AREA_TERMS.items()
            if key == g or any(_ia_mentions(key, term) for term in [g] + terms)
        }
        if _ia_mentions(t, key) or (area_groups & asked_groups):
            found.append(area)
    return found


def _ia_area_of(ruling: Dict[str, Any]) -> str:
    return str(ruling.get("therapy_area") or "").strip().lower()


def _ia_parse_years(question: str) -> Dict[str, Optional[int]]:
    """Year bounds stated in the question. Both None when it states none."""
    q = (question or "").lower()
    yr = r"((?:19|20)\d{2})"
    m = re.search(r"between\s+" + yr + r"\s+and\s+" + yr, q) or \
        re.search(yr + r"\s*(?:-|–|—|to|until|through)\s*" + yr, q)
    if m:
        a, b = sorted((int(m.group(1)), int(m.group(2))))
        return {"from": a, "to": b}

    bounds: Dict[str, Optional[int]] = {"from": None, "to": None}
    m = re.search(r"\b(since|from|after|starting(?:\s+in)?)\s+" + yr, q)
    if m:
        bounds["from"] = int(m.group(2)) + (1 if m.group(1) == "after" else 0)
    m = re.search(r"\b(before|prior\s+to|until|up\s+to|through)\s+" + yr, q)
    if m:
        bounds["to"] = int(m.group(2)) - (1 if m.group(1) in ("before",) or m.group(1).startswith("prior") else 0)
    if bounds["from"] is None and bounds["to"] is None:
        m = re.search(r"\b(?:last|past)\s+(\d{1,2})\s+years?\b", q)
        if m:
            bounds["from"] = datetime.now(timezone.utc).year - int(m.group(1)) + 1
        else:
            m = re.search(r"\bin\s+" + yr + r"\b", q)
            if m:
                bounds["from"] = bounds["to"] = int(m.group(1))
    return bounds


def _ia_stems(text: str) -> set:
    """Lower-cased word stems (first 6 letters), so conditional ≈ conditions."""
    words = re.sub(r"[^a-z0-9\s]", " ", (text or "").lower()).split()
    return {w[:6] for w in words if len(w) > 2 and w not in _IA_STOP_WORDS and not w.isdigit()}


def _ia_relevance(query_stems: set, ruling: Dict[str, Any]) -> int:
    """Matched query stems; a match in the title, drug or indication counts double."""
    if not query_stems:
        return 0
    head = _ia_stems(" ".join([
        ruling.get("title") or "", ruling.get("drug_name") or "", ruling.get("indication") or "",
    ]))
    body = _ia_stems(" ".join([
        ruling.get("summary") or "", ruling.get("decision_outcome_detail") or "",
        (ruling.get("full_text") or "")[:1500],
    ]))
    return sum(2 if s in head else 1 if s in body else 0 for s in query_stems)


def _ia_stats(rulings: List[Dict[str, Any]], by_area: bool) -> Dict[str, Any]:
    """Exact counts and shares over `rulings`. Shares are of published decisions."""
    def blank():
        return {"total": 0, "published": 0, "positive": 0, "conditional": 0,
                "negative": 0, "under_review": 0, "other": 0}

    def add(bucket, r):
        o = _ia_outcome(r)
        bucket["total"] += 1
        bucket[o] += 1
        if o != "under_review":
            bucket["published"] += 1

    def shares(b):
        p = b["published"]
        pc = lambda n: round(n / p * 100, 1) if p else None
        return {**b, "positive_pct": pc(b["positive"]),
                "conditional_pct": pc(b["conditional"]), "negative_pct": pc(b["negative"])}

    overall, years, areas, dossiers = blank(), {}, {}, {}
    for r in rulings:
        add(overall, r)
        y = _ia_year(r)
        if y:
            add(years.setdefault(y, blank()), r)
        if by_area:
            add(areas.setdefault(r.get("therapy_area") or "Unknown", blank()), r)
        cat = (r.get("dossier_category") or "Unknown").strip()
        dossiers[cat] = dossiers.get(cat, 0) + 1

    dated = sorted(str(r.get("decision_date")) for r in rulings if r.get("decision_date"))
    out = {
        "overall":  shares(overall),
        "by_year":  {str(y): shares(b) for y, b in sorted(years.items())},
        "dossier_categories": dict(sorted(dossiers.items(), key=lambda kv: -kv[1])),
        "earliest_decision": dated[0][:10] if dated else None,
        "latest_decision":   dated[-1][:10] if dated else None,
    }
    if by_area:
        out["by_therapy_area"] = {a: shares(b) for a, b in sorted(areas.items(), key=lambda kv: -kv[1]["total"])}
    return out


def _ia_trend(rulings: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Rulings per year per dossier category — the chart under the answer."""
    from collections import defaultdict
    year_dossier: dict = defaultdict(lambda: defaultdict(int))
    for r in rulings:
        y = _ia_year(r)
        if y:
            year_dossier[str(y)][(r.get("dossier_category") or "Unknown").strip()] += 1
    return [{"label": y, **dict(c)} for y, c in sorted(year_dossier.items())]


def _ia_scope_text(areas: List[str], area_source: Optional[str], years: Dict[str, Optional[int]]) -> str:
    parts = []
    if areas:
        parts.append(" / ".join(areas) + (" (from the open session)" if area_source == "session" else ""))
    else:
        parts.append("all therapy areas")
    f, t = years.get("from"), years.get("to")
    if f and t:
        parts.append(f"decided in {f}" if f == t else f"decided {f}–{t}")
    elif f:
        parts.append(f"decided in {f} or later")
    elif t:
        parts.append(f"decided in {t} or earlier")
    else:
        parts.append("all years")
    return ", ".join(parts)


def _ia_response(req, payload: Dict[str, Any], status: int = 200) -> func.HttpResponse:
    return func.HttpResponse(
        json.dumps(payload, ensure_ascii=False),
        status_code=status,
        mimetype="application/json",
        headers=_cors_headers(req),
    )


@app.function_name(name="analyse_insights")
@app.route(
    route="insights-analyse",
    methods=["POST", "OPTIONS"],
    auth_level=func.AuthLevel.ANONYMOUS,
)
def analyse_insights(req: func.HttpRequest) -> func.HttpResponse:
    log_content = []
    try:
        start_time = time.time()
        log_content.append(
            f"[{ts()}] INFO  [analyse_insights] Function invoked | method={req.method}"
        )

        if req.method == "OPTIONS":
            upload_log_to_blob(log_content, "analyse_insights")
            return func.HttpResponse(
                "", status_code=204, headers=_cors_preflight_headers(req)
            )

        try:
            body = req.get_json()
        except ValueError:
            upload_log_to_blob(log_content, "analyse_insights")
            return _ia_response(req, {"detail": "Invalid JSON body"}, 400)

        question        = (body.get("question") or "").strip()
        session_context = (body.get("session_context") or "").strip()
        log_content.append(
            f"[{ts()}] INFO  [analyse_insights] question='{question[:120]}' | "
            f"session_context='{session_context[:80]}'"
        )

        if not question:
            upload_log_to_blob(log_content, "analyse_insights")
            return _ia_response(req, {"detail": "question must not be empty"}, 400)

        neo4j_start = time.time()
        rulings     = read_neo4j()
        log_content.append(
            f"[{ts()}] INFO  [analyse_insights] Neo4j returned {len(rulings)} rulings "
            f"| duration={time.time() - neo4j_start:.2f}s"
        )

        total_rulings = len(rulings)
        if total_rulings == 0:
            upload_log_to_blob(log_content, "analyse_insights")
            return _ia_response(req, {
                "summary":          "No rulings are available in the database to analyse.",
                "findings":         [],
                "trend_data":       [],
                "rulings_analysed": 0,
                "rulings_total":    0,
                "citations":        [],
                "confidence":       "low",
            })

        # ── 1. Scope: therapy area and years, applied to the whole corpus ──
        # Distinct areas, case-insensitively (first spelling seen wins).
        corpus_areas: List[str] = []
        for r in rulings:
            a = str(r.get("therapy_area") or "").strip()
            if a and a.lower() not in {x.lower() for x in corpus_areas}:
                corpus_areas.append(a)
        corpus_areas.sort()
        areas        = _ia_detect_areas(question, corpus_areas)
        area_source  = "question" if areas else None
        if not areas and session_context:
            # Sr 27 — the session chip on the panel now actually scopes the
            # answer, but only when the question names no area itself.
            areas = _ia_detect_areas(session_context, corpus_areas)
            area_source = "session" if areas else None
        years = _ia_parse_years(question)

        def area_keys() -> set:
            return {a.lower() for a in areas}

        def in_area(r) -> bool:
            return not areas or _ia_area_of(r) in area_keys()

        def in_years(r) -> bool:
            y = _ia_year(r)
            if years["from"] is not None and (y is None or y < years["from"]):
                return False
            if years["to"] is not None and (y is None or y > years["to"]):
                return False
            return True

        matched = [r for r in rulings if in_area(r) and in_years(r)]
        if not matched and area_source == "session":
            # The session's area was only a default — drop it rather than
            # answer "nothing found" to a question that never asked for it.
            areas, area_source = [], None
            matched = [r for r in rulings if in_years(r)]

        # Diagnostics: what the area holds regardless of the years, so a
        # surprising empty result can be explained rather than guessed at.
        area_all     = [r for r in rulings if in_area(r)]
        area_dated   = sorted(str(r.get("decision_date")) for r in area_all if _ia_year(r))
        area_latest  = area_dated[-1][:10] if area_dated else None
        area_undated = sum(1 for r in area_all if _ia_year(r) is None)
        corpus_dated  = sorted(str(r.get("decision_date")) for r in rulings if _ia_year(r))
        corpus_latest = corpus_dated[-1][:10] if corpus_dated else None

        # The period asked about holds nothing, but the area does: answer
        # from the area's whole record and say plainly that the period is
        # empty — "there are no cardiology rulings since 2022; the latest is
        # from 2020" IS the answer to "how has it changed since 2022?".
        period_empty = False
        requested_scope_text = _ia_scope_text(areas, area_source, years)
        if not matched and area_all and (years["from"] is not None or years["to"] is not None):
            period_empty = True
            matched = area_all
            years_requested = dict(years)
            years = {"from": None, "to": None}
        else:
            years_requested = None

        scope_text = _ia_scope_text(areas, area_source, years)
        scope = {
            "therapy_areas": areas,
            "therapy_area_source": area_source,
            "year_from": years["from"],
            "year_to":   years["to"],
            "description": scope_text,
            "requested": requested_scope_text,
            "requested_period_empty": period_empty,
            "area_rulings_any_year": len(area_all),
            "area_latest_decision": area_latest,
            "area_rulings_without_date": area_undated,
        }
        log_content.append(
            f"[{ts()}] INFO  [analyse_insights] requested='{requested_scope_text}' | "
            f"scope='{scope_text}' | matched={len(matched)} of {total_rulings} | "
            f"area_any_year={len(area_all)} | area_latest={area_latest} | "
            f"area_undated={area_undated} | period_empty={period_empty}"
        )

        if not matched:
            # Nothing in scope at all: say so plainly, without calling the model.
            upload_log_to_blob(log_content, "analyse_insights")
            return _ia_response(req, {
                "summary": (
                    f"No rulings in the corpus match this question's scope ({scope_text}). "
                    f"The corpus holds {total_rulings} rulings in total"
                    + (f", the latest decided on {corpus_latest}" if corpus_latest else "")
                    + "; widen the therapy area or the years to include some of them."
                ),
                "findings":           [],
                "trend_data":         [],
                "rulings_analysed":   0,
                "rulings_matched":    0,
                "rulings_in_context": 0,
                "rulings_total":      total_rulings,
                "citations":          [],
                "confidence":         "low",
                # Not "corpus order": no fallback sample was analysed.
                "selection_basis":    "relevance",
                "session_context":    session_context or None,
                "scope":              scope,
            })

        # ── 2. Numbers: exact, over every matching ruling ─────────────────
        stats = _ia_stats(matched, by_area=not areas)
        baseline = None
        if years["from"] is not None:
            # Same area scope, before the period — so "has it changed since
            # 2022?" has something to be compared with.
            before = [
                r for r in rulings
                if in_area(r) and (_ia_year(r) or 9999) < years["from"]
            ]
            if before:
                baseline = _ia_stats(before, by_area=False)["overall"]
                baseline["period"] = f"before {years['from']}"

        # ── 3. Text: the most relevant matching rulings, newest on ties ───
        # Area words only restate the filter, so they do not rank anything.
        query_stems = _ia_stems(question)
        q_lower = question.lower()
        for g, terms in _IA_AREA_TERMS.items():
            if any(_ia_mentions(q_lower, t) for t in [g] + terms):
                query_stems -= _ia_stems(" ".join([g] + terms))
        for a in areas:
            query_stems -= _ia_stems(a)
        ranked = sorted(
            matched,
            key=lambda r: (_ia_relevance(query_stems, r), str(r.get("decision_date") or "")),
            reverse=True,
        )
        context = ranked[:IA_MAX_CONTEXT_RULINGS]
        any_relevant = any(_ia_relevance(query_stems, r) > 0 for r in context)
        scoped = bool(areas) or years["from"] is not None or years["to"] is not None

        if scoped or any_relevant:
            selection_basis = "relevance"
        else:
            # The question named no scope and none of its words appear in any
            # ruling: fall back to corpus order, which the page flags.
            context = rulings[:IA_MAX_CONTEXT_RULINGS]
            selection_basis = "corpus order (no ruling matched the question)"

        refs = {f"R{i + 1}": r for i, r in enumerate(context)}
        corpus_lines = []
        for ref, r in refs.items():
            corpus_lines.append(
                f"[{ref}]\n"
                f"Title: {r.get('title') or 'N/A'}\n"
                f"Drug: {r.get('drug_name') or 'N/A'} | "
                f"Therapy: {r.get('therapy_area') or 'Unknown'} | "
                f"Outcome: {r.get('decision_outcome') or 'Unknown'} | "
                f"Dossier: {r.get('dossier_category') or 'Unknown'} | "
                f"Date: {str(r.get('decision_date') or '')[:7]}\n"
                f"Summary: {(r.get('summary') or '')[:IA_MAX_CHARS]}\n"
                f"Cost-Effectiveness: {(r.get('cost_effectiveness') or '')[:IA_MAX_CHARS]}\n"
                f"Full Text Excerpt: {(r.get('full_text') or '')[:IA_MAX_CHARS]}"
            )
        corpus_text = "\n\n---\n\n".join(corpus_lines)

        log_content.append(
            f"[{ts()}] INFO  [analyse_insights] selection={selection_basis} | "
            f"in_context={len(context)} of matched={len(matched)} | corpus_chars={len(corpus_text)}"
        )

        stats_block = json.dumps(
            {"scope": scope_text, "statistics": stats, "baseline": baseline},
            ensure_ascii=False, indent=1,
        )
        session_line = (
            f"\nThe team is preparing a dossier for: {session_context}\n" if session_context else ""
        )
        period_note = ""
        if period_empty:
            period_note = (
                f"\nIMPORTANT — THE REQUESTED PERIOD IS EMPTY: the question asks about "
                f"{requested_scope_text}, and NO rulings in the database fall in that period"
                + (f" (the latest {(', '.join(areas) + ' ') if areas else ''}ruling was decided on {area_latest})"
                   if area_latest else "")
                + ". Open the summary by saying exactly that, so the reader knows the question "
                  "cannot be answered for that period. Then describe the pattern across the "
                  "area's full record below, ending at the latest decision.\n"
            )

        prompt = f"""You are a senior HTA methodologist specialising in Zorginstituut Nederland (ZIN) assessments.

A dossier preparation team has asked:

"{question}"
{session_line}{period_note}
SCOPE OF THIS ANSWER: {scope_text}.
{len(matched)} of the {total_rulings} rulings in the database fall inside this scope.

COMPUTED STATISTICS — exact, calculated by code over ALL {len(matched)} rulings in scope:
{stats_block}

How to read them: shares (positive_pct, conditional_pct, negative_pct) are percentages of PUBLISHED
decisions, which exclude rulings still under review. "baseline", when present, is the same therapy-area
scope in the years before the period, for comparison.

RULING EXCERPTS — the {len(context)} most relevant rulings in scope, each with a reference such as [R1]:
{corpus_text}

INSTRUCTIONS:
1. Write a summary of 3-5 sentences that directly answers the question. Begin by stating the scope
   and how many rulings it covers (e.g. "Across the 14 cardiology rulings decided in 2022 or later, …").
2. Give 4-6 key findings, each one sentence with a specific, checkable observation.
3. Every count, rate or percentage you state MUST come from COMPUTED STATISTICS. Never count rulings
   from the excerpts yourself — they are a subset.
4. Use the excerpts only for qualitative detail: named drugs, conditions imposed, reasons for refusal,
   methods. Do not claim anything is absent from the database because it is missing from the excerpts;
   absence may only be stated when COMPUTED STATISTICS show it.
5. If the scope holds few rulings (under 5 published), say that the evidence is thin.
6. List in "citations" the references (e.g. "R3") of the excerpts your summary and findings rely on,
   most important first, at most {IA_MAX_CITATIONS}. Use only references that appear above.

STRICT OUTPUT RULES:
- Base all content on the statistics and excerpts above — do not hallucinate.
- Return ONLY valid JSON — no markdown fences, no commentary outside the JSON.

Return ONLY this JSON object:
{{
  "summary": "<3-5 sentence answer, starting with the scope>",
  "findings": ["<finding 1>", "<finding 2>", "<finding 3>", "<finding 4>"],
  "citations": ["R1", "R2"]
}}"""

        system_message = (
            "You are an expert HTA methodologist for Zorginstituut Nederland. "
            "Numbers come only from the computed statistics you are given. "
            "Return ONLY valid JSON as instructed. No markdown, no commentary."
        )

        bedrock_request = {
            "modelId":  BEDROCK_MODEL,
            "system":   [{"text": system_message}],
            "messages": [{"role": "user", "content": [{"text": prompt}]}],
            "inferenceConfig": {"temperature": 0.1, "maxTokens": 6000},
        }

        log_content.append(
            f"[{ts()}] INFO  [analyse_insights] Calling Claude Sonnet 4 via Bedrock"
        )
        llm_start = time.time()

        try:
            resp = bedrock_client.converse(**bedrock_request)
        except Exception as bedrock_err:
            log_content.append(
                f"[{ts()}] ERROR [analyse_insights] Bedrock call failed: {bedrock_err}"
            )
            upload_log_to_blob(log_content, "analyse_insights")
            return _ia_response(req, {"detail": f"LLM call failed: {str(bedrock_err)}"}, 500)

        log_content.append(
            f"[{ts()}] INFO  [analyse_insights] Bedrock completed | "
            f"duration={time.time() - llm_start:.2f}s"
        )

        raw_content = None
        try:
            raw_content = resp["output"]["message"]["content"][0]["text"]
        except (KeyError, IndexError, TypeError) as parse_err:
            log_content.append(
                f"[{ts()}] ERROR [analyse_insights] Failed to extract text: {parse_err}"
            )
            upload_log_to_blob(log_content, "analyse_insights")
            return _ia_response(req, {"detail": "Failed to parse LLM response"}, 500)

        if not raw_content:
            log_content.append(
                f"[{ts()}] ERROR [analyse_insights] LLM returned empty content"
            )
            upload_log_to_blob(log_content, "analyse_insights")
            return _ia_response(req, {"detail": "LLM returned no content"}, 500)

        clean = raw_content.strip()
        if clean.startswith("```"):
            clean = clean.split("```", 2)[1]
            if clean.startswith("json"):
                clean = clean[4:]
            clean = clean.rsplit("```", 1)[0].strip()

        try:
            parsed = json.loads(clean)
        except json.JSONDecodeError as json_err:
            log_content.append(
                f"[{ts()}] ERROR [analyse_insights] JSON parse failed: {json_err} | "
                f"raw={raw_content[:500]}"
            )
            upload_log_to_blob(log_content, "analyse_insights")
            return _ia_response(req, {"detail": f"LLM returned invalid JSON: {str(json_err)}"}, 500)

        summary  = parsed.get("summary") or "No summary was generated."
        findings = parsed.get("findings") or []
        if not isinstance(findings, list):
            findings = []
        findings = [str(f) for f in findings if f]

        # ── 4. Citations: what the model says it used, checked against the
        # excerpts it was actually given. Unknown references are dropped.
        cited_refs = []
        for ref in (parsed.get("citations") or []):
            ref = str(ref).strip().strip("[]").upper()
            if ref in refs and ref not in cited_refs:
                cited_refs.append(ref)
        cited_rulings = [refs[ref] for ref in cited_refs[:IA_MAX_CITATIONS]]
        if not cited_rulings:
            # Model named none: show the top-ranked excerpts, which are at
            # least inside the question's scope.
            cited_rulings = context[:6]
            log_content.append(
                f"[{ts()}] WARN  [analyse_insights] model cited no valid references — "
                f"showing top-ranked excerpts"
            )
        citations = [
            {
                "ruling_id": r.get("id"),
                "title":     r.get("title"),
                "year":      str(r.get("decision_date") or "")[:4] or None,
                "outcome":   r.get("decision_outcome"),
            }
            for r in cited_rulings if r.get("title")
        ]

        # Confidence follows how much published precedent is in scope, and is
        # low whenever the fallback sample had to be used.
        n_published = stats["overall"]["published"]
        if selection_basis != "relevance" or period_empty:
            # Fallback sample, or the period asked about holds no rulings: the
            # question as asked cannot be answered with confidence.
            confidence = "low"
        elif n_published >= 20:
            confidence = "high"
        elif n_published >= 5:
            confidence = "moderate"
        else:
            confidence = "low"

        payload = {
            "summary":            summary,
            "findings":           findings,
            # Always the computed series over every ruling in scope — never
            # the model's own count.
            "trend_data":         _ia_trend(matched),
            "rulings_analysed":   len(matched),
            "rulings_matched":    len(matched),
            "rulings_in_context": len(context),
            "rulings_total":      total_rulings,
            "citations":          citations,
            "confidence":         confidence,
            "selection_basis":    selection_basis,
            "session_context":    session_context or None,
            "scope":              scope,
        }

        log_content.append(
            f"[{ts()}] INFO  [analyse_insights] Complete | "
            f"findings={len(findings)} | citations={len(citations)} | "
            f"confidence={confidence} | total_time={time.time() - start_time:.2f}s"
        )
        upload_log_to_blob(log_content, "analyse_insights")
        return _ia_response(req, payload)

    except Exception as e:
        log_content.append(
            f"[{ts()}] ERROR [analyse_insights] {e}\n{traceback.format_exc()}"
        )
        upload_log_to_blob(log_content, "analyse_insights")
        return _ia_response(req, {"error": "Internal Server Error", "detail": str(e)}, 500)

# -----------------------------------------------------------------------------
# POST /api/readiness/assess
# -----------------------------------------------------------------------------
# Precedent assessment ("Readiness check") for ONE research question.
#
# Request JSON:
#   {
#     "question":     "Why are conditional approvals granted in heart failure?",
#     "session_name": "Sacubitril/valsartan - line extension",   (optional)
#     "therapy_area": "Cardiology",                              (optional)
#     "context":      "drug / indication / comparator notes",    (optional)
#     "ruling_ids":   ["..."],                                   (optional)
#     "answers": [
#        {"question": "...", "answer": "...",
#         "dossier_code": "FT" | "FE" | "BIA" | a stored value | a label,
#         "status": "ready" | "needs_evidence" | "draft",
#         "importance": "high" | "medium" | "low"}
#     ]
#   }
#
# Design rules:
#   1. Counts are computed in code, never by the model.
#   2. Comparable rulings are selected in code; the model only reads excerpts.
#   3. The score is an ALIGNMENT score against precedent, not a probability of
#      approval, and is never returned without its per-dossier components.
#   4. Citations are checked against the excerpts actually supplied.
#   5. Overall score = answer-weighted average of dossiers that were assessed.
#      A dossier with no answers is "not assessed", not scored.
# -----------------------------------------------------------------------------

RA_MAX_PRECEDENTS   = 30     # rulings given to the model as excerpts
RA_MAX_CHARS        = 450    # characters per text field per excerpt
RA_MAX_ACTIONS      = 6
RA_MAX_ANSWER_CHARS = 700    # per drafted answer sent to the model
RA_MAX_ANSWERS      = 60

_RA_DOSSIERS = {
    "FT":  {"name": "Pharmacotherapeutic Dossier", "focus": "Therapeutic value and comparator",
            "category": "Clinical Value Pharmaco therapeutic"},
    "FE":  {"name": "Pharmacoeconomic Dossier",    "focus": "Cost-effectiveness",
            "category": "Pharmaco-economic"},
    "BIA": {"name": "Budget Impact Dossier",       "focus": "Population and uptake",
            "category": "Budget Impact"},
}

_RA_STATUS_ALIASES = {
    "ready": "ready", "done": "ready",
    "needs_evidence": "needs_evidence",
    "draft": "draft", "not_started": "draft", "": "draft",
}

# Built from DOSSIER_CATEGORY_OPTIONS so this can never drift from the list the
# frontend mirrors. Accepts the code, the stored value, the design label, and
# the "Label (CODE)" form the Q&A generator uses for its group names.
_RA_ALIAS_TO_CODE: Dict[str, str] = {}
for _opt in DOSSIER_CATEGORY_OPTIONS:
    if _opt["code"]:
        _RA_ALIAS_TO_CODE[_opt["code"].lower()]  = _opt["code"]
        _RA_ALIAS_TO_CODE[_opt["value"].lower()] = _opt["code"]
        _RA_ALIAS_TO_CODE[_opt["label"].lower()] = _opt["code"]
        _RA_ALIAS_TO_CODE[f"{_opt['label']} ({_opt['code']})".lower()] = _opt["code"]


def _ra_normalise_code(value: Any) -> Optional[str]:
    """FT / FE / BIA from a code, stored value or label; None if not a dossier."""
    v = str(value or "").strip()
    if not v:
        return None
    low = v.lower()
    # Review modes and uncategorised items never map to a dossier component.
    if low == "no category" or low == CROSS_DOSSIER_REVIEW.lower() or "cross" in low:
        return None
    code = _RA_ALIAS_TO_CODE.get(low)
    if code:
        return code
    # Fallback for unexpected free text.
    if "budget" in low:
        return "BIA"
    if "economic" in low:
        return "FE"
    if "therapeutic" in low or "clinical" in low:
        return "FT"
    return None


def _ra_band(score: Optional[int]) -> str:
    """Band used by the UI tags: strong=green, partial=amber, weak=red.

    The score is the share of answers marked Ready, so bands read as
    completion levels."""
    if score is None:
        return "not_assessed"
    if score >= 70:
        return "strong"
    if score >= 50:
        return "partial"
    return "weak"


def _ra_clamp(value: Any) -> Optional[int]:
    try:
        return max(0, min(100, int(round(float(value)))))
    except (TypeError, ValueError):
        return None

def _ra_ready_pct(ready: int, total: int) -> Optional[int]:
    """Ready answers as a whole-number percentage of the dossier's answers.

    Computed in code, never by the model. None when the dossier has no
    answers, so it is shown as "not assessed" rather than a misleading 0%.
    """
    return round(ready / total * 100) if total else None

def _ra_select_precedents(question: str, context: str, rulings: List[Dict[str, Any]],
                          ruling_ids: List[str], therapy_area: str) -> tuple:
    """Returns (precedents, basis). A user-picked set is never re-filtered."""
    if ruling_ids:
        wanted = set(ruling_ids)
        chosen = [r for r in rulings if r.get("id") in wanted]
        if chosen:
            return chosen[:RA_MAX_PRECEDENTS], "user_selection"

    pool = rulings
    if therapy_area:
        corpus_areas = sorted({
            str(r.get("therapy_area") or "").strip()
            for r in rulings if r.get("therapy_area")
        })
        areas = _ia_detect_areas(therapy_area, corpus_areas)
        if areas:
            keys = {a.lower() for a in areas}
            scoped = [r for r in rulings if _ia_area_of(r) in keys]
            if scoped:
                pool = scoped

    stems = _ia_stems(f"{question} {context}")
    ranked = sorted(
        pool,
        key=lambda r: (_ia_relevance(stems, r), str(r.get("decision_date") or "")),
        reverse=True,
    )
    top = [r for r in ranked if _ia_relevance(stems, r) > 0][:RA_MAX_PRECEDENTS]
    if top:
        return top, "relevance"
    return ranked[:RA_MAX_PRECEDENTS], "recency_fallback"


@app.function_name(name="assess_readiness")
@app.route(
    route="readiness/assess",
    methods=["POST", "OPTIONS"],
    auth_level=func.AuthLevel.ANONYMOUS,
)
def assess_readiness(req: func.HttpRequest) -> func.HttpResponse:
    log_content = []
    try:
        start_time = time.time()
        log_content.append(f"[{ts()}] INFO  [assess_readiness] invoked | method={req.method}")

        if req.method == "OPTIONS":
            upload_log_to_blob(log_content, "assess_readiness")
            return func.HttpResponse("", status_code=204, headers=_cors_preflight_headers(req))

        try:
            body = req.get_json()
        except ValueError:
            upload_log_to_blob(log_content, "assess_readiness")
            return _ia_response(req, {"detail": "Invalid JSON body"}, 400)

        question     = (body.get("question") or "").strip()
        session_name = (body.get("session_name") or "").strip()
        context      = (body.get("context") or "").strip()
        therapy_area = (body.get("therapy_area") or "").strip()
        ruling_ids   = [r for r in (body.get("ruling_ids") or []) if r]
        raw_answers  = body.get("answers") or []

        if not question:
            upload_log_to_blob(log_content, "assess_readiness")
            return _ia_response(req, {"detail": "question must not be empty"}, 400)
        if not isinstance(raw_answers, list) or not raw_answers:
            upload_log_to_blob(log_content, "assess_readiness")
            return _ia_response(req, {
                "detail": "answers must be a non-empty list of drafted questions/answers"
            }, 400)

        missing = require_settings("BEDROCK_MODEL")
        if missing or bedrock_client is None:
            upload_log_to_blob(log_content, "assess_readiness")
            return _ia_response(req, {"detail": missing or "Bedrock client is not configured"}, 503)

        # ── 1. Normalise answers; compute counts in code ──────────────────
        answers: List[Dict[str, Any]] = []
        for a in raw_answers[:RA_MAX_ANSWERS]:
            if not isinstance(a, dict):
                continue
            raw_status = str(a.get("status") or "").strip().lower().replace(" ", "_").replace("-", "_")
            answers.append({
                "id":         f"A{len(answers) + 1}",
                "question":   str(a.get("question") or "").strip(),
                "answer":     str(a.get("answer") or "").strip(),
                "dossier":    _ra_normalise_code(a.get("dossier_code") or a.get("dossier_category")),
                "status":     _RA_STATUS_ALIASES.get(raw_status, "draft"),
                "importance": str(a.get("importance") or "").strip().lower() or None,
            })

        counts = {"total": len(answers), "ready": 0, "needs_evidence": 0, "draft": 0}
        by_dossier_counts: Dict[str, Dict[str, int]] = {
            c: {"total": 0, "ready": 0, "needs_evidence": 0, "draft": 0} for c in _RA_DOSSIERS
        }
        unclassified = 0
        for a in answers:
            counts[a["status"]] += 1
            if a["dossier"]:
                by_dossier_counts[a["dossier"]]["total"] += 1
                by_dossier_counts[a["dossier"]][a["status"]] += 1
            else:
                unclassified += 1

        log_content.append(
            f"[{ts()}] INFO  [assess_readiness] question='{question[:100]}' | "
            f"answers={counts} | unclassified={unclassified} | ruling_ids={len(ruling_ids)}"
        )

        # ── 2. Precedent set, selected in code ────────────────────────────
        rulings = read_neo4j()
        precedents, basis = _ra_select_precedents(question, context, rulings, ruling_ids, therapy_area)
        if not precedents:
            upload_log_to_blob(log_content, "assess_readiness")
            return _ia_response(req, {
                "question": question, "session_name": session_name or None,
                "overall": {"score": None, "band": "not_assessed", "out_of": 100,
                            "assessed_answers": 0,
                            "note": "Alignment score against precedent, not a probability of approval."},
                "counts": counts, "unclassified_answers": unclassified,
                "dossiers": [], "actions": [],
                "precedent": {"count": 0, "published": 0, "basis": basis,
                              "conditional": 0, "negative": 0, "positive": 0},
                "message": "No comparable rulings were found, so readiness cannot be assessed.",
                "confidence": "low",
            })

        stats = _ia_stats(precedents, by_area=False)["overall"]
        pub = stats["published"]
        precedent_summary = {
            "count":           len(precedents),
            "published":       pub,
            "basis":           basis,
            "conditional_pct": stats["conditional_pct"],
            "negative_pct":    stats["negative_pct"],
            "positive_pct":    stats["positive_pct"],
            "conditional":     stats["conditional"],
            "negative":        stats["negative"],
            "positive":        stats["positive"],
        }

        refs = {f"R{i + 1}": r for i, r in enumerate(precedents)}
        precedent_text = "\n\n---\n\n".join(
            f"[{ref}]\n"
            f"Title: {r.get('title') or 'N/A'}\n"
            f"Therapy: {r.get('therapy_area') or 'Unknown'} | "
            f"Outcome: {r.get('decision_outcome') or 'Unknown'} | "
            f"Dossier: {r.get('dossier_category') or 'Unknown'} | "
            f"Date: {str(r.get('decision_date') or '')[:7]}\n"
            f"{_ruling_facts(r)}\n"
            f"Summary: {(r.get('summary') or '')[:RA_MAX_CHARS]}\n"
            f"Comparator: {(r.get('comparator') or '')[:RA_MAX_CHARS]}\n"
            f"Cost-Effectiveness: {(r.get('cost_effectiveness') or '')[:RA_MAX_CHARS]}\n"
            f"Budget Impact: {(r.get('budget_impact') or '')[:RA_MAX_CHARS]}\n"
            f"Text excerpt: {(r.get('full_text') or '')[:RA_MAX_CHARS]}"
            for ref, r in refs.items()
        )

        answers_text = "\n\n".join(
            f"[{a['id']}] dossier={a['dossier'] or 'UNCLASSIFIED'} | status={a['status']} | "
            f"importance={a['importance'] or 'n/a'}\n"
            f"Q: {a['question'][:400]}\n"
            f"A: {(a['answer'] or '(no answer drafted)')[:RA_MAX_ANSWER_CHARS]}"
            for a in answers
        )

        dossier_lines = "\n".join(
            f"- {code}: {d['name']} ({d['focus']}) - {by_dossier_counts[code]['total']} answer(s)"
            for code, d in _RA_DOSSIERS.items()
        )

        prompt = f"""You are a senior HTA reviewer assessing how well a submitter's drafted answers align
        with what Zorginstituut Nederland (ZIN) precedent expects.

        RESEARCH QUESTION: "{question}"
        SESSION: {session_name or 'n/a'}
        SUBMITTER CONTEXT: {context or 'None provided.'}

        PRECEDENT SET: {len(precedents)} comparable ZIN rulings ({basis}). Computed outcome mix over
        {pub} published decisions: {stats['conditional_pct']}% conditional, {stats['negative_pct']}% negative,
        {stats['positive_pct']}% positive. These figures are exact; do not recompute them.

        DOSSIER TYPES:
        {dossier_lines}

        PRECEDENT EXCERPTS (reference each as e.g. R3):
        {precedent_text}

        SUBMITTER'S DRAFTED ANSWERS (reference each as e.g. A2):
        {answers_text}

        TASK
        For EACH dossier type that has at least one answer:
        1. precedent_expects: one sentence on what the precedent set shows ZIN expects.
        2. gap: one or two sentences on the specific shortfall in the submitter's answers, naming
            answer ids (A1, A2 ...) where relevant, or "None." if there is no gap.
        3. citations: reference ids (R..) of the rulings supporting "precedent_expects".
        Do NOT output a score. Scores are calculated separately from answer statuses.
        For a dossier type with NO answers, return it with gap "No answers drafted."

        Then give "actions": up to {RA_MAX_ACTIONS} recommended actions, most important first. Each has:
        - title (imperative, specific), dossier ("FT"|"FE"|"BIA"), detail (1-3 sentences),
        - answer_ids: the answers it affects, citations: supporting R.. ids.
        Do NOT estimate points or numeric impact.

        STRICT RULES
        - Base everything on the excerpts and answers above. Do not invent rulings, figures or guidelines.
        - Never state a count or percentage that is not given above or visible in the answers.
        - If the precedent is thin (under 5 published decisions) say so in "caveat".
        - Return ONLY valid JSON, no markdown fences.

        {{
        "dossiers": [
            {{"code": "FT", "precedent_expects": "", "gap": "", "citations": ["R1"]}}
        ],
        "actions": [
            {{"title": "", "dossier": "FT", "detail": "", "answer_ids": ["A1"], "citations": ["R1"]}}
        ],
        "caveat": ""
        }}"""

        system_message = (
            "You are an expert HTA reviewer for Zorginstituut Nederland. "
            "Return ONLY valid JSON as instructed. No markdown, no commentary."
        )
        bedrock_request = {
            "modelId":  BEDROCK_MODEL,
            "system":   [{"text": system_message}],
            "messages": [{"role": "user", "content": [{"text": prompt}]}],
            "inferenceConfig": {"temperature": 0, "maxTokens": 6000},
        }

        llm_start = time.time()
        try:
            resp = bedrock_client.converse(**bedrock_request)
        except Exception as bedrock_err:
            log_content.append(f"[{ts()}] ERROR [assess_readiness] Bedrock failed: {bedrock_err}")
            upload_log_to_blob(log_content, "assess_readiness")
            return _ia_response(req, {"detail": f"LLM call failed: {str(bedrock_err)}"}, 500)
        log_content.append(
            f"[{ts()}] INFO  [assess_readiness] Bedrock completed | {time.time()-llm_start:.2f}s"
        )

        try:
            raw_content = resp["output"]["message"]["content"][0]["text"]
        except (KeyError, IndexError, TypeError):
            raw_content = None
        if not raw_content:
            upload_log_to_blob(log_content, "assess_readiness")
            return _ia_response(req, {"detail": "LLM returned no content"}, 500)

        clean = raw_content.strip()
        if clean.startswith("```"):
            clean = clean.split("```", 2)[1]
            if clean.startswith("json"):
                clean = clean[4:]
            clean = clean.rsplit("```", 1)[0].strip()
        try:
            parsed = json.loads(clean)
        except json.JSONDecodeError as json_err:
            log_content.append(
                f"[{ts()}] ERROR [assess_readiness] JSON parse failed: {json_err} | raw={raw_content[:500]}"
            )
            upload_log_to_blob(log_content, "assess_readiness")
            return _ia_response(req, {"detail": f"LLM returned invalid JSON: {str(json_err)}"}, 500)

        # ── 3. Validate and assemble ──────────────────────────────────────
        def _cites(values) -> List[Dict[str, Any]]:
            out, seen = [], set()
            for v in (values or []):
                ref = str(v).strip().strip("[]").upper()
                if ref in refs and ref not in seen:
                    seen.add(ref)
                    r = refs[ref]
                    out.append({
                        "ruling_id": r.get("id"),
                        "title":     r.get("title"),
                        "year":      str(r.get("decision_date") or "")[:4] or None,
                        "outcome":   r.get("decision_outcome"),
                    })
            return out

        valid_answer_ids = {a["id"] for a in answers}
        model_dossiers = {}
        for d in (parsed.get("dossiers") or []):
            code = _ra_normalise_code(d.get("code"))
            if code and code not in model_dossiers:
                model_dossiers[code] = d

        dossier_rows = []
        for code, meta in _RA_DOSSIERS.items():
            c = by_dossier_counts[code]
            n = c["total"]
            d = model_dossiers.get(code, {})
            # Score = ready / total for this dossier, computed in code.
            score = _ra_ready_pct(c["ready"], n)
            dossier_rows.append({
                "code":              code,
                "name":              meta["name"],
                "focus":             meta["focus"],
                "score":             score,
                "band":              _ra_band(score),
                "answers":           c,
                "precedent_expects": (d.get("precedent_expects") or "").strip() if n > 0 else "",
                "gap":               ((d.get("gap") or "").strip() or "None.") if n > 0
                                     else "No answers drafted.",
                "citations":         _cites(d.get("citations")) if n > 0 else [],
            })

        # Overall = ready answers across the three dossiers / classified answers.
        # Answers that could not be mapped to a dossier are excluded, as before.
        classified_total = sum(by_dossier_counts[c]["total"] for c in _RA_DOSSIERS)
        classified_ready = sum(by_dossier_counts[c]["ready"] for c in _RA_DOSSIERS)
        overall_score = _ra_ready_pct(classified_ready, classified_total)
        weight_total = classified_total   # used below for the confidence rule

        actions = []
        for a in (parsed.get("actions") or []):
            title = (a.get("title") or "").strip()
            if not title:
                continue
            code = _ra_normalise_code(a.get("dossier"))
            actions.append({
                "title":        title,
                "dossier":      code,
                "dossier_name": _RA_DOSSIERS[code]["name"] if code else None,
                "detail":       (a.get("detail") or "").strip(),
                "answer_ids":   [x for x in (a.get("answer_ids") or []) if x in valid_answer_ids],
                "citations":    _cites(a.get("citations")),
            })
        # Order is the model's order (most important first); no points to sort by.
        actions = actions[:RA_MAX_ACTIONS]
        for i, a in enumerate(actions, start=1):
            a["rank"] = i

        if basis == "recency_fallback" or weight_total == 0:
            confidence = "low"
        elif pub >= 20 and counts["total"] >= 10:
            confidence = "high"
        elif pub >= 5:
            confidence = "moderate"
        else:
            confidence = "low"

        payload = {
            "question":     question,
            "session_name": session_name or None,
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "overall": {
                "score":            overall_score,
                "band":             _ra_band(overall_score),
                "out_of":           100,
                "assessed_answers": weight_total,
                "ready":            classified_ready,
                "total":            classified_total,
                "note": "Share of drafted answers marked Ready. Not a probability of approval.",
            },
            "counts":               counts,
            "unclassified_answers": unclassified,
            "dossiers":             dossier_rows,
            "actions":              actions,
            "precedent":            precedent_summary,
            "headline": (
                f"{counts['ready']} of {counts['total']} answers ready. "
                f"{counts['needs_evidence']} need evidence attached. "
                f"Comparable decisions: {precedent_summary['conditional']} conditional, "
                f"{precedent_summary['negative']} negative, {precedent_summary['positive']} positive "
                f"of {pub} published."
            ),
            "caveat":     (parsed.get("caveat") or "").strip() or None,
            "confidence": confidence,
        }

        log_content.append(
            f"[{ts()}] INFO  [assess_readiness] Complete | overall={overall_score} | "
            f"actions={len(actions)} | confidence={confidence} | total={time.time()-start_time:.2f}s"
        )
        upload_log_to_blob(log_content, "assess_readiness")
        return _ia_response(req, payload)

    except Exception as e:
        log_content.append(f"[{ts()}] ERROR [assess_readiness] {e}\n{traceback.format_exc()}")
        upload_log_to_blob(log_content, "assess_readiness")
        return _ia_response(req, {"error": "Internal Server Error", "detail": str(e)}, 500)