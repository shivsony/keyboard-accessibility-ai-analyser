import type { KeyboardAccessibilityReport } from "@/lib/report";

/**
 * The shapes the HTTP API exchanges.
 *
 * Deliberately free of `server-only`, so the UI and the route handlers agree on
 * one definition instead of drifting apart. Nothing here may carry a
 * credential, an environment variable, or a server path — the API's job is to
 * decide what crosses this boundary, and this file is the list.
 */

export type AuditStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export type AuditFailure = {
  readonly code:
    "BROWSER_FAILURE" | "AI_FAILURE" | "AI_NOT_CONFIGURED" | "TIMEOUT" | "INTERNAL";
  readonly message: string;
};

/** A finding, as the live view needs it while the audit is still running. */
export type LiveFinding = {
  readonly id: string;
  readonly severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  readonly title: string;
  readonly confidence: number;
  /** "Tab → Logo", ready to render. */
  readonly path: readonly string[];
  readonly screenshotStep: number | null;
};

/**
 * What the agent is doing right now.
 *
 * `rationale` is the model's one-line reason for the current decision — not its
 * working. A developer tool should say "Exploring the next sequential focusable
 * control", not narrate a train of thought; the full reasoning trail belongs in
 * the report, where it is labelled as interpretation.
 */
export type LiveAuditSnapshot = {
  readonly step: number;
  readonly mode: "EXPLORING" | "INVESTIGATING";
  readonly currentFocus: string;
  readonly lastAction: string | null;
  readonly discoveredCount: number;
  readonly visitedCount: number;
  readonly decision: string | null;
  readonly rationale: string | null;
  readonly confidence: number | null;
  /** The traversal so far: ["Logo", "Search", "Menu"]. */
  readonly path: readonly string[];
  readonly findings: readonly LiveFinding[];
};

export type AuditResponse = {
  readonly id: string;
  readonly status: AuditStatus;
  readonly step: number;
  readonly url: string;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly live: LiveAuditSnapshot | null;
  readonly result: KeyboardAccessibilityReport | null;
  readonly error: AuditFailure | null;
};

export type ApiError = {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly issues?: readonly { path: string; message: string }[];
  };
};

export type StartAuditResponse = { readonly auditId: string };

/** Where a step's screenshot is served from. */
export function screenshotUrl(auditId: string, step: number): string {
  return `/api/audits/${auditId}/screenshots/${step}`;
}
