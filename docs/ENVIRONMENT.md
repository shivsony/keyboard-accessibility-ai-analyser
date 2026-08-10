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

| Variable            | Description                                                                                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ANTHROPIC_API_KEY` | Your own API key, used for the agent's decision step. Get one at [console.anthropic.com](https://console.anthropic.com/settings/keys). You pay for your own usage. |

### AI

| Variable   | Default         | Description                       |
| ---------- | --------------- | --------------------------------- |
| `AI_MODEL` | `claude-opus-5` | Model used for the decision step. |

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
