// Split out from guard.ts so lower-level modules (e.g. api-token.ts, for the 429 thrown by
// the rate limiter) can throw a structured HTTP error without importing guard.ts itself —
// guard.ts imports api-token.ts, so the reverse import would be circular.
export class AuthError extends Error {
  status: number
  headers?: HeadersInit
  constructor(message: string, status: number, headers?: HeadersInit) {
    super(message)
    this.status = status
    this.headers = headers
  }
}
