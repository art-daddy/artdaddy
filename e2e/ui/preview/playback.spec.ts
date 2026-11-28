// The live preview, the way a person uses it: open a project and wait for the picture, drag the transport, click the
// ruler, step with the keys, play and pause, play to the end, hear the sound, see a cut, zoom the stage, a phone video
// that needs a preview copy, an empty project, and a machine with no WebGL2. Judged on what the stage SHOWS (the
// pixels on screen, read from a screenshot of the stage) against the time the app says the playhead is at.
//
// The clip (e2e/ui/media-library/fixtures/media/rgb_3s.mp4) is red for its first second, green for its second and
// blue for its third, so a picture says which second is on screen without any reference image. Whole-frame preview
// against export is the parity lane's (e2e/ui/parity.spec.ts); this lane checks that the picture follows the person.
//
//   npm run e2e:ui -- e2e/ui/preview
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import type { Page } from "@playwright/test";

import { expect, test, type AgentRig } from "../agent-and-models/lib/qa";
import { measure, startTimer } from "../../lib/timing";
import {
  colourName,
  expectStage,
  fileMenu,
  fixture,
  libraryItem,
  onDisk,
  openProject,
  osDrop,
  playheadSeconds,
  previewCannotDrawHere,
  stage,
  stageCanvas,
  stageColour,
  trackLane,
} from "../media-library/lib/media";

const PROJECT = "sweep_qa_preview";

/** The fixture's colour at `t` seconds of the timeline. */
const colourAt = (t: number): string =>
  t < 1 ? "red" : t < 2 ? "green" : t < 3 ? "blue" : "black";

const browser = () => test.info().project.name;

/** A project whose v1 track holds the three-colour clip (and its sound) from frame 0, made the way a person makes it:
 *  the file dropped from Explorer onto the start of the track. */
async function projectWithClip(
  qa: AgentRig,
  files: Record<string, string> = { "colours.mp4": "rgb_3s.mp4" },
): Promise<string> {
  const id = await openProject(qa, PROJECT);
  const paths = await onDisk(qa, files);
  const lane = trackLane(qa.page, "v1");
  await expect(lane).toBeVisible({ timeout: 20_000 });
  await osDrop(qa.page, paths, lane, { x: 2, y: 10 });
  await expect
    .poll(
      async () =>
        ((await qa.savedTimeline(id))?.tracks ?? [])
          .filter((t) => t.id === "v1")
          .flatMap((t) => t.clips ?? []).length,
      { timeout: 30_000 },
    )
    .toBe(paths.length);
  await expect(stageCanvas(qa.page)).toBeVisible({ timeout: 20_000 });
  return id;
}

const slider = (page: Page) => stage(page).getByRole("slider", { name: "preview time" });

/** Click the transport at a fraction of its length, as a person does. */
async function clickTransport(page: Page, fraction: number): Promise<void> {
  const box = await slider(page).boundingBox();
  if (!box) throw new Error("the transport is not on screen");
  await page.mouse.click(box.x + box.width * fraction, box.y + box.height / 2);
}

