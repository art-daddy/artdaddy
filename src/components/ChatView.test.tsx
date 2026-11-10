import { render, screen, fireEvent, waitFor, act, within } from "@testing-library/react";
import { StrictMode } from "react";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const state: any = {};
const authState: any = { status: "unlocked", verify: vi.fn() };
vi.mock("../store/chat", () => ({ useChat: () => state }));
vi.mock("../store/auth", () => ({ useAuth: (sel: any) => sel(authState) }));
let platformName = "web";
vi.mock("../platform", () => ({
  get platform() {
    return { name: platformName, capabilities: { localTools: true, fileSystem: true } };
  },
}));
vi.mock("../lib/upload", async (importOriginal) => {
  // The doors' own helpers are the real ones: what a drop turns away is part of what these tests are about.
  const real = await importOriginal<typeof import("../lib/upload")>();
  return {
    uploadFiles: vi.fn(),
    importViaDialog: vi.fn(async () => null), // web by default: callers fall back to the input
    importPaths: vi.fn(async () => []),
    importFootage: vi.fn(async () => []),
    filesFromItems: vi.fn(() => []),
    MEDIA_RE: real.MEDIA_RE,
    acceptDroppedPaths: real.acceptDroppedPaths,
    acceptDroppedFiles: real.acceptDroppedFiles,
  };
});
vi.mock("../lib/files", () => ({ listProjectFiles: () => Promise.resolve([]) }));
// What a drop turns away is reported (the editor stream and the funnel marker): captured here, not sent.
vi.mock("../api/editorEvents", async (orig) => ({
  ...(await orig<typeof import("../api/editorEvents")>()),
  recordImport: vi.fn(),
}));
vi.mock("../api/appEvents", async (orig) => ({
  ...(await orig<typeof import("../api/appEvents")>()),
  reportMediaImport: vi.fn(),
}));
// The approval bar asks the server what a generation may cost; these tests must not reach for the network.
vi.mock("../api/quote", () => ({ quoteHold: vi.fn(async () => null) }));
// Stable snapshot (same reference each call) so useSyncExternalStore doesn't loop — which is
// also why `over` is flipped in place rather than the object being replaced.
const usageMock = vi.hoisted(() => ({
  metered: true,
  over: false,
  globalPaused: undefined as true | undefined,
  used: 10,
  limit: 100,
  remaining: 1_500_000,
  held: undefined as number | undefined,
}));
vi.mock("../api/usage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/usage")>()),
  getUsage: () => usageMock,
  subscribeUsage: () => () => {},
  refreshUsage: vi.fn(),
}));

const startDesktopSignIn = vi.hoisted(() => vi.fn());
vi.mock("../api/desktopAuth", () => ({ startDesktopSignIn }));

import {
  uploadFiles,
  importViaDialog,
  importPaths,
  importFootage,
  filesFromItems,
} from "../lib/upload";
import { recordImport } from "../api/editorEvents";
import { refusedNotice } from "../agent/refusedFrames";
import { DISCORD_URL } from "../lib/community";
import { toUserMessage } from "../lib/errors";
import {
  peekFirstFootage,
  peekFirstPrompt,
  setFirstPrompt,
  takeFirstPrompt,
} from "../store/firstPrompt";
import { useEditor } from "../store/editor";
import ChatView from "./ChatView";
import { resetLiveWait, useLiveWait } from "../store/liveWait";
import { STARTER_PROMPTS } from "./starterPrompts";
import { useCompatibility } from "../update/compatibility";

function baseState() {
  return {
    turns: [],
    projectId: "p1",
    transcriptId: "chat-p1",
    closing: false,
    switching: false,
    rewind: null,
    restored: null,
    streaming: false,
    pending: null,
    session: null,
    model: "gpt-5.6-luna",
    effort: "high",
    mode: "default",
    error: null,
    pendingMentions: [],
    addMention: vi.fn(),
    removeMention: vi.fn(),
    clearMentions: vi.fn(),
    canContinue: false,
    continueRun: vi.fn(),
    canRetry: false,
    retry: vi.fn(),
    setControls: vi.fn(),
    send: vi.fn(),
    approve: vi.fn(),
    deny: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
    restoreTo: vi.fn(),
    newChat: vi.fn(async () => true),
    listChats: vi.fn(async () => []),
    openChat: vi.fn(async () => true),
    deleteChat: vi.fn(async () => true),
    undoRestore: vi.fn(async () => true),
    confirmRewind: vi.fn(async () => null),
    cancelRewind: vi.fn(),
    stop: vi.fn(),
    sendFeedback: vi.fn(async () => true),
  };
}

beforeEach(() => {
  setFirstPrompt("", "");
  vi.mocked(recordImport).mockClear();
  Object.assign(state, baseState());
  authState.status = "unlocked";
  platformName = "web";
  useCompatibility.setState({ status: "allowed" });
  usageMock.over = false;
  usageMock.globalPaused = undefined;
  usageMock.remaining = 1_500_000;
  usageMock.used = 10;
  usageMock.limit = 100;
  usageMock.held = undefined;
  vi.mocked(importPaths).mockResolvedValue([]);
  vi.mocked(importFootage).mockResolvedValue([]);
  vi.mocked(filesFromItems).mockReturnValue([]);
  useEditor.setState({ projectId: null, store: null });
});

describe("ChatView", () => {
  it("only retains nonempty first requests and consumes them for the owning project once", () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        setFirstPrompt("first-property", text);
        const expected = text.trim() || null;
        expect(peekFirstPrompt("first-property")).toBe(expected);
        expect(takeFirstPrompt("unrelated-project")).toBeNull();
        expect(takeFirstPrompt("first-property")).toBe(expected);
        expect(takeFirstPrompt("first-property")).toBeNull();
      }),
    );
    setFirstPrompt("", "Must not be queued without a project");
    expect(peekFirstPrompt("")).toBeNull();
    setFirstPrompt("", "");
  });

  it("shows the waiting request when its project arrives before sign-in", () => {
    setFirstPrompt("p1", "Make my reel");
    state.projectId = null;
    state.transcriptId = null;
    authState.status = "checking";
    const view = render(<ChatView />);
    expect(screen.getByPlaceholderText(/Message the editor/)).toHaveValue("");
    state.projectId = "p1";
    view.rerender(<ChatView />);
    expect(screen.getByPlaceholderText(/Message the editor/)).toHaveValue("Make my reel");
    expect(state.send).not.toHaveBeenCalled();
  });

  it("submits the start-screen prompt as the first turn without a second click", async () => {
    setFirstPrompt("p1", "Create a creative Instagram reel");
    const view = render(<ChatView />);
    await waitFor(() =>
      expect(state.send).toHaveBeenCalledWith("Create a creative Instagram reel", []),
    );
    expect(state.send).toHaveBeenCalledTimes(1);
    expect(screen.getByPlaceholderText(/Message the editor/)).toHaveValue("");
    view.unmount();
    render(<ChatView />);
    expect(state.send).toHaveBeenCalledTimes(1);
  });

  it("waits for transcript loading before starting the first turn", () => {
    setFirstPrompt("p1", "Make my reel");
    state.transcriptId = null;
    const view = render(<ChatView />);
    expect(state.send).not.toHaveBeenCalled();
    expect(screen.getByPlaceholderText(/Message the editor/)).toHaveValue("Make my reel");
    state.transcriptId = "loaded-chat";
    view.rerender(<ChatView />);
    expect(state.send).toHaveBeenCalledWith("Make my reel", []);
    expect(state.send).toHaveBeenCalledTimes(1);
  });

  it("waits for sign-in without losing the start-screen prompt", () => {
    setFirstPrompt("p1", "Make my reel");
    authState.status = "checking";
    const view = render(<ChatView />);
    expect(state.send).not.toHaveBeenCalled();
    authState.status = "unlocked";
    view.rerender(<ChatView />);
    expect(state.send).toHaveBeenCalledWith("Make my reel", []);
    expect(state.send).toHaveBeenCalledTimes(1);
  });

  it("never gives the queued first prompt to another project", () => {
    setFirstPrompt("created-project", "Make my reel");
    const view = render(<ChatView />);
    expect(state.send).not.toHaveBeenCalled();
    state.projectId = "created-project";
    state.transcriptId = "created-chat";
    view.rerender(<ChatView />);
    expect(state.send).toHaveBeenCalledWith("Make my reel", []);
    expect(state.send).toHaveBeenCalledTimes(1);
  });

  it("does not duplicate the first turn during StrictMode effect replay", () => {
    setFirstPrompt("p1", "Make my reel");
    render(
      <StrictMode>
        <ChatView />
      </StrictMode>,
    );
    expect(state.send).toHaveBeenCalledWith("Make my reel", []);
    expect(state.send).toHaveBeenCalledTimes(1);
  });

  it.each(["closing", "streaming"])("does not consume a prompt while chat is %s", (field) => {
    setFirstPrompt("p1", "Make my reel");
    state[field] = true;
    const view = render(<ChatView />);
    expect(state.send).not.toHaveBeenCalled();
    state[field] = false;
    view.rerender(<ChatView />);
    expect(state.send).toHaveBeenCalledWith("Make my reel", []);
    expect(state.send).toHaveBeenCalledTimes(1);
  });

  it("does not insert a stale first prompt into an existing conversation", () => {
    setFirstPrompt("p1", "Old start-screen text");
    state.turns = [
      { id: "existing", userText: "Already started", attachments: [], parts: [], status: "done" },
    ];
    const view = render(<ChatView />);
    expect(state.send).not.toHaveBeenCalled();
    state.turns = [];
    view.rerender(<ChatView />);
    expect(state.send).not.toHaveBeenCalled();
  });

  it("shows the remaining balance while there is one", () => {
    render(<ChatView />);
    expect(screen.queryByRole("button", { name: /join our discord/i })).not.toBeInTheDocument();
  });

  it("shows real fractional headroom without floating-point noise", () => {
    usageMock.remaining = 100 - 99.999;
    render(<ChatView />);
    expect(screen.getByText("0.001 cr left")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /join our discord/i })).not.toBeInTheDocument();
  });

  it("says in the tooltip how much of what is used is reserved for generations in progress", () => {
    Object.assign(usageMock, { used: 96, limit: 150, remaining: 54, held: 96 });
    render(<ChatView />);
    expect(screen.getByText("54 cr left")).toHaveAttribute(
      "title",
      "96 / 150 credits used (96 reserved for generations in progress)",
    );
  });

  it("leaves the tooltip as it was when nothing is held", () => {
    render(<ChatView />);
    expect(screen.getByText(/cr left/)).toHaveAttribute("title", "10 / 100 credits used");
  });

  it("carries the same tooltip on the way out once the balance is spent", () => {
    Object.assign(usageMock, { over: true, used: 150, limit: 150, remaining: 0, held: 30 });
    render(<ChatView />);
    expect(screen.getByRole("button", { name: /join our discord/i })).toHaveAttribute(
      "title",
      "150 / 150 credits used (30 reserved for generations in progress)",
    );
  });

  it("shows the shared pause without pretending the user's remaining credit is zero", () => {
    usageMock.over = true;
    usageMock.globalPaused = true;
    usageMock.remaining = 97;
    render(<ChatView />);
    expect(screen.getByText("AI paused - 97 cr left")).toBeInTheDocument();
    expect(screen.queryByText(/0 cr/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /join our discord/i })).not.toBeInTheDocument();
  });

  // A bare "0" states the dead end and withholds the only way out of it. Asserted by
  // clicking through to the open, not by reading the label.
  it("turns the credit chip into a way out once the balance is spent", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    usageMock.over = true;
    render(<ChatView />);
    fireEvent.click(screen.getByRole("button", { name: /join our discord/i }));
    await waitFor(() =>
      expect(open).toHaveBeenCalledWith(DISCORD_URL, "_blank", "noopener,noreferrer"),
    );
    open.mockRestore();
  });
});

