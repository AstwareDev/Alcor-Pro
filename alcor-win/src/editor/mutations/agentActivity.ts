import { createSignal, type Accessor } from "solid-js";
import type { Editor } from "../editor";

// Port of EditorViewModel+AgentActivity.swift. The timeline draws `agentActivity(editor)()` (added / mutated / read
// overlays); durations match AppTheme.Anim.agentChangeHighlightDuration / agentReadHighlightDuration.

export const agentChangeHighlightDurationMs = (1.0 + 0.3) * 1000;
export const agentReadHighlightDurationMs = (0.7 + 0.25) * 1000;

export interface AgentActivityHighlight {
  readClipIds: ReadonlySet<string>;
  addedClipIds: ReadonlySet<string>;
  mutatedClipIds: ReadonlySet<string>;
  mutatedTrackIds: ReadonlySet<string>;
  /** Half-open project-frame range being read. */
  range?: { start: number; end: number };
  isActive: boolean;
  revision: number;
}

export function makeAgentActivityHighlight(p: Partial<AgentActivityHighlight> = {}): AgentActivityHighlight {
  const out: AgentActivityHighlight = {
    readClipIds: p.readClipIds ?? new Set(),
    addedClipIds: p.addedClipIds ?? new Set(),
    mutatedClipIds: p.mutatedClipIds ?? new Set(),
    mutatedTrackIds: p.mutatedTrackIds ?? new Set(),
    isActive: p.isActive ?? false,
    revision: p.revision ?? 0,
  };
  if (p.range) out.range = p.range;
  return out;
}

export function agentActivityIsRead(a: AgentActivityHighlight): boolean {
  return a.readClipIds.size > 0 || a.range !== undefined;
}

export function agentActivityIsEmpty(a: AgentActivityHighlight): boolean {
  return !agentActivityIsRead(a) && a.addedClipIds.size === 0 && a.mutatedClipIds.size === 0 && a.mutatedTrackIds.size === 0;
}

interface ActivityState {
  signal: ReturnType<typeof createSignal<AgentActivityHighlight>>;
  clearTimer: ReturnType<typeof setTimeout> | null;
}

const states = new WeakMap<Editor, ActivityState>();

function stateFor(editor: Editor): ActivityState {
  let state = states.get(editor);
  if (!state) {
    state = { signal: createSignal(makeAgentActivityHighlight(), { equals: false }), clearTimer: null };
    states.set(editor, state);
  }
  return state;
}

/** Reactive accessor for the editor's current agent highlight. */
export function agentActivity(editor: Editor): Accessor<AgentActivityHighlight> {
  return stateFor(editor).signal[0];
}

function current(editor: Editor): AgentActivityHighlight {
  const [read] = stateFor(editor).signal;
  return read();
}

function set(editor: Editor, next: AgentActivityHighlight): void {
  stateFor(editor).signal[1](next);
}

function cancelClearTimer(state: ActivityState): void {
  if (state.clearTimer !== null) clearTimeout(state.clearTimer);
  state.clearTimer = null;
}

function scheduleClear(editor: Editor, afterMs: number): void {
  const state = stateFor(editor);
  const revision = current(editor).revision;
  cancelClearTimer(state);
  state.clearTimer = setTimeout(() => {
    state.clearTimer = null;
    if (current(editor).revision === revision) clearAgentActivity(editor);
  }, afterMs);
}

export function showAgentChanges(
  editor: Editor,
  p: { addedClipIds: ReadonlySet<string>; mutatedClipIds: ReadonlySet<string>; mutatedTrackIds?: ReadonlySet<string> },
): void {
  const mutatedTrackIds = p.mutatedTrackIds ?? new Set<string>();
  if (p.addedClipIds.size === 0 && p.mutatedClipIds.size === 0 && mutatedTrackIds.size === 0) return;
  const previous = current(editor);
  const base = agentActivityIsRead(previous) ? makeAgentActivityHighlight({ revision: previous.revision }) : previous;
  const added = new Set([...base.addedClipIds, ...p.addedClipIds]);
  const mutated = new Set([...base.mutatedClipIds, ...p.mutatedClipIds].filter((id) => !added.has(id)));
  const next = makeAgentActivityHighlight({
    ...(base.range ? { range: base.range } : {}),
    readClipIds: base.readClipIds,
    addedClipIds: added,
    mutatedClipIds: mutated,
    mutatedTrackIds: new Set([...base.mutatedTrackIds, ...mutatedTrackIds]),
    isActive: false,
    revision: previous.revision + 1,
  });
  set(editor, next);
  scheduleClear(editor, agentChangeHighlightDurationMs);
}

/** Starts a read highlight; returns its revision, or undefined when a write highlight is showing. */
export function beginAgentTimelineRead(editor: Editor, highlight: AgentActivityHighlight | undefined): number | undefined {
  if (!highlight || !agentActivityIsRead(highlight)) return undefined;
  const existing = current(editor);
  if (!(agentActivityIsEmpty(existing) || agentActivityIsRead(existing))) return undefined;
  cancelClearTimer(stateFor(editor));
  const revision = existing.revision + 1;
  set(editor, makeAgentActivityHighlight({ ...highlight, isActive: true, revision }));
  return revision;
}

export function endAgentTimelineRead(editor: Editor, revision: number, succeeded: boolean): void {
  const activity = current(editor);
  if (revision !== activity.revision || !agentActivityIsRead(activity) || !activity.isActive) return;
  if (!succeeded) {
    clearAgentActivity(editor);
    return;
  }
  set(editor, { ...activity, isActive: false, revision: activity.revision + 1 });
  scheduleClear(editor, agentReadHighlightDurationMs);
}

export function clearAgentActivity(editor: Editor): void {
  const state = stateFor(editor);
  const activity = current(editor);
  if (agentActivityIsEmpty(activity) && state.clearTimer === null) return;
  cancelClearTimer(state);
  set(editor, makeAgentActivityHighlight({ revision: activity.revision + 1 }));
}
