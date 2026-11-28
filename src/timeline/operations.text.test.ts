// Titles and captions as the agent places and restyles them (add_text_clips, update_text), and media
// dropped onto a locked lane. Mutation testing (26 Nov) showed these lines run under the existing tests
// while a restyle that wiped the words, or a turn set to nothing, would have gone unnoticed. Each case
// is what a person would see on the frame, or what the agent is told about where the titles went.
import { describe, expect, it } from "vitest";

import { findClip } from "./helpers";
import type { Timeline } from "./model";
import { addTextClips, placeClips, updateTextClips } from "./operations";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const track = (id: string, kind: string, clips: Any[], over: Any = {}): Any => ({
  id,
  kind,
  z: 0,
  clips,
  ...over,
});
const tl = (...tracks: Any[]): Timeline =>
  ({ units: "frames", canvas: { width: 1920, height: 1080, fps: 30 }, tracks }) as Timeline;
const clipOf = (t: Timeline, id: string): Any => {
  const found = findClip(t, id);
  if (!found) throw new Error(`no clip ${id}`);
  return found[1];
};

describe("restyling and rewording a title (update_text)", () => {
  const titled = (): Timeline =>
    tl(
      track("t1", "text", [
        {
          id: "t",
          kind: "text",
          timeline_in: 0,
          timeline_out: 60,
          content: [{ text: "Hello" }],
          style: { size: "m", color: "#ffffff" },
          rotate: 15,
        },
      ]),
      track("v1", "video", [
        { id: "v", kind: "video", media_ref: "v.mp4", timeline_in: 0, timeline_out: 60 },
      ]),
    );

  it("a new style keeps the words, the turn and the parts of the style it did not name", () => {
    const t = titled();
    expect(updateTextClips(t, ["t"], { style: { size: "xl" } })).toEqual({
      updated: [{ clip_id: "t", track_id: "t1" }],
      count: 1,
    });
    const c = clipOf(t, "t");
    expect(c.content).toEqual([{ text: "Hello" }]);
    expect(c.rotate).toBe(15);
    expect(c.style).toEqual({ size: "xl", color: "#ffffff" });
  });

  it("new words keep the style", () => {
    const t = titled();
    updateTextClips(t, ["t"], { content: "Bye" });
    expect(clipOf(t, "t").content).toEqual([{ text: "Bye" }]);
    expect(clipOf(t, "t").style).toEqual({ size: "m", color: "#ffffff" });
  });

  it("a turn is set by a number and taken away by null", () => {
    const t = titled();
    updateTextClips(t, ["t"], { rotate: 30 });
    expect(clipOf(t, "t").rotate).toBe(30);
    updateTextClips(t, ["t"], { rotate: null });
    expect("rotate" in clipOf(t, "t")).toBe(false);
  });

  it("a style of null takes the style away", () => {
    const t = titled();
    updateTextClips(t, ["t"], { style: null });
    expect("style" in clipOf(t, "t")).toBe(false);
    expect(clipOf(t, "t").content).toEqual([{ text: "Hello" }]);
  });

  it.each([
    ["a word", "big"],
    ["a list", ["big"]],
  ])("refuses a style given as %s, changing nothing", (_what, style) => {
    const t = titled();
    const before = JSON.stringify(t);
    expect(() => updateTextClips(t, ["t"], { style })).toThrow(/style must be an object/);
    expect(JSON.stringify(t)).toBe(before);
  });

  it("refuses a clip that is not a title", () => {
    expect(() => updateTextClips(titled(), ["v"], { content: "x" })).toThrow(
      /only applies to text/,
    );
  });
});

