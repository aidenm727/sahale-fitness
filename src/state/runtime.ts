/** What the browser knows about the runtime. */
import { create } from 'zustand'
import { api, ApiError } from '@/runtime/api'

interface RuntimeState {
  reachable: boolean | null
  db: string | null
  error: ApiError | null
  refresh(): Promise<void>
}

export const useRuntime = create<RuntimeState>()((set) => ({
  reachable: null,
  db: null,
  error: null,
  async refresh() {
    try {
      const health = await api<{ ok: boolean; db: string }>('GET', '/api/runtime/health')
      set({ reachable: true, db: health.db, error: null })
    } catch (e) {
      const err = e as ApiError
      set({ reachable: err.kind !== 'unreachable', error: err, ...(err.kind === 'unreachable' ? { db: null } : {}) })
    }
  },
}))
