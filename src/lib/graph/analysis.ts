import type {
  ElementId,
  InteractiveElement,
  KeyboardAction,
  NavigationEdge,
  NavigationGraph,
  NavigationNode,
  NodeId,
} from "@/lib/shared/domain";

import { entryNode } from "./navigation-graph";

/**
 * Reading the navigation graph.
 *
 * Nothing here decides whether what it found is an accessibility problem. A
 * cycle is a cycle; whether it is a focus trap depends on what the cycle
 * excludes and what the page was trying to do, and that judgement belongs to
 * `lib/rules` and the agent.
 *
 * Navigation is not assumed to be linear. The same action from the same node can
 * lead somewhere different at a later step — a page that re-renders under the
 * agent does exactly that — so this is a multigraph throughout, and no function
 * here assumes one edge per node per action.
 */

/** A route through the graph, with the keypresses that produce it. */
export type EvidencePath = {
  readonly nodes: readonly NavigationNode[];
  readonly edges: readonly NavigationEdge[];
  /** The exact key sequence to replay. */
  readonly actions: readonly KeyboardAction[];
};

/** A closed loop in the traversal. */
export type NavigationCycle = {
  /** In order, starting and ending at the same node; the repeat is implied. */
  readonly nodes: readonly NodeId[];
  readonly edges: readonly NavigationEdge[];
  /** A node that leads straight back to itself — the tightest possible trap. */
  readonly isSelfLoop: boolean;
};

function nodesById(graph: NavigationGraph): Map<NodeId, NavigationNode> {
  return new Map(graph.nodes.map((node) => [node.id, node]));
}

function adjacency(graph: NavigationGraph): Map<NodeId, NavigationEdge[]> {
  const adjacent = new Map<NodeId, NavigationEdge[]>();

  for (const node of graph.nodes) adjacent.set(node.id, []);
  for (const edge of graph.edges) adjacent.get(edge.from)?.push(edge);

  return adjacent;
}

/**
 * Every node reachable from a starting point, in breadth-first order.
 *
 * The start is included: it is trivially reachable, and excluding it makes
 * every caller add it back.
 */
export function reachableFrom(graph: NavigationGraph, start: NodeId): readonly NodeId[] {
  if (!graph.nodes.some((node) => node.id === start)) return [];

  const adjacent = adjacency(graph);
  const seen = new Set<NodeId>([start]);
  const order: NodeId[] = [start];
  const queue: NodeId[] = [start];

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;

    for (const edge of adjacent.get(current) ?? []) {
      if (seen.has(edge.to)) continue;
      seen.add(edge.to);
      order.push(edge.to);
      queue.push(edge.to);
    }
  }

  return order;
}

/**
 * Nodes the traversal recorded but cannot arrive at from the entry point.
 *
 * Usually a sign that focus jumped somewhere no keypress leads back to —
 * the graph equivalent of a one-way door.
 */
export function unreachableNodes(
  graph: NavigationGraph,
  start?: NodeId,
): readonly NavigationNode[] {
  const origin = start ?? entryNode(graph)?.id;
  if (origin === undefined) return [];

  const reachable = new Set<NodeId>(reachableFrom(graph, origin));
  return graph.nodes.filter((node) => !reachable.has(node.id));
}

/** Element ids the traversal has actually focused. */
export function visitedElementIds(graph: NavigationGraph): readonly ElementId[] {
  const ids: ElementId[] = [];

  for (const node of graph.nodes) {
    if (node.elementId !== null) ids.push(node.elementId);
  }

  return ids;
}

/**
 * Discovered controls the keyboard never reached.
 *
 * The raw material for UNREACHABLE_ELEMENT. This reports the gap
 * between what the page offers and what the traversal touched; whether the gap
 * is a defect — the traversal may simply be unfinished — is decided elsewhere.
 */
export function unvisitedDiscoveredElements(
  graph: NavigationGraph,
  discovered: readonly InteractiveElement[],
): readonly InteractiveElement[] {
  const visited = new Set<string>(visitedElementIds(graph));
  return discovered.filter((element) => !visited.has(element.id));
}

