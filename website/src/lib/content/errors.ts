export class ContentError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "ContentError";
    this.code = code;
    this.details = details;
  }
}

export function asContentError(error: unknown, fallbackCode = "CONTENT_ERROR") {
  if (error instanceof ContentError) return error;
  if (error instanceof Error) {
    return new ContentError(fallbackCode, error.message, { cause: error.name });
  }
  return new ContentError(fallbackCode, String(error));
}
