import Blend from "lucide-solid/icons/blend";
import { createMemo, Show, type JSX } from "solid-js";
import { transitionAlignmentLabels, transitionAlignments, transitionKindLabels, transitionKinds } from "../model";
import type { Gesture } from "../editor/document";
import type { Editor } from "../editor/editor";
import { findTransition, removeTransition, updateTransition } from "../editor/mutations/transitions";
import { CapsuleButton } from "../ui/CapsuleButton";
import { DropdownMenuButton } from "../ui/DropdownMenuButton";
import { EditorMenuValue, EditorPanelGroup, InspectorRow } from "../ui/EditorPanel";
import type { MenuItem } from "../ui/Menu";
import { ScrubbableNumberField } from "../ui/ScrubbableNumberField";
import { swiftRound } from "../util/math";
import { transitionMaxFrames } from "../transitions/transitionMath";

/** Inspector for the selected timeline transition: type, alignment, duration, remove. Shows `fallback` when none is selected. */
export function TransitionSection(props: { editor: Editor; fallback: JSX.Element }) {
  const { editor } = props;
  const found = createMemo(() => {
    const id = editor.ui.selectedTransitionId;
    return id === null ? undefined : findTransition(editor, id);
  });
  return (
    <Show when={found()} fallback={props.fallback}>
      {(f) => <TransitionFields editor={editor} id={f().transition.id} />}
    </Show>
  );
}

function TransitionFields(props: { editor: Editor; id: string }) {
  const { editor } = props;
  const transition = createMemo(() => findTransition(editor, props.id)?.transition);
  const fps = (): number => Math.max(1, editor.timeline.fps);
  const maxFrames = (): number => {
    const loc = findTransition(editor, props.id);
    const track = loc ? editor.timeline.tracks[loc.trackIndex] : undefined;
    const from = track?.clips.find((c) => c.id === loc?.transition.fromClipId);
    const to = track?.clips.find((c) => c.id === loc?.transition.toClipId);
    return loc && from && to ? Math.max(1, transitionMaxFrames(loc.transition.alignment, from.durationFrames, to.durationFrames)) : 1;
  };
  let gesture: Gesture | undefined;
  const endGesture = (): void => {
    gesture?.commit();
    gesture = undefined;
  };
  const setDuration = (seconds: number): void => {
    updateTransition(editor, props.id, { durationFrames: Math.max(1, swiftRound(seconds * fps())) });
  };
  const kindItems = (): MenuItem[] =>
    transitionKinds.map((kind) => ({
      kind: "item", label: transitionKindLabels[kind], checked: transition()?.kind === kind,
      onSelect: () => updateTransition(editor, props.id, { kind }),
    }));
  const alignmentItems = (): MenuItem[] =>
    transitionAlignments.map((alignment) => ({
      kind: "item", label: transitionAlignmentLabels[alignment], checked: transition()?.alignment === alignment,
      onSelect: () => updateTransition(editor, props.id, { alignment }),
    }));
  return (
    <Show when={transition()}>
      {(t) => (
        <>
          <div class="panel-header inspector-header">
            <span class="inspector-header-icon"><Blend size={13} /></span>
            <span class="inspector-header-title">Transition</span>
          </div>
          <div class="inspector-scroll">
            <EditorPanelGroup title="Transition" gap="var(--sp-sm)">
              <div class="metadata-row">
                <span class="metadata-label">Type</span>
                <DropdownMenuButton items={kindItems}>
                  <EditorMenuValue text={transitionKindLabels[t().kind]} />
                </DropdownMenuButton>
              </div>
              <div class="metadata-row">
                <span class="metadata-label">Alignment</span>
                <DropdownMenuButton items={alignmentItems}>
                  <EditorMenuValue text={transitionAlignmentLabels[t().alignment]} />
                </DropdownMenuButton>
              </div>
              <InspectorRow label="Duration" fixedHeight>
                <ScrubbableNumberField
                  value={t().durationFrames / fps()}
                  range={{ min: 1 / fps(), max: maxFrames() / fps() }}
                  format="%.2f"
                  valueSuffix=" s"
                  dragSensitivity={0.01}
                  fieldWidth="var(--numeric-field-w)"
                  onInteractionStart={() => {
                    gesture = editor.beginGesture("Change Transition Duration");
                  }}
                  onChanged={setDuration}
                  onCancel={() => {
                    gesture?.cancel();
                    gesture = undefined;
                  }}
                  onCommit={(s) => {
                    setDuration(s);
                    endGesture();
                  }}
                  onInteractionEnd={endGesture}
                />
              </InspectorRow>
              <div class="metadata-row">
                <span class="metadata-label">{t().durationFrames} frames</span>
                <CapsuleButton size="regular" onClick={() => removeTransition(editor, props.id)}>Remove</CapsuleButton>
              </div>
            </EditorPanelGroup>
          </div>
        </>
      )}
    </Show>
  );
}
