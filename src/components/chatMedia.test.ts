import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { attachmentKind, attachmentsFromUploads, mediaKindFromName } from "./chatMedia";

describe("attachmentKind", () => {
  it("maps by mime prefix, defaulting to image", () => {
    expect(attachmentKind("video/mp4")).toBe("video");
    expect(attachmentKind("audio/mpeg")).toBe("audio");
    expect(attachmentKind("image/png")).toBe("image");
    expect(attachmentKind("application/pdf")).toBe("image");
  });
});

describe("mediaKindFromName", () => {
  it("maps by extension (case-insensitive), defaulting to image", () => {
    expect(mediaKindFromName("a.MP4")).toBe("video");
    expect(mediaKindFromName("b.wav")).toBe("audio");
    expect(mediaKindFromName("c.png")).toBe("image");
    expect(mediaKindFromName("noext")).toBe("image");
  });
});

// The one mapping from an import's result to what a message carries: the composer's attach and the start
// screen's footage both go through it, so they cannot disagree.
describe("attachmentsFromUploads", () => {
  it("carries the portable library ref and the file's own name, never an absolute path", () => {
    expect(
      attachmentsFromUploads([
        { rel: "library/media_a1.mp4", name: "beach.mp4" },
        { rel: "D:/shoot/take 2.mov", name: "take 2.mov" },
        { rel: "library/media_b2.mp3", name: "song.mp3" },
        { rel: "library/media_c3.png", name: "cover.png" },
      ]),
    ).toEqual([
      { path: "library/media_a1.mp4", kind: "video", caption: "beach.mp4" },
      { path: "D:/shoot/take 2.mov", kind: "video", caption: "take 2.mov" },
      { path: "library/media_b2.mp3", kind: "audio", caption: "song.mp3" },
      { path: "library/media_c3.png", kind: "image", caption: "cover.png" },
    ]);
  });

  it("imports a subtitle but does not attach it: there is nothing for a model to look at", () => {
    expect(
      attachmentsFromUploads([
        { rel: "library/media_s1.srt", name: "captions.srt" },
        { rel: "library/media_s2.vtt", name: "captions.vtt" },
        { rel: "library/media_a1.mp4", name: "a.mp4" },
      ]),
    ).toEqual([{ path: "library/media_a1.mp4", kind: "video", caption: "a.mp4" }]);
    expect(attachmentsFromUploads([])).toEqual([]);
  });

  it("property: keeps the order, never invents or duplicates one, and drops only subtitles", () => {
    const ext = fc.constantFrom("mp4", "mov", "mp3", "wav", "png", "jpg", "srt", "vtt");
    const upload = fc
      .record({ stem: fc.stringMatching(/^[a-z0-9_]{1,8}$/), ext, n: fc.nat(99) })
      .map(({ stem, ext: e, n }) => ({ rel: `library/${stem}_${n}.${e}`, name: `${stem}.${e}` }));
    fc.assert(
      fc.property(fc.array(upload, { maxLength: 12 }), (uploads) => {
        const out = attachmentsFromUploads(uploads);
        const kept = uploads.filter((u) => !/\.(srt|vtt)$/.test(u.name));
        expect(out.map((a) => a.path)).toEqual(kept.map((u) => u.rel));
        expect(out.map((a) => a.caption)).toEqual(kept.map((u) => u.name));
        for (const a of out) expect(["video", "audio", "image"]).toContain(a.kind);
      }),
    );
  });
});
