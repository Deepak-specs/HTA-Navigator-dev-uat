"""
graph.py
========
Everything that touches Neo4j.

Nodes written (labels and ids kept from the POC so function_app.py works unchanged):

  (:DocumentPages {id, pages_nl, pages_en})          per-page text, translation cache
      <-[:HAS_PAGES]-
  (:TranslatedDocuments {id, blob_name, sha256, ..., rawJson})
      -[:HAS_SUMMARY]->
  (:SummaryDocuments {id (same as translated), <21 API fields>, rawJson, ...})

Page text lives on its own node on purpose: function_app.py's dossier Q&A
builds its prompt from str(<TranslatedDocuments node>)[:8000], so that node
must stay small and its main content must be the English rawJson.

TranslatedDocuments.rawJson keeps the POC shape:
  {"extracted_text": "<English text>", "metadata": "{'name': '<blob name>', ...}"}
because function_app.py recovers the file name with
  apoc.text.regexGroups(raw.metadata, "'name':\\s*'([^']+)'")
New code should read TranslatedDocuments.blob_name instead.
"""
from __future__ import annotations

import json
import logging
import uuid
from datetime import datetime, timezone

from .config import PIPELINE_VERSION, PROMPT_VERSION, TRANSLATION_VERSION, Settings
from .summary_schema import API_FIELDS, NEW_FIELDS

log = logging.getLogger("hta.graph")

# Fixed namespace: ids depend only on the blob name, so rebuilding Neo4j from the
# dev storage account later produces the same ids (and the same UI links).
ID_NAMESPACE = uuid.UUID("5b0f1c9e-4a57-4d8e-9f4b-2c1d8e7a6f30")


def doc_id_for(blob_name: str) -> str:
    return str(uuid.uuid5(ID_NAMESPACE, blob_name))


