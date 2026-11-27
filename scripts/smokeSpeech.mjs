// The real speech-to-captions lane, in one command (art-daddy/backlog#83):
//
//   npm run smoke:speech
//
// Runs src/tools/captionsSpeech.e2e.ts on the committed recording (src/tools/__fixtures__/speech:
// Windows' own voice reading a known script, made by scripts/genSpeechFixture.ps1) through the
// shipped whisper-cli and the speech model this PC already has. Nothing is downloaded and nothing
// leaves the PC; without the engine or the model the run fails. Not part of `npm run smoke`, the
// hook or CI (no runner has the model): the lab PC runs it on its own schedule.
import { spawnSync } from "node:child_process";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const run = spawnSync(
  process.execPath,
  [
    path.join(root, "node_modules", "vitest", "vitest.mjs"),
    "run",
    "--config",
    "vitest.smoke.config.ts",
    "src/tools/captionsSpeech.e2e.ts",
    ...process.argv.slice(2),
  ],
  {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      ARTDADDY_SPEECH_WAV: path.join(root, "src", "tools", "__fixtures__", "speech", "spoken.ogg"),
    },
  },
);
process.exit(run.status ?? 1);
