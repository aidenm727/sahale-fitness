import { useMemo, useState } from 'react'
import { Plus } from 'lucide-react'
import { Link, useNavigate } from 'react-router'
import { fmtSets, topSet, volume } from '@shared/fitness/derive'
import type { SessionLog } from '@shared/fitness/types'
import { dayKey, fmt } from '@/lib/time'
import { useFitness, useFitnessView } from '@/state/fitness'
import { Heatmap, type HeatDatum } from '@/ui/charts'
import { Page, PageHeader, Section, SubNav } from '@/ui/Page'
import { Modal } from './editors'
import { DemoBanner, FitnessUnavailable, OriginTag, readinessLabel } from './parts'

function weekStart(d: string) {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7))
  return x
}

export function HistoryPage() {
  const f = useFitnessView()
  const [backfill, setBackfill] = useState(false)
  const sessions = f?.sessions
  const heat = useMemo(() => {
    const m = new Map<string, HeatDatum>()
    if (!f) return m
    for (const s of f.sessions) {
      const k = dayKey(s.date)
      const v = volume(s, f.ex)
      m.set(k, { date: s.date, value: (m.get(k)?.value ?? 0) + v, tip: `${s.name} · ${Math.round(v / 100) / 10}k lb` })
    }
    return m
  }, [f])

  const weeks = useMemo(() => {
    const groups = new Map<string, { start: Date; sessions: SessionLog[] }>()
    for (const s of sessions ?? []) {
      const ws = weekStart(s.date)
      const k = dayKey(ws)
      if (!groups.has(k)) groups.set(k, { start: ws, sessions: [] })
      groups.get(k)!.sessions.push(s)
    }
    return [...groups.values()]
  }, [sessions])

  if (!f) return <FitnessUnavailable />
  const total = f.sessions.length
  const avgDur = Math.round(f.sessions.reduce((a, s) => a + s.durationMin, 0) / Math.max(1, total))
  const missed = f.snap.plans.filter((p) => p.status === 'missed').length

  return (
    <Page>
      <PageHeader
        eyebrow="Fitness · History"
        title="History"
        lede={
          total ? (
            <>
              {total} workout{total > 1 ? 's' : ''} logged, averaging {avgDur} minutes.{missed ? ` ${missed} planned date${missed > 1 ? 's' : ''} passed without a workout — nothing was logged for ${missed > 1 ? 'them' : 'it'}.` : ''}
            </>
          ) : (
            <>No workouts yet. Start one from Today, or backfill one you did without the app.</>
          )
        }
        actions={
          <button className="btn" onClick={() => setBackfill(true)} disabled={!!f.snap.active}>
            <Plus /> Log a past workout
          </button>
        }
      />
      <SubNav />
      <DemoBanner f={f} />

      <Section title="Consistency" meta="Training volume per day · 12 weeks">
        <Heatmap weeks={12} data={heat} ariaLabel="Training volume per day over 12 weeks" legend={['Less', 'More volume']} />
      </Section>

      <Section title="Sessions" meta="Newest first">
        {weeks.map((w) => {
          const s0 = w.sessions[0]
          return (
            <div key={w.start.toISOString()} className="hist-week">
              <div className="hist-week-head">
                <span className="label">Week of {fmt.monthDay(w.start)}</span>
                <span className="faint">{s0.block ? `Block ${s0.block} · ${s0.deload ? 'deload' : `week ${s0.week}`}` : ''}</span>
                <span className="faint mono">{Math.round(w.sessions.reduce((a, s) => a + volume(s, f.ex), 0) / 1000)}k lb</span>
              </div>
              <div className="rows hist-rows">
                {w.sessions.map((s) => {
                  const main = s.entries[0]
                  const t = main && topSet(main)
                  const ex = main ? f.ex[main.exerciseId] : undefined
                  return (
                    <Link key={s.id} to={`/history/${s.id}`}>
                      <span className="mono muted">{fmt.weekday(s.date)}</span>
                      <span className="strong">
                        {s.name}
                        <OriginTag origin={s.origin} />
                      </span>
                      <span className="mono">
                        {main ? `${ex?.short ?? ex?.name ?? main.exerciseId} ${fmtSets(main.sets)}` : ''}
                        {t?.rpe ? <span className="faint"> @{t.rpe}</span> : null}
                      </span>
                      <span className="muted">{s.durationMin} min</span>
                      <span className="muted">{readinessLabel(s.readiness)}</span>
                      <span className="muted hist-note">{s.note ?? ''}</span>
                    </Link>
                  )
                })}
              </div>
            </div>
          )
        })}
      </Section>
      {backfill && <BackfillDialog onClose={() => setBackfill(false)} />}
    </Page>
  )
}

/** Start a workout dated in the past; it opens in the logger like any other. */
function BackfillDialog({ onClose }: { onClose: () => void }) {
  const f = useFitnessView()!
  const navigate = useNavigate()
  const [templateId, setTemplateId] = useState(f.nextTemplate?.id ?? '')
  const [name, setName] = useState('Workout')
  const [date, setDate] = useState(f.snap.today)
  const [time, setTime] = useState('18:00')
  const [error, setError] = useState<string | null>(null)
  const start = async () => {
    const startedAt = new Date(`${date}T${time}:00`).toISOString()
    try {
      await useFitness.getState().write('POST', '/api/fitness/sessions', { startedAt, ...(templateId ? { templateId } : { name }) })
      onClose()
      navigate('/today')
    } catch (e) {
      setError((e as Error).message)
      useFitness.getState().clearWriteError()
    }
  }
  return (
    <Modal
      title="Log a past workout"
      onClose={onClose}
      footer={
        <>
          {error && <span className="form-error">{error}</span>}
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={() => void start()}>
            Open in the logger
          </button>
        </>
      }
    >
      <label className="field">
        <span className="field-label">Workout</span>
        <select className="text-input" value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
          <option value="">— an empty workout —</option>
          {f.snap.templates.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
      </label>
      <div className="field-row">
        {!templateId && (
          <label className="field">
            <span className="field-label">Name</span>
            <input className="text-input" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
        )}
        <label className="field">
          <span className="field-label">Date</span>
          <input className="text-input" type="date" value={date} max={f.snap.today} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label className="field">
          <span className="field-label">Started at</span>
          <input className="text-input" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
        </label>
      </div>
      <p className="field-hint">You’ll fill in sets in the logger, then finish with how long it took. If that workout was planned within a week of this date, it counts for that plan.</p>
    </Modal>
  )
}
