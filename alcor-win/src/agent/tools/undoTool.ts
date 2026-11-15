import { ToolError } from "./toolArgs";
import type { ToolContext } from "./toolRegistry";
import { ok, type ToolResult } from "./toolResult";

/** `ToolExecutor.undo`: undoes the latest action of any origin. */
export function undoTool({ editor }: ToolContext): ToolResult {
  if (editor.undo() === null) throw new ToolError("Nothing to undo.");
  return ok(
    "Undid the latest action. The timeline is restored to its state before that edit; re-read with get_timeline or get_transcript before editing again.",
  );
}
