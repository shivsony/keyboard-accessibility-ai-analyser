# `lib/rules`

The corroboration layer. **AI suspicion is not automatically a reportable
accessibility issue.**

| File                   | Role                                                            |
| ---------------------- | --------------------------------------------------------------- |
| `observations.ts`      | What the browser trace shows. Deterministic, no model involved. |
| `finding-validator.ts` | Whether a model's claim is supported well enough to publish.    |

## The three states

```
OBSERVED    the trace shows the pattern          (browser, deterministic)
SUSPECTED   the model thinks it means something  (AI, uncorroborated)
CONFIRMED   both, and every claim checked        (publishable)
```

A finding reaches CONFIRMED only when a matching observation exists **and** the
trace supports each factual claim made about it. The validator checks:

- the affected element was discovered
- a keyboard sequence exists, and any claimed sequence is a prefix of it
- claimed focus transitions actually occurred
- screenshots were captured
- the issue type is supported
- confidence is within range

## The division of labour

**The browser trace is authoritative for facts.** The keyboard sequence, the
focus path, the screenshots, which elements exist and which were reached — all
of it comes from the recording, never from the claim. Even on a confirmed
finding, the evidence is rebuilt from the trace.

**The model supplies interpretation.** Severity, the title and description a
developer reads, and its reasoning about why the behaviour matters.

Where the two disagree, the trace wins — not as a tiebreak, but because a report
that misstates what happened is worse than no report. Somebody follows the
steps, sees something else, and stops trusting the rest of it.
