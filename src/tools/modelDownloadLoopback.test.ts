// The speech model's download, end to end over a real socket, for EVERY file of the manifest.
//
// `ensureWhisperModel` is the app's own installer; under it run `downloadModel` (which places to ask, in which order,
// how often) and `transferModel` (Range, the length, the SHA-256). Here they talk to a real HTTP server on this
// machine's loopback address (src/test/loopbackModelServer.ts) that plays the first place and the second place, and
// write to a disk that keeps the bytes. The addresses are the real compiled ones (primaryUrl, secondPlaces) and only
// the last step, getting from the address to the socket, is pointed at the server, so the ORDER in which the app
// asks its places is read back from what the server saw. The files here are small stand-ins that keep each entry's
// real file name and revision, so the layout of every address is the real one.
//
// What no test here can say: that Cloudflare's network answers the way this server does (the coordinator measured
// that from the public address), or what the web view's fetch does with CORS (a loopback server needs none).
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetExportFlags, refreshExportFlags } from "../api/exportFlags";
import { readFacts } from "../lib/localFacts";
import {
  clearModelDownload,
  setModelDownloadFailure,
  useModelDownload,
} from "../store/modelDownload";
import {
  corrupted,
  fakeModelBytes,
  LoopbackPlaces,
  MemoryModelFs,
  serversListening,
  sha256Hex,
  type PlaceName,
  type Turn,
} from "../test/loopbackModelServer";
import type { CommandRunner } from "./command";
import type { ClientToolContext } from "./context";
import { MODEL_MANIFEST, primaryUrl, secondPlaces, type ModelEntry } from "./modelManifest";
import { ProjectStoreAccess } from "./store";
import {
  __setDownloadPolicy,
  ensureWhisperModel,
  PATIENT_DOWNLOAD,
  SINGLE_ATTEMPT,
  whisperModelPath,
  type DownloadPolicy,
  type WhisperModelSpec,
} from "./transcribe";

const DIR = "C:/data/projects/p1";
const NO_COMMANDS: CommandRunner = { run: async () => ({ code: 1, stdout: "", stderr: "" }) };

/** The app's four attempts, without the waiting between them. */
const FOUR_ATTEMPTS: DownloadPolicy = { stallMs: Infinity, backoffMs: [0, 0, 0] };
/** The same, with a request that is quiet for half a second counted as stalled. */
const FOUR_QUICK_STALLS: DownloadPolicy = { stallMs: 500, backoffMs: [0, 0, 0] };

const KEYS = Object.keys(MODEL_MANIFEST);

/** The stand-in bytes of a manifest file: odd lengths, different for every file. */
const contentOf = (key: string): Buffer =>
  fakeModelBytes(key, 700_001 + KEYS.indexOf(key) * 250_003);

interface Rig {
  key: string;
  entry: ModelEntry;
  /** The bytes of the file the places hold, and the spec that pins them. */
  content: Buffer;
  spec: WhisperModelSpec;
  places: LoopbackPlaces;
  fs: MemoryModelFs;
  ctx: ClientToolContext;
  path: string;
  part: string;
  marker: string;
  /** The size of the part file at the moment each request was made. */
  partAtAsk: number[];
  fetchImpl: typeof fetch;
}

const rigs: Rig[] = [];

/** A model of the manifest as small stand-in bytes behind both places, which hold every file of the manifest.
 *  `mirrors: false` leaves the first place alone. */
