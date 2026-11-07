import { useState } from 'react'
import { ArrowRight, Check, Pencil, Pin, PinOff, Plus, Trash2 } from 'lucide-react'
import { Link } from 'react-router'
import { daysBetween } from '@shared/dates'
import { fmtSets, topSet, volume } from '@shared/fitness/derive'
import { dayDiff, fmt } from '@/lib/time'
import { act, useFitness, useFitnessView, type FitnessView } from '@/state/fitness'
import { Page, PageHeader, Section, SubNav } from '@/ui/Page'
import { BlockEditor, GoalEditor, TemplateEditor } from './editors'
import { chartLifts, DemoBanner, FitnessUnavailable, GoalMeters, LiftProgress, OriginTag, ProgramList, WorkoutCard } from './parts'

export function FitnessOverview() {
  const f = useFitnessView()
  const [editGoal, setEditGoal] = useState(false)
  const [editBlock, setEditBlock] = useState(false)
  if (!f) return <FitnessUnavailable />

  const recent = f.sessions.filter((s) => dayDiff(s.date) <= 14)
  const goal = f.snap.goal
  const block = f.block
  const week = block ? Math.floor(daysBetween(block.startDate, f.snap.today) / 7) + 1 : 0
  const daysToGoal = goal?.date ? daysBetween(f.snap.today, goal.date) : undefined
  const upcoming = f.snap.plans.filter((p) => p.date > f.snap.today && p.status === 'planned').slice(0, 3)
  const nextBlock = f.snap.blocks.find((b) => b.status === 'planned')
  const lifts = chartLifts(f)
  const empty = !goal && !f.snap.blocks.length && !f.snap.templates.length && !f.sessions.length && !f.snap.active
  // Keep the setup steps around until there's something to train with.
  const settingUp = !f.snap.templates.length && !f.sessions.length && !f.snap.active

  return (
    <Page>
      <PageHeader
        eyebrow="Overview"
        title="Fitness"
        lede={
          empty ? (
            <>Nothing recorded yet. Set a goal, create a block and its workouts, or just start a workout. Everything is kept in a local database.</>
          ) : (
            <>
              {block ? (
                <>
                  Block {block.n}, <b>{block.name}</b> — week {week} of {block.weeks}.{' '}
                </>
              ) : (
                'No current training block. '
              )}
              {recent.length} session{recent.length === 1 ? '' : 's'} in the last two weeks
              {daysToGoal !== undefined ? (daysToGoal >= 0 ? `; goal date is ${daysToGoal} days out.` : '; the goal date has passed.') : '.'}
            </>
          )
        }
      />
      <SubNav />
      <DemoBanner f={f} />
      {settingUp && <Onboarding hasGoal={!!goal} hasBlock={f.snap.blocks.length > 0} onGoal={() => setEditGoal(true)} onBlock={() => setEditBlock(true)} />}

      <div className="cols">
        <div className="stack">
          <WorkoutCard />

          {lifts.length > 0 && (
            <Section
              title={goal?.targets.length ? 'Toward the goal' : 'Main lifts'}
              meta="Est. 1RM · deloads excluded"
              actions={
                <Link to="/exercises" className="btn btn-ghost btn-sm">
                  All lifts <ArrowRight />
                </Link>
              }
            >
              <div className="lifts">
                {lifts.map((l) => (
                  <LiftProgress key={l} f={f} lift={l} />
                ))}
              </div>
            </Section>
          )}

          <Section
            title="Recent sessions"
            meta={`${recent.length} in 14 days`}
            actions={
              <Link to="/history" className="btn btn-ghost btn-sm">
                History <ArrowRight />
              </Link>
            }
          >
            {recent.length ? (
              <div className="rows session-rows">
                {recent.map((s) => {
                  const main = s.entries[0]
                  const t = main && topSet(main)
                  const ex = main ? f.ex[main.exerciseId] : undefined
                  return (
                    <Link key={s.id} to={`/history/${s.id}`}>
                      <span className="sr-day">
                        <b>{fmt.dayName(s.date)}</b>
                        <span>{fmt.monthDay(s.date)}</span>
                      </span>
                      <span className="sr-name">
                        {s.name}
                        <OriginTag origin={s.origin} />
                      </span>
                      <span className="sr-main mono">
                        {main ? `${ex?.short ?? ex?.name ?? main.exerciseId} ${fmtSets(main.sets)}` : '—'}
                        {t?.rpe ? <span className="faint"> @{t.rpe}</span> : null}
                      </span>
                      <span className="sr-vol mono muted">{Math.round(volume(s, f.ex) / 1000)}k lb</span>
                      <span className="sr-note muted">{s.note ?? ''}</span>
                    </Link>
                  )
                })}
              </div>
            ) : (
              <p className="empty-line">No sessions in the last two weeks.</p>
            )}
          </Section>
        </div>

        <aside className="stack aside">
          <Section
            title="Goal"
            meta={goal?.date ? `${daysToGoal}d · ${fmt.monthDay(goal.date)}` : undefined}
            quiet
            actions={
              <button className="btn btn-ghost btn-sm" onClick={() => setEditGoal(true)}>
                <Pencil /> {goal ? 'Edit' : 'Set'}
              </button>
            }
          >
            {goal ? (
              <>
                <p className="goal-statement">
                  {goal.statement} <OriginTag origin={goal.origin} />
                </p>
                <GoalMeters f={f} />
              </>
            ) : (
              <p className="aside-text">No goal yet. A goal gives you something to measure your training against.</p>
            )}
          </Section>

          <Section
            title="Program"
            meta={f.programBlock ? `${f.program.length} workout${f.program.length === 1 ? '' : 's'} in order` : undefined}
            quiet
            actions={
              <Link to="/program" className="btn btn-ghost btn-sm">
                Program <ArrowRight />
              </Link>
            }
          >
            {f.programBlock ? (
              <>
                <p className="aside-text">
                  <b>{f.programBlock.name}</b>
                  {f.programBlock.scheme ? ` — ${f.programBlock.scheme}` : ''}
                </p>
                {f.program.length ? <ProgramList f={f} /> : <p className="aside-text">No workouts in this block yet.</p>}
              </>
            ) : (
              <p className="aside-text">
                No current block.{' '}
                <button className="link-btn" onClick={() => setEditBlock(true)}>
                  Plan one
                </button>
                .
              </p>
            )}
            {upcoming.length > 0 && (
              <div className="aside-next">
                <span className="label">Scheduled</span>
                {upcoming.map((p) => (
                  <div key={p.id} className="aside-next-row">
                    <span>{fmt.day(p.date)}</span>
                    <span>{p.name}</span>
                  </div>
                ))}
                {nextBlock && (
                  <div className="aside-next-row faint">
                    <span>Then</span>
                    <span>
                      Block {nextBlock.n} · {nextBlock.name}
                    </span>
                  </div>
                )}
              </div>
            )}
          </Section>

          <WorkingNotes f={f} />
        </aside>
      </div>
      {editGoal && <GoalEditor goal={goal} onClose={() => setEditGoal(false)} />}
      {editBlock && <BlockEditor onClose={() => setEditBlock(false)} />}
    </Page>
  )
}

