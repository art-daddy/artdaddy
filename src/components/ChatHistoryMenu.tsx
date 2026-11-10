// The Assistant header's chat history: a clock button that opens this project's chats. The open chat
// comes first, then the ones put away, newest first. Click one to open it (the chat on screen is put
// away first); the bin deletes a put-away chat after a confirmation. The popover is positioned against
// the panel (the Pane is `relative`), not the button, so it fits however narrow the panel is dragged.
import { useCallback, useEffect, useRef, useState } from "react";

import { agoLabel } from "../mcp/connections";
import type { ChatSummary } from "../store/transcriptFile";
import ConfirmDialog from "./ConfirmDialog";
import { cn } from "./ui";

/** The look of a small icon button in the Assistant header. */
export const ICON_BUTTON =
  "rounded p-1 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-neutral-500";

const ICON = {
  width: 14,
  height: 14,
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
} as const;

export function PlusIcon() {
  return (
    <svg {...ICON}>
      <path d="M8 3v10M3 8h10" />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg {...ICON}>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.5V8l2.5 1.5" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg {...ICON}>
      <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" />
    </svg>
  );
}

/** How long ago, or nothing when the time does not read (a chat an older build put away). */
function ago(iso: string): string {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? agoLabel(Date.now() - t) : "";
}

export interface ChatHistoryMenuProps {
  /** The open chat: listed first, as it is called now. */
  currentTitle: string;
  /** Opening and deleting are refused for now: the assistant is working, or the project is closing. */
  busy: boolean;
  disabled?: boolean;
  listChats: () => Promise<ChatSummary[]>;
  openChat: (id: string) => Promise<boolean>;
  deleteChat: (id: string) => Promise<boolean>;
}

export default function ChatHistoryMenu({
  currentTitle,
  busy,
  disabled = false,
  listChats,
  openChat,
  deleteChat,
}: ChatHistoryMenuProps) {
  const [open, setOpen] = useState(false);
  const [chats, setChats] = useState<ChatSummary[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<ChatSummary | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  // Only the newest list request may land: a slow one from an earlier open must not overwrite it.
  const requestRef = useRef(0);

  const refresh = useCallback(() => {
    const mine = ++requestRef.current;
    listChats().then(
      (list) => {
        if (mine === requestRef.current) setChats(list);
      },
      () => {
        if (mine !== requestRef.current) return;
        setChats([]);
        setNotice("Couldn't read your earlier chats.");
      },
    );
  }, [listChats]);

  useEffect(() => {
    if (!open) return;
    setNotice(null);
    refresh();
  }, [open, refresh]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const choose = async (chat: ChatSummary) => {
    setNotice(null);
    if (await openChat(chat.id)) setOpen(false);
    else setNotice("That chat couldn't be opened.");
  };

  const confirmDelete = async () => {
    const chat = deleting;
    setDeleting(null);
    if (!chat) return;
    if (!(await deleteChat(chat.id))) setNotice("That chat couldn't be deleted.");
    refresh();
  };

  // The wrapper makes no box of its own: it only lets one outside-click check cover the button, the
  // popover and the dialog, while the popover positions against the panel.
  return (
    <div ref={rootRef} className="contents">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        aria-label="Chat history"
        title="Chat history"
        aria-expanded={open}
        className={cn(ICON_BUTTON, open && "bg-neutral-800 text-neutral-200")}
      >
        <ClockIcon />
      </button>
      {open && (
        <div
          role="group"
          aria-label="Chats in this project"
          className="absolute right-2 top-9 z-40 max-h-[60%] w-[calc(100%-1rem)] max-w-xs overflow-y-auto rounded-lg border border-edge bg-neutral-900 p-1 text-xs shadow-xl"
        >
          <div className="flex items-center gap-2 rounded px-2 py-1.5 bg-neutral-800/60">
            <span className="min-w-0 flex-1 truncate text-neutral-100" title={currentTitle}>
              {currentTitle}
            </span>
            <span className="shrink-0 text-[10px] uppercase tracking-wide text-neutral-500">
              This chat
            </span>
          </div>
          {chats === null && <p className="px-2 py-2 text-neutral-500">Loading…</p>}
          {chats?.length === 0 && !notice && (
            <p className="px-2 py-2 text-neutral-500">No earlier chats yet</p>
          )}
          {chats?.map((chat) => (
            <div
              key={chat.id}
              className="group flex items-center gap-1 rounded hover:bg-neutral-800"
            >
              <button
                type="button"
                onClick={() => void choose(chat)}
                disabled={busy}
                title={busy ? "Available when the assistant is done" : chat.title}
                className="min-w-0 flex-1 px-2 py-1.5 text-left disabled:opacity-50"
              >
                <span className="block truncate text-neutral-200">{chat.title}</span>
                <span className="block text-[10px] text-neutral-500">{ago(chat.updatedAt)}</span>
              </button>
              <button
                type="button"
                onClick={() => setDeleting(chat)}
                disabled={busy}
                aria-label={`Delete chat: ${chat.title}`}
                title="Delete this chat"
                className={cn(ICON_BUTTON, "mr-1 opacity-60 group-hover:opacity-100")}
              >
                <TrashIcon />
              </button>
            </div>
          ))}
          {notice && (
            <p role="alert" className="px-2 py-2 text-red-300">
              {notice}
            </p>
          )}
        </div>
      )}
      <ConfirmDialog
        open={deleting !== null}
        title="Delete this chat?"
        destructive
        confirmLabel="Delete"
        onCancel={() => setDeleting(null)}
        onConfirm={confirmDelete}
      >
        “{deleting?.title}” will be deleted for good. Your timeline and media are not changed.
      </ConfirmDialog>
    </div>
  );
}
