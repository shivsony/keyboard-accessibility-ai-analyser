import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  BrowserLayerError,
  DEFAULT_SESSION_OPTIONS,
  PlaywrightBrowserController,
  withBrowserSession,
  type BrowserSessionOptions,
  type PageController,
} from "@/lib/browser";
import { UrlSchema, type Url, type Viewport } from "@/lib/shared/domain";

import { startFixtureServer, type FixtureServer } from "../../fixtures/server";

/**
 * These drive a real Chromium against local fixture pages.
 *
 * Real browser, real keypresses, real focus. A faked page would happily agree
 * with whatever the implementation believes about focus order, which is the one
 * thing this layer exists to observe correctly.
 */

let server: FixtureServer;

const VIEWPORT: Viewport = { width: 1024, height: 768, deviceScaleFactor: 1 };

function options(overrides: Partial<BrowserSessionOptions> = {}): BrowserSessionOptions {
  return {
    ...DEFAULT_SESSION_OPTIONS,
    headless: true,
    viewport: VIEWPORT,
    signal: null,
    ...overrides,
  };
}

function url(page: string): Url {
  return UrlSchema.parse(server.url(page));
}

beforeAll(async () => {
  server = await startFixtureServer();
}, 30_000);

afterAll(async () => {
  await server.close();
});

describe("navigation and lifecycle", () => {
  it("opens a page and reports where it landed", async () => {
    await withBrowserSession(options(), async (browser) => {
      const page = await browser.open(url("well-behaved.html"));

      expect(page.currentUrl()).toBe(server.url("well-behaved.html"));
      expect(page.isUsable).toBe(true);
      expect(browser.isClosed).toBe(false);
    });
  }, 60_000);

  it("closes everything when the work finishes", async () => {
    const browser = new PlaywrightBrowserController(options());

    await browser.open(url("well-behaved.html"));
    await browser.close();

    expect(browser.isClosed).toBe(true);
  }, 60_000);

  it("is idempotent on close", async () => {
    const browser = new PlaywrightBrowserController(options());
    await browser.open(url("well-behaved.html"));

    await browser.close();
    await expect(browser.close()).resolves.toBeUndefined();
    await expect(browser.close()).resolves.toBeUndefined();
  }, 60_000);

  it("closes safely even if nothing was ever opened", async () => {
    const browser = new PlaywrightBrowserController(options());

    await expect(browser.close()).resolves.toBeUndefined();
    expect(browser.isClosed).toBe(true);
  });

  it("refuses to open a closed session", async () => {
    const browser = new PlaywrightBrowserController(options());
    await browser.close();

    await expect(browser.open(url("well-behaved.html"))).rejects.toMatchObject({
      code: "SESSION_CLOSED",
    });
  });

  it("supports await-using disposal", async () => {
    let captured: PlaywrightBrowserController | null = null;

    {
      await using browser = new PlaywrightBrowserController(options());
      captured = browser;
      await browser.open(url("well-behaved.html"));
      expect(browser.isClosed).toBe(false);
    }

    expect(captured.isClosed).toBe(true);
  }, 60_000);
});

describe("navigation failures", () => {
  // A failed open must not leave a Chromium running. This is the leak that
  // shows up as a machine full of orphaned browsers a week later.
  it("tears the session down when navigation fails", async () => {
    const browser = new PlaywrightBrowserController(options());

    await expect(browser.open(url("does-not-exist.html"))).rejects.toMatchObject({
      code: "NAVIGATION_FAILED",
    });
    expect(browser.isClosed).toBe(true);
  }, 60_000);

  // Auditing an error page produces findings about the error page.
  it("rejects a server error response", async () => {
    const browser = new PlaywrightBrowserController(options());

    await expect(browser.open(url("boom"))).rejects.toMatchObject({
      code: "NAVIGATION_FAILED",
    });
    expect(browser.isClosed).toBe(true);
  }, 60_000);

  it("enforces the navigation timeout", async () => {
    const browser = new PlaywrightBrowserController(
      options({ navigationTimeoutMs: 1_000 }),
    );

    await expect(browser.open(url("slow"))).rejects.toMatchObject({
      code: "NAVIGATION_TIMEOUT",
    });
    expect(browser.isClosed).toBe(true);
  }, 60_000);

  it("rejects a URL that is not http(s)", () => {
    expect(UrlSchema.safeParse("file:///etc/passwd").success).toBe(false);
  });
});

