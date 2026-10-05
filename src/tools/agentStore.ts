// What an AGENT tool call may read: media the project already knows.
//
// Every tool the agent runs (in-app, or an external AI over MCP) gets its context from
// agentToolContext, so no tool can hand an agent-typed path to the trusted resolver by mistake.
// An absolute path resolves only when the project already holds it — inside the project folder, a
// library row (linked media keeps its absolute path there) or a clip on the timeline (legacy
// projects stored absolute refs). Every timeline and library writer refuses agent-typed paths, so
// neither can be used to launder one in. import_media source.path is the one way a new local file
// comes in, and it catalogues what it links.
import type { MutationOrigin } from "../project/MutationGate";
import { loadTimeline } from "../timeline/engine";
import type { ClientToolContext } from "./context";
import { clipAbs, isAbsolutePath, type ProjectStoreAccess } from "./store";

const slashes = (p: string): string => p.replace(/\\/g, "/");

/** Windows paths (drive or UNC) compare case-insensitively, as the OS does. */
function pathKey(p: string): string {
  const s = slashes(p).replace(/\/+$/, "");
  return /^([a-z]:\/|\/\/)/i.test(s) ? s.toLowerCase() : s;
}

const escapes = (p: string): boolean => slashes(p).split("/").includes("..");

/** Does the project already hold `abs`: inside its folder, in the library, or on the timeline? */
export async function projectKnowsPath(store: ProjectStoreAccess, abs: string): Promise<boolean> {
  if (escapes(abs)) return false;
  const k = pathKey(abs);
  if (k.startsWith(`${pathKey(store.projectDir)}/`)) return true;
  const clips = await store.listClips();
  if (clips.some((c) => typeof c.path === "string" && pathKey(clipAbs(store.projectDir, c)) === k))
    return true;
  try {
    const tl = await loadTimeline(store);
    return (tl.tracks ?? []).some((t) =>
      (t.clips ?? []).some((c) => typeof c.media_ref === "string" && pathKey(c.media_ref) === k),
    );
  } catch {
    return false;
  }
}

/** The same store, with resolveRef limited to what the project knows. A Proxy over the one
 *  instance, so session state and every other method stay exactly the store's own. */
export function agentStoreView(store: ProjectStoreAccess): ProjectStoreAccess {
  const resolveRef = async (ref: string): Promise<string | null> => {
    const s = (ref ?? "").trim();
    if (!s || escapes(s)) return null;
    if (isAbsolutePath(s) && !(await projectKnowsPath(store, s))) return null;
    return store.resolveRef(s);
  };
  return new Proxy(store, {
    get(target, prop) {
      if (prop === "resolveRef") return resolveRef;
      const v: unknown = Reflect.get(target, prop, target);
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}

/** The context every agent-originated tool call runs with: the store limited to what the project
 *  knows, and the turn's Stop threaded into the runner when there is one. */
export function agentToolContext(
  base: ClientToolContext,
  signal?: AbortSignal,
  origin?: MutationOrigin,
): ClientToolContext {
  const store = agentStoreView(base.store);
  if (!signal) return { ...base, store };
  return {
    ...base,
    store,
    signal,
    origin,
    // Forward EVERY argument but the signal, which this wrapper exists to inject. Dropping the
    // trailing ones silently disabled the export progress stream: the render worked, the bar
    // never moved, and nothing failed.
    runner: { run: (p, a, _s, cwd, onStdout) => base.runner.run(p, a, signal, cwd, onStdout) },
    detach: () => ({ ...base, store }),
  };
}
