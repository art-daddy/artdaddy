import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { campaignSetup, gitState, serverState } from "./setup";

const SHA = "1234567890abcdef1234567890abcdef12345678";
const json = (body: unknown, ok = true) => ({ ok, json: async () => body });

describe("gitState", () => {
  it("reads the commit and whether tracked files were changed", () => {
    const git = (args: string[]) => (args[0] === "rev-parse" ? `${SHA}\n` : " M src/eval/x.ts\n");
    expect(gitState(git)).toEqual({ appGitSha: SHA, appGitDirty: true });
    expect(gitState((a) => (a[0] === "rev-parse" ? SHA : "\n"))).toEqual({
      appGitSha: SHA,
      appGitDirty: false,
    });
  });

  it("records null, never a guess, when git cannot answer", () => {
    const broken = () => {
      throw new Error("not a git repository");
    };
    expect(gitState(broken)).toEqual({ appGitSha: null, appGitDirty: null });
    expect(gitState(() => "fatal: bad revision").appGitSha).toBeNull();
  });
});

describe("serverState", () => {
  const prompt = "You are the editor's assistant.";

  it("reports the server's version, build and the sha256 of its base prompt", async () => {
    const asked: string[] = [];
    const get = async (url: string) => {
      asked.push(url);
      return url.endsWith("/health")
        ? json({ ok: true, version: "0.9.1", build: "ff70984" })
        : json({ instructions: prompt });
    };
    expect(await serverState("http://127.0.0.1:8000/", get)).toEqual({
      server: "http://127.0.0.1:8000",
      serverVersion: "0.9.1",
      serverBuild: "ff70984",
      promptSha256: createHash("sha256").update(prompt).digest("hex"),
    });
    expect(asked).toEqual([
      "http://127.0.0.1:8000/health",
      "http://127.0.0.1:8000/contract/instructions?host_notifies=true",
    ]);
  });

  it("moves the fingerprint when the prompt moves, by one character", async () => {
    const at = (text: string) =>
      serverState("http://s", async (url) =>
        url.endsWith("/health") ? json({}) : json({ instructions: text }),
      );
    expect((await at(prompt)).promptSha256).not.toBe((await at(`${prompt} `)).promptSha256);
  });

  it("records null for what the server would not tell, and never throws", async () => {
    const down = async () => {
      throw new Error("ECONNREFUSED");
    };
    expect(await serverState("http://s", down)).toEqual({
      server: "http://s",
      serverVersion: null,
      serverBuild: null,
      promptSha256: null,
    });
    const refused = async () => json({ detail: "unauthorized" }, false);
    expect((await serverState("http://s", refused)).promptSha256).toBeNull();
    const empty = async (url: string) =>
      url.endsWith("/health") ? json({ build: "" }) : json({ instructions: "" });
    expect(await serverState("http://s", empty)).toMatchObject({
      serverBuild: null,
      promptSha256: null,
    });
  });

  it("puts both together for a campaign", async () => {
    const get = async (url: string) =>
      url.endsWith("/health") ? json({ version: "1" }) : json({ instructions: prompt });
    const setup = await campaignSetup("http://s", get, (a) => (a[0] === "rev-parse" ? SHA : ""));
    expect(setup).toMatchObject({ appGitSha: SHA, appGitDirty: false, serverVersion: "1" });
  });
});
