// A clip in a paid call (UJ-048b): it goes straight to the bucket and the call carries only its id, and whatever goes wrong with that
// the clip still gets to the model, because the app falls back to sending it inline as it always did.
//
// What is asserted is what the server and the bucket end up holding and what the caller gets back, never the order of internal calls.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BIG_UPLOAD_BYTES, callAiProxy, type AiProxyBody } from "./ai";
import { setClerkTokenProvider } from "./auth";
import { rateLimitConfig } from "./http";
import { CreditLimitError } from "./usage";
import { resetUploads } from "./uploads";
import { FakeUploadServer } from "../test/uploadServer";

const clipOf = (length: number, seed = 1) =>
  Uint8Array.from({ length }, (_, i) => (i * 31 + seed) % 251);
const sameBytes = (a: Uint8Array | undefined, b: Uint8Array | undefined) =>
  a !== undefined &&
  b !== undefined &&
  a.length === b.length &&
  a.every((value, i) => value === b[i]);
const CLIP = clipOf(300_000);
const ASK = { args: { prompt: "what happens?", video: "video" } };
const asking = (clip: Uint8Array): AiProxyBody => ({
  ...ASK,
  media: { video: { clip, ext: ".mp4" } },
});
const ANSWER = { result: { ok: true, text: "an answer" } };
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const requests = (server: FakeUploadServer, prefix: string) =>
  server.calls.filter((line) => line.startsWith(prefix));

let server: FakeUploadServer;
let stored: Map<string, Uint8Array>;
beforeEach(() => {
  server = new FakeUploadServer();
  stored = new Map();
  server.onStored = (id) => stored.set(id, new Uint8Array(server.stored(id)!));
  vi.stubGlobal("fetch", server.fetch);
  setClerkTokenProvider(async () => "tok");
  resetUploads();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setClerkTokenProvider(null);
});

describe("a clip in a paid call", () => {
  it("goes to the bucket byte for byte, and the call that uses it carries only its id", async () => {
    const answer = await callAiProxy("vision_video", asking(CLIP));
    expect(answer).toEqual(ANSWER);
    const [call] = server.seen;
    expect(Object.keys(call.refs)).toEqual(["video"]);
    expect(call.inline).toEqual({});
    expect(call.body.length, "the request still carries the clip").toBeLessThan(2000);
    expect([...stored.values()], "exactly one clip was uploaded").toHaveLength(1);
    expect(
      sameBytes(stored.get(call.refs.video), CLIP),
      "the bucket holds a different clip from the one given",
    ).toBe(true);
  });

  it("never lets the bytes of a clip into the JSON of a request, whichever way it travels", async () => {
    for (const mode of ["on", 501] as const) {
      server.behaviour.tickets = mode;
      resetUploads();
      await callAiProxy("vision_video", asking(clipOf(50_000)));
    }
    for (const call of server.seen) {
      expect(call.body).not.toContain('"clip"');
      expect(call.body).not.toContain('"0":');
    }
  });

  it("leaves nothing behind once the call has run, and the app does not have to clean up", async () => {
    await callAiProxy("vision_video", asking(CLIP));
    expect(server.objects.size).toBe(0);
    expect(
      requests(server, "DELETE"),
      "the app removed an upload the server had already removed",
    ).toEqual([]);
  });

  it("is sent inline, as the same bytes, when the server has no uploads", async () => {
    server.behaviour.tickets = 404;
    const answer = await callAiProxy("vision_video", asking(CLIP));
    expect(answer).toEqual(ANSWER);
    const [call] = server.seen;
    expect(call.refs).toEqual({});
    expect(
      sameBytes(call.inline.video, CLIP),
      "the clip that went inline is not the clip that was given",
    ).toBe(true);
    expect(call.body, "the inline clip lost the extension it always carried").toContain(
      '"ext":".mp4"',
    );
  });

  it.each([
    ["tickets", 429],
    ["tickets", 503],
    ["tickets", "drop"],
    ["tickets", 401],
    ["put", "blocked"],
    ["put", 403],
    ["put", 500],
  ] as const)("still reaches the model, inline, when %s fail (%s)", async (what, mode) => {
    server.behaviour[what] = mode as never;
    const answer = await callAiProxy("vision_video", asking(clipOf(200_000)));
    expect(answer).toEqual(ANSWER);
    expect(sameBytes(server.seen[0].inline.video, clipOf(200_000))).toBe(true);
    expect(server.objects.size).toBe(0);
  });

  it("is turned away at the credit wall before anything is sent anywhere", async () => {
    server.behaviour.tickets = 402;
    await expect(callAiProxy("vision_video", asking(CLIP))).rejects.toBeInstanceOf(
      CreditLimitError,
    );
    expect(server.seen).toEqual([]);
    expect(requests(server, "PUT")).toEqual([]);
  });

  it("keeps working for a call with no clip in it at all, exactly as before", async () => {
    const answer = await callAiProxy("vision_image", {
      args: { images: ["a"] },
      media: { a: { b64: "AAAA" } },
    });
    expect(answer).toEqual(ANSWER);
    expect(server.calls).toEqual(["POST /ai/vision_image"]);
    expect(server.seen[0].inline.a).toEqual(Uint8Array.from([0, 0, 0]));
  });

  it("goes in an upload only for the entries that are clips: bytes already encoded as text stay as they are", async () => {
    await callAiProxy("style_analyze", {
      args: {},
      media: { v0: { clip: clipOf(5000) }, note: { b64: "AAAA" } },
    });
    const [call] = server.seen;
    expect(Object.keys(call.refs)).toEqual(["v0"]);
    expect(call.inline.note).toEqual(Uint8Array.from([0, 0, 0]));
  });
});