test.describe("the live preview", () => {
  test.setTimeout(180_000);

  test.beforeEach(({ browserName }) => {
    test.skip(
      previewCannotDrawHere(browserName),
      "Windows WebKit has no WebGL2 and no WebCodecs: the preview cannot draw there",
    );
  });

  test("a project opens to its picture, and the transport shows the frame at the time it reads", async ({
    qa,
  }) => {
    await projectWithClip(qa);
    await expectStage(qa.page, "red");

    // Close the project, start the app again and open it: the person waits for the first picture.
    await fileMenu(qa, /^Close Project$/);
    await qa.page.waitForURL((u) => !u.pathname.startsWith("/p/"), { timeout: 20_000 });
    await qa.open();
    await qa.page.getByRole("button", { name: "File", exact: true }).click();
    await qa.page
      .getByRole("button", { name: /Open Project/i })
      .first()
      .click();
    const first = startTimer(`preview: open a project to its first picture [${browser()}]`);
    await qa.page.getByRole("button", { name: PROJECT, exact: true }).click();
    await expectStage(qa.page, "red", 60_000);
    first.stop();

    // Drag along the transport: wherever it stops, the picture is the frame at the time it reads.
    for (const fraction of [0.5, 0.83, 0.15]) {
      await measure(`preview: seek to a new picture [${browser()}]`, async () => {
        await clickTransport(qa.page, fraction);
        const t = await playheadSeconds(qa.page);
        expect(t, "the transport did not move").toBeGreaterThan(0);
        await expectStage(qa.page, colourAt(t));
      });
    }
  });

  test("clicking the ruler and the step keys move the playhead and the picture follows; the zoom sizes the picture and Fit fits it", async ({
    qa,
  }) => {
    const id = await projectWithClip(qa);
    const clip = ((await qa.savedTimeline(id))?.tracks ?? []).flatMap((t) => t.clips ?? [])[0];
    const box = await qa.timelineClip(String(clip.id)).boundingBox();
    const ruler = qa.page.getByRole("slider", { name: "timeline scrubber" });
    const rulerBox = await ruler.boundingBox();
    if (!box || !rulerBox) throw new Error("the clip or the ruler is not on screen");

    // Half way along the clip: 1.5 s, green.
    await qa.page.mouse.click(box.x + box.width * 0.5, rulerBox.y + rulerBox.height / 2);
    await expect.poll(() => playheadSeconds(qa.page)).toBeGreaterThan(1.2);
    expect(await playheadSeconds(qa.page)).toBeLessThan(1.8);
    await expectStage(qa.page, "green");

    await qa.page.keyboard.press("Home");
    await expect.poll(() => playheadSeconds(qa.page)).toBe(0);
    await expectStage(qa.page, "red");
    await qa.page.keyboard.press("ArrowRight");
    await expect.poll(() => playheadSeconds(qa.page)).toBeCloseTo(1 / 30, 2);
    await qa.page.keyboard.press("Shift+ArrowRight");
    await expect.poll(() => playheadSeconds(qa.page)).toBeCloseTo(6 / 30, 2);
    await qa.page.keyboard.press("End");
    await expect.poll(() => playheadSeconds(qa.page)).toBe(3);

    // The stage zoom: a quarter of the project's size, then Fit, which fits the pane again.
    await qa.page.keyboard.press("Home");
    const header = await stage(qa.page)
      .getByText(/^\d+×\d+ · \d+fps$/)
      .innerText();
    const [w, h] = header.split(" ")[0].split("×").map(Number);
    const zoom = stage(qa.page).getByRole("combobox", { name: "canvas zoom" });
    await zoom.selectOption("0.25");
    await expect
      .poll(async () => Math.round((await stageCanvas(qa.page).boundingBox())?.width ?? 0))
      .toBe(Math.round(w * 0.25));
    expect(Math.round((await stageCanvas(qa.page).boundingBox())?.height ?? 0)).toBe(
      Math.round(h * 0.25),
    );
    await zoom.selectOption("fit");
    const viewport = await stageCanvas(qa.page).locator("xpath=../../..").boundingBox();
    const fitted = await stageCanvas(qa.page).boundingBox();
    expect(fitted!.width).toBeLessThanOrEqual(viewport!.width + 1);
    expect(fitted!.height).toBeLessThanOrEqual(viewport!.height + 1);
    expect(fitted!.width).toBeGreaterThan(w * 0.25);
    await expectStage(qa.page, "red");
  });

  test("Play runs the picture forward with its sound, Pause holds both, Space does the same, and playing to the end stops there", async ({
    qa,
  }) => {
    const id = await projectWithClip(qa);
    // The clip's sound came in with it, on an audio track.
    await expect
      .poll(
        async () =>
          ((await qa.savedTimeline(id))?.tracks ?? [])
            .filter((t) => t.kind === "audio")
            .flatMap((t) => t.clips ?? []).length,
      )
      .toBeGreaterThan(0);
    const level = stage(qa.page)
      .getByRole("meter", { name: "master level left" })
      .locator("div")
      .first();
    const meter = async () =>
      parseFloat((await level.getAttribute("style"))?.match(/width:\s*([\d.]+)%/)?.[1] ?? "0");
    await expectStage(qa.page, "red");
    expect(await meter()).toBe(0);
    const transport = stage(qa.page);

    await transport.getByRole("button", { name: "play" }).click();
    await expect
      .poll(meter, { timeout: 15_000, message: "no sound reached the meter" })
      .toBeGreaterThan(5);
    await expect.poll(() => playheadSeconds(qa.page), { timeout: 15_000 }).toBeGreaterThan(1.2);
    await transport.getByRole("button", { name: "pause" }).click();
    const held = await playheadSeconds(qa.page);
    await expectStage(qa.page, colourAt(held));
    // Paused means paused: the playhead, the picture and the sound stay put.
    await qa.page.waitForTimeout(700);
    expect(await playheadSeconds(qa.page)).toBe(held);
    expect(colourName(await stageColour(qa.page))).toBe(colourAt(held));
    await expect
      .poll(meter, { timeout: 10_000, message: "the meter kept moving when paused" })
      .toBe(0);

    // The space bar, on the timeline, plays and pauses too.
    await qa.page.getByRole("slider", { name: "timeline scrubber" }).focus();
    await qa.page.keyboard.press("Space");
    await expect(transport.getByRole("button", { name: "pause" })).toBeVisible();
    await expect
      .poll(() => playheadSeconds(qa.page), { timeout: 15_000 })
      .toBeGreaterThan(held + 0.2);
    await qa.page.keyboard.press("Space");
    await expect(transport.getByRole("button", { name: "play" })).toBeVisible();

    // Near the end, play on: it stops at the end and offers Play again.
    await clickTransport(qa.page, 0.9);
    await transport.getByRole("button", { name: "play" }).click();
    await expect(transport.getByRole("button", { name: "play" })).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => playheadSeconds(qa.page)).toBe(3);
  });

  test("at a cut the picture changes from the video to the picture after it", async ({ qa }) => {
    const id = await projectWithClip(qa, { "colours.mp4": "rgb_3s.mp4", "card.png": "orange.png" });
    const clips = ((await qa.savedTimeline(id))?.tracks ?? [])
      .filter((t) => t.id === "v1")
      .flatMap((t) => t.clips ?? [])
      .map((c) => ({ in: Number(c.timeline_in), out: Number(c.timeline_out) }))
      .sort((a, b) => a.in - b.in);
    expect(clips.length).toBe(2);
    expect(clips[1].in, "the picture does not follow the video").toBe(clips[0].out);

    const ruler = qa.page.getByRole("slider", { name: "timeline scrubber" });
    await ruler.focus();
    await qa.page.keyboard.press("Home");
    // Step to the last frame of the video, then one more: across the cut.
    const fives = Math.floor((clips[0].out - 1) / 5);
    for (let i = 0; i < fives; i++) await qa.page.keyboard.press("Shift+ArrowRight");
    for (let i = fives * 5; i < clips[0].out - 1; i++) await qa.page.keyboard.press("ArrowRight");
    await expect.poll(() => playheadSeconds(qa.page)).toBeCloseTo((clips[0].out - 1) / 30, 2);
    await expectStage(qa.page, "blue");
    await qa.page.keyboard.press("ArrowRight");
    await expect.poll(() => playheadSeconds(qa.page)).toBeCloseTo(clips[0].out / 30, 2);
    await expectStage(qa.page, "orange");
  });

  test("a phone video in HEVC gets a preview copy, then shows the right picture at each time", async ({
    qa,
  }) => {
    const id = await projectWithClip(qa, { "phone clip.mp4": "rgb_3s.hevc.mp4" });
    const wait = startTimer(`preview: an HEVC clip to its first true picture [${browser()}]`);
    await clickTransport(qa.page, 0.5);
    const t = await playheadSeconds(qa.page);
    await expectStage(qa.page, colourAt(t), 90_000);
    wait.stop();
    await clickTransport(qa.page, 0.83);
    await expectStage(qa.page, colourAt(await playheadSeconds(qa.page)));
    // The copy is the project's own, in its cache; the person's file was not touched.
    const proxies = path.join(qa.shell.projectDir(id), "internals", "cache", "proxies");
    expect(readdirSync(proxies).length, "no preview copy was made").toBeGreaterThan(0);
    const original = qa.shell.real(qa.shell.virtual("media/footage/phone clip.mp4"));
    expect(readFileSync(original).equals(readFileSync(fixture("rgb_3s.hevc.mp4")))).toBe(true);
  });

  test("an empty project offers Upload file on the stage, and it imports the picked file", async ({
    qa,
  }) => {
    const id = await openProject(qa, PROJECT);
    await expect(stage(qa.page).getByText("Upload file")).toBeVisible();
    await expect(stage(qa.page).getByRole("button", { name: "record video" })).toBeVisible();
    const [clip] = await onDisk(qa, { "first.mp4": "rgb_3s.mp4" });
    qa.shell.pickFiles([clip]);
    await stage(qa.page).getByRole("button", { name: "upload file" }).click();
    await expect(libraryItem(qa.page, "first.mp4")).toBeVisible({ timeout: 30_000 });
    const saved = await qa.shell.readProjectJson<{ clips?: Array<{ filename?: string }> }>(
      id,
      "internals/library.json",
    );
    expect((saved?.clips ?? []).map((c) => c.filename)).toEqual(["first.mp4"]);
  });
});

