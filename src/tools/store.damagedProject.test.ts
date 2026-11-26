// A damaged project file never crashes the app, never costs the person the bytes they had, and the
// person is told; and a valid file with unusual content opens exactly as written.
//
// The project is today's golden (__fixtures__/goldenProjects/0.29.1, written by 0.29.1's own code):
// one of its documents is damaged on disk, then the project is opened the way the window opens it
// (store/projects.ts refresh and open, the editor's load, then the catalog check every opened
// project gets from project/documentRegistry.ts recoverGeneratedMedia). The disk reads bytes the way
// the desktop app does (a byte-order mark is dropped by the decoder), so what "damaged" means here is
// what it means on a person's PC.
import fc from "fast-check";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { stopHeartbeat } from "../api/appEvents";
import { setProjectStoreFactory, setRunnerFactory, useEditor } from "../store/editor";
import { IndexCoordinator } from "../store/indexCoordinator";
import { useProjectNotice } from "../store/projectNotice";
import { useProjects } from "../store/projects";
import type { Timeline } from "../timeline/model";
import { ProjectDisk } from "../test/projectDisk";
import { reconcilePendingMedia } from "./import";
import { INTERNAL_DIR, joinPath, ProjectStoreAccess, type LibraryClip } from "./store";

const APPDATA = "C:/Users/golden/AppData/Roaming";
const DATA_ROOT = `${APPDATA}/ArtDaddy`;

const disk = vi.hoisted(() => ({ current: null as unknown }));

vi.mock("@tauri-apps/api/path", async (orig) => ({
  ...(await orig<typeof import("@tauri-apps/api/path")>()),
  dataDir: async () => "C:/Users/golden/AppData/Roaming",
}));
vi.mock("@tauri-apps/api/core", async (orig) => ({
  ...(await orig<typeof import("@tauri-apps/api/core")>()),
  invoke: async (cmd: string) => {
    if (cmd === "get_env") return null;
    throw new Error(`no desktop bridge in this test: ${cmd}`);
  },
}));
vi.mock("@tauri-apps/plugin-fs", async (orig) => ({
  ...(await orig<typeof import("@tauri-apps/plugin-fs")>()),
  readTextFile: (path: string) => (disk.current as ProjectDisk).readTextFile(path),
}));
vi.mock("./tauri", async (orig) => ({
  ...(await orig<typeof import("./tauri")>()),
  TauriFs: class {
    constructor() {
      return disk.current as ProjectDisk;
    }
  },
}));

const RELEASE = "0.29.1";
const GOLDEN = join(__dirname, "__fixtures__", "goldenProjects", RELEASE);
const golden = JSON.parse(readFileSync(join(GOLDEN, "golden.json"), "utf8")) as {
  dataFolder: string;
  linkedOutsideProject: string;
  projects: Array<{
    id: string;
    name: string;
    readBack: { timeline: Timeline; library: LibraryClip[] };
  }>;
};
const MAIN = golden.projects[0];
const OTHER = golden.projects[1];
const DIR = `${DATA_ROOT}/projects/${MAIN.id}`;
const FILES = {
  "timeline.json": joinPath(DIR, INTERNAL_DIR, "timeline.json"),
  "project.json": joinPath(DIR, INTERNAL_DIR, "project.json"),
  "library.json": joinPath(DIR, INTERNAL_DIR, "library.json"),
  "projects.json": `${DATA_ROOT}/projects.json`,
} as const;
type Doc = keyof typeof FILES;
const DOCS = Object.keys(FILES) as Doc[];

/** Today's golden data folder, with the linked file present so nothing reads as offline. */
function freshDisk(): ProjectDisk {
  const d = new ProjectDisk();
  d.mount(join(GOLDEN, "appdata", golden.dataFolder), DATA_ROOT);
  d.put(golden.linkedOutsideProject, "linked footage, not media");
  disk.current = d;
  return d;
}
const ORIGINAL = (() => {
  const d = freshDisk();
  return Object.fromEntries(DOCS.map((doc) => [doc, d.bytes(FILES[doc])!])) as Record<
    Doc,
    Uint8Array
  >;
})();
const textOf = (b: Uint8Array) => new TextDecoder("utf-8").decode(b);
const enc = (s: string) => new TextEncoder().encode(s);
const BOM = new Uint8Array([0xef, 0xbb, 0xbf]);
const concat = (a: Uint8Array, b: Uint8Array) => {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
};
const same = (a: Uint8Array | undefined, b: Uint8Array) =>
  !!a && a.length === b.length && a.every((x, i) => x === b[i]);

