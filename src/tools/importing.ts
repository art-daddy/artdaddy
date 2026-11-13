// The ONE reader of "what is the person still importing": every way the agent looks at the project asks here (the message note, library_op list, get_project_state, the state
// block, a name that is not in the library yet), so the answer cannot differ between them and the `import_note` flag has one place to switch them all off.
//
// UJ-088: a message sent while files were still coming in was told the library was empty. The registry (store/importJobs.ts) knows the whole batch from the first instant; this
// is how the agent learns it. Flag off (the server can only switch it OFF) = 0.27.0: nothing is reported, a name that is not there yet is "not found".
import { exportFlag } from "../api/exportFlags";
import { importingRows, type ImportingRow } from "../store/importJobs";

export type { ImportingRow };

/** The files this project's person is importing right now (empty when nothing is, or the flag is off). `store` is whatever holds the project's directory. */
export function importingFor(
  store: { projectDir: string } | null | undefined,
  now: number = Date.now(),
): ImportingRow[] {
  if (!store || !exportFlag("import_note")) return [];
  return importingRows(store.projectDir, now);
}

/** Two readings of the same registry as one list: every file either saw, once, with the later reading's percent. */
export function mergeImporting(
  before: readonly ImportingRow[],
  after: readonly ImportingRow[],
): ImportingRow[] {
  const byPath = new Map<string, ImportingRow>();
  for (const r of before) byPath.set(r.path, r);
  for (const r of after) byPath.set(r.path, r);
  return [...byPath.values()];
}

/** Read the library through `read`, and say what was importing around it. The registry is read on BOTH sides of the library read and the two are
 *  joined: a file that lands in between is in the library and in the list (told twice, harmless); one that starts in between is in the list. Reading
 *  the registry once, either side, leaves a window in which a file is in neither, which is the "library is empty" answer this exists to prevent. */
export async function readWithImporting<T>(
  store: { projectDir: string } | null | undefined,
  read: () => Promise<T>,
): Promise<{ value: T; importing: ImportingRow[] }> {
  const before = importingFor(store);
  const value = await read();
  return { value, importing: mergeImporting(before, importingFor(store)) };
}

/** The most files a tool result lists by name; the rest are counted. A drop of hundreds of photos must not push the project block over its size bound
 *  (it would fall back to its summary and lose timeline detail) or fill the model's context with names. */
export const MAX_LISTED_IMPORTING = 20;

/** The shape every reader puts in its result, or nothing at all when nothing is importing (a result is byte-identical to what it always was then). */
export function importingField(
  rows: readonly ImportingRow[],
):
  | { importing: Array<{ name: string; percent?: number }>; importing_count?: number }
  | Record<string, never> {
  if (rows.length === 0) return {};
  return {
    importing: rows.slice(0, MAX_LISTED_IMPORTING).map((r) => ({
      name: r.name,
      ...(r.fraction !== null ? { percent: Math.round(r.fraction * 100) } : {}),
    })),
    ...(rows.length > MAX_LISTED_IMPORTING ? { importing_count: rows.length } : {}),
  };
}

/** The importing file a name or a path refers to (the agent has no id for a file that is not in yet, so it can only say what it was told or saw). */
export function importingMatch(
  store: { projectDir: string } | null | undefined,
  ref: string,
  now: number = Date.now(),
): ImportingRow | null {
  const wanted = ref.trim().replace(/\\/g, "/").toLowerCase();
  if (!wanted) return null;
  return (
    importingFor(store, now).find(
      (r) => r.name.toLowerCase() === wanted || r.path.toLowerCase() === wanted,
    ) ?? null
  );
}
