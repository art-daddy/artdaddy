// The real host OS/CPU. The webview's user-agent cannot be trusted for this: WebKit reports an
// Intel Mac on Apple Silicon, and that distinction decides which native sidecar build is running —
// exactly what we need when export or transcription dies on one machine and not another. So the
// desktop answer comes from Rust (`std::env::consts`), with the user-agent only as a fallback for
// the web build and for the moment before the first IPC round-trip completes.
import { platform } from "./index";
import { settledWithin } from "../lib/settledWithin";
import { CHIP_MAKERS, type ChipMaker } from "../timeline/exportEncoder";
import type { ExportBudgets } from "../timeline/exportOptions";

export type HostOs = "windows" | "macos" | "linux" | "unknown";

export interface HostInfo {
  os: HostOs;
  /** "x86_64" | "aarch64" | … — empty until Rust answers (always empty on web). */
  arch: string;
}

export interface LinuxMemoryCgroup {
  readonly version: 2;
  readonly path: string;
  readonly identity: string;
  readonly process_id: number;
  readonly memory_max_bytes: number | null;
  readonly swap_max_bytes: number | null;
}

export interface ExportTemporarySpace {
  readonly scope: string;
  readonly totalBytes: number;
  readonly payloadBytes: number;
  readonly infrastructureBytes: number;
  readonly entryLimit: number;
}

/** A graphics chip the PC has, as the app process reports it (Windows only): the maker the exporter has an encoder for,
 *  the PCI device number and the installed driver. They key the chip test's local cache; only the maker is ever reported. */
export interface GraphicsAdapter {
  readonly maker: ChipMaker;
  readonly device: string;
  readonly driver: string;
}

export interface ExportResources {
  readonly total_memory_bytes: number | null;
  readonly available_memory_bytes: number | null;
  readonly scratch_free_bytes: number | null;
  readonly destination_free_bytes: number | null;
  readonly budgets: ExportBudgets;
  /** The graphics chips of the makers the exporter knows; absent when the PC could not be asked (none then). */
  readonly adapters?: readonly GraphicsAdapter[];
  /** Retired: the developer-only AMD check of earlier builds. Nothing reads it; the app process no longer sends it. */
  readonly local_fast_candidate?: boolean;
  readonly temporary_space?: ExportTemporarySpace;
  readonly memory_cgroup?: LinuxMemoryCgroup;
}

/** The adapters a response lists, each only if it is the shape the app process sends: a known maker, a hex device
 *  number and a driver made of digits and dots. Anything else is dropped (and the PC is simply taken to have no such chip). */
export function cleanAdapters(raw: unknown): GraphicsAdapter[] {
  if (!Array.isArray(raw)) return [];
  const out: GraphicsAdapter[] = [];
  for (const item of raw.slice(0, 8)) {
    if (!item || typeof item !== "object") continue;
    const { maker, device, driver } = item as Record<string, unknown>;
    if (
      !(CHIP_MAKERS as readonly unknown[]).includes(maker) ||
      typeof device !== "string" ||
      !/^[0-9a-f]{1,8}$/.test(device) ||
      typeof driver !== "string" ||
      !/^[0-9.]{0,40}$/.test(driver)
    )
      continue;
    if (out.some((seen) => seen.maker === maker && seen.device === device)) continue;
    out.push({ maker: maker as ChipMaker, device, driver });
  }
  return out;
}

