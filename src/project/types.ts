// Foundational types for the ProjectDocument refactor (ADR-0001). Types + tiny
// constructors only — no lifecycle behavior yet; the registry/document (Phase 1)
// are the first consumers. Path safety is deliberately NOT re-implemented here: a
// ProjectId is a brand, and id -> package-root resolution + `..`/absolute/symlink
// containment stay the repository's single responsibility (see
// docs/PROJECT_DOCUMENT_ARCHITECTURE.md §16.1). Keeping that in one place avoids the
// capability drift the design warns against.

/** A logical project identifier. Brand-typed so a raw string can't be passed where
 *  a resolved project identity is required. */
export type ProjectId = string & { readonly __brand: "ProjectId" };

/** One open of one project. A fresh value per open/reopen, so a result captured by
 *  an old session is rejected at the final commit even after a same-id reopen. */
export type SessionId = string & { readonly __brand: "SessionId" };

/** Tag a raw string as a ProjectId. Non-emptiness is the only invariant enforced
 *  here; path/containment safety is the repository's job, not the brand's. */
export function asProjectId(raw: string): ProjectId {
  if (!raw) throw new Error("ProjectId must be a non-empty string");
  return raw as ProjectId;
}

export function asSessionId(raw: string): SessionId {
  if (!raw) throw new Error("SessionId must be a non-empty string");
  return raw as SessionId;
}

/** A new, unique session id for an open/reopen. */
export function newSessionId(): SessionId {
  return crypto.randomUUID() as SessionId;
}

/** The single lifecycle phase of a project document. `closing` (drain new work) -> `saving`
 *  (persist timeline + transcript) -> `closed` on success, or `close-failed` on a save failure
 *  (the document stays alive for Retry/Discard/Cancel). */
export type ProjectPhase =
  "opening" | "open" | "closing" | "saving" | "close-failed" | "closed" | "failed";

/** Expected operational outcomes carried as data — not exceptions disguised as
 *  success. Programmer errors / violated internal invariants still throw. */
export type ProjectFailureKind =
  | "cancelled"
  | "closing"
  | "stale_origin"
  | "conflict"
  | "invalid"
  | "not_found"
  | "offline_media"
  | "unsupported"
  | "persistence_failed"
  | "corrupt_project";

/** A command/operation result. `ok:true` carries the committed value + the document
 *  revision + whether it is persisted yet; `ok:false` carries a stable,
 *  machine-readable failure (tool adapters map `code`; UI renders `message`). */
export type ProjectResult<T> =
  | { ok: true; value: T; revision: number; persistence: "dirty" | "durable" }
  | { ok: false; kind: ProjectFailureKind; code: string; message: string; retryable: boolean };

export function projectOk<T>(
  value: T,
  revision: number,
  persistence: "dirty" | "durable" = "dirty",
): ProjectResult<T> {
  return { ok: true, value, revision, persistence };
}

export function projectFail(
  kind: ProjectFailureKind,
  code: string,
  message: string,
  retryable = false,
): ProjectResult<never> {
  return { ok: false, kind, code, message, retryable };
}
