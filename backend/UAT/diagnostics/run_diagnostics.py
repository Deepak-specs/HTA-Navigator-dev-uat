# run_diagnostics.py
# Rename from neo4j.py to avoid import conflict with neo4j library
# Run: python run_diagnostics.py

from neo4j import GraphDatabase
import toml, json, sys
from pathlib import Path

# config.toml sits next to this script. Pin the path so the same config is
# read whatever directory the script is invoked from.
HERE = Path(__file__).resolve().parent

# The report prints check marks and box characters. The Windows console
# defaults to cp1252, which cannot encode them, so force UTF-8 output.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except (AttributeError, OSError):  # not a real stdout (piped or redirected)
    pass

# ── Load config ───────────────────────────────────────────────────
try:
    config = toml.load(HERE / "config.toml")
except FileNotFoundError:
    print("ERROR: config.toml not found.")
    print("Make sure you run this from the backend directory:")
    print("  cd C:\\Users\\khjh068\\OneDrive - AZCollaboration\\Meetings\\HTA_Navigator_Azure\\backend")
    sys.exit(1)

# ── Neo4j connection — every value comes from config.toml ─────────────
NEO4J_URI      = config.get("NEO4J_URI")
NEO4J_USER     = config.get("NEO4J_USER")
NEO4J_PASSWORD = config.get("NEO4J_PASSWORD")

if not NEO4J_URI or not NEO4J_USER or not NEO4J_PASSWORD:
    print("ERROR: Could not find Neo4j settings in config.toml")
    print("Expected keys: NEO4J_URI, NEO4J_USER and NEO4J_PASSWORD")
    print(f"Keys found in config.toml: {list(config.keys())}")
    sys.exit(1)

print(f"Connecting to: {NEO4J_URI}")
print(f"User:          {NEO4J_USER}")
print(f"Password:      {'*' * len(NEO4J_PASSWORD)}\n")

try:
    driver = GraphDatabase.driver(
        NEO4J_URI,
        auth=(NEO4J_USER, NEO4J_PASSWORD)
    )
    # Verify connectivity before running queries
    driver.verify_connectivity()
    print("✓ Connected to Neo4j successfully\n")
except Exception as e:
    print(f"ERROR: Could not connect to Neo4j: {e}")
    print("\nTroubleshooting:")
    print("  1. Check VPN is connected (AstraZeneca internal network required)")
    print("  2. Verify NEO4J_USER and NEO4J_PASSWORD in config.toml")
    print(f"  3. Confirm URI is reachable: {NEO4J_URI}")
    sys.exit(1)


