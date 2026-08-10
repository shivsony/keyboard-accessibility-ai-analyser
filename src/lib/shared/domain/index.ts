/**
 * The domain model for the Keyboard Accessibility AI Analyzer.
 *
 * Framework-independent by rule: nothing here may import React, Next.js, or
 * Playwright. These types are the contract between the agent loop, the AI
 * client, the browser driver, and the reporter — if they depended on any one of
 * those, the others would inherit it.
 *
 * Every model is a Zod schema plus its inferred type, so the boundary where
 * untrusted input arrives (model output, a persisted run directory) validates
 * with the same definition the code is typed against.
 */

export * from "./primitives";
export * from "./keyboard";
export * from "./element";
export * from "./snapshot";
export * from "./observation";
export * from "./decision";
export * from "./finding";
export * from "./graph";
export * from "./step";
export * from "./state";
export * from "./invariants";
export * from "./audit";
