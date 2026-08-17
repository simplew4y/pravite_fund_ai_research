"""Typed compute failures mapped to stable response error codes."""


class ComputeOperationError(RuntimeError):
    def __init__(self, message: str, code: str = "compute_failed") -> None:
        super().__init__(message)
        self.code = code


class DependencyUnavailableError(ComputeOperationError):
    def __init__(self, message: str) -> None:
        super().__init__(message, "dependency_unavailable")


class UnsupportedOperationError(ComputeOperationError):
    def __init__(self, operation: str) -> None:
        super().__init__(
            "Unsupported compute operation: {}".format(operation),
            "unsupported_operation",
        )


class ArtifactConflictError(ComputeOperationError):
    def __init__(self, filename: str) -> None:
        super().__init__(
            "Artifact already exists with different content: {}".format(filename),
            "artifact_conflict",
        )


class ProviderNetworkError(ComputeOperationError):
    def __init__(self, message: str) -> None:
        super().__init__(message, "provider_network_error")


class ProviderError(ComputeOperationError):
    def __init__(self, message: str) -> None:
        super().__init__(message, "provider_error")