describe("several clips in one call", () => {
  const three = () => ({
    args: { n: 3 },
    media: {
      v0: { clip: clipOf(4000, 1) },
      v1: { clip: clipOf(4000, 2) },
      v2: { clip: clipOf(4000, 3) },
    },
  });

  it("all go by ticket before the call, and every one is the clip it was", async () => {
    await callAiProxy("style_analyze", three());
    expect(requests(server, "POST /uploads")).toHaveLength(3);
    const lastUpload = server.calls
      .map((line, i) => (line.startsWith("PUT bucket:") ? i : -1))
      .reduce((a, b) => Math.max(a, b));
    expect(
      server.calls.indexOf("POST /ai/style_analyze"),
      "the call was made before every clip was uploaded",
    ).toBeGreaterThan(lastUpload);
    const [call] = server.seen;
    expect(Object.keys(call.refs)).toEqual(["v0", "v1", "v2"]);
    for (const [key, seed] of [
      ["v0", 1],
      ["v1", 2],
      ["v2", 3],
    ] as const)
      expect(stored.get(call.refs[key])).toEqual(clipOf(4000, seed));
  });

  it("send only the one that could not be uploaded inline, and the others by id", async () => {
    let n = 0;
    server.behaviour.alter = (ticket) => {
      n += 1;
      if (n === 2) ticket.upload.headers = { "Content-Type": "video/webm" }; // the bucket will refuse this one
    };
    await callAiProxy("style_analyze", three());
    const [call] = server.seen;
    expect(Object.keys(call.refs).sort()).toEqual(["v0", "v2"]);
    expect(call.inline.v1).toEqual(clipOf(4000, 2));
  });
});

describe("a clip that is gone from the bucket when the call arrives", () => {
  it("is uploaded again, once, and the call goes through", async () => {
    let lost = true;
    server.onStored = (id) => {
      stored.set(id, new Uint8Array(server.stored(id)!));
      if (lost) {
        lost = false;
        server.objects.delete(id); // the first upload vanishes before the call
      }
    };
    const answer = await callAiProxy("vision_video", asking(CLIP));
    expect(answer).toEqual(ANSWER);
    expect(server.seen).toHaveLength(2);
    expect(server.seen[0].refs.video).not.toBe(server.seen[1].refs.video);
    expect(Object.keys(server.seen[1].refs)).toEqual(["video"]);
  });

  it("is sent inline when even the second upload is lost", async () => {
    server.onStored = (id) => {
      server.objects.delete(id);
    };
    const answer = await callAiProxy("vision_video", asking(clipOf(100_000)));
    expect(answer).toEqual(ANSWER);
    expect(server.seen).toHaveLength(3);
    expect(server.seen[2].refs).toEqual({});
    expect(sameBytes(server.seen[2].inline.video, clipOf(100_000))).toBe(true);
    // Objects that went missing once are not a reason to stop uploading: the next call uploads as usual.
    server.onStored = null;
    await callAiProxy("vision_video", asking(clipOf(100_000)));
    expect(Object.keys(server.seen.at(-1)!.refs)).toEqual(["video"]);
  });

  it("is the only thing sent again: the clips that are still there are not uploaded a second time", async () => {
    const lostIds = new Set<string>();
    server.onStored = (id) => {
      stored.set(id, new Uint8Array(server.stored(id)!));
      if (lostIds.size === 0) {
        lostIds.add(id);
        server.objects.delete(id);
      }
    };
    await callAiProxy("style_analyze", {
      args: {},
      media: { a: { clip: clipOf(3000, 1) }, b: { clip: clipOf(3000, 2) } },
    });
    expect(
      requests(server, "POST /uploads"),
      "two clips and one lost: three tickets, not four",
    ).toHaveLength(3);
    expect(server.seen).toHaveLength(2);
  });

  it("is sent inline when one clip keeps being lost, and the clip that was fine is taken back out of the bucket, not left there", async () => {
    const a = clipOf(3000, 1);
    const b = clipOf(3000, 2);
    let lost = 0;
    server.onStored = (id) => {
      if (sameBytes(server.stored(id), a)) {
        lost += 1;
        server.objects.delete(id); // every upload of the first clip vanishes before the call
      }
    };
    const answer = await callAiProxy("style_analyze", {
      args: {},
      media: { a: { clip: a }, b: { clip: b } },
    });
    expect(answer).toEqual(ANSWER);
    expect(server.seen.at(-1)!.refs, "the last try must send every clip inline").toEqual({});
    expect(lost).toBe(2);
    await vi.waitFor(() =>
      expect(server.objects.size, "an upload nothing used was left in the bucket").toBe(0),
    );
  });
});

