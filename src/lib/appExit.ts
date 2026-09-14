// Quitting the app has ONE door: raise the window's close request and let App's guard run the
// save/confirm flow. A menu item that closed the window directly would bypass that guard, which is
// how a quit path silently loses work.
import { platform } from "../platform";

export async function requestExit(): Promise<void> {
  if (platform.name !== "tauri") return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().close();
}
