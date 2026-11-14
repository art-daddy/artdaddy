// Whether this machine's GPU can run the speech engine, learned from what happened to it.
//
// whisper-cli crashed outright on the GPU of some machines (exit 0xC0000409, just after it began
// to load the model; AMD, Intel and NVIDIA alike), and every transcription there failed the same
// way, three times per file in the background indexer: 226 retries from three users, and 64 failed
// looks. A crash like that is retried once with the GPU off. When that works the machine is
// remembered as CPU-only for a while, so nothing after it has to crash first; when it crashes too,
// the GPU was not the cause and nothing is remembered.
import { exportFlag } from "../api/exportFlags";

/** Windows kills a process that cannot resolve its imports BEFORE a line of its code runs, so
 *  there is no stderr to read and no exit status from whisper itself — only an NTSTATUS. One
 *  user's machine lacked the Visual C++ runtime whisper-cli imports and produced 56 of these in
 *  a single session: identical, empty, and indistinguishable from a broken media file. These say
 *  the engine cannot start AT ALL: turning the GPU off does not help, so they are not crashes of
 *  the GPU path. */
export const WINDOWS_LOAD_FAILURES: ReadonlySet<number> = new Set([
  -1073741515, // 0xC0000135 STATUS_DLL_NOT_FOUND
  -1073741511, // 0xC0000139 STATUS_ENTRYPOINT_NOT_FOUND
  -1073741701, // 0xC000007B STATUS_INVALID_IMAGE_FORMAT
]);

/** A Windows NTSTATUS error, 0xC0000000 to 0xC0FFFFFF, as the signed number a process reports. */
const NTSTATUS_ERROR_FIRST = -1_073_741_824;
const NTSTATUS_ERROR_LAST = -1_056_964_609;

/** The process died, rather than the program finishing badly: a Windows error status, or no exit
 *  code at all (the process was ended by a signal), or what a shell reports for one (128 + n). */
export function isCrash(code: number | null): boolean {
  if (code === null) return true;
  return (
    (code >= NTSTATUS_ERROR_FIRST && code <= NTSTATUS_ERROR_LAST) || (code >= 129 && code <= 159)
  );
}

/** A GPU backend in the engine's own log: ggml prints its Vulkan, Metal, CUDA, HIP or OpenCL
 *  devices before it uses any. */
const GPU_BACKEND_LOG =
  /ggml_(vulkan|metal|cuda|hip|opencl|sycl|cann)|whisper_backend_init_gpu: using/i;

/** Did a run that had the GPU on die in the GPU's code? It crashed, it was not a failure to start
 *  at all, and the engine had named a GPU before it did. */
export function isGpuCrash(run: { code: number | null; stderr: string }): boolean {
  if (!isCrash(run.code)) return false;
  if (run.code !== null && WINDOWS_LOAD_FAILURES.has(run.code)) return false;
  return GPU_BACKEND_LOG.test(run.stderr);
}

const KEY = "artdaddy.speech_cpu_only";
/** What a hold writes as its `until`: a week. The app that is downgraded to reads only this, and
 *  `speech_gpu_retry` off reads only this, so it is still written even though a hold now ends sooner. */
export const CPU_ONLY_HOLD_MS = 7 * 24 * 60 * 60 * 1000;
/** How long a crashed GPU stays off: six hours, or until the app is another version, whichever is
 *  first (owner decision 14 Nov 2026). A driver update and a passing hang are both over by then, and
 *  a retry that crashes again costs one fast failed start and the CPU rerun that is built in. */
export const GPU_RETRY_AFTER_MS = 6 * 60 * 60 * 1000;
/** Where the hold is kept; exported so a test can put something unreadable there. */
export const SPEECH_CPU_ONLY_KEY = KEY;

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function browserStorage(): Store | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** The release this app was built as, which a hold records to know an update from a restart. */
function appVersion(): string {
  return typeof __ARTDADDY_RELEASE__ === "string" ? __ARTDADDY_RELEASE__ : "";
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Is the GPU off for the speech engine on this machine right now?
 *
 *  A hold is `{ since, code, version, until }`. With `speech_gpu_retry` on it lasts for
 *  {@link GPU_RETRY_AFTER_MS} from `since`, and ends at once when `version` is not this app's, so a
 *  GPU is tried again after an update or six hours, never sooner. A hold written by 0.27.0 has only
 *  `until`: its `since` is a week before that, and having no version it ends at the first run after
 *  the update. With the switch off the only end is the week in `until`, as it always was; flipping
 *  it needs no rewrite of the hold. */
export function cpuOnlyNow(
  now: number = Date.now(),
  storage: Store | null = browserStorage(),
  version: string = appVersion(),
): boolean {
  try {
    const raw = JSON.parse(storage?.getItem(KEY) ?? "null") as {
      until?: unknown;
      since?: unknown;
      version?: unknown;
    } | null;
    const until = raw?.until;
    if (!finite(until) || until <= now) return false;
    if (!exportFlag("speech_gpu_retry")) return true;
    if (raw?.version !== version) return false;
    const since = finite(raw.since) ? raw.since : until - CPU_ONLY_HOLD_MS;
    return now < since + GPU_RETRY_AFTER_MS;
  } catch {
    return false;
  }
}

/** Keep the GPU off, after a CPU run proved it was the GPU. */
export function holdCpuOnly(
  code: number | null,
  now: number = Date.now(),
  storage: Store | null = browserStorage(),
): void {
  try {
    storage?.setItem(
      KEY,
      JSON.stringify({ since: now, until: now + CPU_ONLY_HOLD_MS, code, version: appVersion() }),
    );
  } catch {
    /* nothing can be kept here: the next run tries the GPU again, and is retried the same way */
  }
}

/** Let the GPU be tried again. */
export function releaseCpuOnly(storage: Store | null = browserStorage()): void {
  try {
    storage?.removeItem(KEY);
  } catch {
    /* as above */
  }
}
