import type { Editor } from "../../editor/editor";
import { expandToLinkGroup } from "../../editor/mutations/linking";
import { decomposeNest, nestSelectedClips } from "../../editor/mutations/nesting";
import type { ContextMenuItem } from "../../ui/ContextMenu";

/**
 * Clip-menu provider for the Swift "Create Nested Timeline" / "Decompose Nested Timeline" items.
 * "Open Timeline" stays in contextMenus.ts (`nestItems`). Register with:
 * `clipMenuSectionProviders.push(nestClipMenuProvider(editor))`.
 */
export function nestClipMenuProvider(editor: Editor): (clipId: string) => ContextMenuItem[] {
  return (clipId) => {
    const clip = editor.clipFor(clipId);
    if (!clip) return [];
    const items: ContextMenuItem[] = [
      { kind: "item", label: "Create Nested Timeline", onSelect: () => nestSelectedClips(editor) },
    ];
    const selected = editor.ui.selectedClipIds;
    const group = expandToLinkGroup(editor, new Set([clipId]));
    const singleLinkGroup = selected.size === group.size && [...selected].every((id) => group.has(id));
    if (clip.sourceClipType === "sequence" && singleLinkGroup) {
      items.push({ kind: "item", label: "Decompose Nested Timeline", onSelect: () => decomposeNest(editor, clipId) });
    }
    return items;
  };
}
