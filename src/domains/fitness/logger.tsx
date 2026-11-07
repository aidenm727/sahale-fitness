/**
 * The live workout logger.
 *
 * What the owner types is what actually happened; the prescription only
 * supplies hints. Every field saves on its own a moment after typing stops,
 * on blur, and — if the page is closing — with a keepalive request, so a
 * refresh or a restart loses at most the keystroke in flight. The server holds
 * the only copy; this file holds drafts that haven't been sent yet.
 */
import { useEffect, useRef, useState } from 'react'
import { Check, MessageSquare, Plus, Trash2, X } from 'lucide-react'
import { Link } from 'react-router'
import { fmtLoad, fmtReps, performed, previousFor } from '@shared/fitness/derive'
import type { EntryLog, Exercise, SessionLog, SetLog } from '@shared/fitness/types'
import { act, useFitness, type FitnessView } from '@/state/fitness'
import { ExercisePicker, Modal, RPE_STEPS, useSave } from './editors'
import { LastTime } from './parts'
import { RestChoice } from './rest'
import { setupNoteView } from './setupNote'

/* ------------------------------------------------------------------ */
/* Saving                                                              */
/* ------------------------------------------------------------------ */

const SAVE_DELAY_MS = 600
/** Unsent field edits, flushed if the page is hidden or closed. */
const pending = new Map<string, () => void>()

function flushAll() {
  for (const flush of [...pending.values()]) flush()
}
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flushAll)
  document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && flushAll())
  window.addEventListener('beforeunload', (e) => {
    if (pending.size || useFitness.getState().busy > 0) {
      flushAll()
      e.preventDefault()
    }
  })
}

function patchSet(id: string, body: Record<string, unknown>, keepalive = false) {
  return useFitness.getState().write('PATCH', `/api/fitness/sets/${id}`, body, { keepalive })
}

const fmtNum = (n: number | undefined) => (n === undefined ? '' : String(n))
const parse = (text: string): number | null | 'bad' => {
  const t = text.trim().replace(',', '.')
  if (t === '') return null
  const n = Number(t)
  return Number.isFinite(n) && n >= 0 ? n : 'bad'
}

/**
 * A numeric field bound to one column of one set. Shows the server's value
 * until the owner types; then keeps the draft until it's saved.
 */
function useSetField(setId: string, field: 'weight' | 'reps', server: number | undefined, integer: boolean) {
  const [text, setText] = useState(fmtNum(server))
  const [dirty, setDirty] = useState(false)
  const [bad, setBad] = useState(false)
  const [seen, setSeen] = useState(server)
  if (server !== seen) {
    setSeen(server)
    if (!dirty) setText(fmtNum(server))
  }
  const latest = useRef(text)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const key = `${setId}:${field}`

  const send = (keepalive = false) => {
    clearTimeout(timer.current)
    pending.delete(key)
    const value = parse(latest.current)
    if (value === 'bad' || (integer && value !== null && !Number.isInteger(value))) {
      setBad(true)
      return
    }
    setBad(false)
    const sentText = latest.current
    patchSet(setId, { [field]: value }, keepalive)
      .then(() => {
        if (latest.current === sentText) setDirty(false)
      })
      .catch(() => undefined)
  }
  useEffect(() => () => clearTimeout(timer.current), [])

  return {
    text,
    bad,
    dirty,
    onChange(v: string) {
      latest.current = v
      setText(v)
      setDirty(true)
      clearTimeout(timer.current)
      pending.set(key, () => send(true))
      timer.current = setTimeout(() => send(), SAVE_DELAY_MS)
    },
    onBlur() {
      if (pending.has(key)) send()
    },
    /** The parsed draft (or server value), for ticking a set done. */
    value(): number | null | 'bad' {
      return parse(dirty ? latest.current : text)
    },
    /** Drop the draft timer; the caller is about to send this value itself. */
    claim() {
      clearTimeout(timer.current)
      pending.delete(key)
    },
  }
}

/* ------------------------------------------------------------------ */
/* Set rows                                                            */
/* ------------------------------------------------------------------ */

export interface SetHint {
  weight?: number
  reps?: number
}

/**
 * One set. In a live workout it starts empty: type load / reps / RPE, then
 * tick it. Ticking an empty field accepts the faint suggestion shown in it
 * (this workout's previous set, else last time). In history, it edits a
 * logged set. The set number opens its note (and, on a phone, delete).
 */
