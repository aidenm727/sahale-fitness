/**
 * Owner-facing editors for Fitness state. Each one sends a single request and
 * closes only after the runtime confirms; a failure stays on screen.
 */
import { useState } from 'react'
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react'
import { fmtClock, REST_CHOICES, restSecFor } from '@shared/fitness/derive'
import { PATTERNS, type Block, type Exercise, type Goal, type Pattern, type Plan, type Prescription, type WorkoutTemplate } from '@shared/fitness/types'
import { fmt } from '@/lib/time'
import { ApiError } from '@/runtime/api'
import { useFitness, useFitnessView } from '@/state/fitness'
import { Field, Modal } from '@/ui/form'
import { optionalTextForSave } from './setupNote'

export { Field, Modal }

/** Run a write; keep the dialog open with the server's message if it fails. */
export function useSave(onDone: (res: { id?: string }) => void) {
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const save = async (method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown) => {
    setSaving(true)
    setError(null)
    try {
      const res = await useFitness.getState().write<{ snapshot: never; id?: string }>(method, path, body)
      useFitness.getState().clearWriteError()
      onDone(res)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
      useFitness.getState().clearWriteError()
    } finally {
      setSaving(false)
    }
  }
  return { error, setError, saving, save }
}

const num = (v: string): number | undefined => (v.trim() === '' ? undefined : Number(v))
const CREATE = '__create__'
export const RPE_STEPS = [5, 5.5, 6, 6.5, 7, 7.5, 8, 8.5, 9, 9.5, 10]

/**
 * Choose any exercise — built in or yours — or create one on the spot. A new
 * exercise is saved and selected immediately.
 */
