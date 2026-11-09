"""Verify the surrogate fix on the failing document, via the real extract path."""
import io, json, os, re, sys
from hta_ingest.extract import extract_pdf
from hta_ingest.translate import _chunk_pages, MARKER
from hta_ingest.source import _long

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
D = os.path.join("pdfs", "zin")
f = [x for x in os.listdir(D) if "elexacaftor-tezacaf-b5b19c5de2" in x][0]
ex = extract_pdf(open(_long(os.path.join(D, f)), "rb").read())

numbered = [(i + 1, t) for i, t in enumerate(ex.pages) if t.strip()]
chunks = _chunk_pages(numbered, 9000)
SUR = re.compile(r"[\ud800-\udfff]")
bad = []
for i, ch in enumerate(chunks, 1):
    body = "\n\n".join(f"{MARKER.format(n=n)}\n{t}" for n, t in ch)
    try:
        json.dumps({"text": body}).encode("utf-8")
        body.encode("utf-8")
    except Exception as e:
        bad.append((i, [n for n, _ in ch], f"{type(e).__name__}: {e}"))
    if SUR.search(body):
        bad.append((i, [n for n, _ in ch], "surrogates still present"))

print(f"pages={ex.page_count}  chunks={len(chunks)}")
print(f"chunks that would fail: {len(bad)}")
for b in bad:
    print("  ", b)
pg = ex.pages[115]   # page 116, 0-based
print("\npage 116 around the formula:")
m = re.search(r"formule", pg)
print("  ", repr(pg[max(0, m.start() - 40):m.start() + 160]) if m else "  (marker not found)")
