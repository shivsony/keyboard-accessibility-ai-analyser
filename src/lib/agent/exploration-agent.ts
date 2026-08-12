import type { AgentAnalysisInput, AIProvider } from "@/lib/ai";
import { isAIProviderError } from "@/lib/ai";
import type { KeyboardExecutor, PageController } from "@/lib/browser";
import { isBrowserLayerError } from "@/lib/browser";
import { describePath, nodeIdForFocus, traversalPath } from "@/lib/graph";
import { FindingValidator } from "@/lib/rules";
import {
  activeInvestigation,
  agentMode,
  checkAgentStateInvariants,
  confidence,
  createInitialAgentState,
  elementId as toElementId,
  findingId as toFindingId,
  type AgentDecision,
  type AgentState,
  type AgentStep,
  type FindingType,
  type KeyboardAction,
  type AuditId,
  type FocusState,
  type StepIndex,
  type SuspectedFinding,
  type TerminationReason,
  type Url,
} from "@/lib/shared/domain";

import { guardDecision, rejectMalformed, validateDecision } from "./action-guard";
import { decideNextMove, type DecisionPoint } from "./traversal-policy";
import {
  abandonInvestigation,
  confirmInvestigation,
  investigationExhausted,
  openInvestigation,
  recordInvestigationAttempt,
} from "./investigation";
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
  /**
   * Keypresses one investigation may spend before it is abandoned.
   *
   * An agent that has pressed a dozen keys without concluding is not about to
   * conclude on the next one, and the rest of the page still needs covering.
   */
  readonly maxInvestigationSteps: number;

  /**
   * How often the model is consulted.
   *
   * `decision-points` sweeps deterministically and calls the model only where a
   * judgement is required. `every-step` is the original behaviour, kept so the
   * two can be compared on the same page.
   */
  readonly aiMode?: "decision-points" | "every-step";
  readonly signal?: AbortSignal;
  /** Injected in tests. */
  readonly now?: () => number;

  /**
   * Called after each completed step, so a caller can show progress.
   *
   * Best-effort: a throwing observer must not end an audit, so failures here
   * are swallowed. Reporting progress is not part of the run's correctness.
   */
  readonly onProgress?: (progress: AgentProgress) => void;

  /**
   * Called with each screenshot as it is captured.
   *
   * The bytes are not kept in `AgentState` — a megabyte per step would make the
   * run record unreadable — so this is the only chance to persist them.
   */
  readonly onScreenshot?: (step: StepIndex, png: Uint8Array) => void | Promise<void>;
};

/** A snapshot of the run, for a caller that wants to display it. */
export type AgentProgress = {
  readonly step: number;
  readonly mode: "EXPLORING" | "INVESTIGATING";
  readonly currentFocus: FocusState;
  readonly lastAction: KeyboardAction | null;
  readonly discoveredCount: number;
  readonly visitedCount: number;
  readonly decision: AgentDecision;
  readonly state: AgentState;
};

