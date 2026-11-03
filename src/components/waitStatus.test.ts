import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { toolNames } from "../contract/views";
import type { LiveCall, LiveRound } from "../store/liveWait";
import { PHRASED_TOOLS, runningPhrase, summarizeCall } from "./toolSummary";
import {
  CLOCK_MAX_S,
  clockText,
  SHOW_ELAPSED_AFTER_S,
  SLOW_AFTER_S,
  waitStatus,
} from "./waitStatus";

const T0 = 1_000_000;
const at = (s: number): number => T0 + s * 1000;
const call = (name: string, startedAtS = 0, id = `${name}-${startedAtS}`): LiveCall => ({
  id,
  name,
  startedAt: at(startedAtS),
});
const round = (phase: LiveRound["phase"], startedAtS = 0): LiveRound => ({
  phase,
  startedAt: at(startedAtS),
});
const status = (over: Partial<Parameters<typeof waitStatus>[0]>, nowS: number) =>
  waitStatus({ round: null, calls: [], approvalSince: null, now: at(nowS), ...over });

describe("what the turn is waiting on", () => {
  it("says nothing when nothing is known to be running", () => {
    expect(status({}, 5)).toBeNull();
  });

  it("names the model's own phases", () => {
    expect(status({ round: round("preparing") }, 1)?.label).toBe("Getting ready");
    expect(status({ round: round("waiting") }, 1)?.label).toBe("Thinking");
    expect(status({ round: round("writing") }, 1)?.label).toBe("Writing");
    expect(status({ round: round("waiting") }, 1)?.kind).toBe("model");
  });

  it("names a running tool in the words the chat already uses for it, not by its identifier", () => {
    const s = status({ calls: [call("add_captions")] }, 1);
    expect(s?.kind).toBe("tool");
    expect(s?.label).toBe("Captioning the audio");
    expect(status({ calls: [call("video_find_moment")] }, 1)?.label).toBe("Searching a video");
  });

  it("puts the person's own answer first, then a running tool, then the model", () => {
    const both = { round: round("waiting"), calls: [call("inspect_media")] };
    expect(status({ ...both, approvalSince: at(0) }, 1)?.kind).toBe("approval");
    expect(status(both, 1)?.kind).toBe("tool");
    expect(status({ round: round("waiting") }, 1)?.kind).toBe("model");
  });

  it("says how many more are running beside the one it names, and names the one running longest", () => {
    const s = status(
      { calls: [call("inspect_media", 5), call("video_ask", 2), call("inspect_color", 9)] },
      20,
    );
    expect(s?.label).toBe(`${runningPhrase("video_ask")} (+2 more)`);
    expect(s?.elapsedS).toBe(18);
  });

  it("shows no clock for a short wait and a clock from three seconds", () => {
    expect(status({ round: round("waiting") }, SHOW_ELAPSED_AFTER_S - 1)?.showElapsed).toBe(false);
    expect(status({ round: round("waiting") }, SHOW_ELAPSED_AFTER_S)?.showElapsed).toBe(true);
  });

  it("says it is still going, and that Stop is there, from half a minute, and says where the wait is", () => {
    const tool = { calls: [call("video_ask")] };
    expect(status(tool, SLOW_AFTER_S - 1)?.hint).toBeNull();
    const slowTool = status(tool, SLOW_AFTER_S);
    expect(slowTool?.slow).toBe(true);
    expect(slowTool?.hint).toMatch(/Still working/);
    expect(slowTool?.hint).toMatch(/Stop/);
    const slowModel = status({ round: round("waiting") }, SLOW_AFTER_S);
    expect(slowModel?.hint).toMatch(/AI is taking longer/);
    expect(slowModel?.hint).toMatch(/Stop/);
  });

  it("never tells a person who is being asked something that it is still working", () => {
    const s = status({ approvalSince: at(0) }, 3600);
    expect(s?.label).toBe("Waiting for your OK");
    expect(s?.showElapsed).toBe(true);
    expect(s?.slow).toBe(false);
    expect(s?.hint).toBeNull();
  });
});

