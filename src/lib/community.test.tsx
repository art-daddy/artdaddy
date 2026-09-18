// Where the community link shows up, and what it is allowed to reach.
//
// Four surfaces point at ONE constant, which is the only reason a reissued invite is a single
// edit — so the drift guard here is doing as much work as the rendering ones.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const platform = vi.hoisted(() => ({ name: "tauri" as string, capabilities: {} }));
vi.mock("../platform", () => ({ platform }));

const startDesktopSignIn = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
vi.mock("../api/desktopAuth", () => ({ startDesktopSignIn, signOutDesktop: vi.fn() }));
const authState = vi.hoisted(() => ({ status: "locked", verify: vi.fn(), markLocked: vi.fn() }));
vi.mock("../store/auth", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  useAuth: Object.assign((sel: any) => sel(authState), { getState: () => authState }),
}));

import { DISCORD_URL, openDiscord } from "./community";
import SignInScreen from "../components/SignInScreen";

beforeEach(() => {
  invoke.mockClear();
  platform.name = "tauri";
});

describe("opening the community link", () => {
  // The app has no `shell:allow-open` capability on purpose: a general "open this URL" would
  // let the whole webview hand anything to the OS. It goes through our own guarded command.
  it("asks the guarded command rather than the shell plugin", async () => {
    await openDiscord();
    expect(invoke).toHaveBeenCalledWith("open_community_link", { url: DISCORD_URL });
  });

  it("falls back to a new tab off the desktop, where there is no such command", async () => {
    platform.name = "web";
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    await openDiscord();
    expect(open).toHaveBeenCalledWith(DISCORD_URL, "_blank", "noopener,noreferrer");
    expect(invoke).not.toHaveBeenCalled();
    open.mockRestore();
  });

  // A link is not an operation with a half-done state. Throwing here would put an error in
  // front of someone who only clicked "Discord".
  it("never throws when the command fails", async () => {
    invoke.mockRejectedValueOnce(new Error("no handler"));
    await expect(openDiscord()).resolves.toBeUndefined();
  });
});

describe("where it is offered", () => {
  it("is on the sign-in screen, which is where someone stuck has nobody to ask", async () => {
    render(
      <MemoryRouter>
        <SignInScreen />
      </MemoryRouter>,
    );
    const link = screen.getByRole("button", { name: /discord/i });
    fireEvent.click(link);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("open_community_link", { url: DISCORD_URL }),
    );
  });
});

describe("the link itself", () => {
  // One constant, four surfaces. A second literal is how the invite gets reissued in three
  // places and stays broken in the fourth. Asserted against the SURFACES rather than by
  // walking the tree: it states the rule directly, and a whole-of-src read races the other
  // test that does the same walk.
  it.each([
    ["src/components/MenuBar.tsx", "the menu bar tab and the Help entry"],
    ["src/components/SignInScreen.tsx", "the sign-in screen"],
  ])("%s imports the constant instead of repeating it", (file) => {
    const src = readFileSync(file, "utf8");
    expect(src).not.toMatch(/discord\.(com|gg)\//);
    expect(src).toContain("openDiscord");
  });

  it("is written down in community.ts, once", () => {
    const src = readFileSync("src/lib/community.ts", "utf8");
    // Quoted literals only — the file's comment names discord.gg/<code> as the invite form
    // to switch to, and prose is not a second source of truth.
    expect(src.match(/"https:\/\/discord\.(com|gg)\/[^"]*"/g)).toHaveLength(1);
    expect(src).toContain(`export const DISCORD_URL = "${DISCORD_URL}"`);
  });

  // The Rust guard accepts `discord.gg/` too, so swapping in a real invite needs no rebuild.
  it("points at a Discord the guard will accept", () => {
    expect(DISCORD_URL).toMatch(/^https:\/\/(discord\.gg\/|discord\.com\/channels\/)/);
  });
});
