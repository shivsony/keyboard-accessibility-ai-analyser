# Contributing

Thanks for looking. This project is open source and contributions are welcome.

Read [ARCHITECTURE.md](ARCHITECTURE.md) and [SECURITY.md](SECURITY.md) first — most
review feedback on this repository is going to be about the invariants in those two
documents, so knowing them ahead of time saves everyone a round trip.

> **The project is pre-implementation.** Right now the most valuable contributions are
> to the design: challenging the contracts, poking holes in the threat model, and
> sharpening the finding definitions.

---

## What this project is

An autonomous keyboard accessibility agent. It opens a URL, presses Tab and Shift+Tab,
observes what happens, and uses an AI model _in the loop_ to decide what to press next
and when something looks wrong.

The AI is an exploration agent, not a classifier that post-processes a finished trace.
Changes that turn the loop into "collect everything, then ask the model once" are moving
away from the project's premise.

---

## What is in scope

**Keyboard actions:** `TAB`, `SHIFT_TAB`. That's the whole allowlist.

**Decisions:** `CONTINUE`, `INVESTIGATE`, `REPORT`, `STOP`.

**Findings:**

- unreachable interactive element
- suspicious focus order
- unexpected focus leaving the application/page
- suspicious focus cycle
- no keyboard-reachable interactive controls

---

## What is out of scope

Not "not yet prioritized" — **out of scope for the MVP**, deliberately:

Enter · Space · Escape · Arrow keys · Home · End · screen reader automation · color
contrast · a full WCAG scanner · a browser extension · authentication · accounts · a
cloud database · team features · CI integration · automatic code patches

PRs implementing these will be closed regardless of quality. If you think one belongs in
the MVP, open a discussion and make the case before writing code. Nobody enjoys closing a
good PR.

Adding a keyboard action is additionally a **security change** — see
[SECURITY.md §2](SECURITY.md).

---

## Ways to contribute

**Design review.** Read the contracts in ARCHITECTURE.md §3 and tell us where they break.
Is `Observation` missing something the model needs to make a good decision? Does the
`Finding` shape fail to reproduce some real bug you've hit?

**Threat model review.** Try to break the property in SECURITY.md §1: that a hostile page
can influence, at most, which of two keys gets pressed. If you find a path where page
content or model output does more than that, that's the highest-value contribution
available.

**Finding definitions.** "Suspicious focus order" is judgement. What makes it suspicious
enough to report, and what makes it a false positive? Concrete examples are worth more
than adjectives.

**Test pages.** Small, self-contained HTML pages that exhibit exactly one keyboard bug —
a focus trap, an unreachable control, a scrambled tab order. These become the fixture
suite. Real-world reductions are especially welcome.

**Real-world reports.** A page where a keyboard user gets stuck, with a description of
what went wrong. Even without code.

**Implementation.** Once the design settles. Claim an issue before starting substantial
work so two people don't build the same component.

---

## Ground rules

**Discuss before building anything substantial.** Open an issue or discussion first. This
is cheap and prevents the worst outcome — someone spending a weekend on something that
gets closed.

**One concern per PR.** A PR that fixes a bug, refactors a module, and adds a feature is
three reviews wearing a trenchcoat.

**Don't weaken the guard.** The action guard runs on every step, with no bypass, no debug
flag, and no config option that disables it. A PR that adds one won't land.

**Never commit a secret.** No API keys in code, tests, fixtures, docs, or config
defaults — see [SECURITY.md §4](SECURITY.md). If you commit one by accident, say so
immediately and rotate it; removing it from HEAD is not enough.

**Never let model output become a command.** Model-produced strings are displayed and
stored, never used to build a selector, URL, file path, shell command, or `evaluate`
argument.

**Deterministic code stays deterministic.** The guard, executor, recorder, and reporter
are plain code. Don't move judgement into them, and don't move determinism into the
model.

---

## Pull requests

1. Fork and branch from `main`.
2. Keep the diff focused.
3. Explain in the description _what changed and why_, and call out anything that touches
   the allowlist, the guard, secret handling, or the contracts in ARCHITECTURE.md §3.
4. Work through the security checklist in [SECURITY.md §10](SECURITY.md).
5. Update the docs in the same PR when behaviour changes. A contract change that doesn't
   update ARCHITECTURE.md is incomplete.

Commit messages: imperative mood, a subject line that says what changed, and a body
explaining why when it isn't obvious.

---

## Reporting bugs

Include:

- What you ran it against (a URL, or a reduced HTML file — a reduction is much better)
- What you expected
- What happened
- The run directory if you have one — **check it for anything sensitive before attaching**

For agent-quality issues (a bogus finding, or a real bug it missed), include the finding
JSON and the model's reasoning. That reasoning is usually where the problem is visible.

---

## Security issues

Do not open a public issue. Use GitHub's private "Report a vulnerability" flow — see
[SECURITY.md §9](SECURITY.md).

---

## Conduct

Be decent to each other. Assume good faith, critique the work rather than the person, and
remember that a lot of people here care about accessibility because it affects them
directly.

Behaviour that makes this an unpleasant place to contribute gets people removed from it.
