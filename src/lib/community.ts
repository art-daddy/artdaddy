// The community link, in ONE place. Four surfaces point at it (the Help menu, the menu-bar
// tab, the sign-in screen and the landing page), so a reissued invite is a single edit.
//
// An INVITE, not a `discord.com/channels/...` URL: the latter only resolves for people who
// are already members, so it would show nothing to exactly the people it is meant to reach.
import { platform } from "../platform";

export const DISCORD_URL = "https://discord.gg/eJmUhD6vx";

/** Open the community link in the user's real browser / Discord app.
 *
 *  Goes through a command of ours rather than the shell plugin's own: that would need
 *  `shell:allow-open` in the capability file, which hands the whole webview the ability to
 *  open anything. The Rust side accepts only this destination. */
export async function openDiscord(): Promise<void> {
  if (platform.name !== "tauri") {
    window.open(DISCORD_URL, "_blank", "noopener,noreferrer");
    return;
  }
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("open_community_link", { url: DISCORD_URL });
  } catch {
    // Nothing to recover: the user asked for a chat server, not an operation that can fail
    // halfway. Silence beats an error modal over a link.
  }
}
