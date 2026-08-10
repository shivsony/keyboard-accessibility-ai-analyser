import "server-only";

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { createAIProvider, isAIProviderError, SYSTEM_PROMPT_VERSION } from "@/lib/ai";
import {
  DEFAULT_SESSION_OPTIONS,
  KeyboardExecutor,
  PlaywrightBrowserController,
} from "@/lib/browser";
import { traversalPath } from "@/lib/graph";
import { ReportGenerator } from "@/lib/report";
import type { LiveAuditSnapshot, LiveFinding } from "@/lib/shared/api-types";
import { focusedElement, type AgentState, type FocusState } from "@/lib/shared/domain";
import { getEnv } from "@/lib/shared/env";

import { DEFAULT_EXPLORATION_OPTIONS, ExplorationAgent } from "./exploration-agent";
import type { AuditFailure } from "@/lib/shared/api-types";

import type { AuditRunner } from "./audit-registry";

/**
 * Runs one audit, server-side, start to finish.
 *
 * Everything that touches a browser, a provider, or a credential happens here,
 * in the Node process. Nothing in this module — or anything it imports — is
 * reachable from the client bundle.
 *
 * The runner returns failures rather than throwing, so the registry always has
 * something to record. A run that ends in an error still produces a coded
 * outcome; it never leaves a record stuck on "running".
 */

/** Truncated runs still produce a report. The reason travels with it. */
const TRUNCATING_REASONS = new Set([
  "STEP_BUDGET_EXHAUSTED",
  "TIME_BUDGET_EXHAUSTED",
  "REPEATED_STATE",
]);

export const runAudit: AuditRunner = async ({ auditId, url, signal, progress }) => {
  const startedAt = new Date().toISOString();

  // Configuration first: launching a browser before discovering there is no
  // API key wastes twenty seconds and leaves the user watching a spinner.
  let provider;
  try {
    provider = createAIProvider();
  } catch (error) {
    return {
      outcome: "failed",
      error: {
        code: "AI_NOT_CONFIGURED",
        // Safe to pass through: this message is written by our own factory and
        // deliberately says what to set without hinting at the value.
        message: isAIProviderError(error)
          ? error.message
          : "AI provider is not configured.",
      },
    };
  }

  const env = getEnv();

  const browser = new PlaywrightBrowserController({
    ...DEFAULT_SESSION_OPTIONS,
    headless: env.BROWSER_HEADLESS,
    viewport: {
      width: env.BROWSER_VIEWPORT_WIDTH,
      height: env.BROWSER_VIEWPORT_HEIGHT,
      deviceScaleFactor: 1,
    },
    signal,
  });

  try {
    const page = await browser.open(url);

    const agent = new ExplorationAgent(
      {
        page,
        executor: new KeyboardExecutor(page, { settleMs: env.AGENT_SETTLE_MS }),
        provider,
      },
      {
        ...DEFAULT_EXPLORATION_OPTIONS,
        maxSteps: env.AGENT_MAX_STEPS,
        signal,
        onProgress: (update) => {
          progress.onLive(toLiveSnapshot(update));
        },
        onScreenshot: (step, png) =>
          writeScreenshot(auditId, step, png, env.EVIDENCE_DIR),
      },
    );

    const result = await agent.run({ auditId, url });

    progress.onStep(result.state.steps.length);

    if (result.terminationReason === "CANCELLED") return { outcome: "cancelled" };

    const failure = failureFor(result.terminationReason);
    if (failure !== null) return { outcome: "failed", error: failure };

    const report = new ReportGenerator({
      state: result.state,
      startedAt,
      completedAt: new Date().toISOString(),
      terminationReason: result.terminationReason,
      method: {
        provider: provider.name,
        model: provider.model,
        multimodal: provider.multimodal,
        promptVersion: SYSTEM_PROMPT_VERSION,
      },
    }).generate();

    await writeReport(auditId, report, env.EVIDENCE_DIR);

    return { outcome: "completed", report };
  } catch (error) {
    if (signal.aborted) return { outcome: "cancelled" };

    return {
      outcome: "failed",
      error: {
        code: isAIProviderError(error) ? "AI_FAILURE" : "BROWSER_FAILURE",
        // Never the underlying message: a driver error can carry a local path
        // and a provider error can echo a request header.
        message: isAIProviderError(error)
          ? "The AI provider could not be reached. Check the configuration and try again."
          : "The browser could not complete the audit.",
      },
    };
  } finally {
    await browser.close().catch(() => undefined);
  }
};

