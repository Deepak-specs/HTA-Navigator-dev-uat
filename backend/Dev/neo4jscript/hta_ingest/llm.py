"""
llm.py
======
Thin wrapper around Bedrock `converse` through the AZ AI gateway.

The client is constructed the same way as in function_app.py (which is known
to work against the gateway), except that retries are ON: botocore's adaptive
mode backs off on throttling and 5xx, which a bulk load of ~870 documents
will hit.
"""
from __future__ import annotations

import logging
import os
import time
from dataclasses import dataclass, field

from .config import Settings

log = logging.getLogger("hta.llm")


@dataclass
class LLMResult:
    text: str
    stop_reason: str | None
    usage: dict = field(default_factory=dict)

    @property
    def truncated(self) -> bool:
        return self.stop_reason == "max_tokens"


class BedrockLLM:
    def __init__(self, settings: Settings):
        settings.require("bedrock_gateway_url", "bedrock_api_key", "bedrock_model")
        import boto3
        from botocore.config import Config

        os.environ["AWS_BEARER_TOKEN_BEDROCK"] = settings.bedrock_api_key
        self.model = settings.bedrock_model
        self.client = boto3.client(
            service_name="bedrock-runtime",
            region_name=settings.bedrock_region,
            endpoint_url=settings.bedrock_gateway_url,
            # function_app.py passes the gateway URL here; kept identical so the
            # gateway sees the same request shape. Override with BEDROCK_ACCESS_KEY_ID.
            aws_access_key_id=settings.bedrock_access_key_id or settings.bedrock_gateway_url,
            aws_secret_access_key=settings.bedrock_api_key,
            config=Config(
                retries={"max_attempts": 8, "mode": "adaptive"},
                connect_timeout=30,
                read_timeout=600,
            ),
        )
        self.calls = 0
        self.input_tokens = 0
        self.output_tokens = 0

    def complete(self, system: str, user: str, max_tokens: int = 8192,
                 temperature: float = 0.0) -> LLMResult:
        t0 = time.time()
        resp = self.client.converse(
            modelId=self.model,
            system=[{"text": system}],
            messages=[{"role": "user", "content": [{"text": user}]}],
            inferenceConfig={"maxTokens": max_tokens, "temperature": temperature},
        )
        parts = resp.get("output", {}).get("message", {}).get("content", [])
        text = "".join(p.get("text", "") for p in parts)
        usage = resp.get("usage", {}) or {}
        self.calls += 1
        self.input_tokens += int(usage.get("inputTokens", 0) or 0)
        self.output_tokens += int(usage.get("outputTokens", 0) or 0)
        log.debug("LLM call %.1fs stop=%s usage=%s", time.time() - t0,
                  resp.get("stopReason"), usage)
        return LLMResult(text=text, stop_reason=resp.get("stopReason"), usage=usage)

    def complete_image(self, system: str, image_png: bytes, prompt: str,
                       max_tokens: int = 4096, temperature: float = 0.0) -> LLMResult:
        """Same call shape as complete(), with one PNG ahead of the prompt.

        Used by ocr.py to read scanned pages. The gateway accepts Converse
        image blocks, and the model normalises the image before tokenising it,
        so rendering above roughly 150 dpi costs no extra input tokens.
        """
        t0 = time.time()
        resp = self.client.converse(
            modelId=self.model,
            system=[{"text": system}],
            messages=[{"role": "user", "content": [
                {"image": {"format": "png", "source": {"bytes": image_png}}},
                {"text": prompt},
            ]}],
            inferenceConfig={"maxTokens": max_tokens, "temperature": temperature},
        )
        parts = resp.get("output", {}).get("message", {}).get("content", [])
        text = "".join(p.get("text", "") for p in parts)
        usage = resp.get("usage", {}) or {}
        self.calls += 1
        self.input_tokens += int(usage.get("inputTokens", 0) or 0)
        self.output_tokens += int(usage.get("outputTokens", 0) or 0)
        log.debug("LLM vision call %.1fs stop=%s usage=%s", time.time() - t0,
                  resp.get("stopReason"), usage)
        return LLMResult(text=text, stop_reason=resp.get("stopReason"), usage=usage)

    def stats(self) -> dict:
        return {"calls": self.calls, "input_tokens": self.input_tokens,
                "output_tokens": self.output_tokens, "model": self.model}
