import { useState } from 'react'
import { ArrowDown, ArrowUp, CalendarPlus, Copy, Pencil, Plus, Repeat } from 'lucide-react'
import { Link } from 'react-router'
import { addDays, daysBetween } from '@shared/dates'
import type { Block, Plan, WorkoutTemplate } from '@shared/fitness/types'
import { fmt } from '@/lib/time'
import { act, useFitness, useFitnessView, type FitnessView } from '@/state/fitness'
import { Page, PageHeader, Section, SubNav } from '@/ui/Page'
import { BlockEditor, PlanDayEditor, PlanDialog, TemplateEditor } from './editors'
import { DemoBanner, FitnessUnavailable, OriginTag, PrescriptionText, StartButton } from './parts'

type Dialog = { kind: 'block'; block?: Block } | { kind: 'template'; template?: WorkoutTemplate; blockId?: string } | { kind: 'plan'; template?: WorkoutTemplate; plan?: Plan } | { kind: 'day'; plan: Plan }

function TemplateCard({ w, f, index, count, next, onDialog }: { w: WorkoutTemplate; f: FitnessView; index: number; count: number; next: boolean; onDialog: (d: Dialog) => void }) {
  const plans = w.planIds.map((id) => f.planById[id]).filter(Boolean)
  const move = (d: number) => {
    const ids = f.snap.templates.filter((x) => x.blockId === w.blockId).map((x) => x.id)
    const [x] = ids.splice(index, 1)
    ids.splice(index + d, 0, x)
    act('POST', '/api/fitness/templates/order', { blockId: w.blockId ?? null, ids })
  }
  return (
    <article className={`tpl-card${next ? ' next' : ''}`}>
      <header className="tpl-head">
        <span className="tpl-n mono">{index + 1}</span>
        <div className="tpl-title">
          <Link to={`/workouts/${w.id}`} className="tpl-name">
            {w.name}
          </Link>
          {next && <span className="tag tag-domain">next</span>}
          <OriginTag origin={w.origin} />
          <div className="muted tpl-meta">
            {[w.focus, `${w.items.length} exercise${w.items.length === 1 ? '' : 's'}`, w.lastDoneAt ? `last done ${fmt.day(w.lastDoneAt)}` : 'not done yet'].filter(Boolean).join(' · ')}
          </div>
        </div>
        <div className="tpl-order">
          <button className="btn btn-ghost btn-sm btn-icon" disabled={index === 0} onClick={() => move(-1)} aria-label={`Move ${w.name} earlier`}>
            <ArrowUp />
          </button>
          <button className="btn btn-ghost btn-sm btn-icon" disabled={index === count - 1} onClick={() => move(1)} aria-label={`Move ${w.name} later`}>
            <ArrowDown />
          </button>
        </div>
      </header>
      <ul className="tpl-items">
        {w.items.map((i) => (
          <li key={i.id}>
            <span>{f.name(i.exerciseId)}</span>
            <span>
              <PrescriptionText p={i} ex={f.ex[i.exerciseId]} />
            </span>
          </li>
        ))}
        {!w.items.length && <li className="faint">No exercises yet</li>}
      </ul>
      <footer className="tpl-foot">
        <StartButton templateId={w.id} small primary={next} />
        {plans.length ? (
          <button
            className="btn btn-sm btn-ghost"
            onClick={() => onDialog({ kind: 'plan', plan: plans[0] })}
            title="Change or clear the date"
            aria-label={`${plans[0].status === 'missed' ? 'Missed' : 'Planned'} ${fmt.monthDay(plans[0].date)} — change or clear the date`}
          >
            <CalendarPlus /> {plans[0].status === 'missed' ? `Missed ${fmt.monthDay(plans[0].date)}` : fmt.day(plans[0].date)}
          </button>
        ) : (
          <button className="btn btn-sm btn-ghost" onClick={() => onDialog({ kind: 'plan', template: w })}>
            <CalendarPlus /> Plan
          </button>
        )}
        <button className="btn btn-sm btn-ghost btn-icon tpl-edit" onClick={() => onDialog({ kind: 'template', template: w })} aria-label={`Edit ${w.name}`} title="Edit">
          <Pencil />
        </button>
        <button className="btn btn-sm btn-ghost btn-icon" onClick={() => act('POST', `/api/fitness/templates/${w.id}/duplicate`)} aria-label={`Duplicate ${w.name}`} title="Duplicate">
          <Copy />
        </button>
      </footer>
    </article>
  )
}

