import "server-only";

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

import {
  elementId,
  UrlSchema,
  type AccessibilityNode,
  type AccessibilitySnapshot,
  type DOMSnapshot,
  type FocusState,
  type InteractiveElement,
  type KeyboardAction,
  type StepIndex,
  type Url,
  type Viewport,
} from "@/lib/shared/domain";

import { Deadline, withTimeout } from "./deadline";
import { BrowserCleanupError, BrowserLayerError, isTimeoutLike } from "./errors";
import { keyForAction } from "./keys";
import {
  collectInteractiveElements,
  readFocus,
  summarizeDom,
  type RawElement,
} from "./page-scripts";
import type {
  BrowserController,
  BrowserSessionOptions,
  PageController,
  ScreenshotCapture,
} from "./types";

const now = (): string => new Date().toISOString();

/**
 * A node from Chrome DevTools Protocol's `Accessibility.getFullAXTree`.
 *
 * Playwright removed `page.accessibility` in 1.55, and `ariaSnapshot()` returns
 * YAML rather than a tree. CDP gives the same data the old API exposed, in the
 * shape the domain model already uses. Chromium-only is not a constraint here —
 * this layer launches Chromium.
 */
type CdpAxNode = {
  nodeId: string;
  ignored?: boolean;
  role?: { value?: string };
  name?: { value?: string };
  value?: { value?: string | number };
  properties?: { name: string; value?: { value?: unknown } }[];
  childIds?: string[];
};

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

class PlaywrightPageController implements PageController {
  #page: Page;
  #options: BrowserSessionOptions;
  #deadline: Deadline;
  #crashed = false;
  #closed = false;

  constructor(page: Page, options: BrowserSessionOptions, deadline: Deadline) {
    this.#page = page;
    this.#options = options;
    this.#deadline = deadline;

    // A crashed renderer answers no further calls. Recording it here turns
    // every later operation into a clear error instead of a hang.
    page.on("crash", () => {
      this.#crashed = true;
    });
    page.on("close", () => {
      this.#closed = true;
    });
  }

  get isUsable(): boolean {
    return !this.#crashed && !this.#closed && !this.#page.isClosed();
  }

