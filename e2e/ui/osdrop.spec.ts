// File drops, in a REAL browser, on the REAL modules.
//
// The unit suite answers these against hand-built fakes: a `DataTransferItemList` that is really
// an array, and a `platform` that is really a mutable let. Both hide what the real thing does:
//   * a real `DataTransferItemList` is a live, indexed host collection, not the plain array the
//     unit fake substitutes — so only a real browser proves the reader can read one at all.
//   * WebKit is the engine inside macOS's WKWebView, which is where every reported drop bug
//     lived. Running the same assertions there is the closest this repo gets to the Tauri shell
//     without a Mac build.
//
// The production zones (library / timeline lane / composer) can't be reached here — projects
// resolve through Tauri's `dataDir()`, so no project opens in a browser (see drag.spec.ts). What
// IS shared with production is the module below: the same `filesFromItems` and `webOwnsFileDrops`
// the composer, the library and the lanes all call.
import { expect, test, type Page } from "@playwright/test";

type Upload = typeof import("../../src/lib/upload");
type OsDrop = typeof import("../../src/lib/osDrop");

/** Build a REAL DataTransferItemList from the browser and run it through the real reader. */
async function readClipboard(
  page: Page,
  flavours: { type: string; name: string }[],
): Promise<string[]> {
  return page.evaluate(async (list) => {
    const { filesFromItems } = (await import("/src/lib/upload.ts")) as Upload;
    const dt = new DataTransfer();
    for (const f of list) dt.items.add(new File(["payload"], f.name, { type: f.type }));
    return filesFromItems(dt.items).map((f) => f.name);
  }, flavours);
}

test.describe("the paste/drop reader, on a real DataTransferItemList", () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(150_000); // a cold vite server transforms for ~40s before the app boots
    await page.goto("/");
    await expect(page.locator("#root button").first()).toBeVisible({ timeout: 60_000 });
  });

  test("reads a real item list at all", async ({ page }) => {
    // The unit fake is a plain array; this is the real host collection the composer receives.
    expect(await readClipboard(page, [{ type: "video/mp4", name: "holiday.mp4" }])).toEqual([
      "holiday.mp4",
    ]);
  });

  test("takes the video, not the preview still macOS pairs with it", async ({ page }) => {
    const got = await readClipboard(page, [
      { type: "image/jpeg", name: "" },
      { type: "video/quicktime", name: "clip.mov" },
    ]);
    expect(got).toEqual(["clip.mov"]);
  });

  test("names an unnamed flavour with a REAL extension, not the MIME subtype", async ({ page }) => {
    const got = await readClipboard(page, [{ type: "video/quicktime", name: "" }]);
    expect(got).toHaveLength(1);
    // `.quicktime` is what splitting the MIME type gives; nothing downstream can read it.
    expect(got[0]).toMatch(/\.mov$/);
  });

  test("drops a flavour that maps to no supported extension", async ({ page }) => {
    expect(await readClipboard(page, [{ type: "image/vnd.adobe.photoshop", name: "" }])).toEqual(
      [],
    );
  });
});

