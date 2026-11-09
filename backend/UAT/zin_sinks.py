"""
zin_sinks.py
============
Storage abstraction for the ZIN ingestion pipeline.

Provides a small Sink interface with two implementations:

  LocalSink       -> writes to a local directory (used for dev/testing)
  AzureBlobSink   -> writes to Azure Blob Storage (used in cloud)

The rest of the pipeline (discovery / ingest / reconcile) is
storage-agnostic: it calls sink.put_pdf(), sink.put_json(), sink.list_pdfs(),
etc., without knowing where the bytes actually go.

Auth for Azure
--------------
Tries in this order:
  1. AZURE_STORAGE_CONNECTION_STRING env var
  2. AZURE_STORAGE_ACCOUNT env var + DefaultAzureCredential
  3. --account CLI argument + DefaultAzureCredential

DefaultAzureCredential picks up `az login`, managed identity, env vars, etc.
"""

from __future__ import annotations

import json
import logging
import os
from abc import ABC, abstractmethod
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

log = logging.getLogger("zin.sink")


# --------------------------------------------------------------------------- #
@dataclass
class BlobInfo:
    name: str
    size: int
    etag: str | None = None
    last_modified: str | None = None


# --------------------------------------------------------------------------- #
class Sink(ABC):
    """Abstract write/read target for the pipeline."""

    @abstractmethod
    def put_pdf(self, name: str, body: bytes,
                content_type: str = "application/pdf") -> None: ...

    @abstractmethod
    def put_json(self, name: str, obj: dict | list) -> None: ...

    @abstractmethod
    def put_text(self, name: str, text: str,
                 content_type: str = "text/plain; charset=utf-8") -> None: ...

    @abstractmethod
    def get_json(self, name: str) -> dict | list | None: ...

    @abstractmethod
    def get_text(self, name: str) -> str | None: ...

    @abstractmethod
    def list_pdfs(self) -> list[BlobInfo]: ...

    @abstractmethod
    def list_json(self, prefix: str = "") -> list[BlobInfo]: ...

    @abstractmethod
    def exists_pdf(self, name: str) -> bool: ...

    @abstractmethod
    def describe(self) -> str: ...


# --------------------------------------------------------------------------- #
class LocalSink(Sink):
    def __init__(self, root: Path, pdf_subdir: str = "zin",
                 json_subdir: str = "zin_json"):
        self.pdf_dir = root / pdf_subdir
        self.json_dir = root / json_subdir
        self.pdf_dir.mkdir(parents=True, exist_ok=True)
        self.json_dir.mkdir(parents=True, exist_ok=True)

    def _win_long(self, p: Path) -> str:
        s = str(p.resolve())
        if os.name == "nt" and not s.startswith("\\\\?\\"):
            return "\\\\?\\" + s
        return s

    def put_pdf(self, name: str, body: bytes, content_type: str = "application/pdf") -> None:
        p = self.pdf_dir / name
        tmp = p.with_suffix(p.suffix + ".part")
        with open(self._win_long(tmp), "wb") as f:
            f.write(body)
        os.replace(self._win_long(tmp), self._win_long(p))

    def put_json(self, name: str, obj: dict | list) -> None:
        p = self.json_dir / name
        p.parent.mkdir(parents=True, exist_ok=True)
        with open(self._win_long(p), "w", encoding="utf-8") as f:
            json.dump(obj, f, indent=2, ensure_ascii=False)

    def put_text(self, name: str, text: str,
                 content_type: str = "text/plain; charset=utf-8") -> None:
        p = self.json_dir / name
        p.parent.mkdir(parents=True, exist_ok=True)
        with open(self._win_long(p), "w", encoding="utf-8") as f:
            f.write(text)

    def get_json(self, name: str) -> dict | list | None:
        p = self.json_dir / name
        if not p.exists():
            return None
        with open(self._win_long(p), "r", encoding="utf-8") as f:
            return json.load(f)

    def get_text(self, name: str) -> str | None:
        p = self.json_dir / name
        if not p.exists():
            return None
        with open(self._win_long(p), "r", encoding="utf-8") as f:
            return f.read()

    def list_pdfs(self) -> list[BlobInfo]:
        out = []
        for f in self.pdf_dir.glob("*.pdf"):
            st = f.stat()
            out.append(BlobInfo(name=f.name, size=st.st_size))
        return out

    def list_json(self, prefix: str = "") -> list[BlobInfo]:
        out = []
        for f in self.json_dir.rglob("*.json"):
            rel = f.relative_to(self.json_dir).as_posix()
            if prefix and not rel.startswith(prefix):
                continue
            st = f.stat()
            out.append(BlobInfo(name=rel, size=st.st_size))
        return out

    def exists_pdf(self, name: str) -> bool:
        return (self.pdf_dir / name).exists()

    def describe(self) -> str:
        return f"LocalSink(pdf={self.pdf_dir}, json={self.json_dir})"