  currentUrl(): Url {
    const parsed = UrlSchema.safeParse(this.#page.url());
    if (!parsed.success) {
      throw new BrowserLayerError(
        "NAVIGATION_FAILED",
        `Page is at a non-http(s) URL: ${this.#page.url()}`,
      );
    }
    return parsed.data;
  }

  async navigate(url: Url): Promise<void> {
    this.#assertUsable();

    const timeout = this.#deadline.clamp(this.#options.navigationTimeoutMs);
    if (timeout <= 0) {
      throw new BrowserLayerError("AUDIT_TIMEOUT", "No time left to navigate");
    }

    try {
      const response = await this.#page.goto(url, {
        timeout,
        waitUntil: "domcontentloaded",
      });

      // A null response means a same-document navigation, which is fine. An
      // error status is not: auditing a 404 page produces findings about the
      // 404 page.
      if (response !== null && !response.ok()) {
        throw new BrowserLayerError(
          "NAVIGATION_FAILED",
          `Navigation to ${url} returned HTTP ${response.status()}`,
        );
      }
    } catch (error) {
      if (error instanceof BrowserLayerError) throw error;

      throw new BrowserLayerError(
        isTimeoutLike(error) ? "NAVIGATION_TIMEOUT" : "NAVIGATION_FAILED",
        `Navigation to ${url} failed`,
        { cause: error },
      );
    }
  }

  async press(action: KeyboardAction): Promise<void> {
    this.#assertUsable();

    // Re-validated here even though the guard already ran, so that the only
    // path to the keyboard is one that checks the allowlist.
    const key = keyForAction(action);

    await this.#run(
      this.#page.keyboard.press(key),
      `press ${action}`,
      this.#options.navigationTimeoutMs,
    );
  }

  async screenshot(): Promise<ScreenshotCapture> {
    this.#assertUsable();

    const png = await this.#run(
      this.#page.screenshot({ type: "png", timeout: this.#screenshotTimeout() }),
      "screenshot",
      this.#options.navigationTimeoutMs,
    );

    return {
      png: new Uint8Array(png),
      viewport: this.#options.viewport,
      capturedAt: now(),
    };
  }

  async captureDom(): Promise<DOMSnapshot> {
    this.#assertUsable();

    const raw = await this.#run(
      this.#page.evaluate(summarizeDom, this.#options.maxDomLines),
      "summarize the DOM",
      this.#options.navigationTimeoutMs,
    );

    return {
      summary: raw.summary,
      nodeCount: raw.nodeCount,
      truncated: raw.truncated,
      capturedAt: now(),
    };
  }

  async captureAccessibility(): Promise<AccessibilitySnapshot> {
    this.#assertUsable();

    const session = await this.#run(
      this.#page.context().newCDPSession(this.#page),
      "open a CDP session",
      this.#options.navigationTimeoutMs,
    );

    try {
      await this.#run(
        session.send("Accessibility.enable"),
        "enable the accessibility tree",
        this.#options.navigationTimeoutMs,
      );

      const response = (await this.#run(
        session.send("Accessibility.getFullAXTree"),
        "read the accessibility tree",
        this.#options.navigationTimeoutMs,
      )) as unknown as { nodes?: CdpAxNode[] };

      return buildAccessibilitySnapshot(response.nodes ?? []);
    } finally {
      // Detaching is best-effort: the session dies with the page anyway, and a
      // failure here must not mask a real observation error.
      await session.detach().catch(() => undefined);
    }
  }

  async captureFocus(atStep: StepIndex): Promise<FocusState> {
    this.#assertUsable();

    const raw = await this.#run(
      this.#page.evaluate(readFocus),
      "read focus",
      this.#options.navigationTimeoutMs,
    );

    if (raw.kind === "BODY") return { kind: "BODY" };
    if (raw.kind === "OUTSIDE_PAGE") return { kind: "OUTSIDE_PAGE" };

    return { kind: "ELEMENT", element: toInteractiveElement(raw.element, atStep) };
  }

  async captureInteractiveElements(
    atStep: StepIndex,
  ): Promise<readonly InteractiveElement[]> {
    this.#assertUsable();

    const raw = await this.#run(
      this.#page.evaluate(collectInteractiveElements, this.#options.maxElements),
      "collect interactive elements",
      this.#options.navigationTimeoutMs,
    );

    return raw.map((element) => toInteractiveElement(element, atStep));
  }

  #screenshotTimeout(): number {
    return Math.max(1, this.#deadline.clamp(this.#options.navigationTimeoutMs));
  }

  #assertUsable(): void {
    if (this.#options.signal?.aborted === true) {
      throw new BrowserLayerError("CANCELLED", "The audit was cancelled");
    }
    if (this.#crashed) {
      throw new BrowserLayerError("PAGE_CRASHED", "The page crashed");
    }
    if (this.#closed || this.#page.isClosed()) {
      throw new BrowserLayerError("SESSION_CLOSED", "The page is closed");
    }
    this.#deadline.assertNotExpired();
  }

  /**
   * Runs a Playwright call under the audit deadline.
   *
   * Playwright times out most operations on its own, but not against a budget
   * that spans the whole run — that clamping happens here.
   */
  async #run<T>(operation: Promise<T>, label: string, timeoutMs: number): Promise<T> {
    const budget = this.#deadline.clamp(timeoutMs);

    try {
      return await withTimeout(
        operation,
        budget,
        () =>
          new BrowserLayerError(
            this.#deadline.hasExpired() ? "AUDIT_TIMEOUT" : "NAVIGATION_TIMEOUT",
            `Timed out while trying to ${label}`,
          ),
      );
    } catch (error) {
      if (error instanceof BrowserLayerError) throw error;
      if (this.#crashed) {
        throw new BrowserLayerError("PAGE_CRASHED", `The page crashed during ${label}`, {
          cause: error,
        });
      }
      throw new BrowserLayerError("EVALUATION_FAILED", `Failed to ${label}`, {
        cause: error,
      });
    }
  }
}

/**
 * Rebuilds the CDP flat node list into the domain's accessibility tree.
 *
 * CDP returns nodes plus `childIds`, so the tree is reassembled here. The
 * `visited` set is not defensive tidiness: a malformed or cyclic tree from a
 * hostile page would otherwise recurse until the stack gives out.
 */
function buildAccessibilitySnapshot(nodes: readonly CdpAxNode[]): AccessibilitySnapshot {
  const byId = new Map<string, CdpAxNode>();
  for (const node of nodes) byId.set(node.nodeId, node);

  let nodeCount = 0;
  const visited = new Set<string>();

  const propertyOf = (node: CdpAxNode, name: string): boolean =>
    node.properties?.some(
      (property) => property.name === name && property.value?.value === true,
    ) === true;

  const convert = (node: CdpAxNode): AccessibilityNode => {
    nodeCount += 1;
    visited.add(node.nodeId);

    const children: AccessibilityNode[] = [];
    for (const childId of node.childIds ?? []) {
      if (visited.has(childId)) continue;
      const child = byId.get(childId);
      if (child !== undefined) children.push(convert(child));
    }

    const name = node.name?.value;
    const value = node.value?.value;

    return {
      role: node.role?.value ?? "unknown",
      name: name === undefined || name === "" ? null : name,
      value: value === undefined ? null : String(value),
      focused: propertyOf(node, "focused"),
      disabled: propertyOf(node, "disabled"),
      children,
    };
  };

  const first = nodes[0];
  const root = first === undefined ? null : convert(first);

  return { root, nodeCount, truncated: false, capturedAt: now() };
}

function toInteractiveElement(raw: RawElement, atStep: StepIndex): InteractiveElement {
  return {
    id: elementId(raw.path),
    tagName: raw.tagName,
    role: raw.role,
    accessibleName: raw.accessibleName,
    selector: raw.path,
    tabIndex: raw.tabIndex,
    disabled: raw.disabled,
    visible: raw.visible,
    boundingBox: raw.boundingBox,
    discoveredVia: raw.via,
    discoveredAtStep: atStep,
  };
}

