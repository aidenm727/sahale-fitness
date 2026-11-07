/**
 * The app's map. Every place is a node: the overview at the root, the views under it, and the
 * objects reached by drilling in (a workout, a session, an exercise). The rail, the path bar,
 * the page sub-navigation and the document title all read from this tree.
 */
import type { LucideIcon } from 'lucide-react'
import { Activity, Dumbbell, Gauge, History, Layers, ListOrdered } from 'lucide-react'
import { matchPath } from 'react-router'
import { fmt } from '@/lib/time'
import { fitnessNow } from '@/state/fitness'

export type Params = Record<string, string | undefined>

export interface NavNode {
  id: string
  title: string
  path: string
  parent?: string
  icon?: LucideIcon
  /** Not listed in the rail or the sub-navigation (reached by drilling in). */
  hidden?: boolean
  /** The title of an object; undefined when the object doesn't exist. */
  title$?: (p: Params) => string | undefined
}

export const nodes: NavNode[] = [
  { id: 'overview', title: 'Fitness', path: '/', icon: Dumbbell },
  { id: 'today', title: 'Today', path: '/today', parent: 'overview', icon: Activity },
  { id: 'program', title: 'Program', path: '/program', parent: 'overview', icon: Layers },
  {
    id: 'workout',
    title: 'Workout',
    path: '/workouts/:templateId',
    parent: 'program',
    hidden: true,
    title$: (p) => {
      const f = fitnessNow()
      return f ? f.templateById[p.templateId ?? '']?.name : 'Workout'
    },
  },
  { id: 'history', title: 'History', path: '/history', parent: 'overview', icon: History },
  {
    id: 'session',
    title: 'Session',
    path: '/history/:sessionId',
    parent: 'history',
    hidden: true,
    title$: (p) => {
      const f = fitnessNow()
      if (!f) return 'Session' // still loading; the page itself reports a missing session
      const s = f.sessions.find((x) => x.id === p.sessionId) ?? (f.snap.active?.id === p.sessionId ? f.snap.active : undefined)
      return s ? `${s.name} · ${fmt.monthDay(s.date)}` : undefined
    },
  },
  { id: 'exercises', title: 'Exercises', path: '/exercises', parent: 'overview', icon: ListOrdered },
  {
    id: 'exercise',
    title: 'Exercise',
    path: '/exercises/:exerciseId',
    parent: 'exercises',
    hidden: true,
    title$: (p) => {
      const f = fitnessNow()
      return f ? f.ex[p.exerciseId ?? '']?.name : 'Exercise'
    },
  },
  { id: 'runtime', title: 'Runtime', path: '/runtime', parent: 'overview', icon: Gauge, hidden: true },
]

export const nodeById: Record<string, NavNode> = Object.fromEntries(nodes.map((n) => [n.id, n]))

export function childrenOf(id: string): NavNode[] {
  return nodes.filter((n) => n.parent === id && !n.hidden)
}

function fillPath(pattern: string, params: Params): string {
  return pattern.replace(/:(\w+)/g, (_, k: string) => params[k] ?? '')
}

export interface Crumb {
  node: NavNode
  title: string
  href: string
}

export interface NodeMatch {
  node: NavNode
  params: Params
  trail: Crumb[]
}

export function matchLocation(pathname: string): NodeMatch | null {
  for (const node of nodes) {
    const m = matchPath({ path: node.path, end: true }, pathname)
    if (m) {
      const params = m.params as Params
      return { node, params, trail: trailFor(node, params) }
    }
  }
  return null
}

export function trailFor(node: NavNode, params: Params): Crumb[] {
  const out: Crumb[] = []
  let cur: NavNode | undefined = node
  while (cur) {
    out.unshift({ node: cur, title: cur.title$?.(params) ?? cur.title, href: fillPath(cur.path, params) })
    cur = cur.parent ? nodeById[cur.parent] : undefined
  }
  return out
}
