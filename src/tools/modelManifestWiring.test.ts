// The acceptance test of the WIRING of the second place into the download, in transcribe.ts: the table the app really
// downloads by (WHISPER_MODELS), with no spec injected and no change on any server. The mechanism (modelManifest.ts)
// and the download it feeds (modelDownloadLoopback.test.ts, which injects the spec the wiring will build) are tested
// apart from it; this is what says the app itself does it.
//
// It is RED until transcribe.ts maps `mirrors: secondPlaces(e)` into WHISPER_MODELS and narrows the remote list with
// `remotePlacesFor(pinned, speechModelSources())` in downloadModel, and green once it does.
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { __resetExportFlags, refreshExportFlags } from "../api/exportFlags";
import { LoopbackPlaces, MemoryModelFs } from "../test/loopbackModelServer";
import type { CommandRunner } from "./command";
import { MODEL_MANIFEST, MAX_EXTRA_SOURCES, primaryUrl, secondPlaces } from "./modelManifest";
import { ProjectStoreAccess } from "./store";
import {
  __setDownloadPolicy,
  ensureWhisperModel,
  PATIENT_DOWNLOAD,
  WHISPER_MODELS,
} from "./transcribe";

const KEYS = Object.keys(MODEL_MANIFEST);
const NO_COMMANDS: CommandRunner = { run: async () => ({ code: 1, stdout: "", stderr: "" }) };
/** As many attempts as the app makes, without the waiting between them. */
const EVERY_ATTEMPT = { stallMs: Infinity, backoffMs: PATIENT_DOWNLOAD.backoffMs.map(() => 0) };
const REMOTE = (file: string): string =>
  `https://cdn.huggingface.co/some-org/some-copy/resolve/main/${file}`;

let places: LoopbackPlaces | null = null;

beforeEach(() => {
  localStorage.clear();
  __resetExportFlags();
});
afterEach(async () => {
  __setDownloadPolicy(PATIENT_DOWNLOAD);
  __resetExportFlags();
  localStorage.clear();
  await places?.stop();
  places = null;
});

/** Every place answers 500, as often as it is asked: the app has to go through its places to find out. */
async function everyPlaceDown(): Promise<LoopbackPlaces> {
  places = await LoopbackPlaces.start({});
  const down = PATIENT_DOWNLOAD.backoffMs.map(() => ({ status: 500 }) as const);
  places.script("first", ...down, { status: 500 });
  places.script("second", ...down, { status: 500 });
  places.script("other", ...down, { status: 500 });
  return places;
}

const downloadOf = (key: string, served: LoopbackPlaces) => {
  __setDownloadPolicy(EVERY_ATTEMPT);
  const ctx = {
    store: new ProjectStoreAccess("C:/data/projects/p1", new MemoryModelFs()),
    runner: NO_COMMANDS,
  };
  // No spec: the table the app ships.
  return ensureWhisperModel(ctx, key, served.fetch);
};

describe("the table the app downloads by, with no spec injected and no server change", () => {
  it("walks at least two models, or the walk below would pass for nothing", () => {
    expect(KEYS.length).toBeGreaterThanOrEqual(2);
  });

  it.each(KEYS)("%s: carries its entry's second place", (key) => {
    expect(WHISPER_MODELS[key].mirrors).toEqual(secondPlaces(MODEL_MANIFEST[key]));
  });

  it.each(KEYS)(
    "%s: asks its first place and then its second place, and no other, when they fail",
    async (key) => {
      const served = await everyPlaceDown();
      await expect(downloadOf(key, served)).rejects.toThrow();
      const entry = MODEL_MANIFEST[key];
      expect(served.asked.slice(0, 2)).toEqual([primaryUrl(entry), secondPlaces(entry)[0]]);
      expect(new Set(served.asked)).toEqual(new Set([primaryUrl(entry), ...secondPlaces(entry)]));
      expect(served.refused).toEqual([]);
    },
  );

  it.each(KEYS)("%s: uses a remote address only for the file it names", async (key) => {
    const listed = KEYS.slice(0, MAX_EXTRA_SOURCES);
    await refreshExportFlags({
      force: true,
      signedIn: async () => true,
      fetcher: async () =>
        new Response(
          JSON.stringify({
            v: 1,
            flags: {},
            speech_model_sources: listed.map((k) => REMOTE(MODEL_MANIFEST[k].file)),
          }),
          { status: 200 },
        ),
    });
    const entry = MODEL_MANIFEST[key];
    const served = await everyPlaceDown();
    await expect(downloadOf(key, served)).rejects.toThrow();
    // Before the places the app compiled in, never after them, and never an address that names another file.
    expect(served.asked.slice(0, 2)).toEqual([primaryUrl(entry), secondPlaces(entry)[0]]);
    for (const other of KEYS.filter((k) => k !== key))
      expect(served.asked, `${other}'s address for ${key}`).not.toContain(
        REMOTE(MODEL_MANIFEST[other].file),
      );
    if (listed.includes(key)) expect(served.asked).toContain(REMOTE(entry.file));
  });
});