async function rigFor(
  key: string,
  options: { mirrors?: boolean; fs?: MemoryModelFs } = {},
): Promise<Rig> {
  const entry = MODEL_MANIFEST[key];
  const content = contentOf(key);
  const places = await LoopbackPlaces.start(
    Object.fromEntries(KEYS.map((other) => [MODEL_MANIFEST[other].file, contentOf(other)])),
  );
  const fs = options.fs ?? new MemoryModelFs();
  const spec: WhisperModelSpec = {
    file: entry.file,
    revision: entry.revision,
    bytes: content.length,
    sha256: sha256Hex(content),
    // Exactly what transcribe.ts will carry for the entry once the table maps it in.
    ...(options.mirrors !== false && { mirrors: secondPlaces(entry) }),
  };
  const path = whisperModelPath(DIR, key, spec.file);
  const part = `${path}.${spec.sha256.slice(0, 12)}.part`;
  const partAtAsk: number[] = [];
  const rig: Rig = {
    key,
    entry,
    content,
    spec,
    places,
    fs,
    ctx: { store: new ProjectStoreAccess(DIR, fs), runner: NO_COMMANDS },
    path,
    part,
    marker: `${path}.verified.json`,
    partAtAsk,
    fetchImpl: ((input: RequestInfo | URL, init?: RequestInit) => {
      partAtAsk.push(fs.bytes.get(part)?.length ?? 0);
      return places.fetch(input, init);
    }) as typeof fetch,
  };
  rigs.push(rig);
  return rig;
}

/** The app's own installer, with the policy it is to be patient by. */
function install(rig: Rig, policy: DownloadPolicy) {
  __setDownloadPolicy(policy);
  return ensureWhisperModel(rig.ctx, rig.key, rig.fetchImpl, rig.spec);
}

const placesSeen = (rig: Rig): PlaceName[] => rig.places.seen.map((seen) => seen.place);

/** What the app asked for and what it kept, for a download that ended well. */
function expectInstalled(rig: Rig): void {
  expect(rig.fs.bytes.get(rig.path)?.equals(rig.content), "the file that landed is the model").toBe(
    true,
  );
  expect(JSON.parse(rig.fs.texts.get(rig.marker) ?? "null")).toEqual({
    bytes: rig.spec.bytes,
    sha256: rig.spec.sha256,
  });
  expect(rig.fs.parts(), "no part file is left behind").toEqual([]);
  // Whatever was moved into place was the model, and was moved once.
  expect(rig.fs.moved).toEqual([{ to: rig.path, size: rig.spec.bytes, sha256: rig.spec.sha256 }]);
  // Only this entry's file at this entry's revision was ever asked for, and nothing left the machine.
  for (const seen of rig.places.seen) {
    expect(seen.file).toBe(rig.entry.file);
    if (seen.place !== "other") expect(seen.revision).toBe(rig.entry.revision);
  }
  expect(rig.places.refused).toEqual([]);
}

/** What the app asked for and kept when nothing could be installed. */
function expectNothingInstalled(rig: Rig): void {
  expect(rig.fs.bytes.has(rig.path)).toBe(false);
  expect(rig.fs.texts.has(rig.marker)).toBe(false);
  expect(rig.fs.parts()).toEqual([]);
  expect(rig.fs.moved).toEqual([]);
}

const finishedFact = () => readFacts("model_download").find((f) => f.event === "download_finished");

beforeEach(() => {
  localStorage.clear();
  __resetExportFlags();
  __setDownloadPolicy(SINGLE_ATTEMPT);
});
afterEach(async () => {
  __setDownloadPolicy(PATIENT_DOWNLOAD);
  clearModelDownload();
  setModelDownloadFailure(null);
  __resetExportFlags();
  localStorage.clear();
  await Promise.all(rigs.splice(0).map((rig) => rig.places.stop()));
});
afterAll(() => {
  expect(serversListening(), "no server of this file is left listening").toBe(0);
});

describe("what these tests stand in for", () => {
  it("is the app's own policy without the waiting: four attempts, which ask the first place, the second, the first and the second", () => {
    expect(PATIENT_DOWNLOAD.backoffMs).toHaveLength(FOUR_ATTEMPTS.backoffMs.length);
    expect(FOUR_ATTEMPTS.backoffMs).toHaveLength(3);
    expect(PATIENT_DOWNLOAD.backoffMs.every((ms) => ms > 0)).toBe(true);
    expect(Number.isFinite(PATIENT_DOWNLOAD.stallMs)).toBe(true);
  });
});

