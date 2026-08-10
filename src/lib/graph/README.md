# `lib/graph`

The navigation graph: nodes are observed states, edges are the keyboard actions that
moved between them.

This is how focus cycles and traps become detectable — a cycle in the graph is a cycle
in the tab order.
