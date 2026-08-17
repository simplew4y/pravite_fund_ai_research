export class DomainError extends Error {
  public constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode = 400,
  ) {
    super(message);
    this.name = "DomainError";
  }
}

export class NotFoundError extends DomainError {
  public constructor(resource: string) {
    super(`${resource} was not found`, "not_found", 404);
  }
}

export class ForbiddenError extends DomainError {
  public constructor(message = "Access denied") {
    super(message, "forbidden", 403);
  }
}

export class ConflictError extends DomainError {
  public constructor(message: string, code = "conflict") {
    super(message, code, 409);
  }
}
