"""
translate.py
============
Dutch -> English, page-aligned.

Pages are sent in chunks with ⟦PAGE n⟧ markers. The reply must contain
exactly the same markers; if it does not (or the reply was cut off by the
token limit) the chunk is split in half and retried, down to single pages,
and an over-long single page is split by paragraphs. Numbers, amounts and
dates are kept exactly as written -- normalisation happens in the summary
step, under explicit rules.
"""
from __future__ import annotations

import logging
import re

log = logging.getLogger("hta.translate")

MARKER = "⟦PAGE {n}⟧"
MARKER_RE = re.compile(r"⟦PAGE (\d+)⟧")

SYSTEM = """You are a professional Dutch-to-English translator for health technology \
assessment (HTA) documents from Zorginstituut Nederland (formerly CVZ).

Rules:
- Translate the COMPLETE text faithfully. Never summarise, shorten, skip or add content.
- Keep every number, amount, percentage, date and unit EXACTLY as written in the source,
  including Dutch separators: "€ 4.600,00" stays "€ 4.600,00", "7,37/100" stays "7,37/100",
  "12-03-2008" stays "12-03-2008". Do not convert or round anything.
- Keep drug names, brand names (®), trial names, reference numbers and abbreviations
  (CVZ, CFH, ZIN, GVS, NZa, PASI, QALY, ...) unchanged. Established Dutch terms may be
  followed by the Dutch term in brackets the first time, e.g. "therapeutic added value
  (therapeutische meerwaarde)".
- Tables arrive as flattened text: translate the words and keep the numbers and line order.
- Page markers such as ⟦PAGE 3⟧ must be copied unchanged, each on its own line, in the
  same order. Every marker in the input must appear exactly once in the output.
- Output only the translation. No preface, notes or commentary."""


def _chunk_pages(pages: list[tuple[int, str]], max_chars: int) -> list[list[tuple[int, str]]]:
    chunks, cur, size = [], [], 0
    for no, text in pages:
        if cur and size + len(text) > max_chars:
            chunks.append(cur)
            cur, size = [], 0
        cur.append((no, text))
        size += len(text)
    if cur:
        chunks.append(cur)
    return chunks


def _parse_marked(text: str, expected: list[int]) -> dict[int, str] | None:
    parts = MARKER_RE.split(text)
    # parts = [preamble, n1, body1, n2, body2, ...]
    found = [int(n) for n in parts[1::2]]
    if found != expected:
        return None
    return {int(n): body.strip() for n, body in zip(parts[1::2], parts[2::2])}


class Translator:
    def __init__(self, llm, max_chars: int = 9000, max_tokens: int = 8192):
        self.llm = llm
        self.max_chars = max_chars
        self.max_tokens = max_tokens

    def translate_pages(self, pages_nl: list[str]) -> list[str]:
        numbered = [(i + 1, t) for i, t in enumerate(pages_nl) if t.strip()]
        out: dict[int, str] = {}
        for chunk in _chunk_pages(numbered, self.max_chars):
            out.update(self._translate_chunk(chunk))
        return [out.get(i + 1, "") for i in range(len(pages_nl))]

    # ------------------------------------------------------------------ #
    def _translate_chunk(self, chunk: list[tuple[int, str]]) -> dict[int, str]:
        expected = [no for no, _ in chunk]
        body = "\n\n".join(f"{MARKER.format(n=no)}\n{text}" for no, text in chunk)
        res = self.llm.complete(SYSTEM, body, max_tokens=self.max_tokens)
        parsed = None if res.truncated else _parse_marked(res.text, expected)
        if parsed is not None:
            return parsed

        reason = "truncated" if res.truncated else "page markers did not match"
        if len(chunk) > 1:
            log.info("chunk pages %s: %s -> splitting", expected, reason)
            mid = len(chunk) // 2
            return {**self._translate_chunk(chunk[:mid]),
                    **self._translate_chunk(chunk[mid:])}

        no, text = chunk[0]
        if res.truncated:
            log.info("page %d too long for one call -> splitting by paragraph", no)
            return {no: self._translate_long_text(text)}
        # single page, markers garbled but complete: keep the text, drop stray markers
        log.warning("page %d: marker mismatch, keeping unmarked output", no)
        return {no: MARKER_RE.sub("", res.text).strip()}

    def _translate_long_text(self, text: str) -> str:
        paras = text.split("\n\n") if "\n\n" in text else text.split("\n")
        if len(paras) < 2:
            half = len(text) // 2
            paras = [text[:half], text[half:]]
        mid = len(paras) // 2
        pieces = []
        for part in ("\n\n".join(paras[:mid]), "\n\n".join(paras[mid:])):
            res = self.llm.complete(SYSTEM, part, max_tokens=self.max_tokens)
            pieces.append(self._translate_long_text(part) if res.truncated else res.text.strip())
        return "\n\n".join(pieces)