// A tool that is waiting for the transcript is not captioning or looking at anything yet: the line
// says what is being waited on. The wording is the owner's (2026-11-02).
describe("a tool that is waiting for speech", () => {
  const SPEECH_TOOLS = ["add_captions", "inspect_media", "get_transcript"];
  const waiting = (tool = "add_captions") => ({ calls: [call(tool)], speechTools: [tool] });

  it("says it is transcribing the audio, whatever the tool is usually called", () => {
    for (const tool of SPEECH_TOOLS)
      expect(status(waiting(tool), 1)?.label, tool).toBe("Transcribing the audio");
    // The same call, not waiting for speech any more, goes back to its own words.
    expect(status({ calls: [call("add_captions")], speechTools: [] }, 1)?.label).toBe(
      "Captioning the audio",
    );
  });

  it("does not put the words on a tool that is not the one waiting", () => {
    const other = status({ calls: [call("video_ask")], speechTools: ["add_captions"] }, 1);
    expect(other?.label).toBe(runningPhrase("video_ask"));
    const plain = status({ calls: [call("video_ask")], downloadingModel: true }, 1);
    expect(plain?.label).toBe(runningPhrase("video_ask"));
  });

  it("says the speech model is downloading, and explains it from the first second", () => {
    const s = status({ ...waiting(), downloadingModel: true }, 1);
    expect(s?.label).toBe("Downloading the speech model (one time)");
    expect(s?.hint).toMatch(/This only happens when you start the app for the first time/);
    expect(s?.hint).toMatch(/Stop/);
  });

  it("keeps the usual slow hint for a plain transcription: none before half a minute, one after", () => {
    expect(status(waiting(), SLOW_AFTER_S - 1)?.hint).toBeNull();
    expect(status(waiting(), SLOW_AFTER_S)?.hint).toMatch(/Still working/);
  });

  it("still counts the other calls running beside it", () => {
    const s = status(
      { calls: [call("add_captions", 0), call("inspect_color", 2)], speechTools: ["add_captions"] },
      5,
    );
    expect(s?.label).toBe("Transcribing the audio (+1 more)");
  });

  it("changes only the words: the kind and the clock are the same as without it", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 7200 }), fc.boolean(), (nowS, downloading) => {
        const plain = status({ calls: [call("add_captions")] }, nowS);
        const speech = status({ ...waiting(), downloadingModel: downloading }, nowS);
        expect({ ...speech, label: "", hint: null }).toEqual({ ...plain, label: "", hint: null });
      }),
    );
  });
});

// While the request itself is waiting (the connection is being re-made, or the server is finishing
// the person's last request) the line says that, not "Thinking".
describe("a round whose request is waiting", () => {
  const noted = (
    note: "reconnecting" | "busy",
    phase: LiveRound["phase"] = "waiting",
  ): LiveRound => ({
    ...round(phase),
    note,
  });

  it("says it is reconnecting, or waiting for the last request, instead of thinking", () => {
    expect(status({ round: noted("reconnecting") }, 1)).toMatchObject({
      kind: "model",
      label: "Reconnecting",
    });
    expect(status({ round: noted("busy") }, 1)).toMatchObject({
      kind: "model",
      label: "Waiting for your last request",
    });
    expect(status({ round: round("waiting") }, 1)?.label).toBe("Thinking");
  });

  it("explains a wait for the last request at once, and a reconnect only when it drags on", () => {
    const busyHint = status({ round: noted("busy") }, 1)?.hint;
    expect(busyHint).toMatch(/last request is still finishing/);
    expect(busyHint).toMatch(/Stop/);
    expect(status({ round: noted("reconnecting") }, SLOW_AFTER_S - 1)?.hint).toBeNull();
    const slow = status({ round: noted("reconnecting") }, SLOW_AFTER_S)?.hint;
    expect(slow).toMatch(/trying to reach the server/);
    expect(slow).toMatch(/Stop/);
  });

  it("changes only the words: the kind and the clock are those of the same round without it", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 7200 }),
        fc.constantFrom("reconnecting", "busy"),
        fc.constantFrom("preparing", "waiting", "writing"),
        (nowS, note, phase) => {
          const plain = status({ round: round(phase) }, nowS);
          const said = status({ round: noted(note, phase) }, nowS);
          expect({ ...said, label: "", hint: null }).toEqual({ ...plain, label: "", hint: null });
        },
      ),
    );
  });

  it("is only the model's wait: the person's answer and a running tool still come first", () => {
    expect(status({ round: noted("busy"), approvalSince: at(0) }, 1)?.kind).toBe("approval");
    expect(status({ round: noted("busy"), calls: [call("video_ask")] }, 1)?.kind).toBe("tool");
  });
});

