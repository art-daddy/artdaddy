import { beforeEach, describe, expect, it, vi } from "vitest";

import { disposeChatStore, getChatStore } from "./chat";
import { useEditor } from "./editor";
import { buildRequests } from "./chatTranscript";
import { loadClientSession } from "./transcriptFile";
import { inferRoundStreaming } from "../agent/api";
import type { RoundInput, RoundResultDTO } from "../agent/types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

// Tool-call debt, end to end: the REAL chat store and the REAL ClientTurnRunner, against a
// simulated server whose rules match production.
//
// The vendor (Azure Responses) holds the conversation as a CHAIN of responses. Continuing a
// chain (previous_response_id) with calls still awaiting output is refused ("No tool output
// found"); sending an output for a call the chain does not hold is refused ("No tool call
// found for function call output"). A request with NO chain is a fresh conversation, so any
// output it carries is orphaned by definition.
//
// Our server HEALS both refusals (turn/providers/azure.py _generate): it drops the chain and
// retries with the whole history re-sent as plain text. So a mismatch does not break the chat
// — it silently costs a refused request, a full-history resend, and the provider-side state.
// `resets` counts exactly that, and a correct client should cause none.
//
// chat.test.ts mocks the runner and chatTranscript.test.ts tests the recovery rule alone, so no
// test drove store + runner + a provider-shaped server together. That seam is where the debt
// lives: the store computes what is owed, the runner sends it, and nothing records the payment.