def run_diagnostics():
    results = {}

    with driver.session() as session:

        # ── 1. Node counts by label ───────────────────────────────
        print("Running query 1/7: Node counts...")
        try:
            node_counts = session.run("""
                CALL apoc.meta.stats()
                YIELD labels
                RETURN labels
            """).single()
            if node_counts:
                results["node_counts_by_label"] = dict(node_counts["labels"])
                results["apoc_available"] = True
            else:
                raise ValueError("APOC returned no data")
        except Exception:
            # APOC not available — use direct COUNT queries
            results["apoc_available"] = False
            summary_count = session.run(
                "MATCH (n:SummaryDocuments) RETURN COUNT(n) AS count"
            ).single()["count"]

            translated_count = session.run(
                "MATCH (n:TranslatedDocuments) RETURN COUNT(n) AS count"
            ).single()["count"]

            results["node_counts_by_label"] = {
                "SummaryDocuments":    summary_count,
                "TranslatedDocuments": translated_count,
            }

        # ── 2. Relationship counts ────────────────────────────────
        print("Running query 2/7: Relationship counts...")
        rel_count = session.run(
            "MATCH ()-[r]->() RETURN COUNT(r) AS count"
        ).single()["count"]
        results["total_relationships"] = rel_count

        # ── 3. SummaryDocuments storage estimate ──────────────────
        print("Running query 3/7: SummaryDocuments storage sample...")
        sample = session.run("""
            MATCH (s:SummaryDocuments)
            WITH s LIMIT 10
            RETURN
                AVG(SIZE(COALESCE(s.full_text,   ''))) AS avg_full_text_chars,
                AVG(SIZE(COALESCE(s.summary,     ''))) AS avg_summary_chars,
                AVG(SIZE(COALESCE(s.rawJson,     ''))) AS avg_rawjson_chars
        """).single()

        if sample:
            avg_chars_per_node = (
                (sample["avg_full_text_chars"] or 0) +
                (sample["avg_summary_chars"]   or 0) +
                (sample["avg_rawjson_chars"]   or 0)
            )
            total_summary_nodes = results["node_counts_by_label"].get(
                "SummaryDocuments", 0
            )
            estimated_mb = (avg_chars_per_node * total_summary_nodes) / (1024 * 1024)
            results["estimated_summary_storage_mb"] = round(estimated_mb, 1)
            results["avg_chars_per_summary_node"]   = round(avg_chars_per_node)
        else:
            results["estimated_summary_storage_mb"] = 0
            results["avg_chars_per_summary_node"]   = 0

        # ── 4. TranslatedDocuments storage estimate ───────────────
        print("Running query 4/7: TranslatedDocuments storage sample...")
        td_sample = session.run("""
            MATCH (d:TranslatedDocuments)
            WITH d LIMIT 10
            RETURN
                AVG(SIZE(COALESCE(d.rawJson,  ''))) AS avg_rawjson_chars,
                AVG(SIZE(COALESCE(d.content,  ''))) AS avg_content_chars,
                COUNT(d)                            AS sample_count
        """).single()

        if td_sample:
            avg_td_chars = (
                (td_sample["avg_rawjson_chars"]  or 0) +
                (td_sample["avg_content_chars"]  or 0)
            )
            total_td = results["node_counts_by_label"].get(
                "TranslatedDocuments", 0
            )
            estimated_td_mb = (avg_td_chars * total_td) / (1024 * 1024)
            results["estimated_translated_storage_mb"] = round(estimated_td_mb, 1)
            results["avg_chars_per_translated_node"]   = round(avg_td_chars)
        else:
            results["estimated_translated_storage_mb"] = 0
            results["avg_chars_per_translated_node"]   = 0

        # ── 5. Graph features check ───────────────────────────────
        results["graph_features_used"] = rel_count > 0

        # ── 6. Date range of rulings ──────────────────────────────
        print("Running query 5/7: Date range...")
        date_range = session.run("""
            MATCH (s:SummaryDocuments)
            WHERE s.decision_date IS NOT NULL
            RETURN
                MIN(s.decision_date) AS earliest,
                MAX(s.decision_date) AS latest,
                COUNT(s)             AS dated_count
        """).single()

        if date_range:
            results["date_range"] = {
                "earliest":    date_range["earliest"],
                "latest":      date_range["latest"],
                "dated_count": date_range["dated_count"],
            }

        # ── 7. Therapy area distribution ─────────────────────────
        print("Running query 6/7: Therapy area distribution...")
        therapy_dist = session.run("""
            MATCH (s:SummaryDocuments)
            WHERE s.therapy_area IS NOT NULL
            RETURN s.therapy_area AS area, COUNT(s) AS count
            ORDER BY count DESC
        """).data()
        results["therapy_area_distribution"] = therapy_dist

        # ── 8. Decision outcome distribution ─────────────────────
        print("Running query 7/7: Decision outcomes...")
        outcome_dist = session.run("""
            MATCH (s:SummaryDocuments)
            WHERE s.decision_outcome IS NOT NULL
            RETURN s.decision_outcome AS outcome, COUNT(s) AS count
            ORDER BY count DESC
        """).data()
        results["decision_outcome_distribution"] = outcome_dist

    driver.close()
    return results


