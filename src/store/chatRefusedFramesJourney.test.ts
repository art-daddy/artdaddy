// UJ-046 (the Zanzibar journey), replayed through the REAL loop and store: a person asks about a clip, the agent looks at it (three pictures
// are cut and shown to the model), and the next model round is refused because ONE of those pictures is. Only the network and the disk are
// faked; the loop, the store, the request builder and the picture reader are the app's own.
//
// What is checked is what the PERSON gets and what the NEXT request carries, never how the app got there. So this file imports nothing the
// fix added: run against the app before the fix it must go red, and it did (see the closure report).
//
//   deployed server: the provider refuses the whole request over that one picture and nothing says which. The app sends the same
//                    three pictures again on every message, so every message fails the same way (62 of 63 failing requests carried pictures).
//   fixed server:    the server finds the picture, leaves it out, answers, and names it in `refused_frames`.
import { beforeEach, describe, expect, it, vi } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const held = vi.hoisted(() => ({ store: null as unknown }));
vi.mock("../tools/host", () => ({
  openToolHost: vi.fn((id: string) => ({
    projectId: id,
    ready: Promise.resolve(),
    has: (name: string) => name === "inspect_media",
    run: vi.fn(async () => ({
      ok: true,
      summary: "3 frames from beach.mp4",
      _attachments: [0, 1, 2].map((i) => ({
        path: `f/call_9_${i}.jpg`,
        kind: "image",
        caption: `@${i}s`,
      })),
    })),
    store: () => held.store,
  })),
}));
vi.mock("../agent/api", () => ({ inferRound: vi.fn(), inferRoundStreaming: vi.fn() }));
vi.mock("../agent/attachments", () => ({ collectInferenceAttachments: vi.fn(async () => []) }));
vi.mock("./transcriptFile", () => ({
  loadClientSession: vi.fn(),
  persistSession: vi.fn(),
  persistSessionSoon: vi.fn(),
  persistSessionNow: vi.fn(async () => true),
}));

import { inferRoundStreaming } from "../agent/api";
import { ProjectStoreAccess, joinPath, type FsLike } from "../tools/store";
import { resetHistoryModeSupport, useChat } from "./chat";
import { useEditor } from "./editor";
import { persistSessionSoon } from "./transcriptFile";

class MemFs implements FsLike {
  bytes = new Map<string, Uint8Array>();
  async exists(p: string): Promise<boolean> {
    return this.bytes.has(joinPath(p));
  }
  async readTextFile(): Promise<string> {
    throw new Error("ENOENT");
  }
  async writeTextFile(): Promise<void> {}
  async readBytes(p: string): Promise<Uint8Array> {
    const v = this.bytes.get(joinPath(p));
    if (!v) throw new Error("ENOENT");
    return v;
  }
  async mkdir(): Promise<void> {}
}

const JPEG = new Uint8Array([
  0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x10, 0x00, 0x20, 0x03,
]);
const DIR = "C:/proj";
const POISON = "call_9#1"; // the second of the three pictures: the one the provider refuses
const BLOCKED = "azure error: Image processing blocked due to content policy violation.";

let server: "deployed" | "fixed" = "fixed";
type Body = {
  round_input: { user_text?: string; tool_results?: unknown[] };
  history_frames: Array<{ call_id: string; index: number }>;
  transcript: { requests: Array<{ response: Array<Record<string, unknown>> }> };
};
const requests: Body[] = [];

const keys = (b: Body) => b.history_frames.map((f) => `${f.call_id}#${f.index}`);

/** The server and the provider behind it, as far as this journey needs them. */
function serve(body: Body): Record<string, unknown> {
  requests.push(body);
  const text = body.round_input.user_text;
  if (text === "what happens in the beach clip?")
    return {
      kind: "tool_calls",
      pending_calls: [
        { call_id: "call_9", name: "inspect_media", arguments: { media_ref: "beach" } },
      ],
      final_text: "",
      error: "",
      finish_reason: "tool_calls",
      usage: {},
      provider_snapshot: {},
      history_mode: "client",
    };
  const ok = {
    kind: "text",
    pending_calls: [],
    final_text: "A beach at sunset.",
    error: "",
    finish_reason: "stop",
    usage: {},
    provider_snapshot: {},
    history_mode: "client",
  };
  if (!keys(body).includes(POISON)) return ok;
  return server === "fixed"
    ? { ...ok, refused_frames: [{ call_id: "call_9", index: 1 }] }
    : {
        kind: "error",
        pending_calls: [],
        final_text: "",
        error: BLOCKED,
        error_code: "content_policy",
        finish_reason: "",
        usage: {},
        provider_snapshot: {},
      };
}

