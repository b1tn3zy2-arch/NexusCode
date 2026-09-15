export interface TokenUsage {
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
}

export interface Session {
  id: string;
  slug?: string;
  title: string;
  directory: string;
  projectID?: string;
  agent?: string;
  version?: string;
  cost?: number;
  tokens?: TokenUsage;
  model?: { id: string; providerID: string; variant?: string };
  time: { created: number; updated: number };
}

export interface ToolState {
  status: "pending" | "running" | "completed" | "error";
  input?: unknown;
  output?: unknown;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface Part {
  id: string;
  type: string;
  messageID?: string;
  sessionID?: string;
  text?: string;
  tool?: string;
  synthetic?: boolean;
  mime?: string;
  url?: string;
  filename?: string;
  state?: ToolState;
  time?: { start?: number; end?: number };
}

export interface MessageInfo {
  id: string;
  role: "user" | "assistant";
  sessionID: string;
  agent?: string;
  modelID?: string;
  providerID?: string;
  tokens?: TokenUsage;
  cost?: number;
  time: { created: number; end?: number; completed?: number };
}

export interface Message {
  info: MessageInfo;
  parts: Part[];
  local?: boolean;
}

export interface OcEvent {
  id?: string;
  type: string;
  properties: Record<string, unknown>;
}

export interface ServerInfoPayload {
  port: number;
  pid: number;
  work_dir: string;
  binary_path: string;
}

export interface ImageAttachment {
  id: string;
  mime: string;
  width: number;
  height: number;
  size: number;
  b64: string;
  name?: string;
}
