// What a generation will HOLD is decided on the server from a few of the arguments of the paid call (model, how many
// images, how many seconds, how long a script is). The approval bar shows "Up to N credits" beforehand by asking the
// server to price those same arguments (POST /ai/{name}/quote, api/quote.ts).
//
// The quote is only honest if it is about the SAME call, so every input here comes from the code the tools themselves use
// (genModels.ts) after the same two normalisations the registry applies before a handler runs. tools/holdInputs.test.ts
// drives the real tools through the real registry over every model to prove the two never disagree, and pins this file
// to quotedArgs.json, the contract the server's tests read.
//
// It quotes only what the server HOLDS (the four generation tools). Everything else that is paid settles its real cost
// afterwards and has nothing to show in advance. Nothing of the user's travels: not the prompt, not a media reference, not
// a name, and a script only as a placeholder of the same length (the price depends on its length alone).
import { clampArgs, dropStrictNulls } from "../contract/clamp";
import {
  DEFAULTS,
  imageCount,
  resolveGenModel,
  resolveMusicModel,
  resolveTtsBackend,
  videoReferences,
  videoSeconds,
  voiceoverContents,
} from "./genModels";

/** The arguments of each priced proxy that move its hold, and the ones that matter only by their length. Pinned to
 *  __fixtures__/quotedArgs.json. `text_cap` is how long a script placeholder may get, comfortably above the server's own cap
 *  (ARTDADDY_MAX_TTS_CHARS), past which the price no longer changes. */
export const QUOTE_CONTRACT = {
  args: {
    generate_image: ["backend_id", "count"],
    generate_video: ["backend_id", "duration"],
    voiceover: ["model", "text"],
    music: ["backend_id"],
  },
  length_only: { voiceover: ["text"] },
  text_cap: 20000,
} as const;

export const QUOTE_TEXT_CAP: number = QUOTE_CONTRACT.text_cap;

export interface HoldInputs {
  /** The proxy the tool's paid call goes to: `/ai/{proxy}`. */
  proxy: "generate_image" | "generate_video" | "voiceover" | "music";
  /** Only the arguments that move the price. */
  args: Record<string, unknown>;
}

const GENERATION_TOOLS: ReadonlySet<string> = new Set([
  "generate_image",
  "generate_video",
  "generate_voiceover",
  "generate_music",
]);

/** Characters of a script as the server counts them (code points), up to the cap. Reads only as much as it needs. */
function scriptLength(contents: string): number {
  return Math.min(Array.from(contents.slice(0, 2 * QUOTE_TEXT_CAP)).length, QUOTE_TEXT_CAP);
}

/** What the server needs to price this tool call, or null when the call has no price to show: not a generation tool, or one
 *  the tool itself would refuse for its model or its text (nothing would be sent). Never throws: it runs while drawing. */
export function holdInputs(tool: string, raw: Record<string, unknown>): HoldInputs | null {
  if (!GENERATION_TOOLS.has(tool) || !raw || typeof raw !== "object" || Array.isArray(raw))
    return null;
  try {
    // The registry hands a handler these, not what the model wrote.
    const args = clampArgs(tool, dropStrictNulls(tool, raw));
    switch (tool) {
      case "generate_image": {
        const m = resolveGenModel(String(args.model ?? ""), "image", DEFAULTS.image);
        return m
          ? {
              proxy: "generate_image",
              args: { backend_id: m.backend_id, count: imageCount(m, args.count) },
            }
          : null;
      }
      case "generate_video": {
        const m = resolveGenModel(String(args.model ?? ""), "video", DEFAULTS.video);
        if (!m) return null;
        const seconds = videoSeconds(
          args.duration,
          videoReferences(args.reference_images).length > 0,
        );
        return { proxy: "generate_video", args: { backend_id: m.backend_id, duration: seconds } };
      }
      case "generate_voiceover": {
        const text = String(args.text ?? "").trim();
        const model = resolveTtsBackend(args.model);
        if (!text || !model) return null;
        const contents = voiceoverContents(text, String(args.style ?? "").trim());
        return { proxy: "voiceover", args: { model, text: "x".repeat(scriptLength(contents)) } };
      }
      case "generate_music": {
        const am = resolveMusicModel(args.model);
        return am ? { proxy: "music", args: { backend_id: am.backend_id } } : null;
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}
