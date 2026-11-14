// The speech model, fetched when the app starts rather than when somebody first needs it.
//
// A transcript asked for before the model was there waited for the whole download inside a tool call
// (one turn took 81 minutes), and 13 users' downloads failed with nobody watching. Started at launch,
// the download is usually done before the first clip is imported or the first question is asked.
// While it runs, the pill on screen says what it is, how far it is, and that it can be cancelled;
// a look that needs the model in the meantime joins this download and answers within its bound.
import { platform } from "../platform";
import { setModelDownloadFailure, setModelNextAttemptAt } from "../store/modelDownload";
import type { CommandRunner } from "./command";
import type { ClientToolContext } from "./context";
import {
  __resetModelDecline,
  clearModelDecline,
  declineModel,
  modelDeclined,
} from "./modelDecline";
import { ensureWhisperModel } from "./transcribe";

export interface PrefetchEnv {
  /** A context whose store lies under the app's data root, or null where there is no desktop. */
  context(): Promise<ClientToolContext | null>;
  ensure(ctx: ClientToolContext): Promise<unknown>;
  sleep(ms: number): Promise<void>;
}

/** After a round fails (offline at launch, the origin down) another follows after each of these
 *  waits. The download itself already retries with back-off; this is for a machine that was not
 *  online at all. Whatever needs the model first starts its own attempt and joins a running one. */
const ROUND_WAITS_MS: readonly number[] = [60_000, 300_000];

/** The person pressed Cancel: the download's own sentence for it (transcribe.ts). */
export const isCancelledDownload = (e: unknown): boolean =>
  e instanceof Error && /speech model download cancelled/.test(e.message);

let session: Promise<void> | null = null;
/** What the last start was given, so that a Retry asks the same way. */
let lastEnv: PrefetchEnv | null = null;
/** Ends the wait between two rounds now; set only while a round is waiting. */
let cutWait: (() => void) | null = null;

/** Start fetching the speech model if it is not on this machine. Never rejects, and costs nothing
 *  when the model is already there (its checksum was verified when it landed). A person who
 *  cancelled is not asked again, not even after the app is closed and opened (modelDecline.ts). */
export function startSpeechModelPrefetch(env: PrefetchEnv = productionEnv): Promise<void> {
  lastEnv = env;
  if (modelDeclined()) return Promise.resolve();
  session ??= run(env, ROUND_WAITS_MS).finally(() => {
    session = null;
  });
  return session;
}

/** The person pressed Retry on the failure card: a Cancel is forgotten, the card goes, and the model is
 *  asked for now. A round that is waiting for its turn starts at once; with none running, exactly one round
 *  is made, and when it fails the card returns. Never rejects. */
export function retrySpeechModelDownload(): Promise<void> {
  clearModelDecline();
  setModelDownloadFailure(null);
  if (session) {
    cutWait?.();
    return session;
  }
  session = run(lastEnv ?? productionEnv, []).finally(() => {
    session = null;
  });
  return session;
}

async function run(env: PrefetchEnv, waits: readonly number[]): Promise<void> {
  try {
    const ctx = await env.context();
    if (!ctx) return;
    for (let round = 0; ; round++) {
      try {
        await env.ensure(ctx);
        return;
      } catch (e) {
        if (isCancelledDownload(e)) {
          declineModel();
          return;
        }
        if (round >= waits.length) return;
        await waitForNextRound(env, waits[round]);
      }
    }
  } catch {
    /* the first look or import that needs the model asks for it again, resuming */
  }
}

/** The wait between two rounds, which the card says is under way and a Retry can end. */
async function waitForNextRound(env: PrefetchEnv, ms: number): Promise<void> {
  let cut!: () => void;
  const cutShort = new Promise<void>((resolve) => (cut = resolve));
  cutWait = cut;
  setModelNextAttemptAt(Date.now() + ms);
  try {
    await Promise.race([env.sleep(ms), cutShort]);
  } finally {
    if (cutWait === cut) cutWait = null;
    setModelNextAttemptAt(null);
  }
}

/** Tests only: an app that has just started, remembering nothing in memory or in storage. */
export function __resetPrefetch(): void {
  session = null;
  lastEnv = null;
  cutWait = null;
  __resetModelDecline();
}

/** Downloading needs no command: nothing here may start a process. */
const NO_COMMANDS: CommandRunner = {
  run: async () => ({ code: 1, stdout: "", stderr: "the model download runs no commands" }),
};

const productionEnv: PrefetchEnv = {
  async context() {
    if (platform.name !== "tauri") return null;
    const [{ TauriFs }, { ProjectStoreAccess, joinPath }, { projectsRoot }] = await Promise.all([
      import("./tauri"),
      import("./store"),
      import("./dataRoot"),
    ]);
    // The model lives under the data root, which a project directory two levels down names; no
    // project is created or opened.
    const dir = joinPath(await projectsRoot(), "_app");
    return { store: new ProjectStoreAccess(dir, new TauriFs()), runner: NO_COMMANDS };
  },
  ensure: (ctx) => ensureWhisperModel(ctx),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};