describe("when an upload ends the call", () => {
  it("the credit wall at the second clip stops it, and the first clip that had already arrived is taken back out", async () => {
    server.behaviour.tickets = (asked) => (asked === 2 ? 402 : "on");
    await expect(
      callAiProxy("style_analyze", {
        args: {},
        media: { a: { clip: clipOf(3000, 1) }, b: { clip: clipOf(3000, 2) } },
      }),
    ).rejects.toBeInstanceOf(CreditLimitError);
    expect(server.seen, "a call that could not be paid for was made").toEqual([]);
    await vi.waitFor(() =>
      expect(server.objects.size, "a clip that had arrived was left in the bucket").toBe(0),
    );
  });
});

describe("a 400 that is not about a missing upload", () => {
  const refuse = (detail: unknown) => {
    const real = server.fetch;
    const asked: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!url.includes("/ai/")) return real(input, init);
      asked.push(url);
      return new Response(JSON.stringify({ detail }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    });
    return asked;
  };

  it.each([
    ["another error that happens to list keys", { error: "invalid_request", keys: ["video"] }],
    ["a missing upload that names no clip", { error: "upload_missing", keys: [] }],
    ["a missing upload with keys that are not text", { error: "upload_missing", keys: [1, null] }],
    ["a missing upload with no keys at all", { error: "upload_missing" }],
  ])("is %s: the call fails as an ordinary 400 and is not sent again", async (_what, detail) => {
    const asked = refuse(detail);
    await expect(callAiProxy("vision_video", asking(clipOf(5000)))).rejects.toThrow(/^400:/);
    expect(
      asked,
      "the call was sent again for an answer that was not 'send the clips again'",
    ).toHaveLength(1);
  });
});

describe("a server that cannot look in the bucket", () => {
  it("says so on the paid call: the clip goes inline, the call goes through, and what was uploaded is taken back out", async () => {
    const wait = rateLimitConfig.transientBackoffS;
    rateLimitConfig.transientBackoffS = 0.001;
    try {
      server.behaviour.ai = "unbucketed";
      const answer = await callAiProxy("vision_video", asking(CLIP), undefined, {
        transientRetries: 1,
      });
      expect(answer).toEqual(ANSWER);
      const last = server.seen.at(-1)!;
      expect(last.refs, "the last try still named an upload").toEqual({});
      expect(
        sameBytes(last.inline.video, CLIP),
        "the clip did not arrive inline, byte for byte",
      ).toBe(true);
      await vi.waitFor(() =>
        expect(server.objects.size, "an upload nothing used was left in the bucket").toBe(0),
      );
    } finally {
      rateLimitConfig.transientBackoffS = wait;
    }
  });

  it("leaves uploads alone for a couple of minutes, then tries again", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-30T10:00:00Z"));
    server.behaviour.ai = "unbucketed";
    await callAiProxy("vision_video", asking(clipOf(5000)));
    const asked = requests(server, "POST /uploads").length;
    server.behaviour.ai = "ok";
    vi.setSystemTime(new Date("2026-10-30T10:01:00Z")); // a minute later: uploads are still being left alone
    await callAiProxy("vision_video", asking(clipOf(5000)));
    expect(requests(server, "POST /uploads"), "uploads were tried again at once").toHaveLength(
      asked,
    );
    vi.setSystemTime(new Date("2026-10-30T10:03:00Z"));
    await callAiProxy("vision_video", asking(clipOf(5000)));
    expect(requests(server, "POST /uploads"), "uploads were never tried again").toHaveLength(
      asked + 1,
    );
  });

  it("goes inline too when it says so after a clip had to be uploaded again", async () => {
    server.onStored = (id) => {
      if (server.seen.length === 0 && server.objects.size === 1)
        server.objects.delete(id); // the first upload is lost
      else server.behaviour.ai = "unbucketed"; // and by the second try the server cannot look in the bucket
    };
    const answer = await callAiProxy("vision_video", asking(clipOf(5000)));
    expect(answer).toEqual(ANSWER);
    expect(server.seen).toHaveLength(3);
    expect(server.seen[2].refs).toEqual({});
    expect(sameBytes(server.seen[2].inline.video, clipOf(5000))).toBe(true);
  });

  it("is told something else with a 503: that stays an ordinary failure and is not sent again as if it were about the bucket", async () => {
    const real = server.fetch;
    const asked: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!url.includes("/ai/")) return real(input, init);
      asked.push(url);
      return new Response(JSON.stringify({ detail: { error: "metering_unavailable" } }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    });
    await expect(callAiProxy("vision_video", asking(clipOf(5000)))).rejects.toThrow(/^503:/);
    expect(asked, "a 503 that was not about the bucket was sent again").toHaveLength(1);
  });
});

