// Save, then reopen, gives back the same project: whatever a person made, the next launch opens
// exactly that. A property over generated projects (any tracks and clips the timeline accepts, any
// text, settings and library, fields from a newer build), saved through the app's own writers (the
// open document's autosave for the timeline, the settings update for project.json, the catalog's one
// write for library.json) and reopened the way the next launch reads them.
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";

import { ProjectDisk } from "../test/projectDisk";
import { registerTestDocument, resetTestDocuments } from "../test/timelineKit";
import { writeLibraryCatalog } from "../tools/libraryCatalog";
import { ProjectRegistry } from "../tools/project";
import { ProjectStoreAccess } from "../tools/store";
import { ensureStarterTimeline, replaceTimeline } from "./engine";
import type { Clip, Timeline, Track } from "./model";

const DATA_ROOT = "C:/Users/someone/AppData/Roaming/ArtDaddy";
const PROJECTS = `${DATA_ROOT}/projects`;
const REGISTRY = `${DATA_ROOT}/projects.json`;

/** A number as JSON keeps it (-0 is written as 0). */
const num = (a: fc.Arbitrary<number>) => a.map((v) => (Object.is(v, -0) ? 0 : v));
const text = fc.oneof(
  fc.string({ unit: "binary", maxLength: 40 }),
  fc.constantFrom("", "\u2028", "🎬 title", "\u202Eright to left", "x".repeat(2000)),
);
/** Fields a newer build may have written, which this build must carry along untouched. */
const future = fc.dictionary(
  fc.string({ minLength: 1, maxLength: 8 }).map((s) => `future_${s}`),
  fc.jsonValue({ maxDepth: 2 }).map((v) => JSON.parse(JSON.stringify(v)) as unknown),
  { maxKeys: 2 },
);
const keyframes = fc
  .array(
    fc.record({
      dt: fc.integer({ min: 1, max: 90 }),
      v: num(fc.double({ min: -2, max: 4, noNaN: true })),
      ease: fc.constantFrom("linear", "hold", "ease-in", "ease-out", "ease-in-out"),
    }),
    { minLength: 1, maxLength: 4 },
  )
  .map((list) => {
    let t = -1;
    return list.map(({ dt, v, ease }) => ({ t: (t += dt), v, ease }));
  });
const animatable = fc.oneof(num(fc.double({ min: 0, max: 1, noNaN: true })), keyframes);
const mediaRef = fc.stringMatching(/^media_[0-9a-f]{12}$/);

/** The clip-shaped part of one slot on a track: its own fields, apart from where it sits. */
function slot(kind: Track["kind"]) {
  const common = {
    gap: fc.integer({ min: 0, max: 600 }),
    dur: fc.integer({ min: 1, max: 900 }),
    extra: future,
    disabled: fc.option(fc.boolean(), { nil: undefined }),
  };
  if (kind === "text")
    return fc.record({
      ...common,
      content: fc.array(fc.record({ text }), { minLength: 1, maxLength: 3 }),
      style: fc.option(
        fc.record({
          preset: fc.constantFrom("boxed", "headline", "minimal"),
          size: fc.integer({ min: 8, max: 200 }),
        }),
        { nil: undefined },
      ),
    });
  return fc.record({
    ...common,
    media: mediaRef,
    still: kind === "video" ? fc.boolean() : fc.constant(false),
    window: fc.option(
      fc.record({
        from: fc.integer({ min: 0, max: 100_000 }),
        speed: fc.constantFrom(1, 0.5, 2, 1.25),
      }),
      { nil: undefined },
    ),
    opacity: kind === "video" ? fc.option(animatable, { nil: undefined }) : fc.constant(undefined),
    volume: kind === "audio" ? fc.option(animatable, { nil: undefined }) : fc.constant(undefined),
    fade:
      kind === "audio"
        ? fc.option(
            fc.record({
              in: fc.integer({ min: 0, max: 60 }),
              out: fc.integer({ min: 0, max: 60 }),
            }),
            { nil: undefined },
          )
        : fc.constant(undefined),
    transform:
      kind === "video"
        ? fc.option(
            fc.record({
              position: fc.record({
                x: num(fc.double({ min: -1, max: 2, noNaN: true })),
                y: num(fc.double({ min: -1, max: 2, noNaN: true })),
              }),
              scale: animatable,
            }),
            { nil: undefined },
          )
        : fc.constant(undefined),
    crossfade:
      kind === "video"
        ? fc.option(fc.double({ min: 0, max: 1, noNaN: true }), { nil: undefined })
        : fc.constant(undefined),
    effects:
      kind === "video"
        ? fc.option(fc.constant([{ type: "vignette", params: { vignette: 0.3 } }]), {
            nil: undefined,
          })
        : fc.constant(undefined),
  });
}

/** A track the timeline accepts: clips in order, none overlapping, every source window matching its
 *  span at its speed, a crossfade never longer than either clip it joins. */
