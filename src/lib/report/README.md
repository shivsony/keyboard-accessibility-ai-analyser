# `lib/report`

Turns findings into output: `findings.json` (the source of truth) and a human-readable
report.

Findings are deduplicated by type plus element identity. Page-derived text is escaped
on display — it is untrusted content.
