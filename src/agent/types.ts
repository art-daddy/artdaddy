// Wire shapes for the client-owned agent loop. The server runs ONE stateless
// model round (/inference) and the secret/model tools (/tools/server/{name});
// the client owns the loop, the transcript, and the continuity token.

export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  reasoning_tokens?: number;
  context_tokens?: number;
  cost_usd?: number;
}

export interface PendingCall {
  call_id: string;
  name: string;
  arguments: Record<string, unknown>;
  rationale?: string;
  reasoning_summary?: string[];
}

/** Normalized outcome of one /inference round (mirrors the engine's RoundResult). */
export interface RoundResultDTO {
  kind: "tool_calls" | "text" | "error";
  pending_calls: PendingCall[];
  final_text: string;
  error: string;
  credit_limit?: unknown;
  finish_reason: string;
  usage: Usage;
  provider_snapshot: Record<string, unknown>;
  /** This round's encrypted reasoning (client-owned history only). The app keeps it in the
   *  transcript and sends it back, so the model keeps its reasoning without a server chain. */
  reasoning_items?: Array<{ id: string; encrypted_content: string }>;
  /** Echoed only when the server actually rebuilt the input from the transcript. */
  history_mode?: "client";
}

export interface ToolResultItem {
  call_id: string;
  name: string;
  result: Record<string, unknown>;
}

/** One round's input (mirrors the engine's RoundInput). */
export interface RoundInput {
  user_text?: string;
  tool_results?: ToolResultItem[];
  is_retry?: boolean;
  extra_texts?: string[];
}

/** Media the model should SEE this round (uploaded as bytes). */
export interface InferenceAttachment {
  kind: string; // image | video | audio
  b64: string;
  caption?: string;
  fps?: number;
  ext?: string;
  /** Client-owned history: the tool call whose result showed this frame, and which of its
   *  frames it is. The server places the image from these, never from list order. */
  call_id?: string;
  index?: number;
}

/** One generated output file a server tool returned, for the client to persist. */
export interface GeneratedMedia {
  b64: string;
  ext?: string;
  kind?: string | null;
  name?: string | null;
  model?: string | null;
  prompt?: string | null;
  folder?: string | null;
}
