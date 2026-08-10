# `lib/rules`

The deterministic corroborating signals behind each finding type.

A finding requires **both** the model's `REPORT` decision and a signal from this module
(see ARCHITECTURE.md §4). Neither alone emits a finding: that keeps hallucinated
findings out and unexplained heuristic noise out.
