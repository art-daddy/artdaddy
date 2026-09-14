// What the approval bar says. The tool NAME is our vocabulary, not the user's: "Approve
// `get_page_image`?" tells them nothing about what is about to happen or why it needs asking.
// Every gated tool gets a plain-English action plus the reason it is gated, and where an
// argument is what makes the call consequential (a URL, a file about to be deleted) that
// argument is shown too.
import { EXTERNAL_FETCH_TOOLS, PAID_TOOLS, isDestructive } from "../agent/loop";

export type ApprovalReason = "paid" | "external" | "destructive";

export interface ApprovalCopy {
  /** Plain-English action, e.g. "Generate a video". */
  action: string;
  /** The argument that makes this call consequential, when there is one. */
  subject?: string;
  reason: ApprovalReason;
  /** Why we are asking, e.g. "This uses your credits." */
  because: string;
  approveLabel: string;
}

const ACTIONS: Record<string, string> = {
  generate_image: "Generate an image",
  generate_video: "Generate a video",
  generate_voiceover: "Generate a voiceover",
  generate_music: "Generate music",
  video_ask: "Watch a video and answer a question about it",
  video_find_moment: "Search a video for a moment",
  image_ask: "Look at an image and answer a question about it",
  vision_describe: "Describe what is on screen",
  find_content: "Search your footage for matching content",
  extract_style: "Analyse your reference clips to learn their style",
  download_video: "Download a video from the internet",
  get_page_image: "Open a web page and capture it",
  library_op: "Delete media from your library",
};

const BECAUSE: Record<ApprovalReason, string> = {
  paid: "This spends your credits.",
  external: "This pulls a file from the internet onto your computer.",
  destructive: "This removes the file and every clip using it. It can't be undone.",
};

/** First present of the argument names that carry the meaning of the call. */
function subjectOf(args: Record<string, unknown>): string | undefined {
  for (const key of ["url", "prompt", "query", "question", "media_ref", "name", "text"]) {
    const v = args[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

export function approvalReason(
  name: string,
  args: Record<string, unknown> = {},
): ApprovalReason | null {
  if (isDestructive(name, args)) return "destructive";
  if (PAID_TOOLS.has(name)) return "paid";
  if (EXTERNAL_FETCH_TOOLS.has(name)) return "external";
  return null;
}

export function describeApproval(
  name: string,
  args: Record<string, unknown> = {},
): ApprovalCopy | null {
  const reason = approvalReason(name, args);
  if (!reason) return null;
  return {
    action: ACTIONS[name] ?? name,
    subject: subjectOf(args),
    reason,
    because: BECAUSE[reason],
    approveLabel: reason === "destructive" ? "Delete" : "Allow",
  };
}
