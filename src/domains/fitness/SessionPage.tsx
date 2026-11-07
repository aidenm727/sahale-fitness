import { useState } from 'react'
import { ArrowLeft, ArrowRight, Pencil, Trash2 } from 'lucide-react'
import { Link, Navigate, useNavigate, useParams } from 'react-router'
import { e1rm, fmtLoad, fmtReps, performed, topSet, volume } from '@shared/fitness/derive'
import { fmt } from '@/lib/time'
import { act, useFitness, useFitnessView } from '@/state/fitness'
import { Page, PageHeader, Section, Stat, SubNav } from '@/ui/Page'
import { NotFound } from '@/domains/NotFound'
import { AddExercise, SessionNote, SetRow } from './logger'
import { FitnessUnavailable, OriginTag, readinessLabel } from './parts'

export function SessionPage() {
  const { sessionId } = useParams()
  const f = useFitnessView()
  const navigate = useNavigate()
  const [editing, setEditing] = useState(false)
  if (!f) return <FitnessUnavailable />
  if (f.snap.active?.id === sessionId) return <Navigate to="/today" replace />
  const sessions = f.sessions
  const idx = sessions.findIndex((s) => s.id === sessionId)
  const s = sessions[idx]
  if (!s) return <NotFound what="session" />
  // Compare with the last time this same workout was done (by template, else by name).
  const prevSame = sessions.slice(idx + 1).find((x) => (s.templateId ? x.templateId === s.templateId : x.name === s.name))
  const template = s.templateId ? f.templateById[s.templateId] : undefined
  const newer = sessions[idx - 1]
  const older = sessions[idx + 1]
  const sets = s.entries.reduce((n, e) => n + performed(e.sets).length, 0)

  return (
    <Page>
      <PageHeader
        eyebrow={`Fitness · ${fmt.date(s.date)}`}
        title={s.name}
        lede={
          <>
            {fmt.long(s.date)} at {fmt.time(s.date)}
            {s.block ? ` — block ${s.block}, ${s.deload ? 'deload week' : `week ${s.week}`}` : ''}. {s.origin === 'demo' ? 'Demo history.' : 'Logged by you.'}{' '}
            {template ? (
              <>
                From <Link to={`/workouts/${template.id}`}>{template.name}</Link> — later edits to it don’t change this log.
              </>
            ) : null}{' '}
            <OriginTag origin={s.origin} />
          </>
        }
        actions={
          <button className="btn btn-ghost" onClick={() => setEditing((e) => !e)} aria-pressed={editing}>
            <Pencil /> {editing ? 'Done editing' : 'Edit sets'}
          </button>
        }
      />
      <SubNav />

      <div className="stat-row session-stats">
        <Stat label="Duration" value={s.durationMin} unit="min" />
        <Stat label="Volume" value={(volume(s, f.ex) / 1000).toFixed(1)} unit="k lb" />
        <Stat label="Working sets" value={sets} />
        <Stat label="Readiness" value={readinessLabel(s.readiness)} />
      </div>

      <div className="cols" style={{ marginTop: 32 }}>
        <div className="stack">
          {editing ? (
            <Section title="Edit sets" meta="Changes save as you make them">
              <div className="logger">
                {s.entries.map((e) => (
                  <section key={e.id} className="lg-ex">
                    <header className="lg-head">
                      <span className="lg-name">{f.name(e.exerciseId)}</span>
                      <button className="btn btn-ghost btn-sm" onClick={() => window.confirm(`Remove ${f.name(e.exerciseId)} from this session?`) && act('DELETE', `/api/fitness/entries/${e.id}`)}>
                        <Trash2 /> Remove
                      </button>
                    </header>
                    <div className="lg-sets">
                      {e.sets.map((x, i) => (
                        <SetRow key={x.id} set={x} index={i} ex={f.ex[e.exerciseId]} hint={{}} mode="history" onDelete={() => act('DELETE', `/api/fitness/sets/${x.id}`)} />
                      ))}
                      <button className="lg-add" onClick={() => act('POST', `/api/fitness/entries/${e.id}/sets`)}>
                        + Add set
                      </button>
                    </div>
                  </section>
                ))}
                <AddExercise sessionId={s.id} f={f} />
              </div>
            </Section>
          ) : (
            <Section title="Exercises">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Exercise</th>
                    <th>Prescribed</th>
                    <th>Done</th>
                    <th className="num">Top set e1RM</th>
                    <th className="num">vs. last time</th>
                  </tr>
                </thead>
                <tbody>
                  {s.entries.map((e) => {
                    const ex = f.ex[e.exerciseId]
                    const t = topSet(e)
                    const prevEntry = prevSame?.entries.find((x) => x.exerciseId === e.exerciseId)
                    const pt = prevEntry && topSet(prevEntry)
                    const cur = t?.weight && t.reps !== undefined && !ex?.bodyweight ? Math.round(e1rm(t.weight, t.reps)) : null
                    const prev = pt?.weight && pt.reps !== undefined && !ex?.bodyweight ? Math.round(e1rm(pt.weight, pt.reps)) : null
                    const delta = cur !== null && prev !== null ? cur - prev : null
                    return (
                      <tr key={e.id}>
                        <td className="strong">
                          <Link to={`/exercises/${e.exerciseId}`}>{f.name(e.exerciseId)}</Link>
                          {e.note && <div className="faint">{e.note}</div>}
                        </td>
                        <td className="mono muted nowrap">
                          {e.target ? `${e.target.sets} × ${fmtReps(e.target)}${e.target.load !== undefined && e.target.load ? ` @ ${fmtLoad(e.target.load)}` : ''}${e.target.rpe !== undefined ? ` · RPE ${e.target.rpe}` : ''}` : 'added'}
                          {e.target?.adjustedBy === 'sahale' && (
                            <span className="adj-mark" title={e.target.adjustmentNote}>
                              adjusted mid-workout
                            </span>
                          )}
                        </td>
                        <td>
                          <div className="set-chips">
                            {performed(e.sets).map((x, i) => (
                              <span key={i} className="lg-chip mono" title={x.note}>
                                {ex?.bodyweight && !x.weight ? 'BW' : fmtLoad(x.weight ?? 0)}×{x.reps}
                                {x.rpe ? <span className="faint"> @{x.rpe}</span> : null}
                                {x.note ? <span className="faint"> ✎</span> : null}
                              </span>
                            ))}
                          </div>
                        </td>
                        <td className="num mono">{cur ?? '—'}</td>
                        <td className={`num mono ${delta && delta > 0 ? 'up' : ''}`}>{delta === null ? '—' : delta === 0 ? '±0' : `${delta > 0 ? '+' : ''}${delta}`}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </Section>
          )}
        </div>
        <aside className="stack aside">
          <Section title="Note" quiet>
            <SessionNote key={s.id} id={s.id} initial={s.note ?? ''} />
          </Section>
          <Section title="Around it" quiet>
            <div className="around">
              {newer && (
                <Link to={`/history/${newer.id}`} className="btn btn-sm">
                  {newer.name} · {fmt.monthDay(newer.date)} <ArrowRight />
                </Link>
              )}
              {older && (
                <Link to={`/history/${older.id}`} className="btn btn-sm">
                  <ArrowLeft /> {older.name} · {fmt.monthDay(older.date)}
                </Link>
              )}
            </div>
          </Section>
          <Section title="Remove" quiet>
            <button
              className="btn btn-sm btn-ghost danger"
              onClick={() => {
                if (!window.confirm('Delete this session from your history? This can’t be undone (back up first if unsure).')) return
                useFitness
                  .getState()
                  .write('DELETE', `/api/fitness/sessions/${s.id}`)
                  .then(() => navigate('/history'))
                  .catch(() => undefined)
              }}
            >
              <Trash2 /> Delete session
            </button>
          </Section>
        </aside>
      </div>
    </Page>
  )
}
