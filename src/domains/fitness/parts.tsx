import { useMemo, useState } from 'react'
import { AlertTriangle, CalendarPlus, Check, CircleDot, Play, Plus, RotateCcw } from 'lucide-react'
import { Link, useNavigate } from 'react-router'
import { e1rmSeries, fmtPrescription, fmtRpe, fmtSetList, performed, previousFor } from '@shared/fitness/derive'
import type { Exercise, Origin, Prescription } from '@shared/fitness/types'
import { dayDiff, fmt } from '@/lib/time'
import { useFitness, useFitnessView, type FitnessView } from '@/state/fitness'
import { TrendChart } from '@/ui/charts'
import { PlanDialog, TemplateEditor } from './editors'

/* ------------------------------------------------------------------ */
/* Loading / unavailable                                               */
/* ------------------------------------------------------------------ */

/** Shown instead of a Fitness page until the runtime has answered. */
export function FitnessUnavailable() {
  const status = useFitness((s) => s.status)
  const error = useFitness((s) => s.error)
  if (status !== 'error' || !error) return <div className="page fitness-wait">Loading Fitness from the runtime…</div>
  return (
    <div className="page">
      <div className="runtime-problem big">
        <AlertTriangle />
        <div>
          <b>{error.kind === 'unreachable' ? 'The runtime isn’t running' : error.kind === 'database' ? 'The database isn’t usable' : 'Fitness couldn’t load'}</b>
          <p>{error.message}</p>
          {error.kind === 'unreachable' && (
            <p className="faint">
              Fitness lives in a local database served by the runtime. Start everything with <code>npm run dev</code>.
            </p>
          )}
          <div className="runtime-problem-actions">
            <button className="btn btn-sm" onClick={() => void useFitness.getState().load()}>
              <RotateCcw /> Try again
            </button>
            <Link to="/runtime" className="btn btn-sm btn-ghost">
              Runtime status
            </Link>
          </div>
        </div>
      </div>
    </div>
  )
}

export function OriginTag({ origin }: { origin: Origin }) {
  return origin === 'demo' ? <span className="tag tag-quiet origin-demo">demo</span> : null
}

/** Marks exercises the owner created (vs. the built-in library). */
export function CustomTag({ ex }: { ex?: Exercise }) {
  return ex?.origin === 'owner' ? <span className="tag tag-quiet">custom</span> : null
}

