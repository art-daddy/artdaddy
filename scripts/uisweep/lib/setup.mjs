// Fixture project + timeline setup for the sweep.
//
// Setup drives the app's OWN paths (menu, file input, drag from the library) rather than
// writing project files behind its back — a fixture built by a second writer would not
// exercise the same invariants the gestures under test rely on.
//
// It never touches an existing project: a fresh one per run, per the rule that a
// test must not mutate the user's real work.
import { libraryLabel, libraryPath, readDoc, readLibrary, settled, waitForChange } from "./doc.mjs";
import { pxPerFrame } from "./driver.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Create a project through File > New Project and return its id.
 *
 *  The id comes from the ROUTE, not from "newest directory on disk": with a project
 *  already open, a `startsWith('/p/')` wait is satisfied before anything happens, and the
 *  run silently proceeds against the previous project. */
export async function newProject(d, name, aspect = "9:16") {
  // The debugger answers before the app shell renders, so a run started right after
  // launch reports "nothing matching File" and looks like a broken menu.
  await d.waitFor(
    `[...document.querySelectorAll('button')].some(b => (b.innerText ?? '').trim() === 'File')`,
    60000,
  );
  await d.key("Escape");
  if (await d.eval(`location.pathname.startsWith('/p/')`)) {
    await d.clickText("File", "button");
    await d.clickText("Close Project", "button");
    await d.waitFor(`!location.pathname.startsWith('/p/')`, 15000);
    await sleep(500);
  }
  const was = await d.eval(`location.pathname`);
  await d.clickText("File", "button");
  await d.clickText("New Project", "button");
  await d.waitFor(`!!document.querySelector('input[placeholder="Project name\u2026"]')`);
  await d.click(`input[placeholder="Project name\u2026"]`);
  await d.type(name);
  await d.eval(
    `(() => { const s = [...document.querySelectorAll('select')]
        .find(x => [...x.options].some(o => o.value === '9:16'));
      if (s && s.value !== ${JSON.stringify(aspect)}) {
        s.value = ${JSON.stringify(aspect)};
        s.dispatchEvent(new Event('change', { bubbles: true }));
      } return true; })()`,
  );
  await d.clickText("Create", "button");
  await d.waitFor(
    `location.pathname.startsWith('/p/') && location.pathname !== ${JSON.stringify(was)}`,
    30000,
  );
  await sleep(1500);
  return String(await d.eval(`location.pathname.split('/p/')[1]`));
}

/** Import files through the library's hidden file input (the native dialog is undriveable). */
export async function importMedia(d, projectId, files) {
  await d.waitFor(`!!document.querySelector('input[type=file][accept*="video"]')`);
  await d.setFiles(`input[type=file][accept*="video"]`, files);
  // Import stages bytes, probes, and may transcode a proxy — wait on the MANIFEST, which
  // is the thing a later step resolves names through, not on a label appearing.
  const want = files.length;
  const start = Date.now();
  for (;;) {
    if ((readLibrary(projectId).clips ?? []).length >= want) break;
    if (Date.now() - start > 120000)
      throw new Error(
        `import timed out: only ${(readLibrary(projectId).clips ?? []).length}/${want} staged`,
      );
    await sleep(300);
  }
  await sleep(800);
}

/** Put a library asset on a lane.
 *
 *  Setup, not the thing under test: it calls the editor's own `addClip` through the dev
 *  seam so a scenario starts from an exact known timeline. Dragging FROM the library is
 *  covered as its own scenario, through real input. */
export async function placeFromLibrary(d, projectId, filename, trackId, atFrame = 0) {
  const rel = libraryPath(projectId, filename);
  if (!rel) throw new Error(`placeFromLibrary: ${filename} is not in the library manifest`);
  const before = readDoc(projectId);
  const r = await d.eval(
    `window.__artdaddyTest.editor.getState()
       .addClip(${JSON.stringify(rel)}, ${JSON.stringify(trackId)}, ${Number(atFrame)})
       .then(() => 'ok', e => 'threw: ' + String(e))`,
  );
  if (r !== "ok") throw new Error(`placeFromLibrary: ${r}`);
  const after = await waitForChange(projectId, before, 25000);
  if (!after) throw new Error(`placeFromLibrary: ${filename} never reached the document`);
  await settled(projectId);
  return after;
}

