// One-line warnings that belong to the project rather than to whatever the user just clicked.
//
// Everything else here reports through the control that started it (a toast next to the menu,
// an error on the export dialog). A project opened somewhere else has no such control: nobody
// asked for it, it is discovered during open, and it still has to reach the user.
import { create } from "zustand";

interface ProjectNotice {
  message: string | null;
  notify: (message: string) => void;
  clear: () => void;
}

export const useProjectNotice = create<ProjectNotice>((set) => ({
  message: null,
  notify: (message) => set({ message }),
  clear: () => set({ message: null }),
}));
