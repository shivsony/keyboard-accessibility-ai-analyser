import { describe, expect, it } from "vitest";

import {
  addNode,
  describePath,
  detectCycles,
  hasCycle,
  nodeFromFocus,
  nodeIdForFocus,
  reachableFrom,
  recordTransition,
  shortestEvidencePath,
  traversalPath,
  unreachableNodes,
  unvisitedDiscoveredElements,
  visitedElementIds,
} from "@/lib/graph";
import {
  EMPTY_NAVIGATION_GRAPH,
  focusOn,
  nodeId,
  type FocusState,
  type KeyboardAction,
  type NavigationGraph,
} from "@/lib/shared/domain";

import { at, makeElement, TEST_URL } from "../../fixtures/domain";

/**
 * The worked example from the brief:
 *
 *   Logo --TAB--> Search --TAB--> Menu
 */
const LOGO = focusOn(makeElement("logo", { accessibleName: "Logo", role: "link" }));
const SEARCH = focusOn(
  makeElement("search", { accessibleName: "Search", role: "searchbox" }),
);
const MENU = focusOn(makeElement("menu", { accessibleName: "Menu", role: "button" }));
const FOOTER = focusOn(makeElement("footer", { accessibleName: "Footer", role: "link" }));

/** Builds a graph from a list of transitions, one step per entry. */
function build(
  transitions: readonly (readonly [FocusState, KeyboardAction, FocusState])[],
): NavigationGraph {
  return transitions.reduce<NavigationGraph>(
    (graph, [from, action, to], index) =>
      recordTransition(graph, {
        from,
        to,
        action,
        url: TEST_URL,
        step: index,
        at: at(index),
      }),
    EMPTY_NAVIGATION_GRAPH,
  );
}

const id = nodeIdForFocus;

describe("linear navigation", () => {
  const graph = build([
    [LOGO, "TAB", SEARCH],
    [SEARCH, "TAB", MENU],
  ]);

  it("records the chain", () => {
    expect(graph.nodes).toHaveLength(3);
    expect(graph.edges).toHaveLength(2);
  });

  it("returns the traversal path in order", () => {
    const path = traversalPath(graph);

    expect(path.nodes.map((node) => node.accessibleName)).toEqual([
      "Logo",
      "Search",
      "Menu",
    ]);
    expect(path.actions).toEqual(["TAB", "TAB"]);
    expect(describePath(path)).toBe("Logo --TAB--> Search --TAB--> Menu");
  });

  it("finds everything reachable from the entry", () => {
    expect(reachableFrom(graph, id(LOGO))).toEqual([id(LOGO), id(SEARCH), id(MENU)]);
  });

  it("has no cycles", () => {
    expect(detectCycles(graph)).toEqual([]);
    expect(hasCycle(graph)).toBe(false);
  });

  it("gives the shortest path to the last node", () => {
    const path = shortestEvidencePath(graph, id(MENU));

    expect(path?.actions).toEqual(["TAB", "TAB"]);
    expect(path?.nodes.map((node) => node.accessibleName)).toEqual([
      "Logo",
      "Search",
      "Menu",
    ]);
  });

  // Ordered by step, so a graph rebuilt from a run directory out of order still
  // reports the traversal as it happened.
  it("orders the path by step, not by insertion", () => {
    const scrambled: NavigationGraph = {
      nodes: graph.nodes,
      edges: [...graph.edges].reverse(),
    };

    expect(traversalPath(scrambled).actions).toEqual(["TAB", "TAB"]);
    expect(traversalPath(scrambled).nodes.map((node) => node.accessibleName)).toEqual([
      "Logo",
      "Search",
      "Menu",
    ]);
  });
});

