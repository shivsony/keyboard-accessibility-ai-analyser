import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  DEFAULT_SESSION_OPTIONS,
  KeyboardExecutor,
  withBrowserSession,
  type BrowserSessionOptions,
} from "@/lib/browser";
import {
  isSameFocus,
  UrlSchema,
  type FocusState,
  type Url,
  type Viewport,
} from "@/lib/shared/domain";

import { startFixtureServer, type FixtureServer } from "../../fixtures/server";

/**
 * The executor against a real Chromium.
 *
 * The unit tests prove the recording logic; these prove the recording matches
 * what a browser actually does. A fake would agree with whatever the
 * implementation believes about focus movement, which is the fact this class
 * exists to report.
 */

let server: FixtureServer;

const VIEWPORT: Viewport = { width: 1024, height: 768, deviceScaleFactor: 1 };

function options(): BrowserSessionOptions {
  return {
    ...DEFAULT_SESSION_OPTIONS,
    headless: true,
    viewport: VIEWPORT,
    signal: null,
  };
}

function url(page: string): Url {
  return UrlSchema.parse(server.url(page));
}

// A short settle keeps the suite quick; the pause itself is what is under test
// elsewhere, not its duration.
const settle = { settleMs: 20 };

/**
 * Focus positions are compared by identity, not deep equality.
 *
 * The same element observed at two different steps carries a different
 * `discoveredAtStep` and a freshly measured bounding box. Neither means focus
 * moved, which is precisely why `isSameFocus` exists — a `toEqual` here would
 * be asserting the opposite of the intended behaviour.
 */
function expectSamePosition(actual: FocusState, expected: FocusState): void {
  expect(isSameFocus(actual, expected)).toBe(true);
}

beforeAll(async () => {
  server = await startFixtureServer();
}, 30_000);

afterAll(async () => {
  await server.close();
});

describe("TAB", () => {
  it("moves focus forward and records both positions", async () => {
    await withBrowserSession(options(), async (browser) => {
      const page = await browser.open(url("well-behaved.html"));
      const executor = new KeyboardExecutor(page, settle);

      const first = await executor.execute("TAB", 0);

      if (first.outcome !== "EXECUTED") return expect.unreachable("expected EXECUTED");
      expect(first.focusChanged).toBe(true);
      expect(first.previousFocus.kind).not.toBe("ELEMENT");
      expect(first.newFocus.kind).toBe("ELEMENT");
      if (first.newFocus.kind === "ELEMENT") {
        expect(first.newFocus.element.tagName).toBe("button");
      }

      const second = await executor.execute("TAB", 1);
      if (second.outcome !== "EXECUTED") return expect.unreachable("expected EXECUTED");
      expect(second.focusChanged).toBe(true);
      if (second.newFocus.kind === "ELEMENT") {
        expect(second.newFocus.element.tagName).toBe("a");
      }

      // The previous focus of a step is the new focus of the one before it.
      expectSamePosition(second.previousFocus, first.newFocus);
    });
  }, 60_000);

  it("attaches the observation for the resulting state", async () => {
    await withBrowserSession(options(), async (browser) => {
      const page = await browser.open(url("well-behaved.html"));
      const result = await new KeyboardExecutor(page, settle).execute("TAB", 4);

      if (result.outcome !== "EXECUTED") return expect.unreachable("expected EXECUTED");
      expect(result.observation.observation.step).toBe(4);
      expectSamePosition(result.observation.observation.focus, result.newFocus);
      expect(result.observation.observation.interactiveElements.length).toBe(3);
      expect(result.observation.screenshot.png.byteLength).toBeGreaterThan(0);
    });
  }, 60_000);
});

describe("SHIFT_TAB", () => {
  it("moves focus backward", async () => {
    await withBrowserSession(options(), async (browser) => {
      const page = await browser.open(url("well-behaved.html"));
      const executor = new KeyboardExecutor(page, settle);

      await executor.execute("TAB", 0);
      const forward = await executor.execute("TAB", 1);
      const backward = await executor.execute("SHIFT_TAB", 2);

      if (forward.outcome !== "EXECUTED" || backward.outcome !== "EXECUTED") {
        return expect.unreachable("expected EXECUTED");
      }

      expect(backward.focusChanged).toBe(true);
      expectSamePosition(backward.previousFocus, forward.newFocus);
      if (backward.newFocus.kind === "ELEMENT") {
        expect(backward.newFocus.element.tagName).toBe("button");
      }
    });
  }, 60_000);

  it("returns to exactly the element it came from", async () => {
    await withBrowserSession(options(), async (browser) => {
      const page = await browser.open(url("well-behaved.html"));
      const executor = new KeyboardExecutor(page, settle);

      const first = await executor.execute("TAB", 0);
      await executor.execute("TAB", 1);
      const back = await executor.execute("SHIFT_TAB", 2);

      if (first.outcome !== "EXECUTED" || back.outcome !== "EXECUTED") {
        return expect.unreachable("expected EXECUTED");
      }
      expectSamePosition(back.newFocus, first.newFocus);
    });
  }, 60_000);
});

