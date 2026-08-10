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

Structured data only, validated with Zod before anything happens:

- `decision` — one of the four above
- `action` — an allowlisted action, on `CONTINUE` and `INVESTIGATE`
- `reason` — why
- `confidence` — 0 to 1
- `suspectedIssue` — `{ type, severity }`, required on `INVESTIGATE`
- `issue` — `{ type, severity, title, description }`, required on `REPORT`

```json
{
  "decision": "CONTINUE",
  "action": "TAB",
  "reason": "Continue exploring sequential keyboard navigation.",
  "confidence": 0.94
}
```

Malformed responses are rejected. **The browser executes nothing until the
response passes schema validation**, and a rejected response never falls back to
a default action. See [ARCHITECTURE.md §3.2](ARCHITECTURE.md).

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

```bash
AI_PROVIDER=openai
OPENAI_API_KEY=sk-…
OPENAI_MODEL=gpt-4o
```

- The key is read from the environment (or a local, git-ignored config file) by the
  Node-side agent process.
- The key is **never** hard-coded.
- The key is **never** sent to, injected into, or made reachable from the browser page
  under test.
- No secret is ever committed.

**If the key is missing, the audit fails immediately** with
`AI provider is not configured. Set OPENAI_API_KEY.` There is no fallback: the tool
will not quietly substitute a mock provider, because a report full of fabricated
findings that looks real is worse than no report.

The application depends on an `AIProvider` interface, not on a vendor. The OpenAI SDK
is imported in exactly one file, and ESLint fails the build if anything else imports
it — so adding a provider is a new file rather than a refactor.

See [SECURITY.md](SECURITY.md) for the full handling rules.

---

## API

```bash
curl -X POST http://localhost:3000/api/audits \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com"}'
# → 202 { "auditId": "..." }

curl http://localhost:3000/api/audits/<id>
# → { "id", "status", "step", "url", "result", "error", ... }

curl -X DELETE http://localhost:3000/api/audits/<id>
# → cancels a run in progress
```

`status` is `queued | running | completed | failed | cancelled`. `result` is the
report once the audit finishes, and `null` before that.

A run that exhausts its step or time budget still **completes**, with a partial
report whose `terminationReason` says why — a truncated traversal is a result to
read carefully, not an error. Only a browser or AI failure marks a run `failed`.

### ⚠️ The MVP needs a long-running Node.js server

There is no queue and no database. Audits are held **in memory in a single Node
process**, and the run continues after the POST has already responded. That
means:

- **Deploy to something that stays up** — `next start` on a machine you control,
  or a container. A serverless platform that freezes or recycles the process
  once a response is sent will abandon the audit mid-run.
- **One instance only.** Behind a load balancer, a client polling its audit will
  hit a different instance and get a 404.
- **Restarts lose everything.** Finished reports are written to `EVIDENCE_DIR`;
  the in-memory registry is not persisted.

This is a deliberate MVP shortcut, marked as such in
[`lib/agent/audit-registry.ts`](src/lib/agent/audit-registry.ts). A queue and a
store are the obvious next step.

### What the API never returns

No API key, no environment variable, no server filesystem path. Error responses
are coded and phrased for a human; the underlying cause is never passed through,
because a driver error can carry a local path and a provider error can echo a
request header.

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
