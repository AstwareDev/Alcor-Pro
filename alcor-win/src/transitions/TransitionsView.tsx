import { For } from "solid-js";
import { transitionKindLabels, transitionKinds, type TransitionKind } from "../model";
import type { Editor } from "../editor/editor";
import { addTransitionNearPlayhead, updateTransition } from "../editor/mutations/transitions";
import { armMediaDrag } from "../mediapanel/dragSession";
import { transitionDragString } from "./timelineTransitions";

/** Applies `kind` to the selected transition, or adds it at the cut nearest the playhead. */
export function applyTransitionKind(editor: Editor, kind: TransitionKind): void {
  const id = editor.ui.selectedTransitionId;
  const result = id !== null ? updateTransition(editor, id, { kind }) : addTransitionNearPlayhead(editor, { kind });
  if (!result.ok) editor.refuseWithToast(result.reason);
}

/** Library "Transitions" section: click to apply, drag onto a cut. */
export function TransitionsView(props: { editor: Editor }) {
  return (
    <div class="lib-grid-scroll">
      <div class="lib-grid">
        <For each={transitionKinds}>
          {(kind) => (
            <div
              class="lib-tile"
              role="button"
              tabIndex={0}
              title={`${transitionKindLabels[kind]}: click to apply near the playhead, or drag onto a cut`}
              onPointerDown={(e) => armMediaDrag(e, () => ({ payload: transitionDragString(kind), label: transitionKindLabels[kind], count: 1 }))}
              onClick={() => applyTransitionKind(props.editor, kind)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  applyTransitionKind(props.editor, kind);
                }
              }}
            >
              <div class="lib-art text"><span>{transitionKindLabels[kind]}</span></div>
              <span class="lib-name">{transitionKindLabels[kind]}</span>
            </div>
          )}
        </For>
      </div>
    </div>
  );
}
