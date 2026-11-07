/** "Now" for one request: the instant, and the owner's calendar date and timezone. */
export interface Clock {
  now: Date
  /** The owner's calendar date. */
  today: string
  timeZone: string
}