/** Drag a library row onto a lane with REAL input — the drag-drop path itself. */
export async function dragFromLibrary(d, projectId, filename, trackId, atX = null) {
  const label = libraryLabel(projectId, filename);
  const item = await d.eval(
    `(() => { const want = ${JSON.stringify(label)};
       const e = [...document.querySelectorAll('[draggable="true"]')]
         .find(x => (x.innerText ?? '').includes(want) && x.getBoundingClientRect().height > 0);
       if (!e) return null; e.scrollIntoView({ block: 'center' });
       const r = e.getBoundingClientRect();
       return { x: r.x + r.width/2, y: r.y + r.height/2 }; })()`,
  );
  if (!item) throw new Error(`dragFromLibrary: no draggable row labelled ${label}`);
  const lane = await laneRect(d, trackId);
  if (!lane) throw new Error(`dragFromLibrary: no lane ${trackId}`);
  return d.dragAndDrop(item, { x: atX ?? lane.x + 4, y: lane.cy });
}

/** Empty every track, then place `specs` — each scenario starts from a stated timeline
 *  rather than from whatever the previous one left behind.
 *
 *  Each clip is trimmed to its length BEFORE the next is placed: placement is an
 *  overwrite, so a full-length clip dropped first gets carved up by the next one and
 *  leaves fragments the scenario never asked for. */
export async function resetTimeline(d, projectId, specs = []) {
  await d.key("Escape");
  await d.resetScroll();
  // Snapping is modal and survives a scenario, so put it back ON — a scenario that turned it
  // off would otherwise silently change where every later drag lands. Same class of leak as
  // the track lock below.
  await setSnapping(d, true);
  // Clear per-track MODES first: a locked lane refuses the placements below, and `assertOneUndo`
  // ends on a REDO, so any scenario that toggles a mode hands the next one that mode still on.
  // Mute belongs here for the same reason lock does — it was missing, and a leaked `mute a1`
  // turned up in the diagnostics of a lock scenario that failed only in a full run.
  const dirty = await d.eval(
    `(() => { const tl = window.__artdaddyTest.editor.getState().timeline;
       return (tl?.tracks ?? []).filter(t => t.locked === true || t.solo === true || t.mute === true)
         .map(t => String(t.id)); })()`,
  );
  if (dirty?.length) {
    await d.eval(
      `window.__artdaddyTest.editor.getState().setTracks(${JSON.stringify(
        dirty.map((id) => ({ trackId: id, locked: false, solo: false, mute: false })),
      )}).then(() => 'ok')`,
    );
    await settled(projectId);
  }
  const ids = await d.eval(
    `(() => { const tl = window.__artdaddyTest.editor.getState().timeline;
       return (tl?.tracks ?? []).flatMap(t => (t.clips ?? []).map(c => String(c.id))); })()`,
  );
  if (ids?.length) {
    const before = readDoc(projectId);
    await d.eval(
      `window.__artdaddyTest.editor.getState().deleteClips(${JSON.stringify(ids)}).then(() => 'ok')`,
    );
    await waitForChange(projectId, before, 15000);
    await settled(projectId);
  }
  for (const s of specs) {
    const at = s.at ?? 0;
    await placeFromLibrary(d, projectId, s.media, s.track, at);
    if (typeof s.len !== "number") continue;
    const c = await clipAt(d, s.track, at);
    if (!c || c.tout - c.tin === s.len) continue;
    const before = readDoc(projectId);
    await d.eval(
      `window.__artdaddyTest.editor.getState().trimClip(${JSON.stringify(c.id)},
         { timeline_out: ${at + s.len} }).then(() => 'ok')`,
    );
    await waitForChange(projectId, before, 15000);
    await settled(projectId);
  }
  // The document settling is not the DOM settling: a scenario that measures a handle now
  // and drags a moment later can grab coordinates React has since moved. Wait for the
  // drawn clip count to match what was placed, then let one more frame land.
  const doc = await settled(projectId);
  const want = (doc?.tracks ?? []).reduce((n, t) => n + (t.clips ?? []).length, 0);
  await d
    .waitFor(`document.querySelectorAll('[aria-label="trim end"]').length === ${want}`, 8000)
    .catch(() => {});
  await d.resetScroll();
  await sleep(250);
  return doc;
}