describe("cycles", () => {
  // Logo → Search → Menu → Logo: the classic trap.
  const cyclic = build([
    [LOGO, "TAB", SEARCH],
    [SEARCH, "TAB", MENU],
    [MENU, "TAB", LOGO],
  ]);

  it("detects a loop", () => {
    expect(hasCycle(cyclic)).toBe(true);

    const cycles = detectCycles(cyclic);
    expect(cycles).toHaveLength(1);
    expect(cycles[0]?.isSelfLoop).toBe(false);
  });

  // An SCC proves a cycle exists but is an unordered set; evidence has to be a
  // route someone can walk.
  it("reports the loop as an ordered route back to its start", () => {
    const cycle = detectCycles(cyclic)[0];

    expect(cycle?.nodes[0]).toBe(id(LOGO));
    expect(cycle?.nodes.at(-1)).toBe(id(LOGO));
    expect(cycle?.nodes.slice(0, 3)).toEqual([id(LOGO), id(SEARCH), id(MENU)]);
    expect(cycle?.edges).toHaveLength(3);
  });

  // A control whose Tab returns to itself is the tightest trap there is.
  it("detects a self-loop", () => {
    const stuck = build([[LOGO, "TAB", LOGO]]);
    const cycles = detectCycles(stuck);

    expect(cycles).toHaveLength(1);
    expect(cycles[0]?.isSelfLoop).toBe(true);
    expect(cycles[0]?.nodes).toEqual([id(LOGO), id(LOGO)]);
  });

  it("detects a two-element trap", () => {
    const trap = build([
      [SEARCH, "TAB", MENU],
      [MENU, "TAB", SEARCH],
    ]);

    const cycles = detectCycles(trap);
    expect(cycles).toHaveLength(1);
    expect(cycles[0]?.nodes).toEqual([id(SEARCH), id(MENU), id(SEARCH)]);
  });

  it("reports separate traps separately", () => {
    let graph = build([
      [LOGO, "TAB", SEARCH],
      [SEARCH, "TAB", LOGO],
    ]);
    graph = addNode(graph, nodeFromFocus(MENU, { url: TEST_URL, step: 2 }));
    graph = recordTransition(graph, {
      from: MENU,
      to: FOOTER,
      action: "TAB",
      url: TEST_URL,
      step: 3,
      at: at(3),
    });
    graph = recordTransition(graph, {
      from: FOOTER,
      to: MENU,
      action: "TAB",
      url: TEST_URL,
      step: 4,
      at: at(4),
    });

    expect(detectCycles(graph)).toHaveLength(2);
  });

  it("sees no cycle in a path that merely revisits a shape", () => {
    // A → B and A → C is a fork, not a loop.
    const fork = build([
      [LOGO, "TAB", SEARCH],
      [LOGO, "TAB", MENU],
    ]);

    expect(hasCycle(fork)).toBe(false);
  });

  it("finds nothing in an empty graph", () => {
    expect(detectCycles(EMPTY_NAVIGATION_GRAPH)).toEqual([]);
    expect(traversalPath(EMPTY_NAVIGATION_GRAPH).nodes).toEqual([]);
  });
});

describe("repeated nodes", () => {
  // Tab all the way round and start again: the same nodes, visited twice.
  const looped = build([
    [LOGO, "TAB", SEARCH],
    [SEARCH, "TAB", MENU],
    [MENU, "TAB", LOGO],
    [LOGO, "TAB", SEARCH],
    [SEARCH, "TAB", MENU],
  ]);

  it("keeps one node per position however often it is visited", () => {
    expect(looped.nodes).toHaveLength(3);
    expect(looped.edges).toHaveLength(5);
  });

  it("counts the visits", () => {
    const search = looped.nodes.find((node) => node.elementId === "search");
    const menu = looped.nodes.find((node) => node.elementId === "menu");

    expect(search?.visitCount).toBe(2);
    expect(menu?.visitCount).toBe(2);
  });

  it("keeps every traversal in the path, including the repeats", () => {
    const path = traversalPath(looped);

    expect(path.actions).toHaveLength(5);
    expect(path.nodes.map((node) => node.accessibleName)).toEqual([
      "Logo",
      "Search",
      "Menu",
      "Logo",
      "Search",
      "Menu",
    ]);
  });

  // The agent may have wandered for thirty steps; nobody reproducing the bug
  // should have to repeat the wandering.
  it("gives the shortest route, not the wandering one", () => {
    const path = shortestEvidencePath(looped, id(MENU));

    expect(path?.actions).toEqual(["TAB", "TAB"]);
    expect(path?.edges.map((edge) => edge.atStep)).toEqual([0, 1]);
  });

  it("returns an empty path when the target is the origin", () => {
    const path = shortestEvidencePath(looped, id(LOGO));

    expect(path?.actions).toEqual([]);
    expect(path?.nodes.map((node) => node.elementId)).toEqual(["logo"]);
  });
});

describe("reverse navigation", () => {
  // Forward with TAB, back with SHIFT_TAB. Both directions are edges; the graph
  // is directed, so they are not the same edge.
  const bidirectional = build([
    [LOGO, "TAB", SEARCH],
    [SEARCH, "TAB", MENU],
    [MENU, "SHIFT_TAB", SEARCH],
    [SEARCH, "SHIFT_TAB", LOGO],
  ]);

  it("records both directions", () => {
    expect(bidirectional.nodes).toHaveLength(3);
    expect(bidirectional.edges.map((edge) => edge.action)).toEqual([
      "TAB",
      "TAB",
      "SHIFT_TAB",
      "SHIFT_TAB",
    ]);
  });

  it("reports the round trip in order", () => {
    expect(describePath(traversalPath(bidirectional))).toBe(
      "Logo --TAB--> Search --TAB--> Menu --SHIFT_TAB--> Search --SHIFT_TAB--> Logo",
    );
  });

  // Going somewhere and coming back is a cycle in graph terms. Whether it is a
  // trap is the rules layer's call — reversible navigation is normal.
  it("treats a there-and-back route as a cycle", () => {
    expect(hasCycle(bidirectional)).toBe(true);
  });

  it("uses reverse edges when they make the shorter route", () => {
    // Menu is reachable from Logo in two forward presses; Logo is reachable
    // from Menu in two reverse ones.
    const path = shortestEvidencePath(bidirectional, id(LOGO), id(MENU));

    expect(path?.actions).toEqual(["SHIFT_TAB", "SHIFT_TAB"]);
  });

  it("finds a node reachable only by going backwards", () => {
    const onlyBackwards = build([
      [SEARCH, "SHIFT_TAB", LOGO],
      [LOGO, "SHIFT_TAB", FOOTER],
    ]);

    expect(reachableFrom(onlyBackwards, id(SEARCH))).toContain(id(FOOTER));
  });
});

