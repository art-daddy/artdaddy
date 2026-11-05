// The exporter's remote switches (Phase 3). Behaviours that could not be fully proven in the lab can each be switched
// off from the server without a release:
//   stall_stop  stop an export that has made no progress (off: it is only logged, as before)
//   plan_rung   start an export that would not fit with fewer threads (off: it starts as before)
//   pc_floor    stop an export when the PC itself runs short of memory (off: the job's own limits only)
//   chip_amd, chip_nvidia, chip_intel
//               that maker's graphics chip may be tested, offered and chosen (off: never; the processor encodes)
//   chip_default  Fast is chosen for the person when the export would take over a minute (off: still offered)
//   faster_x264 the processor's faster setting may be chosen for a slow export when no chip is usable (off: never)
//
// The client carries compiled defaults, and the server only ever tells it to switch something off (or back
// on). So every way this can fail lands on what the client already does: no session, no network, a slow or
// failing server, a damaged answer, a name or value it does not know. It never throws, never blocks an
// export (a refresh runs beside it) and is not the compatibility gate, which can stop the app from working.
import { apiBase } from "./config";
import { authedFetch, hasSession } from "./auth";

export const EXPORT_FLAG_NAMES = [
  "stall_stop",
  "plan_rung",
  "pc_floor",
  "chip_amd",
  "chip_nvidia",
  "chip_intel",
  "chip_default",
  "faster_x264",
] as const;
export type ExportFlagName = (typeof EXPORT_FLAG_NAMES)[number];

/** What runs before the server has said anything. The gate decided these from the lab and the soak: on,
 *  because every flag gives a way back. */
export const COMPILED_FLAG_DEFAULTS: Readonly<Record<ExportFlagName, boolean>> = {
  stall_stop: true,
  plan_rung: true,
  pc_floor: true,
  chip_amd: true,
  chip_nvidia: true,
  chip_intel: true,
  chip_default: true,
  faster_x264: true,
};

const STORAGE_KEY = "artdaddy.exportFlags.v1";
/** At most one question to the server in this long, unless asked to ask. */
const REFRESH_MS = 10 * 60_000;
const TIMEOUT_MS = 3_000;

function stored(): Record<ExportFlagName, boolean> {
  const flags = { ...COMPILED_FLAG_DEFAULTS };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === "object")
      for (const name of EXPORT_FLAG_NAMES) {
        const value = (parsed as Record<string, unknown>)[name];
        if (typeof value === "boolean") flags[name] = value;
      }
  } catch {
    /* a damaged copy is the defaults */
  }
  return flags;
}

let current: Record<ExportFlagName, boolean> = stored();
let askedAt = 0;
let inflight: Promise<void> | null = null;

/** Whether a behaviour is on right now. A name this client does not know is never on. */
export function exportFlag(name: ExportFlagName): boolean {
  return current[name] ?? false;
}

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

interface RefreshOptions {
  fetcher?: Fetcher;
  signedIn?: () => Promise<boolean>;
  force?: boolean;
  timeoutMs?: number;
}

/** Ask the server which behaviours to run, and keep the answer (also across a restart: a switch that was
 *  turned off must stay off when the app opens offline). One request at a time, however many places ask; and
 *  only a look at a signed-in session uses up the wait, so signing in after the app opened still asks. */
export function refreshExportFlags(options: RefreshOptions = {}): Promise<void> {
  if (inflight) return inflight;
  const now = Date.now();
  if (!options.force && askedAt !== 0 && now - askedAt >= 0 && now - askedAt < REFRESH_MS)
    return Promise.resolve();
  const asking = ask(options).finally(() => {
    if (inflight === asking) inflight = null;
  });
  inflight = asking;
  return asking;
}

async function ask(options: RefreshOptions): Promise<void> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), options.timeoutMs ?? TIMEOUT_MS);
  try {
    if (!(await (options.signedIn ?? hasSession)())) return;
    askedAt = Date.now();
    const fetcher: Fetcher = options.fetcher ?? ((url, init) => authedFetch(url, init));
    const response = await fetcher(`${apiBase()}/client/export-flags`, {
      method: "GET",
      signal: timeout.signal,
    });
    if (!response.ok) return;
    const body: unknown = await response.json();
    if (!body || typeof body !== "object" || (body as { v?: unknown }).v !== 1) return;
    const told = (body as { flags?: unknown }).flags;
    if (!told || typeof told !== "object") return;
    const next = { ...current };
    for (const name of EXPORT_FLAG_NAMES) {
      const value = (told as Record<string, unknown>)[name];
      if (typeof value === "boolean") next[name] = value;
    }
    current = next;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
    } catch {
      /* not being able to remember is not a failure */
    }
  } catch {
    /* unreachable, slow, damaged: the last good answer (or the defaults) stands */
  } finally {
    clearTimeout(timer);
  }
}

/** Tests only. */
export function __setExportFlag(name: ExportFlagName, value: boolean): void {
  current = { ...current, [name]: value };
}

/** Tests only. */
export function __resetExportFlags(options: { keepStorage?: boolean } = {}): void {
  askedAt = 0;
  inflight = null;
  if (!options.keepStorage) {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* none */
    }
  }
  current = stored();
}
