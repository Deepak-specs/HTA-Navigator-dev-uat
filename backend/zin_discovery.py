"""
zin_discovery.py
================
Full enumeration of Zorginstituut Nederland publications -- all 856, not
just the newest 20.

WHY THIS EXISTS
---------------
Three discovery routes were tested against the live site:

  /api/documents          404  -- does not exist
  /api/search             400  -- EXISTS but payload schema unknown
  /api/rss?query=<JSON>   200  -- works, accepts information_type filter,
                                  but hard-caps at the newest ~20 items
                                  and has no pagination parameter
  GET /documenten (HTML)  200  -- but the body is EMPTY. The listing is a
                                  client-side React Search UI, so there is
                                  nothing to scrape without a headless browser.

Strategy: turn the one endpoint that works into a paginated one. /api/rss
accepts an arbitrary Elastic Search-UI filter array, so we add a DATE RANGE
filter and sweep time in windows. Any window that comes back at the cap gets
recursively bisected until it fits. Union of all windows = the full corpus.

  ~15 years of Advies at ~5/month  ->  monthly windows sit well under the cap
  ~190 requests for a complete backfill

CRITICAL SAFEGUARD
------------------
If the date field name is wrong, Elastic may silently IGNORE the filter and
return the same newest-20 for every window -- which would look like success
while producing garbage. validate_range_filter() proves the filter actually
bites before any sweeping happens, by checking that two disjoint windows
return disjoint results. It refuses to continue otherwise.

Usage
-----
    # 0. find out which date field and endpoint your side can use
    python zin_discovery.py --probe

    # 1. full backfill -> newline-delimited JSON of publication URLs
    python zin_discovery.py --information-type Advies --out advies_urls.jsonl

    # 2. feed that into your existing downloader
    python zin_advies_to_local.py --url-file advies_urls.jsonl
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys
import urllib.parse
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone

import httpx
from bs4 import BeautifulSoup

# Add at top of zin_discovery.py:
from zin_sinks import build_sink, add_sink_args

log = logging.getLogger("zin.discover")

BASE = "https://www.zorginstituutnederland.nl"
RSS_PATH = "/api/rss"

USER_AGENT = "HTA-Ingest/1.0 (+contact: your.name@yourcompany.com)"

# Candidate names for the publication-date facet. The probe narrows this down.
DATE_FIELD_CANDIDATES = ["issued", "modified", "date", "available", "publication_date"]

# Candidate shapes for the undocumented /api/search endpoint.
SEARCH_PROBE_PATHS = ["/api/search", "/api/zoeken", "/api/content", "/api/documenten"]


# --------------------------------------------------------------------------- #
@dataclass
class Pub:
    page_url: str
    title: str = ""
    issued: str | None = None

    def __hash__(self) -> int:
        return hash(self.page_url)


@dataclass
class Sweep:
    information_type: str | None = "Advies"
    date_field: str = "issued"
    start: date = date(2008, 1, 1)
    end: date = field(default_factory=lambda: date.today() + timedelta(days=1))
    cap: int = 20          # observed RSS page size; auto-raised if we see more
    delay: float = 0.3
    min_span_days: int = 1


# --------------------------------------------------------------------------- #
# Query construction
# --------------------------------------------------------------------------- #
def iso(d: date) -> str:
    return datetime(d.year, d.month, d.day, tzinfo=timezone.utc).isoformat().replace(
        "+00:00", "Z"
    )


def build_query(
    information_type: str | None,
    date_field: str | None = None,
    start: date | None = None,
    end: date | None = None,
) -> dict:
    """
    Reproduces the object the website puts in its own URL bar, plus an
    optional Elastic range filter:

      {"filters":[
         {"field":"information_type","values":["Advies"],"type":"all"},
         {"field":"issued","values":[{"from":"...","to":"...","name":"w"}],
          "type":"all"}],
       "resultSearchTerm":""}
    """
    filters: list[dict] = []
    if information_type:
        filters.append(
            {"field": "information_type", "values": [information_type], "type": "all"}
        )
    if date_field and start and end:
        filters.append(
            {
                "field": date_field,
                "values": [{"from": iso(start), "to": iso(end), "name": "w"}],
                "type": "all",
            }
        )
    return {"filters": filters, "resultSearchTerm": ""}


def rss_url(query: dict) -> str:
    # separators matter: the site emits compact JSON, and some WAFs are fussy
    q = json.dumps(query, separators=(",", ":"))
    return f"{BASE}{RSS_PATH}?query={urllib.parse.quote(q, safe='')}"


# --------------------------------------------------------------------------- #
# RSS fetch + parse
# --------------------------------------------------------------------------- #
async def fetch_rss(client: httpx.AsyncClient, query: dict) -> list[Pub]:
    url = rss_url(query)
    r = await client.get(url)
    if r.status_code == 400:
        raise ValueError(f"400 -- query rejected: {json.dumps(query)[:200]}")
    r.raise_for_status()
    return parse_rss(r.text)


def parse_rss(xml: str) -> list[Pub]:
    soup = BeautifulSoup(xml, "xml")
    out: list[Pub] = []
    for it in soup.find_all("item"):
        link = it.find("link")
        href = (link.text or "").strip() if link else ""
        if not href:
            continue
        if href.startswith("/"):
            href = BASE + href
        t = it.find("title")
        pd = it.find("pubDate")
        out.append(
            Pub(
                page_url=href,
                title=(t.text or "").strip() if t else "",
                issued=(pd.text or "").strip() if pd else None,
            )
        )
    return out


# --------------------------------------------------------------------------- #
# SAFEGUARD: prove the range filter actually filters
# --------------------------------------------------------------------------- #
async def validate_range_filter(
    client: httpx.AsyncClient, information_type: str | None, date_field: str
) -> bool:
    """
    Two disjoint, non-adjacent year windows must return disjoint URL sets.
    If they overlap, Elastic is ignoring our range filter and every window
    would return the same newest-20 -- silent data corruption. Refuse.
    """
    a = build_query(information_type, date_field, date(2019, 1, 1), date(2020, 1, 1))
    b = build_query(information_type, date_field, date(2023, 1, 1), date(2024, 1, 1))
    try:
        ra, rb = await fetch_rss(client, a), await fetch_rss(client, b)
    except (ValueError, httpx.HTTPStatusError) as exc:
        log.debug("  field %-18s rejected (%s)", date_field, exc)
        return False

    if not ra and not rb:
        log.debug("  field %-18s both windows empty -- inconclusive", date_field)
        return False

    sa, sb = {p.page_url for p in ra}, {p.page_url for p in rb}
    if sa & sb:
        log.debug(
            "  field %-18s OVERLAP (%d shared) -- filter ignored",
            date_field, len(sa & sb),
        )
        return False

    # Sanity: items in the 2019 window should actually carry 2019-ish dates.
    log.info(
        "  field %-18s OK  (2019 window: %d items, 2023 window: %d items)",
        date_field, len(ra), len(rb),
    )
    return True


async def detect_date_field(
    client: httpx.AsyncClient, information_type: str | None
) -> str | None:
    log.info("probing date facet names...")
    for f in DATE_FIELD_CANDIDATES:
        if await validate_range_filter(client, information_type, f):
            return f
        await asyncio.sleep(0.3)
    return None


# --------------------------------------------------------------------------- #
# Adaptive date-window sweep
# --------------------------------------------------------------------------- #
async def sweep(client: httpx.AsyncClient, cfg: Sweep) -> list[Pub]:
    found: dict[str, Pub] = {}
    stats = {"requests": 0, "bisections": 0, "capped_atomic": 0}

    async def visit(lo: date, hi: date, depth: int = 0) -> None:
        q = build_query(cfg.information_type, cfg.date_field, lo, hi)
        items = await fetch_rss(client, q)
        stats["requests"] += 1
        await asyncio.sleep(cfg.delay)

        if len(items) > cfg.cap:
            cfg.cap = len(items)     # endpoint is more generous than assumed

        span = (hi - lo).days
        if len(items) >= cfg.cap and span > cfg.min_span_days:
            # Window is saturated -- we are almost certainly truncated. Bisect.
            mid = lo + timedelta(days=span // 2)
            stats["bisections"] += 1
            log.debug("%sbisect %s..%s (%d items)", "  " * depth, lo, hi, len(items))
            await visit(lo, mid, depth + 1)
            await visit(mid, hi, depth + 1)
            return

        if len(items) >= cfg.cap:
            # Can't subdivide further: >cap documents share one day.
            stats["capped_atomic"] += 1
            log.warning(
                "window %s..%s is at cap (%d) and cannot be split -- "
                "documents may be missing for this day", lo, hi, len(items)
            )

        new = 0
        for p in items:
            if p.page_url not in found:
                found[p.page_url] = p
                new += 1
        if items:
            log.info(
                "%s..%s  %3d items (%d new, total %d)",
                lo, hi, len(items), new, len(found),
            )

    # Monthly first pass; visit() bisects wherever that is too coarse.
    cursor = date(cfg.start.year, cfg.start.month, 1)
    while cursor < cfg.end:
        nxt = (
            date(cursor.year + 1, 1, 1)
            if cursor.month == 12
            else date(cursor.year, cursor.month + 1, 1)
        )
        await visit(cursor, min(nxt, cfg.end))
        cursor = nxt

    log.info(
        "sweep complete: %d unique publications in %d requests "
        "(%d bisections, %d unsplittable capped windows)",
        len(found), stats["requests"], stats["bisections"], stats["capped_atomic"],
    )
    return list(found.values())


# --------------------------------------------------------------------------- #
# Fallback: sitemap enumeration
# --------------------------------------------------------------------------- #
async def sitemap_discover(client: httpx.AsyncClient) -> list[Pub]:
    """
    Independent cross-check that needs no API at all. Platform Rijksoverheid
    Online sites usually expose sitemap.xml (often a sitemapindex). Collect
    every /documenten/YYYY/MM/DD/slug URL. Type filtering then happens on the
    detail page via the DCTERMS meta tags, so this route cannot be broken by
    facet renames -- it is just slower.
    """
    seen: dict[str, Pub] = {}
    queue = [f"{BASE}/sitemap.xml", f"{BASE}/sitemap_index.xml", f"{BASE}/sitemap.xml.gz"]
    visited: set[str] = set()

    while queue:
        url = queue.pop(0)
        if url in visited:
            continue
        visited.add(url)
        try:
            r = await client.get(url)
            if r.status_code != 200:
                log.debug("sitemap %s -> %s", url, r.status_code)
                continue
        except httpx.HTTPError as exc:
            log.debug("sitemap %s failed: %s", url, exc)
            continue

        soup = BeautifulSoup(r.text, "xml")
        # nested sitemapindex
        for sm in soup.find_all("sitemap"):
            loc = sm.find("loc")
            if loc and loc.text.strip() not in visited:
                queue.append(loc.text.strip())
        for u in soup.find_all("url"):
            loc = u.find("loc")
            if not loc:
                continue
            href = loc.text.strip()
            if "/documenten/" in href and href not in seen:
                lm = u.find("lastmod")
                seen[href] = Pub(
                    page_url=href, issued=lm.text.strip() if lm else None
                )
        await asyncio.sleep(0.2)

    log.info("sitemap: %d /documenten/ URLs", len(seen))
    return list(seen.values())


# --------------------------------------------------------------------------- #
# Probe mode: find out what your network can actually reach
# --------------------------------------------------------------------------- #
async def probe(client: httpx.AsyncClient, information_type: str) -> None:
    print("\n=== 1. baseline: /api/rss with no date filter ===")
    try:
        base = await fetch_rss(client, build_query(information_type))
        print(f"  OK  {len(base)} items  <-- this is the cap you are hitting")
    except Exception as exc:                                  # noqa: BLE001
        print(f"  FAIL {exc}")
        base = []

    print("\n=== 2. does /api/rss honour a date range filter? ===")
    good = []
    for f in DATE_FIELD_CANDIDATES:
        ok = await validate_range_filter(client, information_type, f)
        print(f"  {f:<20} {'USABLE' if ok else 'no'}")
        if ok:
            good.append(f)
        await asyncio.sleep(0.3)
    if good:
        print(f"\n  ==> run the sweep with --date-field {good[0]}")
    else:
        print("\n  ==> no usable date facet; fall back to --mode sitemap")

    print("\n=== 3. /api/search payload shapes ===")
    q = json.dumps(build_query(information_type), separators=(",", ":"))
    attempts: list[tuple[str, str, dict]] = []
    for path in SEARCH_PROBE_PATHS:
        attempts += [
            ("GET", f"{path}?query={urllib.parse.quote(q, safe='')}", {}),
            ("GET", f"{path}?q={urllib.parse.quote(information_type)}&page=1", {}),
            ("POST", path, {"json": json.loads(q) | {"current": 1, "resultsPerPage": 100}}),
            ("POST", path, {"json": {"query": "", "filters": json.loads(q)["filters"],
                                     "page": {"size": 100, "current": 1}}}),
        ]
    for method, path_or_url, kw in attempts:
        url = path_or_url if path_or_url.startswith("http") else BASE + path_or_url
        try:
            r = await client.request(method, url, **kw)
            ct = r.headers.get("content-type", "")[:40]
            n = ""
            if r.status_code == 200 and "json" in ct:
                try:
                    d = r.json()
                    for k in ("results", "items", "hits", "data"):
                        if isinstance(d.get(k), list):
                            n = f" results={len(d[k])}"
                            break
                    if "meta" in d:
                        n += f" meta={json.dumps(d['meta'])[:120]}"
                except Exception:                              # noqa: BLE001
                    pass
            flag = "  <<< WINNER" if r.status_code == 200 and "json" in ct else ""
            print(f"  {method:<4} {url[len(BASE):][:58]:<58} {r.status_code} {ct}{n}{flag}")
        except Exception as exc:                               # noqa: BLE001
            print(f"  {method:<4} {url[len(BASE):][:58]:<58} ERR {type(exc).__name__}")
        await asyncio.sleep(0.2)

    print("\n=== 4. sitemap availability ===")
    for p in ["/sitemap.xml", "/sitemap_index.xml", "/robots.txt"]:
        try:
            r = await client.get(BASE + p)
            print(f"  {p:<20} {r.status_code}  {r.headers.get('content-type','')[:30]}")
            if p == "/robots.txt" and r.status_code == 200:
                for line in r.text.splitlines():
                    if line.lower().startswith(("sitemap", "crawl-delay", "disallow")):
                        print(f"      {line.strip()}")
        except Exception as exc:                               # noqa: BLE001
            print(f"  {p:<20} ERR {type(exc).__name__}")
    print()


# --------------------------------------------------------------------------- #
# async def amain(a: argparse.Namespace) -> int:
#     headers = {"User-Agent": USER_AGENT, "Accept-Language": "nl,en"}
#     async with httpx.AsyncClient(
#         headers=headers, timeout=60.0, follow_redirects=True
#     ) as client:

#         if a.probe:
#             await probe(client, a.information_type)
#             return 0

#         pubs: list[Pub] = []

#         if a.mode in ("rss", "auto"):
#             field_name = a.date_field
#             if not field_name:
#                 field_name = await detect_date_field(client, a.information_type)
#             if field_name:
#                 cfg = Sweep(
#                     information_type=a.information_type,
#                     date_field=field_name,
#                     start=datetime.strptime(a.since, "%Y-%m-%d").date(),
#                     delay=a.delay,
#                 )
#                 pubs = await sweep(client, cfg)
#             elif a.mode == "rss":
#                 log.error(
#                     "no usable date facet -- run --probe, or use --mode sitemap"
#                 )
#                 return 2
#             else:
#                 log.warning("no usable date facet; falling back to sitemap")

#         if not pubs and a.mode in ("sitemap", "auto"):
#             pubs = await sitemap_discover(client)

#         if not pubs:
#             log.error("discovered nothing")
#             return 1

#         if a.expect and len(pubs) < a.expect * 0.95:
#             log.warning(
#                 "expected ~%d but found %d (%.0f%%) -- likely truncated. "
#                 "Cross-check with --mode sitemap.",
#                 a.expect, len(pubs), 100 * len(pubs) / a.expect,
#             )
#         elif a.expect:
#             log.info("found %d vs expected ~%d -- looks complete", len(pubs), a.expect)

#         with open(a.out, "w", encoding="utf-8") as fh:
#             for p in sorted(pubs, key=lambda x: x.page_url):
#                 fh.write(json.dumps(
#                     {"page_url": p.page_url, "title": p.title, "issued": p.issued},
#                     ensure_ascii=False,
#                 ) + "\n")
#         log.info("wrote %d publication URLs -> %s", len(pubs), a.out)
#         return 0


# def main() -> int:
#     ap = argparse.ArgumentParser(description="Enumerate ALL ZIN publications")
#     ap.add_argument("--information-type", default="Advies",
#                     help='facet value, or "" for every type')
#     ap.add_argument("--mode", choices=["auto", "rss", "sitemap"], default="auto")
#     ap.add_argument("--date-field", default=None,
#                     help="skip detection, e.g. issued / modified")
#     ap.add_argument("--since", default="2008-01-01")
#     ap.add_argument("--delay", type=float, default=0.3)
#     ap.add_argument("--expect", type=int, default=None,
#                     help="expected total, e.g. 856 -- warns if short")
#     ap.add_argument("--out", default="zin_urls.jsonl")
#     ap.add_argument("--probe", action="store_true",
#                     help="diagnose which endpoints/facets work, then exit")
#     ap.add_argument("-v", "--verbose", action="store_true")
#     a = ap.parse_args()

#     logging.basicConfig(
#         level=logging.DEBUG if a.verbose else logging.INFO,
#         format="%(asctime)s %(levelname)-7s %(message)s",
#     )
#     logging.getLogger("httpx").setLevel(logging.WARNING)
#     if not a.information_type:
#         a.information_type = None
#     return asyncio.run(amain(a))


# if __name__ == "__main__":
#     sys.exit(main())

# --------------------------------------------------------------------------- #
# Replace the existing amain() with this:
async def amain(a: argparse.Namespace) -> int:
    headers = {"User-Agent": USER_AGENT, "Accept-Language": "nl,en"}
    async with httpx.AsyncClient(
        headers=headers, timeout=60.0, follow_redirects=True
    ) as client:

        if a.probe:
            await probe(client, a.information_type)
            return 0

        pubs: list[Pub] = []

        if a.mode in ("rss", "auto"):
            field_name = a.date_field
            if not field_name:
                field_name = await detect_date_field(client, a.information_type)
            if field_name:
                cfg = Sweep(
                    information_type=a.information_type,
                    date_field=field_name,
                    start=datetime.strptime(a.since, "%Y-%m-%d").date(),
                    delay=a.delay,
                )
                pubs = await sweep(client, cfg)
            elif a.mode == "rss":
                log.error("no usable date facet -- run --probe, or use --mode sitemap")
                return 2
            else:
                log.warning("no usable date facet; falling back to sitemap")

        if not pubs and a.mode in ("sitemap", "auto"):
            pubs = await sitemap_discover(client)

        if not pubs:
            log.error("discovered nothing")
            return 1

        if a.expect and len(pubs) < a.expect * 0.95:
            log.warning("expected ~%d but found %d (%.0f%%) -- likely truncated",
                        a.expect, len(pubs), 100 * len(pubs) / a.expect)
        elif a.expect:
            log.info("found %d vs expected ~%d -- looks complete",
                     len(pubs), a.expect)

        # ---- write JSONL ------------------------------------------------- #
        jsonl_lines = [
            json.dumps({"page_url": p.page_url, "title": p.title,
                        "issued": p.issued}, ensure_ascii=False)
            for p in sorted(pubs, key=lambda x: x.page_url)
        ]
        jsonl_text = "\n".join(jsonl_lines) + "\n"

        sink = build_sink(a)
        log.info("sink: %s", sink.describe())
        sink.put_text(a.out, jsonl_text,
                      content_type="application/x-ndjson; charset=utf-8")
        log.info("wrote %d publication URLs -> %s", len(pubs), a.out)

        # Also drop a small summary JSON for auditability
        sink.put_json(
            f"discovery/{datetime.now(timezone.utc).strftime('%Y-%m-%dT%H%M%SZ')}.json",
            {
                "run_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "information_type": a.information_type,
                "date_field": field_name if a.mode != "sitemap" else None,
                "since": a.since,
                "mode": a.mode,
                "count": len(pubs),
                "url_file": a.out,
            },
        )
        return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="Enumerate ALL ZIN publications")
    add_sink_args(ap)                        # NEW
    ap.add_argument("--information-type", default="Advies")
    ap.add_argument("--mode", choices=["auto", "rss", "sitemap"], default="auto")
    ap.add_argument("--date-field", default=None)
    ap.add_argument("--since", default="2008-01-01")
    ap.add_argument("--delay", type=float, default=0.3)
    ap.add_argument("--expect", type=int, default=None)
    ap.add_argument("--out", default="advies_urls.jsonl",
                    help="blob name (JSON container) or filename (local sink)")
    ap.add_argument("--probe", action="store_true")
    ap.add_argument("-v", "--verbose", action="store_true")
    a = ap.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if a.verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(name)-14s %(message)s",
    )
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("azure").setLevel(logging.WARNING)
    if not a.information_type:
        a.information_type = None
    return asyncio.run(amain(a))