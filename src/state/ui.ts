import { create } from 'zustand'

interface UiState {
  /** The navigation drawer on narrow screens (the rail is always shown on wide ones). */
  navOpen: boolean
  setNav(open: boolean): void
}

export const useUi = create<UiState>()((set) => ({
  navOpen: false,
  setNav: (navOpen) => set({ navOpen }),
}))
