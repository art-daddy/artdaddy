// A turn that is waiting for the person (an approval, or Continue) while the window is not in front: ask the
// operating system to draw their eye to it (the taskbar button flashes, the dock icon bounces). A person who
// started a long job and went to another window used to come back to find it had stopped at the first question
// and had been waiting there for a long time (the gap before the first paid tool of a batch: median 9 s, p90
// 117 s, one 46 minutes). Nothing is shown inside the app and nothing is written: only the system's own hint.
import { platform } from "../platform";

export async function askForAttention(): Promise<void> {
  if (platform.name !== "tauri") return;
  try {
    const { getCurrentWindow, UserAttentionType } = await import("@tauri-apps/api/window");
    const win = getCurrentWindow();
    // The window in front already has their eye; a hint then is noise.
    if (await win.isFocused()) return;
    await win.requestUserAttention(UserAttentionType.Informational);
  } catch {
    // A hint, never a failure: a platform without it, or a window already gone, is nothing to report.
  }
}
