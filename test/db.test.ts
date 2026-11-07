import { cpSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { openDatabase, readMigrations } from '../server/db'
import { MIGRATIONS, tempDir } from './helpers'

function tables(path: string): string[] {
  const db = new Database(path, { readonly: true })
  const rows = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all() as { name: string }[]
  db.close()
  return rows.map((r) => r.name)
}

/** A copy of the real migrations folder plus an extra migration. */
function migrationsWith(extraSql: string): string {
  const dir = tempDir()
  cpSync(MIGRATIONS, dir, { recursive: true })
  const journalPath = join(dir, 'meta', '_journal.json')
  const journal = JSON.parse(readFileSync(journalPath, 'utf8'))
  const last = journal.entries.at(-1)
  journal.entries.push({ ...last, idx: last.idx + 1, when: last.when + 1000, tag: '9999_test_extra' })
  writeFileSync(journalPath, JSON.stringify(journal))
  writeFileSync(join(dir, '9999_test_extra.sql'), extraSql)
  return dir
}

describe('migrations', () => {
  it('initialize a fresh database with every table and record what was applied', async () => {
    const dir = tempDir()
    const path = join(dir, 'sahale.db')
    const opened = await openDatabase(path, { migrationsDir: MIGRATIONS, backupsDir: join(dir, 'backups') })
    expect(opened.status.state).toBe('ready')
    expect(opened.status.appliedNow).toEqual(readMigrations(MIGRATIONS).map((m) => m.tag))
    expect(opened.status.backup).toBeUndefined() // nothing to back up yet
    opened.sqlite!.close()
    expect(tables(path)).toEqual(
      expect.arrayContaining(['__drizzle_migrations', 'fitness_templates', 'fitness_template_items', 'fitness_plans', 'fitness_sessions', 'settings']),
    )
  })

  it('are idempotent: reopening applies nothing', async () => {
    const dir = tempDir()
    const path = join(dir, 'sahale.db')
    ;(await openDatabase(path, { migrationsDir: MIGRATIONS })).sqlite!.close()
    const again = await openDatabase(path, { migrationsDir: MIGRATIONS, backupsDir: join(dir, 'backups') })
    expect(again.status.state).toBe('ready')
    expect(again.status.appliedNow).toEqual([])
    again.sqlite!.close()
    expect(existsSync(join(dir, 'backups'))).toBe(false)
  })

  it('back up an existing database before applying a new migration, and keep the data', async () => {
    const dir = tempDir()
    const path = join(dir, 'sahale.db')
    const first = await openDatabase(path, { migrationsDir: MIGRATIONS })
    first.sqlite!.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('owner.thing', '"keep me"', 'x')`).run()
    first.sqlite!.close()

    const extra = migrationsWith('ALTER TABLE `fitness_notes` ADD `color` text;')
    const second = await openDatabase(path, { migrationsDir: extra, backupsDir: join(dir, 'backups') })
    expect(second.status.state).toBe('ready')
    expect(second.status.appliedNow).toEqual(['9999_test_extra'])
    expect(second.status.backup).toMatch(/before-9999_test_extra\.db$/)
    expect(readdirSync(join(dir, 'backups'))).toHaveLength(1)
    expect(second.sqlite!.prepare(`SELECT value FROM settings WHERE key='owner.thing'`).get()).toEqual({ value: '"keep me"' })
    second.sqlite!.close()
  })

  it('roll back entirely when a migration fails, leaving the database as it was', async () => {
    const dir = tempDir()
    const path = join(dir, 'sahale.db')
    ;(await openDatabase(path, { migrationsDir: MIGRATIONS })).sqlite!.close()
    const before = tables(path)

    const bad = migrationsWith('CREATE TABLE `half_done` (`id` text);\n--> statement-breakpoint\nTHIS IS NOT SQL;')
    const result = await openDatabase(path, { migrationsDir: bad, backupsDir: join(dir, 'backups') })
    expect(result.status.state).toBe('migration_failed')
    expect(result.db).toBeNull()
    expect(tables(path)).toEqual(before) // half_done was rolled back
  })

  it('rebuild a parent table (drizzle’s pattern) without cascading deletes into child rows', async () => {
    const dir = tempDir()
    const path = join(dir, 'sahale.db')
    const first = await openDatabase(path, { migrationsDir: MIGRATIONS })
    const db = first.sqlite!
    db.prepare(`INSERT INTO fitness_exercises (id, name, pattern, origin, created_at, updated_at) VALUES ('sq', 'Squat', 'Squat', 'owner', 'x', 'x')`).run()
    db.prepare(`INSERT INTO fitness_templates (id, position, name, origin, created_at, updated_at) VALUES ('w1', 0, 'Lower', 'owner', 'x', 'x')`).run()
    db.prepare(`INSERT INTO fitness_template_items (id, template_id, position, exercise_id, sets, rep_min, rep_max) VALUES ('i1', 'w1', 0, 'sq', 3, 5, 8)`).run()
    db.close()

    const source = readMigrations(MIGRATIONS)
      .map((m) => readFileSync(join(MIGRATIONS, `${m.tag}.sql`), 'utf8'))
      .find((sql) => sql.includes('CREATE TABLE `fitness_templates`'))!
    const create = /CREATE TABLE `fitness_templates` \([\s\S]*?\n\);/.exec(source)![0].replace('`fitness_templates`', '`__new_fitness_templates`')
    const rebuild = [
      'PRAGMA foreign_keys=OFF;',
      create,
      'INSERT INTO `__new_fitness_templates` SELECT * FROM `fitness_templates`;',
      'DROP TABLE `fitness_templates`;',
      'ALTER TABLE `__new_fitness_templates` RENAME TO `fitness_templates`;',
      'PRAGMA foreign_keys=ON;',
    ].join('\n--> statement-breakpoint\n')
    const second = await openDatabase(path, { migrationsDir: migrationsWith(rebuild), backupsDir: join(dir, 'backups') })
    expect(second.status.state).toBe('ready')
    expect(second.sqlite!.prepare(`SELECT id FROM fitness_template_items`).all()).toEqual([{ id: 'i1' }])
    expect(second.sqlite!.pragma('foreign_keys', { simple: true })).toBe(1)
    second.sqlite!.close()
  })

  it('refuse to run when an applied migration file was edited', async () => {
    const dir = tempDir()
    const path = join(dir, 'sahale.db')
    const migrations = tempDir()
    cpSync(MIGRATIONS, migrations, { recursive: true })
    ;(await openDatabase(path, { migrationsDir: migrations })).sqlite!.close()
    const file = join(migrations, `${readMigrations(migrations)[0].tag}.sql`)
    writeFileSync(file, readFileSync(file, 'utf8') + '\n-- edited')
    const result = await openDatabase(path, { migrationsDir: migrations })
    expect(result.status.state).toBe('migration_failed')
    expect(result.status.error).toMatch(/changed after it was applied/)
  })

  it('refuse to run against a database migrated by a newer Sahale', async () => {
    const dir = tempDir()
    const path = join(dir, 'sahale.db')
    const extra = migrationsWith('ALTER TABLE `fitness_notes` ADD `color` text;')
    ;(await openDatabase(path, { migrationsDir: extra })).sqlite!.close()
    const result = await openDatabase(path, { migrationsDir: MIGRATIONS })
    expect(result.status.state).toBe('migration_failed')
    expect(result.status.error).toMatch(/newer version/)
  })
})
