// The model asks for a paid generation: an image, a video, a voice-over or a music bed. Each is a
// paid call, so the default mode asks the person first. Arguments are the ones the tools' contract
// takes (src/contract/catalog.json); a media argument is a library reference, never a path.
import { callTools, type Reply } from "../../../agent-and-models/lib/reply";

export const IMAGE_PROMPT = "a paper boat on a calm lake at sunrise";

export function askImage(
  args: Record<string, unknown> = {},
  prose = "I'll make the picture.",
): Reply {
  return callTools(
    [
      {
        name: "generate_image",
        arguments: { prompt: IMAGE_PROMPT, aspect_ratio: "16:9", ...args },
      },
    ],
    prose,
  );
}

export const VIDEO_PROMPT = "slow push in on a lighthouse at dusk, waves below";

export function askVideo(args: Record<string, unknown> = {}, prose = "I'll make the clip."): Reply {
  return callTools(
    [
      {
        name: "generate_video",
        arguments: { prompt: VIDEO_PROMPT, aspect_ratio: "16:9", duration: 4, ...args },
      },
    ],
    prose,
  );
}

export const VOICE_TEXT = "Welcome back. Today we build a boat out of paper.";

export function askVoiceover(
  args: Record<string, unknown> = {},
  prose = "I'll record the narration.",
): Reply {
  return callTools(
    [{ name: "generate_voiceover", arguments: { text: VOICE_TEXT, ...args } }],
    prose,
  );
}

export const MUSIC_PROMPT = "gentle acoustic guitar, warm and slow";

export function askMusic(
  args: Record<string, unknown> = {},
  prose = "I'll make a music bed.",
): Reply {
  return callTools(
    [{ name: "generate_music", arguments: { prompt: MUSIC_PROMPT, ...args } }],
    prose,
  );
}
