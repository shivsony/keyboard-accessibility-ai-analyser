import { z } from "zod";

import { FocusStateSchema } from "./element";
import { KeyboardActionSchema } from "./keyboard";
import {
  ConfidenceSchema,
  ElementIdSchema,
  FindingIdSchema,
  ScreenshotIdSchema,
  SeveritySchema,
  StepIndexSchema,
  TimestampSchema,
} from "./primitives";
import { AccessibilitySnapshotSchema, DOMSnapshotSchema } from "./snapshot";

/** The five MVP finding types. */
export const FindingTypeSchema = z.enum([
  "UNREACHABLE_INTERACTIVE_ELEMENT",
  "SUSPICIOUS_FOCUS_ORDER",
  "UNEXPECTED_FOCUS_LEAVING_PAGE",
  "SUSPICIOUS_FOCUS_CYCLE",
  "NO_KEYBOARD_REACHABLE_CONTROLS",
]);
export type FindingType = z.infer<typeof FindingTypeSchema>;

/**
 * Type-specific particulars.
 *
 * A discriminated union because the five findings are not the same shape: a
 * focus cycle is a list of elements, an unreachable control is one element, and
 * "no reachable controls" is a count. Flattening them into optional fields
 * would make every consumer re-check which fields happen to be populated.
 */
export const FindingDetailsSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("UNREACHABLE_INTERACTIVE_ELEMENT"),
    elementId: ElementIdSchema,
  }),
  z.object({
    type: z.literal("SUSPICIOUS_FOCUS_ORDER"),
    /** Focus order as observed. */
    observedOrder: z.array(ElementIdSchema).readonly(),
    /** Order a keyboard user would expect (DOM / reading order). */
    expectedOrder: z.array(ElementIdSchema).readonly(),
  }),
  z.object({
    type: z.literal("UNEXPECTED_FOCUS_LEAVING_PAGE"),
    atStep: StepIndexSchema,
    /** Last element focused before focus left, if there was one. */
    lastElementId: ElementIdSchema.nullable(),
  }),
  z.object({
    type: z.literal("SUSPICIOUS_FOCUS_CYCLE"),
    /** Elements the cycle passes through, in order. */
    cycleElementIds: z.array(ElementIdSchema).readonly(),
    /** Known interactive elements the cycle never reaches — the trap's cost. */
    excludedElementIds: z.array(ElementIdSchema).readonly(),
  }),
  z.object({
    type: z.literal("NO_KEYBOARD_REACHABLE_CONTROLS"),
    discoveredCount: z.number().int().positive(),
  }),
]);
export type FindingDetails = z.infer<typeof FindingDetailsSchema>;

/**
 * The reproduction bundle. A finding is not a claim; it is a replay.
 *
 * `keyboardSequence` runs from step 0 so the state can be rebuilt from a cold
 * start — a sequence that begins mid-run is not reproducible.
 */
export const FindingEvidenceSchema = z.object({
  keyboardSequence: z.array(KeyboardActionSchema).readonly(),
  /** Focus after each action, parallel to `keyboardSequence`. */
  focusSequence: z.array(FocusStateSchema).readonly(),
  screenshotIds: z.array(ScreenshotIdSchema).readonly(),
  domEvidence: DOMSnapshotSchema,
  ariaEvidence: AccessibilitySnapshotSchema,
  /** Step range the finding spans, inclusive. */
  steps: z.object({ from: StepIndexSchema, to: StepIndexSchema }),
});
export type FindingEvidence = z.infer<typeof FindingEvidenceSchema>;

const findingBase = {
  id: FindingIdSchema,
  details: FindingDetailsSchema,
  /** The model's own explanation. Displayed, never executed. */
  reasoning: z.string().min(1),
  confidence: ConfidenceSchema,
  detectedAtStep: StepIndexSchema,
  detectedAt: TimestampSchema,
};

/**
 * The model flagged something, but nothing has corroborated it yet.
 *
 * Suspected findings never reach a report. They exist so the agent can hold a
 * hypothesis across steps and keep exploring to test it.
 */
export const SuspectedFindingSchema = z.object({
  ...findingBase,
  status: z.literal("SUSPECTED"),
});
export type SuspectedFinding = z.infer<typeof SuspectedFindingSchema>;

/**
 * Corroborated and reportable.
 *
 * Reaching this state requires **both** the model's REPORT decision and a
 * deterministic signal from `lib/rules` (ARCHITECTURE.md §4). The extra fields
 * over a suspected finding are exactly what a reader needs to act: how bad it
 * is, how to reproduce it, why it happens, and what to change.
 */
export const ConfirmedFindingSchema = z.object({
  ...findingBase,
  status: z.literal("CONFIRMED"),
  severity: SeveritySchema,
  evidence: FindingEvidenceSchema,
  likelyCause: z.string().min(1),
  suggestedFix: z.string().min(1),
  confirmedAtStep: StepIndexSchema,
});
export type ConfirmedFinding = z.infer<typeof ConfirmedFindingSchema>;

export const FindingSchema = z.discriminatedUnion("status", [
  SuspectedFindingSchema,
  ConfirmedFindingSchema,
]);
export type Finding = z.infer<typeof FindingSchema>;

export function isConfirmed(finding: Finding): finding is ConfirmedFinding {
  return finding.status === "CONFIRMED";
}

export function isSuspected(finding: Finding): finding is SuspectedFinding {
  return finding.status === "SUSPECTED";
}