test.describe("the live preview without WebGL2", () => {
  test.setTimeout(150_000);

  test("says the preview is unavailable instead of staying black", async ({ qa }) => {
    // A machine with no WebGL2 anywhere: the preview's worker cannot start one, and neither can the page it falls
    // back to.
    await qa.page.addInitScript(() => {
      const RealWorker = window.Worker;
      window.Worker = function (url: string | URL, options?: WorkerOptions) {
        if (String(url).includes("previewWorker")) throw new Error("no WebGL2 in a worker here");
        return new RealWorker(url, options);
      } as unknown as typeof Worker;
      for (const proto of [HTMLCanvasElement.prototype, globalThis.OffscreenCanvas?.prototype]) {
        if (!proto) continue;
        const real = proto.getContext as (
          this: unknown,
          kind: string,
          ...rest: unknown[]
        ) => unknown;
        (proto as { getContext: unknown }).getContext = function (
          this: unknown,
          kind: string,
          ...rest: unknown[]
        ) {
          return kind === "webgl2" ? null : real.call(this, kind, ...rest);
        };
      }
    });
    const id = await openProject(qa, PROJECT);
    const paths = await onDisk(qa, { "colours.mp4": "rgb_3s.mp4" });
    await osDrop(qa.page, paths, trackLane(qa.page, "v1"), { x: 2, y: 10 });
    await expect
      .poll(
        async () =>
          ((await qa.savedTimeline(id))?.tracks ?? []).flatMap((t) => t.clips ?? []).length,
      )
      .toBeGreaterThan(0);
    await expect(stage(qa.page).getByText(/^Preview unavailable: /)).toBeVisible({
      timeout: 20_000,
    });
  });
});
