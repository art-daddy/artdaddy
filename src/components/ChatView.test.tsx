import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
vi.mock("../lib/upload", () => ({
  uploadFiles: vi.fn(),
  importViaDialog: vi.fn(async () => null), // web by default: callers fall back to the input
  importPaths: vi.fn(async () => []),
  filesFromItems: vi.fn(() => []),
  MEDIA_RE: /\.(mp4|mov|webm|mkv|m4v|png|jpe?g|gif|webp|bmp|avif|mp3|wav|m4a|aac|flac|ogg)$/i,
}));
vi.mock("../lib/files", () => ({ listProjectFiles: () => Promise.resolve([]) }));
// Stable snapshot (same reference each call) so useSyncExternalStore doesn't loop.
vi.mock("../api/usage", () => {
  const usage = { metered: true, over: false, used: 10, limit: 100, remaining: 1_500_000 };
  return { getUsage: () => usage, subscribeUsage: () => () => {}, refreshUsage: vi.fn() };
});

const startDesktopSignIn = vi.hoisted(() => vi.fn());
vi.mock("../api/desktopAuth", () => ({ startDesktopSignIn }));

import { uploadFiles, importViaDialog, importPaths, filesFromItems } from "../lib/upload";
import ChatView from "./ChatView";
import { STARTER_PROMPTS } from "./starterPrompts";

function baseState() {
  return {
    turns: [],
    projectId: "p1",
    streaming: false,
    pending: null,
    session: null,
    model: "gpt-5.4-mini",
    effort: "high",
    mode: "default",
    error: null,
    pendingMentions: [],
    addMention: vi.fn(),
    removeMention: vi.fn(),
    clearMentions: vi.fn(),
    canContinue: false,
    continueRun: vi.fn(),
    setControls: vi.fn(),
    send: vi.fn(),
    approve: vi.fn(),
    deny: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
    restoreTo: vi.fn(),
    stop: vi.fn(),
    sendFeedback: vi.fn(async () => true),
  };
}

beforeEach(() => {
  Object.assign(state, baseState());
  authState.status = "unlocked";
  platformName = "web";
  vi.mocked(importPaths).mockResolvedValue([]);
  vi.mocked(filesFromItems).mockReturnValue([]);
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
    fireEvent.change(selects[0], { target: { value: "gpt-5.4" } });
    expect(state.setControls).toHaveBeenCalledWith({ model: "gpt-5.4" });
    fireEvent.change(selects[1], { target: { value: "low" } });
    expect(state.setControls).toHaveBeenCalledWith({ effort: "low" });
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
    state.model = "gpt-5.4";
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

  it("ignores a dropped path that is not media", async () => {
    platformName = "tauri";
    render(<ChatView />);
    osDrop({ paths: ["/Users/me/notes.pdf"], target: "chat" });
    await waitFor(() => expect(importPaths).not.toHaveBeenCalled());
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
