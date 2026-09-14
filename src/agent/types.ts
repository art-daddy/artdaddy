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
  finish_reason: string;
  usage: Usage;
  provider_snapshot: Record<string, unknown>;
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