describe("unreachable nodes and elements", () => {
  const graph = build([
    [LOGO, "TAB", SEARCH],
    [SEARCH, "TAB", MENU],
  ]);

  it("reports discovered controls the traversal never focused", () => {
    const discovered = [
      makeElement("logo"),
      makeElement("search"),
      makeElement("menu"),
      makeElement("hidden-action", { role: "button", tagName: "div" }),
    ];

    const unvisited = unvisitedDiscoveredElements(graph, discovered);

    expect(unvisited.map((element) => element.id)).toEqual(["hidden-action"]);
  });

  it("reports nothing unvisited when everything was reached", () => {
    const discovered = [makeElement("logo"), makeElement("search"), makeElement("menu")];

    expect(unvisitedDiscoveredElements(graph, discovered)).toEqual([]);
  });

  it("lists the element ids the traversal focused", () => {
    expect(visitedElementIds(graph)).toEqual(["logo", "search", "menu"]);
  });

  it("ignores non-element nodes when listing visited elements", () => {
    const withBody = build([
      [{ kind: "BODY" }, "TAB", LOGO],
      [LOGO, "TAB", { kind: "OUTSIDE_PAGE" }],
    ]);

    expect(visitedElementIds(withBody)).toEqual(["logo"]);
  });

  // A node no keypress leads back to: the graph equivalent of a one-way door.
  it("finds nodes that cannot be reached from the entry", () => {
    let orphaned = graph;
    orphaned = addNode(orphaned, nodeFromFocus(FOOTER, { url: TEST_URL, step: 9 }));

    const unreachable = unreachableNodes(orphaned);

    expect(unreachable.map((node) => node.elementId)).toEqual(["footer"]);
  });

  it("reports nothing unreachable in a fully connected traversal", () => {
    expect(unreachableNodes(graph)).toEqual([]);
  });

  it("returns no path to a node that cannot be reached", () => {
    let orphaned = graph;
    orphaned = addNode(orphaned, nodeFromFocus(FOOTER, { url: TEST_URL, step: 9 }));

    expect(shortestEvidencePath(orphaned, id(FOOTER))).toBeNull();
  });

  it("returns no path to a node that is not in the graph", () => {
    expect(shortestEvidencePath(graph, nodeId("never-seen"))).toBeNull();
  });

  it("returns nothing reachable from a node that is not in the graph", () => {
    expect(reachableFrom(graph, nodeId("never-seen"))).toEqual([]);
  });
});

describe("navigation that is not linear", () => {
  // The same action from the same node leading somewhere new: a page that
  // re-rendered under the agent. The graph must hold both.
  it("keeps both destinations when one action leads two ways", () => {
    const branching = build([
      [LOGO, "TAB", SEARCH],
      [LOGO, "TAB", MENU],
    ]);

    expect(branching.edges).toHaveLength(2);
    expect(reachableFrom(branching, id(LOGO))).toEqual([id(LOGO), id(SEARCH), id(MENU)]);
  });

  it("finds the shorter of two routes to the same node", () => {
    const diamond = build([
      [LOGO, "TAB", SEARCH],
      [SEARCH, "TAB", MENU],
      [MENU, "TAB", FOOTER],
      [LOGO, "SHIFT_TAB", FOOTER],
    ]);

    const path = shortestEvidencePath(diamond, id(FOOTER));

    expect(path?.actions).toEqual(["SHIFT_TAB"]);
  });

  it("handles a graph whose entry is not the first node added", () => {
    let graph = addNode(
      EMPTY_NAVIGATION_GRAPH,
      nodeFromFocus(MENU, { url: TEST_URL, step: 5 }),
    );
    graph = addNode(graph, nodeFromFocus(LOGO, { url: TEST_URL, step: 0 }));

    expect(unreachableNodes(graph).map((node) => node.elementId)).toEqual(["menu"]);
  });
});