function Onboarding({ hasGoal, hasBlock, onGoal, onBlock }: { hasGoal: boolean; hasBlock: boolean; onGoal: () => void; onBlock: () => void }) {
  const [plan, setPlan] = useState(false)
  const [loading, setLoading] = useState(false)
  return (
    <div className="panel panel-pad onboarding">
      <div>
        <b>Start Fitness</b>
        <p className="aside-text">Set a goal, create your training block, then its reusable workouts (e.g. Upper A, Lower A). Or load demo history to try things first — demo rows are marked and can be cleared later without touching yours.</p>
      </div>
      <div className="onboarding-actions">
        <button className={`btn${hasGoal ? '' : ' btn-primary'}`} onClick={onGoal}>
          {hasGoal ? <Check /> : null} {hasGoal ? 'Goal set' : 'Set a goal'}
        </button>
        <button className={`btn${hasGoal && !hasBlock ? ' btn-primary' : ''}`} onClick={onBlock}>
          {hasBlock ? <Check /> : null} {hasBlock ? 'Block planned' : 'Plan a training block'}
        </button>
        <button className={`btn${hasGoal && hasBlock ? ' btn-primary' : ''}`} onClick={() => setPlan(true)}>
          Create a workout
        </button>
        <button
          className="btn btn-ghost"
          disabled={loading}
          onClick={() => {
            setLoading(true)
            useFitness
              .getState()
              .write('POST', '/api/fitness/demo/load')
              .catch(() => undefined)
              .finally(() => setLoading(false))
          }}
        >
          Load demo data
        </button>
      </div>
      {plan && <TemplateEditor onClose={() => setPlan(false)} />}
    </div>
  )
}

function WorkingNotes({ f }: { f: FitnessView }) {
  const [draft, setDraft] = useState('')
  const notes = f.snap.notes
  const sorted = [...notes].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.date.localeCompare(a.date))

  return (
    <Section title="Working notes" meta={`${notes.filter((n) => n.pinned).length} pinned`} quiet id="notes">
      <form
        className="note-add"
        onSubmit={(e) => {
          e.preventDefault()
          if (!draft.trim()) return
          useFitness
            .getState()
            .write('POST', '/api/fitness/notes', { text: draft.trim(), pinned: true })
            .then(() => setDraft(''))
            .catch(() => undefined)
        }}
      >
        <input className="text-input" placeholder="Something to remember next session…" value={draft} onChange={(e) => setDraft(e.target.value)} />
        <button className="btn btn-icon" aria-label="Add note" disabled={!draft.trim()}>
          <Plus />
        </button>
      </form>
      <div>
        {sorted.map((n) => (
          <div key={n.id} className={`note${n.pinned ? '' : ' note-unpinned'}`}>
            <div className="note-text">{n.text}</div>
            <div className="note-meta">
              <span>{fmt.monthDay(n.date)}</span>
              {n.tag && <span className="tag tag-quiet">{n.tag}</span>}
              <OriginTag origin={n.origin} />
              <span className="note-tools">
                <button className="btn btn-ghost btn-sm btn-icon" onClick={() => act('PATCH', `/api/fitness/notes/${n.id}`, { pinned: !n.pinned })} title={n.pinned ? 'Unpin' : 'Pin'}>
                  {n.pinned ? <PinOff /> : <Pin />}
                </button>
                <button className="btn btn-ghost btn-sm btn-icon" onClick={() => window.confirm('Delete this note?') && act('DELETE', `/api/fitness/notes/${n.id}`)} title="Delete">
                  <Trash2 />
                </button>
              </span>
            </div>
          </div>
        ))}
      </div>
    </Section>
  )
}
