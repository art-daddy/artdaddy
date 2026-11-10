import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/desktop", () => ({ storeForProject: vi.fn() }));

import { chatDisk, CHAT_DIR } from "../test/chatDisk";
import { joinPath } from "../tools/store";
import { chatFileId, chatFilePath, chatMetaPath, CHAT_SESSIONS_REL, isChatId } from "./chatFiles";
import { chatTitle, CHAT_TITLE_MAX, isRestoreRecord } from "./chatTranscript";
import { JOB_WAKE_LEAD } from "./jobNotes";
import {
  archiveSession,
  deleteArchivedSession,
  listArchivedSessions,
  loadSession,
  persistSession,
  readArchivedSession,
  SESSION_REL,
  type ClientSession,
} from "./transcriptFile";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const SESSIONS = joinPath(CHAT_DIR, CHAT_SESSIONS_REL);
const OPEN = joinPath(CHAT_DIR, SESSION_REL);

const tl = (label: string): Any => ({
  fps: 30,
  tracks: [{ id: "v1", clips: [{ id: label, media_ref: `library/media_${label}.mp4` }] }],
});

function chat(text: string, extra: Partial<ClientSession> = {}): ClientSession {
  return {
    requests: [
      {
        id: `req-${text}`,
        message: { text, attachments: [] },
        response: [{ kind: "text", text: `answer to ${text}` }],
        undone: false,
        checkpoint: { timeline: tl("before"), timeline_after: tl("after") },
      },
    ],
    providerSnapshot: null,
    transcriptId: A,
    session: null,
    ...extra,
  };
}

describe("chatTitle", () => {
  it("is the first message, on one line", () => {
    expect(chatTitle(["  make   it\n\nshorter  ", "second"])).toBe("make it shorter");
  });

  it("cuts a long first message and says so", () => {
    const title = chatTitle(["x".repeat(200)]);
    expect(Array.from(title)).toHaveLength(CHAT_TITLE_MAX + 1);
    expect(title.endsWith("…")).toBe(true);
  });

  it("never names a chat by the app's own wake prompt", () => {
    const wake = `${JOB_WAKE_LEAD}\n- a clip is ready (media_1)`;
    expect(chatTitle([wake, "add captions"])).toBe("add captions");
    expect(chatTitle([wake])).toBe("New chat");
  });

  it("falls back to New chat when nothing was said", () => {
    expect(chatTitle([])).toBe("New chat");
    expect(chatTitle(["", "   \n "])).toBe("New chat");
  });

  it("never throws, never runs long, never breaks a character (any text)", () => {
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    fc.assert(
      fc.property(fc.array(fc.string({ unit: "grapheme" }), { maxLength: 4 }), (messages) => {
        const title = chatTitle(messages);
        expect(Array.from(title).length).toBeLessThanOrEqual(CHAT_TITLE_MAX + 1);
        expect(title).not.toMatch(/[\r\n]/);
        expect(title).not.toMatch(lone);
        expect(title.length).toBeGreaterThan(0);
      }),
    );
  });

  it("a title cut inside an emoji keeps the whole emoji or none of it", () => {
    const title = chatTitle(["😀".repeat(60)]);
    expect(Array.from(title).filter((c) => c === "😀")).toHaveLength(CHAT_TITLE_MAX);
  });
});

describe("chat ids are file names, never paths", () => {
  it("accepts every id this app mints (a UUID)", () => {
    fc.assert(
      fc.property(fc.uuid(), (id) => {
        expect(isChatId(id)).toBe(true);
      }),
    );
  });

  it("refuses anything that could leave the folder or name another file", () => {
    fc.assert(
      fc.property(
        fc.string().filter((s) => /[./\\:\s%]/.test(s) || s === ""),
        (id) => {
          expect(isChatId(id)).toBe(false);
        },
      ),
    );
    for (const id of ["..", "../x", "a/b", "a\\b", "a.b", ".hidden", "x.json", "C:evil", ""]) {
      expect(isChatId(id)).toBe(false);
    }
  });

  it("only an `<id>.json` entry is a chat: not its summary, a temp, or a corrupt copy", () => {
    expect(chatFileId(`${A}.json`)).toBe(A);
    for (const name of [
      `${A}.meta.json`,
      `${A}.tmp-ab12cd.json`,
      `${A}.json.corrupt-1700000000000`,
      `${A}.json.tmp-ab12cd`,
      "notes.txt",
      ".json",
      "../x.json",
    ])
      expect(chatFileId(name)).toBeNull();
  });
});

