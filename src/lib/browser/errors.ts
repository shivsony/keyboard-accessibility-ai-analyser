/**
 * Failures the browser layer can produce.
 *
 * Every one is typed and coded, because the orchestrator's response differs per
 * cause: a navigation timeout ends the run with a reason, a crash ends it with
 * an error, and a cancellation is not a failure at all. A bare `Error` would
 * flatten those into "something went wrong".
 */

export const BROWSER_ERROR_CODES = Object.freeze([
  "LAUNCH_FAILED",
  "NAVIGATION_FAILED",
  "NAVIGATION_TIMEOUT",
  "AUDIT_TIMEOUT",
  "PAGE_CRASHED",
  "SESSION_CLOSED",
  "CANCELLED",
  "EVALUATION_FAILED",
  "ACTION_NOT_ALLOWLISTED",
] as const);

export type BrowserErrorCode = (typeof BROWSER_ERROR_CODES)[number];

export class BrowserLayerError extends Error {
  readonly code: BrowserErrorCode;

  constructor(code: BrowserErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "BrowserLayerError";
    this.code = code;
  }
}

export function isBrowserLayerError(error: unknown): error is BrowserLayerError {
  return error instanceof BrowserLayerError;
}

/**
 * Errors raised while tearing down, kept together.
 *
 * Cleanup attempts every resource even when an earlier one fails, so there can
 * be more than one problem to report and none of them should silence the
 * others.
 */
export class BrowserCleanupError extends Error {
  readonly failures: readonly unknown[];

  constructor(failures: readonly unknown[]) {
    super(`Browser cleanup failed for ${failures.length} resource(s)`);
    this.name = "BrowserCleanupError";
    this.failures = failures;
  }
}

/** Playwright reports timeouts by message; this keeps that sniffing in one place. */
export function isTimeoutLike(error: unknown): boolean {
  if (error instanceof Error) {
    return error.name === "TimeoutError" || /timeout/i.test(error.message);
  }
  return false;
}
