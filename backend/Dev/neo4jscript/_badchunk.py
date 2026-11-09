"""Find which translate chunk Bedrock rejects as invalid JSON. Read-only."""
import io, json, os, re, sys, unicodedata
from pypdf import PdfReader
from hta_ingest.translate import _chunk_pages, MARKER
from hta_ingest.source import _long

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
NAME = "2021-04-29__gvs-advies-elexacaftor-tezacaf-b5b19c5de2"
D = os.path.join("pdfs", "zin")
f = [x for x in os.listdir(D) if NAME in x][0]
print("file:", f[:70], "\n")

r = PdfReader(io.BytesIO(open(_long(os.path.join(D, f)), "rb").read()))
pages = [(p.extract_text() or "") for p in r.pages]
numbered = [(i + 1, t) for i, t in enumerate(pages) if t.strip()]
chunks = _chunk_pages(numbered, 9000)
print(f"pages={len(pages)}  non-empty={len(numbered)}  chunks={len(chunks)}\n")

SURROGATE = re.compile(r"[\ud800-\udfff]")
# C0/C1 controls minus tab/newline/carriage-return
CTRL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]")

bad = 0
for i, chunk in enumerate(chunks, 1):
    body = "\n\n".join(f"{MARKER.format(n=n)}\n{t}" for n, t in chunk)
    issues = []
    s = SURROGATE.findall(body)
    if s:
        issues.append(f"{len(s)} lone surrogate(s): {[hex(ord(c)) for c in s[:5]]}")
    c = CTRL.findall(body)
    if c:
        issues.append(f"{len(c)} control char(s): {sorted({hex(ord(x)) for x in c})[:8]}")
    try:
        json.dumps({"text": body}).encode("utf-8")
    except Exception as e:
        issues.append(f"JSON/UTF-8 encode fails: {type(e).__name__}: {e}")
    try:
        body.encode("utf-8")
    except Exception as e:
        issues.append(f"UTF-8 encode fails: {type(e).__name__}: {e}")
    if issues:
        bad += 1
        print(f"CHUNK {i}  pages={[n for n,_ in chunk]}  chars={len(body):,}")
        for x in issues:
            print("   !", x)
        for m in SURROGATE.finditer(body):
            a = max(0, m.start() - 60)
            print("     ctx:", repr(body[a:m.start() + 60]))
            break
        print()

print(f"chunks with issues: {bad}/{len(chunks)}")