describe("the open chat's file", () => {
  it("is written exactly as before when the chat has no restore record (old apps read it)", async () => {
    const { fs, store } = chatDisk();
    const session: ClientSession = {
      requests: [{ id: "r1", message: { text: "hi" } }],
      providerSnapshot: { previous_response_id: "r" },
      transcriptId: A,
      session: null,
    };
    await persistSession(store, session);
    // The frozen v0.26.0 shape: these keys, in this order, indented by two.
    expect(fs.files.get(OPEN)).toBe(
      [
        "{",
        '  "version": 1,',
        `  "id": "${A}",`,
        '  "requests": [',
        "    {",
        '      "id": "r1",',
        '      "message": {',
        '        "text": "hi"',
        "      }",
        "    }",
        "  ],",
        '  "provider_snapshot": {',
        '    "previous_response_id": "r"',
        "  },",
        '  "session": null',
        "}",
      ].join("\n"),
    );
  });

  it("carries a restore record, and an older reader still opens the chat from it", async () => {
    const { fs, store } = chatDisk();
    const restore = { turnId: "t2", before: tl("live"), hid: ["t2", "t3"] };
    await persistSession(store, chat("hi", { restore }));
    const written = fs.json(OPEN) as Any;
    // v0.26.0's reader: requests must be an array; everything else it ignores.
    expect(Array.isArray(written.requests)).toBe(true);
    expect(written.restore).toEqual(restore);
    expect((await loadSession(store)).restore).toEqual(restore);
  });

  it("drops a restore record that is not the shape it was written in", async () => {
    const { fs, store } = chatDisk();
    for (const bad of [
      null,
      7,
      "x",
      { turnId: 1, hid: [] },
      { turnId: "t", hid: "t" },
      { turnId: "t", hid: [1] },
    ]) {
      fs.files.set(OPEN, JSON.stringify({ requests: [], restore: bad }));
      expect((await loadSession(store)).restore).toBeUndefined();
    }
  });

  it("isRestoreRecord never throws on any JSON and accepts what it writes", () => {
    fc.assert(
      fc.property(fc.anything(), (v) => {
        expect(typeof isRestoreRecord(v)).toBe("boolean");
      }),
    );
    fc.assert(
      fc.property(fc.string(), fc.array(fc.string()), (turnId, hid) => {
        expect(isRestoreRecord({ turnId, before: null, hid })).toBe(true);
      }),
    );
  });
});

