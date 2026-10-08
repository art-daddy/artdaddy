// 4i, on the shipped ffmpeg and whisper: closing a project while its indexer transcribes a file lets
// that transcription finish (Palmier's close, owner decision 2026-10-04). The transcript is kept in
// the app cache, where another project finds it; nothing is written into the closed project from the
// moment it closed; and whisper's scratch is gone from the work folder when it is done.
// Run: npx vitest run --config vitest.smoke.config.ts src/store/indexClose.smoke.e2e.ts
import { spawnSync } from "node:child_process";
import { existsSync, promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { IndexCoordinator } from "./indexCoordinator";
import type { CommandResult, CommandRunner } from "../tools/command";
import { joinPath } from "../tools/store";
import { peekTranscript, whisperModelPath } from "../tools/transcribe";
import { ff, mkCtx, nodeFs, nodeRunner } from "../tools/__e2e";

const { reportAppError } = vi.hoisted(() => ({ reportAppError: vi.fn() }));
vi.mock("../api/appEvents", async (orig) => ({ ...(await orig<object>()), reportAppError }));

const proj = joinPath(os.tmpdir(), `artdaddy-index-close-${Date.now()}`);
const other = joinPath(os.tmpdir(), `artdaddy-index-close-other-${Date.now()}`);
const model = whisperModelPath(proj, "small");

beforeAll(async () => {
  await fsp.mkdir(path.join(proj, "src"), { recursive: true });
  await fsp.mkdir(other, { recursive: true });
});
afterAll(async () => {
  for (const dir of [proj, other]) await fsp.rm(dir, { recursive: true, force: true });
});

/** Every file under `dir`, with its size and when it was last written. */
async function tree(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (d: string): Promise<void> => {
    for (const e of await fsp.readdir(d, { withFileTypes: true }).catch(() => [])) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else {
        const st = await fsp.stat(p);
        out.set(p, `${st.size}@${st.mtimeMs}`);
      }
    }
  };
  await walk(dir);
  return out;
}

/** Speech (Windows' own TTS), then 40 s of silence, so whisper is still at work when we close. */
async function talk(): Promise<string> {
  const speech = path.join(proj, "src", "speech.wav");
  const ps = [
    "Add-Type -AssemblyName System.Speech",
    "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer",
    `$s.SetOutputToWaveFile('${speech.replace(/'/g, "''")}')`,
    "$s.Speak('The quick brown fox jumps over the lazy dog. The project closed while this was heard.')",
    "$s.Dispose()",
  ].join("; ");
  const r = spawnSync("powershell", ["-NoProfile", "-Command", ps], { windowsHide: true });
  if (r.status !== 0 || !existsSync(speech)) throw new Error("no speech synthesiser here");
  const out = path.join(proj, "src", "talk.flac");
  await ff([
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    speech,
    "-f",
    "lavfi",
    "-t",
    "40",
    "-i",
    "anullsrc=r=48000:cl=mono",
    "-filter_complex",
    "[0:a]aresample=48000,aformat=channel_layouts=mono[a];[a][1:a]concat=n=2:v=0:a=1",
    "-c:a",
    "flac",
    out,
  ]);
  return out;
}

describe("closing a project while its indexer transcribes (4i)", () => {
  it.skipIf(process.platform !== "win32" || !existsSync(model))(
    "finishes the transcription, keeps it for every project, and writes nothing into the closed one",
    async () => {
      const file = await talk();
      let whisperStarted!: () => void;
      const started = new Promise<void>((r) => (whisperStarted = r));
      const whisper: CommandResult[] = [];
      const watching: CommandRunner = {
        async run(program, args, signal, cwd, onStdout) {
          if (program === "whisper-cli") whisperStarted();
          const r = await nodeRunner.run(program, args, signal, cwd, onStdout);
          if (program === "whisper-cli") whisper.push(r);
          return r;
        },
      };
      const index = new IndexCoordinator(
        mkCtx(proj).store,
        () => watching,
        () => undefined,
        () => undefined,
      );
      index.indexSource(file);
      await started;
      const atClose = await tree(proj);
      index.dispose();

      const elsewhere = mkCtx(other);
      let words: string[] = [];
      for (let t0 = Date.now(); Date.now() - t0 < 300_000;) {
        const kept = await peekTranscript(elsewhere, file);
        if (kept) {
          words = kept.words.map((w) => w.word.toLowerCase().replace(/[^a-z]/g, ""));
          break;
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      // whisper ran to its end, not killed by the close...
      expect(whisper.map((r) => r.code)).toEqual([0]);
      // ...its words are kept, and another project reads them without running anything...
      expect(words).toEqual(expect.arrayContaining(["quick", "brown", "fox", "closed"]));
      // ...nothing in the closed project changed after the close...
      expect(await tree(proj)).toEqual(atClose);
      // ...and whisper's audio and output leave the work folder as the run ends.
      const workDir = await nodeFs.workDir!();
      let left = [...(await tree(workDir)).keys()];
      for (let t0 = Date.now(); left.length && Date.now() - t0 < 10_000;) {
        await new Promise((r) => setTimeout(r, 100));
        left = [...(await tree(workDir)).keys()];
      }
      expect(left).toEqual([]);
      expect(reportAppError).not.toHaveBeenCalled();
    },
    600_000,
  );
});