export const DEFAULT_EXPLORATION_OPTIONS: Omit<ExplorationOptions, "signal" | "now"> =
  Object.freeze({
    maxSteps: 150,
    maxDurationMs: 300_000,
    repeatedStateThreshold: 6,
    maxInvestigationSteps: 12,
    aiMode: "decision-points" as const,
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
  /**
   * Why reported findings were refused, by type.
   *
   * Carried out of the run so the report can say *why* a suspicion stayed a
   * suspicion, instead of the generic "the trace did not establish this".
   */
  readonly rejectionsByType: Readonly<Record<string, readonly string[]>>;
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

  /**
   * Finding types already put to the model.
   *
   * Without this the policy escalates the same candidate every step. A real run
   * spent six consecutive calls reporting the same thing the validator kept
   * refusing, because nothing remembered it had already asked.
   */
  #adjudicated = new Set<FindingType>();

  /** Why a reported finding was refused, so the model can be told. */
  #rejections = new Map<FindingType, readonly string[]>();

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

      if (stop !== null) {
        // A dead browser is a failure however it was noticed. Detected by the
        // pre-step check it used to end as STOPPED, while the identical error
        // from the executor ended as FAILED — the same event with two different
        // outcomes depending on which line saw it first.
        return stop === "DRIVER_ERROR"
          ? this.#fail(state, new Error("The browser is no longer usable"), stop)
          : this.#stop(state, stop);
      }

      const step = state.currentStep as StepIndex;
      const startedStepAt = new Date(this.#now()).toISOString();

      // ---- POLICY: is this a decision worth paying for? -------------------
      //
      // Most steps of a keyboard sweep are mechanically obvious: press Tab, see
      // where focus lands. Asking a vision model to confirm that, every step,
      // was the bulk of an audit's cost and produced nothing the trace did not
      // already say.
      const move =
        this.#options.aiMode === "every-step"
          ? null
          : decideNextMove(state, {
              adjudicated: this.#adjudicated,
              repeats,
              repeatedStateThreshold: this.#options.repeatedStateThreshold,
            });

      if (move?.kind === "COMPLETE") return this.#stop(state, move.reason);

      let decidedBy: "AI" | "POLICY" = "AI";
      let raw: AgentDecision;

      if (move?.kind === "SWEEP") {
        decidedBy = "POLICY";
        raw = {
          decision: "CONTINUE",
          action: move.action,
          reason: move.reason,
          confidence: confidence(1),
        };
      } else {
        // A decision point, or every-step mode. The model is consulted, and the
        // candidate is marked so the same question is not asked twice.
        if (move?.kind === "ESCALATE" && move.issueType !== null) {
          this.#adjudicated.add(move.issueType);
        }

        try {
          raw = await this.#deps.provider.analyzeObservation(
            this.#buildInput(state, step, move?.decisionPoint ?? null),
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
      }

      // ---- VALIDATE -------------------------------------------------------
      // The provider parses its own responses, but `AIProvider` is an
      // interface. Trusting every implementation is a choice this loop declines
      // to make.
      const validation = validateDecision(raw);

      if (!validation.valid) {
        state = appendStep(state, {
          index: step,
          mode: agentMode(state),
          decidedBy,
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

      // Likewise the mode: this step was taken while investigating, or while
      // exploring, and the decision it produces may change that.
      const modeAtDecision = agentMode(state);

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
            mode: modeAtDecision,
            decidedBy,
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
        await this.#persistScreenshot(
          observation.step,
          executed.observation.screenshot.png,
        );
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
        mode: modeAtDecision,
        decidedBy,
        observation: decidedFrom,
        decision,
        guardVerdict: verdict,
        executedAction: executed?.outcome === "EXECUTED" ? executed.action : null,
        startedAt: startedStepAt,
        completedAt: new Date(this.#now()).toISOString(),
      };

      state = appendStep(state, completedStep);
      state = this.#applyInvestigation(state, {
        decision,
        step,
        at: observedAt,
        executedAction: completedStep.executedAction,
      });
      state = this.#recordIssue(state, decision, step, observedAt);
      state = this.#validateReport(state, decision, step);
      this.#report(state, decision, completedStep);

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

  /**
   * Hands a progress snapshot to the caller, if one asked.
   *
   * Wrapped because an observer is somebody else's code: a display that throws
   * must not take the audit down with it.
   */
  #report(state: AgentState, decision: AgentDecision, step: AgentStep): void {
    if (this.#options.onProgress === undefined) return;

    try {
      this.#options.onProgress({
        step: step.index,
        mode: agentMode(state),
        currentFocus: state.currentFocus,
        lastAction: step.executedAction,
        discoveredCount: state.discoveredElements.length,
        visitedCount: state.visitedElementIds.length,
        decision,
        state,
      });
    } catch {
      // Deliberately ignored. See above.
    }
  }

  async #persistScreenshot(step: StepIndex, png: Uint8Array): Promise<void> {
    if (this.#options.onScreenshot === undefined) return;

    try {
      await this.#options.onScreenshot(step, png);
    } catch {
      // A screenshot that could not be written costs evidence, not the run.
    }
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
    await this.#persistScreenshot(step, capture.screenshot.png);
    return next;
  }

  /**
   * Assembles what the model sees.
   *
   * Everything the agent knows, minus anything it could not act on: no internal
   * ids beyond element identity, no configuration, and — emphatically — no
   * credentials.
   */
  #buildInput(
    state: AgentState,
    step: StepIndex,
    decisionPoint: DecisionPoint | null,
  ): AgentAnalysisInput {
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
      investigation: activeInvestigation(state),
      // The image input. Without it the provider fails the step rather than
      // quietly reasoning from text alone.
      screenshot: this.#latestScreenshot,
      decisionPoint,
      // Reports the validator has already refused. Telling the model saves it
      // filing the same one again, which is exactly what happened before.
      rejectedClaims: [...this.#rejections].map(([type, reasons]) => ({
        type,
        reasons,
      })),
      stepsRemaining: Math.max(0, this.#options.maxSteps - state.currentStep),
    };
  }

  /**
   * Moves the open line of enquiry along, or opens or closes one.
   *
   * The state machine in one place:
   *
   * - `INVESTIGATE` opens an investigation, or feeds the open one. Switching to
   *   a *different* issue type abandons the current line first — an agent
   *   chasing two questions at once is chasing neither, and the evidence for
   *   each would be interleaved with the other's keypresses.
   * - `CONTINUE` while investigating abandons it. The agent has chosen to
   *   resume ordinary exploration, which is exactly what dropping a false
   *   suspicion looks like from outside.
   * - `REPORT` confirms it.
   * - `STOP` closes it as abandoned; the run is over either way.
   *
   * An investigation that outstays its budget is abandoned too, so a line of
   * enquiry cannot quietly consume the whole run.
   */
  #applyInvestigation(
    state: AgentState,
    params: {
      decision: AgentDecision;
      step: StepIndex;
      at: string;
      executedAction: KeyboardAction | null;
    },
  ): AgentState {
    const { decision, step, at } = params;
    const current = activeInvestigation(state);

    if (decision.decision === "INVESTIGATE") {
      const changedSubject =
        current !== null && current.issueType !== decision.suspectedIssue.type;

      let next = changedSubject
        ? abandonInvestigation(state, { at, reason: "AGENT_MOVED_ON" })
        : state;

      if (current === null || changedSubject) {
        next = openInvestigation(next, {
          issue: decision.suspectedIssue,
          step,
          hypothesis: decision.reason,
          confidence: decision.confidence,
          at,
          targetElementId: decision.targetElementId ?? null,
        });
      }

      // The keypress this decision asked for is evidence in the enquiry that
      // asked for it.
      if (params.executedAction !== null) {
        next = recordInvestigationAttempt(next, {
          action: params.executedAction,
          step,
          resultingFocus: next.currentFocus,
          hypothesis: decision.reason,
          confidence: decision.confidence,
          at,
        });
      }

      return investigationExhausted(next, this.#options.maxInvestigationSteps)
        ? abandonInvestigation(next, { at, reason: "BUDGET_EXHAUSTED" })
        : next;
    }

    if (current === null) return state;

    if (decision.decision === "REPORT") {
      return confirmInvestigation(state, { at, confidence: decision.confidence });
    }

    // CONTINUE or STOP: the agent has moved on.
    return abandonInvestigation(state, {
      at,
      reason: decision.decision === "STOP" ? "RUN_ENDED" : "AGENT_MOVED_ON",
    });
  }

  /**
   * Puts a REPORT through the validator.
   *
   * This is where a suspicion becomes a finding, or does not. The model has
   * said what it thinks is wrong; the validator checks that against the
   * recorded traversal and confirms only what the trace supports.
   *
   * A rejection is not an error. The run continues, the suspicion stays on the
   * record as suspected, and the report simply does not get published — which
   * is the intended outcome when a model reports something the page does not
   * actually do.
   */
  #validateReport(
    state: AgentState,
    decision: AgentDecision,
    step: StepIndex,
  ): AgentState {
    if (decision.decision !== "REPORT") return state;

    const result = new FindingValidator(state).validate({
      issue: decision.issue,
      reason: decision.reason,
      confidence: decision.confidence,
      step,
      targetElementId: decision.targetElementId ?? null,
    });

    if (result.outcome === "REJECTED") {
      // Kept, and shown back to the model. A run that never learns its report
      // was refused simply files it again — six times, in the case that
      // prompted this.
      this.#rejections.set(
        decision.issue.type,
        result.problems.map((problem) => problem.detail),
      );
      return state;
    }

    // Deduplicated by type: a page has one unreachable-controls problem, not
    // one per step the agent chose to mention it.
    const alreadyConfirmed = state.confirmedFindings.some(
      (finding) => finding.details.type === result.finding.details.type,
    );

    return alreadyConfirmed
      ? state
      : { ...state, confirmedFindings: [...state.confirmedFindings, result.finding] };
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
      rejectionsByType: Object.fromEntries(this.#rejections),
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
      rejectionsByType: Object.fromEntries(this.#rejections),
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
