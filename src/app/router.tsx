import { createBrowserRouter } from 'react-router'
import { Shell } from '@/shell/Shell'
import { ExercisePage } from '@/domains/fitness/ExercisePage'
import { ExercisesPage } from '@/domains/fitness/ExercisesPage'
import { FitnessOverview } from '@/domains/fitness/FitnessOverview'
import { HistoryPage } from '@/domains/fitness/HistoryPage'
import { ProgramPage } from '@/domains/fitness/ProgramPage'
import { SessionPage } from '@/domains/fitness/SessionPage'
import { TodayPage } from '@/domains/fitness/TodayPage'
import { WorkoutPage } from '@/domains/fitness/WorkoutPage'
import { NotFound } from '@/domains/NotFound'
import { RuntimePage } from '@/domains/runtime/RuntimePage'

/** URL routes. The navigational meaning of each path lives in sahale/tree.ts. */
export const router = createBrowserRouter([
  {
    path: '/',
    element: <Shell />,
    children: [
      { index: true, element: <FitnessOverview /> },
      { path: 'today', element: <TodayPage /> },
      { path: 'program', element: <ProgramPage /> },
      { path: 'workouts/:templateId', element: <WorkoutPage /> },
      { path: 'history', element: <HistoryPage /> },
      { path: 'history/:sessionId', element: <SessionPage /> },
      { path: 'exercises', element: <ExercisesPage /> },
      { path: 'exercises/:exerciseId', element: <ExercisePage /> },
      { path: 'runtime', element: <RuntimePage /> },
      { path: '*', element: <NotFound /> },
    ],
  },
])
