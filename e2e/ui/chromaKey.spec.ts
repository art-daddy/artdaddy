// Real-GPU proof that the preview's chroma key makes the SAME decision as the exporter's.
//
// From a production session (feedback d03ab792): the user's preview still showed green backing,
// so the model raised chroma similarity 0.30 -> 0.42 to get rid of it. The preview barely
// changed — it was keying on RGB distance — while ffmpeg, keying on chroma distance, was already
// past the threshold where WHITE falls inside the key. The delivered video showed an
// orange-and-white cat as a floating nose and mouth.
//
// So the assertion is not "the shader keys something". It is "at 0.42 the shader removes the
// backing AND the white and keeps the orange", which is exactly what the bundled ffmpeg does at
// that value (pinned in src/preview/chromaKey.smoke.e2e.ts).
import { expect, test } from "@playwright/test";

type RGBA = [number, number, number, number];

async function pixel(page: import("@playwright/test").Page, x: number, y: number): Promise<RGBA> {
  return page.evaluate(
    ([px, py]) => {
      const src = document.getElementById("probe-snapshot") as HTMLCanvasElement;
      const ctx = src.getContext("2d") as CanvasRenderingContext2D;
      const d = ctx.getImageData(px, py, 1, 1).data;
      return [d[0], d[1], d[2], d[3]] as [number, number, number, number];
    },
    [x, y],
  );
}

/** The base is pure blue, so "was this keyed away?" is "is this pixel blue?". */
const isBase = (p: RGBA): boolean => p[2] > 150 && p[0] < 80 && p[1] < 80;

test.describe("chroma key on the GPU", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/preview-probe-chroma.html");
    await page.waitForFunction(() => "__probe" in window);
    await page.waitForSelector("#probe-snapshot", { state: "attached" });
  });

  test("compiles and renders", async ({ page }) => {
    const status = await page.evaluate(() => (window as unknown as { __probe: string }).__probe);
    expect(status).toBe("ok");
  });

  test("removes the green backing", async ({ page }) => {
    // Bottom half is pure backing.
    expect(isBase(await pixel(page, 300, 450)), "the backing survived the key").toBe(true);
  });

  test("removes WHITE at similarity 0.42, exactly as ffmpeg does", async ({ page }) => {
    // The regression in one pixel. Under the old RGB-distance shader white sat far from green
    // and stayed put, so the preview looked right while the export dropped it.
    expect(
      isBase(await pixel(page, 150, 150)),
      "white was kept — the shader disagrees with ffmpeg",
    ).toBe(true);
  });

  test("keeps ORANGE at the same similarity — the key is not simply erasing everything", async ({
    page,
  }) => {
    const p = await pixel(page, 450, 150);
    expect(isBase(p), "orange was keyed away too").toBe(false);
    expect(p[0], "orange is not orange any more").toBeGreaterThan(150);
    expect(p[1]).toBeGreaterThan(80);
    expect(p[2]).toBeLessThan(120);
  });
});
