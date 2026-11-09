// HTA Navigator - Neo4j schema setup (safe to run repeatedly)
// Run with:  python neo4j_admin.py setup
// or paste ONE statement at a time into the Neo4j Query UI.

CREATE CONSTRAINT hta_translated_id IF NOT EXISTS
FOR (t:TranslatedDocuments) REQUIRE t.id IS UNIQUE;

CREATE CONSTRAINT hta_summary_id IF NOT EXISTS
FOR (s:SummaryDocuments) REQUIRE s.id IS UNIQUE;

CREATE CONSTRAINT hta_translated_blob IF NOT EXISTS
FOR (t:TranslatedDocuments) REQUIRE t.blob_name IS UNIQUE;

CREATE CONSTRAINT hta_pages_id IF NOT EXISTS
FOR (p:DocumentPages) REQUIRE p.id IS UNIQUE;

CREATE INDEX hta_translated_status IF NOT EXISTS
FOR (t:TranslatedDocuments) ON (t.status);

CREATE INDEX hta_translated_sha IF NOT EXISTS
FOR (t:TranslatedDocuments) ON (t.sha256);

CREATE INDEX hta_summary_therapy_area IF NOT EXISTS
FOR (s:SummaryDocuments) ON (s.therapy_area);

CREATE INDEX hta_summary_decision_outcome IF NOT EXISTS
FOR (s:SummaryDocuments) ON (s.decision_outcome);

CREATE INDEX hta_summary_decision_date IF NOT EXISTS
FOR (s:SummaryDocuments) ON (s.decision_date);

// PICO presence, so "rulings that state a research question" is an index lookup
CREATE INDEX hta_summary_pico_stated IF NOT EXISTS
FOR (s:SummaryDocuments) ON (s.pico_stated);

CREATE INDEX hta_summary_document_type IF NOT EXISTS
FOR (s:SummaryDocuments) ON (s.document_type);
