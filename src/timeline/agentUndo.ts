// What the person does to the agent's edits soon after it makes them: Undo or Redo in the editor, Undo, Redo or
// Restore in the chat, or a clip put back the way it was by hand. Each is one small event (api/agentEvents.ts
// recordAgentEditUndo): which tool made the edit, how long ago, and where it was taken back; never what the edit was.
// The user-journey analysis turns them into an undo rate per tool and per model (art-daddy/backlog#131).
//
// Who made an edit is decided where it is committed: an agent's tool call commits through the agent's view of the
// store, which names the call (tools/agentCall.ts), and the timeline's history keeps that call on the edit's slot
// (TimelineSession). Everything made through the editor's own store is the person's. So the person's Undo is told
// apart from the agent's own `undo` tool and from an outside agent's over MCP, which never count.
//
// Nothing here runs while the build keeps the events dark (undoEventsOn): no comparison, no memory.
import { recordAgentEditUndo, undoEventsOn, type AgentEditCall } from "../api/agentEvents";
import { openDocumentByDir } from "../project/openDocuments";
import { clipChanges, clipsPutBack, clipStates, type ClipChange } from "./handRevert";
import type { Timeline } from "./model";
import type { AgentEditRecord, TimelineHistoryResult, TimelineSession } from "./TimelineSession";

/** How long after the agent made an edit taking it back still counts as soon after: the person's answer to that edit, not a
 *  later change of mind. */
export const AGENT_EDIT_WINDOW_MS = 30 * 60_000;

/** The most takings back remembered until they are brought back (a Redo that follows an Undo cancels it). */
const MAX_REMEMBERED = 200;

const recent = (at: number | undefined, now: number): at is number =>
  typeof at === "number" && Number.isFinite(at) && now - at <= AGENT_EDIT_WINDOW_MS;

/** Edits whose taking back was told, by call and time, until they are brought back. Oldest first. */
const takenBack = new Map<string, { by: AgentEditCall; at: number }>();
/** Edits already told as put back by hand, so a second touch of the same clip does not tell it twice. */
const putBackByHand = new WeakSet<object>();
/** What each agent edit did to its clips, worked out once per edit. */
const changes = new WeakMap<object, Map<string, ClipChange>>();

const key = (by: AgentEditCall, at: number): string => `${by.callId}\u0000${at}`;

/** A count is never worth a failed edit: whatever goes wrong while noticing is dropped. */
function quietly(work: () => void): void {
  try {
    work();
  } catch {
    // nothing: the edit, the undo or the restore already happened
  }
}

function tellTakenBack(
  by: AgentEditCall,
  at: number,
  via: "editor" | "chat" | "hand",
  now: number,
): void {
  recordAgentEditUndo("edit_undone", by, via, now - at);
  const k = key(by, at);
  takenBack.delete(k);
  takenBack.set(k, { by, at });
  while (takenBack.size > MAX_REMEMBERED) takenBack.delete(takenBack.keys().next().value as string);
}

/** The editor's Undo or Redo moved a slot of the history (`moved`, from TimelineSession.undo or redo). Told only when the
 *  person asked (`byPerson`: the editor's own store, not an agent's view) and the slot is an agent's edit: an Undo of one
 *  made in the last AGENT_EDIT_WINDOW_MS, or a Redo of one whose Undo was told. */
export function noteHistoryMove(
  direction: "undo" | "redo",
  moved: TimelineHistoryResult,
  byPerson: boolean,
  now = Date.now(),
): void {
  if (!undoEventsOn() || !byPerson || !moved.ok || !moved.by || typeof moved.at !== "number")
    return;
  const { by, at } = moved;
  quietly(() => {
    if (direction === "undo") {
      if (recent(at, now)) tellTakenBack(by, at, "editor", now);
      return;
    }
    if (takenBack.delete(key(by, at))) recordAgentEditUndo("edit_redone", by, "editor", now - at);
  });
}

/** The person changed the timeline by hand, from `before` to `after`, and `session` already holds the change. For each of
 *  the agent's recent edits still on the timeline, told once, if this put one of its clips back the way it was. */
export function noteHandEdit(
  session: TimelineSession,
  before: Timeline,
  after: Timeline,
  now = Date.now(),
): void {
  if (!undoEventsOn()) return;
  quietly(() => {
    const edits = session
      .agentEdits()
      .filter((edit) => recent(edit.at, now) && !putBackByHand.has(edit.key));
    if (!edits.length) return;
    const handBefore = clipStates(before);
    const handAfter = clipStates(after);
    for (const edit of edits) {
      let change = changes.get(edit.key);
      if (!change) {
        change = clipChanges(edit.before, edit.after);
        changes.set(edit.key, change);
      }
      if (!clipsPutBack(change, handBefore, handAfter).length) continue;
      putBackByHand.add(edit.key);
      tellTakenBack(edit.by, edit.at, "hand", now);
    }
  });
}

/** The ids of the tool calls made in these chat turns (their `tool_call` parts). */
export function toolCallIds(
  turns: Iterable<{
    readonly parts: readonly { readonly kind: string; readonly [k: string]: unknown }[];
  }>,
): Set<string> {
  const ids = new Set<string>();
  for (const turn of turns)
    for (const part of turn.parts ?? [])
      if (part.kind === "tool_call" && typeof part.call_id === "string" && part.call_id)
        ids.add(part.call_id);
  return ids;
}

/** The agent's recent edits still on the timeline of the project in `projectDir` that these calls made: what the chat's Undo
 *  or Restore is about to take back. Read BEFORE the restore, which starts the history over. Empty while the events are
 *  dark, or when nothing of the project is open in memory. */
export function agentEditsOfCalls(
  projectDir: string,
  calls: ReadonlySet<string>,
  now = Date.now(),
): AgentEditRecord[] {
  if (!undoEventsOn() || !calls.size) return [];
  let out: AgentEditRecord[] = [];
  quietly(() => {
    const session = openDocumentByDir(projectDir)?.timeline;
    out = (session?.agentEdits() ?? []).filter(
      (edit) => calls.has(edit.by.callId) && recent(edit.at, now),
    );
  });
  return out;
}

/** The chat's Undo or Restore took these edits back (from agentEditsOfCalls, read before it): told once per call. */
export function noteChatUndo(edits: readonly AgentEditRecord[], now = Date.now()): void {
  if (!undoEventsOn()) return;
  quietly(() => {
    const told = new Set<string>();
    for (const edit of edits) {
      if (told.has(edit.by.callId)) continue;
      told.add(edit.by.callId);
      tellTakenBack(edit.by, edit.at, "chat", now);
    }
  });
}

/** The chat's Redo or "Undo restore" brought these calls' turns back: told for each whose taking back was told. */
export function noteChatRedo(calls: ReadonlySet<string>, now = Date.now()): void {
  if (!undoEventsOn() || !calls.size) return;
  quietly(() => {
    const told = new Set<string>();
    for (const [k, edit] of [...takenBack]) {
      if (!calls.has(edit.by.callId)) continue;
      takenBack.delete(k);
      if (told.has(edit.by.callId)) continue;
      told.add(edit.by.callId);
      recordAgentEditUndo("edit_redone", edit.by, "chat", now - edit.at);
    }
  });
}

/** Tests only. */
export function __resetAgentUndo(): void {
  takenBack.clear();
}
