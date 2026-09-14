// Platform-capability abstraction so the SAME bundle runs as a web app now and
// inside a Tauri desktop shell later. Capabilities gate features (e.g. local
// tool execution) that only exist on desktop; on web those tools run on the
// server (via the gateway's in-process fallback) or are disabled.
import { apiBase } from "../api/config";

export type PlatformName = "web" | "tauri";

export interface Capabilities {
  /** Can run local tools (ffmpeg / yt-dlp / playwright) on this device. */
  localTools: boolean;
  /** Has direct local filesystem access. */
  fileSystem: boolean;
}

export interface Platform {
  name: PlatformName;
  capabilities: Capabilities;
  apiBaseUrl: string;
}

declare global {
  interface Window {
    __TAURI__?: unknown;
    __TAURI_INTERNALS__?: unknown;
  }
}

export function detectPlatform(): Platform {
  // Tauri v2 always injects `__TAURI_INTERNALS__`; `__TAURI__` only exists when
  // `withGlobalTauri` is enabled (it isn't here). Check both so the desktop shell
  // is detected regardless — otherwise the app runs as "web" and disables the
  // local tool runtime + the direct-fs fast paths.
  const w = typeof window !== "undefined" ? window : undefined;
  const isTauri = Boolean(w && (w.__TAURI_INTERNALS__ ?? w.__TAURI__));
  // apiBaseUrl is a getter: `platform` is built once at import, but the server is
  // user-configurable at runtime, so a snapshot here would go stale.
  return isTauri
    ? {
        name: "tauri",
        capabilities: { localTools: true, fileSystem: true },
        get apiBaseUrl() {
          return apiBase();
        },
      }
    : {
        name: "web",
        capabilities: { localTools: false, fileSystem: false },
        get apiBaseUrl() {
          return apiBase();
        },
      };
}

export const platform = detectPlatform();