/** What the app makes of these bytes: a JSON object, or null when it cannot read one. */
function readable(bytes: Uint8Array): Record<string, unknown> | null {
  try {
    const v = JSON.parse(textOf(bytes)) as unknown;
    return v !== null && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
/** True when the bytes are JSON of any shape. */
function parses(bytes: Uint8Array): boolean {
  try {
    JSON.parse(textOf(bytes));
    return true;
  } catch {
    return false;
  }
}

interface Opened {
  listed: string[];
  refreshError: string | null;
  openError: string | null;
  editor: "loaded" | "failed" | "superseded" | "not run";
  catalogCheckFailed: boolean;
  timeline: Timeline | null;
  notice: string | null;
}

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

/** Open a project the way the window does: the list refreshes, the projects store opens it (Shell
 *  shows a rejection and stops), the editor loads it, then every opened project gets its catalog
 *  checked for finished generations (a failure there is shown as a notice). */
async function openLikeTheApp(id: string): Promise<Opened> {
  await useProjects.getState().refresh();
  const listed = useProjects.getState().projects.map((p) => p.id);
  const refreshError = useProjects.getState().error;
  const base = { listed, refreshError, catalogCheckFailed: false, timeline: null };
  try {
    await useProjects.getState().open(id);
  } catch (e) {
    const openError = e instanceof Error ? e.message : String(e);
    return { ...base, openError, editor: "not run", notice: useProjectNotice.getState().message };
  }
  const editor = await useEditor.getState().load(id);
  let catalogCheckFailed = false;
  const store = useEditor.getState().store;
  if (editor === "loaded" && store) {
    try {
      await reconcilePendingMedia(store);
    } catch {
      catalogCheckFailed = true; // documentRegistry shows "Could not update generated media..."
    }
  }
  await settle();
  return {
    ...base,
    openError: null,
    editor,
    catalogCheckFailed,
    timeline: useEditor.getState().timeline,
    notice: useProjectNotice.getState().message,
  };
}

/** The person learns something is wrong: a refused open (with its message), a failed load (Shell:
 *  "Couldn't open this project"), a notice, or an error on the project list. */
const told = (o: Opened) =>
  o.openError !== null ||
  o.editor === "failed" ||
  o.catalogCheckFailed ||
  o.notice !== null ||
  o.refreshError !== null;

/** The bytes the person had at `path` still exist: in place, or set aside as `<path>.corrupt-<time>`. */
function kept(d: ProjectDisk, path: string, bytes: Uint8Array): boolean {
  if (same(d.bytes(path), bytes)) return true;
  const prefix = `${ProjectDisk.key(path)}.corrupt-`;
  return [...d.files].some(([k, v]) => k.startsWith(prefix) && same(v, bytes));
}

function reset(): void {
  useEditor.getState().dispose();
  stopHeartbeat();
  useProjects.setState({ projects: [], activeId: null, active: null, loading: false, error: null });
  useProjectNotice.getState().clear();
  backgroundErrors.length = 0;
}

/** Errors thrown by the media indexing an open starts in the background (the editor fires it and
 *  forgets it, so in the app such an error reaches nobody). Recorded here instead of escaping. */
const backgroundErrors: unknown[] = [];

beforeEach(() => {
  setProjectStoreFactory((dir) => new ProjectStoreAccess(dir, disk.current as ProjectDisk));
  setRunnerFactory(() => ({
    run: async () => ({ code: 1, stdout: "", stderr: "no media tools in this test" }),
  }));
  const sweep = IndexCoordinator.prototype.sweep;
  vi.spyOn(IndexCoordinator.prototype, "sweep").mockImplementation(function (
    this: IndexCoordinator,
    ...args: Parameters<IndexCoordinator["sweep"]>
  ) {
    return Promise.resolve(sweep.apply(this, args)).catch((e: unknown) => {
      backgroundErrors.push(e);
    });
  });
  reset();
});
afterEach(reset);

// ── damage ─────────────────────────────────────────────────────────────────────────────────────

type JsonPath = Array<string | number>;
function pathsOf(v: unknown, at: JsonPath = [], out: JsonPath[] = []): JsonPath[] {
  if (Array.isArray(v))
    v.forEach((x, i) => {
      out.push([...at, i]);
      pathsOf(x, [...at, i], out);
    });
  else if (v !== null && typeof v === "object")
    for (const [k, x] of Object.entries(v)) {
      out.push([...at, k]);
      pathsOf(x, [...at, k], out);
    }
  return out;
}
const valueAt = (root: unknown, p: JsonPath) =>
  p.reduce<unknown>((o, k) => (o as Record<string | number, unknown>)[k], root);
function edited(
  root: unknown,
  p: JsonPath,
  edit: (parent: Record<string | number, unknown>, k: string | number) => void,
) {
  const copy = structuredClone(root);
  edit(valueAt(copy, p.slice(0, -1)) as Record<string | number, unknown>, p[p.length - 1]);
  return copy;
}
const kindOf = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
/** JSON text with a number no double can hold, written the way another program could write it. */
const HUGE = "__huge__";
const withHuge = (v: unknown) => JSON.stringify(v, null, 2).replace(`"${HUGE}"`, "1e400");

interface Damage {
  kind: string;
  bytes: Uint8Array;
}
/** A counterexample names itself by what was done to the file, not by its bytes. */
const named = <T extends object>(v: T, label: string): T =>
  Object.assign(v, { [fc.toStringMethod]: () => label });

/** Every way a file is found broken on a person's disk: cut short (a crash mid-write, a full disk,
 *  a sync conflict), not JSON at all, a byte-order mark, a field of the wrong type or missing, a
 *  number out of range, a version from another build, or not an object at all. */
function damaged(doc: Doc): fc.Arbitrary<Damage> {
  return damages(doc).map((d) => named(d, `${doc}: ${d.kind}`));
}
function damages(doc: Doc): fc.Arbitrary<Damage> {
  const bytes = ORIGINAL[doc];
  const json = JSON.parse(textOf(bytes)) as unknown;
  const paths = pathsOf(json);
  const numeric = paths.filter((p) => typeof valueAt(json, p) === "number");
  const versionKey = doc === "project.json" ? "schemaVersion" : "version";
  return fc.oneof(
    fc
      .integer({ min: 0, max: bytes.length - 1 })
      .map((k) => ({ kind: `cut at ${k}`, bytes: bytes.slice(0, k) })),
    fc
      .integer({ min: 0, max: bytes.length - 1 })
      .map((k) => ({ kind: `BOM, then cut at ${k}`, bytes: concat(BOM, bytes.slice(0, k)) })),
    fc
      .uint8Array({ minLength: 1, maxLength: 64 })
      .map((b) => ({ kind: `random bytes [${b.join(",")}]`, bytes: b })),
    fc
      .string({ minLength: 1, maxLength: 40 })
      .filter((s) => readable(enc(s)) === null)
      .map((s) => ({ kind: `not JSON: ${JSON.stringify(s)}`, bytes: enc(s) })),
    fc
      .constantFrom("null", "[]", '"timeline"', "42", "true", "{}")
      .map((s) => ({ kind: `the whole file is ${s}`, bytes: enc(s) })),
    fc
      .tuple(
        fc.constantFrom(...paths),
        fc.constantFrom<unknown>("x", 7, -1, true, null, [], {}, [1, 2], { a: 1 }),
      )
      .filter(([p, v]) => kindOf(valueAt(json, p)) !== kindOf(v))
      .map(([p, v]) => ({
        kind: `${p.join(".")} is ${JSON.stringify(v)}`,
        bytes: enc(
          JSON.stringify(
            edited(json, p, (o, k) => (o[k] = v)),
            null,
            2,
          ),
        ),
      })),
    fc.constantFrom(...paths).map((p) => ({
      kind: `${p.join(".")} is missing`,
      bytes: enc(
        JSON.stringify(
          edited(json, p, (o, k) => (Array.isArray(o) ? o.splice(Number(k), 1) : delete o[k])),
          null,
          2,
        ),
      ),
    })),
    ...(numeric.length
      ? [
          fc
            .tuple(
              fc.constantFrom(...numeric),
              fc.constantFrom<unknown>(1e308, -1e308, 2 ** 53 + 2, 1e21, -1, 0, HUGE),
            )
            .map(([p, v]) => ({
              kind: `${p.join(".")} is ${v === HUGE ? "1e400" : String(v)}`,
              bytes: enc(withHuge(edited(json, p, (o, k) => (o[k] = v)))),
            })),
        ]
      : []),
    fc.constantFrom<unknown>(2, 999, 1.5, HUGE, 0, -1, "2", null).map((v) => ({
      kind: `${versionKey} is ${v === HUGE ? "1e400" : JSON.stringify(v)}`,
      bytes: enc(withHuge({ ...(json as object), [versionKey]: v })),
    })),
  );
}

/** A rewrite that loses nothing the person had: seeding starter tracks onto a timeline with no tracks,
 *  or stamping an older project.json with the current schema version. */
function rewriteKeepsEverything(
  doc: Doc,
  before: Uint8Array,
  after: Uint8Array | undefined,
): boolean {
  const old = readable(before);
  const now = after ? readable(after) : null;
  if (!old || !now) return false;
  if (doc === "timeline.json")
    return Array.isArray(old.tracks) && old.tracks.length === 0 && Array.isArray(now.tracks);
  if (doc === "project.json")
    return JSON.stringify({ ...old, schemaVersion: 1 }) === JSON.stringify(now);
  return false;
}

/** The registry is rewritten by every open (the time it was last opened), so what must survive a
 *  damaged one it could still read is its projects: each entry that still named a valid project. */
function registryEntries(bytes: Uint8Array | undefined): string[] {
  const reg = bytes ? readable(bytes) : null;
  const list = reg && Array.isArray(reg.projects) ? (reg.projects as unknown[]) : [];
  return list
    .map((e) => (e !== null && typeof e === "object" ? (e as { id?: unknown }).id : undefined))
    .filter((id): id is string => typeof id === "string" && /^[a-z0-9_]{1,64}$/.test(id));
}

describe("a damaged project file", () => {
  describe.each(DOCS)("%s", (doc) => {
    it("whatever the damage, the open completes and every byte the person had is still on disk (property)", async () => {
      await fc.assert(
        fc.asyncProperty(damaged(doc), async (dmg) => {
          reset();
          const d = freshDisk();
          d.put(FILES[doc], dmg.bytes);
          const before = d.snapshot(DIR);
          const o = await openLikeTheApp(MAIN.id);
          // It finished, one way or the other, and a refusal says something.
          expect(["loaded", "failed", "not run"]).toContain(o.editor);
          if (o.openError !== null) expect(o.openError.trim().length).toBeGreaterThan(0);
          // Nothing the person had is gone: each file is where it was or set aside whole.
          for (const [path, bytes] of before) {
            const ok =
              kept(d, path, bytes) ||
              (path === ProjectDisk.key(FILES[doc]) &&
                rewriteKeepsEverything(doc, bytes, d.bytes(path)));
            expect(ok, `${path} after "${dmg.kind}"`).toBe(true);
          }
          if (doc === "projects.json") {
            // A registry that is not JSON any more is kept whole; one that still reads may be
            // rewritten (every open stamps it), but not lose a project it still named.
            const path = FILES["projects.json"];
            if (!parses(dmg.bytes))
              expect(kept(d, path, dmg.bytes), `projects.json after "${dmg.kind}"`).toBe(true);
            else
              expect(registryEntries(d.bytes(path)), `projects.json after "${dmg.kind}"`).toEqual(
                expect.arrayContaining(registryEntries(dmg.bytes)),
              );
          }
        }),
        { numRuns: 40 },
      );
    }, 120_000);
  });

  it("a timeline.json the app cannot read refuses the open with a message, and is left exactly as it was (property)", async () => {
    await fc.assert(
      fc.asyncProperty(
        damaged("timeline.json").filter((dmg) => readable(dmg.bytes) === null),
        async (dmg) => {
          reset();
          const d = freshDisk();
          d.put(FILES["timeline.json"], dmg.bytes);
          const o = await openLikeTheApp(MAIN.id);
          expect(o.editor).toBe("failed");
          expect(useEditor.getState().error).toBeTruthy();
          expect(told(o)).toBe(true);
          expect(same(d.bytes(FILES["timeline.json"]), dmg.bytes)).toBe(true);
          expect([...d.files.keys()].filter((k) => k.includes(".corrupt-"))).toEqual([]);
        },
      ),
      { numRuns: 40 },
    );
  }, 120_000);

  it.each([2, 3, 999, 1.5])(
    "a project.json from a newer build (schemaVersion %s) is refused with 'update the app' and not touched",
    async (v) => {
      const d = freshDisk();
      const bytes = enc(
        JSON.stringify({ ...readable(ORIGINAL["project.json"]), schemaVersion: v }, null, 2),
      );
      d.put(FILES["project.json"], bytes);
      const o = await openLikeTheApp(MAIN.id);
      expect(o.openError).toMatch(/newer version/);
      expect(o.openError).toMatch(/Update ArtDaddy/);
      expect(same(d.bytes(FILES["project.json"]), bytes)).toBe(true);
    },
  );

  // The documents below are set aside (or ignored) on a failed read and the project opens with that
  // document empty. The bytes survive; nothing tells the person.
  const cut = (doc: Doc) => ORIGINAL[doc].slice(0, Math.floor(ORIGINAL[doc].length / 2));

  describe("project.json cut short", () => {
    it("is set aside whole as project.json.corrupt-<time>, and the project opens", async () => {
      const d = freshDisk();
      d.put(FILES["project.json"], cut("project.json"));
      const o = await openLikeTheApp(MAIN.id);
      expect(o.editor).toBe("loaded");
      expect(o.timeline).toEqual(MAIN.readBack.timeline); // the edit itself is safe
      expect(d.bytes(FILES["project.json"])).toBeUndefined();
      expect(kept(d, FILES["project.json"], cut("project.json"))).toBe(true);
      // ...and it opened with nothing of what project.json held: not its name, not its settings.
      expect(useProjects.getState().active?.name).toBe(MAIN.id);
      expect(useProjects.getState().active?.settings).toEqual({});
    });

    it.fails(
      "BUG: the person is told their project settings could not be read (today: set aside with no notice)",
      async () => {
        const d = freshDisk();
        d.put(FILES["project.json"], cut("project.json"));
        expect(told(await openLikeTheApp(MAIN.id))).toBe(true);
      },
    );
  });

  describe("library.json cut short", () => {
    it("is set aside whole when the opened project's catalog is checked, and the project opens with an empty library", async () => {
      const d = freshDisk();
      d.put(FILES["library.json"], cut("library.json"));
      const o = await openLikeTheApp(MAIN.id);
      expect(o.editor).toBe("loaded");
      expect(o.timeline).toEqual(MAIN.readBack.timeline);
      expect(await useEditor.getState().store!.listClips()).toEqual([]);
      expect(d.bytes(FILES["library.json"])).toBeUndefined();
      expect(kept(d, FILES["library.json"], cut("library.json"))).toBe(true);
    });

    it.fails(
      "BUG: the person is told their media library could not be read (today: set aside with no notice, the library shows empty)",
      async () => {
        const d = freshDisk();
        d.put(FILES["library.json"], cut("library.json"));
        expect(told(await openLikeTheApp(MAIN.id))).toBe(true);
      },
    );
  });

  describe("a library.json row that is not an object", () => {
    const withNullRow = () => {
      const cat = readable(ORIGINAL["library.json"])! as { clips: unknown[] };
      return enc(JSON.stringify({ ...cat, clips: [null, ...cat.clips] }, null, 2));
    };

    it("the project still opens, with its timeline, and the file is left as it was", async () => {
      const d = freshDisk();
      d.put(FILES["library.json"], withNullRow());
      const o = await openLikeTheApp(MAIN.id);
      expect(o.editor).toBe("loaded");
      expect(o.timeline).toEqual(MAIN.readBack.timeline);
      expect(same(d.bytes(FILES["library.json"]), withNullRow())).toBe(true);
    });

    it.fails(
      "BUG: it does not stop the media indexing the open starts (today: a TypeError in IndexCoordinator.sweep, so the project's media gets no poster, preview copy or transcript from it)",
      async () => {
        const d = freshDisk();
        d.put(FILES["library.json"], withNullRow());
        await openLikeTheApp(MAIN.id);
        expect(backgroundErrors.map((e) => String(e))).toEqual([]);
      },
    );
  });

  describe("projects.json cut short", () => {
    it("is set aside whole, and the project list starts empty although both projects are still on disk", async () => {
      const d = freshDisk();
      d.put(FILES["projects.json"], cut("projects.json"));
      await useProjects.getState().refresh();
      expect(useProjects.getState().projects).toEqual([]);
      expect(kept(d, FILES["projects.json"], cut("projects.json"))).toBe(true);
      expect(
        d.bytes(joinPath(DATA_ROOT, "projects", OTHER.id, INTERNAL_DIR, "timeline.json")),
      ).toBeDefined();
    });

    it.fails(
      "BUG: the person is told, or still sees their projects (today: the list is silently empty and nothing in the app finds them again)",
      async () => {
        const d = freshDisk();
        d.put(FILES["projects.json"], cut("projects.json"));
        await useProjects.getState().refresh();
        const s = useProjects.getState();
        expect(s.error !== null || s.projects.length === 2).toBe(true);
      },
    );
  });
});

// ── the other direction: nothing legitimate is dropped ────────────────────────────────────────────

/** Keys a newer build might add: anything, as long as it is not a field this build already knows. */
const futureKey = fc.string({ minLength: 1, maxLength: 12 }).map((s) => `future_${s}`);
const anyJson = fc.jsonValue({ maxDepth: 3 }).map((v) => JSON.parse(JSON.stringify(v)) as unknown);
const oddText = fc.oneof(
  fc.string({ unit: "binary", maxLength: 60 }),
  fc.constantFrom(
    "",
    "\u2028\u2029",
    "e\u0301",
    "\u202Eright to left",
    "🎬🎞️",
    "\t\n\r",
    '\\"quoted"',
    "x".repeat(5000),
  ),
);
/** The same object written the ways other programs write JSON. A counterexample names what was
 *  unusual about the document and how it was written, not the whole document. */
const written = <T>(value: T, what: string) =>
  fc
    .record({
      indent: fc.constantFrom<string | number>(0, 1, 2, 4, "\t"),
      crlf: fc.boolean(),
      bom: fc.boolean(),
      tail: fc.constantFrom("", "\n", "\r\n", "  \n"),
    })
    .map(({ indent, crlf, bom, tail }) => {
      let text = JSON.stringify(value, null, indent) + tail;
      if (crlf) text = text.replace(/\r?\n/g, "\r\n");
      const how = JSON.stringify({ indent, crlf, bom, tail });
      return named(
        { value, bytes: bom ? concat(BOM, enc(text)) : enc(text) },
        `${what}; written ${how}`,
      );
    });
const summary = (params: object) => JSON.stringify(params).slice(0, 400);

describe("a valid project file with unusual content opens exactly as written", () => {
  it("timeline.json: any text, fields from a newer build, extreme but allowed numbers, any formatting (property)", async () => {
    const base = MAIN.readBack.timeline;
    const unusual = fc
      .record({
        title: oddText,
        rootExtra: fc.dictionary(futureKey, anyJson, { maxKeys: 3 }),
        trackExtra: fc.dictionary(futureKey, anyJson, { maxKeys: 3 }),
        clipExtra: fc.dictionary(futureKey, anyJson, { maxKeys: 3 }),
        canvas: fc.constantFrom(
          { width: 1920, height: 1080, fps: 30 },
          { width: 8192, height: 8192, fps: 120 },
          { width: 64, height: 64, fps: 1 },
        ),
        shift: fc.constantFrom(0, 10_000_000),
      })
      .chain((params) => {
        const { title, rootExtra, trackExtra, clipExtra, canvas, shift } = params;
        const tl = structuredClone(base) as Timeline & Record<string, unknown>;
        Object.assign(tl, rootExtra, { canvas });
        for (const t of tl.tracks)
          for (const c of t.clips ?? []) {
            c.timeline_in += shift;
            c.timeline_out += shift;
            if (c.kind === "text") c.content = [{ text: title }];
          }
        Object.assign(tl.tracks[0], trackExtra);
        Object.assign(tl.tracks[0].clips![0], clipExtra);
        return written(tl, summary(params));
      });
    await fc.assert(
      fc.asyncProperty(unusual, async ({ value: tl, bytes }) => {
        reset();
        const d = freshDisk();
        d.put(FILES["timeline.json"], bytes);
        const o = await openLikeTheApp(MAIN.id);
        expect(o.editor).toBe("loaded");
        expect(o.timeline).toEqual(tl);
        expect(same(d.bytes(FILES["timeline.json"]), bytes)).toBe(true);
      }),
      { numRuns: 30 },
    );
  }, 120_000);

  it("project.json: any name, settings a newer build added, any formatting (property)", async () => {
    const base = readable(ORIGINAL["project.json"])!;
    const unusual = fc
      .record({
        name: oddText.filter((s) => s.length > 0),
        model: oddText,
        extra: fc.dictionary(futureKey, anyJson, { maxKeys: 3 }),
        settingsExtra: fc.dictionary(futureKey, anyJson, { maxKeys: 3 }),
      })
      .chain((params) => {
        const { name, model, extra, settingsExtra } = params;
        const pj = {
          ...base,
          ...extra,
          name,
          settings: { ...(base.settings as object), ...settingsExtra, model_id: model },
        };
        return written(pj, summary(params));
      });
    await fc.assert(
      fc.asyncProperty(unusual, async ({ value: pj, bytes }) => {
        reset();
        const d = freshDisk();
        d.put(FILES["project.json"], bytes);
        const o = await openLikeTheApp(MAIN.id);
        expect(o.editor).toBe("loaded");
        const active = useProjects.getState().active!;
        expect(active.name).toBe(pj.name);
        expect(active.settings).toEqual(pj.settings);
        expect(same(d.bytes(FILES["project.json"]), bytes)).toBe(true);
      }),
      { numRuns: 30 },
    );
  }, 120_000);

  it("library.json: any file names, fields a newer build added, any formatting (property)", async () => {
    const base = readable(ORIGINAL["library.json"])! as { clips: LibraryClip[] };
    const unusual = fc
      .record({
        names: fc.array(oddText, { minLength: base.clips.length, maxLength: base.clips.length }),
        extra: fc.dictionary(futureKey, anyJson, { maxKeys: 3 }),
        rowExtra: fc.dictionary(futureKey, anyJson, { maxKeys: 3 }),
      })
      .chain((params) => {
        const { names, extra, rowExtra } = params;
        const cat = {
          ...base,
          ...extra,
          clips: base.clips.map((c, i) => ({
            ...c,
            ...(i === 0 ? rowExtra : {}),
            filename: names[i],
          })),
        };
        return written(cat, summary(params));
      });
    await fc.assert(
      fc.asyncProperty(unusual, async ({ value: cat, bytes }) => {
        reset();
        const d = freshDisk();
        d.put(FILES["library.json"], bytes);
        const o = await openLikeTheApp(MAIN.id);
        expect(o.editor).toBe("loaded");
        expect(await useEditor.getState().store!.listClips()).toEqual(cat.clips);
        expect(same(d.bytes(FILES["library.json"]), bytes)).toBe(true);
      }),
      { numRuns: 30 },
    );
  }, 120_000);
});