function PlanRow({ p, f, onDialog }: { p: Plan; f: FitnessView; onDialog: (d: Dialog) => void }) {
  const [saving, setSaving] = useState(false)
  return (
    <div className={`plan-row s-${p.status}`}>
      <span className="mono muted">{fmt.day(p.date)}</span>
      <span className="strong">
        {p.templateId ? <Link to={`/workouts/${p.templateId}`}>{p.name}</Link> : p.name} <OriginTag origin={p.origin} />
        {p.custom && !p.legacy && <span className="tag tag-quiet">adjusted for this day</span>}
        {p.legacy && <span className="tag tag-quiet" title="Carried over from v0.1, when workouts were tied to dates. It keeps its own prescription.">from v0.1</span>}
      </span>
      <span className={p.status === 'missed' ? 'muted' : 'faint'}>{p.status === 'missed' ? 'not done — nothing logged' : p.status === 'today' ? 'today' : ''}</span>
      <span className="row-tools">
        <StartButton planId={p.id} small primary={false} label="Start" />
        <button className="btn btn-ghost btn-sm" onClick={() => onDialog({ kind: 'plan', plan: p })}>
          Move / clear
        </button>
        <button className="btn btn-ghost btn-sm" onClick={() => onDialog({ kind: 'day', plan: p })} title="Change the prescription for this day only">
          Edit day
        </button>
        {!p.templateId && (
          <button
            className="btn btn-ghost btn-sm"
            disabled={saving}
            title="Save this one-off as a reusable workout in its block"
            onClick={() => {
              setSaving(true)
              useFitness
                .getState()
                .write('POST', `/api/fitness/plans/${p.id}/template`, {})
                .catch(() => undefined)
                .finally(() => setSaving(false))
            }}
          >
            <Repeat /> Make reusable
          </button>
        )}
      </span>
      {p.custom && (
        <span className="plan-row-items muted">
          {p.items.map((i) => `${f.ex[i.exerciseId]?.short ?? f.name(i.exerciseId)} ${i.sets}×${i.repMin === i.repMax ? i.repMin : `${i.repMin}–${i.repMax}`}`).join(' · ')}
        </span>
      )}
    </div>
  )
}

