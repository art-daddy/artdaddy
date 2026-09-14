// Real-GPU pixel test for the WebGL2 compositor.
//
// `src/preview/__probe.ts` composites a fixed scene: a 800×400 red image letterboxed
// (contain) into a 600×600 canvas, with a 400×400 blue box at 50% opacity on a higher
// track. Every number below follows from that geometry, so this fails if the shader
// stops compiling, the letterbox maths inverts, the z-order flips, or alpha blending
// silently becomes an opaque overwrite — none of which a draw-list unit test can see.
import { expect, test } from "@playwright/test";

type RGBA = [number, number, number, number];

/** Read one pixel out of the probe's SNAPSHOT (device pixels, top-left origin).
 *  Not the live WebGL canvas: that context is not preserveDrawingBuffer, so reading it
 *  from a later task returns an empty buffer and every assertion here fails as black. */
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

test.describe("preview compositor (real WebGL2)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/preview-probe.html");
    await page.waitForFunction(() => "__probe" in window);
    await page.waitForSelector("#probe-snapshot", { state: "attached" });
  });

  test("builds a WebGL2 context and renders without throwing", async ({ page }) => {
    const status = await page.evaluate(() => (window as unknown as { __probe: string }).__probe);
    expect(status, "the compositor failed to initialise in a real browser").toBe("ok");
  });

  test("renders a NON-BLACK frame", async ({ page }) => {
    // The whole point of the lane: a compositor that silently outputs a cleared
    // buffer passes every draw-list assertion we have.
    const lit = await page.evaluate(() => {
      const src = document.getElementById("probe-snapshot") as HTMLCanvasElement;
      const ctx = src.getContext("2d") as CanvasRenderingContext2D;
      const d = ctx.getImageData(0, 0, src.width, src.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 24) n += 1;
      return n;
    });
    expect(lit, "every pixel is black — nothing was composited").toBeGreaterThan(1000);
  });

  test("letterboxes the wide source instead of stretching it", async ({ page }) => {
    // 800×400 contained in 600×600 → 600×300, centred: rows 150..450 carry the image
    // and the bands above/below stay black. Sampled outside the blue box (x=50).
    const above = await pixel(page, 50, 40);
    const middle = await pixel(page, 50, 300);
    const below = await pixel(page, 50, 560);

    expect(above[0] + above[1] + above[2], "the top band is not letterboxed").toBeLessThan(24);
    expect(below[0] + below[1] + below[2], "the bottom band is not letterboxed").toBeLessThan(24);
    expect(middle[0], "the middle band is not the red source").toBeGreaterThan(150);
    expect(middle[2]).toBeLessThan(80);
  });

  test("blends the upper track at 50% instead of overwriting it", async ({ page }) => {
    // Inside both the red band and the blue box: neither colour may dominate.
    const blended = await pixel(page, 300, 300);
    expect(blended[0], "red vanished — the overlay overwrote instead of blending").toBeGreaterThan(
      60,
    );
    expect(blended[2], "blue never landed — the overlay was dropped").toBeGreaterThan(60);
    expect(Math.abs(blended[0] - blended[2]), "the mix is not ~50/50").toBeLessThan(70);
  });

  test("respects z-order — the overlay draws OVER the base, not under", async ({ page }) => {
    // Below the letterboxed image (y=470) but still inside the blue box: only the
    // overlay can put colour here. If z-order were inverted this would be black.
    const overBlack = await pixel(page, 300, 470);
    expect(overBlack[2], "the overlay is not drawn above the base track").toBeGreaterThan(60);
    expect(overBlack[0], "unexpected red below the letterboxed image").toBeLessThan(60);
  });

  test("clips the overlay to its layout box", async ({ page }) => {
    // The blue box is x∈[100,500]; x=50 in the red band must be untouched red.
    const outside = await pixel(page, 50, 300);
    expect(outside[2], "the overlay bled outside its layout rect").toBeLessThan(80);
    expect(outside[0]).toBeGreaterThan(150);
  });
});
