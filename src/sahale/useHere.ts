import { useMemo } from 'react'
import { useLocation } from 'react-router'
import { useFitness } from '@/state/fitness'
import { matchLocation, nodeById, trailFor, type NodeMatch } from './tree'

/**
 * Where the owner is standing in the map right now. Unknown paths (and objects that don't
 * resolve) fall back to the overview and are flagged `unmatched`.
 */
export function useHere(): NodeMatch & { unmatched?: boolean } {
  const { pathname } = useLocation()
  // Object titles (a session, an exercise) come from runtime state.
  const fitnessAt = useFitness((s) => s.snapshot?.generatedAt)
  return useMemo(() => {
    const m = matchLocation(pathname)
    if (!m) return { node: nodeById.overview, params: {}, trail: trailFor(nodeById.overview, {}), unmatched: true }
    const unresolved = !!m.node.title$ && !m.node.title$(m.params)
    return unresolved ? { ...m, unmatched: true } : m
  }, [pathname, fitnessAt]) // eslint-disable-line react-hooks/exhaustive-deps
}
