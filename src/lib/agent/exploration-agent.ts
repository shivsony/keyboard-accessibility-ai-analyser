import type { AgentAnalysisInput, AIProvider } from "@/lib/ai";
import { isAIProviderError } from "@/lib/ai";
import type { KeyboardExecutor, PageController } from "@/lib/browser";
import { isBrowserLayerError } from "@/lib/browser";
import { describePath, nodeIdForFocus, traversalPath } from "@/lib/graph";
import {
  checkAgentStateInvariants,
  createInitialAgentState,
  elementId as toElementId,
  findingId as toFindingId,
  type AgentDecision,
  type AgentState,
  type AgentStep,
  type AuditId,
  type FocusState,
  type StepIndex,
  type SuspectedFinding,
  type TerminationReason,
  type Url,
} from "@/lib/shared/domain";

import { guardDecision, rejectMalformed, validateDecision } from "./action-guard";
import {
  addSuspectedFinding,
  appendStep,
  applyInitialNode,
  applyObservation,
  applyScreenshot,
  applyTransition,
  withStatus,
} from "./state-updates";

/**
 * The exploration loop.
 *
 *   OBSERVE → ASK THE AI → VALIDATE → GUARD → EXECUTE → OBSERVE → UPDATE STATE
 *
 * The AI never touches Playwright. It returns a decision; the guard rules on it;
 * the `KeyboardExecutor` is the only thing that presses a key. There is no path
 * from a model response to the browser that skips those two
 * (ARCHITECTURE.md invariants 2 and 3).
 *
 * **The loop cannot run forever.** Termination is guaranteed by a step budget
 * that is checked before every iteration and cannot be disabled, backed by a
 * wall-clock budget and a repeated-state threshold. Those last two are not
 * belt-and-braces: a page that answers every keypress identically would
 * otherwise burn the whole budget learning nothing, and a slow model would turn
 * a 150-step budget into an afternoon.
 */

export type ExplorationOptions = {
  /** Hard ceiling on iterations. Required, positive, and not overridable. */
  readonly maxSteps: number;
  /** Wall-clock ceiling for the whole run. */
  readonly maxDurationMs: number;
  /**
   * Consecutive identical states tolerated before stopping.
   *
   * Some repetition is legitimate — a page with one control returns to it every
   * other Tab — so this is a threshold rather than a tripwire.
   */
  readonly repeatedStateThreshold: number;
  readonly signal?: AbortSignal;
  /** Injected in tests. */
  readonly now?: () => number;
};

export const DEFAULT_EXPLORATION_OPTIONS: Omit<ExplorationOptions, "signal" | "now"> =
  Object.freeze({
    maxSteps: 150,
    maxDurationMs: 300_000,
    repeatedStateThreshold: 6,
  });

export type ExplorationDependencies = {
  readonly page: PageController;
  readonly executor: KeyboardExecutor;
  readonly provider: AIProvider;
};

export type ExplorationResult = {
  readonly state: AgentState;
  readonly terminationReason: TerminationReason;
  /** Set when the run ended in failure rather than completion. */
  readonly error: Error | null;
};

export class ExplorationAgent {
  #deps: ExplorationDependencies;
  #options: ExplorationOptions;
  #now: () => number;

  /**
   * Bytes of the most recent screenshot.
   *
   * Held here rather than in `AgentState` because state is serialized into the
   * run record, and a megabyte of base64 per step would make it unreadable.
   * The state keeps the reference; this keeps the pixels for the next request.
   */
  #latestScreenshot: Uint8Array | null = null;

