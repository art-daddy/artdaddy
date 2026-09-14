import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { startDesktopSignIn } from "../api/desktopAuth";
import type { ApprovalMode, Attachment, FileNode, SessionState } from "../api/types";
import { getUsage, refreshUsage, subscribeUsage } from "../api/usage";
import type { FeedbackKind } from "../api/feedback";
import { BRAND } from "../brand";
import { listProjectFiles } from "../lib/files";
import { onOsDragOver, onOsDrop, webOwnsFileDrops } from "../lib/osDrop";
import {
  filesFromItems,
  uploadFiles as importFiles,
  importPaths,
  importViaDialog,
  MEDIA_RE,
} from "../lib/upload";
import { useChat } from "../store/chat";
import { useAuth } from "../store/auth";
import { useEditor } from "../store/editor";
import { takeFirstPrompt } from "../store/firstPrompt";
import { mentionKey, mentionLabel } from "../timeline/mentions";
import {
  buildMentionOptions,
  detectAtQuery,
  stripAtQuery,
  type MentionOption,
} from "../timeline/mentionOptions";
import ApprovalBar from "./ApprovalBar";
import MessagePart from "./MessagePart";
import { Pane } from "./Pane";
import ReportProblemDialog from "./ReportProblemDialog";
import { trackLabelById } from "./timeline/labels";
import ToolCalls from "./ToolCalls";
import { buildRows, type SummaryContext } from "./toolSummary";
import { STARTER_PROMPTS } from "./starterPrompts";
import { jobNoteSummary } from "./jobNoteSummary";
import { Button, Spinner, cn } from "./ui";
import { useMcpPanel } from "../store/mcpPanel";
import { useProjectNotice } from "../store/projectNotice";
import { attachmentKindFromName, mediaKindFromName } from "./chatMedia";

// Gemini ids route to the Gemini provider server-side by prefix (attachments.is_gemini_model),
// so adding them here is all that is needed to offer them. The gemini-3.x family is withdrawn for
// now and the server refuses it too, so listing one here would only produce a 400.
const MODELS = ["gpt-5.4-mini", "gpt-5.4"];
const EFFORTS = ["none", "low", "medium", "high", "xhigh"];
const MODES: ApprovalMode[] = ["default", "autopilot"];
// "default" alone says nothing about what it decides; the value stays as the stored/wire form.
const MODE_LABELS: Record<ApprovalMode, string> = {
  default: "Default permissions",
  autopilot: "Autopilot",
};

/** Flatten the project file tree to library media refs for the @ picker. */
function collectMediaRefs(nodes: FileNode[]): { ref: string; name: string; kind: string }[] {
  const out: { ref: string; name: string; kind: string }[] = [];
  for (const n of nodes) {
    if (n.type === "dir") out.push(...collectMediaRefs(n.children ?? []));
    else if (MEDIA_RE.test(n.name))
      out.push({ ref: n.path, name: n.name, kind: mediaKindFromName(n.name) });
  }
  return out;
}

/** Outline thumbs-up/down (Copilot-style): muted stroke icon that fills in when
 *  selected. `down` flips to the thumbs-down glyph. */
function ThumbIcon({ down = false, filled = false }: { down?: boolean; filled?: boolean }) {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {down ? (
        <>
          <path d="M17 14V2" />
          <path d="M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88Z" />
        </>
      ) : (
        <>
          <path d="M7 10v12" />
          <path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z" />
        </>
      )}
    </svg>
  );
}

