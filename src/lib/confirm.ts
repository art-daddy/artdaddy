// Tauri v2's webview replaces `window.confirm` with an async IPC shim that invokes
// `plugin:dialog|confirm` — a command tauri-plugin-dialog 2.7 no longer implements, so it
// is denied by the ACL and the returned Promise ALWAYS rejects. A Promise is truthy, so
// `if (!window.confirm(...))` silently ran every destructive branch without asking.
// The plugin's own `confirm()` goes through `plugin:dialog|message`, which is granted.
import { BRAND } from "../brand";

export type ExportConfirmation = "continue" | "cancel" | "unavailable";
let exportConfirmationForTests:
  ((message: string, warning: boolean) => Promise<ExportConfirmation>) | null = null;

export function __setExportConfirmationForTests(handler: typeof exportConfirmationForTests): void {
  exportConfirmationForTests = handler;
}

export async function confirmExport(
  message: string,
  warning: boolean,
): Promise<ExportConfirmation> {
  if (exportConfirmationForTests) {
    try {
      const choice = await exportConfirmationForTests(message, warning);
      return choice === "continue" || choice === "cancel" ? choice : "unavailable";
    } catch {
      return "unavailable";
    }
  }
  const view = typeof window === "undefined" ? undefined : window;
  if (!view) return "unavailable";
  try {
    let answer: unknown;
    if (view.__TAURI_INTERNALS__ ?? view.__TAURI__) {
      const { confirm } = await import("@tauri-apps/plugin-dialog");
      answer = await confirm(message, {
        title: "Export check",
        kind: warning ? "warning" : "info",
        okLabel: warning ? "Continue anyway" : "Continue",
        cancelLabel: "Cancel",
      });
    } else answer = view.confirm(message);
    return answer === true ? "continue" : answer === false ? "cancel" : "unavailable";
  } catch {
    return "unavailable";
  }
}

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

let canvasChangeForTests: ((message: string) => Promise<boolean>) | null = null;

export function __setCanvasChangeConfirmationForTests(handler: typeof canvasChangeForTests): void {
  canvasChangeForTests = handler;
}

/** The question a clip that does not fit the project's canvas puts to the person (timeline/canvasAuto.ts).
 *  True: change the project to match the clip. False: keep it as it is, which is also the answer when no
 *  dialog could be shown: a question that cannot be asked never changes the canvas. */
export async function confirmCanvasChange(message: string): Promise<boolean> {
  if (canvasChangeForTests) {
    try {
      return (await canvasChangeForTests(message)) === true;
    } catch {
      return false;
    }
  }
  const w = typeof window !== "undefined" ? window : undefined;
  if (!w) return false;
  try {
    if (w.__TAURI_INTERNALS__ ?? w.__TAURI__) {
      const { confirm } = await import("@tauri-apps/plugin-dialog");
      return (
        (await confirm(message, {
          title: "Clip and project differ",
          kind: "info",
          okLabel: "Change to Match",
          cancelLabel: "Keep Current",
        })) === true
      );
    }
    return w.confirm(message) === true;
  } catch {
    return false;
  }
}