describe("the loopback server itself (a test of a test double: it must really do what the tests below claim)", () => {
  /** The whole of a body, or what came before it broke: negative. */
  async function readAll(answer: Response): Promise<{ bytes: Buffer; broke: boolean }> {
    const chunks: Buffer[] = [];
    const reader = answer.body!.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return { bytes: Buffer.concat(chunks), broke: false };
        chunks.push(Buffer.from(value));
      }
    } catch {
      return { bytes: Buffer.concat(chunks), broke: true };
    }
  }

  it("answers a whole file with 200 and a Range with the exact tail as 206, and the app's request reaches it as written", async () => {
    const rig = await rigFor(KEYS[0]);
    const all = await readAll(await rig.fetchImpl(primaryUrl(rig.entry)));
    expect(all.bytes.equals(rig.content)).toBe(true);
    const tail = await readAll(
      await rig.fetchImpl(primaryUrl(rig.entry), { headers: { Range: "bytes=1000-" } }),
    );
    expect(tail.bytes.equals(rig.content.subarray(1000))).toBe(true);
    expect(rig.places.seen.map((s) => [s.status, s.range, s.sent])).toEqual([
      [200, null, rig.content.length],
      [206, "bytes=1000-", rig.content.length - 1000],
    ]);
  });

  it("really cuts a body short, ignores Range, sends wrong bytes of the right length, mixes files up, and refuses an address it cannot serve", async () => {
    const rig = await rigFor(KEYS[0]);
    const other = MODEL_MANIFEST[KEYS[KEYS.length - 1]].file;
    rig.places.script("first", { cut: 1000, then: "close" }, "ignore-range", "wrong", {
      instead: other,
    });
    const ask = async (init?: RequestInit) =>
      readAll(await rig.fetchImpl(primaryUrl(rig.entry), init));

    const cut = await ask();
    expect(cut.broke, "closed early: the read ends in an error").toBe(true);
    expect(cut.bytes.length).toBeLessThanOrEqual(1000);
    await vi.waitFor(() => expect(rig.places.seen[0]).toMatchObject({ sent: 1000, end: "cut" }));

    const ignored = await ask({ headers: { Range: "bytes=5-" } });
    expect(ignored.bytes.equals(rig.content)).toBe(true);
    expect(rig.places.seen[1]).toMatchObject({ status: 200, range: "bytes=5-" });

    const wrong = await ask();
    expect(wrong.bytes.length).toBe(rig.content.length);
    expect(wrong.bytes.equals(corrupted(rig.content))).toBe(true);
    expect(wrong.bytes.equals(rig.content)).toBe(false);

    const mixed = await ask();
    expect(mixed.bytes.equals(contentOf(KEYS[KEYS.length - 1]))).toBe(true);

    // An address that is not https is refused, never fetched; any https address is pointed at this server (which holds
    // no such file and says 404), so that nothing in these tests can leave the machine.
    await expect(rig.fetchImpl("http://example.org/ggml.bin")).rejects.toThrow();
    expect(rig.places.refused).toEqual(["http://example.org/ggml.bin"]);
    const unknown = await rig.fetchImpl("https://example.org/ggml.bin");
    expect(unknown.status).toBe(404);
    expect(rig.places.seen.at(-1)).toMatchObject({ place: "other", file: "ggml.bin", status: 404 });
  });
});