export default function ChatView({ onHide }: { onHide?: () => void } = {}) {
  const {
    turns,
    projectId,
    streaming,
    pending,
    session,
    model,
    effort,
    mode,
    error,
    setControls,
    send,
    approve,
    deny,
    undo,
    redo,
    restoreTo,
    stop,
    canContinue,
    continueRun,
    pendingMentions,
    addMention,
    removeMention,
    sendFeedback,
  } = useChat();
  const aiStatus = useAuth((s) => s.status);
  const openSignIn = () => void startDesktopSignIn();
  const verifyAuth = useAuth((s) => s.verify);
  const aiReady = aiStatus === "unlocked";
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [media, setMedia] = useState<{ ref: string; name: string; kind: string }[]>([]);
  const [picker, setPicker] = useState<{
    query: string;
    options: MentionOption[];
    fromAt: boolean;
  } | null>(null);
  const [rated, setRated] = useState<Record<string, FeedbackKind>>({});
  const [reportingTurn, setReportingTurn] = useState<string | null>(null);

  useLayoutEffect(() => {
    const composer = composerRef.current;
    if (!composer) return;

    if (!text) {
      composer.style.height = "";
      composer.style.overflowY = "hidden";
      return;
    }

    composer.style.height = "auto";
    const style = getComputedStyle(composer);
    const lineHeight = Number.parseFloat(style.lineHeight);
    const chrome =
      Number.parseFloat(style.paddingTop) +
      Number.parseFloat(style.paddingBottom) +
      Number.parseFloat(style.borderTopWidth) +
      Number.parseFloat(style.borderBottomWidth);
    const maxHeight = lineHeight * 10 + chrome;
    const contentHeight =
      composer.scrollHeight +
      Number.parseFloat(style.borderTopWidth) +
      Number.parseFloat(style.borderBottomWidth);

    composer.style.height = `${Math.min(contentHeight, maxHeight)}px`;
    composer.style.overflowY = contentHeight > maxHeight ? "auto" : "hidden";
  }, [text]);

  // Tool summaries name a track the way the ruler does. Subscribed rather than read once,
  // so adding a track relabels the sentences with it. A track the transcript mentions but
  // the timeline no longer has keeps its raw id, which is at least honest.
  const tracks = useEditor((s) => s.timeline?.tracks);
  const summaryCtx: SummaryContext = useMemo(() => {
    const byId = trackLabelById(tracks ?? []);
    return { trackLabel: (id: string) => byId[id] ?? id };
  }, [tracks]);

  // Thumbs / report: optimistically mark the turn, roll back if the upload fails.
  const rate = (turnId: string, kind: FeedbackKind, requestId?: string) => {
    setRated((r) => ({ ...r, [turnId]: kind }));
    void sendFeedback(kind, { requestId }).then((ok) => {
      if (!ok)
        setRated((r) => {
          const n = { ...r };
          delete n[turnId];
          return n;
        });
    });
  };

  // A report carries the user's note, so it is marked sent only once stored (the
  // dialog stays open on failure so the typed text survives a retry).
  const submitReport = async (note: string): Promise<boolean> => {
    const turnId = reportingTurn;
    if (!turnId) return false;
    const ok = await sendFeedback("report", { note });
    if (ok) {
      setRated((r) => ({ ...r, [turnId]: "report" }));
      setReportingTurn(null);
    }
    return ok;
  };

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [turns, streaming]);

  // What the user typed in the assistant pane before this project existed.
  useEffect(() => {
    const first = takeFirstPrompt();
    if (first) setText(first);
  }, []);

  // Media list for the @ / Add-context picker; refetched on import (like FileTree).
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    const load = () =>
      listProjectFiles(projectId)
        .then((t) => !cancelled && setMedia(collectMediaRefs(t)))
        .catch(() => undefined);
    void load();
    window.addEventListener("artdaddy:files-changed", load);
    return () => {
      cancelled = true;
      window.removeEventListener("artdaddy:files-changed", load);
    };
  }, [projectId]);

  // Read the LIVE editor state on demand (not via a subscription) so scrubbing
  // the playhead doesn't re-render the whole transcript.
  const openPicker = (query: string, fromAt: boolean) => {
    const ed = useEditor.getState();
    const fps = Number(ed.timeline?.canvas?.fps) || 30;
    const options = buildMentionOptions(
      {
        timeline: ed.timeline,
        playheadFrame: ed.timeline ? Math.max(0, Math.round(ed.playhead * fps)) : null,
        selectedRange: ed.selectedRange,
        selectedGap: ed.selectedGap,
        media,
      },
      query,
    );
    setPicker({ query, options, fromAt });
  };

  const chooseMention = (opt: MentionOption) => {
    addMention(opt.mention);
    if (picker?.fromAt) setText((t) => stripAtQuery(t));
    setPicker(null);
  };

  const onChangeText = (v: string) => {
    setText(v);
    const q = detectAtQuery(v);
    if (q !== null) openPicker(q, true);
    else if (picker?.fromAt) setPicker(null);
  };

  const addAttachments = useCallback(
    (uploaded: { rel: string; name: string }[]) =>
      setAttachments((prev) => [
        ...prev,
        // Send the PORTABLE library ref (project-relative), never an absolute
        // system path - the model only ever sees the asset id (other NLEs model).
        // Subtitles are imported but not attached: there is nothing to look at or listen to.
        ...uploaded.flatMap((u): Attachment[] => {
          const kind = attachmentKindFromName(u.name);
          return kind ? [{ path: u.rel, kind, caption: u.name }] : [];
        }),
      ]),
    [],
  );

  const uploadFiles = async (files: File[]) => {
    if (!projectId || files.length === 0) return;
    setUploading(true);
    try {
      // Through the shared importer, which REPORTS a failure. Importing here directly is how
      // a rejected attach became an unhandled rejection and the user saw nothing at all.
      addAttachments(await importFiles(projectId, files));
    } catch (e) {
      // uploadFiles reports per-FILE failures; this catches a throw of the boundary itself, which
      // would otherwise be an unhandled rejection and show the user nothing at all.
      useProjectNotice
        .getState()
        .notify(`Couldn't attach: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setUploading(false);
    }
  };

  // A file dropped on the composer attaches it. On desktop the drop arrives from Tauri as a
  // PATH, so it is LINKED in place exactly like File > Import rather than copied; the composer
  // had no drop target of any kind before, so dropping media here did nothing at all.
  useEffect(() => {
    if (!projectId) return;
    const off = onOsDrop("chat", (d) => {
      setDragOver(false);
      const media = d.paths.filter((p) => MEDIA_RE.test(p));
      if (!media.length) return;
      setUploading(true);
      void importPaths(projectId, media)
        .then(addAttachments)
        .finally(() => setUploading(false));
    });
    const offOver = onOsDragOver((d) => setDragOver(d?.target === "chat"));
    return () => {
      off();
      offOver();
    };
  }, [projectId, addAttachments]);

  /** Desktop opens the OS dialog; the hidden input is the WEB fallback only — a file input
   *  never opens on macOS while the window keeps native drag-drop. */
  const onAttachClick = async () => {
    if (!projectId) return;
    setUploading(true);
    try {
      const picked = await importViaDialog(projectId, "Attach media");
      if (picked === null) {
        fileInputRef.current?.click();
        return;
      }
      addAttachments(picked);
    } catch (e) {
      useProjectNotice
        .getState()
        .notify(`Couldn't attach: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setUploading(false);
    }
  };

  const onPickFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = ""; // allow re-picking the same file
    await uploadFiles(files);
  };

  // Ctrl/Cmd+V of a clipboard image/video auto-attaches it (Copilot-style). Shared with the
  // library's paste: naming the file from the raw MIME subtype produced `.jpeg` / `.quicktime`
  // and imported macOS's preview still of a copied video instead of the video.
  const onPaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = filesFromItems(e.clipboardData?.items);
    if (files.length === 0) return;
    e.preventDefault();
    await uploadFiles(files);
  };

  const onSend = () => {
    if (!aiReady) {
      openSignIn();
      return;
    }
    if (!text.trim() || streaming || uploading) return;
    const t = text;
    const atts = attachments;
    setText("");
    setAttachments([]);
    void send(t, atts);
  };

  const canUndo = session?.can_undo ?? false;
  const canRedo = session?.can_redo ?? false;

  // Restoring a checkpoint takes the conversation back to before that prompt, so the prompt
  // and everything after it leave the transcript and the text returns to the composer, ready
  // to edit and resend. Redo is still reachable from the toolbar above.
  const onRestore = async (turnId: string) => {
    const restored = await restoreTo(turnId);
    if (!restored) return;
    setText(restored.text);
    setAttachments(restored.attachments);
  };
  const visibleTurns = turns.filter((t) => !t.undone);

  return (
    <Pane title="Assistant" onHide={onHide} bodyClassName="flex min-h-0 flex-col overflow-hidden">
      <div ref={scrollRef} className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {visibleTurns.length === 0 && (
          <div className="pt-2">
            <p className="mb-3 text-center text-sm text-neutral-400">
              Ask anything, or start with:
            </p>
            <div className="space-y-1.5">
              {STARTER_PROMPTS.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  disabled={!aiReady}
                  // Fills the composer instead of sending: the user still gets to edit it, and
                  // several of these reach paid generation, so a stray click must not spend.
                  onClick={() => {
                    setText(p.text);
                    composerRef.current?.focus();
                  }}
                  title={p.text}
                  className="flex w-full items-center gap-2 rounded-lg border border-edge bg-neutral-900/60 px-3 py-2 text-left text-sm text-neutral-300 hover:border-neutral-600 hover:bg-neutral-800 hover:text-neutral-100 disabled:opacity-40"
                >
                  <span aria-hidden className="text-neutral-600">
                    ›
                  </span>
                  <span className="truncate">{p.label}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        {visibleTurns.map((turn) => (
          <div key={turn.id} className="group space-y-2">
            {turn.checkpoint && (
              <div className="flex justify-center opacity-60 transition-opacity group-hover:opacity-100">
                <button
                  type="button"
                  disabled={streaming}
                  onClick={() => void onRestore(turn.id)}
                  title="Undo back to before this message and put it back in the composer"
                  className="flex items-center gap-1 rounded-full border border-neutral-600 px-2 py-0.5 text-[11px] text-neutral-300 hover:border-neutral-500 hover:bg-neutral-800 hover:text-neutral-100 disabled:opacity-40"
                >
                  ⟲ Restore Checkpoint
                </button>
              </div>
            )}
            {turn.userText &&
              (turn.system ? (
                // The app wrote this, not the user — show it as a note so the transcript never
                // reads as if they typed it.
                <div className="flex justify-center">
                  <div className="max-w-[90%] rounded-md border border-neutral-800 bg-neutral-900/60 px-3 py-1.5 text-center text-[11px] text-neutral-400">
                    {jobNoteSummary(turn.userText)}
                  </div>
                </div>
              ) : (
                <div className="flex justify-end">
                  <div className="max-w-[80%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-accent/20 px-3 py-2 text-sm">
                    {turn.userText}
                  </div>
                </div>
              ))}
            {turn.attachments.length > 0 && (
              <div className="flex flex-wrap justify-end gap-1">
                {turn.attachments.map((a, i) => (
                  <span
                    key={i}
                    className="rounded bg-neutral-800 px-2 py-0.5 text-[11px] text-neutral-400"
                  >
                    📎 {a.caption ?? a.path}
                  </span>
                ))}
              </div>
            )}
            {(turn.parts.length > 0 || turn.status === "streaming") && (
              <div className="flex gap-2.5">
                {/* Fixed height + shrink-0: as a stretching flex item it grew to the whole
                    message and squashed the lion. Plated, because the bare mark is line art
                    and at this size it reads as a blob. */}
                <img
                  src="/icon.png"
                  alt=""
                  aria-hidden
                  className="mt-1 h-[26px] w-[26px] shrink-0 self-start rounded-[7px]"
                />
                <div className="min-w-0 flex-1 space-y-2">
                  {buildRows(
                    turn.parts,
                    summaryCtx,
                    turn.status === "streaming" || turn.status === "awaiting",
                  ).map((row) =>
                    row.kind === "tools" ? (
                      <ToolCalls key={row.key} calls={row.calls} ctx={summaryCtx} />
                    ) : (
                      <MessagePart key={row.key} part={row.part} />
                    ),
                  )}
                  {turn.status === "streaming" && (
                    <div className="flex items-center gap-2 text-xs">
                      <Spinner />
                      <span className="shimmer">working…</span>
                    </div>
                  )}
                </div>
              </div>
            )}
            {turn.status === "done" && (
              <div
                className={cn(
                  "flex items-center gap-0.5 pt-0.5 transition-opacity",
                  rated[turn.id] ? "opacity-100" : "opacity-0 group-hover:opacity-100",
                )}
              >
                <button
                  type="button"
                  onClick={() => rate(turn.id, "up")}
                  disabled={Boolean(rated[turn.id])}
                  title="Good response"
                  aria-label="Good response"
                  className={cn(
                    "rounded-md p-1 text-neutral-500 transition-colors hover:bg-neutral-800 hover:text-neutral-200 disabled:hover:bg-transparent",
                    rated[turn.id] === "up" && "text-accent hover:text-accent",
                  )}
                >
                  <ThumbIcon filled={rated[turn.id] === "up"} />
                </button>
                <button
                  type="button"
                  onClick={() => rate(turn.id, "down")}
                  disabled={Boolean(rated[turn.id])}
                  title="Bad response — sends the transcript + timeline to help us fix it"
                  aria-label="Bad response"
                  className={cn(
                    "rounded-md p-1 text-neutral-500 transition-colors hover:bg-neutral-800 hover:text-neutral-200 disabled:hover:bg-transparent",
                    rated[turn.id] === "down" && "text-accent hover:text-accent",
                  )}
                >
                  <ThumbIcon down filled={rated[turn.id] === "down"} />
                </button>
              </div>
            )}
            {turn.status === "error" && (
              <button
                type="button"
                onClick={() => setReportingTurn(turn.id)}
                disabled={Boolean(rated[turn.id])}
                className="self-start text-[11px] text-red-300/80 underline hover:text-red-200 disabled:text-neutral-500 disabled:no-underline"
              >
                {rated[turn.id] ? "Report sent — thanks" : "Report this problem"}
              </button>
            )}
          </div>
        ))}
        {canContinue && (
          <div className="mx-auto flex max-w-[85%] flex-col items-center gap-2 rounded-lg border border-edge bg-neutral-900/60 px-4 py-3 text-center">
            <p className="text-xs text-neutral-400">
              {BRAND.displayName} has been running for a long time — continue to iterate?
            </p>
            <Button variant="primary" onClick={() => void continueRun()}>
              ▶ Continue
            </Button>
          </div>
        )}
      </div>

      {/* Every gated call in the round, together — one interruption instead of one per
          call — but each still allowed or denied on its own. */}
      {pending?.map((p) => (
        <ApprovalBar
          key={p.call_id}
          pending={p}
          onApprove={() => approve(p.call_id)}
          onDeny={() => deny(undefined, p.call_id)}
        />
      ))}

      {error && (
        <div className="border-t border-red-500/30 bg-red-500/10 px-5 py-2 text-xs text-red-300">
          {error}
        </div>
      )}

      <div
        className={cn(
          "shrink-0 border-t border-edge px-5 py-3",
          dragOver && "ring-2 ring-inset ring-accent",
        )}
        data-artdaddy-drop="chat"
        onDragOver={(e) => {
          // Web only: on desktop the page must not claim the drag (see osDrop).
          if (!webOwnsFileDrops()) return;
          if (![...e.dataTransfer.types].includes("Files")) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
          setDragOver(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false);
        }}
        onDrop={(e) => {
          // Web only: on desktop the drop arrives through osDrop, carrying real paths.
          if (!webOwnsFileDrops()) return;
          setDragOver(false);
          const files = [...(e.dataTransfer.files ?? [])].filter((f) => MEDIA_RE.test(f.name));
          if (!files.length) return;
          e.preventDefault();
          void uploadFiles(files);
        }}
      >
        {attachments.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {attachments.map((a, i) => (
              <span
                key={i}
                className="flex items-center gap-1 rounded bg-neutral-800 px-2 py-0.5 text-[11px] text-neutral-300"
              >
                <span>
                  {a.kind === "video"
                    ? "\uD83C\uDFAC"
                    : a.kind === "audio"
                      ? "\uD83C\uDFB5"
                      : "\uD83D\uDDBC"}
                </span>
                <span className="max-w-[160px] truncate">{a.caption ?? a.path}</span>
                <button
                  type="button"
                  onClick={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}
                  className="ml-0.5 text-neutral-500 hover:text-neutral-200"
                  aria-label="remove attachment"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        {pendingMentions.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {pendingMentions.map((m) => {
              const key = mentionKey(m);
              return (
                <span
                  key={key}
                  className="flex items-center gap-1 rounded bg-accent/20 px-2 py-0.5 text-[11px] text-accent"
                >
                  <span className="max-w-[180px] truncate">@{mentionLabel(m)}</span>
                  <button
                    type="button"
                    onClick={() => removeMention(key)}
                    className="ml-0.5 text-accent/70 hover:text-accent"
                    aria-label="remove mention"
                  >
                    ×
                  </button>
                </span>
              );
            })}
          </div>
        )}
        {picker && picker.options.length > 0 && (
          <div className="mb-2 max-h-56 overflow-y-auto rounded-lg border border-edge bg-neutral-900 py-1 text-sm shadow-xl">
            {picker.options.map((o) => (
              <button
                key={o.key}
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  chooseMention(o);
                }}
                className="flex w-full items-center gap-2 px-3 py-1 text-left hover:bg-neutral-800"
              >
                <span className="w-14 shrink-0 text-[10px] uppercase tracking-wide text-neutral-500">
                  {o.group}
                </span>
                <span className="truncate">{o.label}</span>
              </button>
            ))}
          </div>
        )}
        {!aiReady && (
          <div className="mb-2 flex items-center justify-between gap-2 rounded-md border border-edge bg-neutral-900 px-3 py-2 text-xs text-neutral-400">
            <span>
              {aiStatus === "offline"
                ? "Can't reach the server — editing works offline; reconnect to use AI."
                : // MCP is no longer an alternative to signing in: that door is gated too, so
                  // offering it here would promise something the bridge refuses.
                  "Sign in to use AI. Editing works without it."}
            </span>
            <Button
              variant="ghost"
              onClick={() => {
                if (aiStatus === "offline") void verifyAuth();
                else openSignIn();
              }}
            >
              {aiStatus === "offline" ? "Retry" : "Sign in"}
            </Button>
          </div>
        )}
        <div className="flex items-end gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,video/*,audio/*"
            multiple
            className="hidden"
            onChange={(e) => void onPickFiles(e)}
          />
          <Button
            variant="ghost"
            disabled={!projectId || streaming || uploading || !aiReady}
            onClick={() => void onAttachClick()}
            title="Attach images, video, or audio"
          >
            {uploading ? "\u2026" : "\uD83D\uDCCE"}
          </Button>
          <Button
            variant="ghost"
            disabled={!projectId || streaming || !aiReady}
            onClick={() => (picker && !picker.fromAt ? setPicker(null) : openPicker("", false))}
            title="Add editor context — playhead, range, clip, gap, or media"
          >
            @
          </Button>
          {/* The halo lives on a wrapper, not the textarea: a textarea's pseudo-elements are
              unreliable across engines, and the ring has to sit OUTSIDE the input's own box. */}
          <div className={cn("halo relative min-w-0 flex-1 rounded-lg", streaming && "halo-on")}>
            <textarea
              value={text}
              ref={composerRef}
              disabled={!aiReady}
              onChange={(e) => onChangeText(e.target.value)}
              onPaste={(e) => void onPaste(e)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  onSend();
                }
              }}
              placeholder="Message the editor…"
              rows={1}
              className="relative z-10 min-h-[40px] w-full resize-none overflow-y-hidden rounded-lg border border-edge bg-neutral-900 px-3 py-2 text-sm outline-none focus:border-accent"
            />
          </div>
          {streaming ? (
            <Button variant="danger" onClick={() => void stop()}>
              ⏹ Stop
            </Button>
          ) : (
            <Button
              variant="primary"
              disabled={uploading || !text.trim() || !aiReady}
              onClick={onSend}
            >
              Send
            </Button>
          )}
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
          <Select value={model} onChange={(v) => setControls({ model: v })} options={MODELS} />
          <Select value={effort} onChange={(v) => setControls({ effort: v })} options={EFFORTS} />
          <Select
            value={mode}
            onChange={(v) => setControls({ mode: v as ApprovalMode })}
            options={MODES}
            labels={MODE_LABELS}
            title="Default permissions asks before anything paid, downloaded or deleted. Autopilot runs them."
          />
          <button
            disabled={!canUndo || streaming}
            onClick={() => void undo()}
            title="Undo"
            aria-label="Undo"
            className="rounded px-1.5 py-1 text-neutral-400 hover:bg-neutral-800 disabled:opacity-30"
          >
            ↶
          </button>
          <button
            disabled={!canRedo || streaming}
            onClick={() => void redo()}
            title="Redo"
            aria-label="Redo"
            className="rounded px-1.5 py-1 text-neutral-400 hover:bg-neutral-800 disabled:opacity-30"
          >
            ↷
          </button>
          <McpChip />
          <div className="ml-auto">
            <ContextMeter session={session} model={model} />
          </div>
        </div>
      </div>
      <ReportProblemDialog
        open={reportingTurn !== null}
        onCancel={() => setReportingTurn(null)}
        onSubmit={submitReport}
      />
    </Pane>
  );
}

/** MCP is the app's most-missed feature because it lived only in the Help menu. Sat next to the
 *  model controls, where someone wondering whether another agent can drive this is already
 *  looking, and named for what it DOES — "MCP" alone means nothing to most people. The dot also
 *  gives the server's state a permanent home — previously the only way to tell it was running
 *  was to reopen the dialog. */
function McpChip() {
  const running = useMcpPanel((s) => s.running);
  const openPanel = useMcpPanel((s) => s.openPanel);
  const refresh = useMcpPanel((s) => s.refresh);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <button
      onClick={openPanel}
      title={
        running
          ? "MCP server is running — Claude, Cursor or Codex can edit this project"
          : "Let Claude, Cursor or Codex edit this project"
      }
      className={cn(
        "flex items-center gap-1 whitespace-nowrap rounded px-1.5 py-1 hover:bg-neutral-800",
        running ? "text-brand" : "text-neutral-400",
      )}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full", running ? "bg-brand" : "bg-neutral-600")} />
      Connect your own agent/MCP
    </button>
  );
}

