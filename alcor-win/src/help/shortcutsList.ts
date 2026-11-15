import { shortcutTable, type KeyCombo, type ShortcutCommand } from "../timeline/view/shortcuts";

export interface ShortcutRow {
  keys: string;
  label: string;
}
export interface ShortcutGroup {
  title: string;
  rows: ShortcutRow[];
}

/** Display group and label of every timeline shortcut command; the keys come from the live `shortcutTable`. */
const commands: Record<ShortcutCommand, { group: string; label: string }> = {
  togglePlayback: { group: "Playback", label: "Play / Pause" },
  stepBackward: { group: "Playback", label: "Step Backward" },
  stepForward: { group: "Playback", label: "Step Forward" },
  skipBackward: { group: "Playback", label: "Skip Backward" },
  skipForward: { group: "Playback", label: "Skip Forward" },
  toolPointer: { group: "Tools", label: "Selection Tool" },
  toolRazor: { group: "Tools", label: "Razor Tool" },
  toolTrim: { group: "Tools", label: "Trim Tool" },
  selectForwardOnTrack: { group: "Editing", label: "Select Forward on Track" },
  selectForwardOnAllTracks: { group: "Editing", label: "Select Forward on All Tracks" },
  splitAtPlayhead: { group: "Editing", label: "Split at Playhead" },
  trimStartToPlayhead: { group: "Editing", label: "Trim Start to Playhead" },
  trimEndToPlayhead: { group: "Editing", label: "Trim End to Playhead" },
  delete: { group: "Editing", label: "Delete" },
  rippleDelete: { group: "Editing", label: "Ripple Delete" },
  addTransition: { group: "Editing", label: "Add Transition at Playhead" },
  easyEase: { group: "Editing", label: "Easy Ease Selected Keyframes" },
  addMarker: { group: "Timeline", label: "Add Marker" },
  markIn: { group: "Timeline", label: "Mark Range Start" },
  markOut: { group: "Timeline", label: "Mark Range End" },
  nextTimelineTab: { group: "Timeline", label: "Next Timeline Tab" },
  previousTimelineTab: { group: "Timeline", label: "Previous Timeline Tab" },
  zoomIn: { group: "Timeline", label: "Zoom In" },
  zoomOut: { group: "Timeline", label: "Zoom Out" },
  zoomToFit: { group: "Timeline", label: "Zoom to Fit" },
  undo: { group: "Edit", label: "Undo" },
  redo: { group: "Edit", label: "Redo" },
  cut: { group: "Edit", label: "Cut" },
  copy: { group: "Edit", label: "Copy" },
  paste: { group: "Edit", label: "Paste" },
  selectAll: { group: "Edit", label: "Select All" },
  escape: { group: "View", label: "Deselect & Reset Tool" },
};

const codeNames: Record<string, string> = {
  ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓", Space: "Space", Tab: "Tab", Escape: "Esc",
  Backspace: "Backspace", Delete: "Delete", BracketLeft: "[", BracketRight: "]", Equal: "=", Minus: "-", Backquote: "`",
};

export function formatCombo(combo: KeyCombo): string {
  const key = codeNames[combo.code] ?? combo.code.replace(/^Key/, "").replace(/^Digit/, "");
  return [combo.ctrl ? "Ctrl" : "", combo.alt ? "Alt" : "", combo.shift ? "Shift" : "", key].filter(Boolean).join(" + ");
}

/** Shortcuts that live outside the timeline table (App, preview, prompt bar, media panel). Keep in sync with those handlers. */
const extras: Record<string, ShortcutRow[]> = {
  Playback: [
    { keys: "J / K / L", label: "Reverse / Pause / Forward (preview focused)" },
    { keys: "Home / End", label: "Go to Start / End (preview focused)" },
  ],
  File: [
    { keys: "Ctrl + S", label: "Save" },
    { keys: "Ctrl + E", label: "Export" },
  ],
  View: [
    { keys: "Ctrl + Scroll", label: "Zoom Preview to Cursor" },
    { keys: "Ctrl + ,", label: "Settings" },
    { keys: "/", label: "Focus Prompt Bar" },
    { keys: "?", label: "Keyboard Shortcuts" },
  ],
  "Media Panel": [
    { keys: "F2", label: "Rename" },
    { keys: "Delete", label: "Delete" },
    { keys: "Backspace", label: "Up One Folder" },
    { keys: "Ctrl + A", label: "Select All" },
  ],
};

const groupOrder = ["Playback", "Tools", "Editing", "Timeline", "Edit", "File", "View", "Media Panel"];

export function shortcutGroups(table = shortcutTable): ShortcutGroup[] {
  const keysByCommand = new Map<ShortcutCommand, string[]>();
  for (const b of table) {
    if (b.combo.code.startsWith("Numpad")) continue;
    const list = keysByCommand.get(b.command) ?? [];
    const keys = formatCombo(b.combo);
    if (!list.includes(keys)) list.push(keys);
    keysByCommand.set(b.command, list);
  }
  const groups = new Map<string, ShortcutRow[]>();
  for (const [command, keys] of keysByCommand) {
    const info = commands[command];
    const rows = groups.get(info.group) ?? [];
    rows.push({ keys: keys.join(" or "), label: info.label });
    groups.set(info.group, rows);
  }
  for (const [group, rows] of Object.entries(extras)) groups.set(group, [...(groups.get(group) ?? []), ...rows]);
  return groupOrder.filter((g) => groups.has(g)).map((title) => ({ title, rows: groups.get(title) ?? [] }));
}
