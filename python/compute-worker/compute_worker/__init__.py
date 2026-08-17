"""Pure document-compute worker.

The package intentionally contains no authentication, tenant, queue, or
business-database code.
"""

from .operations import execute_request
from .protocol import PROTOCOL_VERSION, make_health_response, validate_request

__all__ = [
    "PROTOCOL_VERSION",
    "execute_request",
    "make_health_response",
    "validate_request",
]
