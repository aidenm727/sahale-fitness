/**
 * DEMO DATA — a made-up training history, written into the database as ordinary
 * rows marked `origin = 'demo'`. Only loaded on request.
 *
 * It is generated relative to the moment it's loaded (block 3 started 17 days
 * earlier; the next workout in its sequence is Lower · Squat, which is also
 * planned for today), then ages like real data. Block 3 has four reusable
 * workouts with rep-range prescriptions; its history links to them.
 * "Clear demo data" removes exactly these rows.
 */
import { addDays } from '../../shared/dates'
import { round, seeded } from '../../shared/random'
import type { NoteTag } from '../../shared/fitness/types'
import { newId } from '../ids'
import type * as schema from '../db/schema'

type Row<T extends { $inferInsert: unknown }> = T['$inferInsert']

export interface DemoData {
  goal: Row<typeof schema.goals>
  goalTargets: Row<typeof schema.goalTargets>[]
  blocks: Row<typeof schema.blocks>[]
  templates: Row<typeof schema.templates>[]
  templateItems: Row<typeof schema.templateItems>[]
  plans: Row<typeof schema.plans>[]
  sessions: Row<typeof schema.sessions>[]
  entries: Row<typeof schema.sessionEntries>[]
  sets: Row<typeof schema.sessionSets>[]
  notes: Row<typeof schema.notes>[]
}

type TemplateId = 'lower-dl' | 'upper-bench' | 'lower-squat' | 'upper-press'
type MainLift = 'back-squat' | 'bench-press' | 'deadlift' | 'overhead-press'

const B3_START = -17

const BLOCKS = [
  { n: 1, name: 'Hypertrophy I', phase: 'Base', intent: 'Rebuild work capacity after summer travel. Higher reps, moderate loads.', startDay: B3_START - 70, weeks: 5, deloadWeek: 5, scheme: '3×8–10' },
  { n: 2, name: 'Hypertrophy II', phase: 'Base', intent: 'Volume peak. An extra set on every main lift, same rep range.', startDay: B3_START - 35, weeks: 5, deloadWeek: 5, scheme: '4×6–8' },
  { n: 3, name: 'Strength Accumulation', phase: 'Strength', intent: 'Move to 4–5 rep sets and build bar speed. Accessories hold steady.', startDay: B3_START, weeks: 5, deloadWeek: 5, scheme: '4×5 → 4×4' },
  { n: 4, name: 'Intensification', phase: 'Strength', intent: 'Triples and doubles. Cut accessory volume by a third.', startDay: B3_START + 35, weeks: 4, deloadWeek: 4, scheme: '5×3 / 4×2' },
  { n: 5, name: 'Peak & Test', phase: 'Peak', intent: 'Heavy singles at RPE 8, then a test day for all three lifts.', startDay: B3_START + 63, weeks: 2, deloadWeek: undefined, scheme: 'Singles → test' },
]

const WEEK_PATTERN: Record<number, TemplateId> = { 0: 'lower-dl', 1: 'upper-bench', 3: 'lower-squat', 4: 'upper-press' }

const BODYWEIGHT = new Set(['leg-raise', 'ab-wheel'])

