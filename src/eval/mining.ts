// Offline transcript mining ("Mode A") — replay a real session's recorded
// transcript.json through the SAME friction analyzer the live eval uses, with zero
// model spend and no media. Turns the on-disk t001–t009 runs into a "model-behavior
// smells" report: recurring tool errors, retry thrash, escape-hatch use, and
// workaround reasoning — ground truth, straight from what the model actually did.
import { analyzeTrace } from "./signals";
import type { Scenario, Signals, ToolCall, Trace } from "./types";

/** Shape of a recorded transcript.json (loose — only the bits we read). */
export interface RawTranscript {
  requests?: Array<{
    message?: { text?: string };
    response?: Array<{
      kind?: string;
      call_id?: string;
      name?: string;
      args?: unknown;
      ok?: boolean;
      error?: string;
      text?: string;
    }>;
  }>;
}

export interface MinedSession {
  id: string;
  prompts: string[];
  trace: Trace;
  signals: Signals;
}

/** Fold a recorded transcript into a Trace (tool calls matched to their results
 *  by call_id) + the user prompts. One Trace per session (whole conversation). */
export function transcriptToTrace(t: RawTranscript): { trace: Trace; prompts: string[] } {
  const toolCalls: ToolCall[] = [];
  const reasoning: string[] = [];
  const prompts: string[] = [];
  const pending = new Map<string, ToolCall>();
  let round = 0;

  for (const req of t.requests ?? []) {
    round += 1;
    if (typeof req.message?.text === "string" && req.message.text.trim())
      prompts.push(req.message.text.trim());
    for (const r of req.response ?? []) {
      if (r.kind === "reasoning" && typeof r.text === "string") {
        reasoning.push(r.text);
      } else if (r.kind === "tool_call") {
        const tc: ToolCall = {
          round,
          name: r.name ?? "?",
          args: (r.args ?? {}) as Record<string, unknown>,
          ok: true,
        };
        toolCalls.push(tc);
        if (r.call_id) pending.set(r.call_id, tc);
      } else if (r.kind === "tool_result") {
        const ok = r.ok !== false;
        const tc = r.call_id ? pending.get(r.call_id) : undefined;
        if (tc) {
          tc.ok = ok;
          if (!ok) tc.error = String(r.error ?? "");
        } else {
          toolCalls.push({
            round,
            name: r.name ?? "?",
            args: {},
            ok,
            error: ok ? undefined : String(r.error ?? ""),
          });
        }
      }
    }
  }

  return {
    trace: {
      toolCalls,
      reasoning,
      rounds: round,
      finalText: "",
      usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, costUsd: 0 },
    },
    prompts,
  };
}

/** Analyze one recorded session (no scenario intent; inefficiency suppressed since
 *  real sessions are legitimately multi-turn). */
export function mineSession(id: string, t: RawTranscript): MinedSession {
  const { trace, prompts } = transcriptToTrace(t);
  const scenario: Scenario = {
    id,
    title: id,
    seed: () => ({}) as never,
    prompt: prompts.join(" | "),
    maxRounds: Number.MAX_SAFE_INTEGER,
  };
  return { id, prompts, trace, signals: analyzeTrace(scenario, trace, []) };
}

/** Normalize an error message so variants (ids/numbers) group together. */
function normalizeError(err: string): string {
  return err
    .replace(/[0-9a-f]{6,}/gi, "#")
    .replace(/\d+/g, "N")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 90);
}

/** Aggregate mined sessions into a markdown "model-behavior smells" report. */
export function mineReport(sessions: MinedSession[]): string {
  // Recurring errors: normalized signature -> {count, sessions}.
  const errors = new Map<string, { count: number; sessions: Set<string> }>();
  for (const s of sessions) {
    for (const e of s.signals.toolErrors) {
      const key = `${e.name}: ${normalizeError(e.error)}`;
      const rec = errors.get(key) ?? { count: 0, sessions: new Set<string>() };
      rec.count += 1;
      rec.sessions.add(s.id);
      errors.set(key, rec);
    }
  }
  const ranked = [...errors.entries()].sort(
    (a, b) => b[1].sessions.size - a[1].sessions.size || b[1].count - a[1].count,
  );

  const L: string[] = [];
  L.push(`# Transcript mining — model-behavior smells`);
  L.push("");
  L.push(
    `Sessions: ${sessions.length} · Total tool calls: ${sessions.reduce((a, s) => a + s.trace.toolCalls.length, 0)} · Total errors: ${sessions.reduce((a, s) => a + s.signals.toolErrors.length, 0)}`,
  );
  L.push("");

  L.push("## Recurring tool errors (ranked by #sessions, then count)");
  if (ranked.length) {
    L.push("| Error | Sessions | Count |");
    L.push("|---|---|---|");
    for (const [key, rec] of ranked.slice(0, 30))
      L.push(`| ${key} | ${[...rec.sessions].sort().join(", ")} | ${rec.count} |`);
  } else {
    L.push("_(no tool errors)_");
  }
  L.push("");

  L.push("## Retry thrash (same tool retried after a rejection)");
  const thrash = sessions
    .flatMap((s) => s.signals.retryLoops.map((r) => ({ s: s.id, ...r })))
    .sort((a, b) => b.attempts - a.attempts);
  L.push(
    thrash.length
      ? thrash.map((t) => `- [${t.s}] \`${t.name}\` ×${t.attempts}`).join("\n")
      : "_(none)_",
  );
  L.push("");

  L.push("## Escape-hatch usage (raw ffmpeg / low-level)");
  const hatches = sessions
    .filter((s) => s.signals.escapeHatchUsed.length)
    .map((s) => `- [${s.id}] ${s.signals.escapeHatchUsed.join(", ")}`);
  L.push(hatches.length ? hatches.join("\n") : "_(none)_");
  L.push("");

  L.push("## Suspected workarounds (reasoning)");
  const wa = sessions.flatMap((s) => s.signals.workaroundSuspected.map((w) => `- [${s.id}] ${w}`));
  L.push(wa.length ? wa.slice(0, 25).join("\n") : "_(none)_");
  L.push("");

  L.push("## Per-session");
  L.push("| Session | Turns | Tool calls | Errors | First prompt |");
  L.push("|---|---|---|---|---|");
  for (const s of sessions) {
    const first = (s.prompts[0] ?? "").replace(/\|/g, "/").slice(0, 60);
    L.push(
      `| ${s.id} | ${s.trace.rounds} | ${s.trace.toolCalls.length} | ${s.signals.toolErrors.length} | ${first} |`,
    );
  }
  L.push("");

  return L.join("\n");
}
