import { z } from "zod";

import { ActionGuardVerdictSchema, AgentDecisionSchema } from "./decision";
import { KeyboardActionSchema } from "./keyboard";
import { AgentObservationSchema } from "./observation";
import { StepIndexSchema, TimestampSchema } from "./primitives";

/**
 * One full turn of the loop: observe → decide → guard → execute.
 *
 * The step records all four, including the guard's ruling and what was
 * *actually* executed. `executedAction` is null when the guard rejected the
 * request or the decision was STOP — so "the model asked for X" and "X
 * happened" stay distinguishable in the record. Collapsing them would make a
 * rejected action look like an executed one when the run is replayed.
 */
export const AgentStepSchema = z.object({
  index: StepIndexSchema,
  observation: AgentObservationSchema,
  decision: AgentDecisionSchema,
  guardVerdict: ActionGuardVerdictSchema,
  executedAction: KeyboardActionSchema.nullable(),
  startedAt: TimestampSchema,
  completedAt: TimestampSchema,
});
export type AgentStep = z.infer<typeof AgentStepSchema>;
