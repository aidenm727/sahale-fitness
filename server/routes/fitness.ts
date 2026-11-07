import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import {
  AddEntryInput,
  BlockInput,
  DuplicateTemplateInput,
  ExerciseInput,
  ExercisePatch,
  FinishSessionInput,
  GoalInput,
  NoteInput,
  NotePatch,
  PlanInput,
  PlanPatch,
  PlanVersion,
  RestInput,
  SessionPatch,
  SetPatch,
  StartSessionInput,
  TemplateInput,
  TemplateOrderInput,
  TemplatePatch,
} from '../../shared/schemas'
import type { AppContext } from '../app'

const Id = z.object({ id: z.string().min(1).max(80) })
const EntryNote = z.object({ note: z.string().trim().max(500).optional() })
const PlanToTemplate = z.object({ name: z.string().trim().min(1).max(80).optional(), blockId: z.string().min(1).max(80).nullable().optional() })

/** Every write answers with the committed, authoritative snapshot. */
export async function registerFitnessRoutes(app: FastifyInstance, ctx: AppContext) {
  const snap = (req: FastifyRequest) => ctx.need().fitness.snapshot(ctx.clock(req))
  const id = (req: FastifyRequest) => Id.parse(req.params).id
  const write =
    (fn: (req: FastifyRequest) => unknown, status = 200) =>
    async (req: FastifyRequest, reply: import('fastify').FastifyReply) => {
      const created = fn(req)
      return reply.code(status).send({ snapshot: snap(req), ...(typeof created === 'string' ? { id: created } : {}) })
    }

  app.get('/api/fitness', async (req) => snap(req))

  app.put('/api/fitness/goal', write((req) => ctx.need().fitness.putGoal(GoalInput.parse(req.body), ctx.clock(req))))
  app.delete('/api/fitness/goal', write((req) => ctx.need().fitness.archiveGoal(ctx.clock(req))))

  app.post('/api/fitness/blocks', write((req) => ctx.need().fitness.createBlock(BlockInput.parse(req.body), ctx.clock(req)), 201))
  app.patch('/api/fitness/blocks/:id', write((req) => ctx.need().fitness.updateBlock(id(req), BlockInput.partial().parse(req.body), ctx.clock(req))))
  app.delete('/api/fitness/blocks/:id', write((req) => ctx.need().fitness.deleteBlock(id(req))))

  // Reusable workouts (templates) — no dates.
  app.post('/api/fitness/templates', write((req) => ctx.need().fitness.createTemplate(TemplateInput.parse(req.body), ctx.clock(req)), 201))
  app.patch('/api/fitness/templates/:id', write((req) => ctx.need().fitness.updateTemplate(id(req), TemplatePatch.parse(req.body), ctx.clock(req))))
  app.delete('/api/fitness/templates/:id', write((req) => ctx.need().fitness.deleteTemplate(id(req))))
  app.post('/api/fitness/templates/:id/duplicate', write((req) => ctx.need().fitness.duplicateTemplate(id(req), DuplicateTemplateInput.parse(req.body ?? {}).name, ctx.clock(req)), 201))
  app.post('/api/fitness/templates/order', write((req) => {
    const body = TemplateOrderInput.parse(req.body)
    ctx.need().fitness.reorderTemplates(body.blockId, body.ids, ctx.clock(req))
  }))

  // Plans — optional dates on top of templates.
  app.post('/api/fitness/plans', write((req) => ctx.need().fitness.createPlan(PlanInput.parse(req.body), ctx.clock(req)), 201))
  app.patch('/api/fitness/plans/:id', write((req) => ctx.need().fitness.updatePlan(id(req), PlanPatch.parse(req.body), ctx.clock(req))))
  app.post('/api/fitness/plans/:id/reset', write((req) => ctx.need().fitness.resetPlan(id(req), PlanVersion.parse(req.body).version, ctx.clock(req))))
  app.post('/api/fitness/plans/:id/template', write((req) => ctx.need().fitness.planToTemplate(id(req), PlanToTemplate.parse(req.body ?? {}), ctx.clock(req)), 201))
  app.delete('/api/fitness/plans/:id', write((req) => ctx.need().fitness.deletePlan(id(req))))

  app.post('/api/fitness/exercises', write((req) => ctx.need().fitness.createExercise(ExerciseInput.parse(req.body), ctx.clock(req)), 201))
  app.patch('/api/fitness/exercises/:id', write((req) => ctx.need().fitness.updateExercise(id(req), ExercisePatch.parse(req.body), ctx.clock(req))))
  app.delete('/api/fitness/exercises/:id', write((req) => ctx.need().fitness.deleteExercise(id(req))))

  app.post('/api/fitness/sessions', write((req) => ctx.need().fitness.startSession(StartSessionInput.parse(req.body ?? {}), ctx.clock(req)), 201))
  app.patch('/api/fitness/sessions/:id', write((req) => ctx.need().fitness.patchSession(id(req), SessionPatch.parse(req.body), ctx.clock(req))))
  app.post('/api/fitness/sessions/:id/finish', write((req) => ctx.need().fitness.finishSession(id(req), FinishSessionInput.parse(req.body ?? {}), ctx.clock(req))))
  app.post('/api/fitness/sessions/:id/discard', write((req) => ctx.need().fitness.discardSession(id(req))))
  app.post('/api/fitness/sessions/:id/rest', write((req) => ctx.need().fitness.controlRest(id(req), RestInput.parse(req.body), ctx.clock(req))))
  app.delete('/api/fitness/sessions/:id', write((req) => ctx.need().fitness.deleteSession(id(req))))
  app.post('/api/fitness/sessions/:id/entries', write((req) => ctx.need().fitness.addEntry(id(req), AddEntryInput.parse(req.body).exerciseId, ctx.clock(req)), 201))
  app.patch('/api/fitness/entries/:id', write((req) => ctx.need().fitness.patchEntry(id(req), EntryNote.parse(req.body).note, ctx.clock(req))))
  app.delete('/api/fitness/entries/:id', write((req) => ctx.need().fitness.removeEntry(id(req), ctx.clock(req))))
  app.post('/api/fitness/entries/:id/sets', write((req) => ctx.need().fitness.addSet(id(req), ctx.clock(req)), 201))
  app.patch('/api/fitness/sets/:id', write((req) => ctx.need().fitness.patchSet(id(req), SetPatch.parse(req.body), ctx.clock(req))))
  app.delete('/api/fitness/sets/:id', write((req) => ctx.need().fitness.deleteSet(id(req), ctx.clock(req))))

  app.post('/api/fitness/notes', write((req) => ctx.need().fitness.addNote(NoteInput.parse(req.body), ctx.clock(req)), 201))
  app.patch('/api/fitness/notes/:id', write((req) => ctx.need().fitness.patchNote(id(req), NotePatch.parse(req.body), ctx.clock(req))))
  app.delete('/api/fitness/notes/:id', write((req) => ctx.need().fitness.deleteNote(id(req))))

  app.post('/api/fitness/demo/load', write((req) => ctx.need().fitness.loadDemo(ctx.clock(req))))
  app.post('/api/fitness/demo/clear', write(() => ctx.need().fitness.clearDemo()))
}
