"""
_pico_probe.py -- does this PDF actually state a research question?

Greps the extracted text for the Dutch cues a ZIN assessment uses when it frames
a PICO, and prints a snippet around each hit so you can judge it yourself.

    python _pico_probe.py "<blob name or fragment>"

Read-only. Reads from the local mirror in pdfs/zin/.
"""
import io
import os
import re
import sys

from pypdf import PdfReader

PDF_DIR = os.path.join("pdfs", "zin")

STRONG = ["onderzoeksvraag", "vraagstelling", "PICO", "centrale vraag",
          "research question"]
WEAK = ["uitkomstmaat", "eindpunt", "vergelijkende behandeling",
        "populatie", "interventie", "comparator"]


def normalise(text):
    r"""Collapse letter-spaced extractions.

    Some ZIN PDFs carry font encodings that make pypdf emit a space between
    every glyph, so "PICO" comes out as "P I C O" and a literal search finds
    nothing. The ingest pipeline is unaffected -- the LLM reads spaced text
    perfectly well -- but this probe greps, so it has to undo the spacing.

    Detected by the share of single-character whitespace-delimited tokens;
    real Dutch prose sits far below the threshold. Two or more spaces
    separate words, a single space separates glyphs.
    """
    tokens = text.split()
    if not tokens:
        return text, False
    singles = sum(1 for t in tokens if len(t) == 1)
    if singles / len(tokens) < 0.5:
        return text, False
    words = [re.sub(r"\s+", "", w) for w in re.split(r"\s{2,}", text)]
    return " ".join(w for w in words if w), True


def read_bytes(path):
    """Plain read first; only reach for the long-path form if the OS refuses."""
    try:
        with open(path, "rb") as fh:
            return fh.read()
    except OSError:
        prefixed = "\\\\?\\" + os.path.abspath(path)   # becomes \\?\C:\...
        with open(prefixed, "rb") as fh:
            return fh.read()


def resolve(name):
    """Accept a full blob name or any unique fragment of one."""
    direct = os.path.join(PDF_DIR, name)
    if os.path.exists(direct):
        return direct
    matches = [f for f in os.listdir(PDF_DIR) if name.lower() in f.lower()]
    if len(matches) == 1:
        print(f"matched: {matches[0]}\n")
        return os.path.join(PDF_DIR, matches[0])
    if matches:
        print(f"{len(matches)} files match '{name}':")
        for m in matches[:10]:
            print("   ", m)
        return None
    print(f"not found in {PDF_DIR}: {name}")
    return None


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 2

    path = resolve(sys.argv[1])
    if path is None:
        return 1

    reader = PdfReader(io.BytesIO(read_bytes(path)))
    raw = "\n".join((pg.extract_text() or "") for pg in reader.pages)
    text, spaced = normalise(raw)
    note = f"  [letter-spaced extraction, collapsed to {len(text):,}]" if spaced else ""
    print(f"pages={len(reader.pages)}  chars={len(raw):,}{note}\n")

    strong_hits = 0
    weak_hits = 0
    for cue in STRONG + WEAK:
        hits = [m.start() for m in re.finditer(re.escape(cue), text, re.I)]
        if cue in STRONG:
            strong_hits += len(hits)
            marker = "**" if hits else "  "
        else:
            weak_hits += len(hits)
            marker = "  "
        print(f"{marker} {cue:<28}{len(hits)}")
        for h in hits[:2]:
            snippet = " ".join(text[max(0, h - 130):h + 170].split())
            print(f"        ...{snippet}...")

    print()
    if strong_hits:
        print(f"VERDICT: {strong_hits} explicit research-question cue(s). A PICO is "
              "probably stated -- pico_stated=false would be a miss.")
    elif weak_hits:
        print("VERDICT: incidental vocabulary only, no framed research question. "
              "pico_stated=false looks correct.")
    else:
        print("VERDICT: no PICO vocabulary at all. pico_stated=false is correct.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
