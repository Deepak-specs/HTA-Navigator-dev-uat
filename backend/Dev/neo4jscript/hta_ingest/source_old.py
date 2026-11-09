"""
source.py
=========
Reads what the ZIN crawler produced, through the crawler's own zin_sinks.py:

  <pdf container>/<name>.pdf                    e.g. test-1709
  <json container>/meta/<name>.pdf.meta.json    e.g. jsonoutput-1709

The .meta.json files are the inventory: one per PDF. Unlike Sink.get_json(),
this reader distinguishes "not found" from "read failed", so a network error
never looks like a missing document.
"""
from __future__ import annotations

import json
import logging
import sys
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from types import SimpleNamespace

from .config import Settings

log = logging.getLogger("hta.source")

META_PREFIX = "meta/"
META_SUFFIX = ".meta.json"


def _import_zin_sinks():
    try:
        import zin_sinks  # noqa: F401
    except ImportError:
        # allow zin_sinks.py to sit in the project root next to run_ingest.py
        sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
        import zin_sinks  # noqa: F401
    return sys.modules["zin_sinks"]


@dataclass
class DocMeta:
    blob_name: str
    sha256: str | None
    source_url: str | None
    source_page: str | None
    title: str | None
    doc_issued: str | None
    doc_modified: str | None
    information_type: str | None
    first_seen: str | None
    raw: dict


class SourceReader:
    def __init__(self, settings: Settings):
        zs = _import_zin_sinks()
        self._zs = zs
        args = SimpleNamespace(
            sink=settings.sink,
            root=settings.root,
            account=settings.account,
            pdf_container=settings.pdf_container,
            json_container=settings.json_container,
        )
        self.sink = zs.build_sink(args)
        self.pdf_container = settings.pdf_container
        log.info("source: %s", self.sink.describe())

    # ------------------------------------------------------------------ #
    def _is_local(self) -> bool:
        return isinstance(self.sink, self._zs.LocalSink)

    def _read_json_blob(self, name: str) -> dict:
        if self._is_local():
            p = self.sink.json_dir / name
            if not p.exists():
                raise FileNotFoundError(name)
            return json.loads(p.read_text(encoding="utf-8-sig"))
        from azure.core.exceptions import ResourceNotFoundError

        try:
            data = self.sink._json.get_blob_client(name).download_blob().readall()
        except ResourceNotFoundError as exc:
            raise FileNotFoundError(name) from exc
        return json.loads(data.decode("utf-8-sig"))

    def get_pdf(self, blob_name: str) -> bytes:
        if self._is_local():
            p = self.sink.pdf_dir / blob_name
            if not p.exists():
                raise FileNotFoundError(f"PDF not found: {blob_name}")
            return p.read_bytes()
        from azure.core.exceptions import ResourceNotFoundError

        try:
            return self.sink._pdf.get_blob_client(blob_name).download_blob().readall()
        except ResourceNotFoundError as exc:
            raise FileNotFoundError(f"PDF not found: {blob_name}") from exc

    def list_pdf_names(self) -> set[str]:
        return {b.name for b in self.sink.list_pdfs()}

    # ------------------------------------------------------------------ #
    def list_metas(self, workers: int = 8) -> list[DocMeta]:
        names = [
            b.name for b in self.sink.list_json(prefix=META_PREFIX)
            if b.name.endswith(META_SUFFIX)
        ]
        log.info("found %d meta files", len(names))

        def load(name: str) -> DocMeta:
            md = self._read_json_blob(name)          # errors propagate on purpose
            blob = name[len(META_PREFIX):-len(META_SUFFIX)]
            if md.get("filename") and md["filename"] != blob:
                log.warning("meta %s says filename=%s; using blob name %s",
                            name, md["filename"], blob)
            return DocMeta(
                blob_name=blob,
                sha256=md.get("sha256") or None,
                source_url=md.get("source_url"),
                source_page=md.get("source_page"),
                title=md.get("title"),
                doc_issued=md.get("doc_issued"),
                doc_modified=md.get("doc_modified"),
                information_type=md.get("information_type"),
                first_seen=md.get("first_seen"),
                raw=md,
            )

        with ThreadPoolExecutor(max_workers=workers) as ex:
            metas = list(ex.map(load, names))
        return sorted(metas, key=lambda m: m.blob_name)
