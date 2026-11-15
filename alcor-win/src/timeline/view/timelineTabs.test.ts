import { describe, expect, it } from "vitest";
import { makeEditor } from "../../editor/mutations/testFixtures";
import { createTimeline } from "../../editor/mutations/timelines";
import {
  closeAllTimelineTabs,
  closeTimelineTab,
  isTimelineTabBarExpanded,
  openAllTimelineTabs,
  selectAdjacentOpenTimeline,
  toggleTimelineTabBarExpanded,
} from "./timelineTabs";

// Ports of the tab parts of MultiTimelineTests.
describe("Multi-timeline - tabs", () => {
  it("closeTabNeverClosesLastAndReactivatesNeighbor", () => {
    const e = makeEditor();
    const firstId = e.doc.activeTimelineId;
    const secondId = createTimeline(e);
    closeTimelineTab(e, secondId);
    expect(e.doc.openTimelineIds).toEqual([firstId]);
    expect(e.doc.activeTimelineId).toBe(firstId);
    expect(e.doc.timelines.some((t) => t.id === secondId)).toBe(true);
    closeTimelineTab(e, firstId);
    expect(e.doc.openTimelineIds).toEqual([firstId]);
  });

  it("closeAllTimelineTabsKeepsTheActiveTab", () => {
    const e = makeEditor();
    const firstId = e.doc.activeTimelineId;
    createTimeline(e);
    const thirdId = createTimeline(e);
    closeAllTimelineTabs(e);
    expect(e.doc.openTimelineIds).toEqual([thirdId]);
    expect(e.doc.activeTimelineId).toBe(thirdId);
    expect(e.doc.timelines.some((t) => t.id === firstId)).toBe(true);
  });

  it("selectAdjacentOpenTimelineWrapsAndRevealsTabs", () => {
    const e = makeEditor();
    expect(selectAdjacentOpenTimeline(e, 1)).toBe(false);
    const firstId = e.doc.activeTimelineId;
    const secondId = createTimeline(e);
    toggleTimelineTabBarExpanded(e);
    expect(isTimelineTabBarExpanded(e)).toBe(false);
    expect(selectAdjacentOpenTimeline(e, -1)).toBe(true);
    expect(e.doc.activeTimelineId).toBe(firstId);
    expect(isTimelineTabBarExpanded(e)).toBe(true);
    expect(selectAdjacentOpenTimeline(e, 1)).toBe(true);
    expect(e.doc.activeTimelineId).toBe(secondId);
    expect(selectAdjacentOpenTimeline(e, 1)).toBe(true);
    expect(e.doc.activeTimelineId).toBe(firstId);
  });

  it("openAllTimelineTabsAppendsClosedTimelines", () => {
    const e = makeEditor();
    const firstId = e.doc.activeTimelineId;
    const secondId = createTimeline(e);
    closeTimelineTab(e, secondId);
    openAllTimelineTabs(e);
    expect(e.doc.openTimelineIds).toEqual([firstId, secondId]);
    expect(e.doc.activeTimelineId).toBe(firstId);
    openAllTimelineTabs(e);
    expect(e.doc.openTimelineIds).toEqual([firstId, secondId]);
  });

  it("tabOperationsCreateNoUndoEntries", () => {
    const e = makeEditor();
    const secondId = createTimeline(e);
    while (e.store.canUndo) e.undo();
    e.redo();
    const name = e.store.undoActionName;
    closeTimelineTab(e, secondId);
    openAllTimelineTabs(e);
    expect(e.store.undoActionName).toBe(name);
  });
});
