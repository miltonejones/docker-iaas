/**
 * Standard error class for service-layer validation and business-logic errors.
 * Services throw this; route handlers catch it and map to HTTP status codes.
 * This replaces the HttpError previously defined in databaseManagement.ts.
 */
export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = 'HttpError';
  }
}