/** Demo data is visible as such, and removable without touching the owner's records. */
export function DemoBanner({ f }: { f: FitnessView }) {
  const [busy, setBusy] = useState(false)
  if (!f.snap.counts.demo) return null
  return (
    <div className="demo-banner">
      <span>
        <b>Demo data is loaded</b> — {f.snap.counts.demo} demo records{f.snap.counts.owner ? ` alongside ${f.snap.counts.owner} of yours` : ''}. Anything you log or edit is yours and stays when demo data is cleared.
      </span>
      <button
        className="btn btn-sm"
        disabled={busy}
        onClick={() => {
          if (!window.confirm('Remove all demo Fitness data? Your own records stay.')) return
          setBusy(true)
          useFitness
            .getState()
            .write('POST', '/api/fitness/demo/clear')
            .catch(() => undefined)
            .finally(() => setBusy(false))
        }}
      >
        Clear demo data
      </button>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Workouts                                                            */
/* ------------------------------------------------------------------ */

/** "3 × 5–8 · RPE 8 · 185 lb" */
export function PrescriptionText({ p, ex }: { p: Prescription; ex?: Exercise }) {
  return (
    <>
      <span className="mono">{fmtPrescription(p, ex)}</span>
      {p.rpe !== undefined && <span className="muted"> {fmtRpe(p.rpe)}</span>}
    </>
  )
}

/** What happened last time for an exercise — preferring the same workout. */
export function LastTime({ f, exerciseId, templateId, excludeSessionId, align = 'right' }: { f: FitnessView; exerciseId: string; templateId?: string; excludeSessionId?: string; align?: 'right' | 'left' }) {
  const prev = previousFor(f.sessions, exerciseId, templateId, excludeSessionId)
  if (!prev) {
    return (
      <div className={`last-time ${align}`}>
        <span className="label">Last time</span>
        <span className="faint">—</span>
      </div>
    )
  }
  return (
    <div className={`last-time ${align}`}>
      <span className="label">
        Last time · <Link to={`/history/${prev.session.id}`}>{fmt.monthDay(prev.session.date)}</Link>
        {!prev.sameWorkout && <span className="faint"> · {prev.session.name}</span>}
      </span>
      <span className="set-chips">
        {fmtSetList(prev.entry.sets, f.ex[exerciseId]?.bodyweight).map((x, i) => (
          <span key={i} className="lg-chip mono">
            {x}
          </span>
        ))}
      </span>
    </div>
  )
}

/** Start a workout and go to the logger. With one already live, this resumes it instead. */
export function useStart() {
  const navigate = useNavigate()
  const active = useFitness((s) => s.snapshot?.active)
  return {
    active,
    start: async (body: { templateId?: string; planId?: string; name?: string; startedAt?: string }) => {
      if (active) return navigate('/today')
      try {
        await useFitness.getState().write('POST', '/api/fitness/sessions', body)
        navigate('/today')
      } catch {
        /* shown by the write-error notice */
      }
    },
  }
}

export function StartButton({ templateId, planId, label = 'Start workout', primary = true, small }: { templateId?: string; planId?: string; label?: string; primary?: boolean; small?: boolean }) {
  const { active, start } = useStart()
  const busy = useFitness((s) => s.busy > 0)
  const resumes = !!active
  return (
    <button className={`btn${primary ? ' btn-primary' : ''}${small ? ' btn-sm' : ''}`} disabled={busy && !resumes} onClick={() => void start({ templateId, planId })} title={resumes ? `${active!.name} is in progress` : undefined}>
      <Play /> {resumes ? 'Resume workout' : label}
    </button>
  )
}

/** Overview card: the live workout, else today's plan, else the next workout in the block. */
export function WorkoutCard() {
  const f = useFitnessView()!
  const [editing, setEditing] = useState(false)
  const [planning, setPlanning] = useState(false)
  const active = f.snap.active
  const today = f.todayPlan
  const todayDone = today?.status === 'done'
  const shownPlan = today && !todayDone ? today : undefined
  const template = shownPlan?.templateId ? f.templateById[shownPlan.templateId] : shownPlan ? undefined : f.nextTemplate
  const items = shownPlan?.items ?? template?.items ?? []
  const templateId = shownPlan?.templateId ?? template?.id

  if (active) {
    const done = active.entries.reduce((n, e) => n + performed(e.sets).length, 0)
    const total = active.entries.reduce((n, e) => n + e.sets.length, 0)
    return (
      <div className="today panel">
        <div className="today-head">
          <div>
            <div className="label">Workout in progress · since {fmt.time(active.date)}</div>
            <h3 className="today-title">{active.name}</h3>
          </div>
          <div className="today-when">
            <span className="tag tag-accent">
              <CircleDot /> Live · {done}/{total} sets
            </span>
          </div>
        </div>
        <div className="today-foot">
          <Link className="btn btn-primary" to="/today">
            <Play /> Resume workout
          </Link>
        </div>
      </div>
    )
  }

  if (!shownPlan && !template) {
    return (
      <div className="today panel">
        <div className="label">Next workout</div>
        <h3 className="today-title">{f.snap.templates.length ? 'Pick a workout' : 'No workouts yet'}</h3>
        <p className="aside-text">
          {f.snap.templates.length
            ? 'Start any of your saved workouts, or an empty one.'
            : 'Create reusable workouts like Upper A and Lower A in your block, then start whichever comes next when you get to the gym.'}
        </p>
        <div className="today-foot">
          <button className="btn btn-primary" onClick={() => setEditing(true)}>
            <Plus /> New workout
          </button>
          <Link className="btn" to="/today">
            <Play /> Start a workout
          </Link>
        </div>
        {editing && <TemplateEditor onClose={() => setEditing(false)} />}
      </div>
    )
  }

  const title = shownPlan?.name ?? template!.name
  return (
    <div className="today panel">
      {todayDone && today?.sessionId && (
        <div className="today-logged">
          <Check /> {today.name} is logged for today ·{' '}
          <Link to={`/history/${today.sessionId}`}>view</Link>
        </div>
      )}
      <div className="today-head">
        <div>
          <div className="label">
            {shownPlan ? 'Planned for today' : 'Next workout'}
            {f.programBlock && !shownPlan ? ` · ${f.programBlock.name}` : ''}
          </div>
          <h3 className="today-title">
            <Link to={templateId ? `/workouts/${templateId}` : '/program'}>{title}</Link>
          </h3>
          {(shownPlan?.focus ?? template?.focus) && <div className="muted">{shownPlan?.focus ?? template?.focus}</div>}
        </div>
        <div className="today-when">
          {(shownPlan ?? template) && <OriginTag origin={(shownPlan ?? template)!.origin} />}
          {shownPlan?.custom && <span className="tag tag-quiet">adjusted for today</span>}
          {!shownPlan && template?.lastDoneAt && <span className="today-slot">last done {fmt.day(template.lastDoneAt)}</span>}
          {!shownPlan && template && template.planIds.length > 0 && <span className="today-slot">planned {fmt.day(f.planById[template.planIds[0]].date)}</span>}
        </div>
      </div>

      <table className="tbl today-tbl">
        <thead>
          <tr>
            <th>Exercise</th>
            <th>Prescription</th>
            <th>Last time</th>
          </tr>
        </thead>
        <tbody>
          {items.map((p) => {
            const ex = f.ex[p.exerciseId]
            const prev = previousFor(f.sessions, p.exerciseId, templateId)
            return (
              <tr key={p.id}>
                <td className="strong">
                  <Link to={`/exercises/${p.exerciseId}`}>{f.name(p.exerciseId)}</Link>
                  {p.adjustedBy === 'sahale' && (
                    <span className="adj-mark" title={p.adjustmentNote}>
                      adjusted
                    </span>
                  )}
                </td>
                <td className="num-left">
                  <PrescriptionText p={p} ex={ex} />
                  {p.note && <span className="muted"> · {p.note}</span>}
                </td>
                <td className="mono muted">{prev ? fmtSetList(prev.entry.sets, ex?.bodyweight).join(', ') : '—'}</td>
              </tr>
            )
          })}
          {!items.length && (
            <tr>
              <td colSpan={3} className="muted">
                No exercises yet — edit the workout to add some.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <div className="today-foot">
        <StartButton planId={shownPlan?.id} templateId={shownPlan ? undefined : template?.id} />
        <Link className="btn btn-ghost" to="/today">
          Choose another
        </Link>
        {template && !shownPlan && (
          <button className="btn btn-ghost" onClick={() => setPlanning(true)}>
            <CalendarPlus /> Plan
          </button>
        )}
      </div>
      {planning && template && <PlanDialog template={template} onClose={() => setPlanning(false)} />}
    </div>
  )
}

/** The block's workouts in their normal order, with the next one marked. */
export function ProgramList({ f }: { f: FitnessView }) {
  if (!f.program.length) return null
  return (
    <ol className="program-list">
      {f.program.map((w) => (
        <li key={w.id} className={w.id === f.nextTemplate?.id ? 'next' : ''}>
          <Link to={`/workouts/${w.id}`}>{w.name}</Link>
          <span className="faint">{w.id === f.nextTemplate?.id ? 'next' : w.lastDoneAt ? fmt.day(w.lastDoneAt) : 'not yet'}</span>
        </li>
      ))}
    </ol>
  )
}

/* ------------------------------------------------------------------ */
/* Lift progress (small multiples)                                     */
/* ------------------------------------------------------------------ */

export function LiftProgress({ f, lift, height = 92 }: { f: FitnessView; lift: string; height?: number }) {
  const data = useMemo(() => e1rmSeries(f.sessions, lift).filter((p) => dayDiff(p.date) <= 120), [f, lift])
  const target = f.snap.goal?.targets.find((t) => t.exerciseId === lift)?.target
  if (!data.length) {
    return (
      <Link to={`/exercises/${lift}`} className="lift">
        <div className="lift-head">
          <span className="lift-name">{f.name(lift)}</span>
          {target && <span className="lift-target">goal {target}</span>}
        </div>
        <div className="lift-empty">No sets logged yet.</div>
      </Link>
    )
  }
  const first = data[0].value
  const last = data[data.length - 1].value
  const weeks = Math.round(dayDiff(data[0].date, data[data.length - 1].date) / 7)
  return (
    <Link to={`/exercises/${lift}`} className="lift">
      <div className="lift-head">
        <span className="lift-name">{f.name(lift)}</span>
        {target && <span className="lift-target">goal {target}</span>}
      </div>
      <div className="lift-value">
        {last}
        <small>lb est.</small>
        {data.length > 1 && (
          <span className="lift-delta">
            {last - first >= 0 ? '+' : ''}
            {last - first} in {weeks} wk
          </span>
        )}
      </div>
      {data.length > 1 && <TrendChart data={data} height={height} compact target={target ? { value: target, label: '' } : undefined} ariaLabel={`${f.name(lift)} estimated 1RM`} title={f.name(lift)} unit=" lb" area />}
    </Link>
  )
}

export function GoalMeters({ f }: { f: FitnessView }) {
  const targets = f.snap.goal?.targets ?? []
  return (
    <div className="goal-meters">
      {targets.map((t) => {
        const cur = e1rmSeries(f.sessions, t.exerciseId).at(-1)?.value ?? 0
        const ex = f.ex[t.exerciseId]
        return (
          <div key={t.exerciseId} className="goal-meter">
            <div className="goal-meter-row">
              <span>{ex?.short ?? ex?.name ?? t.exerciseId}</span>
              <span className="mono">
                {cur || '—'} <span className="faint">/ {t.target}</span>
              </span>
            </div>
            <div className="meter meter-thin">
              <span style={{ width: `${Math.min(100, (cur / t.target) * 100)}%` }} />
            </div>
          </div>
        )
      })}
    </div>
  )
}

/** The lifts worth charting: goal targets first, else the main lifts that have history. */
export function chartLifts(f: FitnessView): string[] {
  const goal = f.snap.goal?.targets.map((t) => t.exerciseId) ?? []
  const mains = f.snap.exercises.filter((e) => e.main && !goal.includes(e.id) && e1rmSeries(f.sessions, e.id).length).map((e) => e.id)
  return [...goal, ...mains].slice(0, 4)
}

export function readinessLabel(r?: number) {
  return r ? ['', 'Wrecked', 'Flat', 'Okay', 'Good', 'Great'][r] : '—'
}
