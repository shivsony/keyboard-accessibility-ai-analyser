import { describe, expect, it } from "vitest";

import {
  KEYBOARD_ACTIONS,
  KeyboardActionSchema,
  isKeyboardAction,
} from "@/lib/shared/domain";

describe("keyboard allowlist", () => {
  it("contains exactly the two MVP actions", () => {
    expect([...KEYBOARD_ACTIONS]).toEqual(["TAB", "SHIFT_TAB"]);
  });

  it("is frozen, so no module can extend it at runtime", () => {
    expect(Object.isFrozen(KEYBOARD_ACTIONS)).toBe(true);
  });

  // The out-of-scope keys are excluded for capability reasons, not just scope:
  // on a hostile page they submit forms, follow links, and open dialogs.
  it.each(["ENTER", "SPACE", "ESCAPE", "ARROW_DOWN", "HOME", "END"])(
    "rejects the out-of-scope key %s",
    (action) => {
      expect(isKeyboardAction(action)).toBe(false);
      expect(KeyboardActionSchema.safeParse(action).success).toBe(false);
    },
  );

  it("matches exactly — not by prefix, case, or whitespace", () => {
    for (const near of ["tab", "Tab", "TAB ", " TAB", "TAB\n", "SHIFT_TAB;TAB"]) {
      expect(isKeyboardAction(near)).toBe(false);
    }
  });

  it("rejects non-string input without throwing", () => {
    for (const value of [null, undefined, 0, {}, [], { action: "TAB" }]) {
      expect(isKeyboardAction(value)).toBe(false);
    }
  });

  it("accepts the allowlisted actions", () => {
    expect(isKeyboardAction("TAB")).toBe(true);
    expect(isKeyboardAction("SHIFT_TAB")).toBe(true);
  });
});