describe.each(KEYS)("%s: the app's download over a socket", (key) => {
  it("installs the file, its marker and the right bytes from the first place, once, and a second call fetches nothing", async () => {
    const rig = await rigFor(key);
    const result = await install(rig, SINGLE_ATTEMPT);
    expect(result).toEqual({ path: rig.path, downloaded: true });
    expectInstalled(rig);
    expect(rig.places.asked).toEqual([primaryUrl(rig.entry)]);
    expect(rig.places.seen).toMatchObject([{ place: "first", status: 200, range: null }]);
    expect(finishedFact()).toMatchObject({
      source: "primary",
      attempts: 1,
      bytes: rig.content.length,
    });
    expect(await install(rig, SINGLE_ATTEMPT)).toEqual({ path: rig.path, downloaded: false });
    expect(rig.places.asked, "an installed model is not asked for again").toHaveLength(1);
  });

  describe("an answer that is cut short", () => {
    it("is resumed from the same place with a Range request that starts where the disk ends, and completes with the right SHA-256", async () => {
      const rig = await rigFor(key, { mirrors: false });
      const cut = Math.floor(rig.content.length * 0.4);
      rig.places.script("first", { cut, then: "close" });
      await install(rig, FOUR_ATTEMPTS);
      const [first, second] = rig.places.seen;
      expect(first).toMatchObject({ place: "first", range: null, end: "cut", sent: cut });
      const have = rig.partAtAsk[1];
      expect(have, "what the first answer left on disk").toBeGreaterThan(0);
      expect(have).toBeLessThanOrEqual(cut);
      expect(second).toMatchObject({
        place: "first",
        status: 206,
        range: `bytes=${have}-`,
        sent: rig.content.length - have,
      });
      expect(rig.places.asked).toEqual([primaryUrl(rig.entry), primaryUrl(rig.entry)]);
      expectInstalled(rig);
    });

    it("is resumed at the second place from exactly what the disk holds, and the bytes of the two places make the model", async () => {
      const rig = await rigFor(key);
      const cut = Math.floor(rig.content.length * 0.4);
      rig.places.script("first", { cut, then: "close" });
      await install(rig, FOUR_ATTEMPTS);
      const have = rig.partAtAsk[1];
      expect(have).toBeGreaterThan(0);
      expect(have).toBeLessThanOrEqual(cut);
      expect(rig.places.asked).toEqual([primaryUrl(rig.entry), secondPlaces(rig.entry)[0]]);
      expect(rig.places.seen.map((s) => [s.place, s.status, s.range])).toEqual([
        ["first", 200, null],
        ["second", 206, `bytes=${have}-`],
      ]);
      expect(rig.places.seen[1].sent).toBe(rig.content.length - have);
      expectInstalled(rig);
      expect(finishedFact()).toMatchObject({ source: "extra_1", attempts: 2 });
    });
  });

  describe("an answer of the right length with the wrong bytes", () => {
    it("is never installed, its part is gone, and the next place is asked from zero", async () => {
      const rig = await rigFor(key);
      rig.places.script("first", "wrong");
      await install(rig, FOUR_ATTEMPTS);
      expect(rig.places.seen.map((s) => [s.place, s.status, s.range])).toEqual([
        ["first", 200, null],
        ["second", 200, null],
      ]);
      expectInstalled(rig);
      expect(finishedFact()).toMatchObject({ source: "extra_1", attempts: 2 });
    });

    it("leaves nothing on the disk and says so plainly when every place sends wrong bytes, and asks no place twice", async () => {
      const rig = await rigFor(key);
      rig.places.script("first", "wrong").script("second", "wrong");
      const failure = await install(rig, FOUR_ATTEMPTS).then(
        () => "installed",
        (e: Error) => e.message,
      );
      expect(failure).toMatch(/checksum/);
      expect(failure).toMatch(/after 2 attempts/);
      expect(failure).not.toMatch(/127\.0\.0\.1|C:\/|artdaddy|huggingface/);
      expectNothingInstalled(rig);
      expect(placesSeen(rig), "a place that sent wrong bytes is not asked again").toEqual([
        "first",
        "second",
      ]);
      expect(useModelDownload.getState().failure).toBe("damaged");
    });
  });

  describe("a part left by an earlier attempt", () => {
    it("is continued from its length: only the tail is fetched, and the file is the model", async () => {
      const rig = await rigFor(key);
      const have = 300_007;
      rig.fs.bytes.set(rig.part, Buffer.from(rig.content.subarray(0, have)));
      await install(rig, SINGLE_ATTEMPT);
      expect(rig.places.seen).toMatchObject([
        { place: "first", status: 206, range: `bytes=${have}-`, sent: rig.content.length - have },
      ]);
      expectInstalled(rig);
      expect(finishedFact()).toMatchObject({ bytes: rig.content.length - have });
    });

    it("that is not a prefix of the model is never installed: it fails the checksum and the next place starts from zero", async () => {
      const rig = await rigFor(key);
      const have = 300_007;
      rig.fs.bytes.set(rig.part, Buffer.from(corrupted(rig.content).subarray(0, have)));
      await install(rig, FOUR_ATTEMPTS);
      expect(rig.places.seen.map((s) => [s.place, s.status, s.range])).toEqual([
        ["first", 206, `bytes=${have}-`],
        ["second", 200, null],
      ]);
      expectInstalled(rig);
    });
  });

  describe("a first place that fails", () => {
    const FAILURES: ReadonlyArray<[string, Turn, DownloadPolicy]> = [
      ["answers 500", { status: 500 }, FOUR_ATTEMPTS],
      ["answers 503", { status: 503 }, FOUR_ATTEMPTS],
      ["answers 404 (and is not asked again)", { status: 404 }, FOUR_ATTEMPTS],
      ["resets the connection", "reset", FOUR_ATTEMPTS],
      ["never answers", "silent", FOUR_QUICK_STALLS],
      ["goes quiet in the middle of the file", { cut: 2000, then: "stall" }, FOUR_QUICK_STALLS],
    ];

    it.each(FAILURES)(
      "%s: the second place is asked next and installs",
      async (_what, turn, policy) => {
        const rig = await rigFor(key);
        rig.places.script("first", turn);
        await install(rig, policy);
        expect(rig.places.asked).toEqual([primaryUrl(rig.entry), secondPlaces(rig.entry)[0]]);
        expect(placesSeen(rig)).toEqual(["first", "second"]);
        expectInstalled(rig);
        expect(finishedFact()).toMatchObject({ source: "extra_1", attempts: 2 });
      },
    );

    it("leaves nothing installed when the second place fails too, and the four attempts alternate between the two places", async () => {
      const rig = await rigFor(key);
      const down: Turn[] = [{ status: 500 }, { status: 500 }];
      rig.places.script("first", ...down).script("second", ...down);
      const failure = await install(rig, FOUR_ATTEMPTS).then(
        () => "installed",
        (e: Error) => e.message,
      );
      expect(failure).toMatch(/HTTP 500 \(after 4 attempts\)/);
      expect(rig.places.asked).toEqual([
        primaryUrl(rig.entry),
        secondPlaces(rig.entry)[0],
        primaryUrl(rig.entry),
        secondPlaces(rig.entry)[0],
      ]);
      expectNothingInstalled(rig);
      expect(useModelDownload.getState().failure).toBe("server_busy");
    });

    it("is asked first again the next time the app wants the model: no place is remembered as bad", async () => {
      const rig = await rigFor(key);
      rig.places.script("first", "wrong").script("second", "wrong");
      await expect(install(rig, FOUR_ATTEMPTS)).rejects.toThrow(/checksum/);
      const before = rig.places.asked.length;
      await install(rig, SINGLE_ATTEMPT);
      expect(rig.places.asked.slice(before)).toEqual([primaryUrl(rig.entry)]);
      expectInstalled(rig);
    });
  });

  describe("a place that ignores Range", () => {
    it("is handled as it always was: the part is started over and the file is still the model", async () => {
      const rig = await rigFor(key);
      const have = 300_007;
      rig.fs.bytes.set(rig.part, Buffer.from(rig.content.subarray(0, have)));
      rig.places.script("first", "ignore-range");
      await install(rig, SINGLE_ATTEMPT);
      expect(rig.places.seen).toMatchObject([
        { place: "first", status: 200, range: `bytes=${have}-`, sent: rig.content.length },
      ]);
      expectInstalled(rig);
    });

    it("is handled the same at the second place, after a first place that was cut short", async () => {
      const rig = await rigFor(key);
      rig.places.script("first", { cut: 200_000, then: "close" }).script("second", "ignore-range");
      await install(rig, FOUR_ATTEMPTS);
      expect(rig.places.seen[1]).toMatchObject({
        place: "second",
        status: 200,
        sent: rig.content.length,
      });
      expect(rig.partAtAsk[1]).toBeGreaterThan(0);
      expectInstalled(rig);
    });
  });

  describe("a remote answer that names a place of its own", () => {
    const answer = (sources: unknown): Promise<void> =>
      refreshExportFlags({
        force: true,
        signedIn: async () => true,
        fetcher: async () =>
          new Response(JSON.stringify({ v: 1, flags: {}, speech_model_sources: sources }), {
            status: 200,
          }),
      });

    it("is asked after both compiled places, and what it sends is checked like everything else", async () => {
      const rig = await rigFor(key);
      const remote = `https://cdn.huggingface.co/some-org/some-copy/resolve/main/${rig.entry.file}`;
      await answer([remote]);
      rig.places.script("first", { status: 500 }).script("second", { status: 500 });
      await install(rig, FOUR_ATTEMPTS);
      expect(rig.places.asked).toEqual([primaryUrl(rig.entry), secondPlaces(rig.entry)[0], remote]);
      expect(placesSeen(rig)).toEqual(["first", "second", "other"]);
      expectInstalled(rig);
      expect(finishedFact()).toMatchObject({ source: "extra_2", attempts: 3 });
    });

    it("never installs wrong bytes from it either, even when it is the last place that is asked", async () => {
      const rig = await rigFor(key);
      const remote = `https://cdn.huggingface.co/some-org/some-copy/resolve/main/${rig.entry.file}`;
      await answer([remote]);
      const down: Turn[] = [{ status: 500 }, { status: 500 }];
      rig.places
        .script("first", ...down)
        .script("second", ...down)
        .script("other", "wrong");
      await expect(install(rig, FOUR_ATTEMPTS)).rejects.toThrow();
      expect(placesSeen(rig)).toContain("other");
      expectNothingInstalled(rig);
    });
  });
});

