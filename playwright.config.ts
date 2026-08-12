import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.PORT ?? 3000);
// localhost rather than 127.0.0.1: Next's dev server treats the latter as a
// cross-origin host and logs a warning on every HMR request.
const BASE_URL = process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`;

/**
 * E2E suite for the application's own UI.
 *
 * Note: this is Playwright-as-test-runner. The agent's own use of Playwright to
 * drive a target page is a separate, server-side concern living in
 * src/lib/browser — the two must not be conflated.
 */
export default defineConfig({
  testDir: "./tests/e2e",
  // See tsconfig.e2e.json: the agent tests import server-only modules, which a
  // plain test runner cannot resolve without a stub.
  tsconfig: "./tsconfig.e2e.json",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  ...(process.env.CI ? { workers: 1 } : {}),
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  // Start a dev server unless E2E_BASE_URL points at one already running.
  ...(process.env.E2E_BASE_URL
    ? {}
    : {
        webServer: {
          // A production build, not `next dev`. The dev overlay renders a
          // focusable <nextjs-portal> element that joins the tab order, which
          // would make every fixture's expected focus order wrong — and would
          // be testing a page that does not exist in production.
          command: "pnpm build && pnpm start",
          url: BASE_URL,
          reuseExistingServer: !process.env.CI,
          timeout: 300_000,
        },
      }),
});
