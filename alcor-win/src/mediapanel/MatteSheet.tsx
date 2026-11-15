import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import type { Editor } from "../editor/editor";
import { createMatte } from "../editor/mutations/matte";
import { makeRGBA, matteAspectPixelSize, matteAspects, type MatteAspect } from "../model";
import { ColorField } from "../ui/ColorField";
import { hexText } from "../ui/color";
import { DropdownMenuButton } from "../ui/DropdownMenuButton";
import "../ui/Dialog.css";
import "./MatteSheet.css";

/** Port of MatteSheet.swift: pick a colour and aspect, then add a solid-colour PNG to the library. */
export function MatteSheet(props: { editor: Editor; onClose: () => void }) {
  const editor = props.editor;
  const [color, setColor] = createSignal(makeRGBA({ r: 0, g: 0, b: 0 }));
  const [aspect, setAspect] = createSignal<MatteAspect>("Project");
  const [creating, setCreating] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const dims = () => matteAspectPixelSize(aspect(), editor.timeline.width, editor.timeline.height);

  const create = async () => {
    setError(null);
    setCreating(true);
    try {
      await createMatte(editor, {
        hex: hexText(color(), false),
        aspect: aspect(),
        ...(editor.ui.mediaPanelCurrentFolderId !== null ? { folderId: editor.ui.mediaPanelCurrentFolderId } : {}),
      });
      props.onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  };

  onMount(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      props.onClose();
    };
    document.addEventListener("keydown", key, true);
    onCleanup(() => document.removeEventListener("keydown", key, true));
  });

  return (
    <Portal>
      <div class="dialog-scrim" onPointerDown={(e) => e.target === e.currentTarget && props.onClose()}>
        <div class="dialog matte-sheet" role="dialog" aria-modal="true" aria-label="Create Matte">
          <div class="matte-row">
            <span class="matte-label">Color</span>
            <div class="matte-control"><ColorField color={color()} onChange={setColor} supportsOpacity={false} label="Matte color" /></div>
          </div>
          <div class="matte-row">
            <span class="matte-label">Aspect</span>
            <div class="matte-control">
              <DropdownMenuButton
                class="matte-picker"
                items={() => matteAspects.map((a) => ({ kind: "item" as const, label: a, checked: aspect() === a, onSelect: () => setAspect(a) }))}
              >
                {aspect()}
              </DropdownMenuButton>
            </div>
          </div>
          <div class="matte-row">
            <span class="matte-label">Size</span>
            <span class="matte-control matte-size">{dims().width} × {dims().height}</span>
          </div>
          <Show when={error()}>{(message) => <div class="matte-error">{message()}</div>}</Show>
          <button type="button" class="matte-create" disabled={creating()} onClick={() => void create()}>
            {creating() ? "Creating…" : "Create Matte"}
          </button>
        </div>
      </div>
    </Portal>
  );
}
