"""
extract.py
==========
PDF -> list of per-page text, with conservative cleaning.

What is removed
  * page headers/footers such as "Pagina 2 van 9" / "Page 2 of 9"
  * lines that repeat on most pages (running headers like
    "27089055 def. versie adalimumab (humira®)")
  * margin line numbers (5, 10, 15, ... printed beside the text)

What is deliberately KEPT (the POC's clean_text() destroyed these)
  * punctuation, diacritics (patiënten), currency symbols (€, £), %,
    decimal and thousands separators (€ 4.600,00), dates (12-03-2024)
"""
from __future__ import annotations

import io
import re
from collections import Counter
from dataclasses import dataclass, field

PAGE_NUM_PATTERNS = [
    re.compile(r"\bPagina\s+\d+\s+van\s+\d+\b", re.I),
    re.compile(r"\bPage\s+\d+\s+of\s+\d+\b", re.I),
]
_LEADING_NUM = re.compile(r"^(\d{1,3})(?:\s+(\S.*))?$")
_TRAILING_NUM = re.compile(r"^(.*\S)\s+(\d{1,3})$")

# Formulae and symbols set in a non-standard font can come out of pypdf as
# unpaired UTF-16 surrogates. They encode to nothing in UTF-8, so botocore
# serialises a malformed request body and Bedrock rejects the whole call with
# "The request body is not valid JSON" -- failing the document deterministically
# at translate. The glyphs carry no recoverable text, so they are dropped.
_SURROGATES = re.compile(r"[\ud800-\udfff]")

LOW_TEXT_PAGE_CHARS = 40      # below this a page is probably an image/scan
LOW_TEXT_DOC_CHARS = 300      # below this the whole document needs OCR


@dataclass
class ExtractedDoc:
    pages: list[str]
    page_count: int
    low_text_pages: list[int] = field(default_factory=list)   # 1-based

    @property
    def total_chars(self) -> int:
        return sum(len(p) for p in self.pages)

    @property
    def needs_ocr(self) -> bool:
        return self.total_chars < LOW_TEXT_DOC_CHARS


# --------------------------------------------------------------------------- #
def extract_pdf(pdf_bytes: bytes) -> ExtractedDoc:
    from pypdf import PdfReader

    reader = PdfReader(io.BytesIO(pdf_bytes))
    raw_pages = []
    for page in reader.pages:
        try:
            raw_pages.append(page.extract_text() or "")
        except Exception:  # noqa: BLE001 - one bad page must not kill the doc
            raw_pages.append("")
    pages = clean_pages(raw_pages)
    low = [i + 1 for i, p in enumerate(pages) if len(p.strip()) < LOW_TEXT_PAGE_CHARS]
    return ExtractedDoc(pages=pages, page_count=len(pages), low_text_pages=low)


# --------------------------------------------------------------------------- #
def clean_pages(raw_pages: list[str]) -> list[str]:
    split = [_normalise_lines(p) for p in raw_pages]
    repeated = _repeated_lines(split)
    out = []
    for lines in split:
        lines = [ln for ln in lines if _norm_key(ln) not in repeated]
        lines = _strip_margin_numbers(lines)
        text = "\n".join(lines)
        for pat in PAGE_NUM_PATTERNS:
            text = pat.sub("", text)
        text = re.sub(r"[ \t]{2,}", " ", text)
        text = re.sub(r"\n{3,}", "\n\n", text)
        out.append(text.strip())
    return out


def _normalise_lines(page: str) -> list[str]:
    page = _SURROGATES.sub("", page)
    page = page.replace("\r", "\n").replace("\u00a0", " ")
    lines = [ln.rstrip() for ln in page.split("\n")]
    # collapse runs of blank lines to one
    out: list[str] = []
    for ln in lines:
        if not ln.strip():
            if out and out[-1] == "":
                continue
            out.append("")
        else:
            out.append(ln.strip())
    return out


def _norm_key(line: str) -> str:
    return re.sub(r"\d+", "#", line.strip().lower())


def _repeated_lines(pages: list[list[str]]) -> set[str]:
    """Lines (digits ignored) that occur on at least half of the pages (min 3)."""
    if len(pages) < 3:
        return set()
    counts: Counter[str] = Counter()
    for lines in pages:
        counts.update({_norm_key(ln) for ln in lines if 0 < len(ln.strip()) <= 120})
    threshold = max(3, (len(pages) + 1) // 2)
    return {k for k, c in counts.items() if c >= threshold and k not in ("", "#")}


def _strip_margin_numbers(lines: list[str]) -> list[str]:
    """
    Margin line numbers run 5, 10, 15 ... down the page and pypdf glues them
    to the start or end of a text line. Only a strict +5 chain of at least 3
    numbers counts, so ordinary numbers ("10 weken", "PASI 75") survive.
    """
    candidates: list[tuple[int, int, str]] = []   # (line_idx, value, kind)
    for i, ln in enumerate(lines):
        m = _LEADING_NUM.match(ln)
        if m:
            candidates.append((i, int(m.group(1)), "lead"))
            continue
        m = _TRAILING_NUM.match(ln)
        if m:
            candidates.append((i, int(m.group(2)), "trail"))

    chain: list[tuple[int, int, str]] = []
    expected = 5
    for idx, val, kind in candidates:
        if val == expected:
            chain.append((idx, val, kind))
            expected += 5
    if len(chain) < 3:
        return lines

    out = list(lines)
    for idx, _val, kind in chain:
        if kind == "lead":
            m = _LEADING_NUM.match(out[idx])
            out[idx] = (m.group(2) or "") if m else out[idx]
        else:
            m = _TRAILING_NUM.match(out[idx])
            out[idx] = m.group(1) if m else out[idx]
    return out
