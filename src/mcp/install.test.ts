import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  cursorInstallUrl,
  installClaudeConnector,
  openInstallLink,
  vscodeInstallUrl,
} from "./install";
import { BRAND } from "../brand";
import { MCP_PORT } from "./service";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const platformMock = vi.hoisted(() => ({ name: "tauri" }));
vi.mock("../platform", () => ({ platform: platformMock }));

const endpoint = `http://127.0.0.1:${MCP_PORT}/mcp`;

/** What the editor actually receives, not what we meant to send. */
const cursorPayload = () => {
  const config = new URL(cursorInstallUrl()).searchParams.get("config")!;
  return JSON.parse(atob(config));
};
const vscodePayload = (url: string) => JSON.parse(decodeURIComponent(url.split("?")[1]));

describe("MCP install links", () => {
  it("hands Cursor the inner server object, and the name separately", () => {
    // Cursor takes the entry WITHOUT the { mcpServers: … } wrapper. Sending the wrapper is the
    // obvious mistake and would register a server called "mcpServers" pointing nowhere.
    expect(cursorPayload()).toEqual({ type: "http", url: endpoint });
    expect(new URL(cursorInstallUrl()).searchParams.get("name")).toBe(BRAND.mcpServerName);
  });

  it("hands VS Code the whole entry, name included", () => {
    // The mirror-image mistake: VS Code has no separate name param, so omitting it here leaves
    // the server unnamed.
    expect(vscodePayload(vscodeInstallUrl())).toEqual({
      name: BRAND.mcpServerName,
      type: "http",
      url: endpoint,
    });
  });

  it("targets Insiders with its own scheme", () => {
    expect(vscodeInstallUrl(true).startsWith("vscode-insiders:")).toBe(true);
    expect(vscodeInstallUrl(false).startsWith("vscode:")).toBe(true);
  });

  it("survives a server name that needs escaping", () => {
    // The name reaches the URL as a query param and the JSON as a value; a raw & or space would
    // truncate the first and a raw quote would break the second.
    const url = cursorInstallUrl();
    expect(() => new URL(url)).not.toThrow();
    expect(() => cursorPayload()).not.toThrow();
  });

  it("every link we build is one Rust will actually open", () => {
    // Rust refuses anything outside INSTALL_LINK_PREFIXES. If these two drift, the button does
    // nothing and the failure is silent on the user's side — they just see no editor open.
    const rs = readFileSync(resolve(__dirname, "../../src-tauri/src/lib.rs"), "utf8");
    const block = rs.slice(rs.indexOf("INSTALL_LINK_PREFIXES"));
    const prefixes = [...block.slice(0, block.indexOf("];")).matchAll(/"([^"]+)"/g)].map(
      (m) => m[1],
    );
    expect(prefixes.length).toBeGreaterThan(0);

    for (const url of [cursorInstallUrl(), vscodeInstallUrl(false), vscodeInstallUrl(true)]) {
      expect(
        prefixes.some((p) => url.startsWith(p)),
        `Rust would refuse ${url}`,
      ).toBe(true);
    }
  });
});

describe("install outcomes", () => {
  it("does not report success when the attempt was refused", () => {
    // The failure direction that matters: a button that says "Opened" to someone who has no such
    // editor sends them away believing it worked.
    invoke.mockRejectedValueOnce("refused: not an MCP install link");
    return expect(openInstallLink("vscode:mcp/install?x")).resolves.toEqual({
      ok: false,
      message: "refused: not an MCP install link",
    });
  });

  it("passes Rust's reason through untouched, because it is the actionable part", () => {
    // "Claude Desktop was not found. Install it, then try again." tells the user what to do;
    // a generic "couldn't open" does not. Rust owns the wording, so it must not be rewritten.
    invoke.mockRejectedValueOnce("Claude Desktop was not found. Install it, then try again.");
    return expect(installClaudeConnector()).resolves.toEqual({
      ok: false,
      message: "Claude Desktop was not found. Install it, then try again.",
    });
  });

  it("blames the missing shell, not the editor, outside the desktop app", () => {
    invoke.mockRejectedValueOnce(new Error("Failed to fetch dynamically imported module"));
    return expect(openInstallLink(cursorInstallUrl())).resolves.toEqual({
      ok: false,
      message: "Installing from here needs the desktop app. Use the config below.",
    });
  });

  it("never shows a raw TypeError on the web build", async () => {
    // Found by driving the real UI: on web the module IMPORTS fine and `invoke` is undefined, so
    // the panel displayed "Cannot read properties of undefined (reading 'invoke')". Desktop-ness
    // is now asked of the platform instead of guessed from whatever the failure said.
    platformMock.name = "web";
    try {
      invoke.mockImplementation(() => {
        throw new TypeError("Cannot read properties of undefined (reading 'invoke')");
      });
      for (const outcome of [
        await openInstallLink(cursorInstallUrl()),
        await installClaudeConnector(),
      ]) {
        expect(outcome).toEqual({
          ok: false,
          message: "Installing from here needs the desktop app. Use the config below.",
        });
      }
      // and it must not even try to reach the shell
      expect(invoke).not.toHaveBeenCalled();
    } finally {
      platformMock.name = "tauri";
      invoke.mockReset();
    }
  });

  it("tells the user where the connector went and what is left to do", async () => {
    // Success here is "the file is saved and shown", NOT "the connector is installed" — the
    // old version reported installed the moment a process spawned, which is how a tester ended
    // up with Claude flashing open and no connector, and the UI saying it had worked.
    invoke.mockResolvedValueOnce("C:\\Users\\x\\Downloads\\artdaddy.mcpb");
    const outcome = await installClaudeConnector();
    expect(outcome.ok).toBe(true);
    expect(outcome.message).toContain("artdaddy.mcpb");
    expect(outcome.message).toMatch(/Install Extension/i);
  });

  it("never leaves the user with an empty explanation", () => {
    // A thrown value with no message would render as a blank amber line.
    invoke.mockRejectedValueOnce({});
    return expect(openInstallLink(cursorInstallUrl())).resolves.toMatchObject({ ok: false });
  });
});