describe("putting a chat away", () => {
  it("writes the whole chat and a summary, and reads back the same chat", async () => {
    const { fs, store } = chatDisk();
    const session = chat("make the intro punchier", {
      providerSnapshot: { previous_response_id: "stale" },
      session: { cost_usd: 0.5, input_tokens: 9 } as Any,
      restore: { turnId: "t1", before: tl("live"), hid: ["t1"] },
    });
    expect(await archiveSession(store, A, session, "2026-11-10T10:00:00.000Z")).toBe(true);

    expect(fs.names(SESSIONS)).toEqual([`${A}.json`, `${A}.meta.json`]);
    const meta = fs.json(chatMetaPath(CHAT_DIR, A)) as Any;
    expect(meta).toMatchObject({ id: A, title: "make the intro punchier" });
    expect(meta.updated_at).toBe("2026-11-10T10:00:00.000Z");

    const back = await readArchivedSession(store, A);
    // Every checkpoint and the restore record survive: a chat is restorable from where it was put away.
    expect(back?.requests).toEqual(session.requests);
    expect(back?.restore).toEqual(session.restore);
    expect(back?.session).toEqual(session.session);
    expect(back?.transcriptId).toBe(A);
    // The provider chain belongs to the chat that was live; a put-away one is rebuilt from its transcript.
    expect(back?.providerSnapshot).toEqual({ previous_response_id: "stale" });
  });

  it("files the chat under the id it is given, not the one inside it", async () => {
    const { fs, store } = chatDisk();
    await archiveSession(store, B, chat("x", { transcriptId: A }), "2026-11-10T10:00:00.000Z");
    expect(fs.names(SESSIONS)).toContain(`${B}.json`);
    expect((await readArchivedSession(store, B))?.transcriptId).toBe(B);
  });

  it("refuses an id that is not a file name, and writes nothing", async () => {
    const { fs, store } = chatDisk();
    for (const id of ["../transcript", "..", "a/b", "x.y", ""]) {
      expect(await archiveSession(store, id, chat("x"), "2026-11-10T10:00:00.000Z")).toBe(false);
    }
    expect(fs.writes).toEqual([]);
    expect(fs.files.size).toBe(0);
  });

  it("reports a write the disk refused instead of claiming the chat was saved", async () => {
    const { fs, store } = chatDisk();
    fs.failWrite = (p) => p.includes("/chat/sessions/");
    await expect(archiveSession(store, A, chat("x"), "2026-11-10T10:00:00.000Z")).rejects.toThrow();
    expect(fs.names(SESSIONS)).toEqual([]);
  });

  it("still counts as put away when only the summary could not be written", async () => {
    const { fs, store } = chatDisk();
    fs.failWrite = (p) => p.includes(".meta");
    expect(await archiveSession(store, A, chat("x"), "2026-11-10T10:00:00.000Z")).toBe(true);
    expect(fs.names(SESSIONS)).toEqual([`${A}.json`]);
    // ...and the list rebuilds what the summary would have said.
    fs.failWrite = null;
    expect(await listArchivedSessions(store)).toEqual([
      { id: A, title: "x", updatedAt: "2026-11-10T10:00:00.000Z" },
    ]);
    expect(fs.names(SESSIONS)).toContain(`${A}.meta.json`);
  });

  it("abandons the write once the project session has closed (nothing lands in a project the user left)", async () => {
    const { fs, store } = chatDisk();
    vi.spyOn(store, "sessionLive").mockReturnValue(false);
    expect(await archiveSession(store, A, chat("x"), "2026-11-10T10:00:00.000Z")).toBe(false);
    expect(fs.names(SESSIONS)).toEqual([]);
  });
});

describe("listing put-away chats", () => {
  async function putAway(store: Any, id: string, text: string, at: string) {
    await archiveSession(store, id, chat(text, { transcriptId: id }), at);
  }

  it("is newest first, titled by the first message", async () => {
    const { store } = chatDisk();
    await putAway(store, A, "older chat", "2026-11-08T10:00:00.000Z");
    await putAway(store, C, "newest chat", "2026-11-10T10:00:00.000Z");
    await putAway(store, B, "middle chat", "2026-11-09T10:00:00.000Z");
    expect((await listArchivedSessions(store)).map((c) => c.title)).toEqual([
      "newest chat",
      "middle chat",
      "older chat",
    ]);
  });

  it("is empty before any chat was put away", async () => {
    const { store } = chatDisk();
    expect(await listArchivedSessions(store)).toEqual([]);
  });

  it("leaves out the open chat when a crash left its copy here too", async () => {
    const { store } = chatDisk();
    await putAway(store, A, "open chat", "2026-11-10T10:00:00.000Z");
    await putAway(store, B, "another", "2026-11-09T10:00:00.000Z");
    expect((await listArchivedSessions(store, A)).map((c) => c.id)).toEqual([B]);
  });

  it("reads the small summaries, not the chats (they can be megabytes)", async () => {
    const { fs, store } = chatDisk();
    await putAway(store, A, "one", "2026-11-10T10:00:00.000Z");
    await putAway(store, B, "two", "2026-11-09T10:00:00.000Z");
    fs.reads.length = 0;
    await listArchivedSessions(store);
    expect(fs.reads.filter((p) => p.endsWith(`${A}.json`) || p.endsWith(`${B}.json`))).toEqual([]);
    expect(fs.reads).toHaveLength(2);
  });

  it("rebuilds a missing or corrupt summary from the chat itself", async () => {
    const { fs, store } = chatDisk();
    await putAway(store, A, "lost summary", "2026-11-10T10:00:00.000Z");
    await putAway(store, B, "torn summary", "2026-11-09T10:00:00.000Z");
    fs.files.delete(chatMetaPath(CHAT_DIR, A));
    fs.files.set(chatMetaPath(CHAT_DIR, B), '{"title": ');
    const list = await listArchivedSessions(store);
    expect(list).toEqual([
      { id: A, title: "lost summary", updatedAt: "2026-11-10T10:00:00.000Z" },
      { id: B, title: "torn summary", updatedAt: "2026-11-09T10:00:00.000Z" },
    ]);
    // The cache is put back, so the next list is cheap again.
    expect((fs.json(chatMetaPath(CHAT_DIR, A)) as Any).title).toBe("lost summary");
    expect((fs.json(chatMetaPath(CHAT_DIR, B)) as Any).title).toBe("torn summary");
  });

  it("skips a chat file that does not read, and keeps its bytes aside", async () => {
    const { fs, store } = chatDisk();
    await putAway(store, A, "fine", "2026-11-10T10:00:00.000Z");
    fs.files.set(chatFilePath(CHAT_DIR, B), "{not json");
    expect((await listArchivedSessions(store)).map((c) => c.id)).toEqual([A]);
    expect(fs.names(SESSIONS).some((n) => n.startsWith(`${B}.json.corrupt-`))).toBe(true);
  });

  it("ignores everything in the folder that is not a chat", async () => {
    const { fs, store } = chatDisk();
    await putAway(store, A, "the only chat", "2026-11-10T10:00:00.000Z");
    for (const stray of ["notes.txt", `${B}.tmp-ab12cd.json`, `${B}.json.corrupt-1`, "..json"])
      fs.files.set(joinPath(SESSIONS, stray), "x");
    fs.files.set(joinPath(SESSIONS, "nested/inner.json"), "{}");
    expect((await listArchivedSessions(store)).map((c) => c.id)).toEqual([A]);
  });

  it("says so when the folder exists but cannot be listed, instead of reporting no chats", async () => {
    const { fs, store } = chatDisk();
    await putAway(store, A, "x", "2026-11-10T10:00:00.000Z");
    fs.failList = () => true;
    await expect(listArchivedSessions(store)).rejects.toThrow();
  });
});

