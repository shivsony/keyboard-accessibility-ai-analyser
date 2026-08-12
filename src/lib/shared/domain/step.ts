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
/**
 * Which mode the agent was in when it took the step.
 *
 * Recorded per step rather than derived later, because "was the agent
 * investigating at the time?" is the question that separates a keypress spent
 * gathering evidence from one spent covering new ground.
 */
export const AgentModeSchema = z.enum(["EXPLORING", "INVESTIGATING"]);
export type AgentMode = z.infer<typeof AgentModeSchema>;

/**
 * Who chose the action.
 *
 * Recorded because a report that counted deterministic sweeps as model
 * decisions would overstate what the AI did. Most steps of a traversal are
 * mechanically obvious — press Tab, see where focus goes — and code makes
 * those. The model is consulted where a judgement is genuinely required.
 */
export const DecidedBySchema = z.enum(["AI", "POLICY"]);
export type DecidedBy = z.infer<typeof DecidedBySchema>;

export const AgentStepSchema = z.object({
  index: StepIndexSchema,
  mode: AgentModeSchema,
  decidedBy: DecidedBySchema,
  observation: AgentObservationSchema,
  decision: AgentDecisionSchema,
  guardVerdict: ActionGuardVerdictSchema,
  executedAction: KeyboardActionSchema.nullable(),
  startedAt: TimestampSchema,
  completedAt: TimestampSchema,
});
export type AgentStep = z.infer<typeof AgentStepSchema>;