/** Block 3's reusable workouts: [exerciseId, sets, repMin, repMax, rpe?, note?]. */
const BLOCK3: Record<TemplateId, [string, number, number, number, number?, string?][]> = {
  'lower-dl': [['deadlift', 3, 3, 5, 8], ['front-squat', 3, 6, 8, 8], ['walking-lunge', 2, 10, 12, undefined, 'Reps per leg'], ['back-ext', 3, 10, 15], ['ab-wheel', 3, 8, 12]],
  'upper-bench': [['bench-press', 4, 4, 6, 8, 'Pause the first rep'], ['pull-up', 4, 5, 8, 8], ['incline-db', 3, 8, 12, 8], ['cs-row', 3, 8, 12], ['lateral-raise', 3, 12, 20]],
  'lower-squat': [['back-squat', 4, 4, 6, 8], ['rdl', 3, 6, 10, 8], ['split-squat', 2, 8, 12, 8, 'Per leg · controlled depth — left knee'], ['leg-curl', 3, 8, 15], ['standing-calf-raise', 3, 10, 15], ['leg-raise', 3, 10, 15]],
  'upper-press': [['overhead-press', 4, 4, 6, 8], ['barbell-row', 4, 6, 10, 8], ['cg-bench', 3, 6, 10], ['lat-pulldown', 3, 10, 12], ['face-pull', 3, 12, 20]],
}
const BLOCK3_ORDER: TemplateId[] = ['lower-dl', 'upper-bench', 'lower-squat', 'upper-press']

const TEMPLATES: Record<TemplateId, { name: string; focus: string; main: MainLift; accessories: [string, number, number, number, number][] }> = {
  'lower-dl': { name: 'Lower · Deadlift', focus: 'Deadlift', main: 'deadlift', accessories: [['front-squat', 3, 6, 175, 2], ['walking-lunge', 2, 12, 35, 0.6], ['back-ext', 3, 12, 15, 0.8], ['ab-wheel', 3, 10, 0, 0]] },
  'upper-bench': { name: 'Upper · Bench', focus: 'Bench', main: 'bench-press', accessories: [['pull-up', 4, 6, 15, 1.2], ['incline-db', 3, 10, 50, 0.9], ['cs-row', 3, 10, 55, 1], ['lateral-raise', 3, 15, 17.5, 0.4]] },
  'lower-squat': { name: 'Lower · Squat', focus: 'Squat', main: 'back-squat', accessories: [['rdl', 3, 8, 185, 2.2], ['split-squat', 3, 10, 35, 0.8], ['leg-curl', 3, 12, 90, 1.6], ['leg-raise', 3, 12, 0, 0]] },
  'upper-press': { name: 'Upper · Press', focus: 'Press', main: 'overhead-press', accessories: [['barbell-row', 4, 8, 145, 2], ['cg-bench', 3, 8, 140, 1.8], ['lat-pulldown', 3, 12, 120, 1.6], ['face-pull', 3, 15, 35, 1]] },
}

const MAIN: Record<MainLift, { sets: number[]; reps: number[]; loads: number[] }[]> = {
  'back-squat': [
    { sets: [3, 3, 3, 3, 3], reps: [10, 10, 10, 10, 8], loads: [195, 200, 205, 210, 170] },
    { sets: [4, 4, 4, 4, 3], reps: [8, 8, 8, 8, 6], loads: [220, 225, 230, 235, 190] },
    { sets: [4, 4, 4, 4, 3], reps: [5, 5, 5, 4, 5], loads: [255, 260, 265, 275, 215] },
    { sets: [5, 5, 5, 3], reps: [3, 3, 3, 3], loads: [285, 290, 300, 240] },
    { sets: [3, 1], reps: [1, 1], loads: [295, 315] },
  ],
  'bench-press': [
    { sets: [3, 3, 3, 3, 3], reps: [10, 10, 10, 10, 8], loads: [140, 145, 147.5, 150, 120] },
    { sets: [4, 4, 4, 4, 3], reps: [8, 8, 8, 8, 6], loads: [157.5, 160, 162.5, 165, 135] },
    { sets: [4, 4, 4, 4, 3], reps: [5, 5, 5, 4, 5], loads: [180, 182.5, 185, 190, 155] },
    { sets: [5, 5, 5, 3], reps: [3, 3, 3, 3], loads: [195, 200, 205, 165] },
    { sets: [3, 1], reps: [1, 1], loads: [210, 225] },
  ],
  deadlift: [
    { sets: [3, 3, 3, 3, 2], reps: [8, 8, 8, 8, 6], loads: [250, 255, 260, 265, 215] },
    { sets: [3, 3, 3, 3, 2], reps: [6, 6, 6, 6, 5], loads: [290, 295, 300, 305, 245] },
    { sets: [3, 3, 3, 3, 2], reps: [4, 4, 4, 3, 4], loads: [325, 330, 335, 345, 275] },
    { sets: [4, 4, 4, 2], reps: [2, 2, 2, 3], loads: [360, 370, 380, 300] },
    { sets: [2, 1], reps: [1, 1], loads: [385, 405] },
  ],
  'overhead-press': [
    { sets: [3, 3, 3, 3, 3], reps: [10, 10, 10, 10, 8], loads: [87.5, 90, 92.5, 95, 75] },
    { sets: [4, 4, 4, 4, 3], reps: [8, 8, 8, 8, 6], loads: [97.5, 100, 102.5, 105, 85] },
    { sets: [4, 4, 4, 4, 3], reps: [5, 5, 5, 4, 5], loads: [115, 117.5, 120, 122.5, 95] },
    { sets: [5, 5, 5, 3], reps: [3, 3, 3, 3], loads: [125, 127.5, 130, 105] },
    { sets: [3, 1], reps: [1, 1], loads: [132.5, 140] },
  ],
}

