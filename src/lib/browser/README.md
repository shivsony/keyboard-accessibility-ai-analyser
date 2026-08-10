# `lib/browser`

The only module permitted to import Playwright.

Exposes a deliberately narrow driver: `open(url)`, `observe()`, `press(action)`,
`close()`. No `evaluate(script)`, no selector-driven clicking, no post-open navigation
is exposed upstream.

`press` re-validates its argument against the frozen keyboard allowlist — defence in
depth behind the agent's action guard.

Server-only.
