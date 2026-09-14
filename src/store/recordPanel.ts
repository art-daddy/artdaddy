// Where the recorder is opened from, so the three entry points drive ONE dialog.
//
// Discoverability was the whole point of adding it in three places (toolbar, media panel, and the
// empty stage); three copies of the dialog would be three cameras fighting for the same device.
import { create } from "zustand";

interface RecordPanelState {
  open: boolean;
  openRecorder: () => void;
  closeRecorder: () => void;
}

export const useRecordPanel = create<RecordPanelState>((set) => ({
  open: false,
  openRecorder: () => set({ open: true }),
  closeRecorder: () => set({ open: false }),
}));