const RPE_BY_WEEK = [7, 7.5, 8, 8.5, 6]

const SESSION_NOTES: Record<number, string> = {
  [-2]: 'Bench 185 ×5 for four sets, last one RPE 8. Pull-ups felt easy — try +35 next week.',
  [-3]: 'Deadlift 335 moved fast on all three sets. Grip slipped on set 3; chalk next time.',
  [-6]: 'OHP 117.5 for 5s. Last set was a grind. Face pulls helped the shoulder feel better.',
  [-7]: 'Squat 260 felt heavier than it should (RPE 8.5 on the last set) — only slept ~6h. Left knee achy on split squats; cut depth.',
  [-10]: 'Deadlift 330 ×4. Hips felt locked in.',
  [-17]: 'Block 3 starts. Backed off the belt on warmups.',
  [-21]: 'Deload. Everything felt snappy.',
  [-31]: 'Gym packed at 6pm — waited 15 min for a rack. Train earlier.',
  [-35]: 'Squat 230 ×8 ×4. Legs fried for two days.',
  [-41]: 'Missed the last rep of the final OHP set at 100.',
}
const SESSION_READINESS: Record<number, number> = { [-2]: 4, [-3]: 4, [-6]: 3, [-7]: 2, [-10]: 4 }
const SKIPPED = new Set([-30, -59, -66])

interface Planned {
  day: number
  blockN: number
  week: number
  deload: boolean
  template: TemplateId
  items: { exerciseId: string; sets: number; reps: number; load: number; rpe: number; note?: string }[]
}

function locate(day: number) {
  for (const b of BLOCKS) {
    if (day >= b.startDay && day < b.startDay + b.weeks * 7) {
      const d = day - b.startDay
      return { block: b, week: Math.floor(d / 7) + 1, dayInWeek: d % 7 }
    }
  }
  return null
}

function trainingWeeksBefore(blockN: number, week: number): number {
  let n = 0
  for (const b of BLOCKS) {
    for (let w = 1; w <= b.weeks; w++) {
      if (b.n === blockN && w === week) return n
      if (w !== b.deloadWeek) n++
    }
  }
  return n
}

