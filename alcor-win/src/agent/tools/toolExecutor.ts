import type { Editor } from "../../editor/editor";
import type { MediaAsset, TextMeasurer } from "../../model";
import { canvasTextMeasurer } from "../../preview/textRenderer";
import type { AgentHost } from "./agentHost";
import { publishAgentChanges, timelineReadActivity } from "./toolExecutorAgentActivity";
import { beginAgentTimelineRead, endAgentTimelineRead } from "../../editor/mutations/agentActivity";
import { ToolError, droppingAutofilledBlanks } from "./toolArgs";
import { currentIdUniverse, expandingIdPrefixes, shorteningIds } from "./toolExecutorShortId";
import { agentToolHooks } from "./toolHooks";
import { registeredTool, type ToolArgs } from "./toolRegistry";
import { error, type ToolResult } from "./toolResult";

export { ToolError } from "./toolArgs";
export { agentToolHooks, type AgentToolHooks } from "./toolHooks";

export interface ToolExecutorOptions {
  measureText?: TextMeasurer;
}

export type ToolSource = "agent" | "mcp";

/**
 * Shared by the MCP server and the in-app agent. Tool implementations register through `defineTools`; this class
 * resolves the editor, expands/shortens ids, publishes highlights and wraps errors.
 */
export class ToolExecutor {
  private readonly inAppEditor: Editor | null;
  readonly host: AgentHost | null;
  private readonly options: ToolExecutorOptions;

  private constructor(inAppEditor: Editor | null, host: AgentHost | null, options: ToolExecutorOptions) {
    this.inAppEditor = inAppEditor;
    this.host = host;
    this.options = options;
  }

  /** In-app chat: stays with the editor owned by its project window. */
  static forEditor(editor: Editor, options: ToolExecutorOptions = {}): ToolExecutor {
    return new ToolExecutor(editor, null, options);
  }

  /** External MCP session: follows the host's open project; `manage_project` rebinds it. */
  static forSession(host: AgentHost, options: ToolExecutorOptions = {}): ToolExecutor {
    return new ToolExecutor(null, host, options);
  }

  get editor(): Editor | null {
    return this.inAppEditor ?? this.host?.currentEditor() ?? null;
  }

  get measureText(): TextMeasurer {
    return this.options.measureText ?? this.host?.measureText ?? canvasTextMeasurer;
  }

  static get canGenerate(): boolean {
    return agentToolHooks.canGenerate?.() ?? false;
  }

  async execute(name: string, rawArgs: ToolArgs = {}, source: ToolSource = "agent"): Promise<ToolResult> {
    const args = droppingAutofilledBlanks(rawArgs);
    const tool = registeredTool(name);
    if (!tool || (source === "mcp" && tool.inAppOnly === true) || (source !== "mcp" && tool.mcpOnly === true)) {
      return error(`Unknown tool: ${name}`);
    }

    // project tools act on the host before an editor is available
    if (tool.needsEditor === false) {
      try {
        return await tool.run({ executor: this, editor: this.editor as Editor }, args);
      } catch (e) {
        return error(e instanceof Error ? e.message : String(e));
      }
    }

    const editor = this.editor;
    if (!editor) return error("Editor not available");

    const activeTimelineIdBefore = editor.store.committed.activeTimelineId;
    const before = editor.store.committed.timelines;
    const idsBefore = currentIdUniverse(editor);
    let result: ToolResult;
    let readRevision: number | undefined;
    try {
      const resolved = expandingIdPrefixes(args, idsBefore);
      readRevision = beginAgentTimelineRead(editor, timelineReadActivity(name, resolved, editor));
      result = await tool.run({ executor: this, editor }, resolved);
    } catch (e) {
      result = error(e instanceof ToolError ? e.message : e instanceof Error ? e.message : String(e));
    }
    if (readRevision !== undefined) endAgentTimelineRead(editor, readRevision, !result.isError);

    const after = editor.store.committed;
    if (
      !result.isError &&
      after.timelines !== before &&
      tool.publishesTimelineChanges === true &&
      after.activeTimelineId === activeTimelineIdBefore
    ) {
      const previous = before.find((t) => t.id === activeTimelineIdBefore);
      if (previous) publishAgentChanges(previous, editor.timeline, editor);
    }

    // Shorten on pre ∪ post ids: new ids and just-removed ids both stay short.
    const universe = currentIdUniverse(editor);
    for (const id of idsBefore) universe.add(id);
    return shorteningIds(result, universe);
  }

  // Shared helpers used by tool modules.

  asset(id: string, editor: Editor, label = "Media asset"): MediaAsset {
    const asset = editor.mediaAssets.find((a) => a.id === id);
    if (!asset) throw new ToolError(`${label} not found: ${id}`);
    return asset;
  }
}
