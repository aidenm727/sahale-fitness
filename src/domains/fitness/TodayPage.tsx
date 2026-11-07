import { useEffect, useState } from 'react'
import { ArrowRight, Check, Flag, Play, Plus, Trash2 } from 'lucide-react'
import { Link, useNavigate } from 'react-router'
import { performed } from '@shared/fitness/derive'
import type { WorkoutTemplate } from '@shared/fitness/types'
import { fmt } from '@/lib/time'
import { act, useFitness, useFitnessView, type FitnessView } from '@/state/fitness'
import { Page, PageHeader, Section, SubNav } from '@/ui/Page'
import { TemplateEditor } from './editors'
import { AddExercise, EntryCard, FinishDialog, SessionNote } from './logger'
import { FitnessUnavailable, OriginTag, PrescriptionText, StartButton, useStart } from './parts'
import { RestPanel, useRestCue } from './rest'

function Elapsed({ since }: { since: string }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  const s = Math.max(0, Math.floor((now - new Date(since).getTime()) / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return (
    <span className="mono">
      {h ? `${h}:` : ''}
      {String(m).padStart(h ? 2 : 1, '0')}:{String(s % 60).padStart(2, '0')}
    </span>
  )
}

/** "Saving…", "All changes saved", or the error — always visible while logging. */
function SaveState() {
  const busy = useFitness((s) => s.busy)
  const error = useFitness((s) => s.writeError)
  if (error) return <span className="save-state bad">Not saved — {error.message}</span>
  return <span className={`save-state${busy ? ' busy' : ''}`}>{busy ? 'Saving…' : 'All changes saved'}</span>
}

export function TodayPage() {
  const f = useFitnessView()
  if (!f) return <FitnessUnavailable />
  return f.snap.active ? <LiveWorkout f={f} /> : <ChooseWorkout f={f} />
}

/* ------------------------------------------------------------------ */
/* No workout running: pick one                                        */
/* ------------------------------------------------------------------ */

function WorkoutRow({ w, f, next }: { w: WorkoutTemplate; f: FitnessView; next?: boolean }) {
  const plan = w.planIds.map((id) => f.planById[id]).find(Boolean)
  return (
    <div className={`choose-row${next ? ' next' : ''}`}>
      <div className="choose-main">
        <Link to={`/workouts/${w.id}`} className="choose-name">
          {w.name}
        </Link>
        {next && <span className="tag tag-domain">next</span>}
        <OriginTag origin={w.origin} />
        <div className="choose-meta muted">
          {[w.focus, `${w.items.length} exercise${w.items.length === 1 ? '' : 's'}`, w.lastDoneAt ? `last done ${fmt.day(w.lastDoneAt)}` : 'not done yet', plan ? `planned ${fmt.day(plan.date)}` : ''].filter(Boolean).join(' · ')}
        </div>
      </div>
      <StartButton templateId={w.id} label="Start" primary={!!next} small />
    </div>
  )
}

function ChooseWorkout({ f }: { f: FitnessView }) {
  const { start } = useStart()
  const [creating, setCreating] = useState(false)
  const navigate = useNavigate()
  const plan = f.todayPlan
  const planOpen = plan && plan.status !== 'done'
  const others = f.snap.templates.filter((w) => w.blockId !== f.snap.programBlockId)
  const doneToday = plan?.status === 'done' ? plan : undefined

  return (
    <Page>
      <PageHeader
        eyebrow="Fitness · Today"
        title="Start a workout"
        lede={
          <>
            Pick any saved workout — {f.nextTemplate ? <>next in your block is <b>{f.nextTemplate.name}</b></> : 'or an empty one'}. Every set you log is saved as you go, so a refresh or restart loses nothing.
          </>
        }
        actions={
          <>
            <button className="btn btn-ghost" onClick={() => setCreating(true)}>
              <Plus /> New workout
            </button>
            <button className="btn" onClick={() => void start({ name: 'Workout' })}>
              <Play /> Empty workout
            </button>
          </>
        }
      />
      <SubNav />

      <div className="cols">
        <div className="stack">
          {doneToday?.sessionId && (
            <div className="panel panel-pad done-banner">
              <Check />
              <div>
                <b>{doneToday.name} is logged.</b> It’s in your history.
              </div>
              <Link to={`/history/${doneToday.sessionId}`} className="btn btn-sm">
                View log <ArrowRight />
              </Link>
            </div>
          )}

          {planOpen && (
            <Section title="Planned for today" meta={plan.custom ? 'adjusted for today' : undefined}>
              <div className="panel panel-pad planned-today">
                <div className="choose-row">
                  <div className="choose-main">
                    <span className="choose-name">{plan.name}</span>
                    <OriginTag origin={plan.origin} />
                    {plan.legacy && <span className="tag tag-quiet">from v0.1</span>}
                    <div className="choose-meta muted">{plan.items.map((i) => f.ex[i.exerciseId]?.short ?? f.name(i.exerciseId)).join(' · ')}</div>
                  </div>
                  <StartButton planId={plan.id} />
                </div>
                {plan.custom && (
                  <ul className="plan-items">
                    {plan.items.map((i) => (
                      <li key={i.id}>
                        <span>{f.name(i.exerciseId)}</span> <PrescriptionText p={i} ex={f.ex[i.exerciseId]} />
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </Section>
          )}

          <Section title={f.programBlock ? f.programBlock.name : 'Your workouts'} meta={f.program.length ? 'In their normal order — start any of them' : undefined}>
            {f.program.length ? (
              <div className="rows choose-rows">
                {f.program.map((w) => (
                  <WorkoutRow key={w.id} w={w} f={f} next={w.id === f.nextTemplate?.id} />
                ))}
              </div>
            ) : (
              <p className="empty-line">
                No saved workouts {f.programBlock ? 'in this block ' : ''}yet.{' '}
                <button className="link-btn" onClick={() => setCreating(true)}>
                  Create one
                </button>{' '}
                — e.g. Upper A, Lower A — or start an empty workout and add exercises as you go.
              </p>
            )}
          </Section>

          {others.length > 0 && (
            <Section title="Other workouts" meta="From other blocks or not in a block">
              <div className="rows choose-rows">
                {others.map((w) => (
                  <WorkoutRow key={w.id} w={w} f={f} />
                ))}
              </div>
            </Section>
          )}
        </div>

        <aside className="stack aside">
          <Section title="How this works" quiet>
            <p className="aside-text">
              Your block holds reusable workouts in order. Start whichever you’re doing today — planned or not. Starting copies the workout’s prescription into a live log; you record what actually happened set by set, and finishing puts it in History. Your saved workout
              never changes from logging.
            </p>
          </Section>
        </aside>
      </div>
      {creating && <TemplateEditor onClose={() => setCreating(false)} onSaved={(id) => navigate(`/workouts/${id}`)} />}
    </Page>
  )
}

/* ------------------------------------------------------------------ */
/* A workout is running: the logger                                    */
/* ------------------------------------------------------------------ */

function LiveWorkout({ f }: { f: FitnessView }) {
  const active = f.snap.active!
  const navigate = useNavigate()
  const [finishing, setFinishing] = useState(false)
  const done = active.entries.reduce((n, e) => n + performed(e.sets).length, 0)
  const total = active.entries.reduce((n, e) => n + e.sets.length, 0)
  const current = active.entries.find((e) => e.sets.some((s) => !s.done)) ?? active.entries[0]
  const cueEx = current ? f.ex[current.exerciseId] : undefined
  const template = active.templateId ? f.templateById[active.templateId] : undefined
  const plan = active.planId ? f.planById[active.planId] : undefined
  useRestCue(active.rest)
  // Starting a workout from further down this same page keeps the scroll position; begin at the top.
  useEffect(() => {
    document.querySelector('.content')?.scrollTo(0, 0)
  }, [active.id])

  return (
    <Page className="live-page">
      <PageHeader
        eyebrow="Fitness · Workout in progress"
        title={active.name}
        lede={
          <>
            Started {fmt.time(active.date)}
            {!fmt.day(active.date).startsWith('Today') ? ` on ${fmt.date(active.date)}` : ''}
            {plan ? ` · planned for ${fmt.day(plan.date)}` : ''}. Type what you actually did; each set saves as you go.
          </>
        }
        actions={
          <>
            <button className="btn btn-ghost" onClick={() => window.confirm('Discard this workout? Nothing from it will be logged.') && act('POST', `/api/fitness/sessions/${active.id}/discard`)}>
              <Trash2 /> Discard
            </button>
            <button className="btn btn-primary" onClick={() => setFinishing(true)}>
              <Flag /> Finish workout
            </button>
          </>
        }
      />
      <SubNav />

      <div className="cols">
        <div>
          <div className="live-bar">
            <span className="live-dot" />
            <span>
              Live · <Elapsed since={active.date} />
            </span>
            <span className="muted">
              {done} of {total} sets
            </span>
            <div className="meter meter-thin live-meter">
              <span style={{ width: `${(done / Math.max(1, total)) * 100}%` }} />
            </div>
            <SaveState />
            {active.rest && <RestPanel session={active} f={f} place="bar" />}
          </div>

          <div className="logger">
            {active.entries.map((e, i) => (
              <EntryCard key={e.id} entry={e} f={f} session={active} main={i === 0 && !!f.ex[e.exerciseId]?.main} />
            ))}
            {!active.entries.length && <p className="empty-line">No exercises yet — add the first one below.</p>}
            <AddExercise sessionId={active.id} f={f} />
          </div>

          <Section title="Workout note" quiet>
            <SessionNote key={active.id} id={active.id} initial={active.note ?? ''} />
          </Section>

          <div className="finish-foot">
            <button className="btn btn-primary" onClick={() => setFinishing(true)}>
              <Flag /> Finish workout
            </button>
            <span className="muted">You don’t have to complete every prescribed set to finish.</span>
          </div>
        </div>

        <aside className="stack aside">
          <Section title="Readiness" quiet>
            <span className="readiness">
              {[1, 2, 3, 4, 5].map((r) => (
                <button key={r} className={active.readiness === r ? 'on' : ''} onClick={() => act('PATCH', `/api/fitness/sessions/${active.id}`, { readiness: r })} aria-label={`Readiness ${r}`}>
                  {r}
                </button>
              ))}
            </span>
          </Section>

          {cueEx && cueEx.cues.length > 0 && (
            <Section title="Cues" meta={cueEx.name} quiet>
              <ul className="cues">
                {cueEx.cues.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </Section>
          )}

          <Section title="How this works" quiet>
            <p className="aside-text">
              Faint numbers are suggestions — this workout’s previous set, else last time. Tick a set to log it (an empty field takes the suggestion) and your rest starts; set each exercise’s rest with its timer chip. Typed numbers save on their own a
              moment after you stop typing. Finishing keeps the logged sets and drops the empty ones{template ? `; ${template.name} itself isn’t changed` : ''}.
            </p>
          </Section>
        </aside>
      </div>
      {active.rest && <RestPanel session={active} f={f} place="dock" />}
      {finishing && (
        <FinishDialog
          session={active}
          f={f}
          onClose={() => setFinishing(false)}
          onFinished={() => {
            setFinishing(false)
            navigate(`/history/${active.id}`)
          }}
        />
      )}
    </Page>
  )
}
