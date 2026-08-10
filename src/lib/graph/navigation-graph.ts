import {
  nodeId,
  type FocusState,
  type KeyboardAction,
  type NavigationEdge,
  type NavigationGraph,
  type NavigationNode,
  type NodeId,
  type StepIndex,
  type Timestamp,
  type Url,
} from "@/lib/shared/domain";

/**
 * Building the navigation graph.
 *
 * Every function here is pure and returns a new graph. The agent threads state
 * through its loop rather than mutating a shared object, and a graph that
 * quietly changed under a caller holding a reference to it would make evidence
 * captured at step 4 disagree with the same graph read at step 40.
 */

/**
 * The identity of a focus position.
 *
 * Element focus is keyed by element id, so returning to the same control is
 * recognised as a revisit rather than logged as a new place — that recognition
 * is what turns a repeated traversal into a detectable cycle.
 *
 * The three non-element states each collapse to a single node: there is only
 * one document body, and "focus left the page" is one destination however many
 * ways you arrive at it.
 */
export function nodeIdForFocus(focus: FocusState): NodeId {
  switch (focus.kind) {
    case "ELEMENT":
      return nodeId(`element:${focus.element.id}`);
    case "BODY":
      return nodeId("body");
    case "OUTSIDE_PAGE":
      return nodeId("outside-page");
    case "UNKNOWN":
      return nodeId("unknown");
  }
}

/** Builds the node record for a focus position observed at a step. */
export function nodeFromFocus(
  focus: FocusState,
  context: { url: Url; step: StepIndex },
): NavigationNode {
  const base = {
    id: nodeIdForFocus(focus),
    url: context.url,
    firstSeenAtStep: context.step,
    visitCount: 1,
  };

  if (focus.kind === "ELEMENT") {
    return {
      ...base,
      focusKind: "ELEMENT",
      elementId: focus.element.id,
      role: focus.element.role,
      accessibleName: focus.element.accessibleName,
    };
  }

  return {
    ...base,
    focusKind: focus.kind,
    elementId: null,
    role: null,
    accessibleName: null,
  };
}

/**
 * Adds a node, or records another visit to one already known.
 *
 * Re-adding is the common case — a traversal spends most of its time returning
 * to places it has been. `firstSeenAtStep` keeps the earliest sighting because
 * that is what the evidence path is measured from, and role and name are
 * refreshed since a live page can relabel a control between visits.
 */
export function addNode(graph: NavigationGraph, node: NavigationNode): NavigationGraph {
  const existing = graph.nodes.find((candidate) => candidate.id === node.id);

  if (existing === undefined) {
    return { nodes: [...graph.nodes, node], edges: graph.edges };
  }

  const merged: NavigationNode = {
    ...existing,
    role: node.role,
    accessibleName: node.accessibleName,
    firstSeenAtStep: Math.min(existing.firstSeenAtStep, node.firstSeenAtStep),
    visitCount: existing.visitCount + 1,
  };

  return {
    nodes: graph.nodes.map((candidate) =>
      candidate.id === node.id ? merged : candidate,
    ),
    edges: graph.edges,
  };
}

/**
 * Adds a traversal.
 *
 * Repeated traversals are kept, not deduplicated: the same Tab pressed at step 3
 * and step 30 are two pieces of evidence, and collapsing them would erase the
 * visit history that makes a cycle visible.
 *
 * Both endpoints must already exist. A dangling edge is a bug in the caller, and
 * silently inventing the missing node would hide it.
 */
export function addEdge(graph: NavigationGraph, edge: NavigationEdge): NavigationGraph {
  const known = new Set<string>(graph.nodes.map((node) => node.id));

  if (!known.has(edge.from) || !known.has(edge.to)) {
    throw new Error(
      `Cannot add an edge between unknown nodes: ${edge.from} -> ${edge.to}`,
    );
  }

  return { nodes: graph.nodes, edges: [...graph.edges, edge] };
}

/**
 * Records one observed transition: both endpoints and the edge between them.
 *
 * The normal way the agent grows the graph, since a keypress always produces a
 * source, a destination, and the action that joined them — even when the
 * destination turns out to be where it started.
 */
export function recordTransition(
  graph: NavigationGraph,
  transition: {
    from: FocusState;
    to: FocusState;
    action: KeyboardAction;
    url: Url;
    step: StepIndex;
    at: Timestamp;
  },
): NavigationGraph {
  const source = nodeFromFocus(transition.from, {
    url: transition.url,
    step: transition.step,
  });
  const destination = nodeFromFocus(transition.to, {
    url: transition.url,
    step: transition.step,
  });

  // The source is only added if new; arriving somewhere is what counts as a
  // visit, so re-recording the origin every step would inflate its count.
  const withSource = graph.nodes.some((node) => node.id === source.id)
    ? graph
    : addNode(graph, source);

  const withDestination = addNode(withSource, destination);

  return addEdge(withDestination, {
    from: source.id,
    to: destination.id,
    action: transition.action,
    atStep: transition.step,
    at: transition.at,
  });
}

export function hasNode(graph: NavigationGraph, id: NodeId): boolean {
  return graph.nodes.some((node) => node.id === id);
}

/** Outgoing edges, in the order they were traversed. */
export function outgoingEdges(
  graph: NavigationGraph,
  id: NodeId,
): readonly NavigationEdge[] {
  return graph.edges.filter((edge) => edge.from === id);
}

export function incomingEdges(
  graph: NavigationGraph,
  id: NodeId,
): readonly NavigationEdge[] {
  return graph.edges.filter((edge) => edge.to === id);
}

/**
 * Where the traversal began: the node seen first.
 *
 * Ties break on insertion order, so a graph built from a single run always
 * reports the node the agent actually started from.
 */
export function entryNode(graph: NavigationGraph): NavigationNode | null {
  let earliest: NavigationNode | null = null;

  for (const node of graph.nodes) {
    if (earliest === null || node.firstSeenAtStep < earliest.firstSeenAtStep) {
      earliest = node;
    }
  }

  return earliest;
}
