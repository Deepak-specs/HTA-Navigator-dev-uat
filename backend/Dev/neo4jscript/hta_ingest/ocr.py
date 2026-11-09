"""
ocr.py
======
Text out of scanned PDFs, using the model's vision input.

Ten documents in the ZIN corpus, dated 2012 to 2024, are image-only: pypdf
reads their page structure perfectly well but finds no text layer, so
`ExtractedDoc.needs_ocr` is true and the document stops before translation.
They are 801 pages between them.

Rather than add an OCR service, each page is rendered to PNG and read by the
same Bedrock model the rest of the pipeline already calls. That needs no new
credential, endpoint or quota -- only a renderer (PyMuPDF, a self-contained
wheel with no system dependencies).

Two things keep the cost down:

* Blank pages are skipped. These are duplex scans of single-sided originals,
  so a large share of pages carry nothing. A grayscale render at 50 dpi and a
  dark-pixel count is far cheaper than a model call.
* Rendering stays at 150 dpi. The model normalises the image before
  tokenising, so a page costs about 1,600 input tokens whether it arrives at
  150 or 200 dpi -- the extra resolution buys nothing.

The output goes back into the normal path: the recovered Dutch text is
translated and summarised exactly like a text-layer PDF, so an OCR'd document
is indistinguishable downstream.
"""
from __future__ import annotations

import logging
import time
from concurrent.futures import ThreadPoolExecutor

log = logging.getLogger("hta.ocr")

SYSTEM = """You transcribe scanned pages from Dutch health technology assessment \
documents published by Zorginstituut Nederland (formerly CVZ).

Rules:
- Output ONLY the text visible on the page, in reading order. No commentary,
  no description of the layout, no apology for unclear text.
- Keep every number, amount, percentage, date and reference exactly as printed,
  including Dutch separators: "€ 4.600,00" stays "€ 4.600,00".
- Transcribe tables row by row, keeping the cells in their printed order.
- Keep headings, list markers and the line order of the original.
- If the page carries no text at all, output nothing."""

PROMPT = "Transcribe this page."

# A page is considered blank when fewer than this share of sampled pixels are
# dark. Scanner speckle and a faint edge shadow sit well below it; a page with
# even a single line of text sits well above.
INK_THRESHOLD = 0.002
INK_DPI = 50
_INK_STRIDE = 11          # sample every Nth byte; an ink test needs no better


class OcrReader:
    """Renders a scanned PDF and reads each page through the model."""

    def __init__(self, llm, *, dpi: int = 150, workers: int = 4,
                 max_pages: int | None = None, max_tokens: int = 4096):
        self.llm = llm
        self.dpi = dpi
        self.workers = max(1, workers)
        self.max_pages = max_pages
        self.max_tokens = max_tokens

    # ------------------------------------------------------------------ #
    def read_pdf(self, pdf_bytes: bytes) -> list[str]:
        """One string per page, in order. Blank or unreadable pages give ""."""
        import pymupdf

        doc = pymupdf.open(stream=pdf_bytes, filetype="pdf")
        total = len(doc)
        limit = min(total, self.max_pages) if self.max_pages else total

        # Render on the main thread: PyMuPDF document objects are not safe to
        # share across threads. Only the model calls are parallelised.
        t0 = time.time()
        jobs: list[tuple[int, bytes]] = []
        blank = 0
        for i in range(limit):
            page = doc[i]
            if not _has_ink(page, pymupdf):
                blank += 1
                continue
            jobs.append((i, page.get_pixmap(dpi=self.dpi).tobytes("png")))
        doc.close()

        log.info("ocr: %d pages, %d blank, %d to read (rendered in %.1fs)",
                 total, blank, len(jobs), time.time() - t0)

        pages = [""] * total
        if not jobs:
            return pages

        with ThreadPoolExecutor(max_workers=self.workers) as pool:
            for idx, text in pool.map(self._read_one, jobs):
                pages[idx] = text

        got = sum(1 for p in pages if p.strip())
        log.info("ocr: %d/%d pages returned text, %d chars total",
                 got, len(jobs), sum(len(p) for p in pages))
        return pages

    # ------------------------------------------------------------------ #
    def _read_one(self, job: tuple[int, bytes]) -> tuple[int, str]:
        idx, png = job
        try:
            res = self.llm.complete_image(SYSTEM, png, PROMPT, max_tokens=self.max_tokens)
        except Exception as exc:                                   # noqa: BLE001
            # One unreadable page must not lose the other 800. The page is left
            # empty and the document carries on.
            log.warning("ocr: page %d failed: %s: %s", idx + 1, type(exc).__name__, exc)
            return idx, ""
        return idx, (res.text or "").strip()


# --------------------------------------------------------------------------- #
def _has_ink(page, pymupdf) -> bool:
    """Cheap blank-page test: any meaningful share of dark pixels at 50 dpi."""
    try:
        pm = page.get_pixmap(dpi=INK_DPI, colorspace=pymupdf.csGRAY)
    except Exception:                                              # noqa: BLE001
        return True        # cannot tell -- send it rather than drop it
    sample = pm.samples[::_INK_STRIDE]
    if not sample:
        return False
    dark = sum(1 for b in sample if b < 200)
    return (dark / len(sample)) >= INK_THRESHOLD
