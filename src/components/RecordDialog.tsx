// Camera recording: pick a device, see yourself, record, and land in the library.
//
// The stream is opened BEFORE the device pickers are filled, because a browser hides device
// LABELS until permission has been granted at least once — a picker built first shows a list of
// blanks. Everything is torn down on close, or the camera light stays on over a dismissed dialog.
import { useCallback, useEffect, useRef, useState } from "react";

import {
  elapsedLabel,
  listCaptureDevices,
  pickRecordingMime,
  MAX_RECORDING_BYTES,
  type CaptureDevice,
} from "../media/recorder";
import { saveRecording } from "../media/recordSave";
import { notifyLibraryChanged } from "../tools/import";
import { makeTauriContext } from "../tools/tauri";
import { useProjectNotice } from "../store/projectNotice";
import { Button } from "./ui";

type Phase = "idle" | "recording" | "saving";

export default function RecordDialog({
  open,
  projectDir,
  onClose,
}: {
  open: boolean;
  projectDir: string | null;
  onClose: () => void;
}): JSX.Element | null {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recRef = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);

  const [cameras, setCameras] = useState<CaptureDevice[]>([]);
  const [mics, setMics] = useState<CaptureDevice[]>([]);
  const [cameraId, setCameraId] = useState<string>("");
  const [micId, setMicId] = useState<string>("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const stop = useCallback(() => {
    recRef.current?.state === "recording" && recRef.current.stop();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  /** (Re)open the camera. Also refreshes the device lists, which only carry labels once a
   *  stream has been granted. */
  const openStream = useCallback(async (camera: string, mic: string) => {
    setError(null);
    try {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      const stream = await navigator.mediaDevices.getUserMedia({
        video: camera ? { deviceId: { exact: camera } } : true,
        audio: mic ? { deviceId: { exact: mic } } : true,
      });
      streamRef.current = stream;
      if (videoRef.current) videoRef.current.srcObject = stream;
      const { cameras: cams, mics: ms } = await listCaptureDevices(navigator.mediaDevices);
      setCameras(cams);
      setMics(ms);
      setCameraId((c) => c || (cams[0]?.deviceId ?? ""));
      setMicId((m) => m || (ms[0]?.deviceId ?? ""));
    } catch (e) {
      // A refused permission is the common case and reads as a bug unless it is named.
      setError(
        e instanceof DOMException && (e.name === "NotAllowedError" || e.name === "NotFoundError")
          ? "No camera available, or access was refused. Check your system privacy settings."
          : `Could not open the camera: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void openStream("", "");
    return () => {
      stop();
      setPhase("idle");
      setElapsed(0);
    };
  }, [open, openStream, stop]);

  useEffect(() => {
    if (phase !== "recording") return;
    const started = Date.now();
    const t = setInterval(() => setElapsed(Date.now() - started), 250);
    return () => clearInterval(t);
  }, [phase]);

  const begin = (): void => {
    const stream = streamRef.current;
    if (!stream) return;
    const mime = pickRecordingMime((t) => MediaRecorder.isTypeSupported(t));
    if (!mime) {
      setError("This system cannot record video in a format the editor can read.");
      return;
    }
    chunks.current = [];
    let held = 0;
    const rec = new MediaRecorder(stream, { mimeType: mime });
    rec.ondataavailable = (e) => {
      if (!e.data.size) return;
      chunks.current.push(e.data);
      held += e.data.size;
      // The take is buffered in this heap, so it has to stop itself before it can crash the
      // app. Stopping saves what was captured rather than discarding an hour of it.
      if (held >= MAX_RECORDING_BYTES && rec.state === "recording") {
        setError("Reached the maximum recording length — saving what was captured.");
        rec.stop();
      }
    };
    rec.onstop = () => void finish(mime);
    recRef.current = rec;
    rec.start(1000); // timeslice: a crash mid-recording still leaves the chunks so far
    setPhase("recording");
  };

  const finish = async (mime: string): Promise<void> => {
    setPhase("saving");
    try {
      if (!projectDir) throw new Error("open a project first");
      const blob = new Blob(chunks.current, { type: mime });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const ctx = makeTauriContext(projectDir);
      const saved = await saveRecording(ctx, bytes, mime);
      notifyLibraryChanged();
      useProjectNotice.getState().notify(`Saved ${saved.filename} to the library.`);
      onClose();
    } catch (e) {
      setError(`Could not save the recording: ${e instanceof Error ? e.message : String(e)}`);
      setPhase("idle");
    }
  };

  if (!open) return null;
  const recording = phase === "recording";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6">
      <div
        role="dialog"
        aria-label="record video"
        className="w-[560px] max-w-[92vw] rounded-lg border border-edge bg-panel p-4 text-neutral-100 shadow-2xl"
      >
        <h2 className="text-sm font-semibold tracking-tight">Record</h2>

        <div className="mt-3 aspect-video w-full overflow-hidden rounded bg-black">
          {/* Muted: playing the mic back through the speakers is an instant feedback howl. */}
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className="h-full w-full object-contain"
          />
        </div>

        {error && <p className="mt-2 text-[11px] text-amber-400">{error}</p>}

        <div className="mt-3 grid grid-cols-2 gap-3">
          <label className="text-[11px] text-neutral-400">
            Camera
            <select
              aria-label="camera"
              value={cameraId}
              disabled={recording || phase === "saving"}
              onChange={(e) => {
                setCameraId(e.target.value);
                void openStream(e.target.value, micId);
              }}
              className="mt-1 w-full rounded border border-edge bg-neutral-900 px-2 py-1 text-xs text-neutral-200 disabled:opacity-50"
            >
              {cameras.map((c) => (
                <option key={c.deviceId} value={c.deviceId}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          <label className="text-[11px] text-neutral-400">
            Microphone
            <select
              aria-label="microphone"
              value={micId}
              disabled={recording || phase === "saving"}
              onChange={(e) => {
                setMicId(e.target.value);
                void openStream(cameraId, e.target.value);
              }}
              className="mt-1 w-full rounded border border-edge bg-neutral-900 px-2 py-1 text-xs text-neutral-200 disabled:opacity-50"
            >
              {mics.map((m) => (
                <option key={m.deviceId} value={m.deviceId}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="mt-4 flex items-center justify-between">
          <span className="flex items-center gap-2 text-[11px] tabular-nums text-neutral-400">
            {recording && <span className="h-2 w-2 animate-pulse rounded-full bg-red-500" />}
            {recording || phase === "saving" ? elapsedLabel(elapsed) : ""}
          </span>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose} disabled={phase === "saving"}>
              {recording ? "Discard" : "Close"}
            </Button>
            {recording ? (
              <Button variant="primary" onClick={() => stop()}>
                Stop &amp; save
              </Button>
            ) : (
              <Button
                variant="primary"
                onClick={begin}
                disabled={phase === "saving" || !streamRef.current}
              >
                {phase === "saving" ? "Saving…" : "Record"}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
