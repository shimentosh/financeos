/**
 * An expected failure with an HTTP meaning. Domain code throws these; the
 * exception filter turns them into JSON responses. Anything else is a bug and
 * becomes a 500 with the details kept out of the response.
 */
export class DomainError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, message: string, code = "error", details?: unknown) {
    super(message);
    this.name = "DomainError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const notFound = (entity: string) => new DomainError(404, `${entity} not found`, "not_found");
export const badRequest = (message: string, code = "bad_request", details?: unknown) => new DomainError(400, message, code, details);
export const conflict = (message: string, code = "conflict", details?: unknown) => new DomainError(409, message, code, details);
export const forbidden = (message = "You do not have permission to do that", code = "forbidden") => new DomainError(403, message, code);
export const unprocessable = (message: string, code = "unprocessable", details?: unknown) => new DomainError(422, message, code, details);
export const unauthorized = (message = "Sign in to continue") => new DomainError(401, message, "unauthorized");
export const tooManyRequests = (message = "Too many requests, try again shortly") => new DomainError(429, message, "rate_limited");
/** Over the plan's limit: the response says which limit and how to lift it (upgrade, buy credits). */
export const planLimit = (message: string, details?: { limit: string; plan: string; used?: number; allowed?: number | null }) =>
  new DomainError(402, message, "plan_limit", details);

export function assertFound<T>(value: T | null | undefined, entity: string): T {
  if (value === null || value === undefined) throw notFound(entity);
  return value;
}
