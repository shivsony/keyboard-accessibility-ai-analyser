import {
  activeInvestigation,
  investigationId as toInvestigationId,
  type AbandonReason,
  type AgentState,
  type ElementId,
  type FocusState,
  type Hypothesis,
  type InvestigationContext,
  type KeyboardAction,
  type StepIndex,
  type SuspectedIssue,
  type Timestamp,
} from "@/lib/shared/domain";

/**
 * Opening, feeding, and closing investigations.
 *
 * Pure transitions, like the rest of the agent's memory. An investigation is
 * just accumulated evidence with a question attached — the interesting logic is
 * when to open one, when to keep feeding it, and when to admit it led nowhere.
 */

/**
 * Controls that discovery found and the traversal has not reached.
 *
 * The raw material for a suspicion. When focus goes Logo → Search → Checkout
 * and Menu and Filter are sitting in this list, that gap is what the agent is
 * investigating.
 */
export function skippedElementIds(state: AgentState): readonly ElementId[] {
  const visited = new Set<string>(state.visitedElementIds);

  return state.discoveredElements
    .filter((element) => !visited.has(element.id))
    .map((element) => element.id);
}

/**
 * Opens a line of enquiry.
 *
 * The suspicious set is captured at open time from what has been skipped so
 * far, so the investigation records what looked wrong *then* — not what the
 * traversal happened to still be missing when it concluded.
 */
export function openInvestigation(
  state: AgentState,
  params: {
    issue: SuspectedIssue;
    step: StepIndex;
    hypothesis: string;
    confidence: InvestigationContext["confidence"];
    at: Timestamp;
    /** Named by the model, when it named one. */
    targetElementId?: ElementId | null;
  },
): AgentState {
  const named = params.targetElementId ?? null;
  const skipped = skippedElementIds(state);

  // A control the model named leads the list, whether or not it was already
  // among the skipped ones — it is the one the report will be about.
  const suspiciousElementIds =
    named === null ? skipped : [named, ...skipped.filter((id) => id !== named)];

  const investigation: InvestigationContext = {
    id: toInvestigationId(`inv-${params.issue.type}-${params.step}`),
    issueType: params.issue.type,
    severity: params.issue.severity,
    status: "OPEN",
    suspiciousElementIds,
    triggeringStep: params.step,
    triggeringFocus: state.currentFocus,
    evidenceActions: [],
    evidenceFocusSequence: [state.currentFocus],
    attemptedActions: [],
    hypotheses: [
      {
        statement: params.hypothesis,
        raisedAtStep: params.step,
        confidence: params.confidence,
      },
    ],
    confidence: params.confidence,
    openedAt: params.at,
    closedAt: null,
    abandonReason: null,
  };

  return { ...state, investigations: [...state.investigations, investigation] };
}

/**
 * Records another keypress spent on the open investigation.
 *
 * Confidence is taken from the model each time rather than accumulated by the
 * system: evidence can weaken a suspicion as easily as strengthen it, and an
 * agent that grows more certain with every keypress regardless of what it finds
 * is not investigating, it is committing.
 */
export function recordInvestigationAttempt(
  state: AgentState,
  params: {
    action: KeyboardAction;
    step: StepIndex;
    resultingFocus: FocusState;
    hypothesis: string;
    confidence: InvestigationContext["confidence"];
    at: Timestamp;
  },
): AgentState {
  const current = activeInvestigation(state);
  if (current === null) return state;

  // A restated hypothesis is the same hypothesis. Only a new line of thinking
  // is worth recording.
  const isNew = !current.hypotheses.some(
    (existing) => existing.statement === params.hypothesis,
  );

  const hypotheses: readonly Hypothesis[] = isNew
    ? [
        ...current.hypotheses,
        {
          statement: params.hypothesis,
          raisedAtStep: params.step,
          confidence: params.confidence,
        },
      ]
    : current.hypotheses;

  return replace(state, {
    ...current,
    evidenceActions: [...current.evidenceActions, params.action],
    evidenceFocusSequence: [...current.evidenceFocusSequence, params.resultingFocus],
    attemptedActions: [
      ...current.attemptedActions,
      { step: params.step, action: params.action, at: params.at },
    ],
    hypotheses,
    confidence: params.confidence,
  });
}

/** Closes the open investigation as proven. */
export function confirmInvestigation(
  state: AgentState,
  params: { at: Timestamp; confidence?: InvestigationContext["confidence"] },
): AgentState {
  const current = activeInvestigation(state);
  if (current === null) return state;

  return replace(state, {
    ...current,
    status: "CONFIRMED",
    confidence: params.confidence ?? current.confidence,
    closedAt: params.at,
    abandonReason: null,
  });
}

/**
 * Closes the open investigation without a finding.
 *
 * Kept rather than deleted. "The agent looked into this and concluded nothing"
 * is a result, and one worth showing to somebody deciding whether to trust the
 * rest of the run.
 */
export function abandonInvestigation(
  state: AgentState,
  params: { at: Timestamp; reason: AbandonReason },
): AgentState {
  const current = activeInvestigation(state);
  if (current === null) return state;

  return replace(state, {
    ...current,
    status: "ABANDONED",
    closedAt: params.at,
    abandonReason: params.reason,
  });
}

/**
 * Whether the open investigation has outstayed its budget.
 *
 * A safety net rather than a rule of method: an agent that has pressed twelve
 * keys without deciding either way is not about to decide on the thirteenth,
 * and the rest of the page still needs covering.
 */
export function investigationExhausted(
  state: AgentState,
  maxInvestigationSteps: number,
): boolean {
  const current = activeInvestigation(state);

  return current !== null && current.attemptedActions.length >= maxInvestigationSteps;
}

function replace(state: AgentState, updated: InvestigationContext): AgentState {
  return {
    ...state,
    investigations: state.investigations.map((each) =>
      each.id === updated.id ? updated : each,
    ),
  };
}
