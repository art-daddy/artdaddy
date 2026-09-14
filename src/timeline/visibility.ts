// Playback visibility — the ONE place that answers "does this track draw / sound, and does this
// clip play at all?".
//
// This module exists because the same defect appeared three times in one week, each in a different
// consumer, and each invisible to a green test suite:
//
//   S6  the preview filtered `hidden`, the render plan did not -> hiding a track darkened the
//       preview and STILL EXPORTED the track.
//   S7  the audio engine honoured neither `disabled` nor `solo` -> a disabled audio clip would have
//       been silent in the export and audible in the preview.
//   S8  a single cross-kind solo filter would have blacked out the picture when an AUDIO lane was
//       soloed.
//   S9  the render plan gated audio with the VIDEO rule (`visibleTracks`/`hidden`), so `mute` was
//       never consulted in the export path -> a muted track was silent in preview and AUDIBLE in
//       the exported mp4. Shipped; a user exported a promo with two voiceovers.
//
// Every one was "a consumer owning its own copy of a visibility rule" — except S9, which was the
// inverse and is why the guard needs both halves: a consumer that reads NO flag passes a check for
// "don't read flags yourself" while honouring nothing. The mutation side of the same problem is
// already solved by operations.ts + its guard; this is that pattern applied to the read side.
// `visibility.guard.test.ts` fails if a render/preview consumer reads these flags itself, AND
// asserts behaviourally that each flag actually suppresses output.
import type { Clip, Timeline, Track } from "./model";

/** True when a clip should be seen AND heard. Absent `disabled` = enabled, so every document
 *  written before the flag existed keeps playing exactly as it did. */
export function clipPlays(clip: Clip): boolean {
  return clip.disabled !== true;
}

/** Take a clip out of playback on a RENDER-ONLY copy of the timeline, for a reason the document
 *  cannot express — today: its media turned out to have no audio stream, which makes ffmpeg reject
 *  the entire graph. The WRITE lives here beside the read so a consumer never has to touch the flag
 *  itself, and so suppression keeps meaning exactly what `clipPlays` says it means. Never call this
 *  on a timeline that will be persisted: to the user this clip is not disabled. */
export function suppressClip(clip: Clip): void {
  clip.disabled = true;
}

/** Solo scoped to a KIND.
 *
 *  A single flag applied across all tracks means soloing an audio lane blacks out the picture,
 *  which is not what anyone means by soloing a lane. Soloing within a kind is the behaviour
 *  Premiere gives you from having separate video/audio solo controls. */
function soloWithinKind(tracks: Track[]): Track[] {
  const soloedKinds = new Set(
    tracks.filter((t) => t.solo === true).map((t) => String(t.kind ?? "video")),
  );
  if (!soloedKinds.size) return tracks;
  return tracks.filter((t) => t.solo === true || !soloedKinds.has(String(t.kind ?? "video")));
}

/** Tracks that DRAW, in compositing order — the render plan and the preview scene share this.
 *
 *  `hidden` is applied BEFORE solo, so a hidden track cannot define the solo set: hiding the one
 *  soloed lane leaves normal compositing rather than an all-black output from two toggles that
 *  each made sense on their own. */
export function visibleTracks(timeline: Timeline): Track[] {
  const drawable = (timeline.tracks ?? []).filter((t) => !t.hidden && (t.clips ?? []).length > 0);
  return soloWithinKind(drawable)
    .slice()
    .sort(
      (a, b) => (Number(a.z) || 0) - (Number(b.z) || 0) || String(a.id).localeCompare(String(b.id)),
    );
}

/** Tracks that SOUND — `mute` is the audio counterpart of `hidden`, and solo is scoped to the
 *  lanes that actually carry audio so it cannot silence a lane it has nothing to do with. */
export function audibleTracks(timeline: Timeline | null): Track[] {
  const carriesAudio = (t: Track): boolean => (t.clips ?? []).some((c) => c.kind === "audio");
  const heard = (timeline?.tracks ?? []).filter((t) => !t.mute && carriesAudio(t));
  const soloed = heard.some((t) => t.solo === true);
  return soloed ? heard.filter((t) => t.solo === true) : heard;
}

/** The gate for a backend that turns ONE pass into BOTH picture and sound — i.e. the exporter.
 *
 *  S9 (2026-08-25): the render plan gated every clip with `visibleTracks`, the `hidden` rule. Audio
 *  therefore inherited the VIDEO flag and `mute` was never consulted anywhere in the export path, so
 *  a muted track rendered into the mix while the preview stayed silent — a user shipped a video with
 *  two voiceovers. The negative drift guard could not catch it: the exporter never READ a flag, it
 *  ignored them, and "reads no flag" is what that guard asks for.
 *
 *  The preview needs no such gate because it asks in two places (scene.ts for pixels, audioEngine.ts
 *  for samples) and each already picks up its own rule. A single-pass backend has one clip list, so
 *  the rule has to be chosen per clip KIND or one medium's flag silently governs the other.
 *
 *  `admits` is the per-clip test; `tracks` is what to walk — the drawing lanes in compositing order,
 *  then any audio-only lane that draws nothing (its z cannot affect the picture, so its position
 *  among them carries no meaning). Track identity is by REFERENCE: both lists are filtered from
 *  `timeline.tracks`, and ids are optional in the model. */
export function outputGate(timeline: Timeline): {
  tracks: Track[];
  admits: (track: Track, clipKind: string) => boolean;
} {
  const drawing = visibleTracks(timeline);
  const sounding = audibleTracks(timeline);
  const draws = new Set<Track>(drawing);
  const sounds = new Set<Track>(sounding);

  const tracks = drawing.slice();
  for (const t of sounding) if (!draws.has(t)) tracks.push(t);

  return {
    tracks,
    admits: (track, clipKind) => (clipKind === "audio" ? sounds.has(track) : draws.has(track)),
  };
}