function planFor(day: number): Planned | null {
  const loc = locate(day)
  if (!loc) return null
  const template = WEEK_PATTERN[loc.dayInWeek]
  if (!template) return null
  const t = TEMPLATES[template]
  const m = MAIN[t.main][loc.block.n - 1]
  const wi = Math.min(loc.week, m.loads.length) - 1
  const deload = loc.week === loc.block.deloadWeek
  const tw = trainingWeeksBefore(loc.block.n, loc.week)
  return {
    day,
    blockN: loc.block.n,
    week: loc.week,
    deload,
    template,
    items: [
      {
        exerciseId: t.main,
        sets: m.sets[wi],
        reps: m.reps[wi],
        load: m.loads[wi],
        rpe: deload ? 6 : loc.block.n === 5 ? 8 : RPE_BY_WEEK[wi],
        note: deload ? 'Deload — leave plenty in the tank' : undefined,
      },
      ...t.accessories.map(([exerciseId, sets, reps, start, gain]) => {
        const raw = (start + gain * tw) * (deload ? 0.8 : 1)
        const load = BODYWEIGHT.has(exerciseId) ? 0 : round(raw, raw >= 30 ? 5 : 2.5)
        return {
          exerciseId,
          sets: deload || loc.block.n >= 4 ? Math.max(2, sets - 1) : sets,
          reps,
          load,
          rpe: 8,
          note: exerciseId === 'split-squat' ? 'Controlled depth — left knee' : undefined,
        }
      }),
    ],
  }
}