# --------------------------------------------------------------------------- #
class AzureBlobSink(Sink):
    """
    Writes PDFs to one container and JSON artefacts to another.

    Two Azure SDK packages needed:
        pip install azure-storage-blob azure-identity
    """

    def __init__(
        self,
        account: str | None = None,
        pdf_container: str = "hta-navigator-preprod",
        json_container: str = "jsonoutput-preprod",
        connection_string: str | None = None,
    ):
        from azure.storage.blob import BlobServiceClient
        from azure.identity import DefaultAzureCredential

        conn = connection_string or os.environ.get("AZURE_STORAGE_CONNECTION_STRING")
        if conn:
            self.service = BlobServiceClient.from_connection_string(conn)
            log.info("Azure auth: connection string")
        else:
            acct = account or os.environ.get("AZURE_STORAGE_ACCOUNT")
            if not acct:
                raise ValueError(
                    "No connection string and no account name. "
                    "Set AZURE_STORAGE_CONNECTION_STRING, or "
                    "AZURE_STORAGE_ACCOUNT, or pass --account."
                )
            url = f"https://{acct}.blob.core.windows.net"
            self.service = BlobServiceClient(
                account_url=url, credential=DefaultAzureCredential()
            )
            log.info("Azure auth: DefaultAzureCredential -> %s", url)

        self.pdf_container = pdf_container
        self.json_container = json_container
        self._pdf = self.service.get_container_client(pdf_container)
        self._json = self.service.get_container_client(json_container)

        # Verify containers exist (do not auto-create -- the ops team pre-creates them)
        for c in (self._pdf, self._json):
            try:
                c.get_container_properties()
            except Exception as exc:
                raise RuntimeError(
                    f"Container '{c.container_name}' inaccessible: {exc}. "
                    f"Ensure it exists and your identity has "
                    f"'Storage Blob Data Contributor' role."
                ) from exc

    # -- writes ------------------------------------------------------------ #
    def put_pdf(self, name: str, body: bytes,
                content_type: str = "application/pdf") -> None:
        from azure.storage.blob import ContentSettings
        self._pdf.upload_blob(
            name=name, data=body, overwrite=True,
            content_settings=ContentSettings(content_type=content_type),
        )

    def put_json(self, name: str, obj: dict | list) -> None:
        from azure.storage.blob import ContentSettings
        data = json.dumps(obj, indent=2, ensure_ascii=False).encode("utf-8")
        self._json.upload_blob(
            name=name, data=data, overwrite=True,
            content_settings=ContentSettings(content_type="application/json"),
        )

    def put_text(self, name: str, text: str,
                 content_type: str = "text/plain; charset=utf-8") -> None:
        from azure.storage.blob import ContentSettings
        self._json.upload_blob(
            name=name, data=text.encode("utf-8"), overwrite=True,
            content_settings=ContentSettings(content_type=content_type),
        )

    # -- reads ------------------------------------------------------------- #
    def get_json(self, name: str) -> dict | list | None:
        try:
            data = self._json.get_blob_client(name).download_blob().readall()
        except Exception:
            return None
        return json.loads(data.decode("utf-8"))

    def get_text(self, name: str) -> str | None:
        try:
            data = self._json.get_blob_client(name).download_blob().readall()
        except Exception:
            return None
        return data.decode("utf-8")

    # -- listing ----------------------------------------------------------- #
    def list_pdfs(self) -> list[BlobInfo]:
        out = []
        for b in self._pdf.list_blobs():
            if not b.name.lower().endswith(".pdf"):
                continue
            out.append(BlobInfo(
                name=b.name,
                size=b.size or 0,
                etag=b.etag,
                last_modified=(b.last_modified.isoformat()
                               if b.last_modified else None),
            ))
        return out

    def list_json(self, prefix: str = "") -> list[BlobInfo]:
        out = []
        for b in self._json.list_blobs(name_starts_with=prefix):
            out.append(BlobInfo(
                name=b.name,
                size=b.size or 0,
                etag=b.etag,
                last_modified=(b.last_modified.isoformat()
                               if b.last_modified else None),
            ))
        return out

    def exists_pdf(self, name: str) -> bool:
        return self._pdf.get_blob_client(name).exists()

    def describe(self) -> str:
        acct = self.service.account_name
        return (f"AzureBlobSink(account={acct}, "
                f"pdf={self.pdf_container}, json={self.json_container})")


# --------------------------------------------------------------------------- #
def build_sink(args) -> Sink:
    """
    Factory used by all pipeline scripts. Expects `args` to have:
        args.sink            'local' | 'azure'
        args.root            Path (local mode)
        args.account         str  (azure mode, optional)
        args.pdf_container   str  (azure mode)
        args.json_container  str  (azure mode)
    """
    if args.sink == "local":
        return LocalSink(Path(args.root))
    elif args.sink == "azure":
        return AzureBlobSink(
            account=getattr(args, "account", None),
            pdf_container=args.pdf_container,
            json_container=args.json_container,
        )
    raise ValueError(f"unknown sink: {args.sink}")


def add_sink_args(ap) -> None:
    """Attach the common --sink / container CLI args to any argparse parser."""
    ap.add_argument(
        "--sink", choices=["local", "azure"],
        default=os.environ.get("ZIN_SINK", "azure"),
        help="storage backend (default: azure, overridable with ZIN_SINK env)",
    )
    ap.add_argument("--root", default=os.environ.get("ZIN_ROOT", "./zin_data"),
                    help="local root (only used when --sink local)")
    ap.add_argument("--account",
                    default=os.environ.get("AZURE_STORAGE_ACCOUNT",
                                           "nlhtanavigatoruksppdsa"),
                    help="Azure Storage account name")
    ap.add_argument("--pdf-container", default="hta-navigator-preprod",
                    help="container for PDF blobs")
    ap.add_argument("--json-container", default="jsonoutput-preprod",
                    help="container for JSON / manifest / log blobs")