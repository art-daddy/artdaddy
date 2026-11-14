// The assistant's controls: the models the picker offers, the efforts each accepts, and what a new app
// starts with. They are written once, here, so a starting value can never be one the picker does not
// offer. Nothing saves the person's choice (the chat file holds no model and no effort), so a changed
// default reaches everyone who updates; anyone can still pick another value for the session.

// Gemini ids route to the Gemini provider server-side by prefix (attachments.is_gemini_model),
// so adding them here is all that is needed to offer them. The gemini-3.x family is withdrawn for
// now and the server refuses it too, so listing one here would only produce a 400.
/** The models the picker offers, the default first. */
export const PICKER_MODELS: string[] = ["gpt-6-luna", "gpt-6.1-sol"];
export const DEFAULT_MODEL = "gpt-6-luna";

export const EFFORTS: string[] = ["none", "low", "medium", "high", "xhigh"];
/** What a new app starts with for every model above (owner decision, 14 Nov 2026): in his benchmark
 *  medium was about a second a round quicker than high, with no accuracy difference beyond noise. */
export const DEFAULT_EFFORT = "medium";

// gpt-6.1-sol rejects "none"; the server would send it as "low", so don't offer it.
/** The efforts a model accepts. */
export const effortsFor = (model: string): string[] =>
  model === "gpt-6.1-sol" ? EFFORTS.slice(1) : EFFORTS;
