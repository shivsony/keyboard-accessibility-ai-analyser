import { isKeyboardAction, type KeyboardAction } from "@/lib/shared/domain";

import { BrowserLayerError } from "./errors";

/**
 * The action → keypress table. This is the whole translation layer.
 *
 * Adding a row here is a security change, not a feature (SECURITY.md §2). The
 * excluded keys are excluded for what they *do* on an untrusted page — Enter
 * and Space activate controls and submit forms, Escape dismisses dialogs — not
 * merely because the MVP has not gotten to them.
 */
const KEY_FOR_ACTION = Object.freeze({
  TAB: "Tab",
  SHIFT_TAB: "Shift+Tab",
} as const satisfies Record<KeyboardAction, string>);

export type PlaywrightKey = (typeof KEY_FOR_ACTION)[KeyboardAction];

/**
 * Resolves an action to a keypress, re-validating the allowlist on the way.
 *
 * This is defence in depth behind the agent's action guard: a bug that skips
 * the guard entirely still cannot get an unallowlisted key to the browser,
 * because the only path to `keyboard.press` runs through here
 * (ARCHITECTURE.md §2.3).
 */
export function keyForAction(action: KeyboardAction): PlaywrightKey {
  if (!isKeyboardAction(action)) {
    throw new BrowserLayerError(
      "ACTION_NOT_ALLOWLISTED",
      `Refusing to press a key outside the allowlist: ${JSON.stringify(action)}`,
    );
  }

  return KEY_FOR_ACTION[action];
}
