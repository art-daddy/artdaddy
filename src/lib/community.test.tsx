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
  // places and stays broken in the fourth.
  it("is written down exactly once in the app source", () => {
    const hits: string[] = [];
    const walk = (dir: string): void => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const fs = require("node:fs") as typeof import("node:fs");
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = `${dir}/${e.name}`;
        if (e.isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) {
          if (readFileSync(p, "utf8").includes("discord.com/channels")) hits.push(p);
        }
      }
    };
    walk("src");
    expect(hits).toEqual(["src/lib/community.ts"]);
  });

  // The Rust guard accepts `discord.gg/` too, so swapping in a real invite needs no rebuild.
  it("points at a Discord the guard will accept", () => {
    expect(DISCORD_URL).toMatch(/^https:\/\/(discord\.gg\/|discord\.com\/channels\/)/);
  });
});
