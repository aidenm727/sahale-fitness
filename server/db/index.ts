/**
 * Opening the database and evolving its schema without losing the owner's data.
 *
 * - Migrations are the SQL files drizzle-kit generated in server/db/migrations,
 *   applied in order and recorded in `__drizzle_migrations` (drizzle's format).
 * - Applied migrations are verified by hash; an edited or unknown migration
 *   stops startup instead of guessing.
 * - Before applying anything to an existing database, a full online backup is
 *   written to the backups directory.
 * - All pending migrations run in one transaction with foreign keys switched
 *   off at the connection level (so table rebuilds can't cascade-delete rows),
 *   and `foreign_key_check` must pass before COMMIT.
 */
import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import * as schema from './schema'

export type Db = BetterSQLite3Database<typeof schema>
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]
export type DbLike = Db | Tx

export interface MigrationInfo {
  tag: string
  when: number
  hash: string
}

export interface DbStatus {
  state: 'ready' | 'migration_failed' | 'open_failed'
  path: string
  applied: string[]
  available: string[]
  /** Migrations applied during this startup. */
  appliedNow: string[]
  backup?: string
  error?: string
}

export interface OpenedDatabase {
  sqlite: Database.Database
  db: Db
  status: DbStatus
}

const MIGRATIONS_TABLE = '__drizzle_migrations'

export function readMigrations(migrationsDir: string): MigrationInfo[] {
  const journal = JSON.parse(readFileSync(join(migrationsDir, 'meta', '_journal.json'), 'utf8')) as { entries: { tag: string; when: number }[] }
  const files = readMigrationFiles({ migrationsFolder: migrationsDir })
  return journal.entries.map((e, i) => ({ tag: e.tag, when: e.when, hash: files[i].hash }))
}

function sqlFor(migrationsDir: string, tag: string): string[] {
  return readFileSync(join(migrationsDir, `${tag}.sql`), 'utf8')
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter(Boolean)
}

/** UTC, sortable: 20261005-150825Z */
function stamp(d = new Date()): string {
  return `${d.toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-')}Z`
}

export async function backupDatabase(sqlite: Database.Database, backupsDir: string, label: string): Promise<string> {
  mkdirSync(backupsDir, { recursive: true, mode: 0o700 })
  const target = join(backupsDir, `sahale-${stamp()}-${label}.db`)
  await sqlite.backup(target)
  return target
}

function configure(sqlite: Database.Database) {
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('synchronous = FULL')
  sqlite.pragma('busy_timeout = 5000')
  sqlite.pragma('foreign_keys = ON')
}

function appliedMigrations(sqlite: Database.Database): { hash: string; when: number }[] {
  const exists = sqlite.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(MIGRATIONS_TABLE)
  if (!exists) return []
  return (sqlite.prepare(`SELECT hash, created_at AS "when" FROM ${MIGRATIONS_TABLE} ORDER BY created_at`).all() as { hash: string; when: number | string }[]).map((r) => ({
    hash: r.hash,
    when: Number(r.when),
  }))
}

function hasUserTables(sqlite: Database.Database): boolean {
  return !!sqlite.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' LIMIT 1`).get()
}

/** Apply pending migrations. Throws (after rolling back) if anything is off. */
export async function migrateDatabase(
  sqlite: Database.Database,
  opts: { migrationsDir: string; backupsDir?: string },
): Promise<{ applied: string[]; appliedNow: string[]; available: string[]; backup?: string }> {
  const local = readMigrations(opts.migrationsDir)
  const applied = appliedMigrations(sqlite)

  for (const row of applied) {
    const match = local.find((m) => m.when === row.when)
    if (!match) {
      throw new Error(
        `The database has a migration (${new Date(row.when).toISOString()}) that this copy of Sahale does not have. It may have been created by a newer version; refusing to continue.`,
      )
    }
    if (match.hash !== row.hash) {
      throw new Error(`Migration ${match.tag} was changed after it was applied to this database. Restore the original file instead of editing applied migrations.`)
    }
  }

  const last = applied.length ? applied[applied.length - 1].when : -Infinity
  const pending = local.filter((m) => m.when > last)
  const done = local.filter((m) => m.when <= last).map((m) => m.tag)
  if (!pending.length) return { applied: done, appliedNow: [], available: local.map((m) => m.tag) }

  let backup: string | undefined
  if (opts.backupsDir && hasUserTables(sqlite)) {
    backup = await backupDatabase(sqlite, opts.backupsDir, `before-${pending[0].tag}`)
  }

  sqlite.pragma('foreign_keys = OFF')
  try {
    sqlite.exec('BEGIN IMMEDIATE')
    try {
      sqlite.exec(`CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)`)
      const record = sqlite.prepare(`INSERT INTO ${MIGRATIONS_TABLE} (hash, created_at) VALUES (?, ?)`)
      for (const m of pending) {
        for (const stmt of sqlFor(opts.migrationsDir, m.tag)) sqlite.exec(stmt)
        record.run(m.hash, m.when)
      }
      const violations = sqlite.pragma('foreign_key_check') as unknown[]
      if (violations.length) throw new Error(`Migration would leave ${violations.length} broken references; rolled back.`)
      sqlite.exec('COMMIT')
    } catch (e) {
      sqlite.exec('ROLLBACK')
      throw e
    }
  } finally {
    sqlite.pragma('foreign_keys = ON')
  }
  return { applied: [...done, ...pending.map((m) => m.tag)], appliedNow: pending.map((m) => m.tag), available: local.map((m) => m.tag), backup }
}

/**
 * Open (creating if needed) and migrate. Never throws: a failure is reported in
 * `status` so the runtime can still start and explain what's wrong.
 */
export async function openDatabase(path: string, opts: { migrationsDir: string; backupsDir?: string }): Promise<OpenedDatabase | { sqlite: null; db: null; status: DbStatus }> {
  const status: DbStatus = { state: 'ready', path, applied: [], available: [], appliedNow: [] }
  let sqlite: Database.Database
  try {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    const isNew = path === ':memory:' || !existsSync(path)
    sqlite = new Database(path)
    configure(sqlite)
    if (!isNew) sqlite.prepare('SELECT count(*) FROM sqlite_master').get()
  } catch (e) {
    return { sqlite: null, db: null, status: { ...status, state: 'open_failed', error: (e as Error).message } }
  }
  try {
    const result = await migrateDatabase(sqlite, opts)
    Object.assign(status, result)
  } catch (e) {
    status.state = 'migration_failed'
    status.error = (e as Error).message
    try {
      status.available = readMigrations(opts.migrationsDir).map((m) => m.tag)
    } catch {
      /* the error above already explains it */
    }
    sqlite.close()
    return { sqlite: null, db: null, status }
  }
  return { sqlite, db: drizzle(sqlite, { schema }), status }
}