export function SetRow({ set, index, ex, hint, repRange, mode, onDelete }: { set: SetLog; index: number; ex?: Exercise; hint: SetHint; repRange?: string; mode: 'live' | 'history'; onDelete?: () => void }) {
  const weight = useSetField(set.id!, 'weight', set.weight, false)
  const reps = useSetField(set.id!, 'reps', set.reps, true)
  const [open, setOpen] = useState(!!set.note)
  const [note, setNote] = useState(set.note ?? '')
  const [problem, setProblem] = useState<string | null>(null)
  const repsRef = useRef<HTMLInputElement>(null)
  const bw = ex?.bodyweight

  const tick = () => {
    if (set.done) {
      if (mode === 'live') void patchSet(set.id!, { done: false }).catch(() => undefined)
      return
    }
    const w = weight.value()
    const r = reps.value()
    if (w === 'bad' || r === 'bad') return setProblem('Check the numbers')
    const finalReps = r ?? hint.reps ?? null
    if (finalReps === null) {
      setProblem('Enter reps')
      repsRef.current?.focus()
      return
    }
    setProblem(null)
    weight.claim()
    reps.claim()
    void patchSet(set.id!, { weight: w ?? hint.weight ?? null, reps: finalReps, done: true }).catch(() => undefined)
  }

  const saveNote = () => {
    if ((set.note ?? '') !== note) void patchSet(set.id!, { note: note.trim() || null }).catch(() => undefined)
  }

  return (
    <div className={`lg-set${set.done ? ' done' : ''}${weight.dirty || reps.dirty ? ' dirty' : ''}${open ? ' open' : ''}${problem ? ' problem' : ''}`}>
      <button className="lg-n mono" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label={`Set ${index + 1}: note${onDelete ? ' and delete' : ''}`}>
        {index + 1}
      </button>
      <label className={`lg-field${weight.bad ? ' bad' : ''}`}>
        <input
          className="mono"
          inputMode="decimal"
          value={weight.text}
          placeholder={hint.weight !== undefined ? fmtLoad(hint.weight) : bw ? 'BW' : ''}
          onChange={(e) => weight.onChange(e.target.value)}
          onBlur={weight.onBlur}
          onKeyDown={(e) => e.key === 'Enter' && repsRef.current?.focus()}
          aria-label={`Set ${index + 1} load`}
        />
        <span className="lg-unit">{bw ? '+lb' : 'lb'}</span>
      </label>
      <span className="lg-x">×</span>
      <label className={`lg-field reps${reps.bad ? ' bad' : ''}`}>
        <input
          ref={repsRef}
          className="mono"
          inputMode="numeric"
          value={reps.text}
          placeholder={hint.reps !== undefined ? String(hint.reps) : (repRange ?? 'reps')}
          onChange={(e) => reps.onChange(e.target.value)}
          onBlur={reps.onBlur}
          onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget.blur(), mode === 'live' && !set.done && tick())}
          aria-label={`Set ${index + 1} reps`}
        />
        <span className="lg-unit">reps</span>
      </label>
      <select className="lg-rpe" value={set.rpe ?? ''} onChange={(e) => void patchSet(set.id!, { rpe: e.target.value ? Number(e.target.value) : null }).catch(() => undefined)} aria-label={`Set ${index + 1} RPE`}>
        <option value="">RPE</option>
        {RPE_STEPS.map((r) => (
          <option key={r} value={r}>
            @{r}
          </option>
        ))}
      </select>
      <span className="lg-set-tools">
        {problem && <span className="lg-problem">{problem}</span>}
        <button className={`lg-icon${open || set.note ? ' on' : ''}`} onClick={() => setOpen((o) => !o)} aria-label={`Note for set ${index + 1}`} title="Set note">
          <MessageSquare />
        </button>
        {onDelete && (
          <button className="lg-del" onClick={onDelete} aria-label={`Delete set ${index + 1}`} title="Delete set">
            <X />
          </button>
        )}
      </span>
      {mode === 'live' ? (
        <button className={`lg-done${set.done ? ' on' : ''}`} onClick={tick} aria-pressed={!!set.done} aria-label={set.done ? `Set ${index + 1} done — undo` : `Complete set ${index + 1}`}>
          <Check />
        </button>
      ) : (
        <span className="lg-done-slot" />
      )}
      {open && (
        <input
          className="text-input lg-note"
          value={note}
          placeholder="e.g. belt on, felt fast, left knee"
          onChange={(e) => setNote(e.target.value)}
          onBlur={saveNote}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          aria-label={`Set ${index + 1} note`}
        />
      )}
    </div>
  )
}

