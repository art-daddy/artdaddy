// The CLIENT owns the agent loop (Cursor pattern). The legacy server-driven SSE
// loop + WS tool proxy were removed in P5, so there is no longer a fallback to
// switch to — this always returns true. The guard is kept (vestigial) only until
// the remaining dead SSE branches in `store/chat.ts` are pruned; callers can then
// drop it entirely.
export function clientLoopEnabled(): boolean {
  return true;
}
