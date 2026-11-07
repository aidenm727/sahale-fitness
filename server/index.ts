/**
 * Start the runtime:  npm run server  (or npm run dev / npm start)
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { buildApp } from './app'
import { loadConfig, LOOPBACK_HOSTS } from './config'
import { openDatabase } from './db'
import { FitnessService } from './fitness/service'

async function main() {
  const config = loadConfig()
  const database = await openDatabase(config.dbPath, { migrationsDir: config.migrationsDir, backupsDir: config.backupsDir })
  if (database.db) new FitnessService(database.db).ensureLibrary(new Date())
  const { app } = await buildApp({ config, database, logger: process.env.SAHALE_LOG === '1' })
  await app.listen({ host: config.host, port: config.port })

  const s = database.status
  console.log(`\n  Sahale Fitness  http://${config.host}:${config.port}${config.serveStatic ? '  (serving the built UI)' : ''}`)
  console.log(`  data       ${config.dataDir}`)
  console.log(`  database   ${s.state}${s.appliedNow.length ? ` — applied ${s.appliedNow.join(', ')}` : ''}${s.backup ? ` (backup: ${s.backup})` : ''}${s.error ? ` — ${s.error}` : ''}`)
  if (config.publicOrigin) {
    console.log(`  private    ${config.publicOrigin}  (only ${config.ownerLogin}, via Tailscale Serve)`)
    if (!config.serveStatic || !existsSync(join(config.distDir, 'index.html'))) console.warn(`\n  NOTE: the built UI isn't being served, so ${config.publicOrigin} has no pages. Use npm run build && npm start.`)
  }
  if (!LOOPBACK_HOSTS.has(config.host)) console.warn(`\n  WARNING: listening on ${config.host}, not loopback. Sahale has no authentication.`)
  console.log('')

  const stop = async () => {
    await app.close()
    database.sqlite?.close()
    process.exit(0)
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
