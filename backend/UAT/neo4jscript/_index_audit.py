"""Read-only: which Neo4j documents are missing from the search index?"""
import sys, os, tomllib, warnings
warnings.filterwarnings("ignore")
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
from hta_ingest.config import Settings
from neo4j import GraphDatabase
from azure.search.documents import SearchClient
from azure.core.credentials import AzureKeyCredential

cfg_path = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "config.toml"))
cfg = tomllib.load(open(cfg_path, "rb")); flat = {}
def w(d):
    for k, v in d.items(): w(v) if isinstance(v, dict) else flat.__setitem__(k, v)
w(cfg)

s = Settings.from_env()
drv = GraphDatabase.driver(s.neo4j_uri, auth=(s.neo4j_user, s.neo4j_password))
with drv.session(database=s.neo4j_database) as ses:
    expected = {r["blob"]: r["n"] for r in ses.run("""
        MATCH (t:TranslatedDocuments)-[:HAS_PAGES]->(p:DocumentPages)
        RETURN t.blob_name AS blob,
               size([x IN p.pages_en WHERE trim(x) <> '']) AS n""")}
drv.close()

sc = SearchClient(endpoint=flat["search_endpoint"], index_name=flat["index_name"],
                  credential=AzureKeyCredential(flat["search_key"]))
actual = {}
for r in sc.search(search_text="*", select=["source"], top=100000):
    actual[r["source"]] = actual.get(r["source"], 0) + 1

print(f"Neo4j documents with English text : {sum(1 for v in expected.values() if v):,}")
print(f"expected chunks                   : {sum(expected.values()):,}")
print(f"index sources                     : {len(actual):,}")
print(f"index chunks                      : {sum(actual.values()):,}")

missing  = {b: n for b, n in expected.items() if n and actual.get(b, 0) == 0}
partial  = {b: (n, actual[b]) for b, n in expected.items() if n and 0 < actual.get(b, 0) < n}
notext   = [b for b, n in expected.items() if not n]
print(f"\nMISSING entirely : {len(missing)}")
for b, n in list(missing.items())[:10]: print(f"   {n:>4} pages  {b[:84]}")
print(f"PARTIAL          : {len(partial)}")
for b, (e, a) in list(partial.items())[:10]: print(f"   {a}/{e}  {b[:80]}")
print(f"no English text  : {len(notext)}")
for b in notext[:10]: print(f"   {b[:84]}")
