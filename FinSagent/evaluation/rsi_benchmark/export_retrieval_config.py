"""Export a credential-free, loopback-only config for candidate retrieval runs."""

from __future__ import annotations

import argparse
import os
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import yaml


SENSITIVE_PARTS = ("api_key", "apikey", "secret", "token", "password", "credential")
LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}


def sanitize(value: Any, key: str = "") -> Any:
    lowered = key.lower()
    if any(part in lowered for part in SENSITIVE_PARTS):
        return None
    if isinstance(value, dict):
        return {
            child_key: cleaned
            for child_key, child_value in value.items()
            if (cleaned := sanitize(child_value, str(child_key))) is not None
        }
    if isinstance(value, list):
        return [sanitize(item) for item in value]
    if isinstance(value, str) and (lowered.endswith("url") or lowered.endswith("endpoint")):
        parsed = urlparse(value)
        if parsed.scheme in {"http", "https"} and parsed.hostname not in LOOPBACK_HOSTS:
            return None
    return value


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    config = yaml.safe_load(args.source.read_text(encoding="utf-8"))
    cleaned = sanitize(config)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(args.out, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        yaml.safe_dump(cleaned, handle, allow_unicode=True, sort_keys=True)
    print(len(cleaned))


if __name__ == "__main__":
    main()
