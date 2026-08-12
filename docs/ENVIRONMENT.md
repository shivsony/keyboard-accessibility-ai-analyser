# Environment variables

All configuration is read **server-side only**, in `src/lib/shared/env.ts`. That module
imports `server-only`, so importing it from a client component is a build error rather
than a leak.

## Setup

```bash
cp .env.example .env.local
```

Then edit `.env.local` and add your own AI API key. `.env*` is git-ignored, with
`.env.example` as the single deliberate exception.

## Rules

1. **Never prefix any of these with `NEXT_PUBLIC_`.** That prefix ships the value into
   the browser bundle, where the page under test can read it.
2. **Never commit a real value.** `.env.example` contains placeholders only. A key that
   reaches a commit is compromised — rotate it, don't just delete the line.
3. **Never log a value.** `parseEnv` reports which variables are wrong, never what they
   contain, because error strings end up in logs and bug reports.
4. **Never write a value to the run directory.** Run directories are shareable
   artifacts; people attach them to issues.

See [SECURITY.md](../SECURITY.md) §4 for the full handling rules.

## Reference

### Required

| Variable         | Description                                                                                                                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `OPENAI_API_KEY` | Your own API key, used for the agent's decision step. Get one at [platform.openai.com](https://platform.openai.com/api-keys). You pay for your own usage. Without it the audit refuses to start. |

If it is missing, the audit fails immediately with:

> AI provider is not configured. Set OPENAI_API_KEY.

There is no fallback. The tool will not substitute a mock provider and produce
fabricated findings — a report nobody knows to distrust is worse than no report.

### AI

| Variable          | Default           | Description                                                                                                                                                                                                                      |
| ----------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AI_PROVIDER`     | `openai`          | Which provider to use. `openai` is the only supported value today; anything else fails at startup.                                                                                                                               |
| `OPENAI_MODEL`    | `gpt-4o-mini`     | Model for the decision step. Needs structured outputs, and vision to see screenshots. Roughly a sixteenth of `gpt-4o` per input token.                                                                                           |
| `AI_MODE`         | `decision-points` | `decision-points` sweeps the page in code and calls the model only where a judgement is needed — a clean page may cost no calls at all. `every-step` restores the original behaviour, at roughly ten times the calls and tokens. |
| `AI_IMAGE_DETAIL` | `low`             | `low` is a flat 85 tokens per screenshot; `high` tiles a 1280×800 viewport into ~1,105. Low still conveys layout and reading order.                                                                                              |
| `AI_IMAGE_MODE`   | `required`        | `text-only` for a model without vision. `required` fails a step whose screenshot is missing rather than silently continuing and reporting as though the agent had seen the page.                                                 |

### Agent limits

| Variable          | Default | Description                                                                                                                                  |
| ----------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `AGENT_MAX_STEPS` | `150`   | Hard ceiling on loop iterations. Guarantees a run terminates regardless of what the model decides (ARCHITECTURE.md invariant 7). Max `1000`. |
| `AGENT_SETTLE_MS` | `250`   | Milliseconds to wait after a keypress before observing, so focus and animations settle. Max `10000`.                                         |

### Browser

| Variable                  | Default | Description                                                          |
| ------------------------- | ------- | -------------------------------------------------------------------- |
| `BROWSER_HEADLESS`        | `true`  | Set `false` to watch the agent work. Accepts `true`/`false`/`1`/`0`. |
| `BROWSER_VIEWPORT_WIDTH`  | `1280`  | Viewport width for observation and screenshots.                      |
| `BROWSER_VIEWPORT_HEIGHT` | `800`   | Viewport height for observation and screenshots.                     |

Chromium always runs with a fresh, ephemeral profile. There is no setting to reuse your
real browser profile, and there will not be one.

### Evidence

| Variable       | Default  | Description                                                                 |
| -------------- | -------- | --------------------------------------------------------------------------- |
| `EVIDENCE_DIR` | `./runs` | Directory for run artifacts: screenshots, step logs, findings. Git-ignored. |

### Test-only

These are not read by the application.

| Variable       | Description                                                                          |
| -------------- | ------------------------------------------------------------------------------------ |
| `E2E_BASE_URL` | Point the Playwright e2e suite at an already-running server instead of starting one. |
| `PORT`         | Dev server port; the e2e config follows it.                                          |
| `CI`           | Set by CI. Enables retries, disables `test.only`, and switches the reporter.         |