export function ExercisePicker({ value, onChange, exercises, label = 'Choose…' }: { value: string; onChange: (id: string) => void; exercises: Exercise[]; label?: string }) {
  const [creating, setCreating] = useState(false)
  const mine = exercises.filter((e) => e.origin === 'owner')
  return (
    <>
      <select
        className="text-input"
        value={value}
        aria-label="Exercise"
        onChange={(e) => {
          if (e.target.value === CREATE) setCreating(true)
          else onChange(e.target.value)
        }}
      >
        <option value="">{label}</option>
        <option value={CREATE}>+ Create exercise…</option>
        {mine.length > 0 && (
          <optgroup label="Your exercises">
            {mine.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </optgroup>
        )}
        {PATTERNS.map((p) => {
          const group = exercises.filter((e) => e.pattern === p && e.origin !== 'owner')
          return group.length ? (
            <optgroup key={p} label={p}>
              {group.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </optgroup>
          ) : null
        })}
      </select>
      {creating && <ExerciseEditor onClose={() => setCreating(false)} onCreated={onChange} />}
    </>
  )
}

/* ------------------------------------------------------------------ */

export function GoalEditor({ goal, onClose }: { goal: Goal | null; onClose: () => void }) {
  const f = useFitnessView()!
  const [statement, setStatement] = useState(goal?.statement ?? '')
  const [date, setDate] = useState(goal?.date ?? '')
  const [bw, setBw] = useState(goal?.bodyweightTarget?.toString() ?? '')
  const [targets, setTargets] = useState(goal?.targets.map((t) => ({ exerciseId: t.exerciseId, target: String(t.target) })) ?? [])
  const { error, saving, save } = useSave(onClose)
  const submit = () =>
    save('PUT', '/api/fitness/goal', {
      statement,
      date: date || undefined,
      bodyweightTarget: num(bw),
      targets: targets.filter((t) => t.exerciseId && t.target).map((t) => ({ exerciseId: t.exerciseId, target: Number(t.target) })),
    })
  return (
    <Modal
      title={goal ? 'Edit goal' : 'Set a goal'}
      onClose={onClose}
      footer={
        <>
          {error && <span className="form-error">{error}</span>}
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={() => void submit()} disabled={saving || !statement.trim()}>
            Save goal
          </button>
        </>
      }
    >
      <Field label="Goal">
        <textarea className="text-input" rows={2} value={statement} onChange={(e) => setStatement(e.target.value)} placeholder="e.g. Squat 315 and bench 225 by test day, while cutting to ~175 lb" />
      </Field>
      <div className="field-row">
        <Field label="Target date">
          <input className="text-input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label="Bodyweight target (lb)">
          <input className="text-input" inputMode="decimal" value={bw} onChange={(e) => setBw(e.target.value)} />
        </Field>
      </div>
      <div className="field">
        <span className="field-label">Lift targets (lb)</span>
        {targets.map((t, i) => (
          <div key={i} className="field-row tight">
            <ExercisePicker value={t.exerciseId} exercises={f.snap.exercises} onChange={(id) => setTargets(targets.map((x, j) => (j === i ? { ...x, exerciseId: id } : x)))} />
            <input className="text-input" inputMode="decimal" value={t.target} onChange={(e) => setTargets(targets.map((x, j) => (j === i ? { ...x, target: e.target.value } : x)))} placeholder="lb" />
            <button className="btn btn-ghost btn-icon" onClick={() => setTargets(targets.filter((_, j) => j !== i))} aria-label="Remove target">
              <Trash2 />
            </button>
          </div>
        ))}
        <button className="btn btn-sm btn-ghost" onClick={() => setTargets([...targets, { exerciseId: '', target: '' }])}>
          <Plus /> Add a lift target
        </button>
      </div>
    </Modal>
  )
}

/* ------------------------------------------------------------------ */

export function BlockEditor({ block, onClose }: { block?: Block; onClose: () => void }) {
  const today = useFitnessView()!.snap.today
  const [v, setV] = useState({
    name: block?.name ?? '',
    phase: block?.phase ?? '',
    scheme: block?.scheme ?? '',
    intent: block?.intent ?? '',
    startDate: block?.startDate ?? today,
    weeks: String(block?.weeks ?? 4),
    deloadWeek: block?.deloadWeek?.toString() ?? '',
  })
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV({ ...v, [k]: e.target.value })
  const { error, saving, save } = useSave(onClose)
  const body = { ...v, weeks: Number(v.weeks), deloadWeek: num(v.deloadWeek) }
  return (
    <Modal
      title={block ? `Edit block ${block.n}` : 'New training block'}
      onClose={onClose}
      footer={
        <>
          {error && <span className="form-error">{error}</span>}
          {block && (
            <button
              className="btn btn-ghost danger"
              onClick={() => window.confirm('Delete this block? Its workouts stay (without a block), and your history is untouched.') && void save('DELETE', `/api/fitness/blocks/${block.id}`)}
            >
              Delete
            </button>
          )}
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={saving || !v.name.trim()} onClick={() => void save(block ? 'PATCH' : 'POST', block ? `/api/fitness/blocks/${block.id}` : '/api/fitness/blocks', body)}>
            Save block
          </button>
        </>
      }
    >
      <div className="field-row">
        <Field label="Name">
          <input className="text-input" value={v.name} onChange={set('name')} placeholder="Strength + Hypertrophy Base" />
        </Field>
        <Field label="Phase">
          <input className="text-input" value={v.phase} onChange={set('phase')} placeholder="Accumulation" />
        </Field>
      </div>
      <div className="field-row">
        <Field label="Starts">
          <input className="text-input" type="date" value={v.startDate} onChange={set('startDate')} />
        </Field>
        <Field label="Weeks">
          <input className="text-input" inputMode="numeric" value={v.weeks} onChange={set('weeks')} />
        </Field>
        <Field label="Deload week">
          <input className="text-input" inputMode="numeric" value={v.deloadWeek} onChange={set('deloadWeek')} placeholder="none" />
        </Field>
      </div>
      <Field label="Progression scheme">
        <input className="text-input" value={v.scheme} onChange={set('scheme')} placeholder="Double progression; compounds 5–10, accessories 8–20" />
      </Field>
      <Field label="Intent">
        <textarea className="text-input" rows={2} value={v.intent} onChange={set('intent')} placeholder="What this block is for" />
      </Field>
    </Modal>
  )
}

/* ------------------------------------------------------------------ */
/* Prescriptions                                                       */
/* ------------------------------------------------------------------ */

interface ItemDraft {
  key: string
  id?: string
  exerciseId: string
  sets: string
  repMin: string
  repMax: string
  rpe: string
  load: string
  note: string
}

let draftKey = 0
const toDraft = (i?: Prescription & { id?: string }): ItemDraft => ({
  key: `d${++draftKey}`,
  id: i?.id,
  exerciseId: i?.exerciseId ?? '',
  sets: String(i?.sets ?? 3),
  repMin: String(i?.repMin ?? 8),
  repMax: String(i?.repMax ?? 12),
  rpe: i?.rpe !== undefined ? String(i.rpe) : '',
  load: i?.load !== undefined ? String(i.load) : '',
  note: i?.note ?? '',
})

/** Drafts → API items, or a message saying what's wrong. */
function toItems(drafts: ItemDraft[], keepIds: boolean): { items: object[]; problem?: string } {
  const items: object[] = []
  for (const d of drafts) {
    if (!d.exerciseId) continue
    const sets = Number(d.sets)
    const repMin = Number(d.repMin)
    const repMax = d.repMax.trim() === '' ? repMin : Number(d.repMax)
    if (!Number.isInteger(sets) || sets < 1) return { items, problem: 'Sets must be a whole number of at least 1.' }
    if (!Number.isInteger(repMin) || !Number.isInteger(repMax) || repMin < 0) return { items, problem: 'Reps must be whole numbers.' }
    if (repMin > repMax) return { items, problem: `A rep range of ${repMin}–${repMax} runs backwards.` }
    const load = num(d.load)
    if (load !== undefined && (!Number.isFinite(load) || load < 0)) return { items, problem: 'Load must be a number of lb.' }
    items.push({ ...(keepIds && d.id ? { id: d.id } : {}), exerciseId: d.exerciseId, sets, repMin, repMax, rpe: num(d.rpe), load, note: d.note.trim() || undefined })
  }
  return { items }
}

function PrescriptionTable({ items, setItems, exercises }: { items: ItemDraft[]; setItems: (x: ItemDraft[]) => void; exercises: Exercise[] }) {
  const patch = (i: number, p: Partial<ItemDraft>) => setItems(items.map((x, j) => (j === i ? { ...x, ...p } : x)))
  const move = (i: number, d: number) => {
    const next = [...items]
    const [x] = next.splice(i, 1)
    next.splice(i + d, 0, x)
    setItems(next)
  }
  return (
    <div className="field">
      <span className="field-label">Exercises</span>
      <div className="table-scroll">
        <table className="tbl items-tbl">
          <thead>
            <tr>
              <th>Exercise</th>
              <th>Sets</th>
              <th>Reps (range)</th>
              <th>Target RPE</th>
              <th>Load (lb)</th>
              <th>Note</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((it, i) => (
              <tr key={it.key}>
                <td>
                  <ExercisePicker value={it.exerciseId} exercises={exercises} onChange={(id) => patch(i, { exerciseId: id })} />
                </td>
                <td>
                  <input className="text-input num" inputMode="numeric" value={it.sets} onChange={(e) => patch(i, { sets: e.target.value })} aria-label="Sets" />
                </td>
                <td className="rep-range">
                  <input className="text-input num" inputMode="numeric" value={it.repMin} onChange={(e) => patch(i, { repMin: e.target.value })} aria-label="Reps, low end" />
                  <span>–</span>
                  <input className="text-input num" inputMode="numeric" value={it.repMax} onChange={(e) => patch(i, { repMax: e.target.value })} aria-label="Reps, high end" placeholder={it.repMin} />
                </td>
                <td>
                  <select className="text-input num" value={it.rpe} onChange={(e) => patch(i, { rpe: e.target.value })} aria-label="Target RPE">
                    <option value="">—</option>
                    {RPE_STEPS.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <input className="text-input num" inputMode="decimal" value={it.load} placeholder="—" onChange={(e) => patch(i, { load: e.target.value })} aria-label="Target load" />
                </td>
                <td>
                  <input className="text-input" value={it.note} onChange={(e) => patch(i, { note: e.target.value })} aria-label="Note" />
                </td>
                <td className="items-tools">
                  <button className="btn btn-ghost btn-sm btn-icon" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up">
                    <ArrowUp />
                  </button>
                  <button className="btn btn-ghost btn-sm btn-icon" disabled={i === items.length - 1} onClick={() => move(i, 1)} aria-label="Move down">
                    <ArrowDown />
                  </button>
                  <button className="btn btn-ghost btn-sm btn-icon" onClick={() => setItems(items.filter((_, j) => j !== i))} aria-label="Remove">
                    <Trash2 />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button className="btn btn-sm btn-ghost" onClick={() => setItems([...items, toDraft()])}>
        <Plus /> Add exercise
      </button>
      <span className="field-hint">Reps are a range: 5 – 8 means anywhere from 5 to 8. Use the same number twice for an exact target. Load is optional — the logger shows last time.</span>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Reusable workouts                                                   */
/* ------------------------------------------------------------------ */

/** Create or edit a reusable workout. There is no date here — planning is separate and optional. */
export function TemplateEditor({ template, blockId, onClose, onSaved }: { template?: WorkoutTemplate; blockId?: string; onClose: () => void; onSaved?: (id: string) => void }) {
  const f = useFitnessView()!
  const [name, setName] = useState(template?.name ?? '')
  const [focus, setFocus] = useState(template?.focus ?? '')
  const [block, setBlock] = useState(template ? (template.blockId ?? '') : (blockId ?? f.snap.programBlockId ?? ''))
  const [notes, setNotes] = useState(template?.notes ?? '')
  const [items, setItems] = useState<ItemDraft[]>(template?.items.map(toDraft) ?? [toDraft()])
  const { error, setError, saving, save } = useSave((res) => {
    onClose()
    const id = template?.id ?? res.id
    if (id) onSaved?.(id)
  })
  const submit = () => {
    const { items: list, problem } = toItems(items, !!template)
    if (problem) return setError(problem)
    const body = { name, focus: focus || undefined, notes: notes || undefined, blockId: block || null, items: list }
    void (template ? save('PATCH', `/api/fitness/templates/${template.id}`, { ...body, version: template.version }) : save('POST', '/api/fitness/templates', body))
  }
  return (
    <Modal
      wide
      title={template ? `Edit ${template.name}` : 'New workout'}
      onClose={onClose}
      footer={
        <>
          {error && <span className="form-error">{error}</span>}
          {template && (
            <button
              className="btn btn-ghost danger"
              onClick={() =>
                window.confirm(`Delete ${template.name}? Workouts you already logged stay in History exactly as they were; dates you planned for it are cleared.`) &&
                void save('DELETE', `/api/fitness/templates/${template.id}`)
              }
            >
              Delete
            </button>
          )}
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={saving || !name.trim()} onClick={submit}>
            Save workout
          </button>
        </>
      }
    >
      <div className="field-row">
        <Field label="Name">
          <input className="text-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Lower A" />
        </Field>
        <Field label="Focus">
          <input className="text-input" value={focus} onChange={(e) => setFocus(e.target.value)} placeholder="Squat / Quads" />
        </Field>
        <Field label="Block">
          <select className="text-input" value={block} onChange={(e) => setBlock(e.target.value)}>
            <option value="">No block</option>
            {f.snap.blocks.map((b) => (
              <option key={b.id} value={b.id}>
                {b.n}. {b.name}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <PrescriptionTable items={items} setItems={setItems} exercises={f.snap.exercises} />
      <Field label="Notes">
        <textarea className="text-input" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Warm-up, rest times, anything to remember" />
      </Field>
      {template && <p className="field-hint">Editing changes this workout from now on. Workouts already logged keep the prescription they were done with.</p>}
    </Modal>
  )
}

/** Put a workout on a date, move it, or clear it. Optional — the workout itself never changes. */
export function PlanDialog({ template, plan, onClose }: { template?: WorkoutTemplate; plan?: Plan; onClose: () => void }) {
  const f = useFitnessView()!
  const [date, setDate] = useState(plan?.date ?? f.snap.today)
  const [notes, setNotes] = useState(plan?.notes ?? '')
  const name = plan?.name ?? template?.name ?? 'Workout'
  const { error, saving, save } = useSave(() => onClose())
  return (
    <Modal
      title={plan ? `${name} · ${fmt.date(plan.date)}` : `Plan ${name}`}
      onClose={onClose}
      footer={
        <>
          {error && <span className="form-error">{error}</span>}
          {plan && (
            <button className="btn btn-ghost danger" onClick={() => void save('DELETE', `/api/fitness/plans/${plan.id}`)}>
              Clear plan
            </button>
          )}
          {plan?.custom && plan.templateId && (
            <button className="btn btn-ghost" title="Drop this day's own prescription" onClick={() => void save('POST', `/api/fitness/plans/${plan.id}/reset`, { version: plan.version })}>
              Use the workout as written
            </button>
          )}
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            disabled={saving || !date}
            onClick={() => void (plan ? save('PATCH', `/api/fitness/plans/${plan.id}`, { version: plan.version, date, notes }) : save('POST', '/api/fitness/plans', { templateId: template!.id, date, notes: notes || undefined }))}
          >
            {plan ? 'Save' : 'Plan it'}
          </button>
        </>
      }
    >
      <Field label="Date">
        <input className="text-input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </Field>
      <Field label="Note for that day (optional)">
        <input className="text-input" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. gym early, before work" />
      </Field>
      <p className="field-hint">
        Planning is optional. If you train on a different day, just start {name} then — it counts for this plan if it’s within a week. Missing the date logs nothing and changes nothing.
        {plan?.custom ? ' This day has its own adjusted prescription.' : ''}
      </p>
    </Modal>
  )
}

/** Change the prescription of one planned day only. */
export function PlanDayEditor({ plan, onClose }: { plan: Plan; onClose: () => void }) {
  const f = useFitnessView()!
  const [items, setItems] = useState<ItemDraft[]>(plan.items.map((i) => ({ ...toDraft(i), id: undefined })))
  const { error, setError, saving, save } = useSave(() => onClose())
  const submit = () => {
    const { items: list, problem } = toItems(items, false)
    if (problem) return setError(problem)
    void save('PATCH', `/api/fitness/plans/${plan.id}`, { version: plan.version, items: list })
  }
  return (
    <Modal
      wide
      title={`${plan.name} on ${fmt.date(plan.date)} only`}
      onClose={onClose}
      footer={
        <>
          {error && <span className="form-error">{error}</span>}
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={saving} onClick={submit}>
            Save this day
          </button>
        </>
      }
    >
      <p className="field-hint">Changes here apply to {fmt.date(plan.date)} only. {plan.templateId ? `Your reusable ${plan.name} stays exactly as it is.` : ''}</p>
      <PrescriptionTable items={items} setItems={setItems} exercises={f.snap.exercises} />
    </Modal>
  )
}

/* ------------------------------------------------------------------ */

export function ExerciseEditor({ exercise, onClose, onCreated }: { exercise?: Exercise; onClose: () => void; onCreated?: (id: string) => void }) {
  const [v, setV] = useState({
    name: exercise?.name ?? '',
    short: exercise?.short ?? '',
    pattern: (exercise?.pattern ?? 'Other') as Pattern,
    equipment: exercise?.equipment ?? '',
    main: exercise?.main ?? false,
    bodyweight: exercise?.bodyweight ?? false,
    cues: exercise?.cues.join('\n') ?? '',
    note: exercise?.note ?? '',
    restSec: exercise?.restSec === undefined ? '' : String(exercise.restSec),
  })
  const { error, saving, save } = useSave((res) => {
    if (res.id && !exercise) onCreated?.(res.id)
    onClose()
  })
  const submit = () => {
    const body = { ...v, short: optionalTextForSave(v.short, !!exercise), note: optionalTextForSave(v.note, !!exercise), cues: v.cues.split('\n').map((c) => c.trim()).filter(Boolean), restSec: v.restSec === '' ? null : Number(v.restSec) }
    void save(exercise ? 'PATCH' : 'POST', exercise ? `/api/fitness/exercises/${exercise.id}` : '/api/fitness/exercises', body)
  }
  return (
    <Modal
      title={exercise ? `Edit ${exercise.name}` : 'New exercise'}
      onClose={onClose}
      footer={
        <>
          {error && <span className="form-error">{error}</span>}
          {exercise?.origin === 'owner' && (
            <button className="btn btn-ghost danger" onClick={() => window.confirm(`Delete ${exercise.name}? Only possible while no workout or history uses it.`) && void save('DELETE', `/api/fitness/exercises/${exercise.id}`)}>
              Delete
            </button>
          )}
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={saving || !v.name.trim()} onClick={submit}>
            {exercise ? 'Save exercise' : 'Create exercise'}
          </button>
        </>
      }
    >
      <div className="field-row">
        <Field label="Name">
          <input className="text-input" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} placeholder="Standing Calf Raise" />
        </Field>
        <Field label="Short name">
          <input className="text-input" value={v.short} onChange={(e) => setV({ ...v, short: e.target.value })} placeholder="optional" />
        </Field>
      </div>
      <div className="field-row">
        <Field label="Category">
          <select className="text-input" value={v.pattern} onChange={(e) => setV({ ...v, pattern: e.target.value as Pattern })}>
            {PATTERNS.map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
        </Field>
        <Field label="Equipment">
          <input className="text-input" value={v.equipment} onChange={(e) => setV({ ...v, equipment: e.target.value })} placeholder="optional" />
        </Field>
      </div>
      <Field label="Rest between sets" hint="Starts when you tick a set in a live workout. Used in every workout with this exercise.">
        <select className="text-input" value={v.restSec} onChange={(e) => setV({ ...v, restSec: e.target.value })}>
          <option value="">Default ({fmtClock(restSecFor({ main: v.main, pattern: v.pattern }))} for this kind of exercise)</option>
          {[...new Set([...REST_CHOICES, ...(v.restSec && v.restSec !== '0' ? [Number(v.restSec)] : [])])]
            .sort((a, b) => a - b)
            .map((s) => (
              <option key={s} value={s}>
                {fmtClock(s)}
              </option>
            ))}
          <option value="0">No rest timer</option>
        </select>
      </Field>
      <div className="field-row checks">
        <label>
          <input type="checkbox" checked={v.main} onChange={(e) => setV({ ...v, main: e.target.checked })} /> Main lift (tracked for strength)
        </label>
        <label>
          <input type="checkbox" checked={v.bodyweight} onChange={(e) => setV({ ...v, bodyweight: e.target.checked })} /> Bodyweight
        </label>
      </div>
      <Field label="Cues" hint="One per line">
        <textarea className="text-input" rows={3} value={v.cues} onChange={(e) => setV({ ...v, cues: e.target.value })} />
      </Field>
      <Field label="Notes">
        <textarea className="text-input" rows={2} value={v.note} onChange={(e) => setV({ ...v, note: e.target.value })} />
      </Field>
    </Modal>
  )
}
