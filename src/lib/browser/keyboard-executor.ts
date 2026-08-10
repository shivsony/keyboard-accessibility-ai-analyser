import "server-only";

import {
  isKeyboardAction,
  isSameFocus,
  type FocusState,
  type KeyboardAction,
  type StepIndex,
  type Timestamp,
} from "@/lib/shared/domain";

import { BrowserLayerError, isBrowserLayerError } from "./errors";
import type { ObservationCapture } from "./types";

/**
 * The narrow slice of the page the executor drives.
 *
 * Deliberately smaller than `PageController`: the executor presses keys and
 * observes the result, and has no business navigating or taking screenshots on
 * its own. It also makes the unit tests a fake rather than a browser.
 */
export type KeyboardTarget = {
  press(action: KeyboardAction): Promise<void>;
  captureFocus(atStep: StepIndex): Promise<FocusState>;
  observe(atStep: StepIndex): Promise<ObservationCapture>;
};

export type KeyboardExecutorOptions = {
  /**
   * Pause between the keypress and the observation.
   *
   * Focus changes, scrolling, and dialog transitions are not synchronous with
   * the keypress. Observing immediately would record the state the page is
   * leaving rather than the one it arrives at.
   */
  readonly settleMs: number;
  /** Injectable so unit tests do not spend real time settling. */
  readonly sleep?: (ms: number) => Promise<void>;
};

export const DEFAULT_SETTLE_MS = 250;

/**
 * What the browser did.
 *
 * A discriminated union on `outcome`, because the three cases carry genuinely
 * different information and flattening them would mean a caller reading
 * `newFocus` off a result where no key was ever pressed.
 *
 * Note what this type does **not** contain: any notion of success. `focusChanged`
 * is a browser fact, not a verdict. Whether moving focus there was correct,
 * expected, or an accessibility bug is a question for the agent and the rules
 * layer — the executor only reports what happened (ARCHITECTURE.md §2.7).
 */
export type KeyboardExecutionResult =
  | {
      readonly outcome: "EXECUTED";
      readonly action: KeyboardAction;
      readonly previousFocus: FocusState;
      readonly newFocus: FocusState;
      /** Focus is at a different position than before the keypress. */
      readonly focusChanged: boolean;
      readonly observation: ObservationCapture;
      readonly startedAt: Timestamp;
      readonly completedAt: Timestamp;
      readonly error: null;
    }
  | {
      readonly outcome: "REJECTED";
      /** The value as requested, retained as evidence. Never pressed. */
      readonly requested: string;
      /**
       * Everything outside the frozen set lands here — including a raw
       * Playwright key string like `"Tab"`, which is exactly the mistake the
       * domain enum exists to prevent.
       */
      readonly reason: "NOT_ALLOWLISTED";
      readonly previousFocus: FocusState | null;
      readonly focusChanged: false;
      readonly startedAt: Timestamp;
      readonly completedAt: Timestamp;
      readonly error: BrowserLayerError;
    }
  | {
      readonly outcome: "FAILED";
      readonly action: KeyboardAction;
      readonly previousFocus: FocusState | null;
      /** Focus after the failure, when it could still be read. */
      readonly newFocus: FocusState | null;
      readonly focusChanged: boolean;
      readonly startedAt: Timestamp;
      readonly completedAt: Timestamp;
      readonly error: BrowserLayerError;
    };

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const now = (): Timestamp => new Date().toISOString();

/**
 * Executes one allowlisted keyboard action and reports what the browser did.
 *
 * The sequence per call is fixed: capture focus, press, settle, capture focus
 * again, observe. Focus is captured *here* rather than taken from the caller's
 * state, so "before" and "after" are read the same way one keypress apart —
 * a caller passing stale state would silently produce wrong `focusChanged`
 * values, which is the one fact this class exists to get right.
 */
export class KeyboardExecutor {
  #target: KeyboardTarget;
  #settleMs: number;
  #sleep: (ms: number) => Promise<void>;

  constructor(target: KeyboardTarget, options: Partial<KeyboardExecutorOptions> = {}) {
    this.#target = target;
    this.#settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;
    this.#sleep = options.sleep ?? defaultSleep;
  }

  /**
   * Rejections are returned, not thrown.
   *
   * A model repeatedly asking for a key it cannot have is a signal worth
   * recording (SECURITY.md §2), and a thrown error tends to become a stack
   * trace in a log rather than a row in the run record.
   */
  async execute(
    action: KeyboardAction,
    step: StepIndex,
  ): Promise<KeyboardExecutionResult> {
    const startedAt = now();

    // Checked before anything else: an unsupported action must not cause a
    // focus capture, a settle, or any other contact with the page.
    if (!isKeyboardAction(action)) {
      return {
        outcome: "REJECTED",
        requested: describe(action),
        reason: "NOT_ALLOWLISTED",
        previousFocus: null,
        focusChanged: false,
        startedAt,
        completedAt: now(),
        error: new BrowserLayerError(
          "ACTION_NOT_ALLOWLISTED",
          `Refusing to execute an action outside the allowlist: ${describe(action)}`,
        ),
      };
    }

    let previousFocus: FocusState | null = null;

    try {
      previousFocus = await this.#target.captureFocus(step);

      await this.#target.press(action);
      await this.#sleep(this.#settleMs);

      const newFocus = await this.#target.captureFocus(step);
      const observation = await this.#target.observe(step);

      return {
        outcome: "EXECUTED",
        action,
        previousFocus,
        newFocus,
        focusChanged: !isSameFocus(previousFocus, newFocus),
        observation,
        startedAt,
        completedAt: now(),
        error: null,
      };
    } catch (error) {
      // A failure can happen before or after the key landed, and the executor
      // cannot always tell which. Reporting the focus it managed to read keeps
      // that ambiguity visible instead of guessing.
      return {
        outcome: "FAILED",
        action,
        previousFocus,
        newFocus: null,
        focusChanged: false,
        startedAt,
        completedAt: now(),
        error: toBrowserLayerError(error, `Failed to execute ${action}`),
      };
    }
  }
}

/** Renders an unsupported request for the record without trusting its type. */
function describe(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  return Object.prototype.toString.call(value);
}

function toBrowserLayerError(error: unknown, fallback: string): BrowserLayerError {
  if (isBrowserLayerError(error)) return error;
  return new BrowserLayerError("EVALUATION_FAILED", fallback, { cause: error });
}
