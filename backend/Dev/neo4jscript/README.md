# HTA Navigator – ingestion into Neo4j dev

Reads the ZIN crawler's output (PDFs + `.meta.json` files), translates each PDF
from Dutch to English, summarises it, and writes it to Neo4j in the shape the
existing `function_app.py` API already reads.

```
hta_ingest/            the pipeline (extract, translate, summarise, Neo4j)
neo4j/01_setup.cypher  constraints + indexes
neo4j/02_verify.cypher read-only checks
neo4j_admin.py         runs the two Cypher files: check | setup | verify
run_ingest.py          the ingestion CLI
sample_data/           the 3 sample PDFs + meta files, laid out like the crawler's LocalSink
tests/test_offline.py  tests that need no Neo4j and no LLM
```

## Graph model

```
(:DocumentPages {id, pages_nl, pages_en})              per-page text + translation cache
      ^
      | HAS_PAGES
(:TranslatedDocuments {id, blob_name, sha256, status, rawJson, ...})
      |
      | HAS_SUMMARY
      v
(:SummaryDocuments {id, title, therapy_area, decision_outcome, ... rawJson})
```

* `id` is derived from the blob name, so it is the same on every rebuild.
* `TranslatedDocuments.rawJson` keeps the POC shape (`extracted_text` + a `metadata`
  string with `'name': '<blob>'`), so the API's APOC file-name lookup works unchanged.
* `SummaryDocuments` has the 21 fields the API reads, with the POC's allowed values.
  New information is in new fields: `document_type`, `dossier_categories`,
  `decision_outcome_detail` (adds "Not applicable"), `zin_case_number`.
* Page text is on `DocumentPages`, not on `TranslatedDocuments`, because the API's
  dossier Q&A uses `str(node)[:8000]` of the translated node.
* `status` on `TranslatedDocuments`: `TRANSLATED` → `SUMMARISED`, or `FAILED`
  (with `failed_stage`, `error`, `attempts`), or `NEEDS_OCR` (scanned PDF).

---

## Step by step

### Step 1 – Get the code ready

