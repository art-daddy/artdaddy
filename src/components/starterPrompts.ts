// Starter prompts for an empty chat. Each one has to be something the shipped tools can actually
// carry out — a suggestion the editor then fails at is worse than no suggestion, so this list is
// deliberately narrower than the category is. No multicam sync and no beat detection, for example:
// there are no tools for either, however good they look on a landing page.
export interface StarterPrompt {
  /** Short label on the chip. */
  label: string;
  /** What lands in the composer. Left as an instruction the user can edit before sending — a
   *  click must never spend money on its own, and several of these reach paid generation. */
  text: string;
  /** Tools that make it possible, so the grounding is reviewable rather than asserted. */
  tools: string[];
}

export const STARTER_PROMPTS: readonly StarterPrompt[] = [
  {
    label: "Add captions",
    text: "Add captions from the audio, and style them to suit the video.",
    tools: ["get_transcript", "add_text_clips"],
  },
  {
    label: "Cut the dead air",
    text: "Cut the silences and filler words, and close the gaps.",
    tools: ["get_transcript", "split_clips", "ripple_delete"],
  },
  {
    label: "Make a vertical short",
    text: "Turn this into a 9:16 vertical short built from the strongest moments.",
    tools: ["set_project_settings", "video_find_moment", "set_clip_properties"],
  },
  {
    label: "Add a voiceover",
    text: "Write a voiceover for this and lay it under the video.",
    tools: ["generate_voiceover", "add_clips"],
  },
  {
    label: "Score my timeline",
    text: "Add background music that fits the pacing, ducked under the speech.",
    tools: ["generate_music", "add_clips", "set_clip_properties"],
  },
  {
    label: "Find B-roll",
    text: "Find B-roll that matches what is on screen and cut it in.",
    tools: ["youtube_search", "download_video", "insert_clips"],
  },
  {
    label: "Grade the footage",
    text: "Give this a consistent colour grade across every shot.",
    tools: ["inspect_color", "apply_color"],
  },
  {
    label: "Build a title card",
    text: "Make an opening title card for this video.",
    tools: ["generate_image", "add_text_clips"],
  },
];
