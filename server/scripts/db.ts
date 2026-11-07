/**
 * Database maintenance.
 *
 *   npm run db -- status        schema state and row counts
 *   npm run db -- migrate       apply pending migrations (with a backup first)
 *   npm run db -- backup        write a consistent copy to the backups folder
 *   npm run db -- demo:load     add demo Fitness data (marked origin=demo)
 *   npm run db -- demo:clear    remove only demo rows; your data stays
 *   npm run db -- reset --yes   back up, then delete the database (fresh start)
 *
 * Stop the server before `reset`.
 */
import { existsSync, rmSync } from 'node:fs'
import { loadConfig } from '../config'
import { backupDatabase, openDatabase } from '../db'
import { FitnessService } from '../fitness/service'
import { localDate } from '../../shared/dates'

async function main() {
  const [cmd, ...rest] = process.argv.slice(2)
  const config = loadConfig()
  const clock = () => {
    const now = new Date()
    return { now, today: localDate(now), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }
  }

  if (cmd === 'reset') {
    if (!rest.includes('--yes')) {
      console.error(`This deletes ${config.dbPath} (after backing it up). Re-run with --yes to confirm.`)
      process.exit(2)
    }
    const running = await fetch(`http://127.0.0.1:${config.port}/api/runtime/health`, { signal: AbortSignal.timeout(1500) }).then(
      () => true,
      () => false,
    )
    if (running) {
      console.error(`Sahale is running on port ${config.port}. Stop it first — deleting the database under a running server loses data.`)
      process.exit(1)
    }
    if (existsSync(config.dbPath)) {
      const opened = await openDatabase(config.dbPath, { migrationsDir: config.migrationsDir })
      if (opened.sqlite) {
        console.log(`backup: ${await backupDatabase(opened.sqlite, config.backupsDir, 'before-reset')}`)
        opened.sqlite.close()
      } else {
        console.error(`Could not open the database to back it up (${opened.status.error}). Copy ${config.dbPath} yourself, then delete it.`)
        process.exit(1)
      }
      for (const f of [config.dbPath, `${config.dbPath}-wal`, `${config.dbPath}-shm`]) rmSync(f, { force: true })
      console.log(`deleted ${config.dbPath}. The next start creates a fresh database.`)
    } else console.log('No database to reset.')
    return
  }

  const opened = await openDatabase(config.dbPath, { migrationsDir: config.migrationsDir, backupsDir: config.backupsDir })
  const s = opened.status
  if (!opened.db) {
    console.error(`database ${s.state}: ${s.error}`)
    process.exit(1)
  }
  const fitness = new FitnessService(opened.db)
  fitness.ensureLibrary()
  switch (cmd) {
    case 'status':
    case 'migrate':
    case undefined: {
      const snap = fitness.snapshot(clock())
      console.log(`path       ${s.path}\nstate      ${s.state}\nmigrations ${s.applied.join(', ')}${s.appliedNow.length ? ` (applied now: ${s.appliedNow.join(', ')})` : ''}${s.backup ? `\nbackup     ${s.backup}` : ''}`)
      console.log(`rows       owner ${snap.counts.owner} · demo ${snap.counts.demo} · sessions ${snap.sessions.length} · workouts ${snap.templates.length} · plans ${snap.plans.length} · notes ${snap.notes.length}`)
      break
    }
    case 'backup':
      console.log(await backupDatabase(opened.sqlite, config.backupsDir, 'manual'))
      break
    case 'demo:load':
      fitness.loadDemo(clock())
      console.log('Demo data loaded.')
      break
    case 'demo:clear':
      fitness.clearDemo()
      console.log('Demo data removed.')
      break
    default:
      console.error(`Unknown command: ${cmd}`)
      process.exit(2)
  }
  opened.sqlite.close()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
