import { z } from "zod";

import { BoundingBoxSchema, ElementIdSchema, StepIndexSchema } from "./primitives";

/** Frame containing the element. Selectors are scoped to this frame. */
export const FrameInfoSchema = z.object({
  url: z.string(),
  name: z.string().nullable(),
  isMainFrame: z.boolean(),
});
export type FrameInfo = z.infer<typeof FrameInfoSchema>;

/** Why the element was treated as interactive. Useful when a finding is disputed. */
export const ElementDiscoverySourceSchema = z.enum([
  /** button, a[href], input, select, textarea, summary, … */
  "NATIVE_CONTROL",
  /** Explicit `tabindex >= 0` on a non-native element. */
  "TABINDEX",
  /** An interactive ARIA role (button, link, menuitem, tab, …). */
  "ARIA_ROLE",
  /** Focus was observed on it even though discovery did not predict it. */
  "OBSERVED_FOCUS",
]);
export type ElementDiscoverySource = z.infer<typeof ElementDiscoverySourceSchema>;

/**
 * An interactive control on the page.
 *
 * `selector` is evidence and identity only. It is never used to drive an
 * action: the agent acts with the keyboard, never by targeting an element
 * (ARCHITECTURE.md invariant 2).
 *
 * Reachability deliberately lives on `AgentState.visitedElementIds` rather than
 * on this record, so there is exactly one source of truth for "did the keyboard
 * ever get here".
 */
export const InteractiveElementSchema = z.object({
  id: ElementIdSchema,
  tagName: z.string().min(1),
  role: z.string().nullable(),
  accessibleName: z.string().nullable(),
  selector: z.string().min(1),
  /** The frame in which `selector` is meaningful. */
  frame: FrameInfoSchema,
  tabIndex: z.number().int().nullable(),
  disabled: z.boolean(),
  visible: z.boolean(),
  boundingBox: BoundingBoxSchema.nullable(),
  discoveredVia: ElementDiscoverySourceSchema,
  discoveredAtStep: StepIndexSchema,
});
export type InteractiveElement = z.infer<typeof InteractiveElementSchema>;

/**
 * Where focus currently is.
 *
 * A discriminated union rather than `element | null`, because "focus is on
 * nothing" has three distinct meanings and only one of them is a finding:
 *
 * - `BODY` — focus reset to the document. Normal at the start of a traversal,
 *   suspicious in the middle of one.
 * - `OUTSIDE_PAGE` — focus left the document for browser chrome. This is the
 *   signal behind UNEXPECTED_FOCUS_LEAVING_PAGE.
 * - `UNKNOWN` — not observed yet. Never evidence of anything.
 */
export const FocusStateSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("ELEMENT"),
    element: InteractiveElementSchema,
  }),
  z.object({ kind: z.literal("BODY") }),
  z.object({ kind: z.literal("OUTSIDE_PAGE") }),
  z.object({ kind: z.literal("UNKNOWN") }),
]);
export type FocusState = z.infer<typeof FocusStateSchema>;

export const FOCUS_UNKNOWN: FocusState = Object.freeze({ kind: "UNKNOWN" });
export const FOCUS_BODY: FocusState = Object.freeze({ kind: "BODY" });
export const FOCUS_OUTSIDE_PAGE: FocusState = Object.freeze({ kind: "OUTSIDE_PAGE" });

export function focusOn(element: InteractiveElement): FocusState {
  return { kind: "ELEMENT", element };
}

/** The focused element, when focus is actually on one. */
export function focusedElement(focus: FocusState): InteractiveElement | null {
  return focus.kind === "ELEMENT" ? focus.element : null;
}

/**
 * Whether two focus states are the same position.
 *
 * Identity, not deep equality: the same element re-observed carries a fresh
 * bounding box and a later `discoveredAtStep`, and neither means focus moved.
 * Comparing whole records would report a change on every keypress.
 */
export function isSameFocus(a: FocusState, b: FocusState): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "ELEMENT" && b.kind === "ELEMENT") return a.element.id === b.element.id;
  return true;
}