async function ask(text: string) {
  await useChat.getState().send(text);
}

const turns = () => useChat.getState().turns;
const parts = () => turns().flatMap((t) => t.parts);
const sentOf = (b: Body) => keys(b).sort();
const noticeParts = () => parts().filter((p) => p.kind === "notice");

beforeEach(() => {
  vi.clearAllMocks();
  requests.length = 0;
  resetHistoryModeSupport();
  const fs = new MemFs();
  for (let i = 0; i < 3; i++) fs.bytes.set(joinPath(DIR, `f/call_9_${i}.jpg`), JPEG);
  held.store = new ProjectStoreAccess(DIR, fs);
  (inferRoundStreaming as Any).mockImplementation(async (body: Body) => serve(body));
  useEditor.setState({
    projectId: "p1",
    store: { projectDir: DIR, writeProjectText: vi.fn() } as Any,
    timeline: null,
  });
  useChat.setState({
    projectId: "p1",
    turns: [],
    session: null,
    providerSnapshot: null,
    streaming: false,
    pending: null,
    closing: false,
    error: null,
    model: "gpt-5.4",
    effort: "high",
    mode: "autopilot",
  });
});

describe("the person asks about a clip and the provider refuses one of its pictures: the fixed server", () => {
  beforeEach(() => {
    server = "fixed";
  });

  it("answers the first message, and says once that a picture was left out", async () => {
    await ask("what happens in the beach clip?");
    expect(turns()).toHaveLength(1);
    expect(turns()[0].status).toBe("done");
    expect(parts().some((p) => p.kind === "text" && p.text === "A beach at sunset.")).toBe(true);
    expect(parts().some((p) => p.kind === "error")).toBe(false);
    expect(noticeParts()).toHaveLength(1);
    expect(String(noticeParts()[0].text)).toMatch(/refused 1 picture/);
  });

  it("the NEXT message no longer carries the refused picture, and the transcript says which one it was", async () => {
    await ask("what happens in the beach clip?");
    const round2 = requests.at(-1)!;
    expect(sentOf(round2)).toEqual(["call_9#0", "call_9#1", "call_9#2"]); // the round that was refused carried all three

    await ask("now trim the first five seconds");
    const next = requests.at(-1)!;
    expect(next.round_input.user_text).toBe("now trim the first five seconds");
    expect(sentOf(next)).toEqual(["call_9#0", "call_9#2"]); // the same pictures, minus exactly the refused one
    const shown = next.transcript.requests
      .flatMap((r) => r.response)
      .find((p) => p.kind === "tool_result" && p.call_id === "call_9") as {
      frame_refs: Array<Record<string, unknown>>;
    };
    expect(shown.frame_refs.map((r) => r.refused === true)).toEqual([false, true, false]);
  });

  it("the second message is answered and the person is not told again", async () => {
    await ask("what happens in the beach clip?");
    await ask("now trim the first five seconds");
    expect(turns().map((t) => t.status)).toEqual(["done", "done"]);
    expect(noticeParts()).toHaveLength(1);
    expect(parts().some((p) => p.kind === "error")).toBe(false);
  });

  it("keeps the picture out after the app is closed and opened again", async () => {
    await ask("what happens in the beach clip?");
    const saved = (persistSessionSoon as Any).mock.calls.at(-1)[1].requests;
    const file = JSON.parse(JSON.stringify(saved));
    expect(file[0].response.find((p: Any) => p.kind === "tool_result").frame_refs[1].refused).toBe(
      true,
    );
  });
});

describe("the same journey on a server that does not name pictures (the one deployed today)", () => {
  beforeEach(() => {
    server = "deployed";
  });

  it("fails the way it always did, and the app does not invent a notice", async () => {
    await ask("what happens in the beach clip?");
    expect(turns()[0].status).toBe("error");
    expect(parts().at(-1)).toMatchObject({ kind: "error", error: BLOCKED });
    expect(noticeParts()).toEqual([]);
  });

  it("changes nothing in what the next message carries: the same three pictures", async () => {
    await ask("what happens in the beach clip?");
    await ask("try again");
    expect(sentOf(requests.at(-1)!)).toEqual(["call_9#0", "call_9#1", "call_9#2"]);
  });
});
