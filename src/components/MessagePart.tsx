import { useState } from "react";
import type { ReactNode } from "react";

import type { TranscriptPart } from "../api/types";

export default function MessagePart({ part }: { part: TranscriptPart }) {
  const kind = part.kind;

  if (kind === "reasoning") {
    // While it is still arriving, hold it open: reasoning is collapsed by default, so a
    // streamed block would otherwise tick away entirely unseen. It collapses itself once
    // the authoritative part lands.
    const streaming = Boolean(part.partial);
    return (
      <Collapsible
        label={streaming ? "\u{1F4AD} thinking\u2026" : "\u{1F4AD} reasoning"}
        forceOpen={streaming}
      >
        {String(part.text ?? "")}
      </Collapsible>
    );
  }
  if (kind === "text" || kind === "final") {
    const text = String(part.text ?? "");
    if (!text) return null;
    return <div className="whitespace-pre-wrap break-words text-sm text-neutral-200">{text}</div>;
  }
  if (kind === "tool_call" || kind === "tool_result") {
    // ChatView folds these into a ToolCalls row (buildRows), which owns the summary and
    // the raw payload behind its chevron. Reaching here means a caller bypassed that.
    return null;
  }
  if (kind === "error") {
    return (
      <div className="rounded bg-red-500/10 px-3 py-2 text-xs text-red-300">
        ⚠ {String(part.error ?? "error")}
      </div>
    );
  }
  return null;
}

function Collapsible({
  label,
  children,
  forceOpen = false,
}: {
  label: string;
  children: ReactNode;
  forceOpen?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const shown = forceOpen || open;
  return (
    <div className="text-xs">
      <button
        onClick={() => setOpen((v) => !v)}
        className="italic text-neutral-500 hover:text-neutral-300"
      >
        {shown ? "▾" : "▸"} {label}
      </button>
      {shown && (
        <div className="mt-1 whitespace-pre-wrap break-words border-l border-edge pl-2 text-neutral-500">
          {children}
        </div>
      )}
    </div>
  );
}
