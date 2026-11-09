# find_pdf_links.py
import re
import httpx
from pathlib import Path
from urllib.parse import urljoin

PAGES = [
    "https://www.zorginstituutnederland.nl/documenten/2022/01/01/advies-zorgclustermodel-ggz",
    "https://www.zorginstituutnederland.nl/documenten/2022/10/12/advies-over-vaccinatie-tegen-meningokokken-b",
]
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml",
    "Accept-Language": "nl,en;q=0.8",
}

with httpx.Client(headers=HEADERS, follow_redirects=True, timeout=30) as c:
    for i, page in enumerate(PAGES, 1):
        r = c.get(page)
        print(f"\n[{i}] {page}\n    HTTP {r.status_code}, {len(r.text)} chars, final URL: {r.url}")
        Path(f"page_{i}.html").write_text(r.text, encoding="utf-8")
        hrefs = re.findall(r'(?:href|src|data-[\w-]+)\s*=\s*["\']([^"\']+)["\']', r.text, re.I)
        found = [urljoin(str(r.url), h) for h in dict.fromkeys(hrefs)
                 if re.search(r"\.pdf|/publish/|/binaries/|download|bijlage|attachment|/file", h, re.I)]
        print(f"    candidate links: {len(found)}")
        for u in found:
            print("     ", u)