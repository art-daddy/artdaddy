// The assistant pane exists before any project does. What the user types there has to survive
// the navigation into the project it creates, or their first sentence is thrown away.
let pending: string | null = null;

export function setFirstPrompt(text: string): void {
  pending = text.trim() || null;
}

/** Read once — a second mount (or a later project) must not inherit it. */
export function takeFirstPrompt(): string | null {
  const t = pending;
  pending = null;
  return t;
}