vi.mock("../tools/host", () => ({
  openToolHost: vi.fn((id: string) => ({
    projectId: id,
    ready: Promise.resolve(),
    has: () => true,
    run: vi.fn((name: string) => hostRun(name)),
    store: () => null,
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

/** How the next tool run behaves; a never-settling promise models the process dying mid-tool. */
let hostRun: (name: string) => Promise<unknown> = async () => ({ ok: true });

interface Server {
  /** response id -> calls that response issued and that are still awaiting output */
  chains: Map<string, Set<string>>;
  resets: string[];
  requests: RoundInput[];
  script: RoundResultDTO[];
}
let server: Server;
let ids = 0;

function toolCalls(...names: string[]): RoundResultDTO {
  return {
    kind: "tool_calls",
    pending_calls: names.map((name) => ({ call_id: `call_${++ids}`, name, arguments: {} })),
    usage: {},
  } as Any;
}
const text = (t: string): RoundResultDTO => ({ kind: "text", final_text: t, usage: {} }) as Any;

function installServer(): void {
  server = { chains: new Map(), resets: [], requests: [], script: [] };
  (inferRoundStreaming as Any).mockImplementation(
    async (body: { round_input: RoundInput; provider_snapshot?: Any }) => {
      const ri = body.round_input;
      server.requests.push(ri);
      const prev: string = body.provider_snapshot?.previous_response_id ?? "";
      const awaiting = prev ? (server.chains.get(prev) ?? new Set<string>()) : new Set<string>();
      const sent = (ri.tool_results ?? []).map((t) => t.call_id);
      const orphan = sent.find((id) => !awaiting.has(id));
      const missing = [...awaiting].find((id) => !sent.includes(id));
      if (orphan) server.resets.push(`No tool call found for function call output ${orphan}`);
      else if (missing) server.resets.push(`No tool output found for function call ${missing}`);
      // Either way the server answers (healed or not), so the turn itself completes.
      const reply = server.script.shift() ?? text("ok");
      const respId = `resp_${server.requests.length}`;
      server.chains.set(
        respId,
        new Set(((reply as Any).pending_calls ?? []).map((c: Any) => String(c.call_id))),
      );
      return { ...reply, provider_snapshot: { previous_response_id: respId } };
    },
  );
}

const PID = "debt";
const chat = () => getChatStore(PID).getState();
const tick = () => new Promise((r) => setTimeout(r, 0));

/** Start a turn whose tool is still running when the "process dies". */
async function sendAndDieMidTool(msg: string): Promise<void> {
  hostRun = () => new Promise(() => {});
  void chat().send(msg);
  for (let i = 0; i < 5; i++) await tick();
}

/** Kill the process: discard all in-memory state, reload from what was on disk. */
async function relaunch(): Promise<void> {
  const requests = buildRequests(chat().turns);
  const providerSnapshot = chat().providerSnapshot;
  disposeChatStore(PID);
  (loadClientSession as Any).mockResolvedValueOnce({
    requests,
    transcriptId: "tx",
    session: null,
    providerSnapshot,
  });
  await chat().load(PID);
  getChatStore(PID).setState({ mode: "autopilot" });
  hostRun = async () => ({ ok: true });
}

async function send(msg: string): Promise<void> {
  const before = server.requests.length;
  await chat().send(msg);
  for (let i = 0; i < 5; i++) await tick();
  // Guard the guard: a send that silently no-ops would make every assertion below vacuous.
  expect(server.requests.length, `"${msg}" never reached the server`).toBeGreaterThan(before);
}

beforeEach(async () => {
  vi.clearAllMocks();
  ids = 0;
  hostRun = async () => ({ ok: true });
  installServer();
  useEditor.setState({ projectId: null, store: null, timeline: null });
  disposeChatStore(PID);
  (loadClientSession as Any).mockResolvedValue({
    requests: [],
    transcriptId: "tx",
    session: null,
    providerSnapshot: null,
  });
  await chat().load(PID);
  getChatStore(PID).setState({ mode: "autopilot" });
});

describe("tool-call debt across the real store + runner, judged by a provider-shaped server", () => {
  it("a healthy multi-round conversation never forces a reset", async () => {
    server.script.push(toolCalls("get_timeline"), text("done"));
    await send("look at my timeline");
    await send("thanks");
    expect(server.resets).toEqual([]);
  });

  // The reported strand (3ba29aa): the app dies while a tool runs. The call is on disk, its
  // output is not, and the chain is still waiting for it.
  it("pays a call the app died in the middle of", async () => {
    server.script.push(toolCalls("add_track"));
    await sendAndDieMidTool("add a track");
    await relaunch();
    await send("are you there?");
    expect(server.resets).toEqual([]);
  });

  // The ordering after that: recovery PAYS the debt, the model answers in plain text, the user
  // writes again. The payment was sent but never written to the transcript, so the only record
  // of the call is still an unanswered tool_call two turns back.
  //
  // KNOWN BUG (found 2026-09-27; unreleased, introduced with the 3ba29aa walk-back): the next
  // message re-sends the settled output, forcing a silent chain reset. Remove `.fails` when fixed.
  it.fails("does not re-pay a debt the recovery round already settled", async () => {
    server.script.push(toolCalls("add_track"));
    await sendAndDieMidTool("add a track");
    await relaunch();
    server.script.push(text("Sorry, the app closed before that finished. Retry?"));
    await send("are you there?");
    await send("yes please");
    expect(server.resets).toEqual([]);
  });

  // The opposite ordering: the batch's FIRST call finished and its result reached disk, the app
  // died during the SECOND, and neither output was sent (the runner sends a batch's outputs
  // together once it drains). The transcript shows an answered call, which the recovery rule
  // reads as proof the provider accepted it — so only the unfinished call is owed.
  //
  // KNOWN BUG (found 2026-09-27): the finished call's output never reaches the provider, forcing
  // a silent chain reset. Remove `.fails` when fixed.
  it.fails("pays every call of a batch the app died in, including one that finished", async () => {
    server.script.push(toolCalls("add_track", "add_track"));
    let runs = 0;
    hostRun = () => (++runs === 1 ? Promise.resolve({ ok: true }) : new Promise(() => {}));
    void chat().send("add two tracks");
    for (let i = 0; i < 6; i++) await tick();
    await relaunch();
    await send("are you there?");
    expect(server.resets).toEqual([]);
  });
});