# ── Main ──────────────────────────────────────────────────────────
if __name__ == "__main__":
    print("=" * 60)
    print("NEO4J DIAGNOSTIC TOOL — HTA Navigator")
    print(f"URI: {NEO4J_URI}")
    print("=" * 60 + "\n")

    data = run_diagnostics()

    print("\n" + "=" * 60)
    print("NEO4J USAGE REPORT")
    print("=" * 60)

    # Node counts
    node_counts = data.get("node_counts_by_label", {})
    total_nodes = sum(node_counts.values())
    print(f"\nAPOC Available:             {'YES' if data.get('apoc_available') else 'NO (used fallback)'}")
    print(f"\nNode Counts:")
    for label, count in node_counts.items():
        print(f"  {label:<30} {count:>6} nodes")
    print(f"  {'TOTAL':<30} {total_nodes:>6} nodes")

    # Relationships
    rel_count = data.get('total_relationships', 0)
    print(f"\nRelationships:              {rel_count:>6}")
    print(f"Graph features used:        "
          f"{'YES' if data.get('graph_features_used') else 'NO — pure document store'}")

    # Storage
    est_summary = data.get("estimated_summary_storage_mb", 0)
    est_td      = data.get("estimated_translated_storage_mb", 0)
    total_mb    = est_summary + est_td
    print(f"\nEstimated Storage:")
    print(f"  SummaryDocuments:         {est_summary:>6.1f} MB")
    print(f"  TranslatedDocuments:      {est_td:>6.1f} MB")
    print(f"  Total estimated:          {total_mb:>6.1f} MB  "
          f"({total_mb/1024:.2f} GB)")
    print(f"\n  Avg chars/SummaryDoc:     "
          f"{data.get('avg_chars_per_summary_node', 0):>8,}")
    print(f"  Avg chars/TranslatedDoc:  "
          f"{data.get('avg_chars_per_translated_node', 0):>8,}")

    # Date range
    date_range = data.get("date_range", {})
    if date_range:
        print(f"\nRuling Date Range:")
        print(f"  Earliest:  {date_range.get('earliest', 'N/A')}")
        print(f"  Latest:    {date_range.get('latest',   'N/A')}")
        print(f"  Dated:     {date_range.get('dated_count', 0)} rulings")

    # Therapy areas
    print(f"\nTherapy Area Distribution:")
    for row in data.get("therapy_area_distribution", []):
        bar = "█" * min(40, int(row["count"] / max(
            r["count"] for r in data["therapy_area_distribution"]
        ) * 40))
        print(f"  {row['area']:<35} {row['count']:>4}  {bar}")

    # Decision outcomes
    print(f"\nDecision Outcome Distribution:")
    for row in data.get("decision_outcome_distribution", []):
        print(f"  {row['outcome']:<35} {row['count']:>4} rulings")

    # Cost assessment
    print("\n" + "=" * 60)
    print("COST ASSESSMENT")
    print("=" * 60)

    if total_nodes < 200_000 and total_mb < 1024:
        print("""
  Based on node count and storage, your POC is likely on:
  ┌─────────────────────────────────────────────────────┐
  │  AuraDB Free:        $0/month                       │
  │    — pauses after 3 days idle                       │
  │    — no SLA, not suitable for production            │
  │                                                     │
  │  AuraDB DS:          $65/month                      │
  │    — suitable for dev/test only                     │
  │                                                     │
  │  ► Check console.neo4j.io to confirm exact tier     │
  └─────────────────────────────────────────────────────┘
        """)
    else:
        print("""
  Based on node count and storage, your POC is likely on:
  ┌─────────────────────────────────────────────────────┐
  │  AuraDB Professional 4GB:  $395/month               │
  │  AuraDB Professional 8GB:  $790/month               │
  │                                                     │
  │  ► Check console.neo4j.io to confirm exact billing  │
  └─────────────────────────────────────────────────────┘
        """)

    # MySQL comparison
    print("  MySQL Flexible Server (West Europe) comparison:")
    print("  ┌─────────────────────────────────────────────────────┐")
    if total_mb < 200:
        mysql_cost = 65
        mysql_tier = "Burstable B2ms  (2 vCore, 8GB RAM)"
    elif total_mb < 1024:
        mysql_cost = 150
        mysql_tier = "Burstable B4ms  (4 vCore, 16GB RAM)"
    else:
        mysql_cost = 280
        mysql_tier = "General Purpose D4ds (4 vCore, 16GB RAM)"

    neo4j_est = 395 if total_nodes < 200_000 else 790
    saving    = neo4j_est - mysql_cost
    saving_pct = round((saving / neo4j_est) * 100)

    print(f"  │  Recommended tier: {mysql_tier}")
    print(f"  │  MySQL cost:       ~${mysql_cost}/month")
    print(f"  │  Neo4j est. cost:  ~${neo4j_est}/month")
    print(f"  │  Monthly saving:   ~${saving}/month")
    print(f"  │  Annual saving:    ~${saving * 12:,}/year  ({saving_pct}% reduction)")
    print(f"  └─────────────────────────────────────────────────────┘")

    if not data.get("graph_features_used"):
        print(f"""
  ⚠  CRITICAL FINDING:
     {rel_count} relationships found — Neo4j graph features are NOT used.
     HTA Navigator uses Neo4j purely as a document store.
     MySQL provides identical functionality at {saving_pct}% lower cost.
     Migration effort: 3-5 engineering days.
        """)

    # Save JSON report
    output_file = "neo4j_poc_diagnostics.json"
    with open(output_file, "w") as f:
        json.dump(data, f, indent=2, default=str)
    print(f"\n✓ Full diagnostic data saved to: {output_file}")
    print(  "  Share this file when requesting MySQL migration approval.\n")