/** Force the snapping mode to `on` and PROVE it took.
 *
 *  Blind-toggling with the S key would drift the moment anything else changed the mode;
 *  this reads the toolbar button's own `aria-pressed` — the same state the drag code uses —
 *  and only clicks when it disagrees. */
export async function setSnapping(d, on) {
  const state = () =>
    d.eval(`document.querySelector('[aria-label="snapping"]')?.ariaPressed ?? null`);
  if ((await state()) === null) throw new Error("setSnapping: no snapping toggle in the toolbar");
  if ((await state()) !== String(on)) await d.click('[aria-label="snapping"]');
  const got = await state();
  if (got !== String(on)) throw new Error(`setSnapping(${on}): toggle still reads ${got}`);
}

/** The clip starting at `frame` on `track`, straight from the live store. */
export function clipAt(d, track, frame) {
  return d.eval(
    `(() => { const tl = window.__artdaddyTest.editor.getState().timeline;
       const t = (tl?.tracks ?? []).find(t => String(t.id) === ${JSON.stringify(track)});
       const c = (t?.clips ?? []).find(c => (Number(c.timeline_in) || 0) === ${Number(frame)});
       return c ? { id: String(c.id), tin: c.timeline_in, tout: c.timeline_out } : null; })()`,
  );
}

/** Screen x for a timeline frame on `track`, and px-per-frame — both CALIBRATED from what
 *  is drawn against what is saved, so a trim expectation can be stated in frames without
 *  re-implementing the app's own frame<->pixel conversion. */
export async function ruler(d, t, track) {
  const clips = await t.track(track);
  const els = await d.clipEls();
  if (!clips.length || !els.length) return null;
  // Match each drawn element to a saved clip by width, then solve x = origin + frame*px.
  const c = clips[0];
  const el =
    els.find((e) => Math.abs(e.w / (c.tout - c.tin) - els[0].w / (c.tout - c.tin)) < 1e-6) ??
    els[0];
  const px = el.w / (c.tout - c.tin);
  const origin = el.x - c.tin * px;
  return { px, origin, xOf: (frame) => origin + frame * px };
}

/** Lane rect for a track id — the lane element states its own identity, so no guessing. */
export function laneRect(d, trackId) {
  return d.eval(
    `(() => { const e = document.querySelector('[data-track-id=${JSON.stringify(trackId)}]');
       if (!e) return null; const r = e.getBoundingClientRect();
       return { x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width/2, cy: r.y + r.height/2 }; })()`,
  );
}

/** Every lane, top to bottom, with the track id it belongs to. */
export function laneRects(d) {
  return d.eval(
    `(() => [...document.querySelectorAll('[data-track-id]')].map(e => {
        const r = e.getBoundingClientRect();
        return { track: e.getAttribute('data-track-id'), x: r.x, y: r.y, w: r.width, h: r.height,
                 cx: r.x + r.width/2, cy: r.y + r.height/2 }; }))()`,
  );
}

/** Calibrate px-per-frame from what is actually drawn against what is actually saved. */
export async function calibrate(d, ctx) {
  const els = await d.clipEls();
  const c = await ctx.clips();
  for (const el of els) {
    for (const v of Object.values(c)) {
      const p = pxPerFrame(el, v);
      if (p && p > 0.01) return p;
    }
  }
  return null;
}