export function ProgramPage() {
  const f = useFitnessView()
  const [dialog, setDialog] = useState<Dialog | null>(null)
  if (!f) return <FitnessUnavailable />

  const blocks = f.snap.blocks
  const block = f.programBlock
  const week = block && f.block?.id === block.id ? Math.floor(daysBetween(block.startDate, f.snap.today) / 7) + 1 : undefined
  const first = blocks[0]?.startDate
  const lastEnd = blocks.reduce((m, b) => (b.endDate > m ? b.endDate : m), first ?? '')
  const span = first ? daysBetween(first, lastEnd) + 1 : 1
  // Overlapping blocks get their own lane so nothing draws on top of anything else.
  const lanes: Block[][] = []
  for (const b of blocks) {
    const lane = lanes.find((l) => l[l.length - 1].endDate < b.startDate)
    if (lane) lane.push(b)
    else lanes.push([b])
  }
  const pos = (date: string) => `${(daysBetween(first!, date) / span) * 100}%`
  const scheduled = f.snap.plans.filter((p) => (p.status === 'planned' || p.status === 'today') && p.date <= addDays(f.snap.today, 27))
  const missed = f.snap.plans.filter((p) => p.status === 'missed' && p.date >= addDays(f.snap.today, -14))
  const legacyOld = f.snap.plans.filter((p) => p.legacy && p.status === 'missed' && p.date < addDays(f.snap.today, -14)).length
  const otherBlocks = blocks.filter((b) => b.id !== block?.id && f.snap.templates.some((w) => w.blockId === b.id))
  const unassigned = block ? f.snap.templates.filter((w) => !w.blockId) : []
  const onDialog = (d: Dialog) => setDialog(d)

  return (
    <Page>
      <PageHeader
        eyebrow="Fitness · Program"
        title="Program"
        lede={
          block ? (
            <>
              <b>{block.name}</b>
              {week ? `, week ${week} of ${block.weeks}` : block.status === 'planned' ? `, starts ${fmt.date(block.startDate)}` : ''} — {f.program.length} reusable workout{f.program.length === 1 ? '' : 's'} in order. Start whichever is next when you train; dates are optional.
            </>
          ) : (
            <>Create a training block, then the workouts in it — e.g. Upper A, Lower A, Upper B, Lower B. They aren’t tied to dates; you start the next one whenever you train.</>
          )
        }
        actions={
          <>
            <button className="btn" onClick={() => setDialog({ kind: 'template', blockId: block?.id })}>
              <Plus /> New workout
            </button>
            <button className="btn btn-ghost" onClick={() => setDialog({ kind: 'block' })}>
              <Plus /> New block
            </button>
          </>
        }
      />
      <SubNav />
      <DemoBanner f={f} />

      <div className="cols">
        <div className="stack">
          {block && (
            <Section
              title={block.name}
              meta={[block.phase, `${block.weeks} weeks from ${fmt.monthDay(block.startDate)}`, block.scheme].filter(Boolean).join(' · ')}
              actions={
                <button className="btn btn-ghost btn-sm" onClick={() => setDialog({ kind: 'block', block })}>
                  <Pencil /> Edit block
                </button>
              }
            >
              {block.intent && <p className="sec-lede">{block.intent}</p>}
              {f.program.length ? (
                <div className="tpl-grid">
                  {f.program.map((w, i) => (
                    <TemplateCard key={w.id} w={w} f={f} index={i} count={f.program.length} next={w.id === f.nextTemplate?.id} onDialog={onDialog} />
                  ))}
                </div>
              ) : (
                <div className="panel panel-pad empty-program">
                  <p>No workouts in this block yet.</p>
                  <button className="btn btn-primary" onClick={() => setDialog({ kind: 'template', blockId: block.id })}>
                    <Plus /> Create the first workout
                  </button>
                </div>
              )}
            </Section>
          )}

          {!block && f.snap.templates.length > 0 && (
            <Section title="Workouts" meta="Not in a block">
              <div className="tpl-grid">
                {f.snap.templates.map((w, i) => (
                  <TemplateCard key={w.id} w={w} f={f} index={i} count={f.snap.templates.length} next={w.id === f.nextTemplate?.id} onDialog={onDialog} />
                ))}
              </div>
            </Section>
          )}

          <Section title="Scheduled" meta="Optional dates · next four weeks">
            {scheduled.length || missed.length ? (
              <div className="rows plan-rows">
                {missed.map((p) => (
                  <PlanRow key={p.id} p={p} f={f} onDialog={onDialog} />
                ))}
                {scheduled.map((p) => (
                  <PlanRow key={p.id} p={p} f={f} onDialog={onDialog} />
                ))}
              </div>
            ) : (
              <p className="empty-line">Nothing scheduled — that’s fine. Use “Plan” on a workout to put it on a day; it shows up on Today and Home.</p>
            )}
            {legacyOld > 0 && <p className="field-hint">{legacyOld} older planned workout{legacyOld === 1 ? '' : 's'} from v0.1 weren’t done and aren’t shown here.</p>}
          </Section>

          {(otherBlocks.length > 0 || unassigned.length > 0) && (
            <Section title="Other workouts" meta="Other blocks and workouts without one">
              <div className="rows other-tpls">
                {[...otherBlocks.flatMap((b) => f.snap.templates.filter((w) => w.blockId === b.id).map((w) => ({ w, where: `Block ${b.n} · ${b.name}` }))), ...unassigned.map((w) => ({ w, where: 'No block' }))].map(({ w, where }) => (
                  <div key={w.id}>
                    <Link to={`/workouts/${w.id}`} className="strong">
                      {w.name}
                    </Link>
                    <span className="muted">{where}</span>
                    <span className="row-tools">
                      <StartButton templateId={w.id} small primary={false} label="Start" />
                      <button className="btn btn-ghost btn-sm" onClick={() => setDialog({ kind: 'template', template: w })}>
                        <Pencil /> Edit
                      </button>
                    </span>
                  </div>
                ))}
              </div>
            </Section>
          )}

          {blocks.length > 0 && (
            <Section title="Blocks" meta={`${fmt.monthDay(first!)} → ${fmt.monthDay(lastEnd)}${lanes.length > 1 ? ' · some blocks overlap' : ''}`}>
              <div className="timeline">
                {lanes.map((lane, li) => (
                  <div key={li} className="tl-lane">
                    <div className="tl-track">
                      {lane.map((b) => (
                        <button key={b.id} className={`tl-block ${b.status}`} style={{ left: pos(b.startDate), width: `calc(${((b.weeks * 7) / span) * 100}% - 3px)` }} onClick={() => setDialog({ kind: 'block', block: b })} title={`Edit ${b.name}`}>
                          <span className="tl-n">{b.n}</span>
                        </button>
                      ))}
                      {f.snap.today >= first! && f.snap.today <= lastEnd && <div className="tl-today" style={{ left: pos(f.snap.today) }}>{li === 0 && <span>Today</span>}</div>}
                    </div>
                    <div className="tl-labels">
                      {lane.map((b) => (
                        <div key={b.id} className={`tl-label ${b.status}`} style={{ left: pos(b.startDate), width: `${((b.weeks * 7) / span) * 100}%` }}>
                          <b>{b.name}</b>
                          <span>
                            {b.scheme ? `${b.scheme} · ` : ''}
                            {b.weeks} wk
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </Section>
          )}
        </div>

        <aside className="stack aside">
          <Section title="How the program works" quiet>
            <p className="aside-text">
              A block holds reusable workouts in their normal order. They have no dates: when you get to the gym, start the next one (or any one). Planning a workout for a day is optional — move or clear it any time, and missing it logs nothing. Each
              workout you log keeps the prescription it was done with, so editing a workout never rewrites history.
            </p>
          </Section>
          {blocks.some((b) => b.status === 'done') && (
            <Section title="Finished blocks" quiet>
              {blocks
                .filter((b) => b.status === 'done')
                .map((b) => (
                  <p key={b.id} className="aside-text">
                    <b>
                      {b.n}. {b.name}
                    </b>{' '}
                    — {b.scheme || 'no scheme'}, {fmt.monthDay(b.startDate)}–{fmt.monthDay(b.endDate)}
                  </p>
                ))}
            </Section>
          )}
        </aside>
      </div>
      {dialog?.kind === 'block' && <BlockEditor block={dialog.block} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'template' && <TemplateEditor template={dialog.template} blockId={dialog.blockId} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'plan' && <PlanDialog template={dialog.template} plan={dialog.plan} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'day' && <PlanDayEditor plan={dialog.plan} onClose={() => setDialog(null)} />}
    </Page>
  )
}
