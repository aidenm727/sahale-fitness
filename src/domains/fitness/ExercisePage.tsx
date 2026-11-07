import { useMemo, useState } from 'react'
import { Pencil } from 'lucide-react'
import { Link, useParams } from 'react-router'
import { bestSetEver, e1rm, e1rmSeries, fmtClock, fmtLoad, fmtPrescriptionFull, fmtSets, restSecFor, topSet } from '@shared/fitness/derive'
import { fmt } from '@/lib/time'
import { useFitnessView } from '@/state/fitness'
import { TrendChart } from '@/ui/charts'
import { Page, PageHeader, Section, Stat, SubNav } from '@/ui/Page'
import { NotFound } from '@/domains/NotFound'
import { ExerciseEditor } from './editors'
import { CustomTag, FitnessUnavailable } from './parts'

export function ExercisePage() {
  const { exerciseId = '' } = useParams()
  const f = useFitnessView()
  const [editing, setEditing] = useState(false)
  const series = useMemo(() => (f ? e1rmSeries(f.sessions, exerciseId) : []), [f, exerciseId])
  const history = useMemo(() => (f ? f.sessions.flatMap((s) => s.entries.filter((e) => e.exerciseId === exerciseId).map((e) => ({ s, e }))).slice(0, 12) : []), [f, exerciseId])
  if (!f) return <FitnessUnavailable />
  const ex = f.ex[exerciseId]
  if (!ex) return <NotFound what="exercise" />

  const best = bestSetEver(f.sessions, exerciseId)
  const target = f.snap.goal?.targets.find((t) => t.exerciseId === exerciseId)?.target
  const nextWorkout = f.todayPlan && f.todayPlan.status !== 'done' ? f.todayPlan : f.nextTemplate
  const todayItem = nextWorkout?.items.find((i) => i.exerciseId === exerciseId)
  const usedIn = f.snap.templates.filter((w) => w.items.some((i) => i.exerciseId === exerciseId))
  const first = series[0]
  const last = series[series.length - 1]
  const bands = f.snap.blocks
    .filter((b) => b.status !== 'planned' && first && b.endDate >= first.date.slice(0, 10))
    .map((b) => ({ from: `${b.startDate}T00:00:00`, to: `${b.status === 'current' ? f.snap.today : b.endDate}T23:59:59`, label: `B${b.n} ${b.name}` }))
    .filter((_, i) => i % 2 === 0)

  return (
    <Page>
      <PageHeader
        eyebrow={`Fitness · ${ex.pattern}`}
        title={ex.name}
        lede={
          <>
            {ex.equipment || ex.pattern}. {restSecFor(ex) ? `Rest ${fmtClock(restSecFor(ex))} between sets.` : 'No rest timer.'} <CustomTag ex={ex} />{' '}
            {todayItem && nextWorkout ? (
              <>
                Next: <b className="mono">{fmtPrescriptionFull(todayItem, ex)}</b> in {nextWorkout.name}.
              </>
            ) : null}
          </>
        }
        actions={
          <button className="btn btn-ghost" onClick={() => setEditing(true)}>
            <Pencil /> Edit
          </button>
        }
      />
      <SubNav />

      {!ex.bodyweight && series.length > 0 && (
        <div className="stat-row">
          <Stat label="Est. 1RM now" value={last.value} unit="lb" delta={`${last.value - first.value >= 0 ? '+' : ''}${last.value - first.value} since ${fmt.monthDay(first.date)}`} tone="up" />
          <Stat label="Best set" value={best ? `${fmtLoad(best.set.weight ?? 0)}×${best.set.reps}` : '—'} delta={best ? fmt.date(best.session.date) : undefined} />
          {target ? <Stat label="Goal" value={target} unit="lb" delta={`${Math.max(0, target - last.value)} lb to go`} /> : <Stat label="Sessions" value={series.length} />}
          <Stat label="Last trained" value={history[0] ? fmt.day(history[0].s.date) : '—'} delta={history[0] ? history[0].s.name : undefined} />
        </div>
      )}

      <div className="cols" style={{ marginTop: 32 }}>
        <div className="stack">
          {!ex.bodyweight && series.length > 1 && (
            <Section title="Estimated 1RM" meta="Top set per session · Epley · deloads excluded">
              <TrendChart data={series} height={240} target={target ? { value: target, label: `goal ${target}` } : undefined} bands={bands} ariaLabel={`${ex.name} estimated one-rep max over time`} title={ex.name} unit=" lb" />
            </Section>
          )}
          <Section title="Recent sets" meta={history.length ? `Last ${history.length} sessions` : undefined}>
            {history.length ? (
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Session</th>
                    <th>Sets</th>
                    <th className="num">Top e1RM</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map(({ s, e }) => {
                    const t = topSet(e)
                    return (
                      <tr key={`${s.id}-${e.id}`}>
                        <td className="mono muted">{fmt.monthDay(s.date)}</td>
                        <td>
                          <Link to={`/history/${s.id}`}>{s.name}</Link>
                          {s.deload && <span className="faint"> · deload</span>}
                        </td>
                        <td className="mono">{fmtSets(e.sets)}</td>
                        <td className="num mono">{t?.weight && t.reps !== undefined && !ex.bodyweight ? Math.round(e1rm(t.weight, t.reps)) : '—'}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            ) : (
              <p className="empty-line">No logged sets yet.</p>
            )}
          </Section>
        </div>
        <aside className="stack aside">
          <Section title="Cues" quiet>
            {ex.cues.length ? (
              <ul className="cues">
                {ex.cues.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            ) : (
              <p className="aside-text">No cues yet.</p>
            )}
          </Section>
          {ex.note && (
            <Section title="Note" quiet>
              <p className="quote">{ex.note}</p>
            </Section>
          )}
          <Section title="In your workouts" quiet>
            {usedIn.length ? (
              usedIn.map((w) => (
                <p key={w.id} className="aside-text">
                  <Link to={`/workouts/${w.id}`}>{w.name}</Link> — {fmtPrescriptionFull(w.items.find((i) => i.exerciseId === exerciseId)!, ex)}
                </p>
              ))
            ) : (
              <p className="aside-text">Not in any saved workout.</p>
            )}
          </Section>
        </aside>
      </div>
      {editing && <ExerciseEditor exercise={ex} onClose={() => setEditing(false)} />}
    </Page>
  )
}
