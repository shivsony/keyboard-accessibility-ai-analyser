import { z } from "zod";

import { StepIndexSchema, TimestampSchema } from "./primitives";

/**
 * The keyboard allowlist.
 *
 * This is the security boundary of the whole system, expressed as a type. The
 * AI can name an action; it cannot invent one. Anything outside this frozen set
 * fails validation before it reaches the browser (SECURITY.md §2).
 *
 * Adding a member is a security change, not a feature. Enter, Space, Escape,
 * and the arrow keys are excluded for capability reasons as much as scope
 * reasons: they submit forms, follow links, and open dialogs on a page we do
 * not trust.
 */
export const KEYBOARD_ACTIONS = Object.freeze(["TAB", "SHIFT_TAB"] as const);

export const KeyboardActionSchema = z.enum(KEYBOARD_ACTIONS);
export type KeyboardAction = z.infer<typeof KeyboardActionSchema>;

/**
 * Narrowing guard for untrusted input.
 *
 * Exact membership in the frozen set — not a prefix test, not a case-insensitive
 * match over a wider space.
 */
export function isKeyboardAction(value: unknown): value is KeyboardAction {
  return (
    typeof value === "string" && (KEYBOARD_ACTIONS as readonly string[]).includes(value)
  );
}

/** One executed keypress, in order. This is the reproduction record. */
export const KeyboardActionRecordSchema = z.object({
  step: StepIndexSchema,
  action: KeyboardActionSchema,
  at: TimestampSchema,
});
export type KeyboardActionRecord = z.infer<typeof KeyboardActionRecordSchema>;
