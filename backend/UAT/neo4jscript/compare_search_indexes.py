"""
compare_search_indexes.py
=========================
Diffs two Azure AI Search index definitions so a new environment can be proved
identical to a known-good one before it is loaded.

    python compare_search_indexes.py                      # Dev/config.toml vs ../config.toml
    python compare_search_indexes.py <baseline-config>    # compare against another config

Each config must carry search_endpoint, search_key and index_name. Only the
fields and the vectorSearch block are compared: those are what decide whether
function_app.py's vector query works. Nothing is written to either service.
"""
from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

import toml

HERE = Path(__file__).resolve().parent
API_VERSION = "2024-07-01"

# The attributes that change how a field behaves at query time. Anything not in
# this list (e.g. a description) is cosmetic and deliberately ignored.
FIELD_ATTRS = ["type", "key", "retrievable", "filterable", "sortable", "facetable",
               "searchable", "analyzer", "dimensions", "vectorSearchProfile"]


def fetch_index(cfg: dict, label: str) -> dict:
    endpoint = (cfg.get("search_endpoint") or "").rstrip("/")
    key = cfg.get("search_key")
    name = cfg.get("index_name")
    missing = [k for k, v in [("search_endpoint", endpoint), ("search_key", key),
                              ("index_name", name)] if not v]
    if missing:
        sys.exit(f"{label}: config is missing {', '.join(missing)}")

    url = f"{endpoint}/indexes/{name}?api-version={API_VERSION}"
    req = urllib.request.Request(url, headers={"api-key": key,
                                               "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", "replace")[:300]
        sys.exit(f"{label}: HTTP {exc.code} fetching '{name}'\n  {body}")
    except urllib.error.URLError as exc:
        sys.exit(f"{label}: could not reach {endpoint}\n  {exc.reason}\n"
                 "  If the service has public network access disabled, run this from\n"
                 "  inside the network or add your IP to its firewall rules.")


def norm(field: dict) -> dict:
    """The behaviour-relevant attributes of one field, with defaults filled in."""
    out = {}
    for a in FIELD_ATTRS:
        v = field.get(a)
        # Azure omits false booleans on some fields; treat missing as False except
        # for analyzer/dimensions/profile, where missing genuinely means "not set".
        if v is None and a not in ("analyzer", "dimensions", "vectorSearchProfile", "type"):
            v = False
        out[a] = v
    return out


def compare_fields(base: dict, other: dict) -> list[str]:
    b = {f["name"]: norm(f) for f in base.get("fields", [])}
    o = {f["name"]: norm(f) for f in other.get("fields", [])}
    problems = []
    for name in sorted(set(b) - set(o)):
        problems.append(f"MISSING field '{name}' (present in baseline)")
    for name in sorted(set(o) - set(b)):
        problems.append(f"EXTRA   field '{name}' (not in baseline)")
    for name in sorted(set(b) & set(o)):
        for attr in FIELD_ATTRS:
            want, got = b[name][attr], o[name][attr]
            if attr == "vectorSearchProfile":
                # A generated name; only whether a profile is attached matters.
                if bool(want) != bool(got):
                    problems.append(
                        f"field '{name}': vector search profile is "
                        f"{'attached' if got else 'MISSING - vector queries will fail'}"
                        f" (baseline {'has one' if want else 'has none'})")
                continue
            if want != got:
                problems.append(f"field '{name}': {attr} = {got!r} (baseline {want!r})")
    return problems


# Names the portal generates carry a creation timestamp (vector-profile-1779539864959),
# so two equivalent indexes never share them. Comparing by name would report every
# rebuilt index as different; compare the settings instead and ignore the labels.
NAME_KEYS = ("name", "algorithmConfigurationName", "algorithm", "vectorizer", "compression")


def strip_names(obj: dict) -> dict:
    return {k: v for k, v in obj.items() if k not in NAME_KEYS}


def compare_vector_search(base: dict, other: dict) -> list[str]:
    """The vectorSearch block is what the Fields grid in the portal does not show."""
    bv, ov = base.get("vectorSearch") or {}, other.get("vectorSearch") or {}
    problems = []
    if bool(bv) != bool(ov):
        return ["vectorSearch block is %s" %
                ("MISSING entirely - vector queries will fail" if not ov
                 else "present but absent in baseline")]
    for section in ("profiles", "algorithms", "vectorizers", "compressions"):
        b = sorted((json.dumps(strip_names(x), sort_keys=True)
                    for x in (bv.get(section) or [])))
        o = sorted((json.dumps(strip_names(x), sort_keys=True)
                    for x in (ov.get(section) or [])))
        if len(b) != len(o):
            problems.append(f"vectorSearch.{section}: baseline has {len(b)}, "
                            f"target has {len(o)}")
            continue
        for want, got in zip(b, o):
            if want != got:
                problems.append(f"vectorSearch.{section} settings differ:\n"
                                f"      baseline: {want}\n"
                                f"      this one: {got}")
    return problems


def summarise(idx: dict, cfg: dict, label: str) -> None:
    dims = [f.get("dimensions") for f in idx.get("fields", []) if f.get("dimensions")]
    profiles = [p.get("name") for p in (idx.get("vectorSearch") or {}).get("profiles", [])]
    print(f"{label}")
    print(f"   endpoint        {cfg.get('search_endpoint')}")
    print(f"   index           {idx.get('name')}")
    print(f"   fields          {len(idx.get('fields', []))}")
    print(f"   vector dims     {dims or 'none'}")
    print(f"   vector profiles {profiles or 'NONE - vector queries will fail'}")
    print()


def main() -> int:
    baseline_path = Path(sys.argv[1]) if len(sys.argv) > 1 else HERE.parent / "config.toml"
    target_path = HERE / "config.toml"

    baseline_cfg = toml.load(baseline_path)
    target_cfg = toml.load(target_path)

    print("=" * 68)
    print("AZURE AI SEARCH INDEX COMPARISON")
    print("=" * 68 + "\n")

    baseline = fetch_index(baseline_cfg, f"baseline ({baseline_path.name})")
    target = fetch_index(target_cfg, f"target ({target_path.name})")

    summarise(baseline, baseline_cfg, f"BASELINE  {baseline_path}")
    summarise(target, target_cfg, f"TARGET    {target_path}")

    problems = compare_fields(baseline, target) + compare_vector_search(baseline, target)

    print("=" * 68)
    if not problems:
        print("MATCH - the target index is equivalent to the baseline.")
        print("=" * 68)
        return 0
    print(f"{len(problems)} DIFFERENCE(S) FOUND")
    print("=" * 68)
    for p in problems:
        print(f"  - {p}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
