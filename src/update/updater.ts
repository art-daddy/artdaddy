// Desktop auto-update. The check/download/install runs in RUST (see src-tauri/src/lib.rs)
// and is invoked here, so no updater JS package is needed.
//
// Being out of date is not an error state: every failure path here resolves to "no
// update" rather than surfacing, because an unreachable release host must never block
// someone from using the app they already have installed.
import { platform } from "../platform";

export interface UpdateInfo {
  version: string;
  current_version: string;
  notes: string;
  date: string;
}

const isDesktop = (): boolean => platform.name === "tauri";

async function invokeCmd<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

/** An available update, or null when current / offline / not on desktop. */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  if (!isDesktop()) return null;
  try {
    return (await invokeCmd<UpdateInfo | null>("check_for_update")) ?? null;
  } catch (e) {
    console.debug("[update] check failed (staying on the installed build)", e);
    return null;
  }
}

/** Download and verify the update, staged in Rust. Nothing closes or installs yet: the user
 *  keeps working, and a failure here leaves everything as it was. */
export async function downloadUpdate(): Promise<string> {
  if (!isDesktop()) throw new Error("updates are desktop-only");
  return invokeCmd<string>("download_update");
}

/** Install the staged update and relaunch. Call it only once the exit guard has closed the
 *  project. Rejects so the caller can surface a real failure — unlike the check, the user
 *  explicitly asked for this one. */
export async function installUpdate(): Promise<void> {
  if (!isDesktop()) throw new Error("updates are desktop-only");
  await invokeCmd<void>("install_update");
}