/** Build demo rows as of `now` (local time) with `today` as the owner's calendar date. */
export function buildDemo(now: Date, today: string): DemoData {
  const stamp = now.toISOString()
  const at = (day: number, hh = 0, mm = 0) => {
    const d = new Date(now)
    d.setHours(0, 0, 0, 0)
    d.setDate(d.getDate() + day)
    d.setHours(hh, mm, 0, 0)
    return d.toISOString()
  }
  const base = { origin: 'demo' as const, createdAt: stamp, updatedAt: stamp }

  const blockIds = new Map<number, string>()
  const blocks = BLOCKS.map((b) => {
    const id = newId('b')
    blockIds.set(b.n, id)
    return { id, name: b.name, phase: b.phase, intent: b.intent, scheme: b.scheme, startDate: addDays(today, b.startDay), weeks: b.weeks, deloadWeek: b.deloadWeek ?? null, ...base }
  })

  // Block 3's reusable workouts, in their normal order.
  const b3 = blockIds.get(3)!
  const templateIds = new Map<TemplateId, string>()
  const templates: DemoData['templates'] = []
  const templateItems: DemoData['templateItems'] = []
  BLOCK3_ORDER.forEach((tid, position) => {
    const id = newId('wt')
    templateIds.set(tid, id)
    templates.push({ id, blockId: b3, position, name: TEMPLATES[tid].name, focus: TEMPLATES[tid].focus, notes: null, version: 1, ...base })
    BLOCK3[tid].forEach(([exerciseId, sets, repMin, repMax, rpe, note], i) =>
      templateItems.push({ id: newId('ti'), templateId: id, position: i, exerciseId, sets, repMin, repMax, targetRpe: rpe ?? null, targetLoad: null, note: note ?? null }),
    )
  })
  // Optional dates: today's Lower · Squat and tomorrow's Upper · Press.
  const plans: DemoData['plans'] = (
    [
      ['lower-squat', 0],
      ['upper-press', 1],
    ] as const
  ).map(([tid, day]) => ({
    id: newId('pl'),
    templateId: templateIds.get(tid)!,
    blockId: b3,
    date: addDays(today, day),
    name: TEMPLATES[tid].name,
    focus: TEMPLATES[tid].focus,
    notes: null,
    ownPrescription: false,
    legacy: false,
    version: 1,
    ...base,
  }))

  const sessions: DemoData['sessions'] = []
  const entries: DemoData['entries'] = []
  const sets: DemoData['sets'] = []
  const rng = seeded(4417)
  for (let day = -84; day <= -1; day++) {
    const p = planFor(day)
    if (!p || SKIPPED.has(day)) continue
    const weekRpe = [7, 7.5, 8, 8.5, 6][Math.min(p.week, 5) - 1]
    const tired = day === -7
    const sessionId = newId('s')
    const startedAt = at(day, rng.chance(0.5) ? 10 : 17, rng.int(0, 5) * 10)
    const durationMin = rng.int(56, 82)
    const fromTemplate = p.blockN === 3 ? p.template : undefined
    p.items.forEach((pi, position) => {
      const entryId = newId('se')
      const isMain = position === 0
      // Block 3 sessions snapshot the template's rep range; earlier blocks prescribed exact reps.
      const range = fromTemplate ? BLOCK3[fromTemplate].find((x) => x[0] === pi.exerciseId) : undefined
      entries.push({
        id: entryId,
        sessionId,
        position,
        exerciseId: pi.exerciseId,
        note: pi.exerciseId === 'split-squat' && day === -7 ? 'Knee achy below parallel — shortened ROM' : null,
        targetSets: pi.sets,
        targetRepMin: range ? range[2] : pi.reps,
        targetRepMax: range ? range[3] : pi.reps,
        targetRpe: pi.rpe,
        targetLoad: pi.load || null,
        targetNote: pi.note ?? range?.[5] ?? null,
      })
      for (let s = 0; s < pi.sets; s++) {
        let reps = pi.reps
        const isLast = s === pi.sets - 1
        if (!isMain && BODYWEIGHT.has(pi.exerciseId) && isLast && rng.chance(0.4)) reps -= 2
        if (isMain && isLast && day === -41 && pi.exerciseId === 'overhead-press') reps -= 1
        const rpe = isMain ? Math.min(9.5, weekRpe + (isLast ? 0.5 : 0) + (tired ? 0.5 : 0) + (rng.chance(0.15) ? 0.5 : 0)) : null
        sets.push({ id: newId('ss'), entryId, position: s, weight: pi.load, reps, rpe, done: true })
      }
    })
    sessions.push({
      id: sessionId,
      planId: null,
      templateId: fromTemplate ? templateIds.get(fromTemplate)! : null,
      name: TEMPLATES[p.template].name,
      status: 'completed',
      startedAt,
      endedAt: new Date(new Date(startedAt).getTime() + durationMin * 60_000).toISOString(),
      durationMin,
      note: SESSION_NOTES[day] ?? null,
      readiness: SESSION_READINESS[day] ?? rng.int(3, 5),
      blockId: blockIds.get(p.blockN)!,
      week: p.week,
      isDeload: p.deload,
      version: 1,
      ...base,
    })
  }

  const goalId = newId('g')
  const goal = {
    id: goalId,
    statement: 'Squat 315, bench 225 and deadlift 405 on test day — while trimming to ~175 lb.',
    targetDate: addDays(today, BLOCKS[4].startDay + 12),
    bodyweightTarget: 175,
    status: 'active' as const,
    ...base,
    createdAt: at(B3_START - 70, 9),
  }
  const goalTargets = (
    [
      ['back-squat', 315],
      ['bench-press', 225],
      ['deadlift', 405],
    ] as const
  ).map(([exerciseId, targetLoad], position) => ({ id: newId('gt'), goalId, exerciseId, targetLoad, position }))

  const note = (text: string, day: number, hh: number, mm: number, tag: NoteTag, pinned: boolean) => ({ id: newId('n'), text, tag, pinned, ...base, createdAt: at(day, hh, mm), updatedAt: at(day, hh, mm) })
  const notes = [
    note('Left knee: mild ache on deep split squats. Controlled ROM; squats are pain-free. Re-check at the end of block 3.', -15, 21, 4, 'body', true),
    note('Week 5 deload is non-negotiable this block. Skipped it in the spring and stalled for a month.', -17, 9, 30, 'program', true),
    note('Bench: pause the first rep of every set. Keeps the setup honest.', -33, 18, 12, 'technique', true),
    note('Gym is packed 5–7pm. Train before noon on weekends.', -31, 19, 40, 'logistics', false),
  ]

  return { goal, goalTargets, blocks, templates, templateItems, plans, sessions, entries, sets, notes }
}