function track(kind: Track["kind"], index: number): fc.Arbitrary<Track> {
  return fc
    .record({
      slots: fc.array(slot(kind), { maxLength: 5 }),
      mute: fc.option(fc.boolean(), { nil: undefined }),
      hidden: fc.option(fc.boolean(), { nil: undefined }),
      extra: future,
    })
    .map(({ slots, mute, hidden, extra }) => {
      let at = 0;
      let prevLen = 0;
      const clips: Clip[] = slots.map((s, i) => {
        const timeline_in = at + s.gap;
        const timeline_out = timeline_in + s.dur;
        at = timeline_out;
        const clip: Clip = { ...s.extra, id: `${kind[0]}${index}_${i}`, timeline_in, timeline_out };
        if (s.disabled !== undefined) clip.disabled = s.disabled;
        if ("content" in s) {
          clip.kind = "text";
          clip.content = s.content;
          if (s.style) clip.style = s.style;
        } else {
          clip.kind = kind === "audio" ? "audio" : s.still ? "image" : "video";
          clip.media_ref = s.media;
          if (s.window && !s.still) {
            clip.source_in = s.window.from;
            clip.source_out = s.window.from + Math.round(s.dur * s.window.speed);
            if (s.window.speed !== 1) clip.speed = s.window.speed;
          }
          if (s.opacity !== undefined) clip.opacity = s.opacity;
          if (s.volume !== undefined) clip.volume = s.volume;
          if (s.fade) clip.fade = s.fade;
          if (s.transform) clip.transform = s.transform;
          if (s.effects) clip.effects = s.effects;
          if (s.crossfade !== undefined && i > 0)
            clip.transition_in = {
              kind: "crossfade",
              duration: Math.max(1, Math.floor(s.crossfade * Math.min(s.dur, prevLen))),
            };
        }
        prevLen = s.dur;
        return clip;
      });
      const t: Track = { ...extra, id: `${kind[0]}${index}`, kind, z: index, clips };
      if (mute !== undefined) t.mute = mute;
      if (hidden !== undefined) t.hidden = hidden;
      return t;
    });
}

const timelineArb: fc.Arbitrary<Timeline> = fc
  .record({
    canvas: fc.record({
      width: fc.integer({ min: 64, max: 8192 }),
      height: fc.integer({ min: 64, max: 8192 }),
      fps: fc.constantFrom(24, 25, 30, 50, 60, 120),
    }),
    kinds: fc.array(fc.constantFrom<Track["kind"]>("video", "audio", "text"), {
      minLength: 1,
      maxLength: 5,
    }),
    canvasAuto: fc.option(fc.boolean(), { nil: undefined }),
    extra: future,
  })
  .chain(({ canvas, kinds, canvasAuto, extra }) =>
    fc.tuple(...kinds.map((k, i) => track(k, i))).map((tracks) => {
      const tl: Timeline = { ...extra, units: "frames", canvas, tracks, failures: [] };
      if (canvasAuto !== undefined) tl.canvas_auto = canvasAuto;
      return tl;
    }),
  );

const projectArb = fc.record({
  timeline: timelineArb,
  name: text.filter((s) => s.trim().length > 0),
  settings: fc.record({
    canvas: fc.record({
      width: fc.integer({ min: 64, max: 8192 }),
      height: fc.integer({ min: 64, max: 8192 }),
      fps: fc.integer({ min: 1, max: 120 }),
    }),
    model_id: text,
    active_style: text,
    active_workflow: text,
    planning_mode: fc.constant("beats"),
    future: future,
  }),
  library: fc.record({
    version: fc.constant(1),
    clips: fc.array(
      fc.record({
        id: mediaRef,
        filename: text,
        kind: fc.constantFrom("video", "audio", "image"),
        size_bytes: fc.integer({ min: 0, max: 2 ** 40 }),
        added_by: fc.constantFrom("import_media", "import_reference", "generation", "download"),
        added_at: num(fc.double({ min: 1.6e9, max: 2.1e9, noNaN: true })),
        aliases: fc.array(text, { maxLength: 2 }),
        extra: future,
      }),
      { maxLength: 6 },
    ),
    folders: fc.array(fc.record({ name: text }), { maxLength: 2 }),
  }),
});

afterEach(() => resetTestDocuments());

describe("save, then reopen", () => {
  it("gives back the same timeline, settings and library (property)", async () => {
    await fc.assert(
      fc.asyncProperty(projectArb, async ({ timeline, name, settings: s, library }) => {
        const disk = new ProjectDisk();
        const reg = new ProjectRegistry(PROJECTS, REGISTRY, disk);
        const { id, dir } = await reg.createProject(name, s.canvas, s.model_id);
        await reg.register({ id, name, path: dir, lastOpenedAt: new Date(0).toISOString() }, true);
        const settings = {
          ...s.future,
          canvas: s.canvas,
          model_id: s.model_id,
          active_style: s.active_style,
          active_workflow: s.active_workflow,
          planning_mode: s.planning_mode,
        };
        const catalog = {
          ...library,
          clips: library.clips.map(({ extra, ...row }) => ({
            ...extra,
            ...row,
            path: `library/${row.id}.bin`,
          })),
        };

        // Save, through the app's own writers, while the project is open.
        const store = new ProjectStoreAccess(dir, disk);
        const doc = registerTestDocument(dir);
        expect(await replaceTimeline(store, structuredClone(timeline))).toBe(true);
        await reg.updateProject(id, (pj) => ({ ...pj, name, settings }));
        expect(await writeLibraryCatalog(store, catalog)).toBe(true);
        await doc.autosave.flush();
        await resetTestDocuments();

        // The next launch.
        const again = new ProjectStoreAccess(dir, disk);
        expect(await ensureStarterTimeline(again)).toEqual(timeline);
        const opened = await new ProjectRegistry(PROJECTS, REGISTRY, disk).openProjectData(id);
        expect(opened.ok).toBe(true);
        expect(opened.ok && opened.data).toMatchObject({ id, name, settings, schemaVersion: 1 });
        expect(opened.ok && opened.data.settings).toEqual(settings);
        expect(await again.listClips()).toEqual(catalog.clips);
      }),
      { numRuns: 150 },
    );
  }, 120_000);
});
