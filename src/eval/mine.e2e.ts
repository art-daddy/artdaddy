// The offline transcript-mining lane — `npm run mine`. Reads recorded sessions
// from a projects dir (default the desktop app's data dir), runs the friction
// analyzer over each, and writes reports/eval/transcript-mining.md. Zero model
// spend, no media needed. Point it elsewhere with ARTDADDY_MINE_DIR.
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { IDENTITY } from "../brand";
import { type MinedSession, type RawTranscript, mineReport, mineSession } from "./mining";

const MINE = process.env.ARTDADDY_MINE === "1";

/** The app-data base Tauri's `dataDir()` reports, per OS — the node-side twin of
 *  `src/tools/dataRoot.ts` (which needs Tauri and so cannot run in this lane). */
function appDataBase(): string {
  if (process.platform === "win32") {
    return process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support");
  }
  return process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share");
}

// Hard-coding `~/AppData/Roaming/ArtDaddy` here made this lane mine NOTHING twice over: it is a
// Windows-only path, and it names the folder the app used BEFORE the rename. Both failures look
// identical to "no sessions recorded", so the lane reported clean and nobody looked.
const DIR = process.env.ARTDADDY_MINE_DIR ?? path.join(appDataBase(), IDENTITY.dataFolder, "projects");

describe.skipIf(!MINE)("transcript mining (offline, real recorded sessions)", () => {
  const mined: MinedSession[] = [];

  it("mines every project that has a transcript.json", async () => {
    const entries = await fsp.readdir(DIR, { withFileTypes: true }).catch(() => [] as never[]);
    const names = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    for (const name of names) {
      let raw: string;
      try {
        raw = await fsp.readFile(path.join(DIR, name, "internals", "transcript.json"), "utf8");
      } catch {
        continue;
      }
      let json: RawTranscript;
      try {
        json = JSON.parse(raw) as RawTranscript;
      } catch {
        continue;
      }
      mined.push(mineSession(name, json));
    }
    // eslint-disable-next-line no-console
    console.log(`[mine] ${mined.length} session(s) from ${DIR}`);
    expect(mined.length).toBeGreaterThan(0);
  });

  afterAll(async () => {
    if (!mined.length) return;
    const md = mineReport(mined);
    const dir = path.resolve("reports/eval");
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, "transcript-mining.md"), md);
    // eslint-disable-next-line no-console
    console.log(`\n${md}\n\nReport: reports/eval/transcript-mining.md`);
  });
});
