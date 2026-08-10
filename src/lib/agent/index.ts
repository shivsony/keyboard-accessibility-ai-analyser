/**
 * The agent: the loop, its memory, and the action guard.
 *
 * The guard is exported so it can be tested and reasoned about on its own. It
 * is not optional and has no bypass — every keypress the loop makes has passed
 * through it (SECURITY.md §2).
 */

export * from "./action-guard";
export * from "./state-updates";
export {
  ExplorationAgent,
  DEFAULT_EXPLORATION_OPTIONS,
  type ExplorationDependencies,
  type ExplorationOptions,
  type ExplorationResult,
} from "./exploration-agent";
