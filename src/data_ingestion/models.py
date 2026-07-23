"""Data models for ingestion pipeline."""

from dataclasses import dataclass, field
from typing import List


@dataclass
class IngestResult:
    ok: bool
    chunk_count: int = 0
    table_count: int = 0
    file_checksum: str = ""
    error: str = ""
