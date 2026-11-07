import { useState } from 'react'
import { CalendarPlus, Copy, Pencil } from 'lucide-react'
import { Link, useNavigate, useParams } from 'react-router'
import { fmtSets } from '@shared/fitness/derive'
import { fmt } from '@/lib/time'
import { useFitness, useFitnessView } from '@/state/fitness'
import { Page, PageHeader, Section, SubNav } from '@/ui/Page'
import { NotFound } from '@/domains/NotFound'
import { PlanDialog, TemplateEditor } from './editors'
import { CustomTag, FitnessUnavailable, LastTime, OriginTag, PrescriptionText, StartButton } from './parts'

/** One reusable workout: its prescription, what happened last time, and when (if ever) it's planned. */
export function WorkoutPage() {
  const { templateId = '' } = useParams()
  const f = useFitnessView()
  const navigate = useNavigate()
  const [editing, setEditing] = useState(false)
  const [planning, setPlanning] = useState(false)
  if (!f) return <FitnessUnavailable />
  const w = f.templateById[templateId]
  if (!w) return <NotFound what="workout" />
  const block = f.snap.blocks.find((b) => b.id === w.blockId)
  const siblings = f.snap.templates.filter((x) => x.blockId === w.blockId)
  const plans = w.planIds.map((id) => f.planById[id]).filter(Boolean)
  const history = f.sessions.filter((s) => s.templateId === w.id).slice(0, 8)
  const duplicate = () =>
    useFitness
      .getState()
      .write<{ snapshot: never; id?: string }>('POST', `/api/fitness/templates/${w.id}/duplicate`)
      .then((r) => r.id && navigate(`/workouts/${r.id}`))
      .catch(() => undefined)

  return (
    <Page>
      <PageHeader
        eyebrow={`Fitness · ${block ? block.name : 'Workout'}`}
        title={w.name}
        lede={
          <>
            {w.focus ? `${w.focus}. ` : ''}
            {block ? `Workout ${siblings.findIndex((x) => x.id === w.id) + 1} of ${siblings.length} in ${block.name}. ` : 'Not in a block. '}
            {w.lastDoneAt ? `Last done ${fmt.day(w.lastDoneAt)}.` : 'Not done yet.'} {f.nextTemplate?.id === w.id && <span className="tag tag-domain">next</span>} <OriginTag origin={w.origin} />
          </>
        }
        actions={
          <>
            <button className="btn btn-ghost" onClick={() => setEditing(true)}>
              <Pencil /> Edit
            </button>
            <button className="btn btn-ghost" onClick={() => void duplicate()}>
              <Copy /> Duplicate
            </button>
            <button className="btn" onClick={() => setPlanning(true)}>
              <CalendarPlus /> Plan
            </button>
            <StartButton templateId={w.id} />
          </>
        }
      />
      <SubNav />

      <div className="cols">
        <div className="stack">
          <Section title="Prescription" meta={`${w.items.length} exercise${w.items.length === 1 ? '' : 's'} · last time from this workout when there is one`}>
            {w.items.length ? (
              <div className="logger">
                {w.items.map((i, n) => (
                  <section key={i.id} className={`lg-ex${n === 0 && f.ex[i.exerciseId]?.main ? ' main' : ''}`}>
                    <header className="lg-head">
                      <div>
                        <Link to={`/exercises/${i.exerciseId}`} className="lg-name">
                          {f.name(i.exerciseId)}
                        </Link>{' '}
                        <CustomTag ex={f.ex[i.exerciseId]} />
                        <div className="lg-target">
                          <PrescriptionText p={i} ex={f.ex[i.exerciseId]} />
                          {i.note && <span className="muted">· {i.note}</span>}
                        </div>
                      </div>
                      <LastTime f={f} exerciseId={i.exerciseId} templateId={w.id} />
                    </header>
                  </section>
                ))}
              </div>
            ) : (
              <p className="empty-line">
                No exercises yet.{' '}
                <button className="link-btn" onClick={() => setEditing(true)}>
                  Add some
                </button>
                .
              </p>
            )}
            {w.notes && <p className="sec-lede workout-notes">{w.notes}</p>}
          </Section>

          <Section title="Logged" meta={history.length ? `Last ${history.length} times` : undefined}>
            {history.length ? (
              <div className="rows hist-rows">
                {history.map((s) => {
                  const main = s.entries[0]
                  return (
                    <Link key={s.id} to={`/history/${s.id}`}>
                      <span className="mono muted">{fmt.monthDay(s.date)}</span>
                      <span className="strong">{s.name}</span>
                      <span className="mono">{main ? `${f.ex[main.exerciseId]?.short ?? f.name(main.exerciseId)} ${fmtSets(main.sets)}` : ''}</span>
                      <span className="muted">{s.durationMin} min</span>
                      <span />
                      <span className="muted hist-note">{s.note ?? ''}</span>
                    </Link>
                  )
                })}
              </div>
            ) : (
              <p className="empty-line">Not logged yet. Press Start workout when you’re at the gym.</p>
            )}
          </Section>
        </div>

        <aside className="stack aside">
          <Section title="Planned" quiet>
            {plans.length ? (
              plans.map((p) => (
                <p key={p.id} className="aside-text">
                  <button className="link-btn" onClick={() => setPlanning(true)}>
                    {fmt.date(p.date)}
                  </button>
                  {p.status === 'missed' ? ' — missed, nothing logged' : ''}
                  {p.custom ? ' — adjusted for that day' : ''}
                </p>
              ))
            ) : (
              <p className="aside-text">Not on any date. That’s normal — start it whenever you train, or Plan it for a day to see it on Today and the overview.</p>
            )}
          </Section>
        </aside>
      </div>
      {editing && <TemplateEditor template={w} onClose={() => setEditing(false)} />}
      {planning && <PlanDialog template={plans.length ? undefined : w} plan={plans[0]} onClose={() => setPlanning(false)} />}
    </Page>
  )
}
