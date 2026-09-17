// Guards for the Claude Desktop connector bundle (mcpb/).
//
// The bundle is the one piece of this app that runs OUTSIDE it, in Claude's node process, with
// no shared imports — so nothing but a test stops it drifting from the server it talks to. The
// failure mode is silent and total: the connector installs, shows up in Claude, and every call
// times out.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { MCP_PORT } from "./service";

const root = resolve(__dirname, "../..");
const manifest = JSON.parse(readFileSync(resolve(root, "mcpb/manifest.json"), "utf8"));
const shim = readFileSync(resolve(root, "mcpb/server/index.js"), "utf8");

describe("Claude Desktop connector bundle", () => {
  it("talks to the port this app actually listens on", () => {
    // The shim cannot import MCP_PORT — it ships to another process. Change the port without
    // this test and every installed connector breaks with a timeout that names nothing.
    const url = shim.match(/http:\/\/127\.0\.0\.1:(\d+)\/mcp/);
    expect(url, "no loopback endpoint found in the shim").toBeTruthy();
    expect(Number(url![1])).toBe(MCP_PORT);
  });

  it("points its entry point at a file that exists", () => {
    // A manifest naming a missing file installs as a connector that dies on first launch.
    expect(() => readFileSync(resolve(root, "mcpb", manifest.server.entry_point))).not.toThrow();
  });

  it("launches the same file the manifest declares", () => {
    // Two places name the entry point; if they disagree, Claude runs the wrong one.
    expect(manifest.server.mcp_config.args).toContain(
      `\${__dirname}/${manifest.server.entry_point}`,
    );
  });

  it("claims the version this build ships", () => {
    // build-mcpb.mjs overwrites this from tauri.conf.json, so a stale value here is only ever
    // misleading — keep the committed file honest.
    const tauri = JSON.parse(readFileSync(resolve(root, "src-tauri/tauri.conf.json"), "utf8"));
    expect(manifest.version).toBe(tauri.version);
  });

  it("does not advertise the Claude Desktop bundle on Linux", () => {
    // Claude Code uses the HTTP endpoint directly on Linux. Claiming Linux here would instead
    // advertise an .mcpb for Claude Desktop, which has no supported Linux desktop application.
    expect(manifest.compatibility.platforms).toEqual(["win32", "darwin"]);
  });

  it("is shipped as a resource, or it is not in the build at all", () => {
    // A bundle that never gets staged makes the Install button fail for every user.
    const tauri = JSON.parse(readFileSync(resolve(root, "src-tauri/tauri.conf.json"), "utf8"));
    expect(tauri.bundle.resources).toContain("resources/artdaddy.mcpb");
  });

  it("answers with an error and STAYS UP when ArtDaddy is closed", async () => {
    // Claude keeps the connector alive across app restarts, so the shim must survive the app
    // going away. Exiting here is what turns "I closed the editor" into "the connector is
    // broken, reinstall it" — and no string in the source can tell you which one it does.
    const shim = spawn(process.execPath, [resolve(root, "mcpb/server/index.js")], {
      stdio: ["pipe", "pipe", "ignore"],
      env: { ...process.env, ARTDADDY_MCP_URL: "http://127.0.0.1:59999/mcp" }, // nothing listens
    });
    const replies: Record<string, unknown>[] = [];
    let buf = "";
    shim.stdout.on("data", (d: Buffer) => {
      buf += d.toString();
      for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) replies.push(JSON.parse(line));
      }
    });
    let exited = false;
    shim.on("exit", () => (exited = true));

    const reply = async (id: number) => {
      for (let i = 0; i < 100 && !replies.some((r) => r.id === id); i++)
        await new Promise((r) => setTimeout(r, 50));
      return replies.find((r) => r.id === id) as { error?: { message: string } } | undefined;
    };

    try {
      shim.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-06-18" },
        }) + "\n",
      );
      expect((await reply(1))?.error?.message).toMatch(/not reachable/i);
      expect(exited, "the shim exited instead of reporting the failure").toBe(false);

      // And it must keep serving — one failed call cannot poison the session.
      shim.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
      expect((await reply(2))?.error).toBeTruthy();
    } finally {
      shim.kill();
    }
  }, 20000);
});
