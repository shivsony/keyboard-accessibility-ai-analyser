import type {
  AccessibilitySnapshot,
  DOMSnapshot,
  FocusState,
  InteractiveElement,
  KeyboardAction,
  StepIndex,
  Timestamp,
  Url,
  Viewport,
} from "@/lib/shared/domain";

/**
 * The browser layer's public surface.
 *
 * Nothing here mentions Playwright. Callers get domain types and these two
 * interfaces, so the rest of the application never holds a `Page`, and swapping
 * the driver — or faking it in a test — stays a local change.
 *
 * What is *absent* matters as much as what is present: no `evaluate(script)`,
 * no `click(selector)`, no `type(text)`, no way to run a string. The only
 * inputs this layer accepts are a URL and an allowlisted keyboard action
 * (ARCHITECTURE.md §2.3).
 */

/** Raw screenshot bytes. Persisting them is the evidence layer's job. */
export type ScreenshotCapture = {
  readonly png: Uint8Array;
  readonly viewport: Viewport;
  readonly capturedAt: Timestamp;
};

export type BrowserSessionOptions = {
  readonly headless: boolean;
  readonly viewport: Viewport;
  /** Per-navigation limit. */
  readonly navigationTimeoutMs: number;
  /** Ceiling on the whole session, across every operation. */
  readonly auditTimeoutMs: number;
  /** Limit on elements collected per observation. */
  readonly maxElements: number;
  /** Limit on lines in a DOM summary. */
  readonly maxDomLines: number;
  /** Aborting closes the session and fails in-flight operations. */
  readonly signal: AbortSignal | null;
};

export const DEFAULT_SESSION_OPTIONS: Omit<
  BrowserSessionOptions,
  "headless" | "viewport" | "signal"
> = Object.freeze({
  navigationTimeoutMs: 30_000,
  auditTimeoutMs: 300_000,
  maxElements: 500,
  maxDomLines: 400,
});

/**
 * One page, observed and driven by the keyboard.
 *
 * The capture methods take the step they are capturing for because element
 * records carry `discoveredAtStep`, and the browser cannot know the loop's
 * position on its own. Passing it in keeps a single element type flowing
 * through the system instead of a near-duplicate per layer.
 */
export interface PageController {
  /** The URL currently loaded, which is not always the one we asked for. */
  currentUrl(): Url;

  navigate(url: Url): Promise<void>;

  /** Presses exactly one allowlisted key. The only way to affect the page. */
  press(action: KeyboardAction): Promise<void>;

  screenshot(): Promise<ScreenshotCapture>;

  captureDom(): Promise<DOMSnapshot>;

  captureAccessibility(): Promise<AccessibilitySnapshot>;

  captureFocus(atStep: StepIndex): Promise<FocusState>;

  captureInteractiveElements(atStep: StepIndex): Promise<readonly InteractiveElement[]>;

  readonly isUsable: boolean;
}

/**
 * Owns the browser process, the isolated context, and the page.
 *
 * The context is created fresh per session and thrown away with it: no shared
 * profile, no cookies, no storage, nothing carried between runs
 * (SECURITY.md §5).
 */
export interface BrowserController extends AsyncDisposable {
  readonly viewport: Viewport;
  readonly isClosed: boolean;

  /** Launches if needed, then opens the URL and returns the page controller. */
  open(url: Url): Promise<PageController>;

  /** Idempotent, and safe to call after a crash or a failed launch. */
  close(): Promise<void>;
}