describe("ChatView", () => {
  it("disables the composer + shows a sign-in banner when AI is locked", () => {
    authState.status = "locked";
    render(<ChatView />);
    expect(screen.getByText(/sign in to use ai/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Message the editor…")).toBeDisabled();
  });

  it("shows the empty-state prompt", () => {
    render(<ChatView />);
    expect(screen.getByText(/Ask anything, or start with/)).toBeInTheDocument();
  });

  it("sends on click", () => {
    render(<ChatView />);
    fireEvent.change(screen.getByPlaceholderText(/Message the editor/), {
      target: { value: "do it" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(state.send).toHaveBeenCalledWith("do it", []);
  });

  it("uploads a picked file and sends it as an attachment", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (uploadFiles as any).mockResolvedValue([
      {
        path: "/proj/library/pic_abc.png",
        name: "pic.png",
        rel: "library/pic_abc.png",
      },
    ]);
    const { container } = render(<ChatView />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["x"], "pic.png", { type: "image/png" });
    fireEvent.change(input, { target: { files: [file] } });
    expect(await screen.findByText("pic.png")).toBeInTheDocument(); // chip appears after upload
    fireEvent.change(screen.getByPlaceholderText(/Message the editor/), {
      target: { value: "look" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(state.send).toHaveBeenCalledWith("look", [
      { path: "library/pic_abc.png", kind: "image", caption: "pic.png" },
    ]);
  });

  // On macOS a file input never opens its dialog while the window keeps native drag-drop, so the
  // desktop path must go through the OS dialog and must NOT fall back to clicking the input.
  it("attaches through the OS dialog on desktop, without touching the file input", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (importViaDialog as any).mockResolvedValue([
      { path: "/m/library/shot.mp4", name: "shot.mp4", rel: "library/shot.mp4" },
    ]);
    const { container } = render(<ChatView />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const clicked = vi.spyOn(input, "click");

    fireEvent.click(screen.getByTitle("Attach images, video, or audio"));

    expect(await screen.findByText("shot.mp4")).toBeInTheDocument();
    expect(clicked).not.toHaveBeenCalled();
  });

  it("still falls back to the file input on web", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (importViaDialog as any).mockResolvedValue(null); // web
    const { container } = render(<ChatView />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const clicked = vi.spyOn(input, "click");

    fireEvent.click(screen.getByTitle("Attach images, video, or audio"));

    await waitFor(() => expect(clicked).toHaveBeenCalled());
  });

  it("sends on Enter", () => {
    render(<ChatView />);
    const box = screen.getByPlaceholderText(/Message the editor/);
    fireEvent.change(box, { target: { value: "x" } });
    fireEvent.keyDown(box, { key: "Enter", shiftKey: false });
    expect(state.send).toHaveBeenCalled();
  });

  it("starts at one row and grows with the message content", () => {
    render(<ChatView />);
    const box = screen.getByPlaceholderText(/Message the editor/) as HTMLTextAreaElement;
    Object.defineProperty(box, "scrollHeight", {
      configurable: true,
      get: () => (box.value.includes("\n") ? 60 : 40),
    });

    expect(box.style.height).toBe("40px");
    fireEvent.change(box, { target: { value: "first\nsecond" } });
    expect(box.style.height).toBe("60px");
    fireEvent.change(box, { target: { value: "" } });
    expect(box.style.height).toBe("40px");
  });

  it("renders turns with user text + parts", () => {
    state.turns = [
      {
        id: "t1",
        userText: "hi",
        attachments: [{ path: "/a" }],
        parts: [{ kind: "text", text: "reply" }],
        status: "done",
      },
    ];
    render(<ChatView />);
    expect(screen.getByText("hi")).toBeInTheDocument();
    expect(screen.getByText("reply")).toBeInTheDocument();
  });

  it("shows what was left out of the conversation before the answer, and does not treat the turn as failed", () => {
    state.turns = [
      {
        id: "t1",
        userText: "hi",
        attachments: [],
        parts: [
          { kind: "notice", code: "frames_refused", text: refusedNotice(1) },
          { kind: "text", text: "reply" },
        ],
        status: "done",
      },
    ];
    render(<ChatView />);
    const note = screen.getByText(refusedNotice(1));
    expect(
      note.compareDocumentPosition(screen.getByText("reply")) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.queryByText("Report this problem")).toBeNull();
  });

  it("shows the notice and still offers the report on a turn that failed", () => {
    state.turns = [
      {
        id: "t1",
        userText: "hi",
        attachments: [],
        parts: [
          { kind: "notice", code: "frames_refused", text: refusedNotice(1) },
          { kind: "error", error: "Our own sentence." },
        ],
        status: "error",
      },
    ];
    render(<ChatView />);
    expect(screen.getByText(refusedNotice(1))).toBeInTheDocument();
    expect(screen.getByText(/Our own sentence\./)).toBeInTheDocument();
    expect(screen.getByText("Report this problem")).toBeInTheDocument();
  });

  it("asks in plain English and wires the buttons to the store", () => {
    state.pending = [
      {
        call_id: "c",
        name: "generate_image",
        arguments: { prompt: "a red car" },
        rationale: "why",
        reasoning_summary: [],
      },
    ];
    render(<ChatView />);
    // The tool identifier is ours, not the user's — it must not be what they are asked about.
    expect(screen.queryByText(/generate_image/)).not.toBeInTheDocument();
    expect(screen.getByText("Generate an image")).toBeInTheDocument();
    expect(screen.getByText(/spends your credits/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    expect(state.approve).toHaveBeenCalledWith("c");
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(state.deny).toHaveBeenCalledWith(undefined, "c");
  });

  it("shows every gated call in the round, each with its own buttons", () => {
    // One interruption for the whole round instead of one per call.
    state.pending = [
      {
        call_id: "c1",
        name: "generate_image",
        arguments: { prompt: "a red car" },
        rationale: "",
        reasoning_summary: [],
      },
      {
        call_id: "c2",
        name: "generate_video",
        arguments: { prompt: "a blue van" },
        rationale: "",
        reasoning_summary: [],
      },
    ];
    render(<ChatView />);

    expect(screen.getByText("Generate an image")).toBeInTheDocument();
    expect(screen.getByText("Generate a video")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Allow" })).toHaveLength(2);

    // Each button answers ITS OWN call.
    fireEvent.click(screen.getAllByRole("button", { name: "Allow" })[1]);
    expect(state.approve).toHaveBeenCalledWith("c2");
  });

  it("shows Stop while streaming", () => {
    state.streaming = true;
    render(<ChatView />);
    fireEvent.click(screen.getByRole("button", { name: /Stop/ }));
    expect(state.stop).toHaveBeenCalled();
  });

  describe("a turn that failed", () => {
    const failedTurn = (id: string) => ({
      id,
      userText: "make a reel",
      attachments: [],
      parts: [{ kind: "error", error: "ArtDaddy's service is restarting or overloaded." }],
      status: "error",
    });

    it("offers Try again, which sends the round again without retyping", () => {
      state.turns = [failedTurn("t1")];
      state.canRetry = true;
      render(<ChatView />);
      fireEvent.click(screen.getByRole("button", { name: /Try again/ }));
      expect(state.retry).toHaveBeenCalledTimes(1);
      expect(state.send).not.toHaveBeenCalled();
    });

    it("offers it only when sending the round again can help", () => {
      state.turns = [failedTurn("t1")];
      state.canRetry = false;
      render(<ChatView />);
      expect(screen.queryByRole("button", { name: /Try again/ })).toBeNull();
      expect(screen.getByText("Report this problem")).toBeInTheDocument();
    });

    it("offers it on the latest turn only, never on an older failure", () => {
      state.turns = [failedTurn("t1"), { ...failedTurn("t2"), status: "done", parts: [] }];
      state.canRetry = true;
      render(<ChatView />);
      expect(screen.queryByRole("button", { name: /Try again/ })).toBeNull();
    });

    it("still offers the report beside it", () => {
      state.turns = [failedTurn("t1")];
      state.canRetry = true;
      render(<ChatView />);
      expect(screen.getByText("Report this problem")).toBeInTheDocument();
    });
  });

  describe("the line under a running turn says what it is waiting on", () => {
    const runningTurn = (status: string) => ({
      id: "t1",
      userText: "caption it",
      attachments: [],
      parts: [{ kind: "tool_call", call_id: "c1", name: "add_captions", args: {} }],
      status,
    });
    afterEach(() => resetLiveWait());

    it("names the tool that is running, in the chat's own words, with the time it has taken", () => {
      vi.useFakeTimers();
      try {
        state.streaming = true;
        state.turns = [runningTurn("streaming")];
        useLiveWait.getState().callStarted("c1", "add_captions", Date.now() - 42_000);
        const { container } = render(<ChatView />);
        const line = screen.getByTestId("status-line");
        expect(line.textContent).toContain("Captioning the audio…");
        expect(line.textContent).toContain("0:42");
        expect(line.textContent).toMatch(/Still working on this/);
        expect(container.textContent).not.toContain("working…");
      } finally {
        vi.useRealTimers();
      }
    });

    it("says the model is thinking when no tool is running", () => {
      state.streaming = true;
      state.turns = [runningTurn("streaming")];
      useLiveWait.getState().roundStarted(Date.now());
      useLiveWait.getState().roundSent();
      render(<ChatView />);
      expect(screen.getByTestId("status-line").textContent).toContain("Thinking…");
    });

    it("says it is waiting for the person when the turn is waiting for their OK", () => {
      state.turns = [runningTurn("awaiting")];
      useLiveWait.getState().approvalAsked(Date.now());
      render(<ChatView />);
      expect(screen.getByTestId("status-line").textContent).toContain("Waiting for your OK…");
    });

    it("is not shown for a turn that has finished, even if a stale record is left behind", () => {
      state.turns = [runningTurn("done")];
      useLiveWait.getState().callStarted("c1", "add_captions", Date.now());
      render(<ChatView />);
      expect(screen.queryByTestId("status-line")).toBeNull();
    });
  });

  it("lights the composer halo only while the agent is working", () => {
    // The CSS itself can't run in jsdom; what is testable here is that the class is bound
    // to the working state, so the ring cannot end up burning permanently.
    const { container, unmount } = render(<ChatView />);
    expect(container.querySelector(".halo")).not.toBeNull();
    expect(container.querySelector(".halo-on")).toBeNull();
    unmount();

    state.streaming = true;
    const live = render(<ChatView />);
    expect(live.container.querySelector(".halo-on")).not.toBeNull();
  });

  it("changing the mode selector calls setControls", () => {
    render(<ChatView />);
    const selects = screen.getAllByRole("combobox");
    fireEvent.change(selects[2], { target: { value: "autopilot" } });
    expect(state.setControls).toHaveBeenCalledWith({ mode: "autopilot" });
  });

  it("surfaces an error banner", () => {
    state.error = "bad thing";
    render(<ChatView />);
    expect(screen.getByText("bad thing")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /join our discord/i })).not.toBeInTheDocument();
  });

  it("shows request headroom without offering the exhausted-account action", async () => {
    const { CreditLimitError } =
      await vi.importActual<typeof import("../api/usage")>("../api/usage");
    state.error = toUserMessage(
      new CreditLimitError({ used: 99, limit: 100, remaining: 1, requested: 3, scope: "user" }),
    );
    render(<ChatView />);
    expect(screen.getByText(/3 credits.*1 credit remains/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /join our discord/i })).not.toBeInTheDocument();
  });

  // The REAL error's person-facing sentence, for both scopes: the banner is set from
  // toUserMessage(e), so a fixture string would agree with the matcher whatever the error said.
  it.each(["user", "global"])(
    "offers the Discord on the banner when %s credits ran out",
    async (scope) => {
      const { CreditLimitError } =
        await vi.importActual<typeof import("../api/usage")>("../api/usage");
      state.error = toUserMessage(new CreditLimitError({ scope }));
      render(<ChatView />);
      expect(screen.getByRole("button", { name: /join our discord/i })).toBeInTheDocument();
    },
  );

  // A generation that ran out in the background lands as a note, not an error part, so the note
  // itself has to carry the way out.
  it("offers the Discord on a background job that ran out of credits", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const { CreditLimitError } =
      await vi.importActual<typeof import("../api/usage")>("../api/usage");
    const error = new CreditLimitError({ used: 500, limit: 500 }).message;
    state.turns = [
      {
        id: "t1",
        system: true,
        userText: `Background work you started earlier has finished:\n- an image FAILED: ${error}`,
        attachments: [],
        parts: [],
        status: "done",
      },
    ];
    render(<ChatView />);
    expect(screen.getByText(/an image failed — out of credits/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /join our discord/i }));
    await waitFor(() =>
      expect(open).toHaveBeenCalledWith(DISCORD_URL, "_blank", "noopener,noreferrer"),
    );
    open.mockRestore();
  });

  it("undo/redo call the store when enabled", () => {
    state.session = {
      can_undo: true,
      can_redo: true,
      cost_usd: 0,
      input_tokens: 0,
      output_tokens: 0,
      reasoning_tokens: 0,
      approval_mode: "default",
      finished: true,
      pending: false,
    };
    render(<ChatView />);
    fireEvent.click(screen.getByRole("button", { name: /Undo/ }));
    fireEvent.click(screen.getByRole("button", { name: /Redo/ }));
    expect(state.undo).toHaveBeenCalled();
    expect(state.redo).toHaveBeenCalled();
  });

  it("does not send blank text", () => {
    render(<ChatView />);
    fireEvent.keyDown(screen.getByPlaceholderText(/Message the editor/), { key: "Enter" });
    expect(state.send).not.toHaveBeenCalled();
  });

  it("restores a checkpoint", () => {
    state.turns = [
      { id: "t1", userText: "hi", attachments: [], parts: [], status: "done", checkpoint: true },
    ];
    render(<ChatView />);
    fireEvent.click(screen.getByRole("button", { name: /Restore Checkpoint/ }));
    expect(state.restoreTo).toHaveBeenCalledWith("t1");
  });

  it("rates a done turn", () => {
    state.turns = [{ id: "t1", userText: "hi", attachments: [], parts: [], status: "done" }];
    render(<ChatView />);
    fireEvent.click(screen.getByRole("button", { name: "Good response" }));
    expect(state.sendFeedback).toHaveBeenCalledWith("up", { requestId: undefined });
  });

  it("says when a reply was cut short, instead of showing it as finished", () => {
    state.turns = [
      {
        id: "t1",
        userText: "hi",
        attachments: [],
        parts: [{ kind: "tool_call", call_id: "c1", name: "get_timeline", args: {} }],
        status: "interrupted",
      },
    ];
    render(<ChatView />);
    expect(screen.getByText(/This reply was cut short/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Good response" })).not.toBeInTheDocument();
  });

  it("reporting an errored turn asks for a note first, then sends it", async () => {
    state.turns = [{ id: "t1", userText: "hi", attachments: [], parts: [], status: "error" }];
    render(<ChatView />);
    fireEvent.click(screen.getByRole("button", { name: /Report this problem/ }));
    // Opening the dialog must NOT send anything yet.
    expect(state.sendFeedback).not.toHaveBeenCalled();

    const box = screen.getByRole("textbox", { name: /What went wrong/i });
    const sendBtn = screen.getByRole("button", { name: /Send report/ });
    // Empty (and whitespace-only) notes cannot be sent.
    expect(sendBtn).toBeDisabled();
    fireEvent.change(box, { target: { value: "   " } });
    expect(sendBtn).toBeDisabled();

    fireEvent.change(box, { target: { value: "  export made no sound  " } });
    expect(sendBtn).not.toBeDisabled();
    fireEvent.click(sendBtn);
    await waitFor(() =>
      expect(state.sendFeedback).toHaveBeenCalledWith("report", {
        note: "export made no sound",
      }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("keeps the report dialog and the typed note open when the upload fails", async () => {
    state.sendFeedback = vi.fn(async () => false);
    state.turns = [{ id: "t1", userText: "hi", attachments: [], parts: [], status: "error" }];
    render(<ChatView />);
    fireEvent.click(screen.getByRole("button", { name: /Report this problem/ }));
    const box = screen.getByRole("textbox", { name: /What went wrong/i });
    fireEvent.change(box, { target: { value: "it broke" } });
    fireEvent.click(screen.getByRole("button", { name: /Send report/ }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect((box as HTMLTextAreaElement).value).toBe("it broke"); // not lost
  });

  it("cancelling the report dialog sends nothing", () => {
    state.turns = [{ id: "t1", userText: "hi", attachments: [], parts: [], status: "error" }];
    render(<ChatView />);
    fireEvent.click(screen.getByRole("button", { name: /Report this problem/ }));
    fireEvent.change(screen.getByRole("textbox", { name: /What went wrong/i }), {
      target: { value: "never mind" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Cancel/ }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(state.sendFeedback).not.toHaveBeenCalled();
  });

  it("rolls back the rating when feedback upload fails", async () => {
    state.sendFeedback = vi.fn(async () => false);
    state.turns = [{ id: "t1", userText: "hi", attachments: [], parts: [], status: "done" }];
    render(<ChatView />);
    const up = screen.getByRole("button", { name: "Good response" });
    fireEvent.click(up);
    expect(up).toBeDisabled();
    await waitFor(() => expect(up).not.toBeDisabled());
  });

  it("continues a long run", () => {
    state.canContinue = true;
    render(<ChatView />);
    fireEvent.click(screen.getByRole("button", { name: /Continue/ }));
    expect(state.continueRun).toHaveBeenCalled();
  });

  it("renders pending mentions and removes one", () => {
    state.pendingMentions = [{ kind: "playhead", frame: 10, timecode: "00:00:00:10" }];
    render(<ChatView />);
    fireEvent.click(screen.getByRole("button", { name: "remove mention" }));
    expect(state.removeMention).toHaveBeenCalled();
  });

  it("changes model and effort selectors", () => {
    render(<ChatView />);
    const selects = screen.getAllByRole("combobox");
    fireEvent.change(selects[0], { target: { value: "gpt-6.1-sol" } });
    expect(state.setControls).toHaveBeenCalledWith({ model: "gpt-6.1-sol" });
    fireEvent.change(selects[1], { target: { value: "low" } });
    expect(state.setControls).toHaveBeenCalledWith({ effort: "low" });
  });

  it("offers the two served models, Luna first", () => {
    render(<ChatView />);
    const models = [...(screen.getAllByRole("combobox")[0] as HTMLSelectElement).options].map(
      (o) => o.value,
    );
    expect(models).toEqual(["gpt-5.6-luna", "gpt-6.1-sol"]);
  });

  // gpt-6.1-sol 400s on effort "none"; Luna accepts it. Both directions, or a filter that hid
  // "none" everywhere would pass.
  it("never offers Sol an effort it rejects, and Luna keeps it", () => {
    const efforts = () =>
      [...(screen.getAllByRole("combobox")[1] as HTMLSelectElement).options].map((o) => o.value);
    state.model = "gpt-6.1-sol";
    const { unmount } = render(<ChatView />);
    expect(efforts()).not.toContain("none");
    unmount();
    state.model = "gpt-5.6-luna";
    render(<ChatView />);
    expect(efforts()).toContain("none");
  });

  it("switching to Sol at effort none lands on low instead of a value Sol rejects", () => {
    state.effort = "none";
    render(<ChatView />);
    fireEvent.change(screen.getAllByRole("combobox")[0], { target: { value: "gpt-6.1-sol" } });
    expect(state.setControls).toHaveBeenCalledWith({ model: "gpt-6.1-sol", effort: "low" });
  });

  it("removes a pending attachment chip", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (uploadFiles as any).mockResolvedValue([
      {
        path: "/p/library/x.png",
        name: "x.png",
        rel: "library/x.png",
      },
    ]);
    const { container } = render(<ChatView />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(["x"], "x.png", { type: "image/png" })] },
    });
    expect(await screen.findByText("x.png")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "remove attachment" }));
    expect(screen.queryByText("x.png")).not.toBeInTheDocument();
  });

  // The reported bug: pick a file, nothing appears, nothing is said. The attach button reads as
  // dead. Importing through uploadFiles is what makes the failure reportable at all.
  it("does not leave the composer stuck when an import fails", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (uploadFiles as any).mockResolvedValue([]); // every file failed; the boundary reported it
    const { container } = render(<ChatView />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(["x"], "bad.png", { type: "image/png" })] },
    });

    // No phantom chip for media that never landed...
    await waitFor(() => expect(screen.queryByText("bad.png")).not.toBeInTheDocument());
    // ...and the button is usable again rather than stuck on its uploading spinner.
    await waitFor(() =>
      expect(screen.getByTitle("Attach images, video, or audio")).not.toBeDisabled(),
    );
  });

  it("survives an import that rejects outright", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (uploadFiles as any).mockRejectedValue(new Error("disk full"));
    const { container } = render(<ChatView />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(["x"], "bad.png", { type: "image/png" })] },
    });
    // The composer must not be left permanently disabled by a throw.
    await waitFor(() =>
      expect(screen.getByTitle("Attach images, video, or audio")).not.toBeDisabled(),
    );
  });

  it("shows the credit balance whenever the server reports the round is metered", () => {
    // Keyed on usage.metered, not on which model is selected — the gemini id this used to name
    // was incidental, and the app no longer offers one.
    state.model = "gpt-6.1-sol";
    render(<ChatView />);
    expect(screen.getByText(/cr left/)).toBeInTheDocument();
  });

  describe("starter prompts", () => {
    const composer = (): HTMLTextAreaElement =>
      screen.getByPlaceholderText("Message the editor…") as HTMLTextAreaElement;

    it("fills the composer with the prompt's text, not its label", () => {
      render(<ChatView />);
      const p = STARTER_PROMPTS[0];
      fireEvent.click(screen.getByText(p.label));
      expect(composer().value).toBe(p.text);
    });

    it("does NOT send — several of these spend money, so the user gets to read it first", () => {
      render(<ChatView />);
      fireEvent.click(screen.getByText(STARTER_PROMPTS[0].label));
      expect(state.send).not.toHaveBeenCalled();
    });

    it("disappears once the conversation has started", () => {
      state.turns = [{ id: "t1", userText: "hi", attachments: [], parts: [], status: "done" }];
      render(<ChatView />);
      expect(screen.queryByText(STARTER_PROMPTS[0].label)).toBeNull();
    });

    it("is offered for every prompt, not just the first", () => {
      render(<ChatView />);
      for (const p of STARTER_PROMPTS) expect(screen.getByText(p.label)).toBeInTheDocument();
    });
  });
});

// The composer had no drop target of ANY kind, so a file dragged onto chat did nothing on either
// platform. And on desktop the page must not claim the drag: WKWebView then hands it macOS's
// QuickLook preview instead of handing Tauri the file, which is how a dropped video arrived as a
// .jpeg still.
describe("ChatView drop", () => {
  const zone = (c: HTMLElement) => c.querySelector('[data-artdaddy-drop="chat"]') as HTMLElement;
  const osDrop = (detail: { paths: string[]; target: string }) =>
    window.dispatchEvent(
      new CustomEvent("artdaddy:os-drop", { detail: { ...detail, element: null, x: 0, y: 0 } }),
    );

  it("has a drop zone on the composer at all", () => {
    const { container } = render(<ChatView />);
    expect(zone(container)).toBeTruthy();
  });

  it("attaches a file dropped on the composer on web", async () => {
    platformName = "web";
    vi.mocked(uploadFiles).mockResolvedValue([
      { path: "/p/library/a.mp4", name: "a.mp4", rel: "library/a.mp4", id: "media_a" },
    ]);
    const { container } = render(<ChatView />);
    fireEvent.drop(zone(container), {
      dataTransfer: { files: [new File(["x"], "a.mp4", { type: "video/mp4" })], types: ["Files"] },
    });
    expect(await screen.findByText("a.mp4")).toBeInTheDocument();
  });

  it("ignores an HTML5 file drop on desktop, where Tauri owns it", async () => {
    platformName = "tauri";
    const { container } = render(<ChatView />);
    fireEvent.drop(zone(container), {
      dataTransfer: { files: [new File(["x"], "a.mp4", { type: "video/mp4" })], types: ["Files"] },
    });
    await waitFor(() => expect(uploadFiles).not.toHaveBeenCalled());
  });

  it("attaches the PATHS Tauri delivers, linked in place", async () => {
    platformName = "tauri";
    vi.mocked(importPaths).mockResolvedValue([
      { path: "/Users/me/clip.mov", name: "clip.mov", rel: "library/clip.mov", id: "media_c" },
    ]);
    render(<ChatView />);
    osDrop({ paths: ["/Users/me/clip.mov"], target: "chat" });
    expect(await screen.findByText("clip.mov")).toBeInTheDocument();
    expect(importPaths).toHaveBeenCalledWith("p1", ["/Users/me/clip.mov"]);
  });

  it("leaves a drop aimed at another zone alone", async () => {
    platformName = "tauri";
    render(<ChatView />);
    osDrop({ paths: ["/Users/me/clip.mov"], target: "library" });
    await waitFor(() => expect(importPaths).not.toHaveBeenCalled());
  });

  it("ignores a dropped path that is not media, and says it turned it away", async () => {
    platformName = "tauri";
    render(<ChatView />);
    osDrop({ paths: ["/Users/me/notes.pdf"], target: "chat" });
    await waitFor(() => expect(importPaths).not.toHaveBeenCalled());
    // Not a dead window: one word, no name and no folder.
    expect(recordImport).toHaveBeenCalledTimes(1);
    expect(vi.mocked(recordImport).mock.calls[0]).toEqual([
      { ok: false, reason: "unsupported_type", media: "unknown", via: "reference" },
      "p1",
    ]);
  });

  it("attaches what the clipboard actually carried, by the shared reader", async () => {
    const pasted = new File(["x"], "clip.mov", { type: "video/quicktime" });
    vi.mocked(filesFromItems).mockReturnValue([pasted]);
    vi.mocked(uploadFiles).mockResolvedValue([
      { path: "/p/library/clip.mov", name: "clip.mov", rel: "library/clip.mov", id: "media_v" },
    ]);
    render(<ChatView />);
    fireEvent.paste(screen.getByPlaceholderText(/Message the editor/), {
      clipboardData: { items: [] },
    });
    expect(await screen.findByText("clip.mov")).toBeInTheDocument();
    expect(uploadFiles).toHaveBeenCalledWith("p1", [pasted]);
  });
});

describe("sign-in routing", () => {
  it("opens the desktop-auth flow when AI is locked", () => {
    authState.status = "locked";
    render(<ChatView />);
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(startDesktopSignIn).toHaveBeenCalledOnce();
  });
});

// T-30. Footage chosen on the start screen cannot be imported there (an import needs the open project), so the
// chat brings it in once the project is open and sends the first message only after it has landed, carrying it.
// The rule: the first message never goes to the agent without the footage the person chose.
describe("ChatView first prompt with start-screen footage", () => {
  const footage = [
    { name: "a.mp4", path: "C:/v/a.mp4" },
    { name: "b.mov", path: "C:/v/b.mov" },
  ];
  const pool = [
    { path: "C:/v/a.mp4", name: "a.mp4", rel: "library/a.mp4", id: "media_a" },
    { path: "C:/v/b.mov", name: "b.mov", rel: "library/b.mov", id: "media_b" },
    { path: "C:/v/c.mp3", name: "c.mp3", rel: "library/c.mp3", id: "media_c" },
  ];
  const kinds: Record<string, string> = { "a.mp4": "video", "b.mov": "video", "c.mp3": "audio" };
  const attachedFor = (landed: typeof pool) =>
    landed.map((u) => ({ path: u.rel, kind: kinds[u.name], caption: u.name }));
  const openProject = (id = "p1") =>
    act(() => {
      useEditor.setState({ projectId: id, store: {} as never });
    });
  // Long enough for every promise and effect in flight to run, for the checks that something did NOT happen.
  const settle = () =>
    act(async () => {
      await new Promise((r) => setTimeout(r, 25));
    });
  const composer = () => screen.getByPlaceholderText(/Message the editor/);

  it("imports first, then sends the prompt with what landed attached, once", async () => {
    const order: string[] = [];
    vi.mocked(importFootage).mockImplementation(async () => {
      order.push("import");
      return pool.slice(0, 2);
    });
    state.send.mockImplementation(() => {
      order.push("send");
    });
    setFirstPrompt("p1", "Make my reel", footage);
    openProject();
    const view = render(<ChatView />);
    await waitFor(() =>
      expect(state.send).toHaveBeenCalledWith("Make my reel", attachedFor(pool.slice(0, 2))),
    );
    expect(order).toEqual(["import", "send"]);
    expect(importFootage).toHaveBeenCalledWith("p1", footage);
    expect(composer()).toHaveValue("");
    // a second mount inherits nothing: no second import, no second message
    view.unmount();
    render(<ChatView />);
    await settle();
    expect(importFootage).toHaveBeenCalledTimes(1);
    expect(state.send).toHaveBeenCalledTimes(1);
    expect(peekFirstFootage("p1")).toEqual([]);
    expect(peekFirstPrompt("p1")).toBeNull();
  });

  it("does not send while the footage is still coming in; the text waits in the composer", async () => {
    let finish!: (u: typeof pool) => void;
    vi.mocked(importFootage).mockReturnValue(new Promise((r) => (finish = r)));
    setFirstPrompt("p1", "Make my reel", footage);
    openProject();
    render(<ChatView />);
    await waitFor(() => expect(importFootage).toHaveBeenCalled());
    await settle();
    expect(state.send).not.toHaveBeenCalled();
    expect(composer()).toHaveValue("Make my reel");
    await act(async () => finish(pool.slice(0, 2)));
    await waitFor(() =>
      expect(state.send).toHaveBeenCalledWith("Make my reel", attachedFor(pool.slice(0, 2))),
    );
  });

  it("does not import into a project that is not open, and does not send without the footage meanwhile", async () => {
    setFirstPrompt("p1", "Make my reel", footage);
    render(<ChatView />);
    await settle();
    expect(importFootage).not.toHaveBeenCalled();
    expect(state.send).not.toHaveBeenCalled();
    openProject("p2"); // another project's editor is open: still not this one
    await settle();
    expect(importFootage).not.toHaveBeenCalled();
    vi.mocked(importFootage).mockResolvedValue(pool.slice(0, 2));
    openProject("p1");
    await waitFor(() =>
      expect(state.send).toHaveBeenCalledWith("Make my reel", attachedFor(pool.slice(0, 2))),
    );
  });

  it("imports as soon as the project is open, and sends once they are signed in", async () => {
    vi.mocked(importFootage).mockResolvedValue(pool.slice(0, 2));
    authState.status = "checking";
    setFirstPrompt("p1", "Make my reel", footage);
    openProject();
    const view = render(<ChatView />);
    expect(await screen.findByText("a.mp4")).toBeInTheDocument();
    await settle();
    expect(state.send).not.toHaveBeenCalled();
    authState.status = "unlocked";
    view.rerender(<ChatView />);
    await waitFor(() =>
      expect(state.send).toHaveBeenCalledWith("Make my reel", attachedFor(pool.slice(0, 2))),
    );
    expect(importFootage).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      "none of it came in (the importer already said why)",
      () => vi.mocked(importFootage).mockResolvedValue([]),
    ],
    [
      "the import itself failed",
      () => vi.mocked(importFootage).mockRejectedValue(new Error("boom")),
    ],
  ])("holds the message back and keeps their text when %s", async (_name, arrange) => {
    arrange();
    setFirstPrompt("p1", "Make my reel", footage);
    openProject();
    render(<ChatView />);
    await waitFor(() => expect(importFootage).toHaveBeenCalled());
    await settle();
    expect(state.send).not.toHaveBeenCalled();
    expect(composer()).toHaveValue("Make my reel");
    expect(peekFirstPrompt("p1")).toBeNull(); // not sent later, behind their back, either
    // and what they send themselves is theirs to send
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(state.send).toHaveBeenCalledWith("Make my reel", []);
  });

  it("imports once however often the effects replay", async () => {
    vi.mocked(importFootage).mockResolvedValue(pool.slice(0, 2));
    setFirstPrompt("p1", "Make my reel", footage);
    openProject();
    render(
      <StrictMode>
        <ChatView />
      </StrictMode>,
    );
    await waitFor(() => expect(state.send).toHaveBeenCalled());
    await settle();
    expect(importFootage).toHaveBeenCalledTimes(1);
    expect(state.send).toHaveBeenCalledTimes(1);
  });

  it("leaving the project mid-import attaches nothing elsewhere, and never sends on a later return", async () => {
    let finish!: (u: typeof pool) => void;
    vi.mocked(importFootage).mockReturnValue(new Promise((r) => (finish = r)));
    setFirstPrompt("p1", "Make my reel", footage);
    openProject();
    const view = render(<ChatView />);
    await waitFor(() => expect(importFootage).toHaveBeenCalled());
    state.projectId = "p2";
    state.transcriptId = "chat-p2";
    view.rerender(<ChatView />);
    await act(async () => finish(pool.slice(0, 2)));
    await settle();
    expect(screen.queryByText("a.mp4")).not.toBeInTheDocument();
    state.projectId = "p1";
    state.transcriptId = "chat-p1";
    view.rerender(<ChatView />);
    await settle();
    expect(state.send).not.toHaveBeenCalled();
  });

  it("goes with the first message only: the composer is empty after, and the next message is theirs", async () => {
    vi.mocked(importFootage).mockResolvedValue(pool.slice(0, 1));
    setFirstPrompt("p1", "Make my reel", footage);
    openProject();
    render(<ChatView />);
    await waitFor(() => expect(state.send).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("a.mp4")).not.toBeInTheDocument();
    fireEvent.change(composer(), { target: { value: "and a title" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(state.send).toHaveBeenLastCalledWith("and a title", []);
  });

  // Whatever lands, the first message carries exactly that and nothing more, and a landing of nothing means no
  // message. (Subsets keep the order the importer returned them in.)
  it("property: the message carries exactly what landed; an empty landing sends nothing", async () => {
    await fc.assert(
      fc.asyncProperty(fc.subarray(pool), fc.boolean(), async (landed, throws) => {
        Object.assign(state, baseState());
        vi.mocked(importFootage).mockReset();
        if (throws) vi.mocked(importFootage).mockRejectedValue(new Error("boom"));
        else vi.mocked(importFootage).mockResolvedValue(landed);
        setFirstPrompt("p1", "Make my reel", footage);
        openProject();
        const view = render(<ChatView />);
        try {
          await waitFor(() => expect(importFootage).toHaveBeenCalled());
          await settle();
          if (throws || landed.length === 0) {
            expect(state.send).not.toHaveBeenCalled();
            expect(composer()).toHaveValue("Make my reel");
            return;
          }
          expect(state.send).toHaveBeenCalledTimes(1);
          expect(state.send).toHaveBeenCalledWith("Make my reel", attachedFor(landed));
        } finally {
          view.unmount();
          useEditor.setState({ projectId: null, store: null });
        }
      }),
      { numRuns: 25 },
    );
  });
});

// The question an export asks must reach a person who is in the chat: a long export started by their
// assistant waits for an answer, and the dialog alone can sit behind another window. The dialog is modal,
// so the chat carries the question once the person puts the dialog away ("Answer in chat").
describe("ChatView: the export card", () => {
  it("carries the question an export of this project asks once the dialog is put away, and answering it there answers it", async () => {
    const { askQuestion, mountQuestionHost, setQuestionHidden, __resetExportQuestions } =
      await import("../store/exportQuestionHost");
    const { useExportQuestions } = await import("../store/exportQuestionHost");
    const { planQuestions } = await import("../timeline/exportQuestions");
    __resetExportQuestions();
    const unmount = mountQuestionHost();
    try {
      act(() => {
        useEditor.setState({ projectId: "p1", store: { projectDir: "/proj" } as never });
      });
      render(<ChatView />);
      const [question] = planQuestions({
        via: "chat",
        count: 1,
        reasons: new Set(["memory_shortage"]),
        memoryNeededBytes: 3.2e9,
        memoryUsableBytes: 1.9e9,
        spaceNeededBytes: null,
        destinationFreeBytes: null,
        scratchFreeBytes: null,
        destinationShort: false,
        scratchShort: false,
        drive: null,
        movable: false,
        seconds: null,
        secondsGuessed: false,
        executionLimitSeconds: null,
      });
      let outcome!: ReturnType<typeof askQuestion>;
      act(() => {
        outcome = askQuestion(question, { projectDir: "/proj" });
      });
      // The chat is open, so the dialog may be put away: until then the dialog is the one asking.
      await waitFor(() => expect(useExportQuestions.getState().open?.canHide).toBe(true));
      expect(screen.queryByRole("group", { name: "export question" })).toBeNull();
      act(() => void setQuestionHidden(useExportQuestions.getState().open!.id, true));
      const box = await screen.findByRole("group", { name: "export question" });
      expect(within(box).getByText("Not enough free memory")).toBeVisible();
      // It sits with the message box, above it.
      expect(
        box.compareDocumentPosition(screen.getByPlaceholderText(/Message the editor/)) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      fireEvent.click(within(box).getByRole("button", { name: "Cancel" }));
      expect(await outcome).toMatchObject({ answer: "cancel", by: "card" });
      expect(screen.queryByRole("group", { name: "export question" })).toBeNull();
    } finally {
      unmount();
      __resetExportQuestions();
    }
  });
});

// ── Chats of a project: New chat, Chat history, going back over outside changes, Undo restore ──────
describe("ChatView: chats of a project", () => {
  const turn = (id: string, text: string, extra: Record<string, unknown> = {}) => ({
    id,
    userText: text,
    attachments: [],
    parts: [{ kind: "text", text: `answer to ${text}` }],
    status: "done",
    undone: false,
    checkpoint: null,
    timelineAfter: null,
    ...extra,
  });
  const assistant = () => within(screen.getByRole("region", { name: "Assistant" }));
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
  const HOUR = 3_600_000;

  describe("New chat", () => {
    it("is a + button in the Assistant header, and says what it does", () => {
      state.turns = [turn("t1", "hello")];
      render(<ChatView />);
      const button = assistant().getByRole("button", { name: "New chat" });
      expect(button).toBeEnabled();
      expect(button).toHaveAttribute("title", "New chat");
      // It is in the header, with the other panel controls, not in the message area.
      expect(button.closest("header")).not.toBeNull();
    });

    it("starts a new chat when pressed, and leaves what was typed where it is", () => {
      state.turns = [turn("t1", "hello")];
      render(<ChatView />);
      const composer = screen.getByPlaceholderText(/Message the editor/);
      fireEvent.change(composer, { target: { value: "half a thought" } });
      fireEvent.click(assistant().getByRole("button", { name: "New chat" }));
      expect(state.newChat).toHaveBeenCalledTimes(1);
      expect(composer).toHaveValue("half a thought");
    });

    it("has nothing to do in a chat that is already empty", () => {
      state.turns = [];
      render(<ChatView />);
      expect(assistant().getByRole("button", { name: "New chat" })).toBeDisabled();
    });

    it("has nothing to do without a project", () => {
      state.turns = [turn("t1", "hello")];
      state.projectId = null;
      render(<ChatView />);
      expect(assistant().getByRole("button", { name: "New chat" })).toBeDisabled();
      expect(assistant().getByRole("button", { name: "Chat history" })).toBeDisabled();
    });

    it.each([
      ["while the assistant is working", { streaming: true }],
      [
        "with a tool call waiting for approval",
        { pending: [{ call_id: "c", name: "x", arguments: {} }] },
      ],
      ["while the project is closing", { closing: true }],
      ["while a chat is being swapped in", { switching: true }],
    ])("is unavailable %s", (_name, patch) => {
      state.turns = [turn("t1", "hello")];
      Object.assign(state, patch);
      render(<ChatView />);
      const button = assistant().getByRole("button", { name: "New chat" });
      expect(button).toBeDisabled();
      fireEvent.click(button);
      expect(state.newChat).not.toHaveBeenCalled();
    });

    it("a chat that looks empty but holds undone turns can still be put away", () => {
      state.turns = [turn("t1", "hello", { undone: true })];
      render(<ChatView />);
      expect(assistant().getByRole("button", { name: "New chat" })).toBeEnabled();
    });
  });

  describe("Chat history", () => {
    const earlier = [
      { id: "c-new", title: "trim the intro", updatedAt: ago(3 * HOUR) },
      { id: "c-old", title: "colour grade the beach shots", updatedAt: ago(50 * HOUR) },
    ];
    const open = async () => {
      fireEvent.click(assistant().getByRole("button", { name: "Chat history" }));
      return screen.findByRole("group", { name: "Chats in this project" });
    };

    it("lists this chat first, then the earlier ones with how long ago they were put away", async () => {
      state.turns = [turn("t1", "add captions to the interview")];
      state.listChats = vi.fn(async () => earlier);
      render(<ChatView />);
      const list = await open();
      expect(within(list).getByText("add captions to the interview")).toBeVisible();
      expect(within(list).getByText("This chat")).toBeVisible();
      await within(list).findByText("trim the intro");
      expect(within(list).getByText("3 h ago")).toBeVisible();
      expect(within(list).getByText("2 d ago")).toBeVisible();
      const titles = within(list)
        .getAllByText(/add captions|trim the intro|colour grade/)
        .map((n) => n.textContent);
      expect(titles).toEqual([
        "add captions to the interview",
        "trim the intro",
        "colour grade the beach shots",
      ]);
    });

    it("calls an empty chat New chat, and says when there is nothing earlier", async () => {
      state.turns = [];
      state.listChats = vi.fn(async () => []);
      render(<ChatView />);
      const list = await open();
      expect(within(list).getByText("New chat")).toBeVisible();
      expect(await within(list).findByText("No earlier chats yet")).toBeVisible();
    });

    it("opens an earlier chat when it is clicked, and closes the list", async () => {
      state.turns = [turn("t1", "hello")];
      state.listChats = vi.fn(async () => earlier);
      render(<ChatView />);
      const list = await open();
      fireEvent.click(await within(list).findByText("trim the intro"));
      expect(state.openChat).toHaveBeenCalledWith("c-new");
      await waitFor(() =>
        expect(screen.queryByRole("group", { name: "Chats in this project" })).toBeNull(),
      );
    });

    it("tells the person when a chat could not be opened, and keeps the list open", async () => {
      state.turns = [turn("t1", "hello")];
      state.listChats = vi.fn(async () => earlier);
      state.openChat = vi.fn(async () => false);
      render(<ChatView />);
      const list = await open();
      fireEvent.click(await within(list).findByText("trim the intro"));
      expect(await within(list).findByRole("alert")).toHaveTextContent("couldn't be opened");
      expect(screen.getByRole("group", { name: "Chats in this project" })).toBeVisible();
    });

    it("says so when the list cannot be read, instead of claiming there are no chats", async () => {
      state.turns = [turn("t1", "hello")];
      state.listChats = vi.fn(async () => {
        throw new Error("EACCES");
      });
      render(<ChatView />);
      const list = await open();
      expect(await within(list).findByRole("alert")).toHaveTextContent(
        "Couldn't read your earlier chats",
      );
      expect(within(list).queryByText("No earlier chats yet")).toBeNull();
    });

    it("cannot open or delete a chat while the assistant is working", async () => {
      state.turns = [turn("t1", "hello")];
      state.streaming = true;
      state.listChats = vi.fn(async () => earlier);
      render(<ChatView />);
      const list = await open();
      const row = (await within(list).findByText("trim the intro")).closest("button")!;
      expect(row).toBeDisabled();
      expect(
        within(list).getByRole("button", { name: /Delete chat: trim the intro/ }),
      ).toBeDisabled();
    });

    it("asks before deleting a chat, names it, and deletes only when told to", async () => {
      state.turns = [turn("t1", "hello")];
      state.listChats = vi.fn(async () => earlier);
      render(<ChatView />);
      const list = await open();
      await within(list).findByText("trim the intro");

      fireEvent.click(within(list).getByRole("button", { name: /Delete chat: trim the intro/ }));
      const dialog = screen.getByRole("dialog", { name: "Delete this chat?" });
      expect(within(dialog).getByText(/“trim the intro” will be deleted for good/)).toBeVisible();
      expect(within(dialog).getByText(/timeline and media are not changed/)).toBeVisible();
      expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus(); // a stray Enter keeps it

      fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
      expect(state.deleteChat).not.toHaveBeenCalled();
      expect(screen.queryByRole("dialog")).toBeNull();

      fireEvent.click(within(list).getByRole("button", { name: /Delete chat: trim the intro/ }));
      fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" }));
      await waitFor(() => expect(state.deleteChat).toHaveBeenCalledWith("c-new"));
      await waitFor(() => expect(state.listChats).toHaveBeenCalledTimes(2)); // the list is read again
    });

    it("the open chat cannot be deleted from the list", async () => {
      state.turns = [turn("t1", "hello")];
      state.listChats = vi.fn(async () => earlier);
      render(<ChatView />);
      const list = await open();
      await within(list).findByText("trim the intro");
      expect(within(list).getAllByRole("button", { name: /Delete chat/ })).toHaveLength(2); // only the earlier two
    });

    it("closes on Escape and on a click outside, not on a click inside", async () => {
      state.turns = [turn("t1", "hello")];
      state.listChats = vi.fn(async () => earlier);
      render(<ChatView />);
      const list = await open();
      fireEvent.mouseDown(list);
      expect(screen.getByRole("group", { name: "Chats in this project" })).toBeVisible();
      fireEvent.keyDown(document.body, { key: "Escape" });
      await waitFor(() =>
        expect(screen.queryByRole("group", { name: "Chats in this project" })).toBeNull(),
      );
      await open();
      fireEvent.mouseDown(document.body);
      await waitFor(() =>
        expect(screen.queryByRole("group", { name: "Chats in this project" })).toBeNull(),
      );
    });

    it("a slow list from an earlier open never overwrites the newest one", async () => {
      state.turns = [turn("t1", "hello")];
      const deferred = () => {
        let resolve!: (v: typeof earlier) => void;
        const promise = new Promise<typeof earlier>((r) => (resolve = r));
        return { promise, resolve };
      };
      const first = deferred();
      const second = deferred();
      state.listChats = vi
        .fn()
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise);
      render(<ChatView />);
      const toggle = assistant().getByRole("button", { name: "Chat history" });
      fireEvent.click(toggle); // first read starts
      fireEvent.click(toggle); // closed
      fireEvent.click(toggle); // second read starts
      await act(async () => {
        second.resolve([{ id: "new", title: "the newest list", updatedAt: ago(HOUR) }]);
      });
      await act(async () => {
        first.resolve([{ id: "old", title: "a stale list", updatedAt: ago(HOUR) }]);
      });
      expect(await screen.findByText("the newest list")).toBeVisible();
      expect(screen.queryByText("a stale list")).toBeNull();
    });
  });

  describe("Going back over work made outside the chat", () => {
    const ask = (action: string, extra: Record<string, unknown> = {}) => {
      state.turns = [turn("t1", "trim the intro", { checkpoint: { fps: 30, tracks: [] } })];
      state.rewind = { action, ...extra };
    };

    it("asks first, in plain words, and offers to go back anyway or to keep the work", () => {
      ask("restore", { turnId: "t1" });
      render(<ChatView />);
      const dialog = screen.getByRole("dialog", { name: "Go back?" });
      expect(dialog).toHaveTextContent(
        "changed since this chat last edited it, by hand or in another chat",
      );
      expect(dialog).toHaveTextContent(
        "Going back replaces the timeline, and those changes will be lost",
      );
      expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
      fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
      expect(state.cancelRewind).toHaveBeenCalledTimes(1);
      expect(state.confirmRewind).not.toHaveBeenCalled();
    });

    it("hands the prompt back to the composer once the person agrees to a restore", async () => {
      ask("restore", { turnId: "t1" });
      state.confirmRewind = vi.fn(async () => ({ text: "trim the intro", attachments: [] }));
      render(<ChatView />);
      fireEvent.click(
        within(screen.getByRole("dialog")).getByRole("button", { name: "Go back anyway" }),
      );
      await waitFor(() => expect(state.confirmRewind).toHaveBeenCalledTimes(1));
      await waitFor(() =>
        expect(screen.getByPlaceholderText(/Message the editor/)).toHaveValue("trim the intro"),
      );
    });

    it("says forward for a redo, and does not touch the composer", async () => {
      ask("redo");
      render(<ChatView />);
      const dialog = screen.getByRole("dialog", { name: "Go forward?" });
      expect(dialog).toHaveTextContent("Going forward replaces the timeline");
      fireEvent.click(within(dialog).getByRole("button", { name: "Go forward anyway" }));
      await waitFor(() => expect(state.confirmRewind).toHaveBeenCalledTimes(1));
      expect(screen.getByPlaceholderText(/Message the editor/)).toHaveValue("");
    });

    it("is not shown when nothing is waiting", () => {
      state.turns = [turn("t1", "hi")];
      render(<ChatView />);
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("Escape keeps the work", () => {
      ask("undo");
      render(<ChatView />);
      fireEvent.keyDown(
        within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }),
        { key: "Escape" },
      );
      expect(state.cancelRewind).toHaveBeenCalledTimes(1);
    });
  });

  describe("Undo restore", () => {
    const restoredState = () => {
      state.turns = [
        turn("t1", "add a title"),
        turn("t2", "make the intro much shorter and punchier please", { undone: true }),
      ];
      state.restored = { turnId: "t2", before: null, hid: ["t2"] };
    };

    it("is one click away after a restore, and says which message it went back before", () => {
      restoredState();
      render(<ChatView />);
      const bar = screen.getByRole("status");
      expect(bar).toHaveTextContent(
        "Went back to before “make the intro much shorter and punchier…”",
      );
      fireEvent.click(within(bar).getByRole("button", { name: "Undo restore" }));
      expect(state.undoRestore).toHaveBeenCalledTimes(1);
    });

    it("is not there when nothing was restored, or when the turn it names is gone", () => {
      state.turns = [turn("t1", "hi")];
      render(<ChatView />);
      expect(screen.queryByRole("button", { name: "Undo restore" })).toBeNull();
      restoredState();
      state.restored = { turnId: "no-such-turn", before: null, hid: [] };
      render(<ChatView />);
      expect(screen.queryByRole("button", { name: "Undo restore" })).toBeNull();
    });

    it("waits while the assistant works or a chat is being swapped", () => {
      restoredState();
      state.streaming = true;
      render(<ChatView />);
      expect(screen.getByRole("button", { name: "Undo restore" })).toBeDisabled();
    });

    /** Press Restore Checkpoint (the composer gets the prompt back), then show the chat as restored. */
    async function restoreThen(
      view: ReturnType<typeof render>,
      then?: (composer: HTMLElement) => void,
    ) {
      state.turns = [turn("t1", "make it shorter", { checkpoint: { fps: 30, tracks: [] } })];
      state.restoreTo = vi.fn(async () => ({ text: "make it shorter", attachments: [] }));
      view.rerender(<ChatView />);
      const composer = screen.getByPlaceholderText(/Message the editor/);
      fireEvent.click(screen.getByRole("button", { name: /Restore Checkpoint/ }));
      await waitFor(() => expect(composer).toHaveValue("make it shorter"));
      then?.(composer);
      state.turns = [turn("t1", "make it shorter", { undone: true })];
      state.restored = { turnId: "t1", before: null, hid: ["t1"] };
      view.rerender(<ChatView />);
      return composer;
    }

    it("takes the prompt the restore put in the composer out again: it is back in the chat, and sent twice otherwise", async () => {
      const composer = await restoreThen(render(<ChatView />));
      fireEvent.click(screen.getByRole("button", { name: "Undo restore" }));
      await waitFor(() => expect(state.undoRestore).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(composer).toHaveValue(""));
    });

    it("keeps what the person wrote in the composer instead, once they changed the prompt", async () => {
      const composer = await restoreThen(render(<ChatView />), (box) =>
        fireEvent.change(box, { target: { value: "make it shorter, and add a title" } }),
      );
      fireEvent.click(screen.getByRole("button", { name: "Undo restore" }));
      await waitFor(() => expect(state.undoRestore).toHaveBeenCalledTimes(1));
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0)); // long enough for a wrong clear to have happened
      });
      expect(composer).toHaveValue("make it shorter, and add a title");
    });

    it("also takes the prompt out of the composer when the person agrees to undo the restore over outside changes", async () => {
      const view = render(<ChatView />);
      const composer = await restoreThen(view); // the composer holds the prompt the restore handed back
      state.rewind = { action: "undo_restore" }; // the project changed meanwhile: the store asked first
      view.rerender(<ChatView />);
      fireEvent.click(
        within(screen.getByRole("dialog", { name: "Go back?" })).getByRole("button", {
          name: "Go back anyway",
        }),
      );
      await waitFor(() => expect(state.undoRestore).toHaveBeenCalledWith({ confirmed: true }));
      expect(state.cancelRewind).toHaveBeenCalledTimes(1);
      // The prompt is back in the chat: a composer still holding it would send it twice.
      await waitFor(() => expect(composer).toHaveValue(""));
    });

    it("does not take words out of the composer on the strength of a restore made in another chat", async () => {
      const view = render(<ChatView />);
      const composer = await restoreThen(view); // this chat's restore put "make it shorter" there
      state.transcriptId = "another-chat"; // a different chat opens, with a restore record of its own
      state.turns = [turn("t9", "make it shorter", { undone: true })];
      state.restored = { turnId: "t9", before: null, hid: ["t9"] };
      view.rerender(<ChatView />);
      fireEvent.click(screen.getByRole("button", { name: "Undo restore" }));
      await waitFor(() => expect(state.undoRestore).toHaveBeenCalledTimes(1));
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
      expect(composer).toHaveValue("make it shorter");
    });

    it("leaves the composer alone when the undo did not happen", async () => {
      restoredState();
      state.undoRestore = vi.fn(async () => false);
      render(<ChatView />);
      const composer = screen.getByPlaceholderText(/Message the editor/);
      fireEvent.change(composer, { target: { value: "keep this" } });
      fireEvent.click(screen.getByRole("button", { name: "Undo restore" }));
      await waitFor(() => expect(state.undoRestore).toHaveBeenCalled());
      expect(composer).toHaveValue("keep this");
    });
  });

  describe("a long chat", () => {
    const withContext = (tokens: number) => {
      state.turns = [turn("t1", "hello")];
      state.session = { context_tokens: tokens, cost_usd: 0 };
    };

    it("offers a new chat once the conversation is long, and explains why", () => {
      withContext(100_000);
      render(<ChatView />);
      const link = screen.getByRole("button", { name: "Start a new chat" });
      expect(link).toHaveAttribute(
        "title",
        expect.stringContaining("slower and uses more credits"),
      );
      fireEvent.click(link);
      expect(state.newChat).toHaveBeenCalledTimes(1);
    });

    it("says nothing about it in a chat that is not long yet", () => {
      withContext(99_999);
      render(<ChatView />);
      expect(screen.queryByRole("button", { name: "Start a new chat" })).toBeNull();
    });

    it.each([
      ["while the assistant is working", { streaming: true }],
      ["while the project is closing", { closing: true }],
      ["while a chat is being swapped in", { switching: true }],
    ])("does not interrupt %s", (_name, patch) => {
      withContext(250_000);
      Object.assign(state, patch);
      render(<ChatView />);
      expect(screen.queryByRole("button", { name: "Start a new chat" })).toBeNull();
    });
  });

  it("does not send a message while a chat is being swapped, and keeps the words typed", () => {
    state.turns = [turn("t1", "hello")];
    state.switching = true;
    render(<ChatView />);
    const composer = screen.getByPlaceholderText(/Message the editor/);
    fireEvent.change(composer, { target: { value: "do the thing" } });
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    fireEvent.keyDown(composer, { key: "Enter" });
    expect(state.send).not.toHaveBeenCalled();
    expect(composer).toHaveValue("do the thing"); // not cleared into a send that was refused
  });

  it("a Restore Checkpoint waits while a chat is being swapped", () => {
    state.turns = [turn("t1", "hello", { checkpoint: { fps: 30, tracks: [] } })];
    state.switching = true;
    render(<ChatView />);
    expect(screen.getByRole("button", { name: /Restore Checkpoint/ })).toBeDisabled();
  });
});
