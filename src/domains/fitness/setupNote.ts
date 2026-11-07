/** Longer than this (or more than two lines) and the note collapses behind a tap. */
export const SETUP_NOTE_SHORT = 90

export interface SetupNoteView {
  text: string
  /** True when the note is long enough to need tap-to-expand. */
  collapsible: boolean
  /** True when it should currently be clamped to two lines. */
  clamped: boolean
}

/**
 * What the live logger shows under an exercise name: the exercise's own `note`
 * (machine settings, cable height...), or nothing when it is empty.
 */
export function setupNoteView(note: string | null | undefined, expanded: boolean): SetupNoteView | null {
  const text = note?.trim()
  if (!text) return null
  const collapsible = text.length > SETUP_NOTE_SHORT || text.split('\n').length > 2
  return { text, collapsible, clamped: collapsible && !expanded }
}

/**
 * The value to send for an optional text field (note, short name) when saving an
 * exercise. An edit sends the text as typed, empty included: the server treats ""
 * as "clear it" but leaves an omitted field alone. A new exercise has nothing to
 * clear, so an empty value is left out.
 */
export function optionalTextForSave(value: string, editing: boolean): string | undefined {
  return editing ? value : value || undefined
}
