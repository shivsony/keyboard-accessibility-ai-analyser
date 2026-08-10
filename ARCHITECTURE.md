# Architecture

This document describes the intended design. No code exists yet; this is the contract
implementation must satisfy.

---

## 1. Design principles

1. **The AI explores; it does not drive.** The model chooses *which allowed action to
   take next*. It never issues browser commands, selectors, scripts, or URLs.
2. **The browser is a narrow appliance.** It accepts exactly one thing: a keyboard action
   from a fixed allowlist. There is no general-purpose escape hatch.
3. **Determinism where it matters.** The guard, the allowlist, the evidence recorder, and
   the report writer are plain deterministic code. Only the decision step is
   probabilistic.
4. **A finding is a reproduction.** Nothing is reported that cannot be replayed from the
   recorded keyboard sequence.
5. **Secrets stay in the agent process.** The page under test is untrusted and never sees
   a key, a prompt, or a model response.

---

## 2. Components

```
┌───────────────────────────────────────────────────────────────────┐
│ CLI                                                               │
│  parses url + run options, loads config, starts the run           │
└──────────────────────────────┬────────────────────────────────────┘
                               ▼
┌───────────────────────────────────────────────────────────────────┐
│ ORCHESTRATOR  (the loop)                                          │
│  observe → decide → guard → execute → observe …                   │
│  owns step budget, termination, and run state                     │
└───┬───────────────┬───────────────┬───────────────┬───────────────┘
    ▼               ▼               ▼               ▼
┌────────┐   ┌────────────┐   ┌──────────┐   ┌──────────────┐
│OBSERVER│   │AI DECISION │   │  ACTION  │   │   EVIDENCE   │
│        │   │  CLIENT    │   │  GUARD   │   │   RECORDER   │
└───┬────┘   └─────┬──────┘   └────┬─────┘   └──────┬───────┘
    │              │               │                │
    ▼              ▼               ▼                ▼
┌────────────┐ ┌────────────┐ ┌──────────┐   ┌──────────────┐
│ BROWSER    │ │ AI provider│ │ KEYBOARD │   │  REPORTER    │
│ DRIVER     │ │ (user key) │ │ EXECUTOR │   │  (findings)  │
│ Playwright │ └────────────┘ └────┬─────┘   └──────────────┘
│ + Chromium │                     │
└──────▲─────┘◄────────────────────┘
       │
   page under test (untrusted)
```

### 2.1 CLI

Entry point. Responsibilities:

- Accept the target URL and run options (step budget, output directory, model, headless).
- Load configuration and the AI API key from the environment.
- Refuse to start if the key is missing. Never prompt for it in a way that writes it to
  disk or shell history.
- Hand off to the Orchestrator and print a summary when the run ends.

### 2.2 Orchestrator

Owns the loop and all run-level state:

- current step index and step budget
- keyboard history (ordered)
- navigation history (ordered)
- observation history
- discovered interactive elements
- accumulated findings

Terminates when the AI returns `STOP`, the step budget is exhausted, the page navigates
away from the target origin, or an unrecoverable driver error occurs. Every termination
reason is recorded in the run output.

### 2.3 Browser Driver

The only component that talks to Playwright. Exposes a deliberately small surface:

- `open(url)` — navigate to the target once, at run start.
- `observe()` — produce an `Observation` (see §3.1).
- `press(action)` — execute one allowlisted keyboard action. Accepts the action *after*
  the guard has approved it, and re-validates against the allowlist itself as a second
  line of defence.
- `close()`

There is no `evaluate(script)`, no `click(selector)`, no `goto()` after the initial open,
exposed to any caller upstream. Internal page evaluation used to build observations is
fixed, first-party code — never a string derived from model output.

### 2.4 Observer

Builds the `Observation` from the live page:

- **Screenshot** — viewport PNG, written to the run directory, referenced by path.
- **Focused element** — role, accessible name, tag, id, classes, bounding box, visibility,
  a stable selector/path used only for evidence and identity.
- **DOM summary** — a bounded, structural digest. Not the full DOM. Truncation is
  deliberate and recorded.
- **Accessibility / ARIA snapshot** — from Playwright's accessibility tree, bounded the
  same way.
- **Discovered interactive elements** — every element considered interactive (native
  controls, `tabindex >= 0`, interactive ARIA roles, links with `href`), with a flag for
  whether keyboard traversal has reached it yet.
- **Focus-left-page signal** — whether focus is now on `body`/`null` or otherwise appears
  to have exited the application.

Observations are also the record. Every one is persisted with its step index.

### 2.5 AI Decision Client

Builds the prompt, calls the provider, and validates the response.

**Input to the model** (per step): screenshot, focused element, DOM summary, ARIA
snapshot, discovered interactive elements, keyboard history, navigation history, previous
observations (windowed/summarized to stay within context).

**Output from the model** — a structured `Decision` (see §3.2), validated against a
schema. An invalid response is retried a bounded number of times; if it still fails, the
step is recorded as a decision failure and the run ends rather than guessing.

The client is provider-agnostic behind a small interface so alternative providers can be
added without touching the loop.

### 2.6 Action Guard

Deterministic, non-AI, and the security boundary. Given a `Decision`, it:

1. Confirms `decision` is one of `CONTINUE | INVESTIGATE | REPORT | STOP`.
2. Confirms `next_keyboard_action` is exactly one of the allowlist members
   (`TAB`, `SHIFT_TAB`) — string equality against a frozen set, not a pattern match.
