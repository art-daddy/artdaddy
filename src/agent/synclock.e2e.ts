// Model-driven E2E: drives the REAL client agent loop (ClientTurnRunner) against
// the REAL model on a locally-running server (127.0.0.1:8000), executing the REAL
// client timeline tools against a real fs-backed store. Seeds a realistic
// multi-track timeline and sends NATURAL editing prompts (no mention of sync-lock
// or linking) to verify the model's edits keep other tracks aligned (sync-lock)
// and carry linked audio (link groups).
//
// Requires the server running with metering OFF:
//   $env:AZURE_COSMOS_ENDPOINT=' '; $env:AZURE_COSMOS_KEY=' '; $env:ARTDADDY_AUTH_DISABLED='1'
//   .\.venv\Scripts\python.exe -m src.akaru.server
// Run:  npx vitest run --config vitest.smoke.config.ts src/agent/synclock.e2e.ts
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ClientTurnRunner, type LoopDeps } from "./loop";
import type { RoundInput, RoundResultDTO } from "./types";
import { ProjectStoreAccess, type FsLike } from "../tools/store";
import type { ClientToolContext } from "../tools/context";
import type { CommandResult, CommandRunner } from "../tools/command";
import { ClientToolRegistry } from "../tools/registry";
import { registerTimelineTools } from "../timeline/ops";
import { ensureTimeline, loadTimeline, replaceTimeline } from "../timeline/engine";
import type { Timeline } from "../timeline/model";

const SERVER = process.env.ARTDADDY_SERVER ?? "http://127.0.0.1:8000";
// Opt-in: needs the model server running with metering OFF (see header). Off by
// default so a normal `npm run smoke` (ffmpeg-only) doesn't require a live model.
const RUN = process.env.ARTDADDY_SMOKE_MODEL === "1";

const nodeFs: FsLike = {
  async exists(p) {
    try {
      await fsp.access(p);
      return true;
    } catch {
      return false;
    }
  },
  readTextFile: (p) => fsp.readFile(p, "utf8"),
  async writeTextFile(p, c) {
    await fsp.mkdir(path.dirname(p), { recursive: true });
    await fsp.writeFile(p, c);
  },
  async mkdir(p) {
    await fsp.mkdir(p, { recursive: true });
  },
};

const noopRunner: CommandRunner = {
  run: async (): Promise<CommandResult> => ({ code: 0, stdout: "", stderr: "" }),
};

/** A three-shot main video track (v2), a logo overlay on v1 sitting over the
 *  OUTRO, the outro's linked audio on a2, and a full-length music bed on a3. */
function seedTimeline(): Timeline {
  return {
    canvas: { width: 1080, height: 1920, fps: 30 },
    tracks: [
      {
        id: "v1",
        kind: "video",
        z: 2,
        clips: [
          {
            id: "logo",
            media_ref: "logo.png",
            kind: "video",
            timeline_in: 120,
            timeline_out: 180,
            source_in: 0,
            source_out: 60,
          },
        ],
      },
      {
        id: "v2",
        kind: "video",
        z: 1,
        clips: [
          {
            id: "intro",
            media_ref: "intro.mp4",
            kind: "video",
            timeline_in: 0,
            timeline_out: 60,
            source_in: 0,
            source_out: 60,
          },
          {
            id: "middle",
            media_ref: "middle.mp4",
            kind: "video",
            timeline_in: 60,
            timeline_out: 120,
            source_in: 0,
            source_out: 60,
          },
          {
            id: "outro",
            media_ref: "outro.mp4",
            kind: "video",
            timeline_in: 120,
            timeline_out: 180,
            source_in: 0,
            source_out: 60,
            link_group: "lg_outro",
          },
        ],
      },
      {
        id: "a2",
        kind: "audio",
        z: 1,
        clips: [
          {
            id: "outroAud",
            media_ref: "outro.mp4",
            kind: "audio",
            timeline_in: 120,
            timeline_out: 180,
            source_in: 0,
            source_out: 60,
            link_group: "lg_outro",
          },
        ],
      },
      {
        id: "a3",
        kind: "audio",
        z: 0,
        clips: [
          {
            id: "bed",
            media_ref: "music.mp3",
            kind: "audio",
            timeline_in: 0,
            timeline_out: 180,
            source_in: 0,
            source_out: 180,
          },
        ],
      },
    ],
  } as unknown as Timeline;
}

