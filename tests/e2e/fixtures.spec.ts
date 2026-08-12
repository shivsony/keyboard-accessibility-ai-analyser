import { expect, test } from "@playwright/test";

import { FIXTURES, findFixture } from "@/lib/fixtures/manifest";

/**
 * The fixtures behave the way the manifest says they do.
 *
 * This suite uses no AI at all. It checks the *browser* half of every
 * expectation, which is the half everything else rests on: if a fixture's real
 * focus order differs from its documented one, then every agent test built on
 * it is asserting against a fiction.
 *
 * Determinism is checked too. A fixture that answers differently on a second
 * pass cannot support an expectation.
 */

/** The accessible name of whatever currently has focus, or null for none. */
async function focusedName(
  page: import("@playwright/test").Page,
): Promise<string | null> {
  return page.evaluate(() => {
    const active = document.activeElement;
    if (active === null || active === document.body) return null;

    const ariaLabel = active.getAttribute("aria-label");
    if (ariaLabel !== null && ariaLabel !== "") return ariaLabel;

    if (active.id !== "") {
      const label = document.querySelector(`label[for="${CSS.escape(active.id)}"]`);
      const text = label?.textContent?.trim();
      if (text !== undefined && text !== "") return text;
    }

    const text = active.textContent?.trim();
    return text !== undefined && text !== "" ? text : active.tagName;
  });
}

/**
 * Every focus position a keyboard user occupies, in order.
 *
 * Starts from wherever focus already is — a fixture that focuses a dialog on
 * open has occupied its first position before any key is pressed, and a walk
 * that ignored that would report a different page than the one a user meets.
 */
async function walkFocus(
  page: import("@playwright/test").Page,
  limit: number,
): Promise<string[]> {
  const seen: string[] = [];

  const initial = await focusedName(page);
  if (initial !== null) seen.push(initial);

  while (seen.length < limit) {
    await page.keyboard.press("Tab");
    const name = await focusedName(page);
    if (name === null) break;
    seen.push(name);
  }

  return seen;
}

/** Tabs `count` times and records the accessible name at each stop. */
async function tabThrough(
  page: import("@playwright/test").Page,
  count: number,
): Promise<string[]> {
  const seen: string[] = [];

  for (let index = 0; index < count; index += 1) {
    await page.keyboard.press("Tab");

    const label = await page.evaluate(() => {
      const active = document.activeElement;
      if (active === null || active === document.body) return null;

      // The accessible name, roughly as assistive technology would compute it.
      // An <input> has no text content, so falling back to textContent alone
      // would report it as an empty string.
      const ariaLabel = active.getAttribute("aria-label");
      if (ariaLabel !== null && ariaLabel !== "") return ariaLabel;

      if (active.id !== "") {
        const label = document.querySelector(`label[for="${CSS.escape(active.id)}"]`);
        const text = label?.textContent?.trim();
        if (text !== undefined && text !== "") return text;
      }

      const text = active.textContent?.trim();
      return text !== undefined && text !== "" ? text : active.tagName;
    });

    if (label === null) break;
    seen.push(label);
  }

  return seen;
}

test.describe("every fixture", () => {
  for (const fixture of FIXTURES) {
    test(`${fixture.id} exposes only its own controls`, async ({ page }) => {
      await page.goto(fixture.path);

      // Measured by walking focus rather than by selector: a `display: none`
      // button matches every "focusable" selector ever written and takes no
      // focus. The layout must contribute nothing — one stray link and every
      // expected focus order in the manifest is wrong.
      const reached = await walkFocus(page, fixture.expectedFocusOrder.length);

      expect(reached).toEqual(fixture.expectedFocusOrder);
    });
  }
});

test.describe("initial focus", () => {
  for (const fixture of FIXTURES) {
    test(`${fixture.id} starts focus where the manifest says`, async ({ page }) => {
      await page.goto(fixture.path);

      // Read before any key is pressed. A page that focuses a dialog on open
      // has already occupied a position, and a traversal starting elsewhere
      // would be exploring a different page than a user meets.
      expect(await focusedName(page)).toBe(fixture.initialFocus);
    });
  }
});

test.describe("focus order matches the manifest", () => {
  test("good: four controls in reading order", async ({ page }) => {
    await page.goto("/fixtures/good");

    expect(await tabThrough(page, 5)).toEqual(findFixture("good")?.expectedFocusOrder);
  });

  test("unreachable: the role=button div is skipped", async ({ page }) => {
    await page.goto("/fixtures/unreachable");
    const reached = await tabThrough(page, 4);

    expect(reached).toEqual(["Before", "After"]);
    expect(reached).not.toContain("Delete account");

    // It is present and visible — a mouse user sees a button.
    await expect(page.getByRole("button", { name: "Delete account" })).toBeVisible();
  });

  test("focus-order: positive tabindex reverses the order", async ({ page }) => {
    await page.goto("/fixtures/focus-order");

    expect(await tabThrough(page, 4)).toEqual([
      "Third visually",
      "Second visually",
      "First visually",
    ]);
  });

  test("focus-escape: focus leaves the dialog", async ({ page }) => {
    await page.goto("/fixtures/focus-escape");

    // Focus starts inside the dialog.
    await expect(page.getByRole("button", { name: "Confirm" })).toBeFocused();

    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Cancel" })).toBeFocused();

    // The escape: a modal should not let Tab reach the page behind it.
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Background action" })).toBeFocused();
  });

  test("dynamic: options appear on focus and are reachable", async ({ page }) => {
    await page.goto("/fixtures/dynamic");

    expect(await tabThrough(page, 5)).toEqual([
      "Show options",
      "Option A",
      "Option B",
      "Done",
    ]);
  });

  test("custom-controls: all three are reachable", async ({ page }) => {
    await page.goto("/fixtures/custom-controls");

    expect(await tabThrough(page, 4)).toEqual([
      "Custom button",
      "Custom checkbox",
      "Custom slider",
    ]);
  });

  test("cycle: focus loops and never escapes", async ({ page }) => {
    await page.goto("/fixtures/cycle");
    await expect(page.getByRole("button", { name: "Trapped one" })).toBeFocused();

    const visited: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      await page.keyboard.press("Tab");
      visited.push(
        (await page.evaluate(() => document.activeElement?.textContent?.trim())) ?? "",
      );
    }

    expect(new Set(visited)).toEqual(new Set(["Trapped one", "Trapped two"]));
    expect(visited).not.toContain("Outside the trap");
  });

  test("disabled: only the enabled control is reachable", async ({ page }) => {
    await page.goto("/fixtures/disabled");
    const reached = await tabThrough(page, 4);

    expect(reached).toEqual(["Enabled action"]);
    for (const skipped of [
      "Disabled action",
      "Hidden from assistive technology",
      "Not displayed",
    ]) {
      expect(reached).not.toContain(skipped);
    }
  });

  test("no-controls: nothing takes focus", async ({ page }) => {
    await page.goto("/fixtures/no-controls");

    expect(await tabThrough(page, 3)).toEqual([]);
  });
});

// An expectation is only worth writing down if the page honours it every time.
test.describe("determinism", () => {
  for (const fixture of FIXTURES) {
    test(`${fixture.id} produces the same focus order twice`, async ({ page }) => {
      const depth = fixture.expectedFocusOrder.length;

      await page.goto(fixture.path);
      const first = await walkFocus(page, depth);

      await page.reload();
      const second = await walkFocus(page, depth);

      expect(second).toEqual(first);
      expect(first).toEqual(fixture.expectedFocusOrder);
    });
  }
});
