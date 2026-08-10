import { z } from "zod";

import { FindingTypeSchema } from "./finding";
import { KeyboardActionSchema, type KeyboardAction } from "./keyboard";
import { ConfidenceSchema, ElementIdSchema, SeveritySchema } from "./primitives";

/**
 * The structured output contract.
 *
 * This is the **only** channel from an untrusted model into the system, and the
 * only thing standing between generated text and a real browser. Nothing here is
 * free-form: the model picks from enums, supplies prose that is displayed and
 * never interpreted, and has no way to express a selector, a URL, a script, or a
 * command.
 *
 * The browser executes nothing until a response has passed this schema. That
 * order is enforced three times over — the provider parses before returning
 * (`lib/ai`), the action guard validates before dispatching (`lib/agent`), and
 * the executor re-checks the allowlist before pressing (`lib/browser`).
 */

/** What the agent decided to do about what it just saw. */
export const DecisionKindSchema = z.enum(["CONTINUE", "INVESTIGATE", "REPORT", "STOP"]);
export type DecisionKind = z.infer<typeof DecisionKindSchema>;

/**
 * A hypothesis the agent is still testing.
 *
 * Type and severity only. A suspicion has not earned a title and a description
 * yet — those belong to findings that survive corroboration, and asking for them
 * up front invites the model to write the bug report before it has the evidence.
 */
export const SuspectedIssueSchema = z.object({
  type: FindingTypeSchema,
  severity: SeveritySchema,
});
export type SuspectedIssue = z.infer<typeof SuspectedIssueSchema>;

/**
 * An issue the agent is prepared to report.
 *
 * `title` and `description` are written for a developer reading a bug report, so
 * both are required and non-empty. They may quote page-authored text — the model
 * is summarising a page it does not control — so both are untrusted content and
 * are escaped wherever they are displayed.
 */
export const ReportedIssueSchema = z.object({
  type: FindingTypeSchema,
  severity: SeveritySchema,
  /** One line, as a bug report headline. */
  title: z.string().min(1).max(200),
  /** What is wrong, and who it affects. */
  description: z.string().min(1).max(4000),
});
export type ReportedIssue = z.infer<typeof ReportedIssueSchema>;

const reason = z.string().min(1).max(2000);

/**
 * The model's decision for one step.
 *
 * A discriminated union on `decision`, so the illegal combinations are
 * unrepresentable rather than merely discouraged:
 *
 * - `CONTINUE` and `INVESTIGATE` carry exactly one allowlisted action. They are
 *   the decisions that move.
 * - `INVESTIGATE` must name what it suspects. A hypothesis with no type cannot
 *   be corroborated, so it could never become a finding.
 * - `REPORT` carries the issue and **no action**. Reporting is a bookkeeping
 *   step: the finding is recorded, and the next decision chooses where to go.
 * - `STOP` carries nothing but its reason. Nothing is pressed once the run is
 *   over.
 *
 * A field absent from a member is dropped when a model sends it anyway, so a
 * `CONTINUE` arriving with an `issue` attached does not smuggle one through.
 */
export const AgentDecisionSchema = z.discriminatedUnion("decision", [
  z.object({
    decision: z.literal("CONTINUE"),
    action: KeyboardActionSchema,
    reason,
    confidence: ConfidenceSchema,
    targetElementId: ElementIdSchema.nullish(),
  }),
  z.object({
    decision: z.literal("INVESTIGATE"),
    action: KeyboardActionSchema,
    reason,
    confidence: ConfidenceSchema,
    suspectedIssue: SuspectedIssueSchema,
    targetElementId: ElementIdSchema.nullish(),
  }),
  z.object({
    decision: z.literal("REPORT"),
    reason,
    confidence: ConfidenceSchema,
    issue: ReportedIssueSchema,
    targetElementId: ElementIdSchema.nullish(),
  }),
  z.object({
    decision: z.literal("STOP"),
    reason,
    confidence: ConfidenceSchema,
  }),
]);
export type AgentDecision = z.infer<typeof AgentDecisionSchema>;

export type ContinueDecision = Extract<AgentDecision, { decision: "CONTINUE" }>;
export type InvestigateDecision = Extract<AgentDecision, { decision: "INVESTIGATE" }>;
export type ReportDecision = Extract<AgentDecision, { decision: "REPORT" }>;
export type StopDecision = Extract<AgentDecision, { decision: "STOP" }>;

/**
 * The action a decision asks for, if any.
 *
 * The single place that answers "is there a key to press", so callers do not
 * re-derive it from the discriminant and get it subtly wrong.
 */
export function actionFor(decision: AgentDecision): KeyboardAction | null {
  return decision.decision === "CONTINUE" || decision.decision === "INVESTIGATE"
    ? decision.action
    : null;
}

/** The issue a decision names, whether suspected or reported. */
export function issueFor(decision: AgentDecision): SuspectedIssue | ReportedIssue | null {
  if (decision.decision === "INVESTIGATE") return decision.suspectedIssue;
  if (decision.decision === "REPORT") return decision.issue;
  return null;
}

/**
 * Parses untrusted model output into a decision.
 *
 * Unknown fields are stripped rather than carried through, per the guard's rules
 * (SECURITY.md §2). A response that invents a `selector` or `script` field does
 * not get one: the parsed value contains only what is declared above, so there
 * is nothing downstream for an extra field to reach.
 *
 * Throws on anything malformed, and never falls back to a default action —
 * guessing a keypress on the model's behalf is exactly what the structured
 * contract exists to prevent.
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
  /** REPORT and STOP: nothing to approve, nothing rejected. */
  z.object({ outcome: z.literal("NO_ACTION") }),
]);
export type ActionGuardVerdict = z.infer<typeof ActionGuardVerdictSchema>;