  constructor(dependencies: ExplorationDependencies, options: ExplorationOptions) {
    if (!Number.isInteger(options.maxSteps) || options.maxSteps <= 0) {
      throw new Error("maxSteps must be a positive integer");
    }

    this.#deps = dependencies;
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  async run(params: { auditId: AuditId; url: Url }): Promise<ExplorationResult> {
    const startedAt = this.#now();
    let state = createInitialAgentState(params);

    // Step 0 is observed before anything is pressed: the model cannot choose a
    // first action without knowing where focus already is.
    try {
      state = await this.#observe(state, 0);
      state = applyInitialNode(state, 0);
    } catch (error) {
      return this.#fail(state, error, "DRIVER_ERROR");
    }

    state = withStatus(state, { kind: "RUNNING" });

    let repeats = 0;
    let lastSignature = this.#signature(state.currentFocus, state);

    for (;;) {
      const stop = this.#shouldStop(state, startedAt, repeats);
      if (stop !== null) return this.#stop(state, stop);

      const step = state.currentStep as StepIndex;
      const startedStepAt = new Date(this.#now()).toISOString();

      // ---- ASK THE AI -----------------------------------------------------
      let raw: AgentDecision;
      try {
        raw = await this.#deps.provider.analyzeObservation(
          this.#buildInput(state, step),
          {
            ...(this.#options.signal === undefined
              ? {}
              : { signal: this.#options.signal }),
          },
        );
      } catch (error) {
        if (isAIProviderError(error) && error.code === "CANCELLED") {
          return this.#stop(state, "CANCELLED");
        }
        return this.#fail(
          state,
          error,
          isAIProviderError(error) && error.code === "INVALID_RESPONSE"
            ? "DECISION_INVALID"
            : "AI_ERROR",
        );
      }

      // ---- VALIDATE -------------------------------------------------------
      // The provider parses its own responses, but `AIProvider` is an
      // interface. Trusting every implementation is a choice this loop declines
      // to make.
      const validation = validateDecision(raw);

      if (!validation.valid) {
        state = appendStep(state, {
          index: step,
          observation: this.#requireObservation(state),
          decision: raw,
          guardVerdict: rejectMalformed(validation.problem),
          executedAction: null,
          startedAt: startedStepAt,
          completedAt: new Date(this.#now()).toISOString(),
        });
        return this.#stop(state, "DECISION_INVALID");
      }

      const decision = validation.decision;

      // The observation the model actually decided from. Captured before the
      // keypress changes anything, because a step's record must show what was
      // known when the choice was made, not what the choice produced.
      const decidedFrom = this.#requireObservation(state);

      // ---- GUARD ----------------------------------------------------------
      const verdict = guardDecision(decision);

      // ---- EXECUTE --------------------------------------------------------
      const before = state.currentFocus;
      let executed: Awaited<ReturnType<KeyboardExecutor["execute"]>> | null = null;

      if (verdict.outcome === "APPROVED") {
        // The executor observes after pressing, and that observation is what the
        // *next* step decides from — so it is labelled step + 1. Labelling it
        // `step` would give two observations the same index and make the
        // recorded history ambiguous about which one informed which decision.
        const observesAt = (step + 1) as StepIndex;
        executed = await this.#deps.executor.execute(verdict.action, observesAt);

        if (executed.outcome === "FAILED") {
          state = appendStep(state, {
            index: step,
            observation: decidedFrom,
            decision,
            guardVerdict: verdict,
            executedAction: null,
            startedAt: startedStepAt,
            completedAt: new Date(this.#now()).toISOString(),
          });
          return this.#fail(state, executed.error, "DRIVER_ERROR");
        }
      }

      // ---- OBSERVE + UPDATE STATE -----------------------------------------
      const observedAt = new Date(this.#now()).toISOString();

      if (executed !== null && executed.outcome === "EXECUTED") {
        const observation = executed.observation.observation;

        state = applyScreenshot(state, {
          id: observation.screenshotId,
          path: `steps/${String(observation.step).padStart(4, "0")}.png`,
          step: observation.step,
          viewport: executed.observation.screenshot.viewport,
          capturedAt: executed.observation.screenshot.capturedAt,
          format: "png",
        });
        state = applyObservation(state, observation);
        this.#latestScreenshot = executed.observation.screenshot.png;
        state = applyTransition(state, {
          from: before,
          to: executed.newFocus,
          action: executed.action,
          step,
          at: observedAt,
        });
      }

      const completedStep: AgentStep = {
        index: step,
        observation: decidedFrom,
        decision,
        guardVerdict: verdict,
        executedAction: executed?.outcome === "EXECUTED" ? executed.action : null,
        startedAt: startedStepAt,
        completedAt: new Date(this.#now()).toISOString(),
      };

      state = appendStep(state, completedStep);
      state = this.#recordIssue(state, decision, step, observedAt);

      // Development-time check that the transitions above kept memory coherent.
      // A violated invariant means the next finding built from this state would
      // not be reproducible.
      if (process.env.NODE_ENV !== "production") {
        const violations = checkAgentStateInvariants(state);
        if (violations.length > 0) {
          return this.#fail(
            state,
            new Error(
              `Agent state invariants violated after step ${step}: ${violations
                .map((violation) => violation.code)
                .join(", ")}`,
            ),
            "DRIVER_ERROR",
          );
        }
      }

      // ---- REPEATED STATE --------------------------------------------------
      const signature = this.#signature(state.currentFocus, state);
      repeats = signature === lastSignature ? repeats + 1 : 0;
      lastSignature = signature;

      // ---- STOP CONDITIONS THAT DEPEND ON THE DECISION ---------------------
      if (decision.decision === "STOP") return this.#stop(state, "AGENT_STOPPED");

      if (
        decision.decision === "REPORT" &&
        this.#investigationComplete(state, decision.issue.type)
      ) {
        return this.#stop(state, "INVESTIGATION_COMPLETE");
      }
    }
  }

  // -------------------------------------------------------------------------

  /**
   * Checks the conditions that do not depend on what the model just said.
   *
   * Evaluated *before* each iteration, so the budget is a ceiling on steps
   * taken rather than on steps started.
   */
  #shouldStop(
    state: AgentState,
    startedAt: number,
    repeats: number,
  ): TerminationReason | null {
    if (this.#options.signal?.aborted === true) return "CANCELLED";
    if (state.currentStep >= this.#options.maxSteps) return "STEP_BUDGET_EXHAUSTED";
    if (this.#now() - startedAt >= this.#options.maxDurationMs) {
      return "TIME_BUDGET_EXHAUSTED";
    }
    if (repeats >= this.#options.repeatedStateThreshold) return "REPEATED_STATE";
    if (!this.#deps.page.isUsable) return "DRIVER_ERROR";

    return null;
  }

  /**
   * Whether a REPORT should end the run.
   *
   * "Investigation is complete" means there is nothing left to test: every
   * discovered control has been reached, and no hypothesis is still open
   * *other than the one just reported*. That exclusion matters — a REPORT
   * records its own hypothesis, so without it the condition could never be
   * true on the step that raised it.
   *
   * Stopping on any REPORT would end the run at the first problem found, which
   * is exactly the wrong behaviour for a page with several.
   */
  #investigationComplete(
    state: AgentState,
    reportedType: SuspectedFinding["details"]["type"],
  ): boolean {
    const visited = new Set<string>(state.visitedElementIds);
    const everythingReached = state.discoveredElements.every((element) =>
      visited.has(element.id),
    );

    const openHypotheses = state.suspectedFindings.filter(
      (finding) => finding.details.type !== reportedType,
    );

    return everythingReached && openHypotheses.length === 0;
  }

  /**
   * What counts as "the same state".
   *
   * Focus position plus how much has been discovered. Deliberately not the whole
   * observation: timestamps and screenshot ids differ every step, so a stricter
   * signature would never match and the threshold would never fire.
   */
  #signature(focus: FocusState, state: AgentState): string {
    return [
      nodeIdForFocus(focus),
      state.discoveredElements.length,
      state.visitedElementIds.length,
    ].join("|");
  }

  async #observe(state: AgentState, step: StepIndex): Promise<AgentState> {
    const capture = await this.#deps.page.observe(step);

    let next = applyScreenshot(state, {
      id: capture.observation.screenshotId,
      path: `steps/${String(step).padStart(4, "0")}.png`,
      step,
      viewport: capture.screenshot.viewport,
      capturedAt: capture.screenshot.capturedAt,
      format: "png",
    });

    next = applyObservation(next, capture.observation);
    this.#latestScreenshot = capture.screenshot.png;
    return next;
  }

  /**
   * Assembles what the model sees.
   *
   * Everything the agent knows, minus anything it could not act on: no internal
   * ids beyond element identity, no configuration, and — emphatically — no
   * credentials.
   */
  #buildInput(state: AgentState, step: StepIndex): AgentAnalysisInput {
    const observation = this.#requireObservation(state);

    return {
      auditId: state.auditId,
      url: state.url,
      step,
      observation,
      previousObservations: state.previousObservations,
      discoveredElements: state.discoveredElements,
      visitedElementIds: state.visitedElementIds,
      keyboardHistory: state.keyboardHistory,
      navigationSummary: describePath(traversalPath(state.navigationGraph)),
      suspectedFindings: state.suspectedFindings,
      // The image input. Without it the provider fails the step rather than
      // quietly reasoning from text alone.
      screenshot: this.#latestScreenshot,
      stepsRemaining: Math.max(0, this.#options.maxSteps - state.currentStep),
    };
  }

  /**
   * Turns an INVESTIGATE or REPORT into a hypothesis the agent carries forward.
   *
   * Both are recorded as **suspected**, including REPORT. A finding becomes
   * confirmed only when a deterministic signal corroborates it
   * (ARCHITECTURE.md §4), and that corroboration lives in `lib/rules`, which is
   * not built yet. Promoting a REPORT here would publish the model's word alone
   * as a confirmed defect.
   */
  #recordIssue(
    state: AgentState,
    decision: AgentDecision,
    step: StepIndex,
    at: string,
  ): AgentState {
    if (decision.decision !== "INVESTIGATE" && decision.decision !== "REPORT") {
      return state;
    }

    const issue =
      decision.decision === "INVESTIGATE" ? decision.suspectedIssue : decision.issue;

    const finding: SuspectedFinding = {
      id: toFindingId(`${decision.decision.toLowerCase()}-${issue.type}-${step}`),
      status: "SUSPECTED",
      details: detailsFor(issue.type, state),
      reasoning: decision.reason,
      confidence: decision.confidence,
      detectedAtStep: step,
      detectedAt: at,
    };

    return addSuspectedFinding(state, finding);
  }

  #requireObservation(state: AgentState) {
    const observation = state.currentObservation;
    if (observation === null) {
      throw new Error("The agent has no observation; the loop was entered too early");
    }
    return observation;
  }

  #stop(state: AgentState, reason: TerminationReason): ExplorationResult {
    return {
      state: withStatus(state, { kind: "STOPPED", reason }),
      terminationReason: reason,
      error: null,
    };
  }

  #fail(state: AgentState, error: unknown, reason: TerminationReason): ExplorationResult {
    const code =
      isBrowserLayerError(error) || isAIProviderError(error) ? error.code : "INTERNAL";

    const message = error instanceof Error ? error.message : "Unknown error";

    return {
      state: withStatus(state, {
        kind: "FAILED",
        error: {
          code:
            code === "PAGE_CRASHED" || code === "SESSION_CLOSED"
              ? "BROWSER_ERROR"
              : reason === "AI_ERROR" || reason === "DECISION_INVALID"
                ? "AI_ERROR"
                : "BROWSER_ERROR",
          message,
        },
      }),
      terminationReason: reason,
      error: error instanceof Error ? error : new Error(message),
    };
  }
}

/**
 * Fills in the type-specific particulars of a suspicion.
 *
 * The model names the type; the details come from what the agent actually
 * recorded, so a suspicion cannot claim more than the traversal supports.
 */
function detailsFor(
  type: SuspectedFinding["details"]["type"],
  state: AgentState,
): SuspectedFinding["details"] {
  const visited = new Set<string>(state.visitedElementIds);
  const unreached = state.discoveredElements
    .filter((element) => !visited.has(element.id))
    .map((element) => element.id);

  switch (type) {
    case "UNREACHABLE_ELEMENT":
      return {
        type,
        // The first control the traversal has not reached. Null-safe: the model
        // can suspect this before one exists, and that is itself informative.
        elementId:
          unreached[0] ?? state.discoveredElements[0]?.id ?? toElementId("unknown"),
      };
    case "SUSPICIOUS_FOCUS_ORDER":
      return {
        type,
        observedOrder: state.visitedElementIds,
        expectedOrder: state.discoveredElements.map((element) => element.id),
      };
    case "UNEXPECTED_FOCUS_LEAVING_PAGE":
      return {
        type,
        atStep: state.currentStep,
        lastElementId:
          state.currentFocus.kind === "ELEMENT" ? state.currentFocus.element.id : null,
      };
    case "SUSPICIOUS_FOCUS_CYCLE":
      return {
        type,
        cycleElementIds: state.visitedElementIds,
        excludedElementIds: unreached,
      };
    case "NO_KEYBOARD_REACHABLE_CONTROLS":
      return {
        type,
        discoveredCount: Math.max(1, state.discoveredElements.length),
      };
  }
}
