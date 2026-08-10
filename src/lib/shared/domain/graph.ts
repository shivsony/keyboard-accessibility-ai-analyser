import { z } from "zod";

import { KeyboardActionSchema } from "./keyboard";
import type { NodeId } from "./primitives";
import {
  ElementIdSchema,
  NodeIdSchema,
  StepIndexSchema,
  TimestampSchema,
  UrlSchema,
} from "./primitives";

/**
 * A distinct focus position the agent has occupied.
 *
 * A node is a *focus state*, not a page. That is what makes tab order a graph:
 * pressing Tab moves between nodes, so a focus trap is literally a cycle, and an
 * unreachable control is a node that no edge leads to.
 */
export const NavigationNodeSchema = z.object({
  id: NodeIdSchema,
  url: UrlSchema,
  /** Which kind of focus this node represents. Mirrors `FocusState.kind`. */
  focusKind: z.enum(["ELEMENT", "BODY", "OUTSIDE_PAGE", "UNKNOWN"]),
  /** The focused element, when `focusKind` is ELEMENT. */
  elementId: ElementIdSchema.nullable(),
  /**
   * Role and name are copied onto the node rather than looked up through
   * `elementId`. A traversal path has to be readable on its own — "Logo → Search
   * → Menu" is the evidence a human checks, and it should not require joining
   * against a separate element table to render.
   */
  role: z.string().nullable(),
  accessibleName: z.string().nullable(),
  firstSeenAtStep: StepIndexSchema,
  /** How many times the traversal has arrived here. Repeats are the signal. */
  visitCount: z.number().int().positive(),
});
export type NavigationNode = z.infer<typeof NavigationNodeSchema>;

/**
 * A keyboard action that moved focus from one node to another.
 *
 * Self-edges are legal and meaningful: pressing Tab and going nowhere is what a
 * single-element trap looks like.
 */
export const NavigationEdgeSchema = z.object({
  from: NodeIdSchema,
  to: NodeIdSchema,
  action: KeyboardActionSchema,
  atStep: StepIndexSchema,
  at: TimestampSchema,
});
export type NavigationEdge = z.infer<typeof NavigationEdgeSchema>;

/**
 * The traversal so far.
 *
 * Structure only — cycle detection and reachability analysis live in
 * `lib/graph`, so the domain stays a description of what is known rather than a
 * place where conclusions get drawn.
 */
export const NavigationGraphSchema = z.object({
  nodes: z.array(NavigationNodeSchema).readonly(),
  edges: z.array(NavigationEdgeSchema).readonly(),
});
export type NavigationGraph = z.infer<typeof NavigationGraphSchema>;

export const EMPTY_NAVIGATION_GRAPH: NavigationGraph = Object.freeze({
  nodes: Object.freeze([]),
  edges: Object.freeze([]),
});

export function findNode(graph: NavigationGraph, id: NodeId): NavigationNode | null {
  return graph.nodes.find((node) => node.id === id) ?? null;
}