function ContextMeter({ session, model }: { session: SessionState | null; model: string }) {
  const used = session?.context_tokens ?? 0;
  const max = contextWindow(model);
  const pct = max > 0 ? Math.min(100, Math.round((used / max) * 100)) : 0;
  const usage = useSyncExternalStore(subscribeUsage, getUsage);
  // Refresh the credit balance on mount and after each turn (cost changes).
  useEffect(() => {
    void refreshUsage();
  }, [session?.cost_usd]);
  return (
    <div
      className="flex items-center gap-2 text-[11px] text-neutral-500"
      title={`${used.toLocaleString()} / ${max.toLocaleString()} context tokens`}
    >
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-neutral-800">
        <div
          className={cn(
            "h-full",
            pct > 90 ? "bg-red-500" : pct > 70 ? "bg-amber-500" : "bg-accent",
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="tabular-nums">
        {fmtTok(used)}/{fmtTok(max)} · {pct}%
      </span>
      {usage.metered && (
        <span
          className={cn(
            "tabular-nums",
            usage.over ? "font-medium text-red-400" : "text-neutral-400",
          )}
          title={`${Math.round(usage.used).toLocaleString()} / ${Math.round(usage.limit).toLocaleString()} credits used this window`}
        >
          {usage.over ? "0" : fmtTok(Math.max(0, usage.remaining))} cr left
        </span>
      )}
    </div>
  );
}

function contextWindow(model: string): number {
  const m = model.toLowerCase();
  if (m.startsWith("gemini")) return 1_000_000;
  if (m.startsWith("gpt")) return 400_000;
  return 200_000;
}

function fmtTok(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}K`;
  return String(n);
}

function Select({
  value,
  onChange,
  options,
  labels,
  title,
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
  labels?: Record<string, string>;
  title?: string;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      title={title}
      className="rounded border border-edge bg-neutral-900 px-2 py-1"
    >
      {options.map((o) => (
        <option key={o} value={o}>
          {labels?.[o] ?? o}
        </option>
      ))}
    </select>
  );
}
