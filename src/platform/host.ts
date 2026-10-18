// The real host OS/CPU. The webview's user-agent cannot be trusted for this: WebKit reports an
// Intel Mac on Apple Silicon, and that distinction decides which native sidecar build is running —
// exactly what we need when export or transcription dies on one machine and not another. So the
// desktop answer comes from Rust (`std::env::consts`), with the user-agent only as a fallback for
// the web build and for the moment before the first IPC round-trip completes.
import { platform } from "./index";
import { settledWithin } from "../lib/settledWithin";
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

export interface ExportResources {
  readonly total_memory_bytes: number | null;
  readonly available_memory_bytes: number | null;
  readonly scratch_free_bytes: number | null;
  readonly destination_free_bytes: number | null;
  readonly budgets: ExportBudgets;
  readonly local_fast_candidate: boolean;
  readonly memory_cgroup?: LinuxMemoryCgroup;
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
    local_fast_candidate: false,
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
    let memoryCgroup: LinuxMemoryCgroup | undefined;
    if (raw.memory_cgroup !== undefined) {
      const invalid = (): never => {
        console.warn("Native cgroup resource evidence is malformed; resource snapshot is unavailable");
        throw new Error("Native cgroup resource evidence is malformed");
      };
      const value = raw.memory_cgroup;
      if (!value || typeof value !== "object" || Array.isArray(value))
        return invalid();
      const group = value as Record<string, unknown>;
      const memory = group.memory_max_bytes;
      const swap = group.swap_max_bytes;
      const groupPath = group.path;
      const identity = group.identity;
      const pid = group.process_id;
      const validLimit = (bytes: unknown): bytes is number | null =>
        bytes === null || typeof bytes === "number" && Number.isSafeInteger(bytes) && bytes >= 0;
      if (group.version !== 2 || typeof groupPath !== "string" || !groupPath.startsWith("/") ||
        /[\0\r\n]/.test(groupPath) || groupPath !== "/" &&
          groupPath.slice(1).split("/").some((part) => !part || part === "." || part === "..") ||
        typeof identity !== "string" || !/^\d+:\d+$/.test(identity) ||
        typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0 ||
        !validLimit(memory) || !validLimit(swap))
        return invalid();
      memoryCgroup = { version: 2, path: groupPath, identity, process_id: pid,
        memory_max_bytes: memory, swap_max_bytes: swap };
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
      local_fast_candidate: raw.local_fast_candidate === true,
      ...(memoryCgroup ? { memory_cgroup: memoryCgroup } : {}),
    };
  })();
  return (await settledWithin(pending, 2000, signal)) ?? unknown;
}

export async function resolveLocalFastEncoder(signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted || !(await resolveExportResources("", signal)).local_fast_candidate)
    return false;
  const { jobSupervisor, whenJobEnds } = await import("../tools/jobSupervisor");
  const jobs = await settledWithin(
    jobSupervisor().catch(() => null),
    2000,
    signal,
  );
  if (!jobs || signal?.aborted) return false;
  const active = await settledWithin(
    jobs.list().catch(() => null),
    2000,
    signal,
  );
  if (!active || signal?.aborted) return false;
  if (active.some((job) => job.lane === "export" && job.state !== "exited")) return false;
  const id = `fast_probe_${crypto.randomUUID().replaceAll("-", "")}`;
  try {
    await jobs.submit({
      id,
      lane: "fast-capability",
      program: "ffmpeg",
      args: [
        "-hide_banner",
        "-nostdin",
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=1920x1080:r=30:d=0.1",
        "-frames:v",
        "1",
        "-an",
        "-c:v",
        "h264_amf",
        "-usage",
        "transcoding",
        "-quality",
        "quality",
        "-rc",
        "cqp",
        "-qp_i",
        "18",
        "-qp_p",
        "18",
        "-qp_b",
        "18",
        "-f",
        "null",
        "-",
      ],
      meta: { kind: "local-fast-capability" },
    });
    const ended = await settledWithin(whenJobEnds(jobs, id), 10000, signal);
    if (!ended || signal?.aborted) return false;
    return ended.code === 0 && !ended.killed;
  } catch {
    return false;
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
