// The recording ceiling is what the whole-file-read guard names as this module's bound, so it
// has to actually fire — a bound nothing exercises is a claim, not a limit.
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MAX_RECORDING_BYTES } from "../media/recorder";

const h = vi.hoisted(() => ({ saved: [] as number[] }));

vi.mock("../media/recordSave", () => ({
  saveRecording: vi.fn(async (_ctx: unknown, bytes: Uint8Array) => {
    h.saved.push(bytes.byteLength);
    return { media_ref: "m1", filename: "recording.mp4", transcoded: false };
  }),
}));
vi.mock("../tools/import", () => ({ notifyLibraryChanged: vi.fn() }));
vi.mock("../tools/tauri", () => ({ makeTauriContext: () => ({}) }));

import RecordDialog from "./RecordDialog";

function captureStream(stopTrack = vi.fn()): MediaStream {
  return Object.assign(new MediaStream(), {
    getTracks: vi.fn(() => [{ stop: stopTrack } as unknown as MediaStreamTrack]),
  });
}

/** A MediaRecorder we can feed chunks to on demand. */
class FakeRecorder {
  static last: FakeRecorder | null = null;
  static isTypeSupported = (t: string): boolean => t.startsWith("video/mp4");
  state: "inactive" | "recording" = "inactive";
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  stopCalls = 0;
  constructor(_s: MediaStream, _o: unknown) {
    FakeRecorder.last = this;
  }
  start(): void {
    this.state = "recording";
  }
  stop(): void {
    this.stopCalls += 1;
    this.state = "inactive";
    this.onstop?.();
  }
  /** Deliver a chunk of `size` bytes the way the browser would. */
  emit(size: number): void {
    this.ondataavailable?.({ data: { size } as Blob });
  }
}

beforeEach(() => {
  h.saved = [];
  FakeRecorder.last = null;
  vi.stubGlobal("MediaRecorder", FakeRecorder);
  vi.stubGlobal("navigator", {
    ...navigator,
    mediaDevices: {
      getUserMedia: vi.fn(async () => captureStream()),
      enumerateDevices: vi.fn(async () => []),
    },
  });
});

async function startRecording(): Promise<FakeRecorder> {
  render(<RecordDialog open projectDir="C:/p" onClose={vi.fn()} />);
  const record = await screen.findByRole("button", { name: "Record" });
  await waitFor(() => expect(record).toBeEnabled());
  fireEvent.click(record);
  await waitFor(() => expect(FakeRecorder.last).not.toBeNull());
  return FakeRecorder.last as FakeRecorder;
}

describe("RecordDialog", () => {
  it("stops itself once the take reaches the heap ceiling", async () => {
    const rec = await startRecording();
    const chunk = MAX_RECORDING_BYTES / 4;
    rec.emit(chunk);
    rec.emit(chunk);
    rec.emit(chunk);
    expect(rec.stopCalls, "under the ceiling it must keep recording").toBe(0);
    rec.emit(chunk); // this one reaches it
    expect(rec.stopCalls).toBe(1);
    // Stopping SAVES the take; discarding an hour of someone's recording is the worse failure.
    await waitFor(() => expect(h.saved.length).toBe(1));
    await screen.findByText(/maximum recording length/i);
  });

  it("keeps recording for an ordinary take", async () => {
    const rec = await startRecording();
    for (let i = 0; i < 60; i++) rec.emit(500_000); // a minute of webcam
    expect(rec.stopCalls).toBe(0);
    expect(h.saved.length).toBe(0);
  });

  it("discards a take without saving it", async () => {
    const rec = await startRecording();
    rec.emit(500_000);
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    await act(async () => {});
    expect(rec.stopCalls).toBe(1);
    expect(h.saved).toEqual([]);
  });

  it("saves a take once when Stop & save is clicked", async () => {
    const rec = await startRecording();
    rec.emit(500_000);
    fireEvent.click(screen.getByRole("button", { name: "Stop & save" }));
    await waitFor(() => expect(h.saved).toHaveLength(1));
    expect(rec.stopCalls).toBe(1);
  });

  it("names an unavailable capture API without throwing or enabling Record", async () => {
    vi.stubGlobal("navigator", { ...navigator, mediaDevices: undefined });
    render(<RecordDialog open projectDir="C:/p" onClose={vi.fn()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Install the latest ArtDaddy release",
    );
    expect(screen.getByRole("button", { name: "Record" })).toBeDisabled();
    expect(h.saved).toEqual([]);
  });

  it("can retry after permission is refused", async () => {
    vi.mocked(navigator.mediaDevices.getUserMedia).mockRejectedValueOnce(
      new DOMException("denied", "NotAllowedError"),
    );
    render(<RecordDialog open projectDir="C:/p" onClose={vi.fn()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("access was refused");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Record" })).toBeEnabled());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("stops a late stream when the dialog closed while permission was pending", async () => {
    let grant!: (stream: MediaStream) => void;
    vi.mocked(navigator.mediaDevices.getUserMedia).mockReturnValueOnce(
      new Promise((resolve) => {
        grant = resolve;
      }),
    );
    const stopTrack = vi.fn();
    const { rerender } = render(<RecordDialog open projectDir="C:/p" onClose={vi.fn()} />);
    rerender(<RecordDialog open={false} projectDir="C:/p" onClose={vi.fn()} />);
    await act(async () => {
      grant(captureStream(stopTrack));
    });
    expect(stopTrack).toHaveBeenCalledTimes(1);
    expect(navigator.mediaDevices.enumerateDevices).not.toHaveBeenCalled();
    expect(h.saved).toEqual([]);
  });

  it("does not save into a different project after a switch", async () => {
    const { rerender } = render(<RecordDialog open projectDir="C:/first" onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Record" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Record" }));
    const recorder = FakeRecorder.last!;
    recorder.emit(500_000);
    rerender(<RecordDialog open projectDir="C:/second" onClose={vi.fn()} />);
    await act(async () => {});
    expect(recorder.stopCalls).toBe(1);
    expect(h.saved).toEqual([]);
  });

  it("releases the camera when unmounted without saving", async () => {
    const stopTrack = vi.fn();
    vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValueOnce(captureStream(stopTrack));
    const { unmount } = render(<RecordDialog open projectDir="C:/p" onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Record" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Record" }));
    FakeRecorder.last!.emit(500_000);
    unmount();
    await act(async () => {});
    expect(stopTrack).toHaveBeenCalledTimes(1);
    expect(h.saved).toEqual([]);
  });
});
