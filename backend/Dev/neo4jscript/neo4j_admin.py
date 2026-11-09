"""
neo4j_admin.py
==============
    python neo4j_admin.py check     # connectivity, versions, APOC
    python neo4j_admin.py setup     # constraints + indexes (safe to repeat)
    python neo4j_admin.py verify    # read-only checks after a load

Uses the NEO4J_* settings from .env.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from hta_ingest.config import Settings

HERE = Path(__file__).resolve().parent


# Hints for the security errors this script can hit. Only Unauthorized reaches the
# driver as an AuthError, so these are keyed by code rather than by exception class.
SECURITY_HINTS = {
    "Neo.ClientError.Security.Unauthorized": (
        "Check NEO4J_USER / NEO4J_PASSWORD in .env. The server reports the same error for",
        "a wrong password, a user that does not exist and a suspended account, so confirm",
        "the credentials with whoever provisioned the instance.",
    ),
    "Neo.ClientError.Security.AuthenticationRateLimit": (
        "Too many failed sign-ins in a row, so the server is refusing further attempts",
        "for now. Wait a few minutes before retrying, and correct the credentials first --",
        "every failed retry extends the lockout.",
    ),
    "Neo.ClientError.Security.CredentialsExpired": (
        "The password must be changed before the account can be used. Set a new one in",
        "Neo4j Browser, then update NEO4J_PASSWORD in .env.",
    ),
}


def split_statements(text: str) -> list[tuple[str, str]]:
    """Returns (title, statement) pairs; the title is the comment line above it."""
    out, buf, title = [], [], ""
    for line in text.splitlines():
        s = line.strip()
        if s.startswith("//"):
            if not buf:
                title = s.lstrip("/ ").strip()
            continue
        if not s and not buf:
            continue
        buf.append(line)
        if s.endswith(";"):
            stmt = "\n".join(buf).strip().rstrip(";").strip()
            if stmt:
                out.append((title, stmt))
            buf, title = [], ""
    if buf and "\n".join(buf).strip():
        out.append((title, "\n".join(buf).strip().rstrip(";")))
    return out


def print_table(rows: list[dict]) -> None:
    if not rows:
        print("   (no rows)")
        return
    cols = list(rows[0].keys())
    cells = [[_fmt(r.get(c)) for c in cols] for r in rows]
    widths = [min(60, max(len(c), *(len(x[i]) for x in cells))) for i, c in enumerate(cols)]
    print("   " + " | ".join(c.ljust(w) for c, w in zip(cols, widths)))
    print("   " + "-+-".join("-" * w for w in widths))
    for row in cells:
        print("   " + " | ".join(v[:w].ljust(w) for v, w in zip(row, widths)))


def _fmt(v) -> str:
    if v is None:
        return ""
    if isinstance(v, list):
        return ", ".join(str(x) for x in v)
    return str(v).replace("\n", " ")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("command", choices=["check", "setup", "verify"])
    a = ap.parse_args()

    s = Settings.from_env()
    s.require("neo4j_uri", "neo4j_user", "neo4j_password")
    from neo4j import GraphDatabase
    from neo4j.exceptions import Neo4jError, ServiceUnavailable

    driver = GraphDatabase.driver(s.neo4j_uri, auth=(s.neo4j_user, s.neo4j_password))
    try:
        try:
            driver.verify_connectivity()
        except ServiceUnavailable as exc:
            print(f"Could not reach {s.neo4j_uri}: {exc}\n"
                  "Check NEO4J_URI, DNS and whether you are on the network or VPN.")
            return 1
        except Neo4jError as exc:
            # Only Unauthorized arrives as AuthError; the other security codes come
            # through as a plain ClientError, so branch on the code instead.
            hint = SECURITY_HINTS.get(exc.code)
            if hint is None:
                raise
            print(f"{exc.code} for user '{s.neo4j_user}' at {s.neo4j_uri}.")
            for line in hint:
                print(line)
            return 1
        print(f"Connected to {s.neo4j_uri} (database '{s.neo4j_database}')\n")

        def run(stmt: str) -> list[dict]:
            records, _, _ = driver.execute_query(stmt, database_=s.neo4j_database)
            return [r.data() for r in records]

        if a.command == "check":
            print_table(run("CALL dbms.components() YIELD name, versions, edition "
                            "RETURN name, versions, edition"))
            try:
                print_table(run("RETURN apoc.version() AS apoc_version"))
            except Exception as exc:  # noqa: BLE001
                print(f"   APOC NOT available: {exc}")
            print_table(run("MATCH (n) RETURN count(n) AS nodes_in_database"))
            return 0

        fname = "01_setup.cypher" if a.command == "setup" else "02_verify.cypher"
        failures = 0
        for title, stmt in split_statements((HERE / "neo4j" / fname).read_text(encoding="utf-8")):
            first = stmt.splitlines()[0]
            print(f"-- {title if a.command == 'verify' and title else first}")
            try:
                rows = run(stmt)
                if a.command == "verify":
                    print_table(rows)
                else:
                    print("   ok")
            except Exception as exc:  # noqa: BLE001
                failures += 1
                print(f"   ERROR: {exc}")
            print()
        return 1 if failures else 0
    finally:
        driver.close()


if __name__ == "__main__":
    sys.exit(main())
