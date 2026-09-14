// Recording: the container decision, and how a finished take enters the library.
//
// The container is the load-bearing choice. Our preview demuxes with mp4box, which parses MP4 and
// nothing else, so a WebM recording plays everywhere EXCEPT the editor that made it — a failure
// that looks like a broken clip rather than a wrong format. These pin that a recording is only
// ever admitted as MP4, whichever way it was captured.
import { describe, expect, it, vi } from "vitest";

import { ProjectStoreAccess, joinPath, type DirEntry, type FsLike } from "../tools/store";
import type { CommandRunner } from "../tools/command";
import {
  elapsedLabel,
  extensionForMime,
  isPlayableContainer,
  listCaptureDevices,
  pickRecordingMime,
  recordingName,
} from "./recorder";
import { saveRecording } from "./recordSave";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const DIR = "/proj";

class MockFs implements FsLike {
  files = new Map<string, string>();
  bytes = new Map<string, Uint8Array>();
  async exists(p: string): Promise<boolean> {
    const n = joinPath(p);
    if (this.files.has(n) || this.bytes.has(n)) return true;
    const prefix = `${n.replace(/\/+$/, "")}/`;
    for (const k of [...this.files.keys(), ...this.bytes.keys()])
      if (k.startsWith(prefix)) return true;
    return false;
  }
  async readTextFile(p: string): Promise<string> {
    const v = this.files.get(joinPath(p));
    if (v === undefined) throw new Error("ENOENT");
    return v;
  }
  async writeTextFile(p: string, c: string): Promise<void> {
    this.files.set(joinPath(p), c);
  }
  async readBytes(p: string): Promise<Uint8Array> {
    const v = this.bytes.get(joinPath(p));
    if (v === undefined) throw new Error("ENOENT");
    return v;
  }
  async writeBytes(p: string, b: Uint8Array): Promise<void> {
    this.bytes.set(joinPath(p), b);
  }
  async readDir(p: string): Promise<DirEntry[]> {
    const base = joinPath(p).replace(/\/+$/, "");
    const seen = new Map<string, boolean>();
    for (const k of [...this.files.keys(), ...this.bytes.keys()]) {
      if (!k.startsWith(`${base}/`)) continue;
      const rest = k.slice(base.length + 1);
      const slash = rest.indexOf("/");
      if (slash === -1) seen.set(rest, false);
      else seen.set(rest.slice(0, slash), true);
    }
    return [...seen].map(([name, isDirectory]) => ({ name, isDirectory }));
  }
  async mkdir(): Promise<void> {}
  async remove(p: string): Promise<void> {
    const n = joinPath(p);
    this.files.delete(n);
    this.bytes.delete(n);
  }
}

describe("pickRecordingMime", () => {
  it("prefers MP4, because that is the only container the preview can demux", () => {
    const mime = pickRecordingMime(() => true);
    expect(mime).toMatch(/^video\/mp4/);
    expect(isPlayableContainer(mime!)).toBe(true);
  });

  it("falls back to WebM rather than refusing to record", () => {
    const mime = pickRecordingMime((t) => t.startsWith("video/webm"));
    expect(mime).toMatch(/^video\/webm/);
    expect(extensionForMime(mime!)).toBe("webm");
  });

  it("answers null when nothing is supported, instead of a type that will throw", () => {
    expect(pickRecordingMime(() => false)).toBeNull();
  });
});

