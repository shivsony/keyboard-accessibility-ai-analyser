import { describe, expect, it, vi } from "vitest";

import { DEFAULT_SETTLE_MS, KeyboardExecutor, type KeyboardTarget } from "@/lib/browser";
import {
  focusOn,
  type FocusState,
  type KeyboardAction,
  type StepIndex,
} from "@/lib/shared/domain";

import { makeElement, makeObservation, VIEWPORT } from "../../fixtures/domain";

/**
 * A scripted page.
 *
 * The executor's job is to report browser behaviour faithfully, so the tests
 * that matter are about what it records — including the awkward cases a real
 * browser makes hard to stage on demand, like a press that throws.
 */
function makeTarget(
  focusSequence: readonly FocusState[],
  overrides: Partial<KeyboardTarget> = {},
): KeyboardTarget & { readonly pressed: KeyboardAction[]; readonly calls: string[] } {
  const pressed: KeyboardAction[] = [];
  const calls: string[] = [];
  let focusIndex = 0;

  const target = {
    pressed,
    calls,
    async press(action: KeyboardAction) {
      calls.push(`press:${action}`);
      pressed.push(action);
    },
    async captureFocus() {
      calls.push("captureFocus");
      const focus = focusSequence[Math.min(focusIndex, focusSequence.length - 1)];
      focusIndex += 1;
      return focus ?? { kind: "UNKNOWN" };
    },
    async observe(atStep: StepIndex) {
      calls.push("observe");
      return {
        observation: makeObservation(atStep),
        screenshot: {
          png: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
          viewport: VIEWPORT,
          capturedAt: new Date().toISOString(),
        },
      };
    },
    ...overrides,
  };

  return target;
}

const BUTTON_A = focusOn(makeElement("a"));
const BUTTON_B = focusOn(makeElement("b"));

// Settling is real time in production; tests should not spend it.
const instant = { settleMs: 0, sleep: async () => undefined };