describe("opening and deleting put-away chats", () => {
  it("reads nothing for an id that is not a file name (never another file of the project)", async () => {
    const { fs, store } = chatDisk();
    fs.files.set(OPEN, JSON.stringify({ requests: [{ id: "secret" }] }));
    for (const id of ["../../transcript", "..", "x/../../transcript"]) {
      expect(await readArchivedSession(store, id)).toBeNull();
    }
    fs.reads.length = 0;
    await readArchivedSession(store, "../transcript");
    expect(fs.reads).toEqual([]);
  });

  it("returns null for a chat that is not there or does not read", async () => {
    const { fs, store } = chatDisk();
    expect(await readArchivedSession(store, A)).toBeNull();
    fs.files.set(chatFilePath(CHAT_DIR, A), JSON.stringify({ no: "requests" }));
    expect(await readArchivedSession(store, A)).toBeNull();
  });

  it("deletes the chat and its summary, and only those", async () => {
    const { fs, store } = chatDisk();
    await archiveSession(store, A, chat("a"), "2026-11-10T10:00:00.000Z");
    await archiveSession(store, B, chat("b"), "2026-11-09T10:00:00.000Z");
    fs.files.set(OPEN, '{"requests":[]}');
    expect(await deleteArchivedSession(store, A)).toBe(true);
    expect(fs.names(SESSIONS)).toEqual([`${B}.json`, `${B}.meta.json`]);
    expect(fs.files.has(OPEN)).toBe(true);
  });

  it("deleting a chat that is already gone is not a failure", async () => {
    const { store } = chatDisk();
    expect(await deleteArchivedSession(store, A)).toBe(true);
  });

  it("reports false when the disk refuses, and the chat is still listed", async () => {
    const { fs, store } = chatDisk();
    await archiveSession(store, A, chat("a"), "2026-11-10T10:00:00.000Z");
    fs.failRemove = (p) => p.endsWith(`${A}.json`);
    expect(await deleteArchivedSession(store, A)).toBe(false);
    expect((await listArchivedSessions(store)).map((c) => c.id)).toEqual([A]);
  });

  it("never deletes anything outside the sessions folder, whatever the id", async () => {
    const { fs, store } = chatDisk();
    fs.files.set(OPEN, '{"requests":[]}');
    fs.files.set(joinPath(CHAT_DIR, "internals/timeline.json"), "{}");
    for (const id of ["..", "../transcript", "../../internals", "a/b"])
      expect(await deleteArchivedSession(store, id)).toBe(false);
    expect([...fs.files.keys()].sort()).toEqual([
      joinPath(CHAT_DIR, "internals/timeline.json"),
      OPEN,
    ]);
  });
});
