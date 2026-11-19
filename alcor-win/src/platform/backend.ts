import { Channel, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

// ---- fsio ----

export interface FsEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  modifiedMs: number;
}

export interface AppPaths {
  projects: string;
  appData: string;
  cache: string;
  temp: string;
  downloads: string;
}

export const fsReadText = (path: string): Promise<string> => invoke("fs_read_text", { path });
export const fsWriteText = (path: string, contents: string): Promise<void> =>
  invoke("fs_write_text", { path, contents });
// Tauri serialises a Uint8Array argument as an object, so bytes cross as a number array.
export const fsWriteBytes = (path: string, bytes: Uint8Array): Promise<void> =>
  invoke("fs_write_bytes", { path, bytes: Array.from(bytes) });
export const fsExists = (path: string): Promise<boolean> => invoke("fs_exists", { path });
export const fsStat = (path: string): Promise<FsEntry | null> => invoke("fs_stat", { path });
export const fsList = (path: string): Promise<FsEntry[]> => invoke("fs_list", { path });
export const fsMkdir = (path: string): Promise<void> => invoke("fs_mkdir", { path });
export const fsCopy = (from: string, to: string): Promise<void> => invoke("fs_copy", { from, to });
export const fsRename = (from: string, to: string): Promise<void> => invoke("fs_rename", { from, to });
export const fsRemove = (path: string): Promise<void> => invoke("fs_remove", { path });
export const appPaths = (): Promise<AppPaths> => invoke("app_paths");

// ---- secrets ----

export const secretSet = (name: string, value: string): Promise<void> => invoke("secret_set", { name, value });
export const secretDelete = (name: string): Promise<void> => invoke("secret_delete", { name });
export const secretHas = (name: string): Promise<boolean> => invoke("secret_has", { name });
/** Whether this build bundles a key for `name` (used only when the user has none stored). */
export const secretBuiltin = (name: string): Promise<boolean> => invoke("secret_builtin", { name });
export const secretListPresent = (names: string[]): Promise<string[]> =>
  invoke("secret_list_present", { names });

export interface CustomEndpoint {
  id: string;
  host: string;
}

export const customEndpointSet = (id: string, baseUrl: string): Promise<void> =>
  invoke("custom_endpoint_set", { id, baseUrl });
export const customEndpointRemove = (id: string): Promise<void> => invoke("custom_endpoint_remove", { id });
export const customEndpointList = (): Promise<CustomEndpoint[]> => invoke("custom_endpoint_list");

// ---- http ----

export type PartValue =
  | { kind: "text"; value: string }
  | { kind: "bytes"; value: number[] }
  | { kind: "file"; path: string };

export interface Part {
  name: string;
  filename?: string;
  contentType?: string;
  value: PartValue;
}

export type HttpBody =
  | { kind: "text"; value: string }
  | { kind: "json"; value: unknown }
  | { kind: "bytes"; value: number[] }
  | { kind: "file"; path: string }
  | { kind: "multipart"; parts: Part[] };

export interface HttpAuth {
  secret: string;
  header?: string;
  prefix?: string;
  query?: string;
}

export interface HttpRequest {
  requestId?: string;
  url: string;
  method?: string;
  headers?: [string, string][];
  body?: HttpBody;
  auth?: HttpAuth;
  timeoutMs?: number;
}

export interface HttpResponse {
  status: number;
  headers: [string, string][];
  bodyText: string;
}

export type StreamEvent =
  | { event: "status"; status: number; headers: [string, string][] }
  | { event: "chunk"; text: string }
  | { event: "done" }
  | { event: "error"; message: string };

export interface DownloadProgress {
  received: number;
  total: number | null;
}

export interface DownloadResult {
  path: string;
  bytes: number;
  contentType: string | null;
}

export const httpFetch = (req: HttpRequest): Promise<HttpResponse> => invoke("http_fetch", { req });
/** Resolves with the body of a 2xx response; rejects with `HTTP <status>: <excerpt>` otherwise. */
export const httpFetchBytes = (req: HttpRequest): Promise<ArrayBuffer> => invoke("http_fetch_bytes", { req });

/** Outcome is always delivered through `onEvent` (`done` or `error`). */
export function httpStream(req: HttpRequest, onEvent: (e: StreamEvent) => void): Promise<void> {
  const channel = new Channel<StreamEvent>();
  channel.onmessage = onEvent;
  return invoke("http_stream", { req, onEvent: channel });
}

export const httpCancel = (requestId: string): Promise<boolean> => invoke("http_cancel", { requestId });

export function httpDownload(
  req: HttpRequest,
  destPath: string,
  onProgress: (p: DownloadProgress) => void,
): Promise<DownloadResult> {
  const channel = new Channel<DownloadProgress>();
  channel.onmessage = onProgress;
  return invoke("http_download", { req, destPath, onProgress: channel });
}

// ---- mcp ----

export interface McpTool {
  name: string;
  description?: string;
  inputSchema: unknown;
}

export interface McpCall {
  id: string;
  name: string;
  arguments: unknown;
}

export interface McpToolResult {
  content: unknown[];
  isError?: boolean;
}

export interface McpStatus {
  running: boolean;
  port: number;
  error: string | null;
}

export const mcpSetTools = (tools: McpTool[]): Promise<void> => invoke("mcp_set_tools", { tools });
export const mcpSetInstructions = (text: string | null): Promise<void> =>
  invoke("mcp_set_instructions", { text });
export const mcpRespond = (id: string, result: McpToolResult): Promise<void> =>
  invoke("mcp_respond", { id, result });
/** Answers an `mcp://resource` request with the resource text, or null when it can't be produced. */
export const mcpRespondResource = (id: string, text: string | null): Promise<void> =>
  invoke("mcp_respond", { id, result: text });
export const mcpStatus = (): Promise<McpStatus> => invoke("mcp_status");
export const onMcpCall = (handler: (call: McpCall) => void): Promise<UnlistenFn> =>
  listen<McpCall>("mcp://call", (e) => handler(e.payload));

// ---- export file (streaming positional writer) ----

export const exportFileOpen = (path: string): Promise<number> => invoke("export_file_open", { path });
// A Uint8Array argument is sent as the raw request body (no JSON number array).
export const exportFileWrite = (handle: number, offset: number, bytes: Uint8Array): Promise<void> =>
  invoke("export_file_write", bytes, { headers: { "x-handle": String(handle), "x-offset": String(offset) } });
export const exportFileFinish = (handle: number): Promise<void> => invoke("export_file_finish", { handle });
export const exportFileAbort = (handle: number): Promise<void> => invoke("export_file_abort", { handle });
export interface McpResourceRequest {
  id: string;
  uri: string;
}
export const onMcpResource = (handler: (request: McpResourceRequest) => void): Promise<UnlistenFn> =>
  listen<McpResourceRequest>("mcp://resource", (e) => handler(e.payload));
/** `initialize` client info of each MCP session (Swift `MCPClientInfo`). */
export const onMcpClient = (handler: (clientInfo: unknown) => void): Promise<UnlistenFn> =>
  listen<unknown>("mcp://client", (e) => handler(e.payload));
