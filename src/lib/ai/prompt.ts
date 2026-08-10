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

/** How many earlier observations to include. Enough for a cycle to be visible. */
const OBSERVATION_WINDOW = 6;
const MAX_ELEMENTS_LISTED = 60;
const MAX_HISTORY_LISTED = 40;

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

function describeElement(
  element: InteractiveElement,
  visited: ReadonlySet<string>,
): string {
  const name = element.accessibleName ?? "(no accessible name)";
  const role = element.role ?? element.tagName;
  const flags = [
    visited.has(element.id) ? "reached" : "NOT REACHED",
    element.visible ? null : "not visible",
    element.disabled ? "disabled" : null,
    element.tabIndex === null ? null : `tabindex=${element.tabIndex}`,
    `via ${element.discoveredVia}`,
  ].filter((flag) => flag !== null);

  return `  - [${element.id}] ${role} "${name}" (${flags.join(", ")})`;
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
    `  ${input.navigationSummary || "(nothing traversed yet)"}`,
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
      : input.discoveredElements
          .slice(0, MAX_ELEMENTS_LISTED)
          .map((element) => describeElement(element, visited))
          .join("\n"),
  ];

  if (input.discoveredElements.length > MAX_ELEMENTS_LISTED) {
    sections.push(
      `  … and ${input.discoveredElements.length - MAX_ELEMENTS_LISTED} more not listed.`,
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
      : input.suspectedFindings.map(
          (finding) =>
            `  - ${finding.details.type} (confidence ${finding.confidence}): ${finding.reasoning}`,
        )),
  );

  sections.push(
    ``,
    `ACCESSIBILITY TREE (${input.observation.aria.nodeCount} nodes${
      input.observation.aria.truncated ? ", TRUNCATED" : ""
    }):`,
    input.observation.aria.snapshot.slice(0, 4000),
    ``,
    `DOM SUMMARY (${input.observation.dom.nodeCount} nodes${
      input.observation.dom.truncated ? ", TRUNCATED" : ""
    }):`,
    input.observation.dom.summary.slice(0, 4000),
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
