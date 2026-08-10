import { describe, expect, it } from "vitest";

import {
  addEdge,
  addNode,
  entryNode,
  incomingEdges,
  hasNode,
  nodeFromFocus,
  nodeIdForFocus,
  outgoingEdges,
  recordTransition,
} from "@/lib/graph";
import {
  EMPTY_NAVIGATION_GRAPH,
  focusOn,
  nodeId,
  type NavigationGraph,
} from "@/lib/shared/domain";

import { at, makeElement, TEST_URL } from "../../fixtures/domain";

const LOGO = focusOn(makeElement("logo", { accessibleName: "Logo", role: "link" }));
const SEARCH = focusOn(
  makeElement("search", { accessibleName: "Search", role: "searchbox" }),
);

function tab(
  graph: NavigationGraph,
  from: typeof LOGO,
  to: typeof LOGO,
  step: number,
): NavigationGraph {
  return recordTransition(graph, {
    from,
    to,
    action: "TAB",
    url: TEST_URL,
    step,
    at: at(step),
  });
}

describe("node identity", () => {
  // Recognising a return visit is what turns a repeated traversal into a
  // detectable cycle, so identity is the element, not the observation.
  it("keys element focus by element id", () => {
    const later = focusOn(
      makeElement("logo", { accessibleName: "Logo", discoveredAtStep: 9 }),
    );

    expect(nodeIdForFocus(LOGO)).toBe(nodeIdForFocus(later));
    expect(nodeIdForFocus(LOGO)).not.toBe(nodeIdForFocus(SEARCH));
  });

  it("collapses each non-element focus to a single node", () => {
    expect(nodeIdForFocus({ kind: "BODY" })).toBe(nodeIdForFocus({ kind: "BODY" }));
    expect(nodeIdForFocus({ kind: "BODY" })).not.toBe(
      nodeIdForFocus({ kind: "OUTSIDE_PAGE" }),
    );
    expect(nodeIdForFocus({ kind: "UNKNOWN" })).not.toBe(
      nodeIdForFocus({ kind: "BODY" }),
    );
  });

  // A path has to be readable without joining against an element table.
  it("copies role and name onto the node", () => {
    const node = nodeFromFocus(SEARCH, { url: TEST_URL, step: 2 });

    expect(node.role).toBe("searchbox");
    expect(node.accessibleName).toBe("Search");
    expect(node.elementId).toBe("search");
    expect(node.firstSeenAtStep).toBe(2);
    expect(node.visitCount).toBe(1);
  });

  it("records nothing element-shaped for a non-element focus", () => {
    const node = nodeFromFocus({ kind: "OUTSIDE_PAGE" }, { url: TEST_URL, step: 1 });

    expect(node.focusKind).toBe("OUTSIDE_PAGE");
    expect(node.elementId).toBeNull();
    expect(node.role).toBeNull();
    expect(node.accessibleName).toBeNull();
  });
});

describe("addNode", () => {
  it("adds a node that is not yet known", () => {
    const graph = addNode(
      EMPTY_NAVIGATION_GRAPH,
      nodeFromFocus(LOGO, { url: TEST_URL, step: 0 }),
    );

    expect(graph.nodes).toHaveLength(1);
    expect(hasNode(graph, nodeIdForFocus(LOGO))).toBe(true);
  });

  it("counts a revisit instead of duplicating the node", () => {
    let graph = addNode(
      EMPTY_NAVIGATION_GRAPH,
      nodeFromFocus(LOGO, { url: TEST_URL, step: 0 }),
    );
    graph = addNode(graph, nodeFromFocus(LOGO, { url: TEST_URL, step: 5 }));
    graph = addNode(graph, nodeFromFocus(LOGO, { url: TEST_URL, step: 9 }));

    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0]?.visitCount).toBe(3);
  });

  // The evidence path is measured from the first sighting.
  it("keeps the earliest first-seen step", () => {
    let graph = addNode(
      EMPTY_NAVIGATION_GRAPH,
      nodeFromFocus(LOGO, { url: TEST_URL, step: 4 }),
    );
    graph = addNode(graph, nodeFromFocus(LOGO, { url: TEST_URL, step: 1 }));

    expect(graph.nodes[0]?.firstSeenAtStep).toBe(1);
  });

  // A live page can relabel a control between visits.
  it("refreshes the label on revisit", () => {
    let graph = addNode(
      EMPTY_NAVIGATION_GRAPH,
      nodeFromFocus(LOGO, { url: TEST_URL, step: 0 }),
    );
    graph = addNode(
      graph,
      nodeFromFocus(
        focusOn(makeElement("logo", { accessibleName: "Home", role: "link" })),
        { url: TEST_URL, step: 3 },
      ),
    );

    expect(graph.nodes[0]?.accessibleName).toBe("Home");
  });

  it("does not mutate the graph it was given", () => {
    const before = addNode(
      EMPTY_NAVIGATION_GRAPH,
      nodeFromFocus(LOGO, { url: TEST_URL, step: 0 }),
    );
    const after = addNode(before, nodeFromFocus(SEARCH, { url: TEST_URL, step: 1 }));

    expect(before.nodes).toHaveLength(1);
    expect(after.nodes).toHaveLength(2);
  });
});

