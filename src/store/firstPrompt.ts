// The assistant pane exists before any project does. What the user types there has to survive
// the navigation into the project it creates, or their first sentence is thrown away.
let pending: { projectId: string; text: string } | null = null;

export function setFirstPrompt(projectId: string, text: string): void {
  const message = text.trim();
  pending = projectId && message ? { projectId, text: message } : null;
}

export function peekFirstPrompt(projectId: string): string | null {
  return pending?.projectId === projectId ? pending.text : null;
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
