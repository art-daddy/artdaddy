// Living with the library: a clip dragged onto the timeline, a linked folder that moved (offline, then one Relink for
// the whole folder), a relink to the wrong kind of file, a copy into the project that outlives its original, the List
// view, a clip opened in its own tab, a clip sent to the chat, tags the agent puts on a clip, the agent refused a file
// by its path, and a clip the agent deletes. Judged on the screen and on the saved project (internals/library.json,
// internals/timeline.json). The agent runs on scripted replies (../agent-and-models/lib/fakeServer.ts).
//
//   npm run e2e:ui -- e2e/ui/media-library
import { readFileSync } from "node:fs";

import { expect, test, type AgentRig } from "../agent-and-models/lib/qa";
import { addClips } from "../agent-and-models/fixtures/replies/addClips";
import { deleteAsset } from "../agent-and-models/fixtures/replies/gatedCalls";
import { plainText } from "../agent-and-models/fixtures/replies/plainText";
import { callTools, type Round } from "../agent-and-models/lib/reply";
import {
  expectStage,
  fileMenu,
  fixture,
  itemMenu,
  libraryItem,
  libraryPane,
  moveFolder,
  notice,
  onDisk,
  openProject,
  ownedFiles,
  previewCannotDrawHere,
  restart,
  savedRows,
  sidecarsDone,
  stage,
  trackLane,
} from "./lib/media";

const PROJECT = "sweep_qa_media_library";

/** Import `files` (name on disk -> fixture) from one folder with File > Import Media; wait for every tile. */
async function importFolder(
  qa: AgentRig,
  files: Record<string, string>,
  folder = "shoot",
): Promise<string[]> {
  const paths = await onDisk(qa, files, folder);
  qa.shell.pickFiles(paths);
  await fileMenu(qa, /^Import Media…$/);
  for (const name of Object.keys(files))
    await expect(libraryItem(qa.page, name)).toBeVisible({ timeout: 30_000 });
  return paths;
}

/** Drag a library tile onto the start of a track with the mouse, as a person does. */
async function dragToTrack(qa: AgentRig, name: string, trackId = "v1"): Promise<void> {
  const from = await libraryItem(qa.page, name).boundingBox();
  const lane = await trackLane(qa.page, trackId).boundingBox();
  if (!from || !lane) throw new Error("the tile or the track is not on screen");
  await qa.page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await qa.page.mouse.down();
  await qa.page.mouse.move(lane.x + 40, lane.y + lane.height / 2, { steps: 12 });
  await qa.page.mouse.move(lane.x + 3, lane.y + lane.height / 2, { steps: 4 });
  await qa.page.mouse.up();
}

/** The clips on the saved timeline: track, media and first frame. */
const placed = async (qa: AgentRig, id: string) =>
  ((await qa.savedTimeline(id))?.tracks ?? []).flatMap((t) =>
    (t.clips ?? []).map((c) => ({ track: String(t.id), ref: c.media_ref, at: c.timeline_in })),
  );

/** The person closes the project, moves the footage folder on their drive, and opens the project again. */
async function moveWhileClosed(qa: AgentRig, from: string, to: string): Promise<void> {
  await fileMenu(qa, /^Close Project$/);
  await qa.page.waitForURL((u) => !u.pathname.startsWith("/p/"), { timeout: 20_000 });
  await sidecarsDone(qa);
  await moveFolder(qa, from, to);
  await qa.reopen(PROJECT);
}