describe("placing titles (add_text_clips)", () => {
  const empty = (): Timeline => tl(track("v1", "video", []));
  const textTracks = (t: Timeline) => t.tracks.filter((x) => x.kind === "text");

  it("titles that name no track and overlap go on separate tracks, and the agent is told which went where", () => {
    const t = empty();
    const r = addTextClips(t, [
      { content: "C", timeline_in: 40, timeline_out: 60 },
      { content: "A", timeline_in: 0, timeline_out: 30 },
      { content: "B", timeline_in: 10, timeline_out: 40 },
    ]);
    expect(textTracks(t)).toHaveLength(2);
    const [first, second] = textTracks(t);
    const words = (x: Any) => (x.clips ?? []).map((c: Any) => c.content[0].text).sort();
    expect(words(first)).toEqual(["A", "C"]);
    expect(words(second)).toEqual(["B"]);
    expect(String(r.notes)).toContain(`'${first.id}' (entries 0, 1)`);
    expect(String(r.notes)).toContain(`'${second.id}' (entry 2)`);
  });

  it("titles that name no track and follow one another share one track, with nothing to explain", () => {
    const t = empty();
    const r = addTextClips(t, [
      { content: "A", timeline_in: 0, timeline_out: 30 },
      { content: "B", timeline_in: 30, timeline_out: 60 },
    ]);
    expect(textTracks(t)).toHaveLength(1);
    expect(r.notes).toBeUndefined();
    expect(r.count).toBe(2);
  });

  it("two titles that overlap on the track they both name are refused, naming both", () => {
    expect(() =>
      addTextClips(empty(), [
        { content: "A", timeline_in: 0, timeline_out: 30, track_id: "t9" },
        { content: "B", timeline_in: 20, timeline_out: 50, track_id: "t9" },
      ]),
    ).toThrow(/entries\[1\] \(frames 20-50\) overlaps entries\[0\]/);
  });

  it("a title with nothing to show is refused, and one sent with 'text' is told the field is 'content'", () => {
    expect(() => addTextClips(empty(), [{ timeline_in: 0, timeline_out: 30 }])).toThrow(
      /entries\[0\] needs 'content'/,
    );
    expect(() => addTextClips(empty(), [{ text: "Hi", timeline_in: 0, timeline_out: 30 }])).toThrow(
      /got 'text'/,
    );
  });

  it("keeps the look it was given and adds nothing it was not", () => {
    const t = empty();
    const r = addTextClips(t, [
      {
        content: "Hi",
        timeline_in: 0,
        timeline_out: 30,
        style: { size: "l" },
        rotate: 10,
        animation: null,
        transform: undefined,
      },
    ]);
    const id = (r.created as Array<{ clip_id: string }>)[0].clip_id;
    const c = clipOf(t, id);
    expect(c.content).toEqual([{ text: "Hi" }]);
    expect(c.style).toEqual({ size: "l" });
    expect(c.rotate).toBe(10);
    expect("animation" in c).toBe(false);
    expect("transform" in c).toBe(false);
  });
});

describe("media dropped onto a lane", () => {
  const spec = (trackId: string): Any => ({
    source: "b.mp4",
    kind: "video",
    tin: 60,
    tout: 120,
    sIn: 0,
    sOut: 60,
    hasAudio: false,
    trackId,
  });
  const lanes = (): Timeline =>
    tl(
      track(
        "v1",
        "video",
        [{ id: "a", kind: "video", media_ref: "a.mp4", timeline_in: 0, timeline_out: 60 }],
        { locked: true },
      ),
      track("v2", "video", [], { z: 1 }),
    );

  it("onto a locked lane is refused and adds nothing", () => {
    const t = lanes();
    const before = JSON.stringify(t);
    expect(() => placeClips(t, [spec("v1")])).toThrow(/locked/);
    expect(JSON.stringify(t)).toBe(before);
  });

  it("onto an unlocked lane beside a locked one lands, with nothing to explain", () => {
    const t = lanes();
    const r = placeClips(t, [spec("v2")]);
    expect(r.count).toBe(1);
    expect(r.notes).toBeUndefined();
    expect(t.tracks[1].clips?.map((c) => [c.timeline_in, c.timeline_out])).toEqual([[60, 120]]);
  });
});
