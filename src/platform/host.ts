// The real host OS/CPU. The webview's user-agent cannot be trusted for this: WebKit reports an
// Intel Mac on Apple Silicon, and that distinction decides which native sidecar build is running —
// exactly what we need when export or transcription dies on one machine and not another. So the
// desktop answer comes from Rust (`std::env::consts`), with the user-agent only as a fallback for
// the web build and for the moment before the first IPC round-trip completes.
import { platform } from "./index";

export type HostOs = "windows" | "macos" | "linux" | "unknown";

export interface HostInfo {
  os: HostOs;
  /** "x86_64" | "aarch64" | … — empty until Rust answers (always empty on web). */
  arch: string;
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