/** Suggestions per set row: this workout's previous set, else the same set last time, else the prescription. */
export function setHints(entry: EntryLog, last: SetLog[] | undefined): SetHint[] {
  const prevDone = last ? performed(last) : []
  return entry.sets.map((_, i) => {
    const earlier = entry.sets
      .slice(0, i)
      .reverse()
      .find((s) => s.weight !== undefined || s.reps !== undefined)
    const lastTime = prevDone[i] ?? prevDone.at(-1)
    return {
      weight: earlier?.weight ?? lastTime?.weight ?? entry.target?.load,
      reps: lastTime?.reps,
    }
  })
}

/* ------------------------------------------------------------------ */
/* Exercise cards                                                      */
/* ------------------------------------------------------------------ */

/** The exercise's own note (machine settings and the like), tap to expand when long. */
function SetupNote({ note }: { note?: string | null }) {
  const [expanded, setExpanded] = useState(false)
  const view = setupNoteView(note, expanded)
  if (!view) return null
  if (!view.collapsible) return <p className="lg-setup">{view.text}</p>
  return (
    <button type="button" className={`lg-setup lg-setup-btn${view.clamped ? ' clamped' : ''}`} aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
      {view.text}
    </button>
  )
}

export function EntryCard({ entry, f, session, main }: { entry: EntryLog; f: FitnessView; session: SessionLog; main?: boolean }) {
  const ex = f.ex[entry.exerciseId]
  const prev = previousFor(f.sessions, entry.exerciseId, session.templateId, session.id)
  const hints = setHints(entry, prev?.entry.sets)
  const done = performed(entry.sets).length
  const t = entry.target
  const removeEntry = () => {
    const logged = entry.sets.filter((s) => s.done).length
    if (window.confirm(logged ? `Remove ${f.name(entry.exerciseId)} and its ${logged} logged set${logged > 1 ? 's' : ''} from this workout?` : `Remove ${f.name(entry.exerciseId)} from this workout?`)) act('DELETE', `/api/fitness/entries/${entry.id}`)
  }
  return (
    <section className={`lg-ex${main ? ' main' : ''}${t && done >= t.sets ? ' complete' : ''}`}>
      <header className="lg-head">
        <div>
          <Link to={`/exercises/${entry.exerciseId}`} className="lg-name">
            {f.name(entry.exerciseId)}
          </Link>
          <div className="lg-target">
            {t ? (
              <>
                <span className="mono">
                  {t.sets} × {fmtReps(t)}
                  {t.load !== undefined && !(ex?.bodyweight && !t.load) ? ` @ ${fmtLoad(t.load, ex?.bodyweight)}` : ''}
                </span>
                {t.rpe !== undefined && <span className="muted">RPE {t.rpe}</span>}
                {t.note && <span className="muted">· {t.note}</span>}
                {t.adjustedBy === 'sahale' && (
                  <span className="adj-mark" title={t.adjustmentNote}>
                    adjusted
                  </span>
                )}
              </>
            ) : (
              <span className="muted">added during the workout</span>
            )}
            <RestChoice ex={ex} />
            <span className="lg-count mono">
              {done}/{t?.sets ?? entry.sets.length}
            </span>
          </div>
          <SetupNote note={ex?.note} />
        </div>
        <LastTime f={f} exerciseId={entry.exerciseId} templateId={session.templateId} excludeSessionId={session.id} />
      </header>
      <div className="lg-sets">
        {entry.sets.map((s, si) => (
          <SetRow key={s.id} set={s} index={si} ex={ex} hint={hints[si]} repRange={t ? fmtReps(t) : undefined} mode="live" onDelete={() => act('DELETE', `/api/fitness/sets/${s.id}`)} />
        ))}
        <div className="lg-entry-tools">
          <button className="lg-add" onClick={() => act('POST', `/api/fitness/entries/${entry.id}/sets`)}>
            <Plus /> Add set
          </button>
          <button className="lg-add" onClick={removeEntry}>
            <Trash2 /> Remove exercise
          </button>
        </div>
      </div>
    </section>
  )
}

