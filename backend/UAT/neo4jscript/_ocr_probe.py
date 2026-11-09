"""Can the AZ gateway do vision? Renders one scanned page and asks the model to read it."""
import io, os, sys, time
import pymupdf
from hta_ingest.config import Settings
from hta_ingest.llm import BedrockLLM
from hta_ingest.source import _long

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

FRAG = sys.argv[1] if len(sys.argv) > 1 else "mirabegron-betmiga"
PAGE = int(sys.argv[2]) if len(sys.argv) > 2 else 2
DPI  = int(sys.argv[3]) if len(sys.argv) > 3 else 150

D = os.path.join("pdfs", "zin")
f = [x for x in os.listdir(D) if FRAG in x][0]
print(f"file : {f[:72]}")

doc  = pymupdf.open(stream=open(_long(os.path.join(D, f)), "rb").read(), filetype="pdf")
page = doc[PAGE - 1]
png  = page.get_pixmap(dpi=DPI).tobytes("png")
print(f"page : {PAGE} of {len(doc)}   rendered {len(png):,} bytes at {DPI} dpi\n")

settings = Settings.from_env()
llm = BedrockLLM(settings)

t0 = time.time()
try:
    resp = llm.client.converse(
        modelId=llm.model,
        system=[{"text": "You transcribe scanned Dutch documents. Output only the text you can "
                         "read on the page, preserving line order. No commentary."}],
        messages=[{"role": "user", "content": [
            {"image": {"format": "png", "source": {"bytes": png}}},
            {"text": "Transcribe this page."},
        ]}],
        inferenceConfig={"maxTokens": 4096, "temperature": 0.0},
    )
except Exception as e:
    print(f"VISION REJECTED after {time.time()-t0:.1f}s")
    print(f"  {type(e).__name__}: {e}")
    sys.exit(1)

parts = resp.get("output", {}).get("message", {}).get("content", [])
text  = "".join(p.get("text", "") for p in parts)
usage = resp.get("usage", {}) or {}
print(f"VISION WORKS  {time.time()-t0:.1f}s  in={usage.get('inputTokens')} out={usage.get('outputTokens')}")
print(f"chars returned: {len(text):,}\n--- first 700 ---")
print(text[:700])
