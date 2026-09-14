// Domain types for the ArtDaddy API. Request-body shapes are also mirrored in the
// generated src/api/schema.d.ts (from the server OpenAPI); responses are plain
// dicts server-side, so they're typed here.

export interface Canvas {
  width: number;
  height: number;
  fps: number;
}

export interface ProjectManifest {
  status: string;
  model_id: string;
  active_style: string;
  active_workflow: string;
  planning_mode: string;
  final_mp4: string;
  tool_call_count: number;
}

export interface ProjectSummary {
  id: string;
  name: string;
  path: string;
  settings: { canvas?: Canvas };
  manifest?: ProjectManifest | null;
}

export interface ProjectListEntry {
  id: string;
  name: string;
  path: string;
  lastOpenedAt?: string;
}

export interface ProjectsResponse {
  active_project_id: string | null;
  projects: ProjectListEntry[];
}

export interface SessionState {
  cost_usd: number;
  input_tokens: number;
  context_tokens?: number;
  output_tokens: number;
  reasoning_tokens: number;
  approval_mode: string;
  finished: boolean;
  pending: boolean;
  can_undo?: boolean;
  can_redo?: boolean;
  final_mp4?: string;
}

export interface StateResponse {
  project: ProjectSummary;
  session: SessionState | null;
}

export interface AttachmentInfo {
  path?: string;
  kind?: string;
  name?: string;
  caption?: string;
  asset_id?: string;
}

export interface Attachment {
  path: string;
  kind?: string | null;
  caption?: string | null;
}

export interface FileNode {
  name: string;
  path: string;
  type: "dir" | "file";
  size?: number;
  children?: FileNode[];
  /** Referenced-in-place media whose source file is gone (Premiere's "Media Offline"). */
  offline?: boolean;
}

export interface TranscriptPart {
  kind: string;
  [k: string]: unknown;
}

export interface TranscriptMessage {
  text?: string;
  attachments?: AttachmentInfo[];
}

export interface TranscriptRequest {
  id: string;
  message?: TranscriptMessage;
  response?: TranscriptPart[];
  undone?: boolean;
  checkpoint?: { timeline?: unknown; timeline_after?: unknown };
}

export interface PendingApproval {
  call_id: string;
  name: string;
  arguments: Record<string, unknown>;
  rationale: string;
  reasoning_summary: string[];
}

export type TurnEventName =
  | "turn_start"
  | "reasoning"
  | "tool_call"
  | "tool_result"
  | "text"
  | "awaiting_approval"
  | "turn_paused"
  | "final"
  | "turn_done"
  | "error";

export interface TurnEvent {
  event: TurnEventName | string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;
}

export type ApprovalMode = "default" | "autopilot";

export interface Timeline {
  canvas?: Canvas;
  tracks?: unknown[];
  [k: string]: unknown;
}
