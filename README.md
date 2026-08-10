# Keyboard Accessibility AI Analyzer

An autonomous keyboard accessibility testing agent.

Give it a URL. It opens the page in Chromium, looks at it, presses keys, watches what
happens, and decides what to press next using an AI model. When it finds something that
looks broken for keyboard users, it writes up a finding with everything needed to
reproduce it.

The AI is an **exploration agent**, not a post-processing classifier. It is in the loop
on every step, choosing the next keyboard action from what it just observed — it is not
handed a finished trace and asked to label it.

> **Status: pre-implementation.** The application shell, tooling, and internal
> architecture are in place. The audit engine is not built yet.

---

## Why

Automated accessibility scanners are good at static rule checks (missing labels, bad
contrast, invalid ARIA). They are bad at the thing keyboard users actually experience:
_moving through a live application with only a keyboard._

Focus traps, skipped controls, focus that silently escapes into browser chrome, tab
order that jumps around the page — these are behavioural, sequential, and stateful. You
find them by walking the page, not by scanning the DOM once.

This project walks the page.

---

## The loop

```
        ┌──────────────────────────────────────────────┐
        │                                              │
        ▼                                              │
    OBSERVE  ──►  AI DECIDES  ──►  ACTION GUARD  ──►  PLAYWRIGHT
   (browser)      NEXT ACTION      (allowlist)        EXECUTES
                                        │             (keyboard only)
                                        │
                                   reject unsafe
                                    or unknown
```

Every iteration:

1. **OBSERVE** — capture the page state after the last keypress.
2. **AI DECIDES NEXT ACTION** — the model gets the observation and returns a structured
   decision.
3. **ACTION GUARD** — a deterministic allowlist validates the requested action. Anything
   not explicitly permitted is rejected before it reaches the browser.
4. **PLAYWRIGHT EXECUTES** — a single allowed keyboard action, nothing else.
5. **OBSERVE NEW STATE** — and around again.

The AI never executes browser commands. It names an action; the guard decides whether
that action is allowed to happen. See [SECURITY.md](SECURITY.md).

---

## Scope (MVP)

### Keyboard actions the agent may perform

| Action      | Meaning             |
| ----------- | ------------------- |
| `TAB`       | Move focus forward  |
| `SHIFT_TAB` | Move focus backward |

That is the entire allowlist. Nothing else can be executed, by anyone, including the AI.

### Decisions the agent may return

| Decision      | Meaning                                                     |
| ------------- | ----------------------------------------------------------- |
| `CONTINUE`    | Nothing notable; keep exploring.                            |
| `INVESTIGATE` | Something looks off; keep going deliberately to confirm it. |
| `REPORT`      | Confident enough to emit a finding with evidence.           |
| `STOP`        | Exploration is complete or no further progress is possible. |

### What the AI sees each step

- Screenshot of the current viewport
- Currently focused element
- DOM summary
- Accessibility / ARIA snapshot
- Discovered interactive elements
- Keyboard history (every key pressed so far, in order)
- Navigation history
- Previous observations

### What the AI returns each step

- `decision` — one of the four above
- `next_keyboard_action` — one of the allowlisted actions
- `reasoning` — why
- `confidence` — how sure
- `suspected_issue` — when applicable

### Findings the MVP can produce

- **Unreachable interactive element** — an interactive control that keyboard traversal
  never reaches.
- **Suspicious focus order** — tab order that does not follow a sensible reading or
  visual order.
- **Unexpected focus leaving the application/page** — focus escapes to browser chrome or
  out of the app when it shouldn't.
- **Suspicious focus cycle** — focus loops in a way that suggests a trap or a broken
  cycle.
- **No keyboard-reachable interactive controls** — the page has interactive elements and
  the keyboard reaches none of them.

### Evidence attached to every reportable finding

A finding is not a claim; it is a reproduction. Each one carries:

- Exact keyboard sequence
- Focused element sequence
- Screenshot
- DOM / ARIA evidence
- AI reasoning
- Severity
- Confidence
- Likely cause
- Suggested fix

---

## Explicitly out of scope

These are **not** in the MVP. They are listed so nobody has to guess.

**Keys not implemented:** Enter, Space, Escape, Arrow keys, Home, End.

**Capabilities not implemented:** screen reader automation, color contrast checking, a
full WCAG scanner, a browser extension, authentication, user accounts, a cloud database,
team features, CI integration, automatic code patches.

Proposals to add any of these are welcome as discussion, but they will not land in the
MVP. See [CONTRIBUTING.md](CONTRIBUTING.md).

---

## AI provider and API keys

You bring your own AI API key.

- The key is read from the environment (or a local, git-ignored config file) by the
  Node-side agent process.
- The key is **never** hard-coded.
- The key is **never** sent to, injected into, or made reachable from the browser page
  under test.
- No secret is ever committed.

See [SECURITY.md](SECURITY.md) for the full handling rules.

---

## Getting started

Requires Node.js 20.9+ and pnpm.

```bash
pnpm install
pnpm exec playwright install chromium
cp .env.example .env.local   # then add your own AI API key
pnpm dev
```

### Scripts

| Script           | What it does                                 |
| ---------------- | -------------------------------------------- |
| `pnpm dev`       | Development server                           |
| `pnpm build`     | Production build                             |
| `pnpm start`     | Serve the production build                   |
| `pnpm typecheck` | `tsc --noEmit`                               |
| `pnpm lint`      | ESLint                                       |
| `pnpm format`    | Prettier, writing changes                    |
| `pnpm test`      | Vitest (unit + integration)                  |
| `pnpm test:e2e`  | Playwright (e2e; starts a dev server)        |
| `pnpm verify`    | typecheck + lint + format check + unit tests |

### Stack

A single Next.js application — UI, API route handlers, and server-side audit
orchestration in one deployable. There is no separate backend.

Next.js (App Router) · TypeScript (strict) · Tailwind CSS · shadcn/ui · Playwright ·
Vitest · Zod · pnpm

### Layout

```
src/
  app/          UI routes and API route handlers
  components/   UI components (shadcn/ui in components/ui)
  lib/
    agent/      orchestration loop, agent state, action guard
    ai/         decision client — holds the API key, server-only
    browser/    the only module allowed to import Playwright
    discovery/  interactive element discovery and reachability
    evidence/   screenshots, step records, reproduction bundles
    graph/      navigation graph — nodes, edges, cycle detection
    report/     findings output
    rules/      deterministic corroborating signals per finding type
    shared/     domain model, env parsing, utilities
tests/
  fixtures/     test pages and shared test data
  unit/         Vitest
  integration/  Vitest
  e2e/          Playwright
```

Each `src/lib/*` directory has a README describing its responsibility and its
constraints.

**Playwright and AI code are server-only.** ESLint blocks client code from importing
them, and `src/lib/shared/env.ts` imports `server-only` so the API key cannot reach a
browser bundle.

---

## Documents

| Document                                   | What's in it                                 |
| ------------------------------------------ | -------------------------------------------- |
| [ARCHITECTURE.md](ARCHITECTURE.md)         | Components, data flow, contracts, invariants |
| [SECURITY.md](SECURITY.md)                 | Threat model, action guard, secret handling  |
| [CONTRIBUTING.md](CONTRIBUTING.md)         | How to propose and land changes              |
| [docs/ENVIRONMENT.md](docs/ENVIRONMENT.md) | Every environment variable, and the rules    |

---

## License

Open source. License to be finalized before the first release; the intent is a
permissive OSI-approved license (MIT).
