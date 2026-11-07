/**
 * Runtime: what is actually running — the server and its database — and the
 * controls for them.
 */
import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, RefreshCw } from 'lucide-react'
import { fmt } from '@/lib/time'
import { api, ApiError } from '@/runtime/api'
import { useFitness } from '@/state/fitness'
import { useRuntime } from '@/state/runtime'
import { Page, PageHeader, Section } from '@/ui/Page'

interface RuntimeInfo {
  version: string
  startedAt: string
  listen: { host: string; port: number }
  dataDir: string
  db: { state: string; path: string; applied: string[]; appliedNow: string[]; backup?: string; error?: string; sizeBytes: number | null; backupsDir: string; counts: Record<string, number> | null }
}

export function RuntimePage() {
  const [info, setInfo] = useState<RuntimeInfo | null>(null)
  const [error, setError] = useState<ApiError | null>(null)
  const [tick, setTick] = useState(0)
  const reload = useCallback(() => setTick((t) => t + 1), [])
  useEffect(() => {
    let alive = true
    api<RuntimeInfo>('GET', '/api/runtime').then(
      (r) => {
        if (!alive) return
        setInfo(r)
        setError(null)
      },
      (e: ApiError) => {
        if (!alive) return
        setError(e)
        void useRuntime.getState().refresh()
      },
    )
    return () => {
      alive = false
    }
  }, [tick])
  return (
    <Page>
      <PageHeader
        eyebrow="Fitness · Runtime"
        title="Runtime"
        lede={<>The server and the database that holds your Fitness records.</>}
        actions={
          <button className="btn" onClick={reload}>
            <RefreshCw /> Refresh
          </button>
        }
      />

      {error && (
        <div className="runtime-problem big">
          <AlertTriangle />
          <div>
            <b>{error.kind === 'unreachable' ? 'The runtime isn’t reachable' : 'Runtime status unavailable'}</b>
            <p>{error.message}</p>
            <p className="faint">
              Start it with <code>npm run dev</code> (UI + runtime) or <code>npm run server</code>.
            </p>
          </div>
        </div>
      )}

      {info && (
        <div className="stat-row runtime-stats">
          <div className="stat">
            <span className="stat-label">Server</span>
            <span className="stat-value rt-ok">Running</span>
            <span className="stat-delta">
              {info.listen.host}:{info.listen.port} · since {fmt.time(info.startedAt)}
            </span>
          </div>
          <div className="stat">
            <span className="stat-label">Database</span>
            <span className={`stat-value ${info.db.state === 'ready' ? 'rt-ok' : 'rt-bad'}`}>{info.db.state === 'ready' ? 'Ready' : info.db.state.replace('_', ' ')}</span>
            <span className="stat-delta">
              schema {info.db.applied.at(-1) ?? '—'}
              {info.db.sizeBytes ? ` · ${(info.db.sizeBytes / 1024).toFixed(0)} KB` : ''}
            </span>
          </div>
        </div>
      )}

      {info?.db.error && (
        <div className="runtime-problem">
          <AlertTriangle />
          <div>
            <b>Database problem</b>
            <p>{info.db.error}</p>
            <p className="faint">Your data file was left untouched. Pre-migration backups are in {info.db.backupsDir}.</p>
          </div>
        </div>
      )}

      {info && <DataSection info={info} reload={reload} />}
    </Page>
  )
}

/* ------------------------------------------------------------------ */

function DataSection({ info, reload }: { info: RuntimeInfo; reload: () => void }) {
  const counts = useFitness((s) => s.snapshot?.counts)
  const [msg, setMsg] = useState<string | null>(null)
  const write = async (path: string, confirm?: string) => {
    if (confirm && !window.confirm(confirm)) return
    try {
      await useFitness.getState().write('POST', path)
      setMsg(null)
    } catch (e) {
      setMsg((e as Error).message)
    }
    reload()
  }
  return (
    <Section title="Data" quiet>
      <dl className="rt-paths">
        <dt>Data folder</dt>
        <dd className="mono">{info.dataDir}</dd>
        <dt>Database</dt>
        <dd className="mono">{info.db.path}</dd>
        <dt>Backups</dt>
        <dd className="mono">{info.db.backupsDir}</dd>
      </dl>
      {counts && (
        <p className="aside-text">
          Fitness records: <b>{counts.owner}</b> yours · <b>{counts.demo}</b> demo.
        </p>
      )}
      <div className="rt-actions">
        <button
          className="btn btn-sm"
          onClick={async () => {
            try {
              const r = await api<{ path: string }>('POST', '/api/runtime/backup')
              setMsg(`Backed up to ${r.path}`)
            } catch (e) {
              setMsg((e as Error).message)
            }
          }}
        >
          Back up now
        </button>
        {counts?.demo ? (
          <button className="btn btn-sm btn-ghost" onClick={() => void write('/api/fitness/demo/clear', 'Remove all demo Fitness data? Your own records stay.')}>
            Clear demo data
          </button>
        ) : (
          <button className="btn btn-sm btn-ghost" onClick={() => void write('/api/fitness/demo/load')}>
            Load demo data
          </button>
        )}
      </div>
      {msg && <p className="aside-text mono">{msg}</p>}
      <p className="aside-foot">
        Full reset: stop the server, then <code>npm run db -- reset --yes</code>. It backs up first.
      </p>
    </Section>
  )
}