1. Unzip this folder on a machine that can reach the Neo4j dev instance and the
   AI gateway (for the blob-storage steps later it must also pass the storage
   account's firewall – the same place the crawler runs).
2. Copy your crawler's **`zin_sinks.py`** into this folder, next to `run_ingest.py`.
   The pipeline reads storage through it.
3. Create a virtual environment and install:

```bash
python -m venv .venv
.venv\Scripts\activate            # Windows   (Linux/macOS: source .venv/bin/activate)
pip install -r requirements-ingest.txt
```

4. Copy `.env.example` to `.env` and fill in the dev Neo4j credentials and the
   `BEDROCK_*` values (same as in the API's `config.toml`). Leave
   `ZIN_SINK=local` and `ZIN_ROOT=./sample_data` for now.

### Step 2 – Run the offline tests (no network needed)

```bash
python tests/test_offline.py
```

Expect six `PASS` lines. This proves extraction, change detection and the
API-compatible node shape on your three sample PDFs.

### Step 3 – Check the dev instance

```bash
python neo4j_admin.py check
```

Expect Neo4j `2026.06.x`, an APOC version, and `nodes_in_database = 0`.

### Step 4 – Create constraints and indexes

```bash
python neo4j_admin.py setup
python neo4j_admin.py verify
```

`verify` section 1 must list 4 constraints (`hta_pages_id`, `hta_summary_id`,
`hta_translated_blob`, `hta_translated_id`), section 2 ten rows (six indexes plus the four that back the constraints), all `ONLINE`.

*Without Python:* paste the statements from `neo4j/01_setup.cypher` into the
Neo4j Query UI **one at a time** (the UI hides results when several run together).

### Step 5 – Sample run: the 3 PDFs from `sample_data/`

```bash
python run_ingest.py --all --dry-run     # expect 3 lines marked NEW
python run_ingest.py --all
```

Each run writes `ingest_runs/<run-id>.log` and `ingest_runs/<run-id>.json`
(per-document outcome, seconds, LLM calls and tokens). Run it a second time:
it should report `0 need processing`.

### Step 6 – Verify the sample

```bash
python neo4j_admin.py verify
```

Expected:

| Section | Expect |
|---|---|
| 3 status | `SUMMARISED = 3` |
| 4 totals | translated = summaries = has_summary = has_pages = 3 |
| 5 integrity | all 0 |
| 7a node size | no rows |
| 7 API compatibility | `api_lookup_ok = 3`, `mismatches = 0` |

Then check the content in the Query UI:

```cypher
MATCH (t:TranslatedDocuments)-[:HAS_SUMMARY]->(s:SummaryDocuments)
RETURN t.blob_name, s.decision_outcome_detail, s.dossier_categories,
       s.comparator, s.price_per_unit, s.annual_cost, s.summary
```

Acceptance checks:

* **Eculizumab (Soliris):** `price_per_unit` ≈ "€4,600.00 per 300 mg vial … excl. VAT"
  (not €460,000); `dossier_categories` has all three categories.
* **Adalimumab, hidradenitis suppurativa:** summary mentions the 2015 addendum
  (NVDV guideline now treats adalimumab as rational therapy).
* **Adalimumab, plaque psoriasis:** comparators etanercept and infliximab;
  outcome "Positive with Conditions".

### Step 7 – Point the API at dev and test it

In the API's `config.toml` (locally):

* `NEO4J_URI / NEO4J_USER / NEO4J_PASSWORD` → the dev instance
* `CONTAINER_SAS_URL` → a SAS URL for the **`test-1709`** container
  (the API builds PDF links from it)

Run `func start`, then open `http://localhost:7071/api/rulings` (3 rulings) and
`http://localhost:7071/api/rulings/<id>` (includes a working `file_url`).

### Step 8 – First documents from blob storage

In `.env` set `ZIN_SINK=azure` (and run `az login`), then:

```bash
python run_ingest.py --inventory          # meta files vs PDFs in test-1709
python run_ingest.py --all --limit 20 --dry-run
python run_ingest.py --all --limit 20
python neo4j_admin.py verify
```

Review a few summaries (Step 6 queries) and the run manifest: seconds per
document and tokens let you estimate the full load.

### Step 9 – Full corpus

```bash
python run_ingest.py --all --concurrency 3
```

* Safe to stop (Ctrl+C) and re-run – finished documents are skipped.
* Raise `--concurrency` only if the gateway shows no throttling.
* Afterwards: `python neo4j_admin.py verify`; section 6 lists anything
  `FAILED` or `NEEDS_OCR`. Re-running `--all` retries the failures.

### Step 10 – Weekly incremental load

1. Run the crawler (`run_pipeline.py`) – it adds new/updated PDFs and meta files.
2. Run `python run_ingest.py --all` – only NEW and CHANGED documents are processed
   (an updated PDF keeps its id, so UI links stay valid).

### Later – rebuild dev from the dev storage account

1. Recreate the Neo4j dev instance, update `.env`.
2. `python neo4j_admin.py setup`
3. Set `AZURE_STORAGE_ACCOUNT` (and container names) to the dev account.
4. `python run_ingest.py --all` – ids come out identical.

---

## Useful options

| Option | Use |
|---|---|
| `--names <blob> ...` / `--match eculizumab` | specific documents |
| `--force` | reprocess even if up to date |
| `--resummarise` | redo summaries after `PROMPT_VERSION` is bumped (translations reused) |
| `--retranslate` | redo translations after `TRANSLATION_VERSION` is bumped |
| `--retry-ocr` | retry documents marked `NEEDS_OCR` |
| `--manifest-to-sink` | also upload the run manifest to `<json container>/runs/` (needs write access) |

## Troubleshooting

* **"request may be blocked by network rules"** – run from a network the storage
  account allows (where the crawler runs), or use `ZIN_SINK=local`.
* **"Neo4j constraints missing"** – run `python neo4j_admin.py setup`.
* **Throttling** – lower `--concurrency`; botocore already retries with backoff.
* **A document FAILED at `summarise`** – its translation is kept; re-running only
  redoes the summary. The error is in `t.error` and in the run manifest.
