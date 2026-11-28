// Bringing media in, the way a person does: the library's + button, File > Import Media (linked or copied), a file
// dropped from Explorer or Finder onto the library or a track, the same file twice, a damaged file, a file the app
// does not open, and a dialog closed with Cancel. Judged on the screen and on the saved project
// (internals/library.json, the project's own library/ folder), never on what the code meant to do.
//
//   npm run e2e:ui -- e2e/ui/media-library
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { expect, knownBug, test } from "../agent-and-models/lib/qa";
import { startTimer } from "../../lib/timing";
import {
  fileMenu,
  fixture,
  importWithPlus,
  libraryItem,
  libraryPane,
  notice,
  onDisk,
  openProject,
  osDrop,
  ownedFiles,
  restart,
  savedRows,
  stage,
  trackLane,
} from "./lib/media";

/** The id the app gives a file: media_ and the first 12 hex digits of its SHA-256. */
const idOf = (name: string): string =>
  `media_${createHash("sha256")
    .update(readFileSync(fixture(name)))
    .digest("hex")
    .slice(0, 12)}`;

const PROJECT = "sweep_qa_media_import";

test.describe("importing media", () => {
  test.setTimeout(150_000);

  test("the + button links the picked video in place, shows it by its name, and picking it again adds nothing; Cancel adds nothing", async ({
    qa,
  }) => {
    const id = await openProject(qa, PROJECT);
    // A name with a space, as people's files have.
    const [clip] = await onDisk(qa, { "beach day.mp4": "rgb_3s.mp4" });

    // The dialog closed with Cancel, from the + and from the File menu: nothing comes in, nothing is said to fail.
    const dialogs = () => qa.shell.calls.filter((c) => c.cmd === "plugin:dialog|open").length;
    await importWithPlus(qa, null);
    qa.shell.pickFiles(null);
    await fileMenu(qa, /^Import Media…$/);
    await expect.poll(dialogs).toBe(2);
    await expect(notice(qa.page)).toHaveCount(0);
    await expect(qa.page.getByText(/failed|Couldn't/i)).toHaveCount(0);
    expect(await savedRows(qa, id)).toEqual([]);
    await expect(libraryPane(qa.page).getByText("No files yet.")).toBeVisible();

    const wait = startTimer(
      `import: one video linked to its library tile [${test.info().project.name}]`,
    );
    await importWithPlus(qa, [clip]);
    await expect(libraryItem(qa.page, "beach day.mp4")).toBeVisible({ timeout: 30_000 });
    wait.stop();

    await expect.poll(async () => (await savedRows(qa, id)).length).toBe(1);
    const [row] = await savedRows(qa, id);
    expect(row).toMatchObject({
      id: idOf("rgb_3s.mp4"),
      path: clip,
      filename: "beach day.mp4",
      kind: "video",
      external: true,
    });
    // Linked, not copied: nothing landed in the project's own folder, and the original is untouched.
    expect(await ownedFiles(qa, id)).toEqual([]);
    expect(readFileSync(qa.shell.real(clip)).equals(readFileSync(fixture("rgb_3s.mp4")))).toBe(
      true,
    );

    // The same file again: still one row and one tile, under the same id.
    const probes = () => qa.shell.calls.filter((c) => c.cmd === "probe_media_file").length;
    const before = probes();
    await importWithPlus(qa, [clip]);
    await expect.poll(probes).toBeGreaterThan(before);
    await expect(qa.page.getByRole("status", { name: "importing media" })).toHaveCount(0, {
      timeout: 20_000,
    });
    expect((await savedRows(qa, id)).map((r) => r.id)).toEqual([idOf("rgb_3s.mp4")]);
    await expect(libraryItem(qa.page, "beach day.mp4")).toHaveCount(1);
  });

  test("File > Import Media links a video, a sound and a picture picked together, and each opens in its tab", async ({
    qa,
    browserName,
  }) => {
    const id = await openProject(qa, PROJECT);
    const picked = await onDisk(qa, {
      "interview.mp4": "rgb_3s.mp4",
      "room tone.wav": "tone_2s.wav",
      "logo.png": "orange.png",
    });
    qa.shell.pickFiles(picked);
    await fileMenu(qa, /^Import Media…$/);
    await expect(qa.page.getByText("Linked 3 file(s)")).toBeVisible({ timeout: 30_000 });
    for (const name of ["interview.mp4", "room tone.wav", "logo.png"])
      await expect(libraryItem(qa.page, name)).toBeVisible();
    const rows = await savedRows(qa, id);
    expect(rows.map((r) => [r.filename, r.kind, r.external]).sort()).toEqual([
      ["interview.mp4", "video", true],
      ["logo.png", "image", true],
      ["room tone.wav", "audio", true],
    ]);
    expect(await ownedFiles(qa, id)).toEqual([]);

    // A look at each: the picture as a picture, the sound with its own transport.
    await libraryItem(qa.page, "logo.png").click();
    await expect(qa.page.getByRole("tab", { name: "logo.png" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    const picture = stage(qa.page).locator("img").first();
    await expect(picture).toBeVisible({ timeout: 20_000 });
    expect(await picture.evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBe(64);
    await libraryItem(qa.page, "room tone.wav").click();
    await expect(qa.page.getByRole("tab", { name: "room tone.wav" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    // One click replaces the passing look: still one library tab.
    await expect(qa.page.getByRole("tab")).toHaveCount(2);
    if (!(browserName === "webkit" && process.platform === "win32"))
      await expect(qa.page.getByText("0:00 / 0:02")).toBeVisible({ timeout: 20_000 });
  });

  test("File > Import Media (copy into project) copies the bytes in under the same id", async ({
    qa,
  }) => {
    const id = await openProject(qa, PROJECT);
    const [clip] = await onDisk(qa, { "beach day.mp4": "rgb_3s.mp4" });
    qa.shell.pickFiles([clip]);
    await fileMenu(qa, /^Import Media \(copy into project\)…$/);
    await expect(qa.page.getByText("Copied 1/1 file(s) into the project")).toBeVisible({
      timeout: 30_000,
    });

    const ref = idOf("rgb_3s.mp4");
    await expect
      .poll(async () => (await savedRows(qa, id)).map((r) => [r.id, r.path, r.external ?? false]))
      .toEqual([[ref, `library/${ref}.mp4`, false]]);
    expect(await ownedFiles(qa, id)).toEqual([`${ref}.mp4`]);
    const copy = path.join(qa.shell.projectDir(id), "library", `${ref}.mp4`);
    expect(readFileSync(copy).equals(readFileSync(fixture("rgb_3s.mp4")))).toBe(true);
  });

  test("files the project holds a copy of are shown in the library by their own names", async ({
    qa,
    browserName,
  }) => {
    knownBug(
      "The library shows every file copied into the project as media_<id>.<ext>, not by its name",
      /copies shown by their names/,
    );
    const id = await openProject(qa, PROJECT);
    const [clip] = await onDisk(qa, { "beach day.mp4": "rgb_3s.mp4" });
    const names = ["beach day.mp4"];
    // The library's own "Copy into project" on a linked file.
    await importWithPlus(qa, [clip]);
    await expect(libraryItem(qa.page, "beach day.mp4")).toBeVisible({ timeout: 30_000 });
    await libraryItem(qa.page, "beach day.mp4").click({ button: "right" });
    await qa.page.getByRole("menuitem", { name: "Copy into project" }).click();
    await expect(qa.page.getByText("Copied into the project.")).toBeVisible({ timeout: 20_000 });
    // A picture pasted into the library (Ctrl+V): copied in too. Windows WebKit's DataTransfer cannot carry a file.
    if (!(browserName === "webkit" && process.platform === "win32")) {
      await libraryPane(qa.page).focus();
      await qa.page.evaluate(
        ({ b64 }) => {
          const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
          const dt = new DataTransfer();
          dt.items.add(new File([bytes], "logo.png", { type: "image/png" }));
          document
            .querySelector('[data-artdaddy-drop="library"]')!
            .dispatchEvent(
              new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }),
            );
        },
        { b64: readFileSync(fixture("orange.png")).toString("base64") },
      );
      names.push("logo.png");
    }
    await expect
      .poll(async () =>
        (await savedRows(qa, id)).map((r) => [r.filename, r.external ?? false]).sort(),
      )
      .toEqual(names.map((n) => [n, false]).sort());
    // The catalog knows the names; the person must see them. Read after a restart, so the panel's first listing is
    // the one judged (a listing still on its way would show the old tile).
    await restart(qa, PROJECT);
    const tiles = libraryPane(qa.page).locator(".library-grid > button[title]");
    await expect(tiles).toHaveCount(names.length, { timeout: 20_000 });
    expect(
      await tiles.evaluateAll((els) => els.map((e) => e.getAttribute("title")).sort()),
      "copies shown by their names",
    ).toEqual([...names].sort());
  });

  test("a damaged video picked with + is refused with the reason, and nothing is added", async ({
    qa,
  }) => {
    const id = await openProject(qa, PROJECT);
    const [broken] = await onDisk(qa, { "camera take.mp4": "no_index.mp4" });
    await importWithPlus(qa, [broken]);
    await expect(notice(qa.page)).toContainText(
      /Couldn't import camera take\.mp4: .*it has no index/,
      { timeout: 20_000 },
    );
    expect(await savedRows(qa, id)).toEqual([]);
    await expect(libraryItem(qa.page, "camera take.mp4")).toHaveCount(0);
  });

  test("a damaged video picked with File > Import Media is refused with the reason too", async ({
    qa,
  }) => {
    knownBug(
      "File > Import Media drops a file it cannot import without saying why (it reports 'Linked 0 file(s)')",
      /the reason is shown/,
    );
    const id = await openProject(qa, PROJECT);
    const [broken] = await onDisk(qa, { "camera take.mp4": "no_index.mp4" });
    qa.shell.pickFiles([broken]);
    await fileMenu(qa, /^Import Media…$/);
    await expect(qa.page.getByText(/Linked \d file\(s\)|Couldn't import/).first()).toBeVisible({
      timeout: 20_000,
    });
    expect(await savedRows(qa, id)).toEqual([]);
    await expect(
      qa.page.getByText(/Couldn't import camera take\.mp4/),
      "the reason is shown",
    ).toBeVisible({ timeout: 2_000 });
  });

  test("a video dropped from Explorer onto the library is linked where it lies; one dropped onto a track is placed where it fell", async ({
    qa,
  }) => {
    const id = await openProject(qa, PROJECT);
    const [drone, pan] = await onDisk(qa, {
      "drone shot.mp4": "rgb_3s.mp4",
      "pan.mp4": "rgb_3s.hevc.mp4",
    });
    const wait = startTimer(
      `import: a dropped video to its library tile [${test.info().project.name}]`,
    );
    await osDrop(qa.page, [drone], libraryPane(qa.page));
    await expect(libraryItem(qa.page, "drone shot.mp4")).toBeVisible({ timeout: 30_000 });
    wait.stop();
    await expect
      .poll(async () => (await savedRows(qa, id)).map((r) => [r.path, r.external]))
      .toEqual([[drone, true]]);
    // A drop on the library only imports: the timeline was not touched.
    const clipsNow = async () =>
      ((await qa.savedTimeline(id))?.tracks ?? []).flatMap((t) =>
        (t.clips ?? []).map((c) => [t.id, c.media_ref, c.timeline_in]),
      );
    expect(await clipsNow()).toEqual([]);

    // Onto the very start of the v1 track, so it lands on frame 0 whatever the zoom.
    const lane = trackLane(qa.page, "v1");
    await expect(lane).toBeVisible({ timeout: 20_000 });
    await osDrop(qa.page, [pan], lane, { x: 2, y: 10 });
    await expect.poll(clipsNow).toContainEqual(["v1", idOf("rgb_3s.hevc.mp4"), 0]);
    expect(await savedRows(qa, id)).toContainEqual(
      expect.objectContaining({ id: idOf("rgb_3s.hevc.mp4"), path: pan, external: true }),
    );
    await expect(libraryItem(qa.page, "pan.mp4")).toBeVisible();
    // Linked, both of them: nothing was copied into the project.
    expect(await ownedFiles(qa, id)).toEqual([]);
  });

  test("a file the app does not open, dropped with a video, is turned away with a word to the person", async ({
    qa,
  }) => {
    knownBug(
      "Dropping a file the app does not import (a PDF) shows nothing at all: no import and no message",
      /the person is told/,
    );
    const id = await openProject(qa, PROJECT);
    const [pdf, clip] = await onDisk(qa, {
      "shot list.pdf": "notes.pdf",
      "take 1.mp4": "rgb_3s.mp4",
    });
    await osDrop(qa.page, [pdf, clip], libraryPane(qa.page));
    // The drop was handled: the video in it came in.
    await expect(libraryItem(qa.page, "take 1.mp4")).toBeVisible({ timeout: 30_000 });
    expect((await savedRows(qa, id)).map((r) => r.filename)).toEqual(["take 1.mp4"]);
    // ...and the person learns what happened to the PDF.
    await expect(
      qa.page.getByText(/shot list\.pdf|not imported|can't import|cannot import|not supported/i),
      "the person is told",
    ).toBeVisible({ timeout: 5_000 });
  });
});