// ---------------------------------------------------------------------------
// Browser
// ---------------------------------------------------------------------------

export class PlaywrightBrowserController implements BrowserController {
  #options: BrowserSessionOptions;
  #deadline: Deadline;

  #browser: Browser | null = null;
  #context: BrowserContext | null = null;
  #page: Page | null = null;

  #closed = false;
  #closing: Promise<void> | null = null;
  #onAbort: (() => void) | null = null;

  constructor(options: BrowserSessionOptions) {
    this.#options = options;
    this.#deadline = Deadline.in(options.auditTimeoutMs);

    // Cancellation tears the session down rather than waiting for the current
    // operation to notice. A cancelled audit should not leave a browser running.
    if (options.signal !== null) {
      const onAbort = (): void => {
        void this.close();
      };
      this.#onAbort = onAbort;
      options.signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  get viewport(): Viewport {
    return this.#options.viewport;
  }

  get isClosed(): boolean {
    return this.#closed;
  }

  async open(url: Url): Promise<PageController> {
    if (this.#closed) {
      throw new BrowserLayerError("SESSION_CLOSED", "This session is already closed");
    }
    if (this.#options.signal?.aborted === true) {
      throw new BrowserLayerError("CANCELLED", "The audit was cancelled");
    }
    this.#deadline.assertNotExpired();

    try {
      this.#browser = await chromium.launch({ headless: this.#options.headless });
    } catch (error) {
      throw new BrowserLayerError("LAUNCH_FAILED", "Could not launch Chromium", {
        cause: error,
      });
    }

    try {
      // A fresh context every run: no shared profile, no cookies, no storage,
      // nothing carried in from the user's real browser (SECURITY.md §5).
      this.#context = await this.#browser.newContext({
        viewport: {
          width: this.#options.viewport.width,
          height: this.#options.viewport.height,
        },
        deviceScaleFactor: this.#options.viewport.deviceScaleFactor,
        acceptDownloads: false,
        bypassCSP: false,
      });

      this.#context.setDefaultTimeout(this.#options.navigationTimeoutMs);
      this.#context.setDefaultNavigationTimeout(this.#options.navigationTimeoutMs);

      this.#page = await this.#context.newPage();
    } catch (error) {
      // Half-built sessions still own a browser process. Tear it down before
      // the error propagates, or the failure leaks a Chromium.
      await this.close();
      throw new BrowserLayerError("LAUNCH_FAILED", "Could not create a browser context", {
        cause: error,
      });
    }

    const controller = new PlaywrightPageController(
      this.#page,
      this.#options,
      this.#deadline,
    );

    try {
      await controller.navigate(url);
    } catch (error) {
      await this.close();
      throw error;
    }

    return controller;
  }

  /**
   * Closes everything, in order, whatever state the session is in.
   *
   * Every resource is attempted even when an earlier close throws — a crashed
   * page must not prevent the browser process from being killed. Idempotent and
   * concurrency-safe, because cancellation and normal teardown routinely race.
   */
  async close(): Promise<void> {
    if (this.#closing !== null) return this.#closing;

    this.#closing = (async () => {
      const failures: unknown[] = [];

      const attempt = async (
        label: string,
        action: () => Promise<void>,
      ): Promise<void> => {
        try {
          await action();
        } catch (error) {
          failures.push(new Error(`Failed to close ${label}`, { cause: error }));
        }
      };

      const page = this.#page;
      const context = this.#context;
      const browser = this.#browser;

      this.#page = null;
      this.#context = null;
      this.#browser = null;

      if (page !== null && !page.isClosed()) {
        await attempt("page", () => page.close({ runBeforeUnload: false }));
      }
      if (context !== null) {
        await attempt("context", () => context.close());
      }
      if (browser !== null && browser.isConnected()) {
        await attempt("browser", () => browser.close());
      }

      if (this.#onAbort !== null && this.#options.signal !== null) {
        this.#options.signal.removeEventListener("abort", this.#onAbort);
        this.#onAbort = null;
      }

      this.#closed = true;

      if (failures.length > 0) {
        throw new BrowserCleanupError(failures);
      }
    })();

    return this.#closing;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}

/**
 * Runs `work` against a browser session and always closes it.
 *
 * The preferred entry point. Teardown happens in a `finally`, so a throw, a
 * crash, or a cancellation all end with the browser gone — and a cleanup
 * failure never masks the original error, which is the one worth reading.
 */
export async function withBrowserSession<T>(
  options: BrowserSessionOptions,
  work: (controller: BrowserController) => Promise<T>,
): Promise<T> {
  const controller = new PlaywrightBrowserController(options);

  try {
    return await work(controller);
  } finally {
    try {
      await controller.close();
    } catch {
      // Deliberately swallowed: if `work` threw, that error is the one the
      // caller needs. Cleanup problems are already surfaced by close() when it
      // is awaited directly.
    }
  }
}
