// HTA Navigator - read-only checks after a load
// Run with:  python neo4j_admin.py verify
// or paste ONE statement at a time into the Neo4j Query UI.

// 1. constraints (expect 4)
SHOW CONSTRAINTS YIELD name, labelsOrTypes, properties
WHERE name STARTS WITH 'hta_'
RETURN name, labelsOrTypes, properties ORDER BY name;

// 2. indexes (expect all ONLINE)
SHOW INDEXES YIELD name, state, labelsOrTypes, properties
WHERE name STARTS WITH 'hta_'
RETURN name, state, labelsOrTypes, properties ORDER BY name;

// 3. documents by status (expect everything SUMMARISED)
MATCH (t:TranslatedDocuments)
RETURN t.status AS status, count(*) AS documents ORDER BY status;

// 4. totals (translated = summaries = has_summary = has_pages when all succeed)
CALL () { MATCH (t:TranslatedDocuments) RETURN count(t) AS translated }
CALL () { MATCH (s:SummaryDocuments) RETURN count(s) AS summaries }
CALL () { MATCH (:TranslatedDocuments)-[r:HAS_SUMMARY]->(:SummaryDocuments) RETURN count(r) AS has_summary }
CALL () { MATCH (:TranslatedDocuments)-[r:HAS_PAGES]->(:DocumentPages) RETURN count(r) AS has_pages }
RETURN translated, summaries, has_summary, has_pages;

// 5. integrity problems (expect all 0)
CALL () {
  MATCH (t:TranslatedDocuments {status: 'SUMMARISED'})
  WHERE NOT EXISTS { (t)-[:HAS_SUMMARY]->(s:SummaryDocuments) WHERE s.id = t.id }
  RETURN count(t) AS summarised_without_summary }
CALL () {
  MATCH (s:SummaryDocuments)
  WHERE NOT EXISTS { (t:TranslatedDocuments)-[:HAS_SUMMARY]->(s) WHERE t.id = s.id }
  RETURN count(s) AS orphan_summaries }
CALL () {
  MATCH (t:TranslatedDocuments)-[:HAS_SUMMARY]->(s)
  WITH t, count(s) AS n WHERE n > 1
  RETURN count(t) AS more_than_one_summary }
RETURN summarised_without_summary, orphan_summaries, more_than_one_summary;

// 6. failed / scanned documents
MATCH (t:TranslatedDocuments)
WHERE t.status IN ['FAILED', 'NEEDS_OCR']
RETURN t.blob_name AS blob_name, t.status AS status, t.failed_stage AS stage,
       left(t.error, 200) AS error, t.attempts AS attempts
ORDER BY blob_name LIMIT 50;

// 7a. TranslatedDocuments must stay small: the API's Q&A reads str(node)[:8000] (expect no rows)
MATCH (t:TranslatedDocuments)
UNWIND keys(t) AS k
WITH k, max(size(apoc.convert.toJson(t[k]))) AS max_chars
WHERE max_chars > 2000 AND k <> 'rawJson'
RETURN k AS property, max_chars ORDER BY max_chars DESC;

// 7. API compatibility: the exact file-name lookup function_app.py uses (expect mismatches = 0)
MATCH (n:TranslatedDocuments)
WITH n, apoc.convert.fromJsonMap(n.rawJson) AS raw
WITH n, apoc.text.regexGroups(raw.metadata, "'name':\\s*'([^']+)'")[0][1] AS api_filename
RETURN count(n) AS documents,
       sum(CASE WHEN api_filename = n.blob_name THEN 1 ELSE 0 END) AS api_lookup_ok,
       sum(CASE WHEN api_filename IS NULL OR api_filename <> n.blob_name THEN 1 ELSE 0 END) AS mismatches;

// 8. what the UI will list
MATCH (s:SummaryDocuments)
RETURN s.id AS id, s.title AS title, s.therapy_area AS therapy_area,
       s.decision_outcome AS decision_outcome, s.decision_outcome_detail AS outcome_detail,
       s.decision_date AS decision_date, s.dossier_category AS dossier_category,
       s.dossier_categories AS dossier_categories, s.document_type AS document_type
ORDER BY s.decision_date DESC LIMIT 25;

// 9. price / cost fields to eyeball number conversion
MATCH (s:SummaryDocuments)
WHERE s.price_per_unit IS NOT NULL OR s.annual_cost IS NOT NULL
RETURN s.title AS title, s.price_per_unit AS price_per_unit, s.annual_cost AS annual_cost,
       s.budget_impact AS budget_impact
LIMIT 25;