describe("audit timeout", () => {
  // The ceiling on the whole run, independent of any single operation.
  it("refuses to start once the budget is spent", async () => {
    const browser = new PlaywrightBrowserController(options({ auditTimeoutMs: 1 }));

    await new Promise((resolve) => setTimeout(resolve, 10));

    await expect(browser.open(url("well-behaved.html"))).rejects.toMatchObject({
      code: "AUDIT_TIMEOUT",
    });

    await browser.close();
  }, 60_000);

  it("stops mid-session when the budget runs out", async () => {
    const browser = new PlaywrightBrowserController(options({ auditTimeoutMs: 3_000 }));

    try {
      const page = await browser.open(url("well-behaved.html"));
      await page.press("TAB");

      await new Promise((resolve) => setTimeout(resolve, 3_100));

      await expect(page.press("TAB")).rejects.toMatchObject({ code: "AUDIT_TIMEOUT" });
    } finally {
      await browser.close();
    }
  }, 60_000);
});

describe("cancellation", () => {
  it("closes the browser when the audit is aborted", async () => {
    const controller = new AbortController();
    const browser = new PlaywrightBrowserController(
      options({ signal: controller.signal }),
    );

    const page = await browser.open(url("well-behaved.html"));
    controller.abort();

    // Teardown is kicked off by the abort itself rather than waiting for the
    // next operation to notice.
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(browser.isClosed).toBe(true);
    await expect(page.press("TAB")).rejects.toMatchObject({ code: "CANCELLED" });
  }, 60_000);

  it("refuses to open when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const browser = new PlaywrightBrowserController(
      options({ signal: controller.signal }),
    );

    await expect(browser.open(url("well-behaved.html"))).rejects.toMatchObject({
      code: "CANCELLED",
    });
  });
});

describe("keyboard input", () => {
  it("moves focus forward with TAB and back with SHIFT_TAB", async () => {
    await withBrowserSession(options(), async (browser) => {
      const page = await browser.open(url("well-behaved.html"));

      await page.press("TAB");
      const first = await page.captureFocus(0);
      expect(first.kind).toBe("ELEMENT");
      if (first.kind === "ELEMENT") expect(first.element.tagName).toBe("button");

      await page.press("TAB");
      const second = await page.captureFocus(1);
      if (second.kind === "ELEMENT") expect(second.element.tagName).toBe("a");

      await page.press("SHIFT_TAB");
      const back = await page.captureFocus(2);
      if (back.kind === "ELEMENT") expect(back.element.tagName).toBe("button");
    });
  }, 60_000);

  // The type system blocks this at compile time; this proves the runtime check
  // behind it is real and not merely declared.
  it("refuses a key outside the allowlist at runtime", async () => {
    await withBrowserSession(options(), async (browser) => {
      const page = await browser.open(url("well-behaved.html"));

      await expect(page.press("ENTER" as never)).rejects.toMatchObject({
        code: "ACTION_NOT_ALLOWLISTED",
      });
    });
  }, 60_000);

  it("exposes no way to click, type, or evaluate arbitrary code", async () => {
    await withBrowserSession(options(), async (browser) => {
      const page: PageController = await browser.open(url("well-behaved.html"));
      const surface = page as unknown as Record<string, unknown>;

      for (const forbidden of ["evaluate", "click", "type", "fill", "goto", "$", "$$"]) {
        expect(typeof surface[forbidden]).not.toBe("function");
      }
    });
  }, 60_000);
});

