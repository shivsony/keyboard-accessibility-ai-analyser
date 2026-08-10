/**
 * Functions that run **inside the page under test**.
 *
 * Two rules govern this file:
 *
 * 1. **First-party code only.** These are function references handed to
 *    `page.evaluate`, never strings, and never anything derived from model
 *    output. Nothing the AI produces can reach this file
 *    (ARCHITECTURE.md invariant 2).
 * 2. **Self-contained.** Each function is serialized and re-parsed in the page,
 *    so it cannot close over imports or module scope. Helpers are nested
 *    deliberately, not by accident — hoisting one out would break it at
 *    runtime, not compile time.
 *
 * Everything returned here is plain, structured-cloneable data written by an
 * untrusted page. The Node side brands and validates it; this side only reads.
 */

export type RawBoundingBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type RawElement = {
  /** A CSS path, used as both stable identity and human-readable evidence. */
  path: string;
  tagName: string;
  role: string | null;
  accessibleName: string | null;
  tabIndex: number | null;
  disabled: boolean;
  visible: boolean;
  boundingBox: RawBoundingBox | null;
  via: "NATIVE_CONTROL" | "TABINDEX" | "ARIA_ROLE";
};

export type RawFocus =
  { kind: "ELEMENT"; element: RawElement } | { kind: "BODY" } | { kind: "OUTSIDE_PAGE" };

export type RawDomSummary = {
  summary: string;
  nodeCount: number;
  truncated: boolean;
};

/**
 * Collects every element a keyboard user could plausibly reach.
 *
 * Over-collecting is the safer error: an element listed here but never focused
 * becomes a candidate UNREACHABLE_ELEMENT, which a human reviews.
 * An element missed here is invisible to the whole audit.
 */
export function collectInteractiveElements(limit: number): RawElement[] {
  const NATIVE =
    'a[href], button, input:not([type="hidden"]), select, textarea, summary, ' +
    '[contenteditable=""], [contenteditable="true"], audio[controls], video[controls]';

  const INTERACTIVE_ROLES = [
    "button",
    "link",
    "checkbox",
    "radio",
    "menuitem",
    "menuitemcheckbox",
    "menuitemradio",
    "option",
    "switch",
    "tab",
    "textbox",
    "combobox",
    "searchbox",
    "slider",
    "spinbutton",
    "treeitem",
  ];

  function cssPath(element: Element): string {
    const parts: string[] = [];
    let node: Element | null = element;

    while (node !== null && node !== document.documentElement) {
      const parent: Element | null = node.parentElement;
      if (parent === null) break;
      const index = Array.prototype.indexOf.call(parent.children, node) + 1;
      parts.unshift(`${node.tagName.toLowerCase()}:nth-child(${index})`);
      node = parent;
    }

    return ["html", ...parts].join(" > ");
  }

  function isVisible(element: Element): boolean {
    const style = window.getComputedStyle(element);
    if (style.visibility === "hidden" || style.display === "none") return false;
    if (style.opacity !== "" && Number(style.opacity) === 0) return false;
    if (element.hasAttribute("hidden")) return false;
    if (element.getAttribute("aria-hidden") === "true") return false;

    const rect = element.getBoundingClientRect();
    return rect.width > 0 || rect.height > 0;
  }

  function isDisabled(element: Element): boolean {
    if (element.getAttribute("aria-disabled") === "true") return true;
    return "disabled" in element && element.disabled === true;
  }

  /**
   * An approximation of the accessible name, good enough for evidence and for
   * the model to reason about. The ARIA snapshot is the authoritative view;
   * this exists so an element record is readable on its own.
   */
  function accessibleName(element: Element): string | null {
    const label = element.getAttribute("aria-label");
    if (label !== null && label.trim() !== "") return label.trim();

    const labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy !== null) {
      const text = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? "")
        .join(" ")
        .trim();
      if (text !== "") return text;
    }

    const id = element.getAttribute("id");
    if (id !== null && id !== "") {
      const associated = document.querySelector(`label[for="${CSS.escape(id)}"]`);
      const text = associated?.textContent?.trim();
      if (text !== undefined && text !== "") return text;
    }

    for (const attribute of ["alt", "title", "placeholder", "value"]) {
      const value = element.getAttribute(attribute);
      if (value !== null && value.trim() !== "") return value.trim();
    }

    const text = element.textContent?.trim() ?? "";
    if (text !== "") return text.slice(0, 120);

    return null;
  }

  function tabIndexOf(element: Element): number | null {
    const raw = element.getAttribute("tabindex");
    if (raw === null) return null;
    const parsed = Number.parseInt(raw, 10);
    return Number.isNaN(parsed) ? null : parsed;
  }

  function classify(element: Element): RawElement["via"] | null {
    if (element.matches(NATIVE)) return "NATIVE_CONTROL";

    const role = element.getAttribute("role");
    if (role !== null && INTERACTIVE_ROLES.includes(role)) return "ARIA_ROLE";

    const tabIndex = tabIndexOf(element);
    if (tabIndex !== null && tabIndex >= 0) return "TABINDEX";

    return null;
  }

  function describe(element: Element, via: RawElement["via"]): RawElement {
    const rect = element.getBoundingClientRect();

    return {
      path: cssPath(element),
      tagName: element.tagName.toLowerCase(),
      role: element.getAttribute("role"),
      accessibleName: accessibleName(element),
      tabIndex: tabIndexOf(element),
      disabled: isDisabled(element),
      visible: isVisible(element),
      boundingBox: {
        x: rect.x + window.scrollX,
        y: rect.y + window.scrollY,
        width: rect.width,
        height: rect.height,
      },
      via,
    };
  }

  const found: RawElement[] = [];

  for (const element of Array.from(document.querySelectorAll("*"))) {
    if (found.length >= limit) break;
    const via = classify(element);
    if (via !== null) found.push(describe(element, via));
  }

  return found;
}

