/**
 * The corroboration layer.
 *
 * `observations` reads the browser trace and reports what patterns are present.
 * `finding-validator` decides whether a model's claim about those patterns is
 * supported well enough to publish.
 *
 * The rule this module exists to enforce: **AI suspicion is not automatically a
 * reportable accessibility issue.** The trace is authoritative for every factual
 * claim; the model contributes reasoning and interpretation.
 */

export * from "./observations";
export * from "./finding-validator";
