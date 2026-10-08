// The app's own whisper invocation, run for real: its stderr has to say which backend ran and how
// long it took (4i part 4), or the usage sample is empty for every user.
// Run: npx vitest run --config vitest.smoke.config.ts src/tools/whisperFacts.smoke.e2e.ts
import { existsSync, promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const { reportTranscription } = vi.hoisted(() => ({ reportTranscription: vi.fn() }));
vi.mock("../api/appEvents", async (orig) => ({ ...(await orig<object>()), reportTranscription }));

import type { CommandRunner } from "./command";
import { joinPath } from "./store";
import { runWhisper, whisperModelPath } from "./transcribe";
import { whisperRunFacts } from "./whisperFacts";
import { mkCtx, nodeRunner, srcTone } from "./__e2e";

// One level under the OS temp dir, where the app's e2e runs keep the whisper model (two levels up).
const proj = joinPath(os.tmpdir(), `artdaddy-whisper-facts-${Date.now()}`);
const model = whisperModelPath(proj, "small");

beforeAll(async () => {
  await fsp.mkdir(path.join(proj, "src"), { recursive: true });
});
afterAll(async () => {
  await fsp.rm(proj, { recursive: true, force: true }).catch(() => undefined);
});

describe("whisper as the app runs it", () => {
  it.skipIf(!existsSync(model))(
    "says which backend it ran on, how much it heard and how long it took",
    async () => {
      const file = await srcTone(path.join(proj, "src", "tone.wav"), { freq: 440, dur: 35 });
      const stderrs: string[] = [];
      const runner: CommandRunner = {
        async run(program, args, signal, cwd, onStdout) {
          const r = await nodeRunner.run(program, args, signal, cwd, onStdout);
          if (program === "whisper-cli") stderrs.push(r.stderr);
          return r;
        },
      };
      await runWhisper({ ...mkCtx(proj), runner }, file);
      expect(stderrs).toHaveLength(1);
      const facts = whisperRunFacts(stderrs[0]);
      console.log("[whisper] run:", facts); // eslint-disable-line no-console
      expect(facts.backend).toMatch(/^(cpu|vulkan|metal|cuda)$/);
      expect(facts.audioSeconds).toBeCloseTo(35, 1);
      expect(facts.wallSeconds).toBeGreaterThan(0);
      expect([facts.model, facts.threads! > 0]).toEqual(["small", true]);
      expect(reportTranscription.mock.calls).toEqual([[facts]]);
    },
    300_000,
  );
});
