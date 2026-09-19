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
  const requestRef = useRef(0);

  const [cameras, setCameras] = useState<CaptureDevice[]>([]);
  const [mics, setMics] = useState<CaptureDevice[]>([]);
  const [cameraId, setCameraId] = useState<string>("");
  const [micId, setMicId] = useState<string>("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [ready, setReady] = useState(false);

  const releaseStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setReady(false);
  }, []);

  const stop = useCallback(
    (save: boolean) => {
      const recorder = recRef.current;
      recRef.current = null;
      if (recorder) {
        if (!save) {
          recorder.onstop = null;
          recorder.ondataavailable = null;
          recorder.onerror = null;
        }
        if (recorder.state !== "inactive") recorder.stop();
      }
      releaseStream();
    },
    [releaseStream],
  );

  /** (Re)open the camera. Also refreshes the device lists, which only carry labels once a
   *  stream has been granted. */
  const openStream = useCallback(
    async (camera: string, mic: string) => {
      const request = ++requestRef.current;
      releaseStream();
      setError(null);
      setOpening(true);
      try {
        const media = navigator.mediaDevices;
        if (!media?.getUserMedia || typeof MediaRecorder === "undefined") {
          throw new Error(
            "Camera recording is unavailable in this window. Use the installed app or a supported browser.",
          );
        }
        const stream = await media.getUserMedia({
          video: camera ? { deviceId: { exact: camera } } : true,
          audio: mic ? { deviceId: { exact: mic } } : true,
        });
        if (request !== requestRef.current) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) videoRef.current.srcObject = stream;
        const { cameras: cams, mics: ms } = await listCaptureDevices(media);
        if (request !== requestRef.current) return;
        setCameras(cams);
        setMics(ms);
        setCameraId(camera || cams[0]?.deviceId || "");
        setMicId(mic || ms[0]?.deviceId || "");
        setReady(true);
      } catch (e) {
        if (request !== requestRef.current) return;
        releaseStream();
        // A refused permission is the common case and reads as a bug unless it is named.
        setError(
          e instanceof DOMException && e.name === "NotAllowedError"
            ? "Camera or microphone access was refused. Allow ArtDaddy in your system privacy settings, then retry."
            : e instanceof DOMException && e.name === "NotFoundError"
              ? "No camera or microphone was found. Connect a device, then retry."
              : `Could not open the camera: ${e instanceof Error ? e.message : String(e)}`,
        );
      } finally {
        if (request === requestRef.current) setOpening(false);
      }
    },
    [releaseStream],
  );

  useEffect(() => {
    if (!open) return;
    setCameras([]);
    setMics([]);
    setCameraId("");
    setMicId("");
    setPhase("idle");
    setElapsed(0);
    void openStream("", "");
    return () => {
      ++requestRef.current;
      stop(false);
      setPhase("idle");
      setElapsed(0);
    };
  }, [open, projectDir, openStream, stop]);

  useEffect(() => {
    if (phase !== "recording") return;
    const started = Date.now();
    const t = setInterval(() => setElapsed(Date.now() - started), 250);
    return () => clearInterval(t);
  }, [phase]);

  const begin = (): void => {
    const stream = streamRef.current;
    if (!stream || !ready || recRef.current || !projectDir) return;
    const request = requestRef.current;
    try {
      const mime = pickRecordingMime((type) => MediaRecorder.isTypeSupported(type));
      if (!mime) {
        setError("This system cannot record video in a format the editor can read.");
        return;
      }
      const chunks: Blob[] = [];
      let held = 0;
      const rec = new MediaRecorder(stream, { mimeType: mime });
      rec.ondataavailable = (event) => {
        if (request !== requestRef.current || !event.data.size) return;
        chunks.push(event.data);
        held += event.data.size;
        if (held >= MAX_RECORDING_BYTES && rec.state === "recording") {
          setError("Reached the maximum recording length — saving what was captured.");
          stop(true);
        }
      };
      rec.onstop = () => {
        if (request !== requestRef.current) return;
        recRef.current = null;
        releaseStream();
        void finish(chunks, rec.mimeType || mime, request);
      };
      rec.onerror = () => {
        if (request !== requestRef.current) return;
        stop(false);
        setPhase("idle");
        setError("Recording failed. Check your camera and microphone, then retry.");
      };
      recRef.current = rec;
      rec.start(1000);
      setElapsed(0);
      setPhase("recording");
    } catch (e) {
      stop(false);
      setError(`Could not start recording: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const finish = async (chunks: Blob[], mime: string, request: number): Promise<void> => {
    setPhase("saving");
    try {
      if (!projectDir) throw new Error("open a project first");
      const blob = new Blob(chunks, { type: mime });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (request !== requestRef.current) return;
      const ctx = makeTauriContext(projectDir);
      const saved = await saveRecording(ctx, bytes, mime);
      notifyLibraryChanged();
      useProjectNotice.getState().notify(`Saved ${saved.filename} to the library.`);
      if (request === requestRef.current) onClose();
    } catch (e) {
      if (request !== requestRef.current) return;
      setError(`Could not save the recording: ${e instanceof Error ? e.message : String(e)}`);
      setPhase("idle");
    }
  };

  const close = () => {
    ++requestRef.current;
    stop(false);
    onClose();
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

        {opening && (
          <p role="status" className="mt-2 text-[11px] text-neutral-400">
            Opening camera...
          </p>
        )}
        {error && (
          <p role="alert" className="mt-2 text-[11px] text-amber-400">
            {error}
          </p>
        )}

        <div className="mt-3 grid grid-cols-2 gap-3">
          <label className="text-[11px] text-neutral-400">
            Camera
            <select
              aria-label="camera"
              value={cameraId}
              disabled={opening || recording || phase === "saving" || !ready}
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
              disabled={opening || recording || phase === "saving" || !ready}
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
            {error && !ready && !opening && phase === "idle" && (
              <Button onClick={() => void openStream(cameraId, micId)}>Retry</Button>
            )}
            <Button variant="ghost" onClick={close} disabled={phase === "saving"}>
              {recording ? "Discard" : "Close"}
            </Button>
            {recording ? (
              <Button
                variant="primary"
                onClick={() => {
                  setPhase("saving");
                  stop(true);
                }}
              >
                Stop &amp; save
              </Button>
            ) : (
              <Button
                variant="primary"
                onClick={begin}
                disabled={phase === "saving" || opening || !ready || !projectDir}
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
