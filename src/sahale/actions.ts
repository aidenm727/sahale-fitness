import { act, fitnessNow } from '@/state/fitness'

export interface WorkoutAction {
  label: string
  run: (navigate: (to: string) => void) => void
}

/** The top bar's one action: resume the live workout, else start the next one. Null when neither applies. */
export function workoutAction(): WorkoutAction | null {
  const f = fitnessNow()
  if (!f) return null
  if (f.snap.active) return { label: 'Resume the workout in progress', run: (navigate) => navigate('/today') }
  const plan = f.todayPlan?.status === 'today' ? f.todayPlan : undefined
  if (!plan && !f.nextTemplate) return null
  return {
    label: 'Start the next workout',
    run: (navigate) => {
      act('POST', '/api/fitness/sessions', plan ? { planId: plan.id } : { templateId: f.nextTemplate!.id })
      navigate('/today')
    },
  }
}