describe("observation", () => {
  it("discovers the interactive elements on a page", async () => {
    await withBrowserSession(options(), async (browser) => {
      const page = await browser.open(url("well-behaved.html"));
      const elements = await page.captureInteractiveElements(0);

      const tags = elements.map((element) => element.tagName).sort();
      expect(tags).toEqual(["a", "button", "input"]);

      expect(elements.every((element) => element.discoveredAtStep === 0)).toBe(true);
      expect(elements.every((element) => element.visible)).toBe(true);
      expect(elements.map((element) => element.id)).toEqual(
        elements.map((element) => element.selector),
      );
    });
  }, 60_000);

  it("gives each element a stable identity across observations", async () => {
    await withBrowserSession(options(), async (browser) => {
      const page = await browser.open(url("well-behaved.html"));

      const first = await page.captureInteractiveElements(0);
      await page.press("TAB");
      const second = await page.captureInteractiveElements(1);

      expect(second.map((e) => e.id)).toEqual(first.map((e) => e.id));
    });
  }, 60_000);

  // The control a mouse user can click and a keyboard user cannot reach. It has
  // to be discovered, or the audit has nothing to report it against.
  it("discovers a role=button div that the keyboard cannot reach", async () => {
    await withBrowserSession(options(), async (browser) => {
      const page = await browser.open(url("unreachable-control.html"));
      const elements = await page.captureInteractiveElements(0);

      const fake = elements.find((element) => element.role === "button");
      expect(fake).toBeDefined();
      expect(fake?.tagName).toBe("div");
      expect(fake?.discoveredVia).toBe("ARIA_ROLE");
      expect(fake?.tabIndex).toBeNull();

      // Confirm the premise of the fixture: tabbing never lands on it.
      const reached: string[] = [];
      for (let index = 0; index < 6; index += 1) {
        await page.press("TAB");
        const focus = await page.captureFocus(index);
        if (focus.kind === "ELEMENT") reached.push(focus.element.id);
      }

      expect(reached).not.toContain(fake?.id);
    });
  }, 60_000);

  it("discovers elements made focusable with tabindex", async () => {
    await withBrowserSession(options(), async (browser) => {
      const page = await browser.open(url("tabindex-jumble.html"));
      const elements = await page.captureInteractiveElements(0);

      const div = elements.find((element) => element.tagName === "div");
      expect(div?.discoveredVia).toBe("TABINDEX");
      expect(div?.tabIndex).toBe(0);
    });
  }, 60_000);

  it("finds nothing interactive on a page with no controls", async () => {
    await withBrowserSession(options(), async (browser) => {
      const page = await browser.open(url("no-controls.html"));

      expect(await page.captureInteractiveElements(0)).toEqual([]);

      await page.press("TAB");
      const focus = await page.captureFocus(0);
      expect(focus.kind).not.toBe("ELEMENT");
    });
  }, 60_000);

  it("observes a focus trap cycling between two controls", async () => {
    await withBrowserSession(options(), async (browser) => {
      const page = await browser.open(url("focus-trap.html"));

      const visited: string[] = [];
      for (let index = 0; index < 5; index += 1) {
        await page.press("TAB");
        const focus = await page.captureFocus(index);
        if (focus.kind === "ELEMENT") visited.push(focus.element.id);
      }

      // Two distinct controls, revisited — the shape of a trap.
      expect(new Set(visited).size).toBe(2);
      expect(visited.length).toBeGreaterThan(2);
    });
  }, 60_000);

  it("captures a bounded DOM summary", async () => {
    await withBrowserSession(options(), async (browser) => {
      const page = await browser.open(url("well-behaved.html"));
      const dom = await page.captureDom();

      expect(dom.summary).toContain("button");
      expect(dom.nodeCount).toBeGreaterThan(0);
      expect(dom.truncated).toBe(false);
      expect(Date.parse(dom.capturedAt)).not.toBeNaN();
    });
  }, 60_000);

  // Truncation has to be reported, not hidden: a finding built on a silently
  // truncated view is not reproducible.
  it("reports truncation rather than hiding it", async () => {
    await withBrowserSession(options({ maxDomLines: 2 }), async (browser) => {
      const page = await browser.open(url("well-behaved.html"));
      const dom = await page.captureDom();

      expect(dom.truncated).toBe(true);
      expect(dom.summary.split("\n").length).toBeLessThanOrEqual(2);
    });
  }, 60_000);

  it("honours the element cap", async () => {
    await withBrowserSession(options({ maxElements: 1 }), async (browser) => {
      const page = await browser.open(url("well-behaved.html"));

      expect(await page.captureInteractiveElements(0)).toHaveLength(1);
    });
  }, 60_000);

  it("captures an accessibility tree with roles and names", async () => {
    await withBrowserSession(options(), async (browser) => {
      const page = await browser.open(url("well-behaved.html"));
      const aria = await page.captureAccessibility();

      expect(aria.nodeCount).toBeGreaterThan(1);
      expect(aria.snapshot).toContain('button "First"');
      expect(aria.snapshot).toMatch(/\[ref=e\d+\]/);
    });
  }, 60_000);

  it("reports the focused element in the AI-oriented ARIA snapshot", async () => {
    await withBrowserSession(options(), async (browser) => {
      const page = await browser.open(url("well-behaved.html"));
      await page.press("TAB");

      const aria = await page.captureAccessibility();
      expect(aria.snapshot).toContain('button "First"');
      expect(aria.snapshot).toContain("[active]");
    });
  }, 60_000);

  it("captures a PNG screenshot at the configured viewport", async () => {
    await withBrowserSession(options(), async (browser) => {
      const page = await browser.open(url("well-behaved.html"));
      const shot = await page.screenshot();

      expect(shot.viewport).toEqual(VIEWPORT);
      expect(shot.png.byteLength).toBeGreaterThan(0);
      // PNG magic number, so a truncated or misconfigured capture is caught.
      expect([...shot.png.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    });
  }, 60_000);

  it("captures a complete descriptive observation after every browser state", async () => {
    await withBrowserSession(options(), async (browser) => {
      const page = await browser.open(url("well-behaved.html"));
      const initial = await page.observe(0);

      expect(initial.observation.step).toBe(0);
      expect(initial.observation.url).toBe(server.url("well-behaved.html"));
      expect(initial.observation.screenshotId).toBe("observation-0");
      expect(initial.screenshot.png.byteLength).toBeGreaterThan(0);
      expect(initial.observation.dom.summary).toContain("button");
      expect(initial.observation.aria.snapshot).toMatch(/\[ref=e\d+\]/);
      expect(
        initial.observation.interactiveElements.map((element) => element.tagName).sort(),
      ).toEqual(["a", "button", "input"]);
      expect(initial.observation.viewport).toEqual(VIEWPORT);
      expect(Date.parse(initial.observation.timestamp)).not.toBeNaN();

      await page.press("TAB");
      const afterTab = await page.observe(1);
      expect(afterTab.observation.focus).toMatchObject({
        kind: "ELEMENT",
        element: {
          tagName: "button",
          accessibleName: "First",
          frame: { url: server.url("well-behaved.html"), name: null, isMainFrame: true },
        },
      });
    });
  }, 60_000);
});

describe("a page that stops responding", () => {
  // Playwright puts no timeout on page.evaluate. Against a page that has wedged
  // its own main thread, the layer's own timeout is the only thing standing
  // between an audit and an indefinite hang.
  it("times out an observation instead of hanging", async () => {
    const browser = new PlaywrightBrowserController(
      options({ navigationTimeoutMs: 1_500 }),
    );

    try {
      const page = await browser.open(url("hangs.html"));
      await new Promise((resolve) => setTimeout(resolve, 500));

      await expect(page.captureDom()).rejects.toMatchObject({
        code: "NAVIGATION_TIMEOUT",
      });
    } finally {
      await browser.close();
    }
  }, 60_000);

  // Teardown has to work on a page that cannot answer, or a single bad page
  // leaves a Chromium behind for the rest of the session.
  it("still tears down a wedged page", async () => {
    const browser = new PlaywrightBrowserController(
      options({ navigationTimeoutMs: 1_500 }),
    );

    const page = await browser.open(url("hangs.html"));
    await new Promise((resolve) => setTimeout(resolve, 500));

    await browser.close();

    expect(browser.isClosed).toBe(true);
    expect(page.isUsable).toBe(false);
  }, 60_000);
});

describe("failure after the page is gone", () => {
  it("reports a closed session rather than hanging", async () => {
    const browser = new PlaywrightBrowserController(options());
    const page = await browser.open(url("well-behaved.html"));

    await browser.close();

    expect(page.isUsable).toBe(false);
    await expect(page.press("TAB")).rejects.toMatchObject({ code: "SESSION_CLOSED" });
    await expect(page.captureDom()).rejects.toMatchObject({ code: "SESSION_CLOSED" });
    await expect(page.captureFocus(0)).rejects.toMatchObject({
      code: "SESSION_CLOSED",
    });
  }, 60_000);

  // The reason withBrowserSession exists: an exception in the work must still
  // leave the browser closed.
  it("closes the browser when the work throws", async () => {
    let observed: PlaywrightBrowserController | null = null;
    const boom = new Error("something went wrong mid-audit");

    await expect(
      withBrowserSession(options(), async (browser) => {
        observed = browser as PlaywrightBrowserController;
        await browser.open(url("well-behaved.html"));
        throw boom;
      }),
    ).rejects.toBe(boom);

    expect(observed).not.toBeNull();
    expect(observed!.isClosed).toBe(true);
  }, 60_000);

  it("surfaces the original error, not a cleanup error", async () => {
    const boom = new BrowserLayerError("EVALUATION_FAILED", "the real problem");

    await expect(
      withBrowserSession(options(), async (browser) => {
        const page = await browser.open(url("well-behaved.html"));
        await browser.close();
        void page;
        throw boom;
      }),
    ).rejects.toBe(boom);
  }, 60_000);
});
