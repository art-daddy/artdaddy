// UJ-046: the server searches for a refused picture only for an app that says it keeps the mark (`marks_refused_frames`). An app that
// does not say would re-send the picture every round, and every round would pay for the search again. So every round, on both routes
// the app sends rounds by, states it, and no caller can unstate it. The field is held to the shared fixture the server's own tests are
// held to, so a rename on either side fails a test instead of silently switching the search off.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../api/auth", async (io) => {
  const actual = await io<typeof import("../api/auth")>();
  return { ...actual, notifyAuthFailure: vi.fn() };
});

import fixture from "../api/__fixtures__/refusedFrames.json";
import { setApiBase } from "../api/config";
import { inferRound, inferRoundStreaming, type InferBody } from "./api";

const body: InferBody = { round_input: { user_text: "hi" } };

afterEach(() => {
  setApiBase(null);
  vi.unstubAllGlobals();
});

function capture(): string[] {
  const seen: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_u: string, init?: RequestInit) => {
      seen.push(String(init?.body));
      return new Response(JSON.stringify({ kind: "text" }), { status: 200 });
    }),
  );
  return seen;
}

describe("the app says it keeps the mark for a refused picture", () => {
  it("on the whole-round route", async () => {
    const seen = capture();
    await inferRound(body);
    expect(seen).toHaveLength(1);
    expect(JSON.parse(seen[0])).toMatchObject(fixture.request);
  });

  it("on the streaming route", async () => {
    const seen = capture();
    await inferRoundStreaming(body, () => {}).catch(() => {});
    expect(seen.length).toBeGreaterThanOrEqual(1);
    for (const sent of seen) expect(JSON.parse(sent)).toMatchObject(fixture.request);
  });

  it("whatever the caller's body says: it is a statement about the app, not a choice of one round", async () => {
    const seen = capture();
    await inferRound({ ...body, marks_refused_frames: false } as InferBody);
    expect(JSON.parse(seen[0]).marks_refused_frames).toBe(true);
  });

  it("changes nothing else the round sends: the same body plus that one key", async () => {
    const seen = capture();
    await inferRound(body);
    const sent = JSON.parse(seen[0]) as Record<string, unknown>;
    const { marks_refused_frames: said, ...rest } = sent;
    expect(said).toBe(true);
    expect(rest).toMatchObject({ round_input: { user_text: "hi" }, surface: "app" });
    expect(Object.keys(rest).sort()).toEqual(
      ["app_version", "catalog_id", "client_arch", "client_os", "round_input", "surface"].sort(),
    );
  });
});
