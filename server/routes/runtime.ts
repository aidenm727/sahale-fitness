import { count, eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { statSync } from 'node:fs'
import type { AppContext } from '../app'
import { backupDatabase } from '../db'
import * as t from '../db/schema'
import { AppError } from '../errors'

export const VERSION = '0.3.1'

export async function registerRuntimeRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get('/api/runtime/health', async () => ({ ok: true, db: ctx.dbStatus.state }))

  app.get('/api/runtime', async () => {
    const db = ctx.database?.db
    const size = (() => {
      try {
        return statSync(ctx.config.dbPath).size
      } catch {
        return null
      }
    })()
    const tally = db
      ? {
          sessions: db.select({ n: count() }).from(t.sessions).get()!.n,
          ownerSessions: db.select({ n: count() }).from(t.sessions).where(eq(t.sessions.origin, 'owner')).get()!.n,
          workouts: db.select({ n: count() }).from(t.templates).get()!.n,
          plans: db.select({ n: count() }).from(t.plans).get()!.n,
        }
      : null
    return {
      version: VERSION,
      startedAt: ctx.startedAt.toISOString(),
      listen: { host: ctx.config.host, port: ctx.config.port },
      dataDir: ctx.config.dataDir,
      db: { ...ctx.dbStatus, sizeBytes: size, backupsDir: ctx.config.backupsDir, counts: tally },
    }
  })

  app.post('/api/runtime/backup', async () => {
    if (!ctx.database) throw new AppError(503, 'db_unavailable', 'The database is not open.')
    return { path: await backupDatabase(ctx.database.sqlite, ctx.config.backupsDir, 'manual') }
  })
}
