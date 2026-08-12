import {
  FindingTypeSchema,
  SeveritySchema,
  KEYBOARD_ACTIONS,
  focusedElement,
  type AgentObservation,
  type InteractiveElement,
} from "@/lib/shared/domain";

import type { AgentAnalysisInput } from "./types";

/**
 * Prompt construction, kept vendor-neutral.
 *
 * A second provider should reuse these strings rather than invent its own, so
 * that swapping models changes the caller and not the agent's behaviour.
 *
 * The system prompt itself lives in `system-prompt.ts`, versioned separately:
 * it is the method, while this file is the rendering of one step's state.
 */

/**
 * Every section has a ceiling.
 *
 * Three of these did not, and the cost of a step grew with the length of the
 * run — a late step could carry several times the payload of an early one, for
 * information the model had already been told. A prompt whose size depends on
 * how long you have been running is a prompt nobody has budgeted.
 */
const OBSERVATION_WINDOW = 4;
/** Unreached controls first; the model rarely needs the ones already visited. */
const MAX_ELEMENTS_LISTED = 12;
const MAX_HISTORY_LISTED = 12;
const MAX_NAVIGATION_HOPS = 12;
const MAX_OPEN_HYPOTHESES = 3;
const MAX_INVESTIGATION_HYPOTHESES = 3;
/**
 * The accessibility tree is the richer signal, so it keeps the larger share.
 *
 * Both were 4,000. The DOM summary is captured at up to 400 lines and then
 * ~90% of it was discarded here anyway — the model never saw the rest.
 */
const MAX_ARIA_CHARS = 1_800;
const MAX_DOM_CHARS = 1_200;

/**
 * The output shape requested of the provider.
 *
 * One flat object with every field present and nullable, rather than a union of
 * four shapes: strict structured-output modes handle that far more reliably, and
 * a model that has to choose a branch before it has chosen a decision tends to
 * choose badly.
 *
 * This only *shapes* the response. `AgentDecisionSchema` decides whether it is
 * acceptable, and it enforces what this cannot: that REPORT carries an issue and
 * no action, that INVESTIGATE names a suspicion, that STOP carries neither.
 */
export const DECISION_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "decision",
    "action",
    "reason",
    "confidence",
    "suspectedIssue",
    "issue",
    "targetElementId",
  ],
  properties: {
    decision: {
      type: "string",
      enum: ["CONTINUE", "INVESTIGATE", "REPORT", "STOP"],
      description: "What to do about what you just saw.",
    },
    action: {
      type: ["string", "null"],
      enum: [...KEYBOARD_ACTIONS, null],
      description:
        "The key to press next. Required for CONTINUE and INVESTIGATE. Must be null for REPORT and STOP.",
    },
    reason: {
      type: "string",
      description: "Why. One or two sentences, specific to what you observed.",
    },
    confidence: {
      type: "number",
      description: "0 to 1. Your confidence in this decision.",
    },
    suspectedIssue: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["type", "severity"],
      properties: {
        type: { type: "string", enum: [...FindingTypeSchema.options] },
        severity: { type: "string", enum: [...SeveritySchema.options] },
      },
      description: "Required for INVESTIGATE. Must be null otherwise.",
    },
    issue: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["type", "severity", "title", "description"],
      properties: {
        type: { type: "string", enum: [...FindingTypeSchema.options] },
        severity: { type: "string", enum: [...SeveritySchema.options] },
        title: {
          type: "string",
          description: "One line, as a bug report headline.",
        },
        description: {
          type: "string",
          description: "What is wrong, and who it affects.",
        },
      },
      description: "Required for REPORT. Must be null otherwise.",
    },
    targetElementId: {
      type: ["string", "null"],
      description: "The element the issue concerns, if any. Otherwise null.",
    },
  },
} as const;

/**
 * One line per control.
 *
 * `discoveredVia` and the bounding box are dropped: they were ~40 characters of
 * every line and no judgement the model makes depends on them. The element id
 * is a full CSS path, so it is the bulk of what remains — kept, because it is
 * how the model refers to a control in a report.
 */
function describeElement(
  element: InteractiveElement,
  visited: ReadonlySet<string>,
): string {
  const name = element.accessibleName ?? "(unnamed)";
  const role = element.role ?? element.tagName;
  const flags = [
    visited.has(element.id) ? null : "NOT REACHED",
    element.visible ? null : "not visible",
    element.disabled ? "disabled" : null,
  ].filter((flag) => flag !== null);

  const suffix = flags.length === 0 ? "" : ` (${flags.join(", ")})`;

  return `  - [${element.id}] ${role} "${name}"${suffix}`;
}

