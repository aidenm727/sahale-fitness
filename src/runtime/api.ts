/**
 * The browser's only door into the runtime. Every request carries the owner's
 * timezone (so "today" matches) and the header the server requires for writes.
 * Errors keep their meaning: unreachable runtime, database problems and
 * validation are all distinct.
 */
export const TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone

export type ApiErrorKind = 'unreachable' | 'database' | 'invalid' | 'conflict' | 'other'

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly kind: ApiErrorKind
  readonly body?: Record<string, unknown>

  constructor(status: number, code: string, message: string, body?: Record<string, unknown>) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.body = body
    this.kind =
      status === 0 || code === 'runtime_unreachable'
        ? 'unreachable'
        : ['db_unavailable', 'migration_failed', 'db_error'].includes(code)
          ? 'database'
          : status === 400
            ? 'invalid'
            : status === 409
              ? 'conflict'
              : 'other'
  }
}

const unreachable = () => new ApiError(0, 'runtime_unreachable', 'The runtime isn’t reachable. Start it with `npm run dev` (or `npm run server`).')

function headers(body: boolean): HeadersInit {
  return { 'x-sahale-client': '1', 'x-sahale-timezone': TIME_ZONE, ...(body ? { 'content-type': 'application/json' } : {}) }
}

async function failure(res: Response): Promise<ApiError> {
  const text = await res.text().catch(() => '')
  try {
    const body = JSON.parse(text) as Record<string, unknown>
    return new ApiError(res.status, String(body.code ?? 'error'), String(body.message ?? res.statusText), body)
  } catch {
    // The dev proxy answers 5xx with plain text when the runtime is down.
    if (res.status >= 500) return unreachable()
    return new ApiError(res.status, 'error', text.slice(0, 200) || res.statusText)
  }
}

export async function api<T>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown, opts: { keepalive?: boolean } = {}): Promise<T> {
  let res: Response
  try {
    // keepalive lets a last save finish even while the page is being closed.
    res = await fetch(path, { method, headers: headers(body !== undefined), body: body === undefined ? undefined : JSON.stringify(body), keepalive: opts.keepalive })
  } catch {
    throw unreachable()
  }
  if (!res.ok) throw await failure(res)
  return (await res.json()) as T
}
