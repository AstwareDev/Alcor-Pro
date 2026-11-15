import Star from "lucide-solid/icons/star";
import TriangleAlert from "lucide-solid/icons/triangle-exclamation-point";
import { For, Show } from "solid-js";
import { multicamMemberUsable, type MulticamMember, type MulticamMemberKind, type MulticamSource } from "../model";
import type { Editor } from "../editor/editor";
import { multicamGroupById } from "../editor/mutations/multicamRules";
import { EditorPanelGroup } from "../ui/EditorPanel";
import { HoverTooltip } from "../ui/HoverTooltip";

const kindTitles: Record<MulticamMemberKind, string> = { angle: "Angle", mic: "Mic", both: "Both" };

/** Port of MulticamTab: one row per group member with its kind, master star and sync state. */
export function MulticamTab(props: { editor: Editor; groupId: string }) {
  const group = (): MulticamSource | undefined => multicamGroupById(props.editor, props.groupId);
  return (
    <Show when={group()}>
      {(g) => (
        <EditorPanelGroup title={g().name === "" ? "Multicam" : g().name} gap="var(--sp-sm)">
          <For each={g().members}>{(member) => <MemberRow member={member} masterMemberId={g().masterMemberId} />}</For>
        </EditorPanelGroup>
      )}
    </Show>
  );
}

function MemberRow(props: { member: MulticamMember; masterMemberId: string }) {
  const m = (): MulticamMember => props.member;
  const offset = (): string => `${m().sync.offsetSeconds >= 0 ? "+" : "-"}${Math.abs(m().sync.offsetSeconds).toFixed(2)}s`;
  const percent = (): string => (m().sync.confidence * 100).toFixed(0);
  return (
    <div class="multicam-row">
      <span class="multicam-kind" data-kind={m().kind}>{kindTitles[m().kind]}</span>
      <span class="multicam-label">{m().angleLabel}</span>
      <Show when={m().id === props.masterMemberId}>
        <HoverTooltip text="Master — defines the group's clock and transcript.">
          <Star class="multicam-master" size={10} fill="currentColor" aria-label="Master" />
        </HoverTooltip>
      </Show>
      <span class="multicam-spacer" />
      <Show
        when={multicamMemberUsable(m())}
        fallback={
          <HoverTooltip text="Not synced — unusable as an angle.">
            <TriangleAlert class="multicam-unsynced" size={10} aria-label="Not synced" />
          </HoverTooltip>
        }
      >
        <HoverTooltip text={`Starts ${m().sync.offsetSeconds.toFixed(2)}s into the group's clock; matched the master with ${percent()}% confidence.`}>
          <span class="multicam-sync">{offset()} · {percent()}%</span>
        </HoverTooltip>
      </Show>
    </div>
  );
}
