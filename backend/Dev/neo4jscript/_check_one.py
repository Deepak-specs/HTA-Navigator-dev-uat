"""Read-only: show what a document ended up with in Neo4j."""
import sys
from hta_ingest.config import Settings
from neo4j import GraphDatabase
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
frag = sys.argv[1]
s = Settings.from_env()
d = GraphDatabase.driver(s.neo4j_uri, auth=(s.neo4j_user, s.neo4j_password))
q = """
MATCH (t:TranslatedDocuments)-[:HAS_SUMMARY]->(x:SummaryDocuments)
WHERE t.blob_name CONTAINS $f
RETURN t.status AS status, t.page_count AS pages, x.title AS title,
       x.therapy_area AS area, x.decision_outcome AS outcome,
       x.dossier_categories AS cats, x.document_type AS dtype,
       x.pico_stated AS pico, x.prompt_version AS pv,
       x.indication AS indication, x.annual_cost AS cost,
       left(x.summary, 600) AS summary
"""
with d.session(database=s.neo4j_database) as ses:
    for r in ses.run(q, f=frag):
        for k in r.keys():
            v = r[k]
            print(f"{k:<11}: {v}")
d.close()
