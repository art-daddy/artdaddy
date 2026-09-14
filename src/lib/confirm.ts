// Tauri v2's webview replaces `window.confirm` with an async IPC shim that invokes
// `plugin:dialog|confirm` — a command tauri-plugin-dialog 2.7 no longer implements, so it
// is denied by the ACL and the returned Promise ALWAYS rejects. A Promise is truthy, so
// `if (!window.confirm(...))` silently ran every destructive branch without asking.
// The plugin's own `confirm()` goes through `plugin:dialog|message`, which is granted.
import { BRAND } from "../brand";

/** Ask before something destructive. Resolves false if the user said no OR we could not ask. */
export async function confirmDestructive(
  message: string,
  title = BRAND.displayName,
): Promise<boolean> {
  const w = typeof window !== "undefined" ? window : undefined;
  if (!w) return false;
  if (w.__TAURI_INTERNALS__ ?? w.__TAURI__) {
    try {
      const { confirm } = await import("@tauri-apps/plugin-dialog");
      return await confirm(message, { title, kind: "warning" });
    } catch {
      return false; // no dialog backend / ACL denial -> never proceed
    }
  }
  return w.confirm(message);
}