/**
 * Controls worth showing, unreached first.
 *
 * On a page with sixty controls the model was sent all sixty every step. What
 * actually bears on a decision is what has *not* been reached; the rest is
 * context, and a handful of it is enough.
 */
function elementsWorthListing(
  elements: readonly InteractiveElement[],
  visited: ReadonlySet<string>,
): readonly InteractiveElement[] {
  const unreached = elements.filter((element) => !visited.has(element.id));
  const reached = elements.filter((element) => visited.has(element.id));

  return [...unreached, ...reached].slice(0, MAX_ELEMENTS_LISTED);
}

/**
 * The tail of the traversal path.
 *
 * This section had no ceiling and grew one hop per keypress — at 150 steps it
 * was the single largest thing in the prompt. Only the recent shape of the
 * traversal informs the next decision; the whole history is in the report.
 */
function lastHops(summary: string): string {
  if (summary === "") return "(nothing traversed yet)";

  const hops = summary.split(" --");
  if (hops.length <= MAX_NAVIGATION_HOPS) return summary;

  return `… --${hops.slice(-MAX_NAVIGATION_HOPS).join(" --")}`;
}

/** Turns a decision point into the question the model should answer. */
function describeDecisionPoint(point: string): string {
  switch (point) {
    case "CANDIDATE_FINDING":
      return "the recorded traversal supports a possible issue. Judge whether it is real, and REPORT it if so.";
    case "TRAVERSAL_COMPLETE":
      return "every reachable control has been reached. Decide whether anything is worth reporting, then STOP.";
    case "STUCK":
      return "the traversal keeps returning to the same state. Decide whether that is a defect, then STOP.";
    default:
      return point;
  }
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

function describeFocus(observation: AgentObservation): string {
  const element = focusedElement(observation.focus);

  if (element !== null) {
    return `${element.role ?? element.tagName} "${
      element.accessibleName ?? "(no accessible name)"
    }" [${element.id}]`;
  }

  switch (observation.focus.kind) {
    case "BODY":
      return "the document body (no element focused)";
    case "OUTSIDE_PAGE":
      return "OUTSIDE THE PAGE — focus has left the document for browser chrome";
    default:
      return "not yet observed";
  }
}

/**
 * Renders the state for the model.
 *
 * Ordered so the immediate situation comes first and the history that explains
 * it follows: a model that reads "focus is here" before "you have been here
 * three times" reasons about the wrong thing.
 */
export function buildUserPrompt(input: AgentAnalysisInput): string {
  const visited = new Set<string>(input.visitedElementIds);
  const unreached = input.discoveredElements.filter(
    (element) => !visited.has(element.id),
  );

  const recent = input.previousObservations.slice(-OBSERVATION_WINDOW);
  const history = input.keyboardHistory.slice(-MAX_HISTORY_LISTED);

  const sections: string[] = [
    `AUDIT GOAL: determine whether a keyboard-only user can reach and operate`,
    `every interactive control on this page, and record any place they cannot.`,
    ``,
    // The traversal is swept by code; the model is consulted at junctures.
    // Naming the juncture lets it answer a narrow question instead of
    // re-deriving the whole situation.
    ...(input.decisionPoint == null
      ? []
      : [
          `>>> YOU ARE BEING ASKED BECAUSE: ${describeDecisionPoint(input.decisionPoint)}`,
          ``,
        ]),
    `STEP ${input.step} of this audit. ${input.stepsRemaining} steps remain in the budget.`,
    `URL: ${input.url}`,
    ``,
    `FOCUS IS NOW ON: ${describeFocus(input.observation)}`,
    ``,
    `KEYBOARD HISTORY (${input.keyboardHistory.length} keypresses so far${
      history.length < input.keyboardHistory.length
        ? `, last ${history.length} shown`
        : ""
    }):`,
    history.length === 0
      ? "  (nothing pressed yet)"
      : `  ${history.map((record) => record.action).join(" → ")}`,
    ``,
    `NAVIGATION SO FAR:`,
    `  ${lastHops(input.navigationSummary)}`,
    ``,
    `FOCUS HISTORY (most recent ${recent.length}):`,
    recent.length === 0
      ? "  (this is the first observation)"
      : recent
          .map(
            (observation) => `  step ${observation.step}: ${describeFocus(observation)}`,
          )
          .join("\n"),
    ``,
    `DISCOVERED INTERACTIVE ELEMENTS (${input.discoveredElements.length} total, ${unreached.length} not yet reached):`,
    input.discoveredElements.length === 0
      ? "  (none discovered)"
      : elementsWorthListing(input.discoveredElements, visited)
          .map((element) => describeElement(element, visited))
          .join("\n"),
  ];

  if (input.discoveredElements.length > MAX_ELEMENTS_LISTED) {
    sections.push(
      `  … and ${input.discoveredElements.length - MAX_ELEMENTS_LISTED} more not listed.`,
    );
  }

  // The open investigation, when there is one. Placed before the element list
  // so the model reads its own question before the raw material — an agent that
  // re-reads the page first tends to start a new line of enquiry instead of
  // finishing the one it has.
  if (input.investigation !== null) {
    const investigation = input.investigation;

    sections.push(
      ``,
      `>>> YOU ARE INVESTIGATING — this is not ordinary exploration <<<`,
      `  Suspicion:    ${investigation.issueType} (${investigation.severity})`,
      `  Triggered at: step ${investigation.triggeringStep}`,
      `  Confidence:   ${investigation.confidence}`,
      `  Suspicious controls: ${
        investigation.suspiciousElementIds.length === 0
          ? "(none identified)"
          : investigation.suspiciousElementIds.slice(0, 5).join(", ")
      }`,
      `  Keys spent so far: ${
        investigation.evidenceActions.length === 0
          ? "(none yet)"
          : investigation.evidenceActions.join(" → ")
      }`,
      `  Your hypotheses:`,
      ...investigation.hypotheses
        .slice(-MAX_INVESTIGATION_HYPOTHESES)
        .map(
          (hypothesis) =>
            `    - (step ${hypothesis.raisedAtStep}, confidence ${hypothesis.confidence}) ${truncate(hypothesis.statement, 160)}`,
        ),
      ``,
      `  Continue with INVESTIGATE while you are still gathering evidence.`,
      `  Return REPORT once the sequence above demonstrates the problem.`,
      `  Return CONTINUE to drop this line of enquiry and resume exploring —`,
      `  which is the right call if the evidence has not borne it out.`,
    );
  }

  // Always rendered, even when empty: "no hypotheses open" is information the
  // model needs, and a section that appears only sometimes is easy to overlook
  // when it finally does.
  sections.push(
    ``,
    `PREVIOUS FINDINGS — hypotheses you are still testing:`,
    ...(input.suspectedFindings.length === 0
      ? ["  (none raised yet)"]
      : input.suspectedFindings
          .slice(-MAX_OPEN_HYPOTHESES)
          .map(
            (finding) =>
              `  - ${finding.details.type} (confidence ${finding.confidence}): ${truncate(finding.reasoning, 160)}`,
          )),
  );

  if (input.rejectedClaims !== undefined && input.rejectedClaims.length > 0) {
    sections.push(
      ``,
      `ALREADY REPORTED AND REFUSED — do not report these again unless you have`,
      `new evidence the trace supports:`,
      ...input.rejectedClaims.map(
        (claim) => `  - ${claim.type}: ${truncate(claim.reasons.join("; "), 200)}`,
      ),
    );
  }

  sections.push(
    ``,
    `ACCESSIBILITY TREE (${input.observation.aria.nodeCount} nodes${
      input.observation.aria.truncated ? ", TRUNCATED" : ""
    }):`,
    input.observation.aria.snapshot.slice(0, MAX_ARIA_CHARS),
    ``,
    `DOM SUMMARY (${input.observation.dom.nodeCount} nodes${
      input.observation.dom.truncated ? ", TRUNCATED" : ""
    }):`,
    input.observation.dom.summary.slice(0, MAX_DOM_CHARS),
    ``,
    input.screenshot === null
      ? `NO SCREENSHOT was submitted for this step. Reason from the state above.`
      : `A SCREENSHOT of the current viewport is attached. Use it for visual` +
          ` context — layout and reading order — but treat the focus reported` +
          ` above as the source of truth.`,
    ``,
    `Decide what to do next.`,
  );

  return sections.join("\n");
}
