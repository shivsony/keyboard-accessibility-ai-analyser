import { z } from "zod";

import { TerminationReasonSchema, AuditErrorSchema } from "./audit";
import {
  FocusStateSchema,
  InteractiveElementSchema,
  FOCUS_UNKNOWN,
  type InteractiveElement,
} from "./element";
import { ConfirmedFindingSchema, SuspectedFindingSchema } from "./finding";
import { KeyboardActionRecordSchema, type KeyboardAction } from "./keyboard";
import { AgentObservationSchema, type AgentObservation } from "./observation";
import { EMPTY_NAVIGATION_GRAPH, NavigationGraphSchema } from "./graph";
import {
  AuditIdSchema,
  ElementIdSchema,
  StepIndexSchema,
  UrlSchema,
  type AuditId,
  type Url,
} from "./primitives";
import { ScreenshotEvidenceSchema } from "./snapshot";
import { AgentStepSchema } from "./step";

/**
 * What the agent is doing right now.
 *
 * A union rather than a flat enum so that a stopped run carries *why* it
 * stopped and a failed one carries the error. "Status: STOPPED" with the reason
 * kept somewhere else is how termination reasons go missing.
 */
export const AgentStatusSchema = z.discriminatedUnion("kind", [
  /** Constructed, nothing observed yet. */
  z.object({ kind: z.literal("IDLE") }),
  z.object({ kind: z.literal("RUNNING") }),
  z.object({
    kind: z.literal("STOPPED"),
    reason: TerminationReasonSchema,
  }),
  z.object({
    kind: z.literal("FAILED"),
    error: AuditErrorSchema,
  }),
]);
export type AgentStatus = z.infer<typeof AgentStatusSchema>;

/**
 * Everything the agent currently knows. The central model.
 *
 * Design notes:
 *
 * - **One source of truth per fact.** Reachability lives only in
 *   `visitedElementIds`; the exact keypress sequence lives only in
 *   `keyboardHistory`; the full record lives only in `steps`. Where two fields
 *   could drift, an invariant in `invariants.ts` ties them together.
 * - **`currentObservation` is separate from `previousObservations`** because the
 *   decision step needs "what I see now" distinct from "what I saw before", and
 *   the model is shown both.
 * - **Findings are split by status**, not tagged with one, so that reporting
 *   cannot accidentally publish a suspicion (ARCHITECTURE.md §4).
 * - **Plain serializable data.** No class, no methods, no `Set`, no `Date` — a
 *   run must round-trip through JSON into a run directory and back.
 */
export const AgentStateSchema = z.object({
  auditId: AuditIdSchema,
  url: UrlSchema,
  status: AgentStatusSchema,

  /** Number of completed steps; also the index of the step now in flight. */
  currentStep: StepIndexSchema,

  /** What the agent sees now. Null before the first observation. */
  currentObservation: AgentObservationSchema.nullable(),
  /** Earlier observations, oldest first. */
  previousObservations: z.array(AgentObservationSchema).readonly(),

  currentFocus: FocusStateSchema,

  /** Every interactive element found so far, whether or not it was reached. */
  discoveredElements: z.array(InteractiveElementSchema).readonly(),
  /** Elements the keyboard actually reached. A subset of the above. */
  visitedElementIds: z.array(ElementIdSchema).readonly(),

  /** Exact keypress sequence from step 0. The reproduction. */
  keyboardHistory: z.array(KeyboardActionRecordSchema).readonly(),

  navigationGraph: NavigationGraphSchema,

  suspectedFindings: z.array(SuspectedFindingSchema).readonly(),
  confirmedFindings: z.array(ConfirmedFindingSchema).readonly(),

  screenshots: z.array(ScreenshotEvidenceSchema).readonly(),

  /** Full per-step record: observation, decision, guard ruling, what executed. */
  steps: z.array(AgentStepSchema).readonly(),
});
export type AgentState = z.infer<typeof AgentStateSchema>;

/** A fresh state, before anything has been observed. */
export function createInitialAgentState(params: {
  auditId: AuditId;
  url: Url;
}): AgentState {
  return {
    auditId: params.auditId,
    url: params.url,
    status: { kind: "IDLE" },
    currentStep: 0,
    currentObservation: null,
    previousObservations: [],
    currentFocus: FOCUS_UNKNOWN,
    discoveredElements: [],
    visitedElementIds: [],
    keyboardHistory: [],
    navigationGraph: EMPTY_NAVIGATION_GRAPH,
    suspectedFindings: [],
    confirmedFindings: [],
    screenshots: [],
    steps: [],
  };
}

/** Observations oldest-first, including the current one. */
export function allObservations(state: AgentState): readonly AgentObservation[] {
  return state.currentObservation === null
    ? state.previousObservations
    : [...state.previousObservations, state.currentObservation];
}

/** The keypress sequence alone — what a reader replays by hand. */
export function keyboardSequence(state: AgentState): readonly KeyboardAction[] {
  return state.keyboardHistory.map((record) => record.action);
}

/** Discovered elements the keyboard never reached. */
export function unreachedElements(state: AgentState): readonly InteractiveElement[] {
  const visited = new Set<string>(state.visitedElementIds);
  return state.discoveredElements.filter((element) => !visited.has(element.id));
}

/** True once the agent will take no further steps. */
export function isAgentFinished(state: AgentState): boolean {
  return state.status.kind === "STOPPED" || state.status.kind === "FAILED";
}
