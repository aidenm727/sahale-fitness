import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach } from 'vitest'
import { buildApp } from '../server/app'
import { loadConfig, ROOT, type Config } from '../server/config'
import { openDatabase, type OpenedDatabase } from '../server/db'
import { FitnessService, type Clock } from '../server/fitness/service'

export const MIGRATIONS = join(ROOT, 'server', 'db', 'migrations')

const dirs: string[] = []
export function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'sahale-test-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

/** A fixed moment: Monday 2026-10-05 10:00 local. */
export const NOW = new Date(2026, 9, 5, 10, 0, 0)
export function clockAt(now = NOW): Clock {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
  const d = now
  return { now: d, today: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`, timeZone: tz }
}

export async function openDb(path = ':memory:'): Promise<OpenedDatabase> {
  const opened = await openDatabase(path, { migrationsDir: MIGRATIONS })
  if (!opened.db) throw new Error(`db failed: ${opened.status.error}`)
  return opened
}

export function services(opened: OpenedDatabase) {
  const fitness = new FitnessService(opened.db)
  fitness.ensureLibrary(NOW)
  return { fitness }
}

export async function harness(opts: { dbPath?: string; now?: () => Date; config?: Partial<Config> } = {}) {
  const config = { ...loadConfig({ SAHALE_DATA_DIR: tempDir() }), serveStatic: false, ...opts.config }
  const database = await openDb(opts.dbPath)
  const { app, ctx } = await buildApp({ config, database, now: opts.now ?? (() => NOW) })
  ctx.services!.fitness.ensureLibrary(NOW)
  const call = async (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, body?: unknown) => {
    // Like the UI: a JSON content-type only when there is a body.
    const payload = body !== undefined ? JSON.stringify(body) : method === 'GET' || method === 'DELETE' ? undefined : '{}'
    const headers = { 'x-sahale-client': '1', host: '127.0.0.1:4310', ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) }
    const res = await app.inject({ method, url, headers, ...(payload !== undefined ? { payload } : {}) })
    return { status: res.statusCode, body: res.body ? (JSON.parse(res.body) as any) : undefined, raw: res.body } // eslint-disable-line @typescript-eslint/no-explicit-any
  }
  return { app, ctx, database, call, s: ctx.services!, clock: clockAt() }
}