describe("focus unchanged", () => {
  // A page that swallows Tab. The executor reports the fact and passes no
  // judgement on it — that this is a bug is the rules layer's call.
  it("records focusChanged false when the page swallows the key", async () => {
    await withBrowserSession(options(), async (browser) => {
      const page = await browser.open(url("immobile-focus.html"));
      const executor = new KeyboardExecutor(page, settle);

      const result = await executor.execute("TAB", 0);

      if (result.outcome !== "EXECUTED") return expect.unreachable("expected EXECUTED");
      expect(result.focusChanged).toBe(false);
      expectSamePosition(result.previousFocus, result.newFocus);
      if (result.newFocus.kind === "ELEMENT") {
        expect(result.newFocus.element.accessibleName).toBe("Stuck");
      }

      // Still reported as executed: the key was pressed, and nothing moved.
      expect(result.outcome).toBe("EXECUTED");
      expect(result.error).toBeNull();
    });
  }, 60_000);

  it("keeps reporting unchanged focus on repeat presses", async () => {
    await withBrowserSession(options(), async (browser) => {
      const page = await browser.open(url("immobile-focus.html"));
      const executor = new KeyboardExecutor(page, settle);

      for (let step = 0; step < 3; step += 1) {
        const result = await executor.execute("TAB", step);
        if (result.outcome !== "EXECUTED") return expect.unreachable("expected EXECUTED");
        expect(result.focusChanged).toBe(false);
      }
    });
  }, 60_000);

  it("reports movement within a focus trap without calling it a failure", async () => {
    await withBrowserSession(options(), async (browser) => {
      const page = await browser.open(url("focus-trap.html"));
      const executor = new KeyboardExecutor(page, settle);

      const first = await executor.execute("TAB", 0);
      const second = await executor.execute("TAB", 1);

      if (first.outcome !== "EXECUTED" || second.outcome !== "EXECUTED") {
        return expect.unreachable("expected EXECUTED");
      }

      // Focus moves every press; that it moves in a two-element cycle is a
      // finding the graph and rules layers derive, not something the executor
      // decides.
      expect(first.focusChanged).toBe(true);
      expect(second.focusChanged).toBe(true);
      expectSamePosition(second.newFocus, first.previousFocus);
    });
  }, 60_000);
});

describe("unsupported actions", () => {
  it("rejects a key outside the allowlist without pressing anything", async () => {
    await withBrowserSession(options(), async (browser) => {
      const page = await browser.open(url("well-behaved.html"));
      const executor = new KeyboardExecutor(page, settle);

      const before = await page.captureFocus(0);
      const result = await executor.execute("ENTER" as never, 0);
      const after = await page.captureFocus(0);

      expect(result.outcome).toBe("REJECTED");
      if (result.outcome === "REJECTED") {
        expect(result.error.code).toBe("ACTION_NOT_ALLOWLISTED");
      }
      expectSamePosition(after, before);
    });
  }, 60_000);

  it("rejects a raw Playwright key string", async () => {
    await withBrowserSession(options(), async (browser) => {
      const page = await browser.open(url("well-behaved.html"));

      const result = await new KeyboardExecutor(page, settle).execute("Tab" as never, 0);

      expect(result.outcome).toBe("REJECTED");
    });
  }, 60_000);
});

describe("execution errors", () => {
  it("reports a closed page as a failure rather than throwing", async () => {
    const options_ = options();
    const { PlaywrightBrowserController } = await import("@/lib/browser");
    const browser = new PlaywrightBrowserController(options_);

    const page = await browser.open(url("well-behaved.html"));
    await browser.close();

    const result = await new KeyboardExecutor(page, settle).execute("TAB", 0);

    expect(result.outcome).toBe("FAILED");
    if (result.outcome === "FAILED") {
      expect(result.error.code).toBe("SESSION_CLOSED");
      expect(result.previousFocus).toBeNull();
    }
  }, 60_000);
});
