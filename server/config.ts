import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

export const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])

export interface Config {
  host: string
  port: number
  dataDir: string
  dbPath: string
  backupsDir: string
  migrationsDir: string
  distDir: string
  serveStatic: boolean
  /** Allowed browser origins (besides same-origin). */
  allowedOrigins: string[]
  /**
   * The one HTTPS origin a private proxy (Tailscale Serve) exposes Sahale on, e.g.
   * https://laptop.example.ts.net. Only the owner's tailnet identity gets in through it.
   */
  publicOrigin: string | null
  /** The Tailscale login allowed in through `publicOrigin`. */
  ownerLogin: string | null
}

/** Where a non-production run keeps its data when SAHALE_DATA_DIR is unset. Per checkout, gitignored. */
const DEV_DATA_DIR = join(ROOT, '.data', 'dev')

const isInside = (path: string, dir: string) => path === dir || path.startsWith(dir.endsWith(sep) ? dir : dir + sep)

/** The path with symlinks resolved as far as it exists; nothing is created or opened. */
function realish(path: string): string {
  const rest: string[] = []
  let cur = path
  for (;;) {
    try {
      return join(realpathSync(cur), ...rest.reverse())
    } catch {
      const parent = dirname(cur)
      if (parent === cur) return path
      rest.push(basename(cur))
      cur = parent
    }
  }
}

/**
 * True when `path` is, or is inside, a data location that holds (or held) real records. These are
 * the owner's real stores, named here so a dev run can't open them.
 */
function isRealStore(path: string): boolean {
  const home = homedir()
  const share = join(home, '.local', 'share')
  const named = (parent: string, match: (name: string) => boolean) => {
    if (!isInside(path, parent) || path === parent) return false
    return match(path.slice(parent.length + 1).split(sep)[0])
  }
  return (
    named(share, (n) => n === 'sahale' || n.startsWith('sahale-') || n === 'aiden-platform') ||
    named('/var/lib', (n) => n.startsWith('sahale')) ||
    isInside(path, join(home, 'sahale-release'))
  )
}

/**
 * Outside production, never open a real store by accident. The only way past is naming the exact
 * resolved path in SAHALE_ALLOW_DATA_DIR, for the pilot and trial scripts that mean it.
 */
function guardDataDir(env: NodeJS.ProcessEnv, dataDir: string): void {
  const real = realish(dataDir)
  if (!isRealStore(dataDir) && !isRealStore(real)) return
  const allow = env.SAHALE_ALLOW_DATA_DIR?.trim()
  if (allow && isAbsolute(allow) && resolve(allow) === dataDir) return
  const via = real === dataDir ? '' : ` (it resolves to ${real})`
  throw new Error(
    `Refusing SAHALE_DATA_DIR=${dataDir}${via}: it is, or is inside, a real Sahale data location. ` +
      `If you mean to use it, set SAHALE_ALLOW_DATA_DIR=${dataDir} (the exact path). Otherwise unset SAHALE_DATA_DIR to use ${DEV_DATA_DIR}.`,
  )
}

function int(value: string | undefined, fallback: number): number {
  const n = Number(value)
  return Number.isInteger(n) && n >= 0 && n <= 65535 ? n : fallback
}

/** A DNS name ending in a letter label: no IPs, no wildcards, no single-label hosts. */
const DNS_NAME = /^([a-z0-9-]+\.)+[a-z][a-z0-9-]*$/

/**
 * SAHALE_PUBLIC_ORIGIN + SAHALE_OWNER_LOGIN: both or neither. Anything malformed stops
 * startup rather than opening a wider door than intended.
 */
function privateAccess(env: NodeJS.ProcessEnv, host: string): Pick<Config, 'publicOrigin' | 'ownerLogin'> {
  const origin = env.SAHALE_PUBLIC_ORIGIN?.trim()
  const login = env.SAHALE_OWNER_LOGIN?.trim()
  if (!origin) {
    if (login) throw new Error('SAHALE_OWNER_LOGIN only applies together with SAHALE_PUBLIC_ORIGIN')
    return { publicOrigin: null, ownerLogin: null }
  }
  let url: URL | null = null
  try {
    url = new URL(origin)
  } catch {
    /* reported below */
  }
  if (!url || url.protocol !== 'https:' || url.origin !== origin.replace(/\/$/, '') || !DNS_NAME.test(url.hostname)) {
    throw new Error(`SAHALE_PUBLIC_ORIGIN must be one HTTPS origin with a DNS name and nothing else, e.g. https://laptop.example.ts.net (got ${JSON.stringify(origin)})`)
  }
  if (!login) throw new Error('SAHALE_PUBLIC_ORIGIN requires SAHALE_OWNER_LOGIN: the Tailscale login allowed in (e.g. you@example.com)')
  // Tailscale Serve sends non-ASCII logins RFC 2047-encoded; a plain ASCII login compares exactly.
  if (!/^[\x21-\x7e]{1,256}$/.test(login)) throw new Error('SAHALE_OWNER_LOGIN must be a plain ASCII Tailscale login without spaces')
  // Identity headers are only trustworthy when nothing but the local proxy can reach the runtime.
  if (!LOOPBACK_HOSTS.has(host)) throw new Error('SAHALE_PUBLIC_ORIGIN requires the runtime to listen on loopback; unset SAHALE_HOST')
  return { publicOrigin: url.origin, ownerLogin: login }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const production = env.NODE_ENV === 'production'
  if (production && !env.SAHALE_DATA_DIR) throw new Error('SAHALE_DATA_DIR must be set explicitly in production')
  const dataDir = env.SAHALE_DATA_DIR ? resolve(env.SAHALE_DATA_DIR) : DEV_DATA_DIR
  if (!isAbsolute(dataDir)) throw new Error('SAHALE_DATA_DIR must resolve to an absolute path')
  if (!production) guardDataDir(env, dataDir)
  const port = int(env.SAHALE_PORT, 4310)
  const host = env.SAHALE_HOST || '127.0.0.1'
  return {
    host,
    port,
    dataDir,
    dbPath: join(dataDir, 'sahale.db'),
    backupsDir: join(dataDir, 'backups'),
    migrationsDir: join(ROOT, 'server', 'db', 'migrations'),
    distDir: join(ROOT, 'dist'),
    serveStatic: env.SAHALE_SERVE_STATIC === '1' || env.NODE_ENV === 'production',
    allowedOrigins: [`http://localhost:5173`, `http://127.0.0.1:5173`, `http://localhost:${port}`, `http://127.0.0.1:${port}`],
    ...privateAccess(env, host),
  }
}