/**
 * Reduces a progress update to what a display needs.
 *
 * Only the model's one-line reason travels, never a longer rationale: this is a
 * developer tool, and a live view narrating a train of thought would be both
 * noise and a claim about the model's internals that nobody can check. The full
 * reasoning trail is in the report, labelled as interpretation.
 */
function toLiveSnapshot(update: {
  step: number;
  mode: "EXPLORING" | "INVESTIGATING";
  currentFocus: FocusState;
  lastAction: string | null;
  discoveredCount: number;
  visitedCount: number;
  decision: { decision: string; reason: string; confidence: number };
  state: AgentState;
}): LiveAuditSnapshot {
  return {
    step: update.step,
    mode: update.mode,
    currentFocus: focusLabel(update.currentFocus),
    lastAction: update.lastAction === null ? null : actionLabel(update.lastAction),
    discoveredCount: update.discoveredCount,
    visitedCount: update.visitedCount,
    decision: update.decision.decision,
    rationale: update.decision.reason,
    confidence: update.decision.confidence,
    path: pathLabels(update.state),
    findings: update.state.confirmedFindings.map((finding): LiveFinding => ({
      id: finding.id,
      severity: finding.severity,
      title: finding.suggestedFix,
      confidence: finding.confidence,
      path: finding.evidence.keyboardSequence.map(actionLabel),
      screenshotStep: finding.evidence.steps.to,
    })),
  };
}

function actionLabel(action: string): string {
  return action === "SHIFT_TAB" ? "Shift+Tab" : "Tab";
}

function focusLabel(focus: FocusState): string {
  const element = focusedElement(focus);
  if (element !== null) return element.accessibleName ?? element.role ?? element.tagName;

  switch (focus.kind) {
    case "BODY":
      return "the document body";
    case "OUTSIDE_PAGE":
      return "outside the page";
    default:
      return "not observed";
  }
}

function pathLabels(state: AgentState): readonly string[] {
  const path = traversalPath(state.navigationGraph);

  return path.nodes.map(
    (node) => node.accessibleName ?? node.role ?? node.elementId ?? node.focusKind,
  );
}

/**
 * Writes one step's screenshot.
 *
 * Bytes are not kept in the run record, so this is the only chance to persist
 * them — and without them a finding has no visual evidence to show.
 */
async function writeScreenshot(
  auditId: string,
  step: number,
  png: Uint8Array,
  evidenceDir: string,
): Promise<void> {
  assertSafeAuditId(auditId);

  const directory = path.resolve(evidenceDir, auditId, "steps");

  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, `${String(step).padStart(4, "0")}.png`), png);
}

/**
 * Whether a termination reason is a failure or a truncated success.
 *
 * Running out of steps or time is not an error: the traversal covered less of
 * the page than it wanted to, and a partial report saying so is more useful
 * than an error with nothing in it. The reason is recorded in the overview, so
 * a reader knows to treat the coverage accordingly.
 */
function failureFor(reason: string): AuditFailure | null {
  if (TRUNCATING_REASONS.has(reason)) return null;

  switch (reason) {
    case "DRIVER_ERROR":
      return {
        code: "BROWSER_FAILURE",
        message: "The browser could not complete the audit.",
      };
    case "AI_ERROR":
      return {
        code: "AI_FAILURE",
        message: "The AI provider could not be reached. Check the configuration.",
      };
    case "DECISION_INVALID":
      return {
        code: "AI_FAILURE",
        message: "The model did not return a usable decision after several attempts.",
      };
    case "NAVIGATED_AWAY":
      return {
        code: "BROWSER_FAILURE",
        message: "The page navigated away from the audited URL.",
      };
    default:
      return null;
  }
}

/**
 * Writes the report beside the run's artifacts.
 *
 * The path is returned to nobody. A client gets the report as JSON from the
 * API; where it happens to live on the server's disk is not the client's
 * business, and disclosing it would hand out the directory layout for free.
 */
async function writeReport(
  auditId: string,
  report: unknown,
  evidenceDir: string,
): Promise<void> {
  assertSafeAuditId(auditId);

  const directory = path.resolve(evidenceDir, auditId);

  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
}

/**
 * The audit id reaches a filesystem path.
 *
 * It is a generated UUID today, so this never fires — which is exactly why it
 * is worth keeping. A check that only matters when something upstream changes
 * is the one you want already in place when it does.
 */
function assertSafeAuditId(auditId: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(auditId)) {
    throw new Error("Refusing to write artifacts for an unsafe audit id");
  }
}
