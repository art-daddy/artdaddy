import { describe, expect, it } from "vitest";
import { unresolvedMediaBlockers } from "./render";
import type { Timeline } from "./model";
import type { LibraryClip } from "../tools/store";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const store = (clips: Partial<LibraryClip>[]) => ({
  listClips: async () => clips as LibraryClip[],
});

const timeline = (refs: string[]): Timeline =>
  ({
    canvas: { width: 1080, height: 1920, fps: 30 },
    tracks: [
      {
        id: "v1",
        kind: "video",
        z: 0,
        clips: refs.map((r, i) => ({
          id: `c${i}`,
          media_ref: r,
          kind: "video",
          timeline_in: i * 30,
          timeline_out: i * 30 + 30,
        })),
      },
    ],
  }) as Any;

describe("unresolved media blockers", () => {
  it("names a clip whose media is still generating", async () => {
    const out = await unresolvedMediaBlockers(
      store([{ id: "media_gen_a", status: "generating" }]),
      timeline(["media_gen_a"]),
    );
    expect(out).toEqual([{ clip_id: "c0", media_ref: "media_gen_a", status: "generating" }]);
  });

  it("names a clip whose generation failed, carrying the reason", async () => {
    const out = await unresolvedMediaBlockers(
      store([{ id: "media_gen_a", status: "failed", error: "content filter" }]),
      timeline(["media_gen_a"]),
    );
    expect(out).toEqual([
      { clip_id: "c0", media_ref: "media_gen_a", status: "failed", error: "content filter" },
    ]);
  });

  // The failure direction that matters: a false positive would refuse every ordinary export.
  it("does not block a timeline of ready media", async () => {
    const out = await unresolvedMediaBlockers(
      store([{ id: "media_abc" }, { id: "media_def" }]),
      timeline(["media_abc", "media_def"]),
    );
    expect(out).toEqual([]);
  });

  it("ignores a placeholder that is NOT on the timeline", async () => {
    const out = await unresolvedMediaBlockers(
      store([{ id: "media_gen_a", status: "generating" }, { id: "media_abc" }]),
      timeline(["media_abc"]),
    );
    expect(out).toEqual([]);
  });

  it("reports every blocked clip, not just the first", async () => {
    const out = await unresolvedMediaBlockers(
      store([
        { id: "media_gen_a", status: "generating" },
        { id: "media_gen_b", status: "failed", error: "nope" },
      ]),
      timeline(["media_gen_a", "media_abc", "media_gen_b"]),
    );
    expect(out.map((u) => u.clip_id)).toEqual(["c0", "c2"]);
  });

  it("reports the same placeholder once per clip that uses it", async () => {
    const out = await unresolvedMediaBlockers(
      store([{ id: "media_gen_a", status: "generating" }]),
      timeline(["media_gen_a", "media_gen_a"]),
    );
    expect(out).toHaveLength(2);
  });

  it("treats an unknown status as ready rather than blocking on it", async () => {
    const out = await unresolvedMediaBlockers(
      store([{ id: "media_abc", status: "something_else" }]),
      timeline(["media_abc"]),
    );
    expect(out).toEqual([]);
  });
});
