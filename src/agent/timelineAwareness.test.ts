// UJ-028: when to tell the model its picture of the timeline is stale. The rules are about what
// the model has SEEN, so each case is phrased as a sequence of things the model and the user do.
import { describe, expect, it } from "vitest";

import { sameTimeline, TimelineAwareness, type DocReading } from "./timelineAwareness";
import { emptyTimeline, type Timeline } from "../timeline/model";

const at = (epoch: number, docSession = "s1"): DocReading => ({ docSession, epoch });
const noContentChange = async () => false;
const contentChanged = async () => true;

describe("TimelineAwareness", () => {
  it("says nothing on a fresh chat, and nothing while only the agent edits", async () => {
    const a = new TimelineAwareness();
    expect(await a.atTurnStart(at(0), noContentChange)).toBe(false);
    expect(a.atToolRound(at(0))).toBe(false);
    expect(a.atToolRound(at(0))).toBe(false);
    expect(await a.atTurnStart(at(0), contentChanged)).toBe(false); // same session: the count rules
  });

  it("tells the next message once after an outside edit between turns, then never again", async () => {
    const a = new TimelineAwareness();
    await a.atTurnStart(at(0), noContentChange);
    expect(await a.atTurnStart(at(1), noContentChange)).toBe(true);
    expect(await a.atTurnStart(at(1), noContentChange)).toBe(false);
  });

  it("tells the next tool round about an edit made while a tool ran or during a pause", async () => {
    const a = new TimelineAwareness();
    await a.atTurnStart(at(0), noContentChange);
    expect(a.atToolRound(at(2))).toBe(true);
    expect(a.atToolRound(at(2))).toBe(false);
    expect(await a.atTurnStart(at(2), noContentChange)).toBe(false); // already told inside the turn
  });

  it("stays quiet when the agent read the whole timeline after the outside edit", async () => {
    const a = new TimelineAwareness();
    await a.atTurnStart(at(0), noContentChange);
    a.sawWholeTimeline(at(1)); // the edit landed, then the agent's get_timeline began
    expect(a.atToolRound(at(1))).toBe(false);
  });

  it("still tells it when the edit landed after that read began", async () => {
    const a = new TimelineAwareness();
    await a.atTurnStart(at(0), noContentChange);
    a.sawWholeTimeline(at(1));
    expect(a.atToolRound(at(2))).toBe(true);
  });

  it("a read only counts for the round it happened in", async () => {
    const a = new TimelineAwareness();
    await a.atTurnStart(at(0), noContentChange);
    a.sawWholeTimeline(at(0));
    expect(a.atToolRound(at(0))).toBe(false);
    expect(a.atToolRound(at(3))).toBe(true);
  });

  it("compares content when the document session changed (a reopen, an app restart)", async () => {
    const a = new TimelineAwareness();
    await a.atTurnStart(at(5, "s1"), noContentChange);
    expect(await a.atTurnStart(at(0, "s2"), contentChanged)).toBe(true);
    expect(await a.atTurnStart(at(0, "s2"), contentChanged)).toBe(false); // now in-session again
    const b = new TimelineAwareness();
    expect(await b.atTurnStart(at(0, "s3"), noContentChange)).toBe(false);
  });

  it("compares content after the chat rewrote the model's history (undo, redo, restore)", async () => {
    const a = new TimelineAwareness();
    await a.atTurnStart(at(0), noContentChange);
    a.reset(); // the chat restored a checkpoint: that restore bumped the count, but it is not news
    expect(await a.atTurnStart(at(1), noContentChange)).toBe(false);
    a.reset();
    expect(await a.atTurnStart(at(2), contentChanged)).toBe(true);
  });

  it("has nothing to compare without an open document", async () => {
    const a = new TimelineAwareness();
    expect(await a.atTurnStart(null, contentChanged)).toBe(false);
    expect(a.atToolRound(null)).toBe(false);
  });
});

describe("sameTimeline", () => {
  const withClip = (): Timeline => {
    const t = emptyTimeline();
    t.tracks.push({
      id: "v1",
      kind: "video",
      z: 0,
      clips: [{ id: "c1", media_ref: "media_a", timeline_in: 0, timeline_out: 30 }],
    });
    return t;
  };

  it("ignores key order and the defaults every load fills in", () => {
    const a = withClip();
    const b = JSON.parse(JSON.stringify(a)) as Timeline & { units?: string };
    delete b.units;
    delete (b.tracks[0] as { z?: number }).z;
    const reordered = Object.fromEntries(Object.entries(b).reverse()) as Timeline;
    expect(sameTimeline(a, reordered)).toBe(true);
  });

  it("sees a moved clip, a new clip and a changed canvas", () => {
    const base = withClip();
    const moved = withClip();
    moved.tracks[0].clips![0].timeline_in = 1;
    const added = withClip();
    added.tracks[0].clips!.push({
      id: "c2",
      media_ref: "media_a",
      timeline_in: 30,
      timeline_out: 60,
    });
    const canvas = withClip();
    canvas.canvas.fps = 25;
    for (const other of [moved, added, canvas]) expect(sameTimeline(base, other)).toBe(false);
  });

  it("is false when either side is missing", () => {
    expect(sameTimeline(null, withClip())).toBe(false);
    expect(sameTimeline(withClip(), undefined)).toBe(false);
  });
});
