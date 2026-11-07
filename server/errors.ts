/** An error with an HTTP status and a stable code the browser can branch on. */
export class AppError extends Error {
  readonly status: number
  readonly code: string
  readonly details?: unknown

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message)
    this.name = 'AppError'
    this.status = status
    this.code = code
    this.details = details
  }
}

export const notFound = (what: string) => new AppError(404, 'not_found', `${what} not found`)
export const conflict = (code: string, message: string, details?: unknown) => new AppError(409, code, message, details)
export const invalid = (message: string, details?: unknown) => new AppError(400, 'invalid_input', message, details)
