// Direct uploads, the app's half (UJ-048b): a clip goes straight to the private bucket and the paid call carries only its id.
//
// The rules under test: the bucket gets exactly the clip and never the account's token; every way an upload can fail is a reason to
// send the clip inline as the app always did, never a lost clip; a server that has no uploads is not asked again for a while; and what
// the app uploaded is removed again when the call that was to use it never ran.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setClerkTokenProvider } from "./auth";
import { CreditLimitError } from "./usage";
import { discardUploads, resetUploads, uploadClip } from "./uploads";
import { BUCKET, FakeUploadServer } from "../test/uploadServer";

const CLIP = Uint8Array.from({ length: 3000 }, (_, i) => (i * 7) % 251);
const ID = /^[0-9a-f]{32}$/;
const posts = (server: FakeUploadServer) =>
  server.calls.filter((line) => line === "POST /uploads").length;

let server: FakeUploadServer;
beforeEach(() => {
  server = new FakeUploadServer();
  vi.stubGlobal("fetch", server.fetch);
  setClerkTokenProvider(async () => "tok");
  resetUploads();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  setClerkTokenProvider(null);
});

describe("uploadClip", () => {
  it("puts the clip in the bucket byte for byte and hands back the id the server gave it", async () => {
    const id = await uploadClip(CLIP);
    expect(id).toMatch(ID);
    expect(server.stored(id!)).toEqual(CLIP);
  });

  it("asks the server as the signed-in account and sends the bucket nothing but what the ticket lists", async () => {
    await uploadClip(CLIP);
    const asked = server.calls.indexOf("POST /uploads");
    expect(server.headers[asked].authorization).toBe("Bearer tok");
    const put = server.calls.findIndex((line) => line.startsWith("PUT bucket:"));
    expect(put).toBeGreaterThan(asked);
    expect(
      server.headers[put].authorization,
      "the account's token must never go to the bucket",
    ).toBeUndefined();
    expect(Object.keys(server.headers[put]).sort()).toEqual([
      "content-type",
      "x-goog-content-length-range",
    ]);
  });

  it("uploads exactly the clip it is given: a clip of any length gets a ticket for that length", async () => {
    for (const length of [1, 255, 4096, 1_000_003]) {
      const clip = new Uint8Array(length).fill(length % 251);
      const id = await uploadClip(clip);
      expect(id, `a clip of ${length} bytes`).toMatch(ID);
      expect(server.stored(id!)?.byteLength).toBe(length);
    }
  });

  it("does not bother the server with a clip that has nothing in it", async () => {
    expect(await uploadClip(new Uint8Array(0))).toBeNull();
    expect(server.calls).toEqual([]);
  });

  it.each([404, 405, 501, 401, 413, 429, 503, 500, "drop"] as const)(
    "sends the clip inline when the server answers %s for a ticket",
    async (mode) => {
      server.behaviour.tickets = mode;
      expect(await uploadClip(CLIP)).toBeNull();
      expect(server.objects.size).toBe(0);
    },
  );

  it.each(["blocked", 403, 400, 500] as const)(
    "sends the clip inline when the bucket will not take it (%s)",
    async (mode) => {
      server.behaviour.put = mode;
      expect(await uploadClip(CLIP)).toBeNull();
      expect(server.objects.size).toBe(0);
    },
  );

  it("is turned away at the credit wall as any paid call is, and does not send the clip anywhere", async () => {
    server.behaviour.tickets = 402;
    await expect(uploadClip(CLIP)).rejects.toBeInstanceOf(CreditLimitError);
    expect(server.calls.filter((line) => line.startsWith("PUT"))).toEqual([]);
  });

  it("does not trust a ticket that is not a plain https address and never sends the clip there", async () => {
    for (const bad of [
      "file:///C:/secret",
      "http://storage.test/up",
      "javascript:alert(1)",
      "",
      "not a url",
    ]) {
      server.behaviour.alter = (ticket) => {
        ticket.upload.url = bad;
      };
      expect(await uploadClip(CLIP), bad).toBeNull();
    }
    expect(server.objects.size).toBe(0);
    expect(server.calls.filter((line) => line.startsWith("PUT"))).toEqual([]);
  });

  it.each([
    "../../etc/passwd",
    "ABCDEF0123456789ABCDEF0123456789",
    "0123456789abcdef",
    "0123456789abcdef0123456789abcdef0",
    "",
  ])(
    "does not use an upload id the server could not have made (%j), so it can never be put in a path",
    async (bad) => {
      server.behaviour.alter = (ticket) => {
        ticket.upload.id = bad;
      };
      expect(await uploadClip(CLIP)).toBeNull();
      expect(server.calls.filter((line) => line.startsWith("PUT"))).toEqual([]);
    },
  );

  it("does not send the bucket a header its ticket has no business asking for", async () => {
    server.behaviour.alter = (ticket) => {
      ticket.upload.headers = {
        ...(ticket.upload.headers as Record<string, string>),
        Authorization: "Bearer from-the-ticket",
      };
    };
    expect(await uploadClip(CLIP)).toBeNull();
    expect(server.calls.filter((line) => line.startsWith("PUT"))).toEqual([]);
  });

  it.each([
    {},
    { upload: null },
    { upload: { id: "x" } },
    { upload: { id: ID.source, url: `${BUCKET}/x`, headers: "no" } },
  ])("sends the clip inline when the ticket is not one (%j)", async (answer) => {
    server.behaviour.alter = (ticket) => {
      for (const key of Object.keys(ticket)) delete (ticket as Record<string, unknown>)[key];
      Object.assign(ticket, answer);
    };
    expect(await uploadClip(CLIP)).toBeNull();
  });

  it("remembers that the server has no uploads and does not ask again for ten minutes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-30T10:00:00Z"));
    server.behaviour.tickets = 501;
    expect(await uploadClip(CLIP)).toBeNull();
    expect(await uploadClip(CLIP)).toBeNull();
    expect(posts(server), "a server without uploads was asked again at once").toBe(1);
    vi.setSystemTime(new Date("2026-10-30T10:09:59Z"));
    await uploadClip(CLIP);
    expect(posts(server)).toBe(1);
    vi.setSystemTime(new Date("2026-10-30T10:10:01Z"));
    server.behaviour.tickets = "on";
    expect(await uploadClip(CLIP), "a server that turned uploads on later is never found").toMatch(
      ID,
    );
  });

  it.each([404, 405, 501] as const)("remembers a %s as 'no uploads here'", async (status) => {
    server.behaviour.tickets = status;
    await uploadClip(CLIP);
    await uploadClip(CLIP);
    expect(posts(server)).toBe(1);
  });

  it.each([429, 503, 500, "drop"] as const)(
    "does NOT remember a %s: that is trouble of the moment, the next clip asks again",
    async (mode) => {
      server.behaviour.tickets = mode;
      await uploadClip(CLIP);
      server.behaviour.tickets = "on";
      expect(await uploadClip(CLIP)).toMatch(ID);
    },
  );

  it("does not remember a bucket that refused one clip as a reason never to upload another", async () => {
    server.behaviour.put = 403;
    expect(await uploadClip(CLIP)).toBeNull();
    server.behaviour.put = "ok";
    expect(await uploadClip(CLIP)).toMatch(ID);
  });

  it("stops at once for a user who has stopped: no request is made", async () => {
    const stop = new AbortController();
    stop.abort();
    await expect(uploadClip(CLIP, stop.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(server.calls).toEqual([]);
  });

  it("stops while the server is being asked for a ticket: no clip is sent anywhere", async () => {
    const stop = new AbortController();
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!url.endsWith("/uploads")) return server.fetch(input, init);
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
        queueMicrotask(() => stop.abort());
      });
    });
    await expect(uploadClip(CLIP, stop.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(server.calls.filter((line) => line.startsWith("PUT"))).toEqual([]);
  });

  it("stops while the clip is on its way, and takes back whatever may have arrived", async () => {
    const stop = new AbortController();
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!url.startsWith(BUCKET)) return server.fetch(input, init);
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
        queueMicrotask(() => stop.abort());
      });
    });
    await expect(uploadClip(CLIP, stop.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(
      server.calls.some((line) => line.startsWith("DELETE /uploads/")),
      "an upload the app gave up on was left in the bucket",
    ).toBe(true);
  });
});

describe("discardUploads", () => {
  it("removes every upload it is given, as the signed-in account", async () => {
    const [a, b] = [(await uploadClip(CLIP))!, (await uploadClip(CLIP))!];
    await discardUploads([a, b]);
    expect(server.objects.size).toBe(0);
    const removals = server.calls
      .map((line, i) => (line.startsWith("DELETE /uploads/") ? i : -1))
      .filter((i) => i >= 0);
    expect(removals).toHaveLength(2);
    for (const i of removals) expect(server.headers[i].authorization).toBe("Bearer tok");
  });

  it("makes no request when there is nothing to remove", async () => {
    await discardUploads([]);
    expect(server.calls).toEqual([]);
  });

  it.each(["drop", 500, 404, 401] as const)(
    "never fails the caller, however the server answers (%s)",
    async (mode) => {
      const id = (await uploadClip(CLIP))!;
      server.behaviour.remove = mode;
      await expect(discardUploads([id, id])).resolves.toBeUndefined();
    },
  );

  it("does not reach out for an id that is not an upload id", async () => {
    await discardUploads(["../../etc/passwd", "", "A".repeat(32)]);
    expect(server.calls).toEqual([]);
  });
});