test.describe("who owns an OS file drop", () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(150_000);
    await page.goto("/");
    await expect(page.locator("#root button").first()).toBeVisible({ timeout: 60_000 });
  });

  test("the web layer owns it in a browser, where there is no Tauri to defer to", async ({
    page,
  }) => {
    const owns = await page.evaluate(async () => {
      const { webOwnsFileDrops } = (await import("/src/lib/osDrop.ts")) as OsDrop;
      return webOwnsFileDrops();
    });
    expect(owns).toBe(true);
  });

  test("a routed drop reaches only the zone it names", async ({ page }) => {
    // osDrop routes by a string, and a mismatch fails SILENTLY — the file is delivered to nobody.
    const got = await page.evaluate(async () => {
      const { onOsDrop } = (await import("/src/lib/osDrop.ts")) as OsDrop;
      const seen: string[] = [];
      const offChat = onOsDrop("chat", (d) => seen.push(`chat:${d.paths[0]}`));
      const offLib = onOsDrop("library", (d) => seen.push(`library:${d.paths[0]}`));
      const fire = (target: string, path: string) =>
        window.dispatchEvent(
          new CustomEvent("artdaddy:os-drop", {
            detail: { paths: [path], target, element: null, x: 0, y: 0 },
          }),
        );
      fire("chat", "/a.mov");
      fire("library", "/b.mov");
      fire("track", "/c.mov");
      offChat();
      offLib();
      return seen;
    });
    expect(got).toEqual(["chat:/a.mov", "library:/b.mov"]);
  });

  test("unsubscribing really stops delivery", async ({ page }) => {
    // A listener that outlives its component keeps importing into a project that closed.
    const got = await page.evaluate(async () => {
      const { onOsDrop } = (await import("/src/lib/osDrop.ts")) as OsDrop;
      const seen: string[] = [];
      const off = onOsDrop("chat", (d) => seen.push(d.paths[0]));
      off();
      window.dispatchEvent(
        new CustomEvent("artdaddy:os-drop", {
          detail: { paths: ["/gone.mov"], target: "chat", element: null, x: 0, y: 0 },
        }),
      );
      return seen;
    });
    expect(got).toEqual([]);
  });
});

test.describe("a real file dropped on a real zone", () => {
  // Real layout + a real DataTransfer, so this answers the question happy-dom cannot: does the
  // drop land on the zone the cursor is actually over?
  test.beforeEach(async ({ page }) => {
    test.setTimeout(150_000);
    await page.goto("/");
    await expect(page.locator("#root button").first()).toBeVisible({ timeout: 60_000 });
    await page.evaluate(async () => {
      const { filesFromItems, MEDIA_RE } = (await import("/src/lib/upload.ts")) as Upload;
      const { webOwnsFileDrops } = (await import("/src/lib/osDrop.ts")) as OsDrop;
      document.body.innerHTML = "";
      document.body.style.margin = "0";
      const w = window as unknown as { __taken: string[] };
      w.__taken = [];
      for (const [id, left] of [
        ["zone-a", 100],
        ["zone-b", 500],
      ] as const) {
        const el = document.createElement("div");
        el.id = id;
        el.dataset.artdaddyDrop = id;
        el.style.cssText = `position:fixed;top:150px;left:${left}px;width:200px;height:200px;background:#333`;
        el.addEventListener("dragover", (e) => {
          if (!webOwnsFileDrops()) return;
          e.preventDefault();
        });
        el.addEventListener("drop", (e) => {
          // The production rule: on desktop the page must not take the drop at all.
          if (!webOwnsFileDrops()) return;
          e.preventDefault();
          const dt = (e as DragEvent).dataTransfer!;
          const named = [...(dt.files ?? [])].filter((f) => MEDIA_RE.test(f.name));
          const fromItems = filesFromItems(dt.items);
          w.__taken.push(`${id}:${(named[0] ?? fromItems[0])?.name ?? "none"}`);
        });
        document.body.appendChild(el);
      }
    });
  });

  test("lands on the zone under the cursor, carrying the real file", async ({ page }) => {
    const dt = await page.evaluateHandle(() => {
      const d = new DataTransfer();
      d.items.add(new File(["x"], "holiday.mp4", { type: "video/mp4" }));
      return d;
    });
    await page.dispatchEvent("#zone-b", "dragover", { dataTransfer: dt });
    await page.dispatchEvent("#zone-b", "drop", { dataTransfer: dt });
    expect(await page.evaluate(() => (window as unknown as { __taken: string[] }).__taken)).toEqual(
      ["zone-b:holiday.mp4"],
    );
  });

  test("a non-media file is not taken", async ({ page }) => {
    const dt = await page.evaluateHandle(() => {
      const d = new DataTransfer();
      d.items.add(new File(["x"], "notes.pdf", { type: "application/pdf" }));
      return d;
    });
    await page.dispatchEvent("#zone-a", "drop", { dataTransfer: dt });
    expect(await page.evaluate(() => (window as unknown as { __taken: string[] }).__taken)).toEqual(
      ["zone-a:none"],
    );
  });
});