def legacy_metadata_string(blob_name: str, container: str, sha256: str | None,
                           source_url: str | None) -> str:
    """Python-dict-style string, as the POC stored it, so the API regex still matches."""
    def q(v):
        return "None" if v is None else "'" + str(v).replace("'", "%27") + "'"
    return ("{'name': %s, 'container': %s, 'sha256': %s, 'source_url': %s}"
            % (q(blob_name), q(container), q(sha256), q(source_url)))


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class GraphStore:
    def __init__(self, settings: Settings):
        settings.require("neo4j_uri", "neo4j_user", "neo4j_password")
        from neo4j import GraphDatabase

        self.database = settings.neo4j_database
        self.driver = GraphDatabase.driver(
            settings.neo4j_uri, auth=(settings.neo4j_user, settings.neo4j_password))
        self.driver.verify_connectivity()
        log.info("connected to Neo4j %s (db=%s)", settings.neo4j_uri, self.database)

    def close(self) -> None:
        self.driver.close()

    def _read(self, cypher: str, **params) -> list[dict]:
        records, _, _ = self.driver.execute_query(
            cypher, params, database_=self.database, routing_="r")
        return [r.data() for r in records]

    def _write(self, cypher: str, **params) -> None:
        self.driver.execute_query(cypher, params, database_=self.database)

    # ------------------------------------------------------------------ #
    def check_schema(self) -> list[str]:
        rows = self._read("SHOW CONSTRAINTS YIELD name RETURN collect(name) AS names")
        have = set(rows[0]["names"]) if rows else set()
        need = {"hta_translated_id", "hta_summary_id", "hta_translated_blob", "hta_pages_id"}
        return sorted(need - have)

    def load_state(self) -> dict[str, dict]:
        """Small per-document state for change detection (no large text properties)."""
        rows = self._read(
            """
            MATCH (t:TranslatedDocuments) WHERE t.blob_name IS NOT NULL
            OPTIONAL MATCH (t)-[:HAS_SUMMARY]->(s:SummaryDocuments)
            RETURN t.blob_name AS blob_name, t.id AS id, t.sha256 AS sha256,
                   t.status AS status, t.translation_sha256 AS translation_sha256,
                   t.translation_version AS translation_version,
                   s.prompt_version AS prompt_version
            """)
        return {r["blob_name"]: r for r in rows}

    def load_cached_translation(self, doc_id: str, sha256: str) -> list[str] | None:
        rows = self._read(
            """
            MATCH (:TranslatedDocuments {id: $id})-[:HAS_PAGES]->(p:DocumentPages)
            WHERE p.translation_sha256 = $sha AND p.translation_version = $tv
            RETURN p.pages_en AS pages_en
            """, id=doc_id, sha=sha256, tv=TRANSLATION_VERSION)
        return rows[0]["pages_en"] if rows and rows[0]["pages_en"] else None

    # ------------------------------------------------------------------ #
    def write_translation(self, *, doc_id: str, meta, container: str, sha256: str,
                          pages_nl: list[str], pages_en: list[str], page_count: int,
                          low_text_pages: list[int]) -> None:
        extracted_text = "\n\n".join(p for p in pages_en if p.strip())
        raw_json = json.dumps({
            "extracted_text": extracted_text,
            "metadata": legacy_metadata_string(meta.blob_name, container, sha256, meta.source_url),
            "number_format": "nl",   # amounts are kept exactly as in the Dutch source
        }, ensure_ascii=False)
        props = {
            "blob_name": meta.blob_name,
            "container": container,
            "sha256": sha256,
            "source_url": meta.source_url,
            "source_page": meta.source_page,
            "title_nl": meta.title,
            "doc_issued": meta.doc_issued,
            "doc_modified": meta.doc_modified,
            "information_type": meta.information_type,
            "first_seen": meta.first_seen,
            "page_count": page_count,
            "low_text_pages": low_text_pages,
            "rawJson": raw_json,
            "translation_sha256": sha256,
            "translation_version": TRANSLATION_VERSION,
            "translated_at": _now(),
            "pipeline_version": PIPELINE_VERSION,
            "status": "TRANSLATED",
            "failed_stage": None,
            "error": None,
        }
        self._write(
            """
            MERGE (t:TranslatedDocuments {id: $id})
            SET t += $props, t.updatedAt = datetime()
            MERGE (p:DocumentPages {id: $id})
            SET p.pages_nl = $pages_nl, p.pages_en = $pages_en,
                p.translation_sha256 = $sha, p.translation_version = $tv,
                p.updatedAt = datetime()
            MERGE (t)-[:HAS_PAGES]->(p)
            """, id=doc_id, props=props, pages_nl=pages_nl, pages_en=pages_en,
            sha=sha256, tv=TRANSLATION_VERSION)

    def write_summary(self, *, doc_id: str, summary: dict, model: str | None) -> None:
        raw = {k: summary.get(k) for k in API_FIELDS + NEW_FIELDS}
        raw["id"] = doc_id
        props = {k: summary.get(k) for k in API_FIELDS + NEW_FIELDS if k != "id"}
        props.update({
            "rawJson": json.dumps(raw, ensure_ascii=False),
            "model": model,
            "prompt_version": PROMPT_VERSION,
            "pipeline_version": PIPELINE_VERSION,
            "summarised_at": _now(),
        })
        self._write(
            """
            MATCH (t:TranslatedDocuments {id: $id})
            MERGE (s:SummaryDocuments {id: $id})
            SET s += $props, s.updatedAt = datetime()
            MERGE (t)-[:HAS_SUMMARY]->(s)
            SET t.status = 'SUMMARISED', t.failed_stage = null, t.error = null,
                t.updatedAt = datetime()
            """, id=doc_id, props=props)

    def mark_status(self, *, doc_id: str, meta, container: str, status: str,
                    stage: str | None = None, error: str | None = None,
                    sha256: str | None = None) -> None:
        """Record FAILED / NEEDS_OCR without touching an existing good translation."""
        self._write(
            """
            MERGE (t:TranslatedDocuments {id: $id})
            ON CREATE SET t.blob_name = $blob, t.container = $container,
                          t.source_url = $source_url, t.title_nl = $title,
                          t.doc_issued = $issued, t.sha256 = $sha,
                          t.rawJson = $raw_json
            SET t.status = $status, t.failed_stage = $stage, t.error = $error,
                t.last_attempt_at = datetime(), t.updatedAt = datetime(),
                t.attempts = coalesce(t.attempts, 0) + 1
            """,
            id=doc_id, blob=meta.blob_name, container=container,
            source_url=meta.source_url, title=meta.title, issued=meta.doc_issued,
            sha=sha256 or meta.sha256, status=status, stage=stage,
            error=(error or "")[:2000] or None,
            raw_json=json.dumps({
                "extracted_text": "",
                "metadata": legacy_metadata_string(meta.blob_name, container,
                                                   sha256 or meta.sha256, meta.source_url),
            }, ensure_ascii=False))
