import { z } from "zod";

import { FindingTypeSchema } from "./finding";
import { KeyboardActionSchema } from "./keyboard";
import { ConfidenceSchema, ElementIdSchema } from "./primitives";

/** What the agent decided to do about what it just saw. */
export const DecisionKindSchema = z.enum([
  "CONTINUE",
  "INVESTIGATE",
  "REPORT",
  "STOP",
]);
export type DecisionKind = z.infer<typeof DecisionKindSchema>;

/**
 * The model's structured output for one step.
 *
 * This is the single channel from an untrusted model into the system, so the
 * type is drawn as tightly as the domain allows. A discriminated union on
 * `decision` makes the illegal combinations unrepresentable rather than merely
 * discouraged:
 *
 * - `STOP` carries no action. Nothing is pressed when the run is over.
 * - Every other decision carries exactly one allowlisted action.
 * - `INVESTIGATE` and `REPORT` must name the issue they are about. A suspicion
 *   with no type is not actionable, and a report with no type cannot be
 *   corroborated.
 * - `CONTINUE` and `STOP` carry no suspicion, because they are not making a
 *   claim.
 *
 * Note what is *absent*: no selector, no URL, no script, no free-form command.
 * `reasoning` is displayed and stored, never interpreted (SECURITY.md §3).
 */
export const AgentDecisionSchema = z.discriminatedUnion("decision", [
  z.object({
    decision: z.literal("CONTINUE"),
    action: KeyboardActionSchema,
    reasoning: z.string().min(1),
    confidence: ConfidenceSchema,
    suspectedIssue: z.null(),
    targetElementId: ElementIdSchema.nullable(),
  }),
  z.object({
    decision: z.literal("INVESTIGATE"),
    action: KeyboardActionSchema,
    reasoning: z.string().min(1),
    confidence: ConfidenceSchema,
    suspectedIssue: FindingTypeSchema,
    targetElementId: ElementIdSchema.nullable(),
  }),
  z.object({
    decision: z.literal("REPORT"),
    action: KeyboardActionSchema,
    reasoning: z.string().min(1),
    confidence: ConfidenceSchema,
    suspectedIssue: FindingTypeSchema,
    targetElementId: ElementIdSchema.nullable(),
  }),
  z.object({
    decision: z.literal("STOP"),
    action: z.null(),
    reasoning: z.string().min(1),
    confidence: ConfidenceSchema,
    suspectedIssue: z.null(),
    targetElementId: z.null(),
  }),
]);
export type AgentDecision = z.infer<typeof AgentDecisionSchema>;

/**
 * Parses untrusted model output into a decision.
 *
 * Unknown fields are stripped rather than carried through, per the guard's
 * rules (SECURITY.md §2). A response that invents a `selector` or `script`
 * field does not get one: the parsed value contains only what is declared here,
 * so there is nothing downstream for an extra field to reach.
 */
export function parseAgentDecision(input: unknown): AgentDecision {
  return AgentDecisionSchema.parse(input);
}

export function safeParseAgentDecision(
  input: unknown,
): z.ZodSafeParseResult<AgentDecision> {
  return AgentDecisionSchema.safeParse(input);
}

/**
 * The action guard's ruling on a decision.
 *
 * Recorded either way. A model repeatedly asking for a key it cannot have is
 * itself a signal, and silently dropping the request would hide it.
 */
export const ActionGuardVerdictSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("APPROVED"),
    action: KeyboardActionSchema,
  }),
  z.object({
    outcome: z.literal("REJECTED"),
    /** What was asked for, as received. Never executed — retained as evidence. */
    requested: z.string(),
    reason: z.enum([
      "ACTION_NOT_ALLOWLISTED",
      "ACTION_PRESENT_ON_STOP",
      "ACTION_MISSING",
      "MALFORMED_DECISION",
    ]),
  }),
  /** STOP: nothing to approve, nothing rejected. */
  z.object({ outcome: z.literal("NO_ACTION") }),
]);
export type ActionGuardVerdict = z.infer<typeof ActionGuardVerdictSchema>;