/**
 * Strongly connected components, via Tarjan's algorithm.
 *
 * Every cycle lives inside exactly one SCC, which is what makes this the right
 * starting point: it finds the loops without enumerating paths.
 */
function stronglyConnectedComponents(graph: NavigationGraph): NodeId[][] {
  const adjacent = adjacency(graph);
  const index = new Map<NodeId, number>();
  const lowLink = new Map<NodeId, number>();
  const onStack = new Set<NodeId>();
  const stack: NodeId[] = [];
  const components: NodeId[][] = [];
  let counter = 0;

  const strongConnect = (current: NodeId): void => {
    index.set(current, counter);
    lowLink.set(current, counter);
    counter += 1;
    stack.push(current);
    onStack.add(current);

    for (const edge of adjacent.get(current) ?? []) {
      if (!index.has(edge.to)) {
        strongConnect(edge.to);
        lowLink.set(
          current,
          Math.min(lowLink.get(current) ?? 0, lowLink.get(edge.to) ?? 0),
        );
      } else if (onStack.has(edge.to)) {
        lowLink.set(
          current,
          Math.min(lowLink.get(current) ?? 0, index.get(edge.to) ?? 0),
        );
      }
    }

    if (lowLink.get(current) === index.get(current)) {
      const component: NodeId[] = [];
      for (;;) {
        const popped = stack.pop();
        if (popped === undefined) break;
        onStack.delete(popped);
        component.push(popped);
        if (popped === current) break;
      }
      components.push(component);
    }
  };

  for (const node of graph.nodes) {
    if (!index.has(node.id)) strongConnect(node.id);
  }

  return components;
}

/**
 * Finds one concrete loop inside a component.
 *
 * An SCC proves a cycle exists but is an unordered set, and evidence has to be
 * a route someone can follow: "Search → Menu → Search", not "these three nodes
 * are mutually reachable".
 */
function representativeCycle(
  graph: NavigationGraph,
  component: readonly NodeId[],
  start: NodeId,
): NavigationCycle | null {
  const members = new Set<NodeId>(component);
  const adjacent = adjacency(graph);
  const visited = new Set<NodeId>();

  const walk = (current: NodeId, path: NavigationEdge[]): NavigationEdge[] | null => {
    for (const edge of adjacent.get(current) ?? []) {
      if (!members.has(edge.to)) continue;

      if (edge.to === start) return [...path, edge];
      if (visited.has(edge.to)) continue;

      visited.add(edge.to);
      const found = walk(edge.to, [...path, edge]);
      if (found !== null) return found;
    }

    return null;
  };

  visited.add(start);
  const edges = walk(start, []);
  if (edges === null) return null;

  return {
    nodes: [start, ...edges.map((edge) => edge.to)],
    edges,
    isSelfLoop: edges.length === 1 && edges[0]?.from === edges[0]?.to,
  };
}

/**
 * Cycles in the traversal.
 *
 * Returns **one representative cycle per strongly connected component**, not
 * every simple cycle — enumerating all of them is exponential, and for evidence
 * one reproducible loop per trap is what a reader needs. A component containing
 * several interleaved loops reports the first one found from its earliest node.
 *
 * Self-loops count. A control whose Tab returns to itself is the tightest trap
 * there is, and it is a single node with a single edge.
 */
export function detectCycles(graph: NavigationGraph): readonly NavigationCycle[] {
  const byId = nodesById(graph);
  const position = new Map<NodeId, number>(
    graph.nodes.map((node, index) => [node.id, index]),
  );
  const cycles: NavigationCycle[] = [];

  for (const component of stronglyConnectedComponents(graph)) {
    const selfLoop = graph.edges.find(
      (edge) =>
        edge.from === edge.to && component.length === 1 && component[0] === edge.from,
    );

    if (component.length === 1 && selfLoop === undefined) continue;

    // Start from the node seen earliest, so the reported loop reads in the
    // order the traversal actually met it. Ties break on discovery order —
    // a single keypress records both its endpoints at the same step, so
    // without this the reported loop would start at an arbitrary node.
    const start = [...component].sort((a, b) => {
      const byStep =
        (byId.get(a)?.firstSeenAtStep ?? 0) - (byId.get(b)?.firstSeenAtStep ?? 0);
      return byStep !== 0 ? byStep : (position.get(a) ?? 0) - (position.get(b) ?? 0);
    })[0];

    if (start === undefined) continue;

    const cycle = representativeCycle(graph, component, start);
    if (cycle !== null) cycles.push(cycle);
  }

  return cycles;
}