export async function resolveExportResources(
  destination: string,
  signal?: AbortSignal,
): Promise<ExportResources> {
  const unknown: ExportResources = {
    total_memory_bytes: null,
    available_memory_bytes: null,
    scratch_free_bytes: null,
    destination_free_bytes: null,
    budgets: { memoryBytes: null, temporaryBytes: null, executionSeconds: null },
    adapters: [],
  };
  if (platform.name !== "tauri" || signal?.aborted) return unknown;
  const pending = (async (): Promise<ExportResources> => {
    const { invoke } = await import("@tauri-apps/api/core");
    if (signal?.aborted) return unknown;
    const response = await invoke<unknown>("jobs_export_resources", { destination });
    if (!response || typeof response !== "object" || Array.isArray(response)) return unknown;
    const raw = response as Record<string, unknown>;
    const bytes = (key: string): number | null => {
      const value = raw[key];
      return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
    };
    const total = bytes("total_memory_bytes");
    const available = bytes("available_memory_bytes");
    const limits =
      raw.budgets && typeof raw.budgets === "object"
        ? (raw.budgets as Record<string, unknown>)
        : {};
    const limit = (key: string): number | null => {
      const value = limits[key];
      return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
    };
    let temporarySpace: ExportTemporarySpace | undefined;
    if (raw.temporary_space !== undefined) {
      const invalid = (): never => {
        console.warn(
          "Native temporary-space contract is malformed; resource snapshot is unavailable",
        );
        throw new Error("Native temporary-space contract is malformed");
      };
      const value = raw.temporary_space;
      if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
      const { scope, totalBytes, payloadBytes, infrastructureBytes, entryLimit } = value as Record<
        string,
        unknown
      >;
      const validBytes = (bytes: unknown): bytes is number =>
        typeof bytes === "number" && Number.isSafeInteger(bytes) && bytes >= 0;
      if (
        typeof scope !== "string" ||
        !/^[a-z0-9][a-z0-9.-]{0,63}$/.test(scope) ||
        !validBytes(totalBytes) ||
        !validBytes(payloadBytes) ||
        !validBytes(infrastructureBytes) ||
        !validBytes(entryLimit) ||
        entryLimit < 1 ||
        payloadBytes + infrastructureBytes !== totalBytes
      )
        return invalid();
      temporarySpace = { scope, totalBytes, payloadBytes, infrastructureBytes, entryLimit };
    }
    let memoryCgroup: LinuxMemoryCgroup | undefined;
    if (raw.memory_cgroup !== undefined) {
      const invalid = (): never => {
        console.warn(
          "Native cgroup resource evidence is malformed; resource snapshot is unavailable",
        );
        throw new Error("Native cgroup resource evidence is malformed");
      };
      const value = raw.memory_cgroup;
      if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
      const group = value as Record<string, unknown>;
      const memory = group.memory_max_bytes;
      const swap = group.swap_max_bytes;
      const groupPath = group.path;
      const identity = group.identity;
      const pid = group.process_id;
      const validLimit = (bytes: unknown): bytes is number | null =>
        bytes === null || (typeof bytes === "number" && Number.isSafeInteger(bytes) && bytes >= 0);
      if (
        group.version !== 2 ||
        typeof groupPath !== "string" ||
        !groupPath.startsWith("/") ||
        /[\0\r\n]/.test(groupPath) ||
        (groupPath !== "/" &&
          groupPath
            .slice(1)
            .split("/")
            .some((part) => !part || part === "." || part === "..")) ||
        typeof identity !== "string" ||
        !/^\d+:\d+$/.test(identity) ||
        typeof pid !== "number" ||
        !Number.isSafeInteger(pid) ||
        pid <= 0 ||
        !validLimit(memory) ||
        !validLimit(swap)
      )
        return invalid();
      memoryCgroup = {
        version: 2,
        path: groupPath,
        identity,
        process_id: pid,
        memory_max_bytes: memory,
        swap_max_bytes: swap,
      };
    }
    return {
      total_memory_bytes: total !== null && total > 0 ? total : null,
      available_memory_bytes:
        total !== null && total > 0 && available !== null && available <= total ? available : null,
      scratch_free_bytes: bytes("scratch_free_bytes"),
      destination_free_bytes: bytes("destination_free_bytes"),
      budgets: {
        memoryBytes: limit("memoryBytes"),
        temporaryBytes: limit("temporaryBytes"),
        executionSeconds: limit("executionSeconds"),
      },
      adapters: cleanAdapters(raw.adapters),
      ...(temporarySpace ? { temporary_space: temporarySpace } : {}),
      ...(memoryCgroup ? { memory_cgroup: memoryCgroup } : {}),
    };
  })();
  return (await settledWithin(pending, 2000, signal)) ?? unknown;
}

/** How a probe came out. `ran` says what the command did (its exit code, its output, how long it took); the rest say
 *  why it did not run to the end: `busy` (an export is running, or there was no supervisor to ask: try again later),
 *  `timeout` (it did not finish in time and was ended) or `stopped` (the caller's signal ended it). */
export type ProbeOutcome =
  | {
      readonly kind: "ran";
      readonly code: number;
      readonly stdout: string;
      readonly stderr: string;
      readonly ms: number;
    }
  | { readonly kind: "busy" }
  | { readonly kind: "timeout" }
  | { readonly kind: "stopped" };

