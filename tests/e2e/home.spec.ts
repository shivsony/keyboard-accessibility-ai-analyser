import { expect, test } from "@playwright/test";

/**
 * The home page.
 *
 * Includes a keyboard pass over the page itself. A tool that audits keyboard
 * accessibility and cannot be operated from the keyboard would be embarrassing,
 * and the check costs almost nothing.
 */

test.beforeEach(async ({ page }) => {
  await page.goto("/");
});

test("presents the product and what it does", async ({ page }) => {
  await expect(
    page.getByRole("heading", { name: "Keyboard Accessibility AI Analyzer" }),
  ).toBeVisible();

  await expect(
    page.getByText(
      "Let an AI keyboard user explore your web app and find accessibility problems.",
    ),
  ).toBeVisible();
});

// Stated before the user starts: this launches a browser and spends their own
// API budget.
test("warns that it runs browser automation and needs a provider", async ({ page }) => {
  await expect(
    page.getByText(
      "This tool runs browser automation and requires your configured AI provider.",
    ),
  ).toBeVisible();
});

test("offers a URL field and an Analyze button", async ({ page }) => {
  await expect(page.getByLabel("URL to analyze")).toBeVisible();
  await expect(page.getByRole("button", { name: "Analyze" })).toBeVisible();
});

test("rejects a URL that is not absolute, without calling the server", async ({
  page,
}) => {
  let requested = false;
  await page.route("**/api/audits", (route) => {
    requested = true;
    return route.abort();
  });

  await page.getByLabel("URL to analyze").fill("example.com");
  await page.getByRole("button", { name: "Analyze" }).click();

  // Targeted by id: Next's route announcer is also role="alert".
  await expect(page.locator("#audit-url-error")).toHaveText(
    "Enter an absolute URL starting with http:// or https://",
  );
  expect(requested).toBe(false);
});

test("surfaces a server error rather than failing silently", async ({ page }) => {
  await page.route("**/api/audits", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        error: {
          code: "AI_NOT_CONFIGURED",
          message: "AI provider is not configured. Set OPENAI_API_KEY.",
        },
      }),
    }),
  );

  await page.getByLabel("URL to analyze").fill("https://example.com");
  await page.getByRole("button", { name: "Analyze" }).click();

  await expect(page.locator("#audit-url-error")).toHaveText(
    "AI provider is not configured. Set OPENAI_API_KEY.",
  );
});

test("sends the user to the live view once the audit starts", async ({ page }) => {
  await page.route("**/api/audits", (route) =>
    route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({ auditId: "11111111-1111-1111-1111-111111111111" }),
    }),
  );

  await page.route("**/api/audits/*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: "11111111-1111-1111-1111-111111111111",
        status: "running",
        step: 0,
        url: "https://example.com",
        createdAt: new Date(0).toISOString(),
        startedAt: new Date(0).toISOString(),
        completedAt: null,
        live: null,
        result: null,
        error: null,
      }),
    }),
  );

  await page.getByLabel("URL to analyze").fill("https://example.com");
  await page.getByRole("button", { name: "Analyze" }).click();

  await expect(page).toHaveURL(/\/audits\/11111111-1111-1111-1111-111111111111$/);
});

test("is operable with the keyboard alone", async ({ page }) => {
  // Tab to the field, type, Tab to the button. If this ever needs a mouse, the
  // tool has failed at the thing it exists to check for.
  await page.keyboard.press("Tab");
  await page.keyboard.type("not-a-url");
  await page.keyboard.press("Tab");

  await expect(page.getByRole("button", { name: "Analyze" })).toBeFocused();
});

test("has no accounts, billing, settings, or chat", async ({ page }) => {
  const text = (await page.locator("body").innerText()).toLowerCase();

  for (const absent of ["sign in", "log in", "account", "billing", "upgrade", "chat"]) {
    expect(text).not.toContain(absent);
  }
});

// A score would invite comparison between pages explored to different depths.
// Checked as a *displayed value*, not as the word: the page legitimately says it
// does not produce one.
test("shows no score", async ({ page }) => {
  const text = await page.locator("body").innerText();

  expect(text).not.toMatch(/\b\d{1,3}\s*\/\s*100\b/);
  expect(text).not.toMatch(/\b(score|grade|rating)\s*[:=]\s*\d/i);
  expect(text).not.toMatch(/\b\d{1,3}%\s*(accessible|compliant|pass)/i);
});