describe("recordingName", () => {
  it("is sortable, MP4, and free of characters a filesystem rejects", () => {
    const n = recordingName(new Date(2026, 8, 1, 9, 5, 3));
    expect(n).toBe("recording-2026-09-01-090503.mp4");
    expect(n).not.toMatch(/[:\\/*?"<>|]/);
  });
});

describe("elapsedLabel", () => {
  it("counts in mm:ss and only grows an hours field when there are hours", () => {
    expect(elapsedLabel(0)).toBe("0:00");
    expect(elapsedLabel(9_000)).toBe("0:09");
    expect(elapsedLabel(65_000)).toBe("1:05");
    expect(elapsedLabel(3_725_000)).toBe("1:02:05");
  });
});

describe("listCaptureDevices", () => {
  it("labels a device the browser has not named yet, so the picker is never blank", async () => {
    // Labels are empty until permission has been granted at least once — a browser privacy rule.
    const media = {
      enumerateDevices: async () =>
        [
          { kind: "videoinput", deviceId: "c1", label: "" },
          { kind: "audioinput", deviceId: "m1", label: "Headset" },
          { kind: "audiooutput", deviceId: "s1", label: "Speakers" },
        ] as Any,
    };
    const { cameras, mics } = await listCaptureDevices(media as Any);
    expect(cameras).toEqual([{ deviceId: "c1", label: "videoinput 1" }]);
    expect(mics).toEqual([{ deviceId: "m1", label: "Headset" }]);
  });
});

function ctxWith(fs: MockFs, run: CommandRunner["run"]): Any {
  return { store: new ProjectStoreAccess(DIR, fs), runner: { run } };
}

const catalogue = async (fs: MockFs): Promise<Any> =>
  JSON.parse(await fs.readTextFile(joinPath(DIR, "internals/library.json")));

describe("saveRecording", () => {
  it("registers an MP4 capture as-is, with no re-encode", async () => {
    const fs = new MockFs();
    const run = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    const r = await saveRecording(
      ctxWith(fs, run),
      new Uint8Array([1, 2, 3, 4]),
      "video/mp4",
      new Date(2026, 8, 1, 12, 0, 0),
    );

    expect(run).not.toHaveBeenCalled(); // already playable — transcoding would be pure cost
    expect(r.transcoded).toBe(false);
    expect(r.filename).toBe("recording-2026-09-01-120000.mp4");
    const row = (await catalogue(fs)).clips.find((c: Any) => c.id === r.media_ref);
    expect(row.kind).toBe("video");
    expect(row.path).toMatch(/^library\//);
  });

  it("converts a WebM capture before it enters the library", async () => {
    const fs = new MockFs();
    // The real ffmpeg writes the output; the fake must too, or "did it convert" is untested.
    const run = vi.fn(async (_p: string, args: string[]) => {
      await fs.writeBytes(joinPath(args[args.length - 1]), new Uint8Array([9, 9, 9]));
      return { code: 0, stdout: "", stderr: "" };
    });
    const r = await saveRecording(ctxWith(fs, run), new Uint8Array([1, 2]), "video/webm");

    expect(r.transcoded).toBe(true);
    const args = run.mock.calls[0][1] as string[];
    expect(args).toContain("libx264");
    expect(args[args.length - 1]).toMatch(/\.mp4$/);
    // The library must hold the MP4, never the WebM the browser produced.
    const row = (await catalogue(fs)).clips.find((c: Any) => c.id === r.media_ref);
    expect(row.filename).toMatch(/\.mp4$/);
    expect(await fs.readDir(joinPath(DIR, "internals/cache/rec")).catch(() => [])).toEqual([]);
  });

  it("leaves NOTHING behind when the conversion fails", async () => {
    const fs = new MockFs();
    const run = vi.fn(async () => ({ code: 1, stdout: "", stderr: "x\nno encoder" }));
    await expect(
      saveRecording(ctxWith(fs, run), new Uint8Array([1, 2]), "video/webm"),
    ).rejects.toThrow(/no encoder/);

    // A catalog row pointing at a file that was never written is worse than the error.
    expect(fs.files.has(joinPath(DIR, "internals/library.json"))).toBe(false);
    expect(await fs.readDir(joinPath(DIR, "internals/cache/rec")).catch(() => [])).toEqual([]);
  });

  it("refuses an empty capture rather than registering a zero-byte clip", async () => {
    const fs = new MockFs();
    const run = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    await expect(saveRecording(ctxWith(fs, run), new Uint8Array(), "video/mp4")).rejects.toThrow(
      /empty/i,
    );
    expect(run).not.toHaveBeenCalled();
  });
});
