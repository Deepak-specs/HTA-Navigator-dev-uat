import sys, warnings; warnings.filterwarnings("ignore")
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
from hta_ingest.config import Settings
from neo4j import GraphDatabase
s = Settings.from_env()
d = GraphDatabase.driver(s.neo4j_uri, auth=(s.neo4j_user, s.neo4j_password))

TESTS = [
("1. corpus completeness", """
MATCH (t:TranslatedDocuments)
RETURN t.status AS status, count(*) AS documents ORDER BY status"""),

("2. node counts line up", """
MATCH (t:TranslatedDocuments) WITH count(t) AS translated
MATCH (s:SummaryDocuments)    WITH translated, count(s) AS summaries
MATCH (p:DocumentPages)       RETURN translated, summaries, count(p) AS pages"""),

("3. integrity - all should be 0", """
MATCH (t:TranslatedDocuments) WHERE t.status='SUMMARISED' AND NOT (t)-[:HAS_SUMMARY]->()
WITH count(t) AS summarised_without_summary
MATCH (s:SummaryDocuments) WHERE NOT ()-[:HAS_SUMMARY]->(s)
RETURN summarised_without_summary, count(s) AS orphan_summaries"""),

("4. every summary on the current prompt", """
MATCH (s:SummaryDocuments) RETURN s.prompt_version AS version, count(*) AS n ORDER BY version"""),

("5. text available for indexing", """
MATCH (t:TranslatedDocuments)-[:HAS_PAGES]->(p:DocumentPages)
RETURN count(*) AS documents,
       sum(size(p.pages_en)) AS pages_total,
       sum(size([x IN p.pages_en WHERE trim(x) <> ''])) AS pages_with_text"""),

("6. PICO + document_type coverage", """
MATCH (s:SummaryDocuments)
RETURN s.document_type AS document_type, s.pico_stated AS pico, count(*) AS n
ORDER BY document_type, pico"""),

("7. summaries the UI would render thin", """
MATCH (s:SummaryDocuments)
RETURN sum(CASE WHEN s.title     IS NULL OR s.title=''     THEN 1 ELSE 0 END) AS no_title,
       sum(CASE WHEN s.summary   IS NULL OR s.summary=''   THEN 1 ELSE 0 END) AS no_summary,
       sum(CASE WHEN s.therapy_area IS NULL                THEN 1 ELSE 0 END) AS no_area,
       sum(CASE WHEN s.decision_outcome IS NULL            THEN 1 ELSE 0 END) AS no_outcome"""),

("8. API filename join (search citations depend on this)", """
MATCH (n:TranslatedDocuments)
WITH n, apoc.convert.fromJsonMap(n.rawJson) AS raw
RETURN count(*) AS documents,
       count(raw.metadata) AS have_metadata,
       sum(CASE WHEN apoc.text.regexGroups(raw.metadata, "'name':\\s*'([^']+)'")[0][1] = n.blob_name
                THEN 1 ELSE 0 END) AS name_matches_blob"""),
]

with d.session(database=s.neo4j_database) as ses:
    for title, q in TESTS:
        print(f"\n--- {title}")
        try:
            for r in ses.run(q):
                print("   " + "  ".join(f"{k}={r[k]}" for k in r.keys()))
        except Exception as e:
            print("   ERROR:", str(e)[:150])
d.close()
