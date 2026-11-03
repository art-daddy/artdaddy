// One run of the SHIPPED speech engine over several real clips (T-34 step 3). The unit tests script the
// engine; this is the engine itself, handed the arguments the app builds, reading real speech.
//
// Five clips say different things. They go to the engine in ONE process, and each clip must come back with
// its own words: an output file matched to the wrong input would put one clip's sentence on another, which
// no count of processes or files can show.
//
// Needs a speech synthesizer to make the clips (Windows: SAPI, macOS: say); elsewhere it skips.
// Run: npx vitest run --config vitest.smoke.config.ts src/tools/whisperBatch.smoke.e2e.ts
import { spawnSync } from "node:child_process";
import { existsSync, promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { shippedSidecar } from "../test/sidecars";
import type { CommandRunner } from "./command";
import { joinPath } from "./store";
import { ensureTranscripts, peekTranscript, whisperModelPath } from "./transcribe";
import { mkCtx, nodeFs, nodeRunner } from "./__e2e";

const proj = joinPath(os.tmpdir(), `artdaddy-whisper-batch-${Date.now()}`);
const model = whisperModelPath(proj, "small");
const whisper = shippedSidecar("whisper-cli");

/** What each clip says, and the one word of it that no other clip says. */
const CLIPS = [
  { say: "The red apple fell from the tall tree.", word: "apple" },
  { say: "A quiet river runs beside the old garden.", word: "river" },
  { say: "She opened the window and watched the rain.", word: "window" },
  { say: "Please sharpen this pencil before the lesson starts.", word: "pencil" },
  { say: "The train leaves the station at noon.", word: "station" },
];

/** Speech for `text` in `out`; false where this machine has no synthesizer. */
function speak(text: string, out: string): boolean {
  if (process.platform === "win32") {
    const script =
      "Add-Type -AssemblyName System.Speech; " +
      "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; " +
      "$s.SetOutputToWaveFile($env:ART_OUT); $s.Speak($env:ART_TEXT); $s.Dispose()";
    const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
      env: { ...process.env, ART_TEXT: text, ART_OUT: out },
      windowsHide: true,
    });
    return r.status === 0 && existsSync(out);
  }
  if (process.platform === "darwin") {
    const r = spawnSync("say", ["-o", out, "--data-format=LEI16@22050", text]);
    return r.status === 0 && existsSync(out);
  }
  return false;
}

async function filesUnder(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const e of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) found.push(...(await filesUnder(p)));
    else found.push(p);
  }
  return found;
}

const flagValues = (args: string[], flag: string): string[] =>
  args.flatMap((a, i) => (a === flag ? [args[i + 1]] : []));

beforeAll(async () => {
  await fsp.mkdir(path.join(proj, "src"), { recursive: true });
});
afterAll(async () => {
  await fsp.rm(proj, { recursive: true, force: true }).catch(() => undefined);
});

describe("the shipped engine over several clips", () => {
  it.skipIf(!whisper || !existsSync(model))(
    "reads them all in one process, and every clip keeps its own words",
    async (t) => {
      const files = CLIPS.map((_, i) => path.join(proj, "src", `clip${i + 1}.wav`));
      for (const [i, c] of CLIPS.entries()) if (!speak(c.say, files[i])) return t.skip();

      const launches: string[][] = [];
      const runner: CommandRunner = {
        async run(program, args, signal, cwd, onStdout) {
          if (program === "whisper-cli") launches.push(args);
          return nodeRunner.run(program, args, signal, cwd, onStdout);
        },
      };
      const ctx = { ...mkCtx(proj), runner };

      const outcomes = await ensureTranscripts(ctx, files, "small", "en");
      expect(outcomes.map((o) => (o.ok ? "ok" : String(o.error)))).toEqual(files.map(() => "ok"));

      // ONE process, with every clip in it
      expect(launches).toHaveLength(1);
      expect(flagValues(launches[0], "-f")).toHaveLength(CLIPS.length);
      expect(new Set(flagValues(launches[0], "-of")).size).toBe(CLIPS.length);

      // each clip says its own sentence and nobody else's
      for (const [i, c] of CLIPS.entries()) {
        const kept = await peekTranscript(ctx, files[i], "small", "en");
        const words = (kept?.words ?? []).map((w) => w.word.toLowerCase()).join(" ");
        console.log(`[whisper batch] clip ${i + 1}:`, words); // eslint-disable-line no-console
        expect(words, `clip ${i + 1}`).toContain(c.word);
        for (const [j, other] of CLIPS.entries())
          if (j !== i)
            expect(words, `clip ${i + 1} must not say clip ${j + 1}'s word`).not.toContain(
              other.word,
            );
      }

      // nothing is left behind in the work folder: no audio, no scratch output
      expect(await filesUnder((await nodeFs.workDir!()) as string)).toEqual([]);
    },
    300_000,
  );
});
