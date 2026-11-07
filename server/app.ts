/**
 * The Fitness server: a JSON API over the Fitness service, runtime health, and the built UI.
 * Bound to loopback by default.
 */
import fastifyStatic from '@fastify/static'
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ZodError } from 'zod'
import { isTimeZone, localDate } from '../shared/dates'
import type { Config } from './config'
import type { DbStatus, OpenedDatabase } from './db'
import { AppError } from './errors'
import type { Clock } from './clock'
import { FitnessService } from './fitness/service'
import { registerFitnessRoutes } from './routes/fitness'
import { registerRuntimeRoutes } from './routes/runtime'

export interface Services {
  fitness: FitnessService
}

export interface AppContext {
  config: Config
  dbStatus: DbStatus
  database: OpenedDatabase | null
  services: Services | null
  startedAt: Date
  clock(req: FastifyRequest): Clock
  /** The services, or a 503 explaining why the database isn't usable. */
  need(): Services
}

export interface AppOptions {
  config: Config
  database: OpenedDatabase | { sqlite: null; db: null; status: DbStatus }
  now?: () => Date
  logger?: boolean
}

const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i

/**
 * The tailnet login Tailscale Serve vouched for, or null. Serve deletes any client-sent
 * Tailscale-User-* / Tailscale-Funnel-Request headers, then sets Tailscale-User-Login only
 * for an identified, untagged peer and marks Funnel traffic with Tailscale-Funnel-Request.
 * (tailscale/tailscale ipn/ipnlocal/serve.go, addTailscaleIdentityHeaders)
 */
function tailnetLogin(req: FastifyRequest): string | null {
  if (req.headers['tailscale-funnel-request'] !== undefined) return null
  const login = req.headers['tailscale-user-login']
  return typeof login === 'string' && login ? login : null
}

export async function buildApp(opts: AppOptions): Promise<{ app: FastifyInstance; ctx: AppContext }> {
  const app = Fastify({ logger: opts.logger ? { level: 'info', redact: ['req.headers.authorization', 'req.headers.cookie'] } : false, bodyLimit: 1024 * 1024 })
  const database = opts.database.db ? (opts.database as OpenedDatabase) : null
  const services: Services | null = database ? { fitness: new FitnessService(database.db) } : null
  const now = opts.now ?? (() => new Date())
  const fallbackTz = Intl.DateTimeFormat().resolvedOptions().timeZone

  const ctx: AppContext = {
    config: opts.config,
    dbStatus: opts.database.status,
    database,
    services,
    startedAt: now(),
    clock(req) {
      const header = req.headers['x-sahale-timezone']
      const timeZone = isTimeZone(header) ? header : fallbackTz
      const at = now()
      return { now: at, today: localDate(at, timeZone), timeZone }
    },
    need() {
      if (services) return services
      const s = opts.database.status
      throw new AppError(503, s.state === 'migration_failed' ? 'migration_failed' : 'db_unavailable', s.state === 'migration_failed' ? `The database schema couldn't be migrated: ${s.error}` : `The database couldn't be opened: ${s.error}`)
    },
  }

  const { publicOrigin, ownerLogin } = opts.config
  const publicHost = publicOrigin ? new URL(publicOrigin).host : null

  /*
   * Two ways in: the owner's browser on this machine (a loopback Host), or — when
   * publicOrigin is set — the owner's own devices through Tailscale Serve, which forwards
   * the browser's Host unchanged and vouches for who is asking.
   */
  app.addHook('onRequest', async (req, reply) => {
    const host = req.headers.host?.toLowerCase() ?? ''
    const proxied = publicHost !== null && host === publicHost
    if (!proxied && !LOOPBACK_HOST.test(host)) return reply.code(403).send({ code: 'forbidden_host', message: 'This server only answers on localhost.' })
    if (proxied) {
      const login = tailnetLogin(req)
      if (!login || !ownerLogin || login.toLowerCase() !== ownerLogin.toLowerCase()) {
        return reply.code(403).send({
          code: 'forbidden_identity',
          message: login ? 'This tailnet identity is not the configured owner.' : 'No tailnet identity came with this request. This server only answers its owner through Tailscale Serve.',
        })
      }
    }
    if (!req.url.startsWith('/api/')) return
    const origin = req.headers.origin
    const allowedOrigin = proxied ? origin === publicOrigin : origin === `http://${req.headers.host}` || opts.config.allowedOrigins.includes(origin ?? '')
    if (origin && !allowedOrigin) {
      return reply.code(403).send({ code: 'forbidden_origin', message: 'Cross-origin requests are not allowed.' })
    }
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers['x-sahale-client'] !== '1') {
      return reply.code(403).send({ code: 'missing_client_header', message: 'Mutating requests must come from the app.' })
    }
  })

  app.setErrorHandler((err: unknown, req: FastifyRequest, reply: FastifyReply) => {
    if (err instanceof AppError) return reply.code(err.status).send({ code: err.code, message: err.message, details: err.details })
    if (err instanceof ZodError) {
      return reply.code(400).send({ code: 'invalid_input', message: err.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; '), details: err.issues })
    }
    const e = err as { name?: string; code?: string; statusCode?: number; message?: string }
    if (e.name === 'SqliteError') {
      req.log.error({ code: e.code }, 'database error')
      return reply.code(503).send({ code: 'db_error', message: `Database error (${e.code}). Nothing was changed.` })
    }
    if (e.statusCode && e.statusCode < 500) return reply.code(e.statusCode).send({ code: e.code ?? 'bad_request', message: e.message })
    req.log.error(err)
    return reply.code(500).send({ code: 'internal', message: 'The server hit an unexpected error. Nothing was reported as saved.' })
  })

  await registerRuntimeRoutes(app, ctx)
  await registerFitnessRoutes(app, ctx)

  if (opts.config.serveStatic && existsSync(join(opts.config.distDir, 'index.html'))) {
    await app.register(fastifyStatic, { root: opts.config.distDir, wildcard: false })
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ code: 'not_found', message: 'No such API route' })
      return reply.sendFile('index.html')
    })
  } else {
    app.setNotFoundHandler((_req, reply) => reply.code(404).send({ code: 'not_found', message: 'No such route' }))
  }

  return { app, ctx }
}
