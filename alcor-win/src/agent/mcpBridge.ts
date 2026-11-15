import {
  mcpRespond, mcpRespondResource, mcpSetInstructions, mcpSetTools, onMcpCall, onMcpClient, onMcpResource,
  type McpCall, type McpResourceRequest, type McpTool, type McpToolResult,
} from "../platform/backend";
import { parseMcpClientInfo, type MCPClientInfo } from "./mcpClientInfo";
import type { AgentHost } from "./tools/agentHost";
import { projectNavigation, serverInstructions } from "./tools/agentInstructions";
import { modelResourceText } from "./tools/generateTools";
import { ToolExecutor, type ToolExecutorOptions } from "./tools/toolExecutor";
import { mcpServerTools, onToolRegistryChange, type ToolArgs } from "./tools/toolRegistry";
import { error, toMcpResult } from "./tools/toolResult";
import "./tools";

// Port of MCPService.swift: the MCP server's tool list, instructions and call dispatch. The HTTP transport lives in
// Rust (src-tauri/src/mcp.rs); this module feeds it the registered tools and executes the calls it forwards.

/** The Rust MCP server's surface, injectable so tests can stand in for the webview bridge. */
export interface McpBackend {
  setTools(tools: McpTool[]): Promise<void>;
  setInstructions(text: string | null): Promise<void>;
  respond(id: string, result: McpToolResult): Promise<void>;
  onCall(handler: (call: McpCall) => void): Promise<() => void>;
  onClient(handler: (clientInfo: unknown) => void): Promise<() => void>;
  /** `resources/read` requests forwarded by the Rust server (`palmier://models/...`). */
  onResource?(handler: (request: McpResourceRequest) => void): Promise<() => void>;
  respondResource?(id: string, text: string | null): Promise<void>;
}

export const tauriMcpBackend: McpBackend = {
  setTools: mcpSetTools,
  setInstructions: mcpSetInstructions,
  respond: mcpRespond,
  onCall: onMcpCall,
  onClient: onMcpClient,
  onResource: onMcpResource,
  respondResource: mcpRespondResource,
};

export interface AgentMcpBridge {
  readonly executor: ToolExecutor;
  /** Re-reads the registered tools and pushes them if they changed (a project opened/closed, a group registered). */
  refresh(): Promise<void>;
  /** Runs one forwarded call and answers it. Exposed for tests; the bridge wires it to `mcp://call` itself. */
  handleCall(call: McpCall): Promise<void>;
  /** Client info of the most recent MCP `initialize`. */
  clientInfo(): MCPClientInfo | undefined;
  dispose(): void;
}

/** `AgentInstructions.serverInstructions + AgentInstructions.projectNavigation`. */
export const mcpServerInstructions = serverInstructions + projectNavigation;

export function mcpToolList(): McpTool[] {
  return mcpServerTools().map(({ definition }) => ({
    name: definition.name,
    description: definition.description,
    inputSchema: definition.inputSchema,
    ...(definition.annotations ? { annotations: definition.annotations } : {}),
  }));
}

/**
 * Pushes the tool list and instructions to the Rust server and answers its `mcp://call` events with the executor.
 *
 * Concurrency matches Swift's `@MainActor` executor: JavaScript runs each tool's synchronous segment to completion,
 * so edits never interleave; only awaits inside async tools (project open/close, frame renders) can overlap.
 */
export async function startAgentMcpBridge(
  host: AgentHost,
  options: { backend?: McpBackend; executor?: ToolExecutorOptions } = {},
): Promise<AgentMcpBridge> {
  const backend = options.backend ?? tauriMcpBackend;
  const executor = ToolExecutor.forSession(host, options.executor);
  let lastPushed = "";
  let clientInfo: MCPClientInfo | undefined;
  let disposed = false;
  let pushQueue: Promise<void> = Promise.resolve();

  const push = async (): Promise<void> => {
    const tools = mcpToolList();
    const key = JSON.stringify(tools);
    if (key === lastPushed) return;
    await backend.setTools(tools);
    lastPushed = key;
  };
  // Pushes are serialised so a slow earlier push can never overwrite a newer list.
  const refresh = (): Promise<void> => {
    pushQueue = pushQueue.then(push, push);
    return pushQueue;
  };

  const handleCall = async (call: McpCall): Promise<void> => {
    let result: McpToolResult;
    try {
      const args = call.arguments === undefined || call.arguments === null ? {} : call.arguments;
      if (typeof args !== "object" || Array.isArray(args)) {
        result = toMcpResult(error("Invalid arguments: expected an object."));
      } else {
        result = toMcpResult(await executor.execute(call.name, args as ToolArgs, "mcp"));
      }
    } catch (e) {
      result = toMcpResult(error(e instanceof Error ? e.message : String(e)));
    }
    try {
      await backend.respond(call.id, result);
    } catch (e) {
      console.error("mcp respond failed", e);
    }
  };

  const unlisteners: (() => void)[] = [];
  unlisteners.push(await backend.onCall((call) => void handleCall(call)));
  if (backend.onResource && backend.respondResource) {
    const respondResource = backend.respondResource.bind(backend);
    unlisteners.push(
      await backend.onResource((request) => {
        void respondResource(request.id, modelResourceText(request.uri)).catch((e) => console.error("mcp resource respond failed", e));
      }),
    );
  }
  unlisteners.push(
    await backend.onClient((raw) => {
      const info = parseMcpClientInfo(raw);
      if (info) clientInfo = info;
    }),
  );
  unlisteners.push(onToolRegistryChange(() => void refresh().catch((e) => console.error("mcp tool push failed", e))));
  if (host.onCurrentEditorChange) {
    unlisteners.push(host.onCurrentEditorChange(() => void refresh().catch((e) => console.error("mcp tool push failed", e))));
  }

  await backend.setInstructions(mcpServerInstructions);
  await refresh();

  return {
    executor,
    refresh,
    handleCall,
    clientInfo: () => clientInfo,
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const off of unlisteners) off();
    },
  };
}
