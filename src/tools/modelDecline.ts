// A person who pressed Cancel on the speech model's download is not asked again behind his back: the launch
// prefetch skips it, also after the app is closed and opened. The record is `{ at, version }`, kept on this PC.
//
// It ends in four ways: the person presses Retry; anything that needs the model asks for it (a look, a caption
// request, a background job: that is the person wanting speech again); the app is updated (`version` is another
// release's); or it is cleared. Nothing is shown for it, so there is nothing to nag about.
const KEY = "artdaddy.speech_model_declined.v1";

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function browserStorage(): Store | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** The release this app was built as, so that an update is told from a restart. */
function release(): string {
  return typeof __ARTDADDY_RELEASE__ === "string" ? __ARTDADDY_RELEASE__ : "";
}

/** Also held in memory, so that a storage that cannot be written (or read) still keeps this session's Cancel. */
let inMemory = false;

/** The person said no to the download. */
export function declineModel(
  now: number = Date.now(),
  storage: Store | null = browserStorage(),
  version: string = release(),
): void {
  inMemory = true;
  try {
    storage?.setItem(KEY, JSON.stringify({ at: now, version }));
  } catch {
    /* kept for this session only */
  }
}

/** Has the person said no, and not changed his mind since, on this release? */
export function modelDeclined(
  storage: Store | null = browserStorage(),
  version: string = release(),
): boolean {
  if (inMemory) return true;
  try {
    const raw = JSON.parse(storage?.getItem(KEY) ?? "null") as {
      at?: unknown;
      version?: unknown;
    } | null;
    return typeof raw?.at === "number" && Number.isFinite(raw.at) && raw.version === version;
  } catch {
    return false;
  }
}

/** The model is wanted again. */
export function clearModelDecline(storage: Store | null = browserStorage()): void {
  inMemory = false;
  try {
    storage?.removeItem(KEY);
  } catch {
    /* as above */
  }
}

/** Tests only: a start of the app that remembers nothing, in memory or in storage. */
export function __resetModelDecline(): void {
  clearModelDecline();
}
