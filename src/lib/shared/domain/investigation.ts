import { z } from "zod";

import { FocusStateSchema } from "./element";
import { FindingTypeSchema } from "./finding";
import { KeyboardActionRecordSchema, KeyboardActionSchema } from "./keyboard";
import {
  ConfidenceSchema,
  ElementIdSchema,
  InvestigationIdSchema,
  SeveritySchema,
  StepIndexSchema,
  TimestampSchema,
} from "./primitives";

/**
 * An open line of enquiry.
 *
 * The agent has two modes. Normally it explores: press a key, see where focus
 * lands, move on. When something looks wrong it *investigates*: it keeps
 * pressing keys, but now with a question it is trying to answer, and it
 * accumulates the evidence that would let somebody else reproduce the answer.
 *
 * The distinction exists because the alternative is an agent that reports every
 * surprise. Focus jumping from Search to Checkout might mean Menu and Filter
 * are unreachable — or it might mean the traversal has not got to them yet.
 * Those are different findings, and telling them apart takes more keypresses,
 * not more confidence.
 */

/** One thing the agent believes might explain what it saw. */
export const HypothesisSchema = z.object({
  /** In the agent's own words. Displayed, never interpreted. */
  statement: z.string().min(1).max(1000),
  raisedAtStep: StepIndexSchema,
  confidence: ConfidenceSchema,
});
export type Hypothesis = z.infer<typeof HypothesisSchema>;

export const InvestigationStatusSchema = z.enum([
  /** Still gathering evidence. At most one investigation is open at a time. */
  "OPEN",
  /** Enough evidence to report. */
  "CONFIRMED",
  /**
   * Dropped without a report.
   *
   * Kept rather than deleted: an agent that investigated and found nothing has
   * told you something useful about the page, and a run where every suspicion
   * was abandoned is a different result from one that raised none.
   */
  "ABANDONED",
]);
export type InvestigationStatus = z.infer<typeof InvestigationStatusSchema>;

/** Why an investigation ended without a finding. */
export const AbandonReasonSchema = z.enum([
  /** The agent resumed ordinary exploration. */
  "AGENT_MOVED_ON",
  /** It ran longer than the budget allows without reaching a conclusion. */
  "BUDGET_EXHAUSTED",
  /** The run ended first. */
  "RUN_ENDED",
]);
export type AbandonReason = z.infer<typeof AbandonReasonSchema>;

/**
 * Everything gathered while chasing one suspicion.
 *
 * The evidence path is kept separately from the run's overall keyboard history
 * because a reader needs both: the full sequence to reproduce the state, and
 * the slice that actually demonstrates the problem.
 */
export const InvestigationContextSchema = z.object({
  id: InvestigationIdSchema,

  /** What the agent thinks is wrong. */
  issueType: FindingTypeSchema,
  severity: SeveritySchema,
  status: InvestigationStatusSchema,

  /** The controls under suspicion — typically the ones focus skipped. */
  suspiciousElementIds: z.array(ElementIdSchema).readonly(),

  /** The step and focus position that triggered it. */
  triggeringStep: StepIndexSchema,
  triggeringFocus: FocusStateSchema,

  /** Keypresses made since the investigation opened, and where they landed. */
  evidenceActions: z.array(KeyboardActionSchema).readonly(),
  evidenceFocusSequence: z.array(FocusStateSchema).readonly(),

  /** Every action attempted while investigating, with its step. */
  attemptedActions: z.array(KeyboardActionRecordSchema).readonly(),

  hypotheses: z.array(HypothesisSchema).readonly(),

  /** Current confidence that the suspicion is real. Moves as evidence lands. */
  confidence: ConfidenceSchema,

  openedAt: TimestampSchema,
  closedAt: TimestampSchema.nullable(),
  abandonReason: AbandonReasonSchema.nullable(),
});
export type InvestigationContext = z.infer<typeof InvestigationContextSchema>;

export function isOpen(investigation: InvestigationContext): boolean {
  return investigation.status === "OPEN";
}

/** How many keypresses this investigation has spent. */
export function investigationSteps(investigation: InvestigationContext): number {
  return investigation.attemptedActions.length;
}
