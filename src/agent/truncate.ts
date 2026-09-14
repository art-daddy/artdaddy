// Cap a tool result's serialized size before it re-enters the model's context.
// A runaway result (huge transcript, giant metadata dump) bloats context + cost
// and can blow the prompt cache (the $45-run lesson, ideas.md IDEA-V4-006). Like
// Cursor / Copilot, we truncate oversized tool output and tell the model to
// narrow its request — the biggest string field(s) are trimmed first so the
// result keeps its shape.

const DEFAULT_MAX = Number(import.meta.env.VITE_MAX_TOOL_RESULT_CHARS) || 200_000;

function jsonLen(v: unknown): number {
  try {
    return JSON.stringify(v)?.length ?? 0;
  } catch {
    return 0;
  }
}

/** Truncate `result` to at most ~`maxChars` of serialized JSON, flagging it so
 *  the model narrows its request. Trims the largest string fields first (keeping
 *  the object shape); falls back to a compact preview when the bulk isn't in
 *  strings (e.g. a huge array of rows). */
export function capToolResult(
  result: Record<string, unknown>,
  maxChars: number = DEFAULT_MAX,
): Record<string, unknown> {
  if (jsonLen(result) <= maxChars) return result;
  const note = `result exceeded ${maxChars} chars and was truncated — narrow your request (smaller range / fewer items) or ask for a summary.`;

  // Trim strings down to a budget that leaves room for the _note/_truncated flags.
  const budget = Math.max(0, maxChars - note.length - 64);
  const out: Record<string, unknown> = { ...result };
  const stringKeys = Object.keys(out)
    .filter((k) => typeof out[k] === "string")
    .sort((a, b) => (out[b] as string).length - (out[a] as string).length);
  for (const k of stringKeys) {
    if (jsonLen(out) <= budget) break;
    const s = out[k] as string;
    const over = jsonLen(out) - budget;
    const keep = Math.max(0, s.length - over - 64);
    out[k] = `${s.slice(0, keep)}…[truncated ${s.length - keep} chars]`;
  }
  out._truncated = true;
  out._note = note;
  if (jsonLen(out) <= maxChars) return out;

  // Bulk isn't in string fields (many rows / nested arrays): compact summary.
  return {
    ok: (result as { ok?: unknown }).ok ?? true,
    _truncated: true,
    _note: note,
    _preview: (JSON.stringify(result) ?? "").slice(0, Math.min(maxChars, 4000)),
  };
}
