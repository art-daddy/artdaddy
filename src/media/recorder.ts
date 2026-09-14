// Camera capture: choosing the container, and naming what comes out.
//
// The container choice is the load-bearing part. Our preview demuxes with mp4box and decodes with
// WebCodecs, so a WebM recording would not play in the editor at all even though the browser
// recorded it happily — mp4box parses MP4 boxes and nothing else. MediaRecorder in a recent
// Chromium can write H.264 in MP4 directly, so ask for that FIRST and only fall back to WebM,
// which then has to be transcoded before it can enter the library.
export const MP4_CANDIDATES = [
  'video/mp4;codecs="avc1.42E01E,mp4a.40.2"',
  'video/mp4;codecs="avc1.4D401E,mp4a.40.2"',
  "video/mp4",
] as const;

export const WEBM_CANDIDATES = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
] as const;

/** The best container this browser will record, preferring one the preview can already decode. */
export function pickRecordingMime(supported: (type: string) => boolean): string | null {
  for (const t of [...MP4_CANDIDATES, ...WEBM_CANDIDATES]) if (supported(t)) return t;
  return null;
}

/** True when a recording in this container can enter the library as-is. */
export function isPlayableContainer(mime: string): boolean {
  return /^video\/mp4/i.test(mime.trim());
}

/** `.mp4` / `.webm` for a MediaRecorder mime type. */
export function extensionForMime(mime: string): string {
  return isPlayableContainer(mime) ? "mp4" : "webm";
}

function two(n: number): string {
  return String(n).padStart(2, "0");
}

/** A sortable, filesystem-safe name. Local time, because it is a label for the person who
 *  recorded it, not a timestamp anything parses. */
export function recordingName(at: Date = new Date()): string {
  const d = `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}`;
  const t = `${two(at.getHours())}${two(at.getMinutes())}${two(at.getSeconds())}`;
  return `recording-${d}-${t}.mp4`;
}

/** Hard ceiling on a single take, enforced while the chunks arrive.
 *
 *  The capture lives in the WEBVIEW HEAP until it is saved, so an unattended recording is the
 *  same crash (Chromium 0xE0000008) that an oversized source file caused three times over. At a
 *  webcam's ~0.5 MB/s this is a bit over an hour, and the recorder stops itself and saves what
 *  it has rather than taking the app down. */
export const MAX_RECORDING_BYTES = 1_500_000_000;

/** mm:ss for the elapsed counter. Hours are shown only once there are any. */
export function elapsedLabel(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}:${two(m)}:${two(s % 60)}` : `${m}:${two(s % 60)}`;
}

export interface CaptureDevice {
  deviceId: string;
  label: string;
}

/** Cameras and microphones, once permission has been granted.
 *
 *  Labels are EMPTY until the user has allowed access at least once — that is a browser privacy
 *  rule, not a bug — so a picker built before permission shows blanks. Callers open the stream
 *  first, then enumerate. */
export async function listCaptureDevices(
  media: Pick<MediaDevices, "enumerateDevices">,
): Promise<{ cameras: CaptureDevice[]; mics: CaptureDevice[] }> {
  const all = await media.enumerateDevices();
  const pick = (kind: MediaDeviceKind): CaptureDevice[] =>
    all
      .filter((d) => d.kind === kind)
      .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `${kind} ${i + 1}` }));
  return { cameras: pick("videoinput"), mics: pick("audioinput") };
}