describe("KeyboardExecutor", () => {
  describe("supported actions", () => {
    it("executes TAB", async () => {
      const target = makeTarget([BUTTON_A, BUTTON_B]);
      const result = await new KeyboardExecutor(target, instant).execute("TAB", 0);

      expect(result.outcome).toBe("EXECUTED");
      expect(target.pressed).toEqual(["TAB"]);
      if (result.outcome === "EXECUTED") {
        expect(result.action).toBe("TAB");
        expect(result.error).toBeNull();
      }
    });

    it("executes SHIFT_TAB", async () => {
      const target = makeTarget([BUTTON_B, BUTTON_A]);
      const result = await new KeyboardExecutor(target, instant).execute("SHIFT_TAB", 0);

      expect(result.outcome).toBe("EXECUTED");
      expect(target.pressed).toEqual(["SHIFT_TAB"]);
    });

    it("passes the domain action through, never a raw key string", async () => {
      const target = makeTarget([BUTTON_A, BUTTON_B]);
      await new KeyboardExecutor(target, instant).execute("TAB", 0);

      // "Tab" and "Shift+Tab" are the browser layer's business. What crosses
      // this boundary is the domain action.
      expect(target.pressed).toEqual(["TAB"]);
      expect(target.pressed).not.toContain("Tab");
    });
  });

  describe("unsupported actions", () => {
    // Every one of these is a compile error in real code; the runtime check
    // exists because untrusted model output does not typecheck.
    it.each([
      "ENTER",
      "SPACE",
      "ESCAPE",
      "ARROW_DOWN",
      "HOME",
      "END",
      // Raw Playwright key strings: the mistake the domain enum prevents.
      "Tab",
      "Shift+Tab",
      "tab",
      "TAB ",
    ])("rejects %s", async (action) => {
      const target = makeTarget([BUTTON_A]);
      const result = await new KeyboardExecutor(target, instant).execute(
        action as never,
        0,
      );

      expect(result.outcome).toBe("REJECTED");
      if (result.outcome === "REJECTED") {
        expect(result.reason).toBe("NOT_ALLOWLISTED");
        expect(result.error.code).toBe("ACTION_NOT_ALLOWLISTED");
        expect(result.focusChanged).toBe(false);
      }
    });

    it.each([null, undefined, 42, {}, ["TAB"]])(
      "rejects the non-action %s",
      async (action) => {
        const target = makeTarget([BUTTON_A]);
        const result = await new KeyboardExecutor(target, instant).execute(
          action as never,
          0,
        );

        expect(result.outcome).toBe("REJECTED");
      },
    );

    // A rejected action must not touch the page at all — no press, and no
    // observation that might look like a step actually happened.
    it("does not touch the page when rejecting", async () => {
      const target = makeTarget([BUTTON_A]);
      await new KeyboardExecutor(target, instant).execute("ENTER" as never, 0);

      expect(target.pressed).toEqual([]);
      expect(target.calls).toEqual([]);
    });

    it("retains the requested value as evidence without executing it", async () => {
      const target = makeTarget([BUTTON_A]);
      const result = await new KeyboardExecutor(target, instant).execute(
        "Tab; DROP TABLE" as never,
        0,
      );

      if (result.outcome === "REJECTED") {
        expect(result.requested).toContain("Tab; DROP TABLE");
      }
      expect(target.pressed).toEqual([]);
    });
  });

  describe("focus reporting", () => {
    it("reports a focus change between two elements", async () => {
      const target = makeTarget([BUTTON_A, BUTTON_B]);
      const result = await new KeyboardExecutor(target, instant).execute("TAB", 0);

      if (result.outcome !== "EXECUTED") return expect.unreachable("expected EXECUTED");
      expect(result.focusChanged).toBe(true);
      expect(result.previousFocus).toEqual(BUTTON_A);
      expect(result.newFocus).toEqual(BUTTON_B);
    });

    it("reports focus unchanged when the key moved nothing", async () => {
      const target = makeTarget([BUTTON_A, BUTTON_A]);
      const result = await new KeyboardExecutor(target, instant).execute("TAB", 0);

      if (result.outcome !== "EXECUTED") return expect.unreachable("expected EXECUTED");
      expect(result.focusChanged).toBe(false);
      expect(result.previousFocus).toEqual(result.newFocus);
    });

    // The same element re-observed carries a fresh bounding box and a later
    // discovery step. Neither means focus moved.
    it("does not mistake a re-observed element for a move", async () => {
      const sameElementLater = focusOn(
        makeElement("a", {
          discoveredAtStep: 7,
          boundingBox: { x: 10, y: 99, width: 120, height: 40 },
        }),
      );
      const target = makeTarget([BUTTON_A, sameElementLater]);
      const result = await new KeyboardExecutor(target, instant).execute("TAB", 0);

      if (result.outcome !== "EXECUTED") return expect.unreachable("expected EXECUTED");
      expect(result.focusChanged).toBe(false);
    });

    it("treats focus leaving the page as a change", async () => {
      const target = makeTarget([BUTTON_A, { kind: "OUTSIDE_PAGE" }]);
      const result = await new KeyboardExecutor(target, instant).execute("TAB", 0);

      if (result.outcome !== "EXECUTED") return expect.unreachable("expected EXECUTED");
      expect(result.focusChanged).toBe(true);
      expect(result.newFocus).toEqual({ kind: "OUTSIDE_PAGE" });
    });

    it("distinguishes body from outside-page", async () => {
      const target = makeTarget([{ kind: "BODY" }, { kind: "OUTSIDE_PAGE" }]);
      const result = await new KeyboardExecutor(target, instant).execute("TAB", 0);

      if (result.outcome !== "EXECUTED") return expect.unreachable("expected EXECUTED");
      expect(result.focusChanged).toBe(true);
    });
  });

  describe("what it refuses to judge", () => {
    // The executor reports browser behaviour. Whether the behaviour is an
    // accessibility problem belongs to the rules layer and the agent.
    it("carries no verdict, only observations", async () => {
      const target = makeTarget([BUTTON_A, BUTTON_A]);
      const result = await new KeyboardExecutor(target, instant).execute("TAB", 0);

      const keys = Object.keys(result);
      for (const verdict of ["success", "ok", "passed", "valid", "issue", "severity"]) {
        expect(keys).not.toContain(verdict);
      }
      // Focus not moving is recorded as a fact, not flagged as a failure.
      expect(result.outcome).toBe("EXECUTED");
    });
  });

  describe("sequencing", () => {
    it("captures focus, presses, settles, then observes", async () => {
      const target = makeTarget([BUTTON_A, BUTTON_B]);
      const sleep = vi.fn(async () => undefined);

      await new KeyboardExecutor(target, { settleMs: 25, sleep }).execute("TAB", 0);

      expect(target.calls).toEqual([
        "captureFocus",
        "press:TAB",
        "captureFocus",
        "observe",
      ]);
      expect(sleep).toHaveBeenCalledWith(25);
    });

    // Observing immediately after the keypress records the state the page is
    // leaving, not the one it arrives at.
    it("settles between the keypress and the second capture", async () => {
      const order: string[] = [];
      const target = makeTarget([BUTTON_A, BUTTON_B], {
        async press() {
          order.push("press");
        },
      });

      await new KeyboardExecutor(target, {
        settleMs: 5,
        sleep: async () => {
          order.push("settle");
        },
      }).execute("TAB", 0);

      expect(order).toEqual(["press", "settle"]);
    });

    it("defaults to a settle pause rather than none", () => {
      expect(DEFAULT_SETTLE_MS).toBeGreaterThan(0);
    });

    it("includes the observation for the step", async () => {
      const target = makeTarget([BUTTON_A, BUTTON_B]);
      const result = await new KeyboardExecutor(target, instant).execute("TAB", 3);

      if (result.outcome !== "EXECUTED") return expect.unreachable("expected EXECUTED");
      expect(result.observation.observation.step).toBe(3);
      expect(result.observation.screenshot.png.byteLength).toBeGreaterThan(0);
    });

    it("timestamps the attempt", async () => {
      const target = makeTarget([BUTTON_A, BUTTON_B]);
      const result = await new KeyboardExecutor(target, instant).execute("TAB", 0);

      expect(Date.parse(result.startedAt)).not.toBeNaN();
      expect(Date.parse(result.completedAt)).not.toBeNaN();
      expect(Date.parse(result.completedAt)).toBeGreaterThanOrEqual(
        Date.parse(result.startedAt),
      );
    });
  });

  describe("execution errors", () => {
    it("reports a failed keypress instead of throwing", async () => {
      const target = makeTarget([BUTTON_A], {
        async press() {
          throw new Error("renderer went away");
        },
      });

      const result = await new KeyboardExecutor(target, instant).execute("TAB", 0);

      expect(result.outcome).toBe("FAILED");
      if (result.outcome === "FAILED") {
        expect(result.action).toBe("TAB");
        expect(result.error.message).toContain("Failed to execute TAB");
        expect(result.previousFocus).toEqual(BUTTON_A);
        expect(result.newFocus).toBeNull();
      }
    });

    it("preserves a browser-layer error rather than rewrapping it", async () => {
      const target = makeTarget([BUTTON_A], {
        async press() {
          const { BrowserLayerError } = await import("@/lib/browser");
          throw new BrowserLayerError("SESSION_CLOSED", "The page is closed");
        },
      });

      const result = await new KeyboardExecutor(target, instant).execute("TAB", 0);

      if (result.outcome !== "FAILED") return expect.unreachable("expected FAILED");
      expect(result.error.code).toBe("SESSION_CLOSED");
    });

    it("reports a failure while observing, after the key already landed", async () => {
      const target = makeTarget([BUTTON_A, BUTTON_B], {
        async observe() {
          throw new Error("page stopped responding");
        },
      });

      const result = await new KeyboardExecutor(target, instant).execute("TAB", 0);

      expect(result.outcome).toBe("FAILED");
      expect(target.pressed).toEqual(["TAB"]);
    });

    it("survives being unable to read focus at all", async () => {
      const target = makeTarget([], {
        async captureFocus() {
          throw new Error("cannot read focus");
        },
      });

      const result = await new KeyboardExecutor(target, instant).execute("TAB", 0);

      if (result.outcome !== "FAILED") return expect.unreachable("expected FAILED");
      expect(result.previousFocus).toBeNull();
      expect(result.focusChanged).toBe(false);
    });
  });
});
