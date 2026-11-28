// The "look" surface for the eval harness: a timeline case that also gets what the app always
// offers beside its edit tools and that neither bills nor reaches the network. That is the free
// looks (inspect_media, inspect_timeline, inspect_color), the person's library (library_op's reads,
// get_project_state's inventory) and import_media.
//
// WHY: a careful editor looks at a shot before grading it, and finds a file in the library before
// placing it. The timeline surface offers neither, so on "make this clip pop" or "insert intro.mp4"
// the agent rightly declined to edit blind, and the run measured the rig instead of the agent. The
// app offers the whole catalog; this surface adds its free, local reads, answered by the same
// stand-ins a studio case gets (studio.ts), and leaves every paid tool unregistered.
import { kindOf } from "../media/formats";
import { clipKind } from "../timeline/helpers";
import type { Timeline } from "../timeline/model";
import type { ClientToolRegistry, ToolHandler } from "../tools/registry";
import { registerStudioStubs, type StudioState } from "./studio";
import { HARNESS_UNAVAILABLE, type Scenario } from "./types";

/** The studio stand-ins the look surface reuses as they are. */
const LOOKS: ReadonlySet<string> = new Set(["inspect_media", "inspect_timeline", "inspect_color"]);

/** Every tool the look surface registers beside the real timeline tools. */
export const LOOK_TOOLS: readonly string[] = [
  ...LOOKS,
  "library_op",
  "get_project_state",
  "import_media",
];

/** The library_op actions that only read; the others are not offered on this surface. */
const LIBRARY_READS: ReadonlySet<string> = new Set(["list", "get", "resolve"]);

/** One file in the person's library, as get_project_state lists it. */
export interface CaseLibraryItem {
  media_ref: string;
  filename: string;
  kind: "video" | "image" | "audio";
  folder: string | null;
}

const baseName = (s: string): string => s.replace(/\\/g, "/").split("/").pop() ?? s;

/** The person's library in a case: every file its seed places, then each file it says the person
 *  keeps there (Scenario.library), by the filename that is also its media_ref. A clip on the
 *  timeline came from the library, and a file the request names is one the person has: an empty
 *  library beside both told the agent the file was missing. */
export function caseLibrary(scenario: Pick<Scenario, "seed" | "library">): CaseLibraryItem[] {
  const items = new Map<string, CaseLibraryItem>();
  const add = (ref: string, kind: string | null) => {
    if (!ref || items.has(ref)) return;
    const k = kind === "image" || kind === "audio" ? kind : "video";
    items.set(ref, { media_ref: ref, filename: baseName(ref), kind: k, folder: null });
  };
  for (const track of scenario.seed().tracks ?? [])
    for (const clip of track.clips ?? [])
      if (clipKind(clip) !== "text" && typeof clip.media_ref === "string")
        add(clip.media_ref, clipKind(clip));
  for (const file of scenario.library ?? []) add(file, kindOf(file));
  return [...items.values()];
}

/** Register the look surface's stand-ins, after the real timeline tools. `project` is the project
 *  as the runner names it to the model; `timeline` reads the case's live timeline. */
export function registerLookStubs(
  registry: ClientToolRegistry,
  scenario: Pick<Scenario, "seed" | "library">,
  state: StudioState,
  project: { id: string; name: string },
  timeline: () => Promise<Timeline>,
  fps = 30,
): void {
  // The looks are the studio stand-ins themselves; of the rest, only the import is kept, to fall
  // back on for a file the library does not hold.
  let importAnything: ToolHandler | undefined;
  const pick = {
    register(name: string, handler: ToolHandler) {
      if (LOOKS.has(name)) registry.register(name, handler);
      else if (name === "import_media") importAnything = handler;
      return pick;
    },
    has: (name: string) => registry.has(name),
  };
  registerStudioStubs(pick as unknown as ClientToolRegistry, state, fps, timeline);

  const items = caseLibrary(scenario);
  const find = (ref: unknown): CaseLibraryItem | undefined => {
    const s = String(ref ?? "").trim();
    return items.find((i) => i.media_ref === s || (!!s && i.filename === baseName(s)));
  };
  const row = (i: CaseLibraryItem) => ({
    id: i.media_ref,
    filename: i.filename,
    path: `library/${i.filename}`,
    kind: i.kind,
    folder: i.folder ?? "",
  });

  registry.register("get_project_state", async () => {
    const tl = await timeline();
    return {
      ok: true,
      project_id: project.id,
      name: project.name,
      canvas: tl.canvas ?? null,
      library: items.map(({ media_ref, filename, kind, folder }) => ({
        media_ref,
        filename,
        kind,
        folder,
      })),
      library_count: items.length,
    };
  });

  registry.register("library_op", async (args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    const action = String(a.action ?? "").trim();
    if (!action) return { ok: false, error: "an 'action' is required" };
    // A write is not offered here, the way a tool the surface lacks is not: not a failure.
    if (!LIBRARY_READS.has(action)) return { ok: false, error: HARNESS_UNAVAILABLE };
    if (action === "list")
      return { ok: true, clips: String(a.folder ?? "").trim() ? [] : items.map(row) };
    if (action === "get") {
      const id = String(a.id ?? "").trim();
      const hit = items.find((i) => i.media_ref === id);
      return hit ? { ok: true, clip: row(hit) } : { ok: false, error: `unknown clip id ${id}` };
    }
    const ref = String(a.id ?? a.id_or_path ?? "").trim();
    if (!ref) return { ok: false, error: "resolve: an id or path is required" };
    const hit = find(ref);
    return hit
      ? { ok: true, path: `library/${hit.filename}` }
      : { ok: false, error: `resolve: unknown library id ${ref}` };
  });

  // The app's import de-duplicates: importing the file the library already holds returns that
  // entry, so "intro.mp4" imported is the intro.mp4 the person has. Anything else comes in as the
  // journey stand-in brings a file in.
  registry.register("import_media", async (args) => {
    const source = ((args ?? {}) as { source?: Record<string, unknown> }).source ?? {};
    const hit = find(source.path ?? source.url);
    if (hit)
      return {
        ok: true,
        media_ref: hit.media_ref,
        filename: hit.filename,
        kind: hit.kind,
        existed: true,
      };
    return importAnything ? importAnything(args) : { ok: false, error: HARNESS_UNAVAILABLE };
  });
}