/** Run one short ffmpeg command as a job on the capability lane and say how it ended. Never throws, and the job is
 *  always ended and forgotten. It is the one place the exporter's graphics-chip test runs ffmpeg. */
export async function runCapabilityProbe(
  args: readonly string[],
  options: { signal?: AbortSignal; timeoutMs: number; kind: string },
): Promise<ProbeOutcome> {
  const { signal } = options;
  if (signal?.aborted) return { kind: "stopped" };
  const { jobSupervisor, whenJobEnds, jobResult } = await import("../tools/jobSupervisor");
  const jobs = await settledWithin(
    jobSupervisor().catch(() => null),
    2000,
    signal,
  );
  if (signal?.aborted) return { kind: "stopped" };
  if (!jobs) return { kind: "busy" };
  const active = await settledWithin(
    jobs.list().catch(() => null),
    2000,
    signal,
  );
  if (signal?.aborted) return { kind: "stopped" };
  if (!active) return { kind: "busy" };
  // A test never competes with an export for the processor or the chip.
  if (active.some((job) => job.lane === "export" && job.state !== "exited"))
    return { kind: "busy" };
  const id = `chip_probe_${crypto.randomUUID().replaceAll("-", "")}`;
  const started = Date.now();
  try {
    await jobs.submit({
      id,
      lane: "fast-capability",
      program: "ffmpeg",
      args: [...args],
      meta: { kind: options.kind },
    });
    const ended = await settledWithin(whenJobEnds(jobs, id), options.timeoutMs, signal);
    if (signal?.aborted) return { kind: "stopped" };
    if (!ended) return { kind: "timeout" };
    if (ended.killed) return { kind: "stopped" };
    const result = jobResult(ended);
    return {
      kind: "ran",
      code: result.code ?? -1,
      stdout: result.stdout,
      stderr: result.stderr,
      ms: Date.now() - started,
    };
  } catch {
    return { kind: "busy" };
  } finally {
    let ended = (
      await settledWithin(
        jobs.list().catch(() => []),
        2000,
      )
    )?.find((job) => job.id === id);
    if (ended?.state !== "exited") {
      const killed = await settledWithin(
        jobs.kill(id).catch(() => false),
        2000,
      );
      if (killed) ended = (await settledWithin(whenJobEnds(jobs, id), 5000)) ?? undefined;
    }
    if (ended?.state === "exited") {
      await settledWithin(
        jobs.commit(id).catch(() => false),
        2000,
      );
      await settledWithin(
        jobs.forget(id).catch(() => false),
        2000,
      );
    }
  }
}

export function osFromUserAgent(ua: string): HostOs {
  if (/Windows/i.test(ua)) return "windows";
  // Order matters: an iPad's UA contains both "Macintosh" and "like Mac OS X".
  if (/Mac OS X|Macintosh|iPhone|iPad/i.test(ua)) return "macos";
  if (/Linux|X11|Android|CrOS/i.test(ua)) return "linux";
  return "unknown";
}

function guess(): HostInfo {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent || "";
  return { os: osFromUserAgent(ua), arch: "" };
}

let cached: HostInfo = guess();
let inflight: Promise<HostInfo> | null = null;

/** The best answer known right now — never throws, never blocks. */
export function hostInfo(): HostInfo {
  return cached;
}

/** `windows-x86_64`, or just `windows` before Rust has answered. For one-field telemetry. */
export function hostTag(): string {
  const { os, arch } = cached;
  return arch ? `${os}-${arch}` : os;
}

/** Ask Rust for the authoritative OS/arch and cache it. Safe to call more than once; a failure
 *  leaves the user-agent guess in place rather than reporting nothing. */
export async function resolveHostInfo(): Promise<HostInfo> {
  if (cached.arch) return cached;
  if (platform.name !== "tauri") return cached;
  inflight ??= (async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const [os, arch] = await invoke<[string, string]>("host_platform");
      if (os) cached = { os: os as HostOs, arch: arch || "" };
    } catch {
      /* keep the user-agent guess */
    }
    return cached;
  })();
  return inflight;
}

/** Tests only. */
export function __resetHostInfo(): void {
  cached = guess();
  inflight = null;
}
