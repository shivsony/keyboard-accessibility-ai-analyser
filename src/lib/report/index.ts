/**
 * The report.
 *
 * Built from the validated audit trace, never from raw model output. Two
 * outputs: a JSON report (the source of truth, schema-validated) and an HTML
 * view model that shapes the same data for rendering.
 *
 * No score, and no conformance claim — see the `limitations` carried in every
 * report.
 */

export * from "./report-model";
export * from "./report-generator";
