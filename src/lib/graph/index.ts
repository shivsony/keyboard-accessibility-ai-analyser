/**
 * The navigation graph: nodes are focus positions, edges are keypresses.
 *
 * Construction lives in `navigation-graph`, reading in `analysis`. Both are
 * pure and framework-independent — no Playwright, no React, no I/O — so the
 * traversal can be rebuilt and re-analysed from a persisted run directory
 * without a browser anywhere in sight.
 */

export * from "./navigation-graph";
export * from "./analysis";
