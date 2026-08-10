import { describe, expect, it } from "vitest";

import { BrowserLayerError, keyForAction } from "@/lib/browser";

describe("keyForAction", () => {
  it("maps the allowlisted actions to keypresses", () => {
    expect(keyForAction("TAB")).toBe("Tab");
    expect(keyForAction("SHIFT_TAB")).toBe("Shift+Tab");
  });

  // Defence in depth behind the action guard: even if a bug skipped the guard
  // entirely, the only path to the keyboard re-checks the allowlist.
  it.each(["ENTER", "SPACE", "ESCAPE", "ARROW_DOWN", "HOME", "END", "F5"])(
    "refuses %s",
    (action) => {
      expect(() => keyForAction(action as never)).toThrow(BrowserLayerError);
    },
  );

  it("refuses values that are not actions at all", () => {
    for (const value of [null, undefined, 42, {}, ["TAB"], "Tab", "tab"]) {
      expect(() => keyForAction(value as never)).toThrow(BrowserLayerError);
    }
  });

  it("reports the refusal with a code the caller can branch on", () => {
    try {
      keyForAction("ENTER" as never);
      expect.unreachable("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(BrowserLayerError);
      if (error instanceof BrowserLayerError) {
        expect(error.code).toBe("ACTION_NOT_ALLOWLISTED");
      }
    }
  });

  it("does not leak the rejected value into an executable position", () => {
    // The message quotes the input for debugging, but the function throws
    // rather than returning anything a caller could press.
    expect(() => keyForAction("Tab; rm -rf /" as never)).toThrow(/outside the allowlist/);
  });
});
