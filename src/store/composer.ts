// Whether the person has an unsent draft in the chat box.
//
// The chat box keeps its text in the component, where nothing else can see it. The wake for words the
// assistant was told were not ready must not start a turn while a draft sits there (a turn turns Send into
// Stop, and the draft could not be sent), so the box says here, when its content goes from empty to
// something and back, and the wake asks at the moment it would start.
import { create } from "zustand";

interface ComposerState {
  /** True while the box holds text or an attachment that has not been sent. */
  hasDraft: boolean;
  setDraft: (hasDraft: boolean) => void;
}

export const useComposer = create<ComposerState>((set) => ({
  hasDraft: false,
  setDraft: (hasDraft) => set((s) => (s.hasDraft === hasDraft ? s : { hasDraft })),
}));

export function composerHasDraft(): boolean {
  return useComposer.getState().hasDraft;
}

/** Whether a box's content counts as a draft: any visible character, or something attached. */
export function isDraft(text: string, attachments: number): boolean {
  return text.trim().length > 0 || attachments > 0;
}

/** Tests only. */
export function __resetComposer(): void {
  useComposer.setState({ hasDraft: false });
}
