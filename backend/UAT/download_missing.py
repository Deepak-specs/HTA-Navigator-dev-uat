# download_missing.py
import hashlib
from pathlib import Path
import httpx

OUT = Path(r"C:\hta_0511\zin")
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    "Accept-Language": "nl,en;q=0.8",
}

PAGE = "https://www.zorginstituutnederland.nl/documenten/2022/10/12/advies-over-vaccinatie-tegen-meningokokken-b"
PDF = ("https://www.zorginstituutnederland.nl/site/binaries/site-content/collections/documents/"
       "2022/10/12/advies-over-vaccinatie-tegen-meningokokken-b/"
       "Gezamenlijke+notitie+Zorginstituut+en+Gezondheidsraad+bij+advies+over+vaccinatie+tegen+meningokokken+B.pdf")
NAME = "2022-10-12__advies-over-vaccinatie-tegen-meningokokken-b.pdf"   # adjust to match the pipeline's naming

OUT.mkdir(parents=True, exist_ok=True)
with httpx.Client(headers=HEADERS, follow_redirects=True, timeout=60) as c:
    r = c.get(PDF, headers={**HEADERS, "Referer": PAGE})
    print(f"HTTP {r.status_code}, {r.headers.get('content-type')}, {len(r.content)/1024:.1f} KB")
    r.raise_for_status()
    if not r.content.startswith(b"%PDF"):
        raise SystemExit("Not a PDF - not saved")
    (OUT / NAME).write_bytes(r.content)
    print("saved", OUT / NAME, "sha256", hashlib.sha256(r.content).hexdigest()[:12])