3. Rejects any extra or unexpected fields that could be interpreted as instructions.
4. Rejects a request to act when the decision is `STOP`.
5. Records both the request and the verdict.

A rejected action is never executed. Rejections are surfaced in the run log — a model
repeatedly requesting a disallowed action is itself signal.

### 2.7 Keyboard Executor

Translates an approved action into a Playwright key press:

| Action      | Key press     |
| ----------- | ------------- |
| `TAB`       | `Tab`         |
| `SHIFT_TAB` | `Shift+Tab`   |

This table is the whole implementation. Adding a row is a security-relevant change; see
[SECURITY.md](SECURITY.md).

### 2.8 Evidence Recorder

Accumulates, per step: keyboard action, resulting focused element, screenshot path, DOM/
ARIA excerpt, the model's reasoning and confidence. When a `REPORT` decision arrives, it
assembles the slice of history that constitutes the reproduction.

### 2.9 Reporter

Turns findings into output: machine-readable JSON (the source of truth) and a
human-readable HTML/Markdown report. Findings are deduplicated by finding type plus the
element identity involved.

---

## 3. Contracts

These shapes are the interface between components. Field names are indicative; the
structure is the commitment.

### 3.1 Observation

```
Observation {
  step: int
  url: string
  screenshot_path: string
  focused_element: ElementRef | null
  focus_left_page: bool
  dom_summary: string            // bounded
  aria_snapshot: object          // bounded
  discovered_interactive: ElementRef[]
  truncated: bool
}

ElementRef {
  role: string | null
  name: string | null            // accessible name
  tag: string
  selector: string               // evidence + identity only
  visible: bool
  bounding_box: {x, y, w, h} | null
  tabindex: int | null
  reached_by_keyboard: bool
}
```

### 3.2 Decision

```
Decision {
  decision: "CONTINUE" | "INVESTIGATE" | "REPORT" | "STOP"
  next_keyboard_action: "TAB" | "SHIFT_TAB" | null   // null iff decision == STOP
  reasoning: string
  confidence: float              // 0.0 – 1.0
  suspected_issue: FindingType | null
}
```

### 3.3 Finding

```
Finding {
  type: FindingType
  severity: "low" | "medium" | "high"
  confidence: float
  keyboard_sequence: Action[]        // exact, from step 0
  focus_sequence: ElementRef[]       // parallel to the keyboard sequence
  screenshot_paths: string[]
  dom_evidence: string
  aria_evidence: object
  ai_reasoning: string
  likely_cause: string
  suggested_fix: string
  steps: {from: int, to: int}
}

FindingType =
  | "UNREACHABLE_INTERACTIVE_ELEMENT"
  | "SUSPICIOUS_FOCUS_ORDER"
  | "UNEXPECTED_FOCUS_LEAVING_PAGE"
  | "SUSPICIOUS_FOCUS_CYCLE"
  | "NO_KEYBOARD_REACHABLE_CONTROLS"
```

---

## 4. Finding detection

Findings are produced by the AI's `REPORT` decision, but each type has a deterministic
signal the agent can rely on and the recorder can corroborate. The AI supplies judgement
and explanation; the recorder supplies proof.

| Finding | Deterministic corroboration |
| --- | --- |
| Unreachable interactive element | Element present in `discovered_interactive` but `reached_by_keyboard == false` after traversal is judged complete. |
| Suspicious focus order | Focus sequence order diverges from DOM order / visual reading order. |
| Unexpected focus leaving page | `focus_left_page == true` at a step where the traversal was not expected to exit. |
| Suspicious focus cycle | Focus sequence repeats a cycle that excludes known-reachable elements, or returns to a prior element without covering the set between. |
| No keyboard-reachable controls | `discovered_interactive` is non-empty and no element was ever focused. |

A finding requires **both**: the corroborating signal and the model's `REPORT`. Neither
alone emits a finding. This keeps hallucinated findings out and keeps unexplained
heuristic noise out.

---

## 5. Run output

```
runs/<timestamp>/
  run.json            # config, target, termination reason, step count
  steps/
    0000.json         # observation + decision + guard verdict
    0000.png
    0001.json
    ...
  findings.json       # array of Finding
  report.html         # human-readable
```

The run directory is self-contained: a finding can be reviewed, replayed, and disputed
from it alone. **No API key, no prompt containing credentials, and no raw provider
response containing a key is ever written to it.**

---

## 6. Invariants

Implementation must not violate these.

1. The set of executable keyboard actions is a frozen allowlist in one place.
2. No string derived from model output is ever passed to `page.evaluate`, used as a
   selector, used as a URL, or used to construct a shell command.
3. The action guard runs on every step, with no bypass path.
4. The AI API key exists only in the agent process's memory and environment.
5. Nothing the agent writes to disk contains a secret.
6. Every reportable finding carries a complete keyboard sequence from step 0.
7. The run terminates within the step budget regardless of model behaviour.

---

## 7. Extension points (post-MVP)

Designed for, not built:

- **More keyboard actions** — add to the allowlist and the executor table. Security
  review required.
- **Additional finding types** — add a `FindingType` plus its corroborating signal.
- **Alternative AI providers** — implement the decision-client interface.
- **Multi-page exploration** — currently a single origin, single entry URL.

Out-of-scope items listed in [README.md](README.md) remain out of scope; extension points
are not an invitation to add them.