describe("a phrase for every tool the model can call (the registry walk)", () => {
  const tools = toolNames();

  it("gives every tool in the contract a status in its own words", () => {
    const wrong = tools.filter((t) => {
      const label = status({ calls: [call(t)] }, 1)?.label ?? "";
      return !PHRASED_TOOLS.has(t) || label !== runningPhrase(t) || /[_…]|\.\.\.$/.test(label);
    });
    expect(wrong).toEqual([]);
    expect(tools.length).toBeGreaterThan(40);
  });

  it("agrees with the chat's own row for the same tool while it runs", () => {
    for (const t of tools) {
      const row = summarizeCall(t, {}, undefined, { trackLabel: (id) => id }).text;
      expect(row.replace(/…$/, ""), t).toBe(runningPhrase(t));
    }
  });

  it("never lets a name an object inherits, or any odd name, break the line", () => {
    for (const name of [
      "constructor",
      "toString",
      "__proto__",
      "hasOwnProperty",
      "",
      " ",
      "a_b_c",
    ]) {
      const label = status({ calls: [call(name)] }, 1)?.label ?? "";
      expect(label.length, JSON.stringify(name)).toBeGreaterThan(0);
      expect(label).not.toMatch(/undefined|\[object|function/);
    }
  });
});

describe("whatever the live record holds, the line stays sane", () => {
  const time = fc.oneof(
    fc.integer({ min: 0, max: 4e9 }),
    fc.double({ noNaN: false }),
    fc.constantFrom(NaN, Infinity, -Infinity, 0, -1),
  );
  const names = fc.oneof(fc.constantFrom(...toolNames()), fc.string({ maxLength: 12 }));
  const liveCall = fc.record({ id: fc.string(), name: names, startedAt: time });
  const liveRound = fc.oneof(
    fc.constant(null),
    fc.record({ phase: fc.constantFrom("preparing", "waiting", "writing"), startedAt: time }),
  );

  it("always answers with a whole, non-negative elapsed time, a usable label and a finite start", () => {
    fc.assert(
      fc.property(
        liveRound,
        fc.array(liveCall, { maxLength: 5 }),
        fc.oneof(fc.constant(null), time),
        time,
        (r, calls, approvalSince, now) => {
          const s = waitStatus({ round: r as LiveRound | null, calls, approvalSince, now });
          const waiting = approvalSince !== null || calls.length > 0 || r !== null;
          expect(s === null).toBe(!waiting);
          if (!s) return;
          expect(Number.isInteger(s.elapsedS)).toBe(true);
          expect(s.elapsedS).toBeGreaterThanOrEqual(0);
          expect(s.elapsedS).toBeLessThanOrEqual(CLOCK_MAX_S);
          expect(Number.isFinite(s.since)).toBe(true);
          expect(s.label.trim().length).toBeGreaterThan(0);
          expect(s.showElapsed).toBe(s.elapsedS >= SHOW_ELAPSED_AFTER_S);
          expect(s.slow).toBe(s.kind !== "approval" && s.elapsedS >= SLOW_AFTER_S);
          expect(s.hint !== null).toBe(s.slow);
        },
      ),
    );
  });

  // Found by the property above on one run in many (the pre-push run, 2026-11-03): two finite times
  // at opposite extremes subtract to Infinity, which is not a whole number of seconds.
  it("stops the elapsed time where the clock stops, even when the two times overflow when subtracted", () => {
    const wait = (startedAt: number, now: number) =>
      waitStatus({
        round: null,
        calls: [{ id: "", name: "", startedAt }],
        approvalSince: null,
        now,
      });
    for (const [startedAt, now] of [
      [-3.293136510732288e293, Number.MAX_VALUE], // the found counterexample: the difference is Infinity
      [-Number.MAX_VALUE, Number.MAX_VALUE],
      [0, 1e300], // finite, but far past any clock
    ]) {
      const s = wait(startedAt, now);
      expect(s?.elapsedS, `${startedAt} -> ${now}`).toBe(CLOCK_MAX_S);
      expect(s?.slow).toBe(true);
    }
    // The other way round, a start in the future is no wait at all.
    expect(wait(Number.MAX_VALUE, -Number.MAX_VALUE)?.elapsedS).toBe(0);
  });

  it("measures from the call that has run longest, whatever order they arrive in", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 500 }), { minLength: 1, maxLength: 6 }),
        fc.integer({ min: 500, max: 1000 }),
        (starts, nowS) => {
          const calls = starts.map((s, i) => call("inspect_media", s, `c${i}`));
          const s = status({ calls }, nowS);
          expect(s?.elapsedS).toBe(nowS - Math.min(...starts));
        },
      ),
    );
  });
});

describe("clockText", () => {
  it("reads as a clock", () => {
    expect(clockText(0)).toBe("0:00");
    expect(clockText(7)).toBe("0:07");
    expect(clockText(63)).toBe("1:03");
    expect(clockText(725)).toBe("12:05");
    expect(clockText(3723)).toBe("1:02:03");
  });

  it("is always a clock and never goes backwards, for any number", () => {
    fc.assert(
      fc.property(fc.double({ noNaN: false }), (n) => {
        expect(clockText(n)).toMatch(/^\d+:\d{2}(:\d{2})?$/);
      }),
    );
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 359_999 }),
        fc.integer({ min: 0, max: 359_999 }),
        (a, b) => {
          const parse = (t: string): number =>
            t.split(":").reduce((acc, part) => acc * 60 + Number(part), 0);
          expect(Math.sign(parse(clockText(a)) - parse(clockText(b)))).toBe(Math.sign(a - b));
        },
      ),
    );
  });
});