/**
 * Where focus is right now.
 *
 * `document.hasFocus()` is the signal that separates "focus went to the
 * document body" from "focus left for the browser's own UI" — the second is
 * UNEXPECTED_FOCUS_LEAVING_PAGE and the first usually is not. From inside the
 * page both otherwise look like `activeElement === body`.
 */
export function readFocus(): RawFocus {
  function cssPath(element: Element): string {
    const parts: string[] = [];
    let node: Element | null = element;

    while (node !== null && node !== document.documentElement) {
      const parent: Element | null = node.parentElement;
      if (parent === null) break;
      const index = Array.prototype.indexOf.call(parent.children, node) + 1;
      parts.unshift(`${node.tagName.toLowerCase()}:nth-child(${index})`);
      node = parent;
    }

    return ["html", ...parts].join(" > ");
  }

  const active = document.activeElement;

  if (!document.hasFocus()) return { kind: "OUTSIDE_PAGE" };
  if (active === null || active === document.body) return { kind: "BODY" };

  const rect = active.getBoundingClientRect();
  const style = window.getComputedStyle(active);
  const tabIndexAttribute = active.getAttribute("tabindex");
  const parsedTabIndex =
    tabIndexAttribute === null ? null : Number.parseInt(tabIndexAttribute, 10);

  const text = active.getAttribute("aria-label") ?? active.textContent?.trim() ?? "";

  return {
    kind: "ELEMENT",
    element: {
      path: cssPath(active),
      tagName: active.tagName.toLowerCase(),
      role: active.getAttribute("role"),
      accessibleName: text === "" ? null : text.slice(0, 120),
      tabIndex:
        parsedTabIndex !== null && Number.isNaN(parsedTabIndex) ? null : parsedTabIndex,
      disabled:
        active.getAttribute("aria-disabled") === "true" ||
        ("disabled" in active && active.disabled === true),
      visible: style.visibility !== "hidden" && style.display !== "none",
      boundingBox: {
        x: rect.x + window.scrollX,
        y: rect.y + window.scrollY,
        width: rect.width,
        height: rect.height,
      },
      // Focus landing somewhere discovery did not predict is itself
      // informative, so it is recorded rather than reclassified.
      via: "NATIVE_CONTROL",
    },
  };
}

/**
 * A bounded structural digest of the DOM.
 *
 * Deliberately not the full document: the summary is sent to a model and stored
 * as evidence, and an unbounded page would blow up both. Truncation is reported
 * rather than hidden, because a finding built on a silently truncated view is
 * not reproducible.
 */
export function summarizeDom(limit: number): RawDomSummary {
  const lines: string[] = [];
  let visited = 0;
  let truncated = false;

  function walk(element: Element, depth: number): void {
    visited += 1;

    if (lines.length >= limit) {
      truncated = true;
      return;
    }

    const attributes: string[] = [];
    const id = element.getAttribute("id");
    const role = element.getAttribute("role");
    const label = element.getAttribute("aria-label");
    const tabindex = element.getAttribute("tabindex");
    const href = element.getAttribute("href");

    if (id !== null) attributes.push(`#${id}`);
    if (role !== null) attributes.push(`role=${role}`);
    if (label !== null) attributes.push(`aria-label=${JSON.stringify(label)}`);
    if (tabindex !== null) attributes.push(`tabindex=${tabindex}`);
    if (href !== null) attributes.push(`href=${JSON.stringify(href.slice(0, 80))}`);
    if ("disabled" in element && element.disabled === true) attributes.push("disabled");

    const ownText = Array.from(element.childNodes)
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent ?? "")
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();

    const suffix = ownText === "" ? "" : ` "${ownText.slice(0, 60)}"`;

    lines.push(
      `${"  ".repeat(depth)}<${element.tagName.toLowerCase()}${
        attributes.length > 0 ? ` ${attributes.join(" ")}` : ""
      }>${suffix}`,
    );

    for (const child of Array.from(element.children)) {
      walk(child, depth + 1);
    }
  }

  const root = document.body ?? document.documentElement;
  if (root !== null) walk(root, 0);

  return { summary: lines.join("\n"), nodeCount: visited, truncated };
}
