// What an external agent is told, on top of the tools themselves.
//
// The base is the SAME system prompt the in-app agent runs under, fetched from the server
// (`/contract/instructions`) rather than paraphrased here — a second copy would drift, and the
// two agents would then behave differently against identical tools.
//
// Only genuinely MCP-specific guidance is added: an external session has no project open and no
// window to click in, and it has no ApprovalBar, so the cost policy that the UI enforces for the
// in-app agent has to be stated in words. Other desktop NLEs do the same (its generation tools
// say "Costs real money and is not undoable" and its instructions say "Wait for confirmation
// before submitting") — for them, as for us here, consent is prompt-level, not a runtime gate.
import { api } from "../api/client";

/** Project navigation — an MCP session may open with nothing loaded. */
export const PROJECT_NAVIGATION = `
# Projects
This session may start with NO project open, and every editing tool acts on the open one.
Call manage_project with action='list' to see them, then action='open' with an id (or
action='create' with a name). action='current' reports what is open. Do this before reading a
timeline or making any edit.`.trim();

/** What replaces the in-app "you will be told when it lands" rule.
 *
 *  Nothing in MCP can resume a turn that has ended: no notification wakes an agent, and the
 *  Tasks extension that would is in no major client yet. The shared prompt therefore omits
 *  the rule (`host_notifies=false`) and this states the one that is actually true here.
 *  It lives beside the other MCP-only sections so an unreachable backend cannot drop it. */
export const ASYNC_JOBS = `
# Generations and exports finish AFTER your turn ends
Generation and export tools return immediately with a real handle and finish in the
background — anywhere from seconds to 15 minutes.
- NOTHING will tell you when one lands. This connection cannot resume a turn that has
  ended, so "I'll check back and let you know" leaves the user waiting on a message that
  never arrives. Say what you started, say roughly how long it takes, and END your turn.
- Place the handle now: add_clips accepts a still-generating media_ref and the clip fills
  in by itself. Fire independent generations together rather than one at a time.
- When the user writes again, CHECK before claiming anything is done: library_op
  action='list' reports status:'generating' on media still running (the field is absent
  once an asset is ready), and manage_exports action='list' reports a running export.`.trim();

/** The approval that the in-app UI performs and an external client cannot. */
export const COST_POLICY = `
# Cost and destructive actions
You are driving someone's real project on their machine, and this connection has no approval
prompt — whatever you call runs immediately.
- generate_image, generate_video, generate_voiceover, generate_music, video_ask and
  video_find_moment SPEND THE USER'S CREDITS and are not undoable. Propose what you intend to
  run and WAIT for the user to confirm before calling one.
- download_video and get_page_image fetch from the internet. Say what you are fetching first.
- library_op with action='delete' removes media and every clip using it. Confirm first.
- Ordinary timeline edits are reversible and need no permission. Prefer them freely.`.trim();

let cached: string | null = null;

/** The full instruction text for an MCP session: shared prompt + MCP-only sections. Falls back
 *  to the MCP-only sections if the server is unreachable, so an offline session still knows how
 *  to open a project rather than failing silently on its first call. */
export async function mcpInstructions(): Promise<string> {
  if (cached) return cached;
  let base = "";
  try {
    // MCP cannot resume a finished turn, so ask for the prompt that says so.
    base = (await api.instructions(false)).instructions ?? "";
  } catch {
    /* offline: the MCP-only sections below still apply */
  }
  const text = [base.trim(), PROJECT_NAVIGATION, ASYNC_JOBS, COST_POLICY]
    .filter(Boolean)
    .join("\n\n");
  if (base) cached = text;
  return text;
}

export const __testing = {
  reset: () => {
    cached = null;
  },
};
