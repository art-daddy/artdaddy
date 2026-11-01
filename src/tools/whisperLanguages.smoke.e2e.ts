// The language table against the engine itself.
//
// whisper-cli checks `-l` right after its arguments and before it opens the model, so a run with a
// model that is not there tells a language it accepts (it goes on to fail on the model) from one it
// refuses (it prints "unknown language" and exits 0) without transcribing anything.
//
// The engine is the shipped sidecar, or the one in ARTDADDY_WHISPER_CLI. A machine where it cannot
// start (the Windows sidecar needs the DLLs the installed app puts beside it) skips, because a skip
// there says nothing about the table.
// Run: npx vitest run --config vitest.smoke.config.ts src/tools/whisperLanguages.smoke.e2e.ts
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { shippedSidecar } from "../test/sidecars";
import { nodeRunner } from "./__e2e";
import { LANGUAGE_ALIASES, WHISPER_LANGUAGES, whisperCode } from "./whisperLanguages";

const engine = process.env.ARTDADDY_WHISPER_CLI || shippedSidecar("whisper-cli");
let dir = "";
let input = "";

beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "artdaddy-lang-"));
  input = path.join(dir, "input.wav");
  writeFileSync(input, Buffer.alloc(64)); // only has to exist: the language is read before it
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function refuses(language: string): Promise<{ refused: boolean; started: boolean }> {
  const r = await nodeRunner.run(
    engine!,
    ["-m", path.join(dir, "no-such-model.bin"), "-f", input, "-l", language],
    undefined,
    path.dirname(engine!),
  );
  return {
    refused: /error: unknown language/.test(r.stderr),
    started: /failed to (open|initialize)/.test(r.stderr) || /unknown language/.test(r.stderr),
  };
}

describe("the language table, against the engine it is for", () => {
  it.skipIf(!engine)(
    "the engine accepts every language in the table, by code and by name, and refuses what is not in it",
    async (t) => {
      if (!(await refuses("en")).started) return t.skip();

      // The probe can tell the two apart, or none of the below means anything.
      expect((await refuses("zz")).refused).toBe(true);

      const codes = Object.keys(WHISPER_LANGUAGES);
      const bad: string[] = [];
      for (let i = 0; i < codes.length; i += 6)
        await Promise.all(
          codes.slice(i, i + 6).map(async (code) => {
            if ((await refuses(code)).refused) bad.push(code);
          }),
        );
      expect(bad, "codes in the table that the engine refuses").toEqual([]);

      for (const name of ["tagalog", "haitian creole", "Japanese"])
        expect((await refuses(name)).refused, name).toBe(false);

      // What a caller may send is handed on as one of those, never as itself.
      for (const written of [...Object.keys(LANGUAGE_ALIASES), "klingon", "xx", "Pt-BR"]) {
        const sent = whisperCode(written);
        if (sent) expect(codes, written).toContain(sent);
      }
    },
    180_000,
  );
});