describe("a clip that is gone from the bucket when the call arrives", () => {
  it("is the only clip sent again: one that went inline because its upload failed is not uploaded a second time", async () => {
    const a = clipOf(3000, 1);
    const b = clipOf(3000, 2);
    let lostOnce = true;
    server.onStored = (id) => {
      if (lostOnce && sameBytes(server.stored(id), a)) {
        lostOnce = false;
        server.objects.delete(id);
      }
    };
    let asked = 0;
    server.behaviour.alter = (ticket) => {
      asked += 1;
      if (asked === 2) ticket.upload.headers = { "Content-Type": "video/webm" }; // the bucket refuses this one: it goes inline
    };
    await callAiProxy("style_analyze", { args: {}, media: { a: { clip: a }, b: { clip: b } } });
    expect(
      requests(server, "POST /uploads"),
      "a clip that never uploaded was uploaded again",
    ).toHaveLength(3);
    expect(requests(server, "PUT")).toHaveLength(3);
    expect(sameBytes(server.seen.at(-1)!.inline.b, b)).toBe(true);
  });
});

describe("a call that does not run", () => {
  it("is refused before it runs: the app says so, and takes its uploads back out of the bucket", async () => {
    server.behaviour.ai = { refuse: 402 };
    await expect(callAiProxy("vision_video", asking(CLIP))).rejects.toBeInstanceOf(
      CreditLimitError,
    );
    await vi.waitFor(() =>
      expect(server.objects.size, "the clip was left in the bucket for a day").toBe(0),
    );
  });

  it("fails after it ran: the error is the call's own and nothing the app does to clean up can hide it", async () => {
    server.behaviour.ai = { fail: 500 };
    server.behaviour.remove = "drop";
    await expect(callAiProxy("vision_video", asking(CLIP))).rejects.toThrow(/500/);
  });

  it("is stopped by the user while the clip is being uploaded: nothing reaches the model", async () => {
    const stop = new AbortController();
    const real = server.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await real(input, init);
      if (String(init?.method).toUpperCase() === "PUT") stop.abort();
      return response;
    });
    await expect(callAiProxy("vision_video", asking(CLIP), stop.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(server.seen).toEqual([]);
    await vi.waitFor(() =>
      expect(server.objects.size, "an upload the user stopped was left in the bucket").toBe(0),
    );
  });
});

describe("a clip that has to be sent inline", () => {
  // Just big enough that its text form is above the line (a clip of n bytes is 4n/3 characters).
  const BIG = Math.ceil((BIG_UPLOAD_BYTES * 3) / 4) + 1000;

  it("is still sent one big body at a time, as every big upload always was", async () => {
    server.behaviour.tickets = 501;
    let release!: () => void;
    server.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const big = () => asking(new Uint8Array(BIG));
    const first = callAiProxy("vision_video", big());
    const second = callAiProxy("vision_video", big());
    await tick();
    await tick();
    expect(requests(server, "POST /ai/"), "two big bodies were in flight together").toHaveLength(1);
    release();
    await Promise.all([first, second]);
    expect(requests(server, "POST /ai/")).toHaveLength(2);
  }, 30_000);

  it("is never held up when it went by id: a reference is a small request", async () => {
    let release!: () => void;
    server.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runs = [
      callAiProxy("vision_video", asking(clipOf(BIG, 1))),
      callAiProxy("vision_video", asking(clipOf(BIG, 2))),
    ];
    for (let i = 0; i < 6; i += 1) await tick();
    expect(
      requests(server, "POST /ai/"),
      "a request with only an id was queued behind another",
    ).toHaveLength(2);
    release();
    await Promise.all(runs);
  }, 30_000);
});
