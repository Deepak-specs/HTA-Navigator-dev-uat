"""Sample the mirror for letter-spaced PDF extraction. Read-only."""
import io, os, random, re
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from pypdf import PdfReader

D = os.path.join("pdfs", "zin")
random.seed(7)
sample = random.sample(sorted(os.listdir(D)), 120)

def check(f):
    try:
        r = PdfReader(io.BytesIO(open(os.path.join(D, f), "rb").read()))
        t = "\n".join((p.extract_text() or "") for p in r.pages)
        toks = t.split()
        if not toks:
            return ("EMPTY", 0, 0)
        if sum(1 for x in toks if len(x) == 1) / len(toks) >= 0.5:
            col = " ".join(w for w in (re.sub(r"\s+", "", w) for w in re.split(r"\s{2,}", t)) if w)
            return ("SPACED", len(t), len(col))
        return ("NORMAL", len(t), len(t))
    except Exception:
        return ("ERROR", 0, 0)

with ThreadPoolExecutor(max_workers=10) as ex:
    res = list(ex.map(check, sample))

print("sample of", len(sample), flush=True)
for k, v in Counter(k for k, _, _ in res).most_common():
    print(f"  {k:<8}{v:>4}  ({v / len(sample) * 100:.0f}%)")
sp = [(a, b) for k, a, b in res if k == "SPACED"]
if sp:
    raw, col = sum(a for a, _ in sp), sum(b for _, b in sp)
    print(f"\nspaced: {raw:,} raw -> {col:,} collapsed  ({raw / col:.2f}x inflation)")
