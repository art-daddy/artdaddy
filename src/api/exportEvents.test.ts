// The export beacon's contract with the server, asserted on what actually goes over the wire: the
// report travels WITH the signed-in session (the server files it under that account), carries no
// identity of its own, and keeps its text and numbers inside the server's bounds -- a server that
// refuses an over-long or out-of-range value drops the whole row (UJ-006).
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";

import { onAuthFailure, setClerkTokenProvider, setSessionRenewer } from "./auth";
import { apiBase } from "./config";
import {
  EXPORT_FACT_LIMITS,
  EXPORT_OPERATIONS,
  EXPORT_REASON_CODES,
  EXPORT_SIZE_BANDS,
  EXPORT_TRACE_EVENTS,
  EXPORT_TRACE_MAX_EVENTS,
  EXPORT_TRACE_VALUES,
  MAX_EXPORT_ERROR,
  MAX_TRACE_TEXT,
  cleanTrace,
  composeBody,
  decodeTrace,
  encodeTrace,
  reportExport,
  wireBody,
  type ExportEvent,
  type TraceEvent,
} from "./exportEvents";
import { pendingReports, queueReport } from "./exportOutbox";

afterEach(() => {
  setClerkTokenProvider(null);
  setSessionRenewer(null);
  vi.unstubAllGlobals();
});

/** Stub the network and sign in as `token` (null = signed out). Returns the recorded requests. */
function network(
  token: string | null = "tok_alice",
  reply: () => Response = () => new Response("{}"),
) {
  setClerkTokenProvider(token === null ? null : async () => token);
  const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => reply());
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function sent(event: ExportEvent): Promise<Record<string, unknown>> {
  const fetchMock = network();
  await reportExport(event);
  return JSON.parse(String(fetchMock.mock.calls[0][1].body)) as Record<string, unknown>;
}

async function sentBody(error: string): Promise<Record<string, unknown>> {
  return sent({ status: "failed", error });
}

/** Every key the server's ExportEventBody takes from this beacon, and nothing else. `owner_id` is
 *  not here: it is sent only for a report whose account the app knows (see exportReportDelivery). */
const REPORT_KEYS = [
  "active_ms",
  "app_version",
  "arch",
  "duration_s",
  "elapsed_ms",
  "error",
  "event_id",
  "fps",
  "height",
  "occurred_at",
  "operation",
  "platform",
  "project_id",
  "project_size_band",
  "quality",
  "readiness",
  "reason_code",
  "recovered",
  "shell",
  "size_bytes",
  "status",
  "warnings",
  "width",
];

/** The server's numeric bounds (ExportEventBody). Outside them the whole report is refused. */
const SERVER_BOUNDS: Record<string, number> = {
  duration_s: 86_400,
  size_bytes: 1e13,
  elapsed_ms: 10_000_000_000,
  active_ms: 10_000_000_000,
  width: 16_384,
  height: 16_384,
  fps: 1_000,
  warnings: 10_000,
};

