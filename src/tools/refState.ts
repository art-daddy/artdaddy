// What to say when a `media_ref` does not resolve.
//
// A generation tool hands back a ref the instant the request is away, so for the length of the job
// the ref is REAL and RESOLVES TO NOTHING. Every resolver returns null for that, and each tool
// worded its own null branch — "media not found", "local file not found", "image not found". Only
// `add_clips` had been taught the difference, so in one real session the model was told "media not
// found: media_gen_eaaa6fd58bd8" twenty-one times, did what that implies (concluded its ref was
// wrong) and started inventing paths like `library/media_gen_cdf49e3204da.mp4`, which failed in
// turn. 28 of the session's 51 tool errors came from this one message.
//
// So the wording is not a per-tool decision. `pendingMedia` on the store answers the question and
// this answers what to say about it; `refState.conformance.test.ts` walks every contract tool that
// takes a `media_ref` and fails if one of them still says "not found" about media we are making.
import type { ProjectStoreAccess } from "./store";

/** The message for a ref that did not resolve: pending/failed if the catalog knows it, otherwise
 *  the caller's own "unknown ref" text (which is still the right answer for a typo). */
export async function unresolvedRefMessage(
  store: ProjectStoreAccess,
  ref: string,
  whenUnknown: string,
): Promise<string> {
  const pending = await store.pendingMedia(ref).catch(() => null);
  if (!pending) return whenUnknown;
  if (pending.status === "failed") {
    const why = pending.error ? `: ${pending.error}` : "";
    return `'${ref}' failed to generate${why}, so there is no file to read. Generate it again or use different media — do not retry this ref.`;
  }
  return `'${ref}' is still being generated, so there is nothing to read yet. The ref is correct; you will be told when it lands. Don't re-generate it and don't guess a file path.`;
}

/** `{ok:false}` shape for the same, for the tools that return rather than throw. */
export async function unresolvedRefError(
  store: ProjectStoreAccess,
  ref: string,
  whenUnknown: string,
): Promise<{ ok: false; error: string }> {
  return { ok: false, error: await unresolvedRefMessage(store, ref, whenUnknown) };
}
