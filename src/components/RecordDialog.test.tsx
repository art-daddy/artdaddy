// The recording ceiling is what the whole-file-read guard names as this module's bound, so it
// has to actually fire — a bound nothing exercises is a claim, not a limit.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
      getUserMedia: vi.fn(async () => ({ getTracks: () => [] }) as unknown as MediaStream),
      enumerateDevices: vi.fn(async () => []),
    },
  });
});

async function startRecording(): Promise<FakeRecorder> {
  render(<RecordDialog open projectDir="C:/p" onClose={vi.fn()} />);
  const record = await screen.findByRole("button", { name: "Record" });
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
});
