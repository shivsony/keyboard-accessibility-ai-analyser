/**
 * The browser layer.
 *
 * Server-only, and the only place Playwright is imported. Callers get the
 * `BrowserController` / `PageController` interfaces and domain types; nothing
 * above this boundary holds a `Page`.
 *
 * `page-scripts` is exported for tests and for the discovery layer's reference,
 * not because anything else should call into the page directly.
 */

export * from "./types";
export * from "./errors";
export * from "./keys";
export { Deadline, withTimeout } from "./deadline";
export { ObservationEngine } from "./observation-engine";
export {
  KeyboardExecutor,
  DEFAULT_SETTLE_MS,
  type KeyboardExecutionResult,
  type KeyboardExecutorOptions,
  type KeyboardTarget,
} from "./keyboard-executor";
export { PlaywrightBrowserController, withBrowserSession } from "./playwright-controller";