test.describe("the media library", () => {
  test.setTimeout(180_000);

  test("a dragged clip lands where it was dropped; its folder moves, it shows offline everywhere, and one Relink brings every file in it back", async ({
    qa,
    browserName,
  }) => {
    const id = await openProject(qa, PROJECT);
    const [wide, tone] = await importFolder(qa, {
      "wide.mp4": "rgb_3s.mp4",
      "room tone.wav": "tone_2s.wav",
    });
    const ref = (await savedRows(qa, id)).find((r) => r.filename === "wide.mp4")!.id;
    await expect(trackLane(qa.page, "v1")).toBeVisible();
    await dragToTrack(qa, "wide.mp4");
    await expect.poll(async () => placed(qa, id)).toContainEqual({ track: "v1", ref, at: 0 });
    // The clip's sound comes with it, under it, from the same file.
    expect(await placed(qa, id)).toContainEqual({ track: "a1", ref, at: 0 });
    await expect(qa.page.getByText(/2 tracks · 2 clips/)).toBeVisible();

    // The person tidies their drive while the project is closed, then comes back to it.
    await moveWhileClosed(qa, "shoot", "shoot (moved)");
    await expect(notice(qa.page)).toContainText(
      "2 media files are offline — the source moved or was deleted. Relink from the library panel.",
      { timeout: 20_000 },
    );
    await expect(libraryPane(qa.page).getByText("Media Offline")).toHaveCount(2);
    // The playhead sits on the clip whose file is gone: the stage says why it is black.
    await expect(stage(qa.page).getByRole("status")).toContainText(
      "Media offline: wide.mp4 — relink it in the library.",
    );
    // Nothing was lost: the rows and the clips are all still there.
    expect((await savedRows(qa, id)).map((r) => r.path).sort()).toEqual([tone, wide].sort());
    expect((await placed(qa, id)).filter((c) => c.track === "v1")).toHaveLength(1);

    // Relink the one; its neighbour in the same folder is found by its name.
    const moved = qa.shell.virtual("media/shoot (moved)/wide.mp4");
    qa.shell.pickFiles([moved]);
    await itemMenu(qa.page, "wide.mp4", "Relink…");
    await expect(qa.page.getByText("Relinked 2 files.")).toBeVisible({ timeout: 20_000 });
    expect((await savedRows(qa, id)).map((r) => [r.filename, r.path]).sort()).toEqual(
      [
        ["room tone.wav", qa.shell.virtual("media/shoot (moved)/room tone.wav")],
        ["wide.mp4", moved],
      ].sort(),
    );
    await expect(libraryPane(qa.page).getByText("Media Offline")).toHaveCount(0);
    await expect(stage(qa.page).getByText(/Media offline:/)).toHaveCount(0);
    // ...and the picture is back on the stage.
    if (!previewCannotDrawHere(browserName)) await expectStage(qa.page, "red");

    // The relink holds after a restart: no file offline, the picture there at once.
    await restart(qa, PROJECT);
    await expect(trackLane(qa.page, "v1")).toBeVisible({ timeout: 30_000 });
    await expect(libraryItem(qa.page, "wide.mp4")).toBeVisible();
    await expect(libraryPane(qa.page).getByText("Media Offline")).toHaveCount(0);
    await expect(qa.page.getByText(/media files? (is|are) offline/)).toHaveCount(0);
    if (!previewCannotDrawHere(browserName)) await expectStage(qa.page, "red");
  });

  test("Relink refuses a picture in place of a video, Cancel changes nothing, and an offline file cannot be copied in", async ({
    qa,
  }) => {
    const id = await openProject(qa, PROJECT);
    const [wide] = await importFolder(qa, { "wide.mp4": "rgb_3s.mp4" });
    await onDisk(qa, { "poster.png": "orange.png" }, "elsewhere");
    await moveWhileClosed(qa, "shoot", "gone");
    await expect(libraryPane(qa.page).getByText("Media Offline")).toHaveCount(1, {
      timeout: 20_000,
    });

    qa.shell.pickFiles([qa.shell.virtual("media/elsewhere/poster.png")]);
    await itemMenu(qa.page, "wide.mp4", "Relink…");
    await expect(
      qa.page.getByText("'poster.png' is not a video file, so it cannot stand in for 'wide.mp4'."),
    ).toBeVisible({ timeout: 20_000 });
    expect((await savedRows(qa, id)).map((r) => r.path)).toEqual([wide]);

    const dialogs = () => qa.shell.calls.filter((c) => c.cmd === "plugin:dialog|open").length;
    const opened = dialogs();
    qa.shell.pickFiles(null);
    await itemMenu(qa.page, "wide.mp4", "Relink…");
    await expect.poll(dialogs).toBe(opened + 1);
    expect((await savedRows(qa, id)).map((r) => r.path)).toEqual([wide]);
    await expect(libraryPane(qa.page).getByText("Media Offline")).toHaveCount(1);

    await itemMenu(qa.page, "wide.mp4", "Copy into project");
    await expect(
      qa.page.getByText("'wide.mp4' is offline — relink it before copying it in"),
    ).toBeVisible({ timeout: 10_000 });
    expect(await ownedFiles(qa, id)).toEqual([]);
  });

  test("a linked file copied into the project keeps working after its original is gone", async ({
    qa,
    browserName,
  }) => {
    const id = await openProject(qa, PROJECT);
    await importFolder(qa, { "wide.mp4": "rgb_3s.mp4" });
    await dragToTrack(qa, "wide.mp4");
    await expect
      .poll(async () => (await placed(qa, id)).filter((c) => c.track === "v1").length)
      .toBe(1);
    const [row] = await savedRows(qa, id);
    await itemMenu(qa.page, "wide.mp4", "Copy into project");
    await expect(qa.page.getByText("Copied into the project.")).toBeVisible({ timeout: 20_000 });
    expect(await ownedFiles(qa, id)).toEqual([`${row.id}.mp4`]);

    // The original goes away; the project does not care any more.
    await moveWhileClosed(qa, "shoot", "deleted");
    await expect(qa.page.getByText(/media files? (is|are) offline/)).toHaveCount(0);
    await expect(stage(qa.page).getByText(/Media offline:/)).toHaveCount(0);
    expect(await savedRows(qa, id)).toEqual([
      expect.objectContaining({ id: row.id, path: `library/${row.id}.mp4` }),
    ]);
    expect((await placed(qa, id)).filter((c) => c.track === "v1")).toEqual([
      { track: "v1", ref: row.id, at: 0 },
    ]);
    if (!previewCannotDrawHere(browserName)) await expectStage(qa.page, "red");
  });

  test("the List view lists the files and is still chosen after a restart", async ({ qa }) => {
    const id = await openProject(qa, PROJECT);
    await importFolder(qa, { "wide.mp4": "rgb_3s.mp4", "room tone.wav": "tone_2s.wav" });
    const ids = (await savedRows(qa, id)).map((r) => r.id).sort();
    const tile = libraryPane(qa.page).locator("button[title='wide.mp4']");
    // A list row carries the file's place (its library id, for a linked file) as its tooltip.
    const listRow = libraryPane(qa.page).locator(`[title="${ids[0]}"]`);

    await libraryPane(qa.page).getByText("Library").click({ button: "right" });
    await qa.page.getByRole("menuitem", { name: "List" }).click();
    await expect(listRow).toHaveCount(1);
    await expect(tile).toHaveCount(0);
    for (const name of ["wide.mp4", "room tone.wav"])
      await expect(libraryItem(qa.page, name)).toBeVisible();

    await restart(qa, PROJECT);
    await expect(libraryItem(qa.page, "wide.mp4")).toBeVisible({ timeout: 20_000 });
    await expect(listRow).toHaveCount(1);
    await expect(tile).toHaveCount(0);
    // The same rows, under the same ids, after the restart.
    expect((await savedRows(qa, id)).map((r) => r.id).sort()).toEqual(ids);

    await libraryPane(qa.page).getByText("Library").click({ button: "right" });
    await qa.page.getByRole("menuitem", { name: "Thumbnails" }).click();
    await expect(tile).toBeVisible();
    await expect(listRow).toHaveCount(0);
  });

  test("a library clip opens in its own tab, plays there, and closing the tab returns to the live preview", async ({
    qa,
    browserName,
  }) => {
    await openProject(qa, PROJECT);
    await importFolder(qa, { "wide.mp4": "rgb_3s.mp4" });
    await libraryItem(qa.page, "wide.mp4").click();
    const tab = qa.page.getByRole("tab", { name: "wide.mp4" });
    await expect(tab).toHaveAttribute("aria-selected", "true");
    await expect(tab).toHaveClass(/italic/); // one click: a passing look, replaced by the next one
    await tab.dblclick();
    await expect(tab).not.toHaveClass(/italic/); // kept

    if (!previewCannotDrawHere(browserName)) {
      const time = stage(qa.page).getByText(/^\d:\d\d \/ 0:03$/);
      await expect(time).toHaveText("0:00 / 0:03", { timeout: 20_000 });
      await stage(qa.page).getByRole("button", { name: "play" }).click();
      await expect(time).not.toHaveText("0:00 / 0:03", { timeout: 10_000 });
      await stage(qa.page).getByRole("button", { name: "pause" }).click();
    }

    await qa.page.getByRole("button", { name: "close wide.mp4" }).click();
    await expect(qa.page.getByRole("tab", { name: "Live preview" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(qa.page.getByRole("tab", { name: "wide.mp4" })).toHaveCount(0);
  });

  test("Add to chat puts the clip in the message, the agent is told which clip it is, and the tags it puts on it are saved", async ({
    qa,
  }) => {
    const id = await openProject(qa, PROJECT);
    await importFolder(qa, { "wide.mp4": "rgb_3s.mp4" });
    const [row] = await savedRows(qa, id);
    await itemMenu(qa.page, "wide.mp4", "Add to chat");
    await expect(qa.pane.getByText("wide.mp4")).toBeVisible();

    let told: Round["toolResults"] = [];
    qa.server.script(
      callTools(
        [
          {
            name: "library_op",
            arguments: { action: "update", id: row.id, tags: ["b-roll", " beach "] },
          },
        ],
        "Tagging it.",
      ),
      (round: Round) => {
        told = round.toolResults;
        return plainText("Tagged as b-roll and beach.");
      },
    );
    await qa.send("Tag this clip as b-roll and beach");
    await expect(qa.reply("Tagged as b-roll and beach.")).toBeVisible({ timeout: 20_000 });
    // The round carried the clip the person put in the message, by its library id.
    expect(JSON.stringify(qa.server.modelRounds()[0].body)).toContain(row.id);
    expect(told[0]?.result.ok).toBe(true);
    await expect.poll(async () => (await savedRows(qa, id))[0]?.tags).toEqual(["b-roll", "beach"]);
    // The person's view of the clip is unchanged by it.
    await expect(libraryItem(qa.page, "wide.mp4")).toBeVisible();
  });

  test("the agent cannot place a file by its path: the tool refuses, and nothing enters the project", async ({
    qa,
  }) => {
    const id = await openProject(qa, PROJECT);
    const [loose] = await onDisk(qa, { "loose.mp4": "rgb_3s.mp4" }, "desktop");
    let told: Round["toolResults"] = [];
    qa.server.script(addClips(loose, 90, "v1"), (round: Round) => {
      told = round.toolResults;
      return plainText("I need to import it first.");
    });
    await qa.send("Put loose.mp4 from my desktop on the timeline");
    await expect(qa.reply("I need to import it first.")).toBeVisible({ timeout: 20_000 });
    await qa.idle();
    expect(told[0]?.name).toBe("add_clips");
    expect(told[0]?.result.ok).toBe(false);
    expect(JSON.stringify(told[0]?.result)).toMatch(/library asset/);
    expect(await savedRows(qa, id)).toEqual([]);
    expect(await placed(qa, id)).toEqual([]);
    await expect(libraryPane(qa.page).getByText("No files yet.")).toBeVisible();
  });

  test("a clip deleted from the library by the agent takes its clips with it, leaves the file, and stays gone", async ({
    qa,
  }) => {
    const id = await openProject(qa, PROJECT);
    const [wide] = await importFolder(qa, { "wide.mp4": "rgb_3s.mp4" });
    await dragToTrack(qa, "wide.mp4");
    await expect.poll(async () => (await placed(qa, id)).length).toBeGreaterThan(0);
    const [row] = await savedRows(qa, id);
    qa.server.script(deleteAsset(row.id), plainText("Removed it, and its clips."));
    await qa.send("Remove wide.mp4 from the project");
    await qa.pane.getByRole("button", { name: "Delete", exact: true }).click({ timeout: 20_000 });
    await expect(qa.reply("Removed it, and its clips.")).toBeVisible({ timeout: 20_000 });
    await expect.poll(async () => (await savedRows(qa, id)).length).toBe(0);
    await expect.poll(async () => placed(qa, id)).toEqual([]);
    await expect(libraryItem(qa.page, "wide.mp4")).toHaveCount(0);
    // A linked file is the person's: deleting it from the library never touches it.
    expect(readFileSync(qa.shell.real(wide)).equals(readFileSync(fixture("rgb_3s.mp4")))).toBe(
      true,
    );
    await restart(qa, PROJECT);
    await expect(trackLane(qa.page, "v1")).toBeVisible({ timeout: 30_000 });
    await expect(libraryPane(qa.page).getByText("No files yet.")).toBeVisible();
    expect(await placed(qa, id)).toEqual([]);
  });
});
