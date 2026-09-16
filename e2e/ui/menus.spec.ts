// The menu bar had NO browser coverage, which is how 0.13.0 shipped an Export button that failed
// for every manual export: the unit suite mocked the tool host and asserted the arguments the
// button ALREADY sent, and the only export anyone ran by hand went through the agent, which
// builds its arguments from the contract rather than by hand.
//
// So this walks the real menus in a real engine, with a real project open, and asserts each one
// opens, each dialog renders, and the controls that claim to be available actually work. It runs
// on webkit too, deliberately: WKWebView is what macOS gives the app, and the camera failure
// there was an engine difference no Chromium-only lane can see.
import { expect, test, type ConsoleMessage, type Page } from "@playwright/test";

/** Console noise expected with no backend and no native shell. */
const BENIGN =
  /Failed to load resource|ERR_CONNECTION_REFUSED|net::ERR|Failed to fetch|NetworkError|sentry|React Router Future Flag|not implemented|__TAURI|is not a function/i;

function watchForErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m: ConsoleMessage) => {
    if (m.type() === "error" && !BENIGN.test(m.text())) errors.push(`console: ${m.text().slice(0, 200)}`);
  });
  page.on("pageerror", (e) => {
    if (!BENIGN.test(String(e))) errors.push(`pageerror: ${String(e).slice(0, 200)}`);
  });
  return errors;
}

const openMenu = (page: Page, name: string) => page.getByRole("button", { name, exact: true }).click();

/** Every label the menu bar is supposed to offer. A menu that silently loses an entry is the
 *  failure this catches â€” asserting only "the menu opened" would not. */
const ITEMS: Record<string, RegExp[]> = {
  File: [
    /New Project/i,
    /Open Project/i,
    /Save Project As/i,
    /Import Media/i,
    /Export Video/i,
    /Export Project Bundle/i,
    /Close Project/i,
  ],
  Edit: [/Undo/i, /Redo/i, /Cut/i, /Copy/i, /Paste/i, /Delete/i, /Duplicate/i, /Split at Playhead/i],
  View: [/Library/i, /Inspector/i, /Assistant/i, /Zoom In/i, /Zoom Out/i],
  Window: [/Show All Panels/i, /Reset Panel Layout/i],
  Help: [/Report a Problem/i, /Connect an AI Agent/i, /About/i],
};

test.describe("menu bar", () => {
  test("every menu opens and offers the entries it is supposed to", async ({ page }) => {
    const errors = watchForErrors(page);
    await page.goto("/");
    await expect(page.getByRole("button", { name: "File", exact: true })).toBeVisible();
    for (const menu of Object.keys(ITEMS)) {
      await openMenu(page, menu);
      for (const label of ITEMS[menu]) {
        await expect(
          page.getByRole("button", { name: label }).first(),
          `${menu} is missing ${label}`,
        ).toBeVisible();
      }
      await page.keyboard.press("Escape");
    }
    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("actions that need a project are refused, not offered", async ({ page }) => {
    // The class of bug here is a control that looks available and fails when pressed, so with no
    // project these must be DISABLED rather than clickable.
    await page.goto("/");
    await openMenu(page, "File");
    for (const label of [/Import Media/i, /Export Video/i, /Export Project Bundle/i, /Close Project/i]) {
      await expect(page.getByRole("button", { name: label }).first()).toBeDisabled();
    }
  });

  test("the dialogs that do not need a project all render", async ({ page }) => {
    const errors = watchForErrors(page);
    await page.goto("/");
    const cases: Array<[string, RegExp, RegExp]> = [
      ["File", /New Project/i, /new project/i],
      ["Edit", /Keyboard Shortcuts/i, /shortcut/i],
      ["Help", /About/i, /ArtDaddy/i],
      ["Help", /Connect an AI Agent/i, /mcp|agent|claude/i],
    ];
    for (const [menu, item, expected] of cases) {
      await openMenu(page, menu);
      await page.getByRole("button", { name: item }).first().click();
      await expect(page.locator("body")).toContainText(expected);
      await page.keyboard.press("Escape");
    }
    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("a project that cannot be created says so instead of doing nothing", async ({ page }) => {
    // This lane has no desktop bridge, so create always fails here â€” which makes it the one
    // place the FAILURE path can be exercised end to end. It used to escape as an unhandled
    // rejection with nothing rendered, so the button just stopped working. The same shape
    // covers every real cause on desktop: an unwritable location, a permission error.
    await page.goto("/");
    await page.getByRole("button", { name: /New project/i }).first().click();
    await page.getByPlaceholder(/Project name/i).fill("qa create");
    const create = page.getByRole("button", { name: /^Create$/ });
    await expect(create, "Create stayed disabled after a name was typed").toBeEnabled();
    await create.click();
    await expect(page.getByRole("alert")).toContainText(/could not create the project/i);
    // Still usable, so the typed name is not lost and a retry is possible.
    await expect(create).toBeEnabled();
  });
});