export function hasCycle(graph: NavigationGraph): boolean {
  return detectCycles(graph).length > 0;
}

/**
 * The route actually taken, in order.
 *
 * Ordered by step rather than by insertion, so a graph assembled out of order —
 * replayed from a run directory, say — still reports the traversal as it
 * happened.
 */
export function traversalPath(graph: NavigationGraph): EvidencePath {
  const byId = nodesById(graph);
  const edges = [...graph.edges].sort((a, b) => a.atStep - b.atStep);

  if (edges.length === 0) {
    const entry = entryNode(graph);
    return { nodes: entry === null ? [] : [entry], edges: [], actions: [] };
  }

  const nodes: NavigationNode[] = [];
  const first = edges[0];
  if (first !== undefined) {
    const origin = byId.get(first.from);
    if (origin !== undefined) nodes.push(origin);
  }

  for (const edge of edges) {
    const node = byId.get(edge.to);
    if (node !== undefined) nodes.push(node);
  }

  return { nodes, edges, actions: edges.map((edge) => edge.action) };
}

/**
 * The shortest key sequence that reaches a node.
 *
 * Breadth-first, so the result is the fewest keypresses — which is what belongs
 * in a bug report. The agent may have wandered thirty steps before stumbling on
 * the problem; nobody reproducing it should have to repeat the wandering.
 *
 * Returns null when the node cannot be reached from the origin at all.
 */
export function shortestEvidencePath(
  graph: NavigationGraph,
  target: NodeId,
  start?: NodeId,
): EvidencePath | null {
  const byId = nodesById(graph);
  const origin = start ?? entryNode(graph)?.id;

  if (origin === undefined || !byId.has(origin) || !byId.has(target)) return null;

  if (origin === target) {
    const node = byId.get(origin);
    return node === undefined ? null : { nodes: [node], edges: [], actions: [] };
  }

  const adjacent = adjacency(graph);
  const cameBy = new Map<NodeId, NavigationEdge>();
  const seen = new Set<NodeId>([origin]);
  const queue: NodeId[] = [origin];

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;

    for (const edge of adjacent.get(current) ?? []) {
      if (seen.has(edge.to)) continue;

      seen.add(edge.to);
      cameBy.set(edge.to, edge);

      if (edge.to === target) {
        const edges: NavigationEdge[] = [];
        let cursor: NodeId | undefined = target;

        while (cursor !== undefined && cursor !== origin) {
          const arrival: NavigationEdge | undefined = cameBy.get(cursor);
          if (arrival === undefined) break;
          edges.unshift(arrival);
          cursor = arrival.from;
        }

        const nodes: NavigationNode[] = [];
        const originNode = byId.get(origin);
        if (originNode !== undefined) nodes.push(originNode);
        for (const step of edges) {
          const node = byId.get(step.to);
          if (node !== undefined) nodes.push(node);
        }

        return { nodes, edges, actions: edges.map((step) => step.action) };
      }

      queue.push(edge.to);
    }
  }

  return null;
}

/** Renders a path as "Logo --TAB--> Search --TAB--> Menu", for reports and logs. */
export function describePath(path: EvidencePath): string {
  if (path.nodes.length === 0) return "(empty)";

  const label = (node: NavigationNode): string =>
    node.accessibleName ?? node.role ?? node.elementId ?? node.focusKind;

  const parts: string[] = [];
  const first = path.nodes[0];
  if (first !== undefined) parts.push(label(first));

  path.edges.forEach((edge, index) => {
    const next = path.nodes[index + 1];
    parts.push(`--${edge.action}-->`);
    if (next !== undefined) parts.push(label(next));
  });

  return parts.join(" ");
}
