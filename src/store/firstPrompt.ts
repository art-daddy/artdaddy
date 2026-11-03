// The assistant pane exists before any project does. What the user types there has to survive
// the navigation into the project it creates, or their first sentence is thrown away.
//
// It carries the footage the person chose on the start screen too. It cannot be imported before the project is
// open (an import needs the open project's store), so the chat does that first and sends the prompt only once
// the footage is in, with it attached (T-30).

/** A file chosen on the start screen: a path on disk (desktop: it is linked in place, never copied) or the file
 *  itself (the web build). */
export type Footage = { name: string; path: string } | { name: string; file: File };

interface Pending {
  projectId: string;
  text: string;
  footage: Footage[];
}

let pending: Pending | null = null;

export function setFirstPrompt(
  projectId: string,
  text: string,
  footage: readonly Footage[] = [],
): void {
  const message = text.trim();
  pending = projectId && message ? { projectId, text: message, footage: [...footage] } : null;
}

export function peekFirstPrompt(projectId: string): string | null {
  return pending?.projectId === projectId ? pending.text : null;
}

/** The footage still waiting to be brought into the project. */
export function peekFirstFootage(projectId: string): Footage[] {
  return pending?.projectId === projectId ? [...pending.footage] : [];
}

/** The footage, once: it leaves the pending prompt (whose text stays), so it is imported once however often
 *  the chat renders. */
export function takeFirstFootage(projectId: string): Footage[] {
  if (pending?.projectId !== projectId) return [];
  const { footage } = pending;
  pending.footage = [];
  return footage;
}

export function discardFirstPrompt(projectId: string): void {
  if (pending?.projectId === projectId) pending = null;
}

/** Read once — a second mount (or a later project) must not inherit it. */
export function takeFirstPrompt(projectId: string): string | null {
  const text = peekFirstPrompt(projectId);
  discardFirstPrompt(projectId);
  return text;
}