async function makeCtx(): Promise<{
  ctx: ClientToolContext;
  store: ProjectStoreAccess;
  dir: string;
}> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "artdaddy-synclock-"));
  const store = new ProjectStoreAccess(dir, nodeFs);
  await ensureTimeline(store);
  await replaceTimeline(store, seedTimeline());
  return { ctx: { store, runner: noopRunner }, store, dir };
}

/** Drive ONE natural-language turn to completion in autopilot, logging every
 *  tool call, and return the tool-call names in order. */
async function drive(
  ctx: ClientToolContext,
  prompt: string,
): Promise<{ tools: string[]; text: string }> {
  const registry = new ClientToolRegistry();
  registerTimelineTools(registry, () => ctx);

  let snapshot: Record<string, unknown> | null = null;
  const infer = async (roundInput: RoundInput): Promise<RoundResultDTO> => {
    const res = await fetch(`${SERVER}/inference`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        round_input: roundInput,
        provider_snapshot: snapshot,
        mode: "autopilot",
      }),
    });
    if (!res.ok) throw new Error(`/inference ${res.status}: ${await res.text().catch(() => "")}`);
    const dto = (await res.json()) as RoundResultDTO;
    snapshot = dto.provider_snapshot ?? snapshot;
    return dto;
  };

  const tools: string[] = [];
  let finalText = "";
  const deps: LoopDeps = {
    infer,
    runTool: async (name, args) => {
      tools.push(name);
      // eslint-disable-next-line no-console
      console.log(`  → tool: ${name} ${JSON.stringify(args)}`);
      const r = await registry.run(name, args as Record<string, unknown>);
      // eslint-disable-next-line no-console
      console.log(`    ← ${JSON.stringify(r)}`);
      return r;
    },
    emit: (event, data) => {
      if (event === "text" && typeof data.text === "string") finalText = data.text;
      if (event === "reasoning" && typeof data.text === "string")
        console.log(`  ~ ${String(data.text).slice(0, 200)}`);
    },
    mode: () => "autopilot",
    stopped: () => false,
    onUsage: () => {},
    session: () => ({}),
    onToolError: (n, _a, e) => console.error(`  ! tool error ${n}: ${String(e)}`),
  };

  const runner = new ClientTurnRunner(deps);
  await runner.start(prompt);
  return { tools, text: finalText };
}

function clipsOf(tl: Timeline, trackId: string): Array<{ id: string; in: number; out: number }> {
  const t = (tl.tracks ?? []).find((x) => x.id === trackId);
  return (t?.clips ?? [])
    .map((c) => ({ id: String(c.id), in: Number(c.timeline_in), out: Number(c.timeline_out) }))
    .sort((a, b) => a.in - b.in);
}

describe.skipIf(!RUN)("model-driven sync-lock + link groups (real server + real model)", () => {
  it("a natural 'cut the middle shot' ripples the overlay + linked audio into alignment", async () => {
    const { ctx, store } = await makeCtx();
    const prompt =
      "This project has three back-to-back clips on the main video track — an intro (0–2s), " +
      "a middle section (2–4s), and an outro (4–6s). The middle section doesn't work. " +
      "Remove it and tighten the timeline so the outro comes right after the intro.";
    // eslint-disable-next-line no-console
    console.log(`\n=== PROMPT ===\n${prompt}\n=== RUN ===`);
    const { tools, text } = await drive(ctx, prompt);

    const tl = await loadTimeline(store);
    // eslint-disable-next-line no-console
    console.log("\n=== FINAL TIMELINE ===");
    for (const id of ["v1", "v2", "a2", "a3"])
      console.log(`  ${id}:`, JSON.stringify(clipsOf(tl, id)));
    console.log(`tools: ${tools.join(", ")}\nassistant: ${text}\n`);

    const v2 = clipsOf(tl, "v2");
    expect(v2.map((c) => c.id)).not.toContain("middle"); // middle removed
    const outro = v2.find((c) => c.id === "outro")!;
    expect([outro.in, outro.out]).toEqual([60, 120]); // outro slid up to meet intro

    // The overlay (v1, sync-locked, NOT asked about) followed the outro:
    const logo = clipsOf(tl, "v1").find((c) => c.id === "logo")!;
    expect([logo.in, logo.out]).toEqual([60, 120]);
    // The outro's linked audio (a2) followed its video:
    const outroAud = clipsOf(tl, "a2").find((c) => c.id === "outroAud")!;
    expect([outroAud.in, outroAud.out]).toEqual([60, 120]);
    // The full-length music bed spans the cut, so it stays put (not shifted):
    const bed = clipsOf(tl, "a3").find((c) => c.id === "bed")!;
    expect([bed.in, bed.out]).toEqual([0, 180]);
  }, 180_000);
});
