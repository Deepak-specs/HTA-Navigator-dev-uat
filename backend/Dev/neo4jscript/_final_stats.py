"""Read-only: corpus-wide document_type x pico_stated, and the 10 OCR'd documents."""
import sys
from hta_ingest.config import Settings
from neo4j import GraphDatabase
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
s = Settings.from_env()
d = GraphDatabase.driver(s.neo4j_uri, auth=(s.neo4j_user, s.neo4j_password))

OCR = ["omalizumab-xolair","alglucosidase-alfa-myozyme","voedingssupplementen","mirabegron-betmiga",
       "lipegfilgrastim-lonquex","eziclen","amisulpride-aktiprol","oxybutynine-intravesica",
       "niraparib-zejula","relugolix-in-combinatie"]

with d.session(database=s.neo4j_database) as ses:
    print("=== corpus: document_type x pico_stated ===")
    tot = picos = 0
    for r in ses.run("""MATCH (x:SummaryDocuments)
        RETURN x.document_type AS dt, x.pico_stated AS p, count(*) AS n
        ORDER BY dt, p"""):
        print(f"  {str(r['dt']):<30}{str(r['p']):<7}{r['n']:>5}")
        tot += r["n"]
        if r["p"]: picos += r["n"]
    print(f"  {'TOTAL':<30}{'':<7}{tot:>5}    pico_stated=true: {picos} ({picos/tot*100:.1f}%)")

    print("\n=== the 10 OCR'd documents ===")
    print(f"  {'pg':>4} {'type':<26}{'pico':<7}{'outcome':<26}title")
    for frag in OCR:
        for r in ses.run("""MATCH (t:TranslatedDocuments)-[:HAS_SUMMARY]->(x:SummaryDocuments)
            WHERE t.blob_name CONTAINS $f
            RETURN t.page_count AS pg, x.document_type AS dt, x.pico_stated AS p,
                   x.decision_outcome AS o, left(x.title,46) AS title""", f=frag):
            print(f"  {r['pg']:>4} {str(r['dt']):<26}{str(r['p']):<7}{str(r['o']):<26}{r['title']}")
d.close()
