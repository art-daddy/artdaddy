// Timeline invariants — ports renderer._check_timeline (structural) + the
// non-probe parts of v1_tools._preflight_timeline (timing/overlap), run on the
// frames->seconds projection. Returns [] when valid, else actionable errors.
// DEFERRED to a later slice (need async ffprobe / full field parsers): source
// file-existence + duration-coverage checks, and deep per-field validation of
// transform/color/effects/audio/caption params.
import { isNum, parseTimestamp, toSecondsView } from "./frames";
import type { Timeline } from "./model";
import { parseTransitionIn } from "./transition";

const TOL = 0.05;

function ts(v: unknown): number {
  if (typeof v === "number") return v;
  return parseTimestamp(v as string); // throws for junk -> caught by caller
}

export function validateTimeline(raw: Timeline): string[] {
  const errors: string[] = [];

  // ---- structural (_check_timeline) ----
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    return ["timeline must be an object"];
  const canvas = raw.canvas;
  if (canvas === null || typeof canvas !== "object")
    return ["timeline.canvas missing or not an object"];
  for (const k of ["width", "height", "fps"] as const) {
    const v = canvas[k];
    if (!isNum(v) || v <= 0) return [`timeline.canvas.${k} must be a positive number`];
  }
  const tracks = raw.tracks;
  // Edit-validation allows an EMPTY timeline (a fresh project is a valid editing
  // state — the seed itself has no tracks). The Python _preflight rejects empty
  // because it doubles as the RENDER preflight; the client's render/export path
  // will re-check non-empty separately (later slice).
  if (!Array.isArray(tracks)) return ["timeline.tracks must be a list"];

  const seen = new Set<string>();
  for (let ti = 0; ti < tracks.length; ti++) {
    const track = tracks[ti];
    if (track === null || typeof track !== "object") {
      errors.push(`tracks[${ti}] is not an object`);
      continue;
    }
    const tid = track.id;
    if (typeof tid !== "string" || !tid) errors.push(`tracks[${ti}].id must be a non-empty string`);
    else if (seen.has(tid)) errors.push(`duplicate track id '${tid}'`);
    else seen.add(tid);
    if (!["video", "audio", "text"].includes(track.kind)) {
      errors.push(
        `tracks[${ti}] (id='${tid ?? "?"}'): kind must be video/audio/text (got ${JSON.stringify(track.kind)})`,
      );
    }
    if (!isNum(track.z)) errors.push(`tracks[${ti}] (id='${tid ?? "?"}'): z must be a number`);
  }
  if (errors.length) return errors;

  // ---- per-clip timing/overlap (_preflight_timeline on the seconds view) ----
  const timeline = toSecondsView(raw);
  // The contract is INTEGER FRAMES, so report errors in frames (not the internal
  // seconds projection) — otherwise the model, which reads/writes frames, gets
  // confusing decimal-second values it can't map back to what it wrote.
  const fps = Number(raw.canvas.fps) || 30;
  const F = (s: number): number => Math.round(s * fps);
  for (let ti = 0; ti < timeline.tracks.length; ti++) {
    const track = timeline.tracks[ti];
    const trackId = track.id ?? `<track[${ti}]>`;
    const clips = track.clips ?? [];
    if (!Array.isArray(clips)) {
      errors.push(`${trackId}: clips must be a list`);
      continue;
    }
    let lastOut: number | null = null;
    let prevTin: number | null = null;
    for (let ci = 0; ci < clips.length; ci++) {
      const clip = clips[ci];
      const tag = `${trackId}.clips[${ci}]`;
      if (clip === null || typeof clip !== "object") {
        errors.push(`${tag}: must be an object`);
        continue;
      }
      const kind = clip.kind;

      if (kind === "audio" || kind === "text") {
        if (kind === "audio" && typeof clip.media_ref !== "string")
          errors.push(`${tag}: audio clip missing 'media_ref'`);
        let cIn: number;
        let cOut: number;
        try {
          cIn = ts(clip.timeline_in);
          cOut = ts(clip.timeline_out);
        } catch {
          errors.push(`${tag}: ${kind} clip needs numeric timeline_in/timeline_out`);
          continue;
        }
        if (cOut <= cIn) errors.push(`${tag}: timeline_out must be > timeline_in`);
        if (lastOut !== null && cIn + TOL < lastOut) {
          errors.push(
            `${tag}: timeline_in=${F(cIn)} overlaps previous clip (prev timeline_out=${F(lastOut)}).`,
          );
        }
        prevTin = cIn;
        lastOut = cOut;
        continue;
      }

      // media clip (video/image). media_ref + timeline bounds are always required;
      // source_in/source_out are OPTIONAL for stills (image/lottie loop to fill).
      const missing = ["media_ref", "timeline_in", "timeline_out"].filter((f) => !(f in clip));
      for (const f of missing) errors.push(`${tag}: missing field '${f}'`);
      if (missing.length) continue;
      let tIn: number;
      let tOut: number;
      try {
        tIn = ts(clip.timeline_in);
        tOut = ts(clip.timeline_out);
      } catch {
        errors.push(`${tag}: timeline_in/timeline_out must be a number or MM:SS.sss string`);
        continue;
      }
      if (tIn < 0) errors.push(`${tag}: timeline_in=${F(tIn)} must be >= 0`);
      if (tOut <= tIn)
        errors.push(`${tag}: timeline_out=${F(tOut)} must be > timeline_in=${F(tIn)}`);

      if ("source_in" in clip || "source_out" in clip) {
        let sIn: number;
        let sOut: number;
        try {
          sIn = ts(clip.source_in);
          sOut = ts(clip.source_out);
        } catch {
          errors.push(`${tag}: source_in/source_out must be a number or MM:SS.sss string`);
          lastOut = tOut;
          continue;
        }
        const speedRaw = clip.speed ?? 1.0;
        const speed = Number(speedRaw);
        if (Number.isNaN(speed)) {
          errors.push(`${tag}: speed must be a number (got ${JSON.stringify(speedRaw)})`);
        } else if (speed <= 0) {
          errors.push(`${tag}: speed=${speed} must be > 0`);
        } else {
          if (sIn < 0) errors.push(`${tag}: source_in=${F(sIn)} must be >= 0`);
          if (sOut <= sIn)
            errors.push(`${tag}: source_out=${F(sOut)} must be > source_in=${F(sIn)}`);
          const srcDur = sOut - sIn;
          const tlDur = tOut - tIn;
          const played = srcDur / speed;
          // loop/stretch clips fill the slot from a shorter (or longer) source —
          // loop by repetition, stretch by atempo — so their source span is
          // deliberately independent of the timeline span (no parity required).
          const fillsSlot = clip.loop === true || clip.stretch === true;
          if (!fillsSlot && Math.abs(played - tlDur) > TOL) {
            if (Math.abs(speed - 1.0) < 1e-6) {
              errors.push(
                `${tag}: source duration (${F(srcDur)} frames) != timeline duration (${F(tlDur)} frames); renderer does not stretch.`,
              );
            } else {
              errors.push(
                `${tag}: (source_out-source_in)/speed = ${F(srcDur)}/${speed} = ${F(played)} frames != timeline duration (${F(tlDur)} frames).`,
              );
            }
          }
        }
      }
      // Inbound transition: a same-track overlap is allowed (and required) when
      // this clip carries transition_in whose duration equals the overlap.
      // Otherwise same-track media clips must not overlap. Mirrors v1_tools.
      const trans = parseTransitionIn(clip);
      if (trans && lastOut !== null) {
        const durSec = trans.duration; // seconds view already converted duration frames -> seconds
        // Non-shifting model (B): the crossfade is a render-side blend, so a transitioned
        // clip's POSITION relative to its predecessor is unconstrained (abut, overlap, or
        // even a gap) — trimming/moving it must stay free; the render just blends whatever
        // geometry results. Only cap the duration to what a crossfade can physically use.
        const prevLen = prevTin !== null ? lastOut - prevTin : Infinity;
        if (durSec > tOut - tIn + TOL || durSec > prevLen + TOL) {
          errors.push(
            `${tag}: transition_in.duration=${F(durSec)} exceeds a clip's length (crossfade can't be longer than either clip).`,
          );
        }
      } else if (trans && lastOut === null) {
        errors.push(`${tag}: transition_in needs a preceding clip on the same track.`);
      } else if (lastOut !== null && tIn + TOL < lastOut) {
        errors.push(
          `${tag}: timeline_in=${F(tIn)} overlaps previous clip (prev timeline_out=${F(lastOut)}).`,
        );
      }
      prevTin = tIn;
      lastOut = tOut;
    }
  }
  return errors;
}