describe("addEdge", () => {
  it("records a traversal between known nodes", () => {
    let graph = addNode(
      EMPTY_NAVIGATION_GRAPH,
      nodeFromFocus(LOGO, { url: TEST_URL, step: 0 }),
    );
    graph = addNode(graph, nodeFromFocus(SEARCH, { url: TEST_URL, step: 1 }));

    graph = addEdge(graph, {
      from: nodeIdForFocus(LOGO),
      to: nodeIdForFocus(SEARCH),
      action: "TAB",
      atStep: 0,
      at: at(0),
    });

    expect(graph.edges).toHaveLength(1);
    expect(outgoingEdges(graph, nodeIdForFocus(LOGO))).toHaveLength(1);
    expect(incomingEdges(graph, nodeIdForFocus(SEARCH))).toHaveLength(1);
  });

  // Silently inventing the missing node would hide a caller bug.
  it("refuses an edge to an unknown node", () => {
    const graph = addNode(
      EMPTY_NAVIGATION_GRAPH,
      nodeFromFocus(LOGO, { url: TEST_URL, step: 0 }),
    );

    expect(() =>
      addEdge(graph, {
        from: nodeIdForFocus(LOGO),
        to: nodeId("nowhere"),
        action: "TAB",
        atStep: 0,
        at: at(0),
      }),
    ).toThrow(/unknown nodes/);
  });

  // The same Tab pressed at step 3 and step 30 are two pieces of evidence.
  it("keeps repeated traversals rather than collapsing them", () => {
    let graph = tab(EMPTY_NAVIGATION_GRAPH, LOGO, SEARCH, 0);
    graph = tab(graph, LOGO, SEARCH, 7);

    expect(graph.nodes).toHaveLength(2);
    expect(graph.edges).toHaveLength(2);
    expect(graph.edges.map((edge) => edge.atStep)).toEqual([0, 7]);
  });
});

describe("recordTransition", () => {
  it("adds both endpoints and the edge between them", () => {
    const graph = tab(EMPTY_NAVIGATION_GRAPH, LOGO, SEARCH, 0);

    expect(graph.nodes.map((node) => node.accessibleName)).toEqual(["Logo", "Search"]);
    expect(graph.edges[0]).toMatchObject({ action: "TAB", atStep: 0 });
    expect(graph.edges[0]?.at).toBe(at(0));
  });

  // Arriving somewhere is the visit. Re-counting the origin every step would
  // make the first node look far more visited than it was.
  it("counts arrivals, not departures", () => {
    let graph = tab(EMPTY_NAVIGATION_GRAPH, LOGO, SEARCH, 0);
    graph = tab(graph, SEARCH, LOGO, 1);
    graph = tab(graph, LOGO, SEARCH, 2);

    const logo = graph.nodes.find((node) => node.elementId === "logo");
    const search = graph.nodes.find((node) => node.elementId === "search");

    expect(logo?.visitCount).toBe(2);
    expect(search?.visitCount).toBe(2);
  });

  it("records a self-transition when the key moved nothing", () => {
    const graph = tab(EMPTY_NAVIGATION_GRAPH, LOGO, LOGO, 0);

    expect(graph.nodes).toHaveLength(1);
    expect(graph.edges[0]?.from).toBe(graph.edges[0]?.to);
  });

  it("records focus leaving the page as its own destination", () => {
    const graph = recordTransition(EMPTY_NAVIGATION_GRAPH, {
      from: LOGO,
      to: { kind: "OUTSIDE_PAGE" },
      action: "TAB",
      url: TEST_URL,
      step: 0,
      at: at(0),
    });

    expect(graph.nodes.map((node) => node.focusKind)).toEqual([
      "ELEMENT",
      "OUTSIDE_PAGE",
    ]);
  });
});

describe("entryNode", () => {
  it("is the node seen first", () => {
    let graph = tab(EMPTY_NAVIGATION_GRAPH, LOGO, SEARCH, 0);
    graph = tab(graph, SEARCH, LOGO, 1);

    expect(entryNode(graph)?.elementId).toBe("logo");
  });

  it("is null for an empty graph", () => {
    expect(entryNode(EMPTY_NAVIGATION_GRAPH)).toBeNull();
  });
});