describe("the export beacon", () => {
  it("files the report under the signed-in session, and says nothing about who that is", async () => {
    const fetchMock = network("tok_alice");
    await reportExport({
      status: "done",
      ...({ user_id: "someone_else", email: "victim@example.com" } as object),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${apiBase()}/telemetry/export`);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok_alice");
    const body = JSON.parse(String(init.body));
    expect(body).not.toHaveProperty("user_id");
    expect(body).not.toHaveProperty("email");
  });

  it("sends nothing when nobody is signed in, rather than a guaranteed refusal", async () => {
    const fetchMock = network(null);
    await expect(reportExport({ status: "done" })).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is never the thing that puts up the sign-in prompt", async () => {
    const prompted = vi.fn();
    const off = onAuthFailure(prompted);
    try {
      network("tok_expired", () => new Response("{}", { status: 401 }));
      await expect(reportExport({ status: "failed", error: "x" })).resolves.toBeUndefined();
      expect(prompted).not.toHaveBeenCalled();
    } finally {
      off();
    }
  });

  it("reports the whole per-account record the exporter has always sent, plus the V2 vocabulary", async () => {
    const body = await sent({
      status: "done",
      operation: "render",
      readiness: "ready",
      duration_s: 49.5,
      size_bytes: 14_075_403,
      elapsed_ms: 62_000,
      width: 1920,
      height: 1080,
      fps: 30,
      quality: "high",
      warnings: 2,
      error: "",
      project_id: "odyssey_ii",
    });
    expect(body).toMatchObject({
      status: "done",
      reason_code: "none",
      operation: "render",
      readiness: "ready",
      project_size_band: "hd",
      duration_s: 49.5,
      size_bytes: 14_075_403,
      elapsed_ms: 62_000,
      width: 1920,
      height: 1080,
      fps: 30,
      quality: "high",
      warnings: 2,
      error: "",
      project_id: "odyssey_ii",
    });
    expect(Object.keys(body).sort()).toEqual(REPORT_KEYS);
  });

  it("says an export was finished by a later launch, and how long its last run took", async () => {
    const recovered = await sent({ status: "done", recovered: true, active_ms: 3_600_000 });
    expect(recovered).toMatchObject({ recovered: true, active_ms: 3_600_000 });
    // An ordinary export is not recovered, and an unknown run time reads as 0, never as a guess.
    expect(await sent({ status: "done" })).toMatchObject({ recovered: false, active_ms: 0 });
  });

  it.each([1, "true", "yes", {}, [], null, undefined, 0])(
    "treats %j as not recovered: only a real true flags an export",
    async (value) => {
      const body = await sent({ status: "done", ...({ recovered: value } as object) });
      expect(body.recovered).toBe(false);
    },
  );

  it("keeps the failure text that explains a failure, next to its reason", async () => {
    const body = await sentBody("ffmpeg render failed (code=-22): Conversion failed!");
    expect(body).toMatchObject({
      status: "failed",
      reason_code: "render_failed",
      error: "ffmpeg render failed (code=-22): Conversion failed!",
    });
  });

  it("sends a long failure within the server's bound, keeping its cause and its verdict", async () => {
    const error = `ffmpeg render failed (code=-22): ${"[vost#0:0] stream noise ".repeat(40)}Conversion failed!`;
    const sentError = String((await sentBody(error)).error);
    expect(sentError.length).toBeLessThanOrEqual(MAX_EXPORT_ERROR);
    expect(sentError.startsWith("ffmpeg render failed (code=-22)")).toBe(true);
    expect(sentError.endsWith("Conversion failed!")).toBe(true);
  });

  it("sends a short failure, and a success's empty error, untouched", async () => {
    expect((await sentBody("ffmpeg died")).error).toBe("ffmpeg died");
    expect((await sentBody("")).error).toBe("");
    const exact = "e".repeat(MAX_EXPORT_ERROR);
    expect((await sentBody(exact)).error).toBe(exact);
  });

  it("is bounded for every length, not just the one seen", async () => {
    for (const n of [MAX_EXPORT_ERROR + 1, 301, 999, 20_000]) {
      const sentError = String((await sentBody("A".repeat(n - 1) + "Z")).error);
      expect(sentError.length, `length ${n}`).toBeLessThanOrEqual(MAX_EXPORT_ERROR);
      expect(sentError.endsWith("Z"), `length ${n}`).toBe(true);
    }
  });

  // Found by review: a graphics chip's failure can put the device or the driver into the encoder's own words. They stay on the
  // PC: the report says which maker and which encoder, never which device, which driver or which slot.
  describe("never says which device or driver a failure came from", () => {
    const leaks: Array<[string, string, RegExp]> = [
      [
        "a device's PCI id",
        "[h264_amf] device PCI\\VEN_1002&DEV_15BF&SUBSYS_88121043&REV_C1 failed",
        /VEN_|DEV_|SUBSYS_|REV_C1/,
      ],
      [
        "a driver's version",
        "AMF runtime 32.0.22024.4008 cannot open the encoder",
        /32\.0\.22024\.4008/,
      ],
      [
        "an AMD device's name",
        "[h264_amf @ 1] Using AMD Radeon(TM) 780M Graphics: error",
        /Radeon|780M/,
      ],
      [
        "an NVIDIA device's name",
        "[h264_nvenc @ 1] NVIDIA GeForce RTX 3060 Laptop GPU does not support",
        /GeForce|RTX|3060/,
      ],
      [
        "an Intel device's name",
        "[h264_qsv @ 1] Intel(R) Iris(R) Xe Graphics failed to open a session",
        /Iris|Xe Graphics/,
      ],
      [
        "an Intel UHD device's name",
        "Intel(R) UHD Graphics 770 refused the surface",
        /UHD Graphics|770/,
      ],
      ["a bare model", "encoder RX 6800 XT stalled", /6800/],
    ];
    it.each(leaks)("%s", async (_name, error, gone) => {
      const sentError = String((await sentBody(error)).error);
      expect(sentError).not.toMatch(gone);
      expect(sentError.length).toBeGreaterThan(0);
    });

    it("leaves what explains a failure untouched: the encoder's own words, versions that are not a driver's, and ordinary text", async () => {
      for (const keep of [
        "[h264_amf @ 0000028f] Error submitting video frame to the encoder",
        "[h264_nvenc @ 1] Driver does not support the required nvenc API version. Required: 12.2 Found: 12.0",
        "[h264_qsv @ 1] Error creating a MFX session: -9",
        "ffmpeg version 7.1.1 Copyright (c) 2000-2025 the FFmpeg developers",
        "ffmpeg render failed (code=-22): Conversion failed!",
        "x264 malloc of size 134217728 failed",
      ])
        expect((await sentBody(keep)).error, keep).toBe(keep);
    });
  });
  it("classifies reasons without inventing readiness from failure prose", async () => {
    expect(await sentBody("No such file C:/private/source.mp4")).toMatchObject({
      reason_code: "source_unavailable",
      readiness: "unknown",
    });
    expect(await sentBody("No space left on device /private/output.mp4")).toMatchObject({
      reason_code: "storage_full",
      readiness: "unknown",
    });
    expect(await sentBody("media_abc is offline; relink its private file")).toMatchObject({
      reason_code: "source_unavailable",
      readiness: "unknown",
    });
  });

  it.each(["done", "failed"] as const)(
    "does not upgrade %s to ready without explicit checked facts",
    async (status) => {
      const fetchMock = network();
      await reportExport({ status });
      await reportExport({ status, readiness: "ready" });
      expect(JSON.parse(String(fetchMock.mock.calls[0][1].body)).readiness).toBe("unknown");
      expect(JSON.parse(String(fetchMock.mock.calls[1][1].body)).readiness).toBe("ready");
    },
  );

  it("sends only the fields the server knows, every legitimate category intact, every number inside its bound", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1 }),
        fc.constantFrom(...EXPORT_REASON_CODES),
        fc.constantFrom(...EXPORT_SIZE_BANDS),
        fc.constantFrom(...EXPORT_OPERATIONS),
        fc.oneof(
          fc.double(),
          fc.constantFrom(Number.NaN, Infinity, -Infinity, -1, 0, 1e30, Number.MAX_VALUE),
        ),
        async (text, reason, band, operation, weird) => {
          const fetchMock = network();
          await reportExport({
            status: "failed",
            elapsed_ms: weird,
            active_ms: weird,
            error: text,
            project_id: text,
            quality: text,
            duration_s: weird,
            size_bytes: weird,
            width: weird,
            height: weird,
            fps: weird,
            warnings: weird,
            reason_code: reason,
            project_size_band: band,
            operation,
            readiness: "ready",
            // Fields nothing should ever send, even when a caller's object carries them.
            ...{ filename: text, content: text, user_id: text, email: text },
          });
          const request = fetchMock.mock.calls[0][1];
          const body = JSON.parse(String(request.body));
          expect((request.headers as Record<string, string>).Authorization).toBe(
            "Bearer tok_alice",
          );
          expect(Object.keys(body).sort()).toEqual(REPORT_KEYS);
          expect(body).toMatchObject({
            reason_code: reason,
            project_size_band: band,
            operation,
            readiness: "ready",
          });
          for (const [key, max] of Object.entries(SERVER_BOUNDS)) {
            expect(Number.isFinite(body[key]), key).toBe(true);
            expect(body[key], key).toBeGreaterThanOrEqual(0);
            expect(body[key], key).toBeLessThanOrEqual(max);
          }
          expect(String(body.error).length).toBeLessThanOrEqual(MAX_EXPORT_ERROR);
          expect(String(body.project_id).length).toBeLessThanOrEqual(200);
          expect(String(body.quality).length).toBeLessThanOrEqual(20);
        },
      ),
      { numRuns: 40 },
    );
  });

  it("never turns telemetry failure into an export failure or sign-in flow", async () => {
    network();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    await expect(
      reportExport({ status: "done", width: 1080, height: 1920, elapsed_ms: 12 }),
    ).resolves.toBeUndefined();
  });

  it("survives a session provider that is itself failing", async () => {
    setClerkTokenProvider(async () => {
      throw new Error("clerk unavailable");
    });
    vi.stubGlobal("fetch", vi.fn());
    await expect(reportExport({ status: "done" })).resolves.toBeUndefined();
  });
});

// What HAPPENED to the export (Phase 3, S1): the ordered trace and the run facts. Optional and additive:
// a report without them is the report it always was (pinned by REPORT_KEYS above), one with them sends
// the trace as a list and every number inside the server's range.
const STORY: TraceEvent[] = [
  { e: "requested", t: 0, v: "chat", n: 0, m: 0 },
  { e: "dialog_shown", t: 1200, v: "confirm", n: 0, m: 0 },
  { e: "dialog_choice", t: 4100, v: "continue", n: 0, m: 0 },
  { e: "stage", t: 4300, v: "rendering", n: 0, m: 0 },
  { e: "stall_detected", t: 70_000, v: "", n: 61, m: 38 },
  { e: "outcome", t: 71_200, v: "failed", n: 71, m: 0 },
];

describe("the export report's decoration", () => {
  it("sends the trace as a list and the run facts as numbers, only when the app measured them", async () => {
    const body = await sent({
      status: "failed",
      trace: STORY,
      engine: "streamed",
      limit: "resident",
      started_by: "chat",
      peak_resident_mib: 3712,
      resident_limit_mib: 3584,
      ram_free_gib: 6,
      longest_gap_s: 61,
    });
    expect(body.trace).toEqual(STORY);
    expect(body).toMatchObject({
      engine: "streamed",
      limit: "resident",
      started_by: "chat",
      peak_resident_mib: 3712,
      resident_limit_mib: 3584,
      ram_free_gib: 6,
      longest_gap_s: 61,
    });
    // What was not measured is absent, never a zero that reads as a measurement.
    expect(body).not.toHaveProperty("peak_commit_mib");
    expect(body).not.toHaveProperty("ram_total_gib");
  });

  it("is absent altogether when nothing happened worth saying", async () => {
    const body = await sent({ status: "done", trace: [] });
    expect(Object.keys(body).sort()).toEqual(REPORT_KEYS);
  });

  it("keeps a trace through the outbox as flat text and sends it as a list again", () => {
    const flat = composeBody({ status: "failed", trace: STORY }) as Record<string, unknown>;
    expect(typeof flat.trace).toBe("string");
    expect(wireBody(flat as never).trace).toEqual(STORY);
    // The flat body is what the outbox stores, and the outbox accepts it.
    const again = composeBody(flat) as Record<string, unknown>;
    expect(again.trace).toBe(flat.trace);
  });

  it("composes a body with every field set that the outbox still accepts, trace included", () => {
    const biggest: TraceEvent[] = Array.from({ length: EXPORT_TRACE_MAX_EVENTS }, () => ({
      e: "interrupted_found",
      t: 604_800_000,
      v: "person_dialog",
      n: 2_147_483_647,
      m: 2_147_483_647,
    }));
    const body = composeBody({
      status: "failed",
      trace: biggest,
      engine: "streamed",
      limit: "commit",
      started_by: "chat",
      ...Object.fromEntries(Object.entries(EXPORT_FACT_LIMITS)),
      error: "e".repeat(400),
      project_id: "p".repeat(400),
    })!;
    // Under the outbox's field count, and the report is queued (and read back) whole.
    expect(Object.keys(body).length).toBeLessThanOrEqual(40);
    const kept = queueReport(
      {
        id: "r-big",
        owner: "user_a",
        at: Math.floor(Date.now() / 1000),
        failedAt: 0,
        disposable: false,
        body,
      },
      Date.now(),
    );
    expect(kept).toBe(true);
    const [back] = pendingReports(Date.now());
    expect(decodeTrace(back.body.trace)).toEqual(biggest);
  });

  it("encodes the largest legitimate trace within the outbox's bound and loses nothing", () => {
    const biggest: TraceEvent[] = Array.from({ length: EXPORT_TRACE_MAX_EVENTS }, () => ({
      e: "interrupted_found",
      t: 604_800_000,
      v: "person_dialog",
      n: 2_147_483_647,
      m: 2_147_483_647,
    }));
    const text = encodeTrace(biggest);
    expect(text.length).toBeLessThanOrEqual(MAX_TRACE_TEXT);
    expect(decodeTrace(text)).toEqual(biggest);
  });

  it("turns anything that is not a trace into no trace, and never throws", () => {
    for (const junk of [
      null,
      undefined,
      5,
      "x",
      "a:b:c",
      "stage:1:rendering:2",
      ";;;;",
      {},
      [1, 2],
      "\u0000",
    ]) {
      expect(() => decodeTrace(junk)).not.toThrow();
      expect(() => cleanTrace(junk)).not.toThrow();
    }
    expect(decodeTrace("no_such_event:1::0:0")).toEqual([]);
    expect(decodeTrace("x".repeat(MAX_TRACE_TEXT + 1))).toEqual([]);
  });

  it("keeps only the closed vocabulary and numbers inside the server's range, whatever it is given", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            e: fc.oneof(fc.constantFrom(...EXPORT_TRACE_EVENTS), fc.string()),
            t: fc.oneof(fc.double(), fc.integer()),
            v: fc.oneof(fc.constantFrom(...EXPORT_TRACE_VALUES), fc.string()),
            n: fc.oneof(fc.double(), fc.integer()),
            m: fc.oneof(fc.double(), fc.integer()),
          }),
          { maxLength: 80 },
        ),
        (events) => {
          const cleaned = cleanTrace(events);
          expect(cleaned.length).toBeLessThanOrEqual(EXPORT_TRACE_MAX_EVENTS);
          for (const event of cleaned) {
            expect(EXPORT_TRACE_EVENTS).toContain(event.e);
            expect(
              event.v === "" || (EXPORT_TRACE_VALUES as readonly string[]).includes(event.v),
            ).toBe(true);
            for (const key of ["t", "n", "m"] as const) {
              expect(Number.isInteger(event[key])).toBe(true);
              expect(event[key]).toBeGreaterThanOrEqual(0);
            }
          }
          // The text form is lossless for whatever survived.
          expect(decodeTrace(encodeTrace(cleaned))).toEqual(cleaned);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("keeps a legitimate trace whole and in order", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            e: fc.constantFrom(...EXPORT_TRACE_EVENTS),
            t: fc.integer({ min: 0, max: 604_800_000 }),
            v: fc.constantFrom("" as const, ...EXPORT_TRACE_VALUES),
            n: fc.integer({ min: 0, max: 2_147_483_647 }),
            m: fc.integer({ min: 0, max: 2_147_483_647 }),
          }),
          { maxLength: EXPORT_TRACE_MAX_EVENTS },
        ),
        (events) => {
          expect(cleanTrace(events)).toEqual(events);
          expect(decodeTrace(encodeTrace(events))).toEqual(events);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("clamps every run fact into the range the server keeps, and drops what is not a number", async () => {
    const body = await sent({
      status: "failed",
      peak_resident_mib: 1e30,
      peak_commit_mib: -4,
      ram_total_gib: Number.NaN,
      ram_free_gib: 8,
      longest_gap_s: Infinity,
    });
    expect(body.peak_resident_mib).toBe(EXPORT_FACT_LIMITS.peak_resident_mib);
    expect(body.peak_commit_mib).toBe(0);
    expect(body).not.toHaveProperty("ram_total_gib");
    expect(body.ram_free_gib).toBe(8);
    expect(body).not.toHaveProperty("longest_gap_s");
  });

  it("drops a value outside the closed lists instead of sending it", async () => {
    const body = await sent({
      status: "failed",
      ...({ engine: "quantum", limit: "everything", started_by: "someone" } as object),
    });
    expect(body).not.toHaveProperty("engine");
    expect(body).not.toHaveProperty("limit");
    expect(body).not.toHaveProperty("started_by");
  });
});
