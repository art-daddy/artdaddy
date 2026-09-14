import { useState } from "react";

import { rowSummary, type SummaryContext, type ToolCallView } from "./toolSummary";
import { Spinner } from "./ui";

/** A folded run of tool calls: one sentence about what changed, with the raw arguments and
 *  results one click away. The payloads are not hidden, just not the story — a user reading
 *  their own edit history should not have to parse `set_clip_properties`. */
export default function ToolCalls({ calls, ctx }: { calls: ToolCallView[]; ctx: SummaryContext }) {
  const [open, setOpen] = useState(false);
  if (calls.length === 0) return null;

  const running = calls.some((c) => c.running);
  const failed = calls.filter((c) => !c.ok);
  const interrupted = !running && !failed.length && calls.some((c) => c.interrupted);
  const summary = rowSummary(calls, ctx);

  return (
    <div className="text-xs">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 text-left text-neutral-400 hover:text-neutral-200"
        aria-expanded={open}
      >
        <span className="text-neutral-600">{open ? "▾" : "▸"}</span>
        {running ? (
          <Spinner />
        ) : interrupted ? (
          <span className="text-neutral-500" title="stopped before it finished">
            ⊘
          </span>
        ) : (
          <span className={failed.length ? "text-red-400" : "text-emerald-500/70"}>
            {failed.length ? "✗" : "✓"}
          </span>
        )}
        <span className="truncate">{summary}</span>
      </button>

      {/* The first failure's real message, without expanding: a summary that only said
          "Couldn't export the video" would leave the user with nowhere to go. */}
      {!open && failed.length > 0 && failed[0].error && (
        <div className="mt-0.5 pl-5 text-red-300/80">{failed[0].error}</div>
      )}

      {open && (
        <div className="mt-1 space-y-2 border-l border-edge pl-3">
          {calls.map((c, i) => (
            <div key={i}>
              <div className="flex items-center gap-2">
                <code className="text-accent">{c.name}</code>
                <span className="text-neutral-500">{c.text}</span>
              </div>
              {Object.keys(c.args).length > 0 && (
                <pre className="mt-1 overflow-x-auto text-[11px] text-neutral-500">
                  {JSON.stringify(c.args, null, 2)}
                </pre>
              )}
              {c.error && <div className="mt-1 text-[11px] text-red-300">{c.error}</div>}
              {c.result && !c.error && (
                <pre className="mt-1 overflow-x-auto text-[11px] text-neutral-600">
                  {JSON.stringify(c.result, null, 2)}
                </pre>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