export function AddExercise({ sessionId, f }: { sessionId: string; f: FitnessView }) {
  return (
    <div className="lg-addex">
      <ExercisePicker value="" label="Add an exercise…" exercises={f.snap.exercises} onChange={(id) => id && act('POST', `/api/fitness/sessions/${sessionId}/entries`, { exerciseId: id })} />
    </div>
  )
}

/** Saved when the field loses focus — not on every keystroke. */
export function SessionNote({ id, initial }: { id: string; initial: string }) {
  const [note, setNote] = useState(initial)
  const [saved, setSaved] = useState(initial)
  return (
    <>
      <textarea
        className="text-input"
        rows={3}
        placeholder="How did it feel? Anything to carry into next time?"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        onBlur={() => {
          if (note === saved) return
          useFitness
            .getState()
            .write('PATCH', `/api/fitness/sessions/${id}`, { note })
            .then(() => setSaved(note))
            .catch(() => undefined)
        }}
      />
      {note !== saved && <span className="field-hint">Unsaved — click outside the box to save.</span>}
    </>
  )
}

/* ------------------------------------------------------------------ */
/* Finish                                                              */
/* ------------------------------------------------------------------ */

/** Review what will be saved, then move the workout to history in one step. */
export function FinishDialog({ session, f, onClose, onFinished }: { session: SessionLog; f: FitnessView; onClose: () => void; onFinished: () => void }) {
  const [keepUnticked, setKeepUnticked] = useState(true)
  const [duration, setDuration] = useState('')
  const sets = session.entries.flatMap((e) => e.sets)
  const done = sets.filter((s) => s.done).length
  const unticked = sets.filter((s) => !s.done && s.reps !== undefined).length
  const empty = sets.filter((s) => !s.done && s.reps === undefined).length
  const exercises = session.entries.filter((e) => e.sets.some((s) => s.done || (keepUnticked && s.reps !== undefined))).length
  const skipped = session.entries.filter((e) => !e.sets.some((s) => s.done || (keepUnticked && s.reps !== undefined))).map((e) => f.name(e.exerciseId))
  const [openedAt] = useState(() => Date.now())
  const minutes = Math.round((openedAt - new Date(session.date).getTime()) / 60_000)
  const backfill = minutes > 600
  const { error, saving, save } = useSave(onFinished)
  const logged = done + (keepUnticked ? unticked : 0)
  return (
    <Modal
      title={`Finish ${session.name}?`}
      onClose={onClose}
      footer={
        <>
          {error && <span className="form-error">{error}</span>}
          <button className="btn btn-ghost" onClick={onClose}>
            Keep logging
          </button>
          <button
            className="btn btn-primary"
            disabled={saving || logged === 0 || (backfill && !duration)}
            onClick={() => {
              flushAll()
              void save('POST', `/api/fitness/sessions/${session.id}/finish`, { keepUnticked, ...(duration ? { durationMin: Number(duration) } : {}) })
            }}
          >
            <Check /> Finish workout
          </button>
        </>
      }
    >
      <p className="finish-summary">
        <b>{logged}</b> set{logged === 1 ? '' : 's'} across <b>{exercises}</b> exercise{exercises === 1 ? '' : 's'} will be saved to History{backfill ? '' : ` · ${minutes} min`}.
      </p>
      {unticked > 0 && (
        <label className="finish-check">
          <input type="checkbox" checked={keepUnticked} onChange={(e) => setKeepUnticked(e.target.checked)} />
          <span>
            Include {unticked} set{unticked === 1 ? '' : 's'} with reps entered but not ticked
          </span>
        </label>
      )}
      {empty > 0 && (
        <p className="field-hint">
          {empty} empty set{empty === 1 ? '' : 's'} will be dropped{skipped.length ? ` (nothing logged for ${skipped.join(', ')})` : ''}. That’s fine — you don’t have to finish every prescribed set.
        </p>
      )}
      {backfill && (
        <label className="field">
          <span className="field-label">This started over 10 hours ago — how long did it take (minutes)?</span>
          <input className="text-input duration-input" inputMode="numeric" value={duration} onChange={(e) => setDuration(e.target.value)} />
        </label>
      )}
      <p className="field-hint">Your saved workout {session.templateId ? `(${f.templateById[session.templateId]?.name ?? 'template'}) ` : ''}is not changed by finishing.</p>
    </Modal>
  )
}

export { flushAll as flushPendingSets }
