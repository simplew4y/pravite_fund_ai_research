"""PDF-only private fund research demo.

This package is intentionally small: it proves the minimum QA -> memo ->
citation trace loop before the larger FinSagent / MCP integration is wired in.
"""

from .demo import PdfResearchDemo
from .llm import LLMConfig, OpenAICompatibleChatClient, load_llm_config
from .models import Citation, Document, DocumentVersion, Evidence, EvidenceLocation

__all__ = [
    "Citation",
    "Document",
    "DocumentVersion",
    "Evidence",
    "EvidenceLocation",
    "LLMConfig",
    "OpenAICompatibleChatClient",
    "PdfResearchDemo",
    "load_llm_config",
]
