// In-app dragging, driven by a REAL mouse in a REAL browser.
//
// `beginDrag` resolves the drop with `document.elementFromPoint`, which is a pure LAYOUT
// question: which box is on top at this pixel. happy-dom has no layout and no compositing, so
// the unit suite answers it with a stub — it would pass unchanged if the ghost swallowed every
// drop, or if the drop always landed on the first zone regardless of the cursor. Only a real
// browser can tell "dropped on the zone under the cursor" from "dropped somewhere".
//
// The production zones (library / timeline lane) can't be reached here: projects resolve through
// Tauri's `dataDir()`, so no project can be opened in a browser and neither FileTree nor
// TimelineEditor ever mounts. What IS shared with production is the module below — the same
// `beginDrag` both call — so this drives it against real boxes of its own.
import { expect, test, type Page } from "@playwright/test";

/** Lay out two real, non-overlapping drop boxes plus a drag handle, and wire up the REAL module. */
async function harness(page: Page) {
  await page.evaluate(async () => {
    const mod = (await import("/src/lib/dragSource.ts")) as typeof import("../../src/lib/dragSource");
    document.body.innerHTML = "";
    document.body.style.margin = "0";
    const box = (id: string, left: number) => {
      const el = document.createElement("div");
      el.id = id;
      el.style.cssText = `position:fixed;top:200px;left:${left}px;width:150px;height:150px;background:#333`;
      document.body.appendChild(el);
      return el;
    };
    box("zone-a", 300);
    box("zone-b", 600);
    const handle = box("handle", 20);

    const w = window as unknown as { __drops: string[]; __underCursor: string[] };
    w.__drops = [];
    w.__underCursor = [];
    handle.addEventListener("pointerdown", (e) => {
      mod.beginDrag(e, { ref: "media-1", name: "ghost-probe" }, (target) => {
        w.__drops.push(target?.id || target?.tagName?.toLowerCase() || "null");
      });
    });
    // Sample what is under the cursor mid-flight: a hit-testable ghost would show up here.
    window.addEventListener("pointermove", (e) => {
      const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
      if (el) w.__underCursor.push(el.id || el.tagName.toLowerCase());
    });
  });
}

const drops = (page: Page) => page.evaluate(() => (window as unknown as { __drops: string[] }).__drops);

test.describe("in-app drag", () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(150_000); // a cold vite server transforms for ~40s before the app boots
    await page.goto("/");
    await expect(page.locator("#root button").first()).toBeVisible({ timeout: 60_000 });
    await harness(page);
  });

  test("lands on the zone under the cursor, not the first one", async ({ page }) => {
    // The whole point of hit-testing. A drop that always reported zone-a would look identical in
    // a DOM-free test, and would put every dragged clip on the wrong track in production.
    await page.mouse.move(95, 275);
    await page.mouse.down();
    await page.mouse.move(400, 275, { steps: 10 }); // across zone-a...
    await page.mouse.move(675, 275, { steps: 10 }); // ...and released over zone-b
    await page.mouse.up();
    expect(await drops(page)).toEqual(["zone-b"]);
  });

  test("the ghost tracks the cursor and stays out of the hit test", async ({ page }) => {
    // Two separate defences, and only the second one fails when `pointer-events:none` is deleted:
    // the ghost is drawn at cursor+12 (so it is not under the cursor), AND it is transparent to
    // hit-testing (so it swallows nothing even where it IS painted). Sampling only at the cursor
    // passes either way — verified by deleting the property and watching the test stay green.
    await page.mouse.move(95, 275);
    await page.mouse.down();
    await page.mouse.move(400, 275, { steps: 10 });
    const first = await page.evaluate(() => {
      const g = [...document.body.children].find((el) => (el as HTMLElement).style.zIndex === "9999");
      const r = g!.getBoundingClientRect();
      const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) as HTMLElement | null;
      return { left: r.x, top: r.y, w: r.width, underGhost: at?.id || at?.tagName.toLowerCase() || "null" };
    });
    expect(first.w, "the ghost has no box — the user sees nothing being dragged").toBeGreaterThan(0);
    expect(first.underGhost, "the ghost is hit-testable").not.toBe("null");
    expect(["zone-a", "zone-b", "handle", "body", "html"]).toContain(first.underGhost);

    await page.mouse.move(675, 275, { steps: 10 });
    const second = await page.evaluate(() => {
      const g = [...document.body.children].find((el) => (el as HTMLElement).style.zIndex === "9999");
      const r = g!.getBoundingClientRect();
      return { left: r.x, top: r.y };
    });
    expect(second.left, "the ghost did not follow the cursor").toBeGreaterThan(first.left);

    // ...and the cursor itself never lands on the ghost, so the drop still resolves to the zone.
    const seen = await page.evaluate(() => (window as unknown as { __underCursor: string[] }).__underCursor);
    await page.mouse.up();
    expect(seen.length, "no pointermove was sampled — the drag never moved").toBeGreaterThan(0);
    const strangers = [...new Set(seen)].filter((id) => !["zone-a", "zone-b", "handle", "body"].includes(id));
    expect(strangers, "something other than the page was under the cursor mid-drag").toEqual([]);
    expect(await drops(page)).toEqual(["zone-b"]);
  });

  test("a click does not drop", async ({ page }) => {
    // Failure direction: arming on pointerdown would make every click on a library row fling that
    // clip onto whatever happened to be under it.
    await page.mouse.move(95, 275);
    await page.mouse.down();
    await page.mouse.up();
    expect(await drops(page)).toEqual([]);
  });

  test("a 2px twitch does not drop, a 20px move does", async ({ page }) => {
    await page.mouse.move(95, 275);
    await page.mouse.down();
    await page.mouse.move(97, 277); // inside the 5px threshold
    await page.mouse.up();
    expect(await drops(page), "a twitch armed the drag").toEqual([]);

    await page.mouse.move(95, 275);
    await page.mouse.down();
    await page.mouse.move(115, 275, { steps: 5 });
    await page.mouse.up();
    expect(await drops(page), "a real move failed to arm the drag").toHaveLength(1);
  });

  test("releasing over nothing leaves no ghost behind", async ({ page }) => {
    // A leaked ghost is fixed-position at z-index 9999, so it would sit over the app forever. It
    // steals no clicks (pointer-events:none), it is just visibly wrong — exactly the kind of thing
    // a DOM-free test never notices.
    await page.mouse.move(95, 275);
    await page.mouse.down();
    await page.mouse.move(95, 600, { steps: 10 }); // empty page, no zone
    await page.mouse.up();
    expect(await drops(page)).toEqual(["body"]);
    const leftovers = await page.evaluate(
      () => [...document.body.children].filter((el) => (el as HTMLElement).style.zIndex === "9999").length,
    );
    expect(leftovers, "the drag ghost was left in the DOM").toBe(0);
  });
});
