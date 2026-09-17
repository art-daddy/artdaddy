// The library thumbnail grid was hardcoded to two columns, so dragging the pane wider only made
// the tiles bigger. It is responsive now — and the rule is CSS the unit suite cannot see: jsdom
// has no layout engine, so `grid-template-columns` there is the declaration, never the resolved
// tracks. Only a real engine can tell "2 columns" from "a declaration that says it wants 2".
//
// It runs on webkit too, deliberately: `minmax(max(min(…)))` is exactly the kind of nested CSS
// maths where engines diverge, and WKWebView is what macOS gives the app.
import { expect, test, type Page } from "@playwright/test";

/** Resolved column count for a `.library-grid` rendered inside a pane `width` px wide. */
async function columnsAt(page: Page, width: number): Promise<{ columns: number; tile: number }> {
  return page.evaluate((w) => {
    const pane = document.createElement("div");
    pane.style.cssText = `position:fixed;left:-9999px;top:0;width:${w}px`;
    const grid = document.createElement("div");
    grid.className = "library-grid";
    for (let i = 0; i < 12; i++) grid.appendChild(document.createElement("div"));
    pane.appendChild(grid);
    document.body.appendChild(pane);
    const tracks = getComputedStyle(grid).gridTemplateColumns.split(" ").filter(Boolean);
    pane.remove();
    return { columns: tracks.length, tile: Math.round(parseFloat(tracks[0])) };
  }, width);
}

test.describe("library thumbnail grid", () => {
  test.beforeEach(async ({ page }) => {
    // The stylesheet is what this lane is after, not a finished app, so it does not wait on
    // `load` — the shell keeps fetching a backend that is not running here. The poll below is
    // the real readiness signal.
    await page.goto("/", { waitUntil: "domcontentloaded" });
    // The rule has to come from the app's OWN stylesheet — a copy pasted into the test would
    // pass forever while the shipped one said something else.
    await expect
      .poll(async () => (await columnsAt(page, 300)).columns, { timeout: 15_000 })
      .toBe(3);
  });

  test("widens from 2 columns to 3 to 4 as the pane is dragged out", async ({ page }) => {
    expect((await columnsAt(page, 240)).columns).toBe(2);
    expect((await columnsAt(page, 320)).columns).toBe(3);
    expect((await columnsAt(page, 440)).columns).toBe(4);
  });

  // The failure direction that matters at the narrow end: one enormous tile per row, which is
  // what a plain `auto-fill` minimum gives a pane squeezed to its minimum size.
  test("never drops below 2 columns, however narrow the pane gets", async ({ page }) => {
    for (const w of [120, 140, 170, 200]) {
      const { columns } = await columnsAt(page, w);
      expect(columns, `pane ${w}px`).toBe(2);
    }
  });

  // And at the wide end: unbounded auto-fill keeps adding columns until a thumbnail is too
  // small to recognise a shot by.
  test("stops at 4 columns however wide the pane gets", async ({ page }) => {
    for (const w of [500, 700, 900, 1200]) {
      const { columns } = await columnsAt(page, w);
      expect(columns, `pane ${w}px`).toBe(4);
    }
  });

  // The point of widening the pane is to see MORE, not the same three tiles blown up.
  test("a wider pane shows more tiles, not bigger ones, until it adds a column", async ({
    page,
  }) => {
    const narrow = await columnsAt(page, 240);
    const wide = await columnsAt(page, 440);
    expect(wide.columns).toBeGreaterThan(narrow.columns);
    expect(wide.tile).toBeLessThan(narrow.tile);
  });
});