// The manifest has more than one file now, so a place holds more than one. Whatever a place sends for an address, the
// bytes are checked against the file the app is installing: another file's bytes never pass for it.
describe.each(KEYS)("%s: a place that answers with ANOTHER file's bytes", (key) => {
  it.each(KEYS.filter((other) => other !== key))(
    "(%s's bytes at this file's address) is refused, and the next place installs the right file",
    async (other) => {
      const rig = await rigFor(key);
      rig.places.script("first", { instead: MODEL_MANIFEST[other].file });
      await install(rig, FOUR_ATTEMPTS);
      expect(placesSeen(rig)).toEqual(["first", "second"]);
      expectInstalled(rig);
      expect(finishedFact()).toMatchObject({ source: "extra_1", attempts: 2 });
    },
  );
});

// One disk, every file: each lands at its own path with its own bytes, whatever the order they are installed in.
describe("every file of the manifest, installed side by side", () => {
  it.each([KEYS, [...KEYS].reverse()])(
    "on one disk, each at its own path with its own bytes (order %#)",
    async (...order) => {
      const fs = new MemoryModelFs();
      const done: Rig[] = [];
      for (const k of order) {
        const rig = await rigFor(k, { fs });
        await install(rig, SINGLE_ATTEMPT);
        done.push(rig);
      }
      for (const rig of done) {
        expect(fs.bytes.get(rig.path)?.equals(rig.content), rig.entry.file).toBe(true);
        expect(JSON.parse(fs.texts.get(rig.marker) ?? "null")).toEqual({
          bytes: rig.spec.bytes,
          sha256: rig.spec.sha256,
        });
      }
      expect(new Set(done.map((rig) => rig.path)).size).toBe(KEYS.length);
      expect(fs.moved.map((m) => m.sha256).sort()).toEqual(done.map((r) => r.spec.sha256).sort());
      expect(fs.parts()).toEqual([]);
    },
  );
});
