export interface ApiErrorOptions {
  statusCode?: number;
  code?: string;
  details?: unknown;
}

export class ApiError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly details?: unknown;

  constructor(message: string, options: ApiErrorOptions = {}) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = options.statusCode ?? 500;
    this.code = options.code ?? 'UNHANDLED_ERROR';
    this.details = options.details;
    Error.captureStackTrace(this, this.constructor);
  }
}
