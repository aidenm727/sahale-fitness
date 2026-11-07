/**
 * Fitness in the browser = the last snapshot the runtime sent, nothing more.
 *
 * There is no local copy of Fitness state. Every change is a request; the UI
 * re-renders from the snapshot the server returns after it commits. If a
 * request fails, the snapshot is untouched and the error is shown.
 */
import { useMemo } from 'react'
import { create } from 'zustand'
import type { Block, Exercise, FitnessSnapshot, Plan, SessionLog, WorkoutTemplate } from '@shared/fitness/types'
import { api, ApiError } from '@/runtime/api'

interface FitnessState {
  snapshot: FitnessSnapshot | null
  status: 'idle' | 'loading' | 'ready' | 'error'
  /** Why loading failed (runtime unreachable, database, …). */
  error: ApiError | null
  /** The last write that failed, for a visible notice. */
  writeError: ApiError | null
  busy: number
  load(): Promise<void>
  /** Send a write; adopt the server's snapshot on success. Throws on failure. */
  write<T extends { snapshot: FitnessSnapshot }>(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown, opts?: { keepalive?: boolean }): Promise<T>
  adopt(snapshot: FitnessSnapshot): void
  clearWriteError(): void
}

/*
 * Writes go out one at a time, in the order they were made (the live logger
 * saves fields as you type), and a response is only shown if nothing sent
 * after it has already been shown — so an older snapshot never overwrites a
 * newer one.
 */
let sent = 0
let shown = 0
let queue: Promise<unknown> = Promise.resolve()

export const useFitness = create<FitnessState>()((set, get) => ({
  snapshot: null,
  status: 'idle',
  error: null,
  writeError: null,
  busy: 0,
  async load() {
    if (!get().snapshot) set({ status: 'loading' })
    const seq = ++sent
    try {
      const snapshot = await api<FitnessSnapshot>('GET', '/api/fitness')
      if (seq < shown) return
      shown = seq
      set({ snapshot, status: 'ready', error: null })
    } catch (e) {
      set({ status: get().snapshot ? 'ready' : 'error', error: e as ApiError })
    }
  },
  write(method, path, body, opts) {
    set((s) => ({ busy: s.busy + 1 }))
    const run = async () => {
      const seq = ++sent
      try {
        const res = await api<{ snapshot: FitnessSnapshot }>(method, path, body ?? (method === 'DELETE' ? undefined : {}), opts)
        if (seq >= shown) {
          shown = seq
          set({ snapshot: res.snapshot, status: 'ready', error: null, writeError: null })
        }
        return res as never
      } catch (e) {
        const err = e instanceof ApiError ? e : new ApiError(0, 'error', String(e))
        // A 409 from Apply carries a fresh snapshot; adopt it so the UI shows the truth.
        const fresh = err.body?.snapshot as FitnessSnapshot | undefined
        set({ writeError: err, ...(fresh && seq >= shown ? { snapshot: fresh } : {}) })
        throw err
      } finally {
        set((s) => ({ busy: s.busy - 1 }))
      }
    }
    const p = queue.then(run, run)
    queue = p.catch(() => undefined)
    return p
  },
  adopt(snapshot) {
    shown = ++sent
    set({ snapshot, status: 'ready', error: null })
  },
  clearWriteError() {
    set({ writeError: null })
  },
}))

/** Fire-and-report: for buttons that don't need the result. */
export function act(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown): void {
  useFitness
    .getState()
    .write(method, path, body)
    .catch(() => undefined)
}

export interface FitnessView {
  snap: FitnessSnapshot
  ex: Record<string, Exercise>
  name(id: string): string
  /** Completed sessions, newest first. */
  sessions: SessionLog[]
  /** The current block (by date). */
  block?: Block
  /** The block whose workouts make up the program. */
  programBlock?: Block
  /** The program's reusable workouts, in their normal order. */
  program: WorkoutTemplate[]
  /** The next workout in the program's sequence. */
  nextTemplate?: WorkoutTemplate
  /** A workout planned for today, if any. */
  todayPlan?: Plan
  /** The soonest plan after today. */
  upcomingPlan?: Plan
  templateById: Record<string, WorkoutTemplate>
  planById: Record<string, Plan>
}

export function viewOf(snap: FitnessSnapshot): FitnessView {
  const ex = Object.fromEntries(snap.exercises.map((e) => [e.id, e]))
  const templateById = Object.fromEntries(snap.templates.map((w) => [w.id, w]))
  const planById = Object.fromEntries(snap.plans.map((p) => [p.id, p]))
  return {
    snap,
    ex,
    name: (id) => ex[id]?.name ?? id,
    sessions: snap.sessions,
    block: snap.blocks.find((b) => b.id === snap.currentBlockId),
    programBlock: snap.blocks.find((b) => b.id === snap.programBlockId),
    program: snap.templates.filter((w) => w.blockId === snap.programBlockId),
    nextTemplate: snap.nextTemplateId ? templateById[snap.nextTemplateId] : undefined,
    todayPlan: snap.todayPlanId ? planById[snap.todayPlanId] : undefined,
    upcomingPlan: snap.upcomingPlanId ? planById[snap.upcomingPlanId] : undefined,
    templateById,
    planById,
  }
}

/** The current Fitness view, or null while loading / unavailable. */
export function useFitnessView(): FitnessView | null {
  const snap = useFitness((s) => s.snapshot)
  return useMemo(() => (snap ? viewOf(snap) : null), [snap])
}

/** Snapshot accessor for non-React readers (palette, legacy context). */
export function fitnessNow(): FitnessView | null {
  const snap = useFitness.getState().snapshot
  return snap ? viewOf(snap) : null
}
