// What each user message of a case carries, built the way the app builds it.
//
// In the app a message is more than the words typed (store/chat.ts `send`): the composer adds the
// files attached to it and the editor refs @mentioned in it, and when the timeline changed outside
// the chat since the agent last saw it (an edit by hand, an undo), the message says so. All of it
// is composed by agent/compose.ts composeModelText; the attachments come from the import's result
// through components/chatMedia.ts attachmentsFromUploads. This module calls those same functions,
// so a case's messages follow the app if its wording changes.
//
// The lab's Copilot host sends a case's messages itself: it must build each one with
// `composeTurn`, apply each `editedBefore` with `applyOutsideEdit` before the message it comes
// with, and grade against `gradingBaseline`, exactly as the harness does.
import { composeModelText } from "../agent/compose";
import { attachmentsFromUploads } from "../components/chatMedia";
import { applyOp } from "../timeline/engine";
import type { Timeline } from "../timeline/model";
import type { ProjectStoreAccess } from "../tools/store";
import { footageClip, type FootageClip } from "./footage";
import type { OutsideEdit, Scenario, TurnContext } from "./types";

/** What came with user turn `turn` (0 = the prompt), if anything. */
export function turnContextOf(scenario: Scenario, turn: number): TurnContext | undefined {
  return (scenario.turnContext ?? []).find((c) => c.turn === turn);
}

/** What the app's import returns for a footage file (lib/upload.ts `Uploaded`): a LINKED file
 *  (`path` set) keeps its full path as its library path, a COPIED one is library/<id><ext>. The
 *  library path is the one the footage's library_op rows report, so the two cannot disagree. */
export function uploadOf(c: FootageClip): { path: string; name: string; rel: string; id: string } {
  const ext = /\.[^./\\]+$/.exec(c.filename)?.[0]?.toLowerCase() ?? "";
  const rel = c.path
    ? c.path.replace(/\\/g, "/")
    : `library/${c.media_ref}${c.kind === "image" ? "" : ext}`;
  return { path: rel, name: c.filename, rel, id: c.media_ref };
}

/** The footage files attached to turn `turn`, in the order they were attached. */
export function attachedFiles(scenario: Scenario, turn: number): FootageClip[] {
  const refs = turnContextOf(scenario, turn)?.attach ?? [];
  return refs.map((ref) => {
    const c = scenario.footage ? footageClip(scenario.footage, ref) : undefined;
    if (!c) throw new Error(`${scenario.id}: turn ${turn} attaches ${ref}, which is not in its footage`);
    return c;
  });
}

/** The text the model gets for user turn `turn`: its words, then what the composer and the editor
 *  add, worded by the app's own code. `timelineChanged` says the person edited the timeline since
 *  the agent's last look; a state block (the app's own read of the project) replaces that note. */
export function composeTurn(
  scenario: Scenario,
  turn: number,
  text: string,
  opts: { timelineChanged?: boolean; stateBlock?: string } = {},
): string {
  const ctx = turnContextOf(scenario, turn);
  const attachments = attachmentsFromUploads(attachedFiles(scenario, turn).map(uploadOf));
  return composeModelText(text, attachments, [...(ctx?.mentions ?? [])], {
    timelineChanged: opts.timelineChanged === true,
    stateBlock: opts.stateBlock,
  });
}

/** Make the person's edit on the open project, as the editor commits one: through the document's
 *  mutation gate with no chat origin, so it counts as a change made outside the chat. Throws when
 *  the app refuses it: a case whose edit cannot be made would grade a run against nothing. */
export async function applyOutsideEdit(
  store: ProjectStoreAccess,
  edit: OutsideEdit,
): Promise<void> {
  const r = (await applyOp(store, `editor: ${edit.what}`, (timeline) => {
    edit.apply(timeline);
  })) as { ok?: boolean; error?: string };
  if (r?.ok === false) throw new Error(`the person's edit (${edit.what}) failed: ${r.error}`);
}

/** The timeline the agent's changes are judged against: the seed with the person's own edits made
 *  on it, in turn order. What the person changed by hand is not the agent's doing, so it must not
 *  read as collateral or as a deletion nobody asked for. */
export function gradingBaseline(scenario: Scenario, seeded: Timeline): Timeline {
  const edits = [...(scenario.turnContext ?? [])]
    .filter((c) => c.editedBefore)
    .sort((a, b) => a.turn - b.turn);
  if (!edits.length) return seeded;
  const base = JSON.parse(JSON.stringify(seeded)) as Timeline;
  for (const c of edits) c.editedBefore!.apply(base);
  return base;
}
