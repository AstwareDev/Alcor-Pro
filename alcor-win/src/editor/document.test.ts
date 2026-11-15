import { describe, expect, it } from "vitest";
import { DocumentStore } from "./document";

interface Doc {
  timelines: { id: string; clips: number[] }[];
  manifest: { names: string[] };
}

const make = () =>
  new DocumentStore<Doc>({
    timelines: [
      { id: "a", clips: [1] },
      { id: "b", clips: [] },
    ],
    manifest: { names: [] },
  });

describe("DocumentStore", () => {
  it("records one undo entry per perform and restores exact state", () => {
    const store = make();
    const before = store.committed;
    store.perform("Add", () => {
      store.doc.timelines[0].clips.push(2);
    });
    expect(store.doc.timelines[0].clips).toEqual([1, 2]);
    expect(store.undoActionName).toBe("Add");
    expect(store.undo()).toBe("Add");
    expect(store.committed.timelines[0]).toBe(before.timelines[0]);
    expect(store.redo()).toBe("Add");
    expect(store.doc.timelines[0].clips).toEqual([1, 2]);
  });

  it("does not record an unchanged action", () => {
    const store = make();
    const revision = store.revision;
    store.perform("Noop", () => {
      store.doc.timelines[0].clips[0] = 1;
    });
    expect(store.canUndo).toBe(false);
    expect(store.revision).toBe(revision);
  });

  it("coalesces nested performs into the outer action", () => {
    const store = make();
    store.perform("Outer", () => {
      store.doc.timelines[0].clips.push(2);
      store.perform("Inner", () => {
        store.doc.timelines[1].clips.push(9);
      });
    });
    expect(store.undoActionName).toBe("Outer");
    store.undo();
    expect(store.canUndo).toBe(false);
    expect(store.doc.timelines[1].clips).toEqual([]);
  });

  it("discards all changes when work throws", () => {
    const store = make();
    expect(() =>
      store.perform("Fail", () => {
        store.doc.timelines[0].clips.push(2);
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(store.doc.timelines[0].clips).toEqual([1]);
    expect(store.canUndo).toBe(false);
    expect(store.isPerforming).toBe(false);
  });

  it("undo keeps unregistered changes made to other slices and timelines", () => {
    const store = make();
    store.perform("Edit A", () => {
      store.doc.timelines[0].clips.push(2);
    });
    store.withoutRegistration(() => {
      store.doc.manifest.names.push("hydrated");
      store.doc.timelines[1].clips.push(7);
    });
    store.undo();
    expect(store.doc.timelines[0].clips).toEqual([1]);
    expect(store.doc.manifest.names).toEqual(["hydrated"]);
    expect(store.doc.timelines[1].clips).toEqual([7]);
  });

  it("restores timeline membership when an action adds or removes timelines", () => {
    const store = make();
    store.perform("Delete Timeline", () => {
      store.doc.timelines.splice(1, 1);
    });
    expect(store.doc.timelines.map((t) => t.id)).toEqual(["a"]);
    store.undo();
    expect(store.doc.timelines.map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("clears redo when a new action is performed", () => {
    const store = make();
    store.perform("One", () => void store.doc.timelines[0].clips.push(2));
    store.undo();
    store.perform("Two", () => void store.doc.timelines[0].clips.push(3));
    expect(store.canRedo).toBe(false);
  });

  it("gesture commits many live edits as one action", () => {
    const store = make();
    const gesture = store.beginGesture("Move Clip");
    store.perform("", () => void (store.doc.timelines[0].clips[0] = 5));
    store.perform("", () => void (store.doc.timelines[0].clips[0] = 9));
    expect(store.canUndo).toBe(false);
    gesture.commit();
    expect(store.undoActionName).toBe("Move Clip");
    store.undo();
    expect(store.doc.timelines[0].clips).toEqual([1]);
    expect(store.canUndo).toBe(false);
  });

  it("gesture cancel restores the starting state without history", () => {
    const store = make();
    const gesture = store.beginGesture("Trim");
    store.perform("", () => void (store.doc.timelines[0].clips[0] = 5));
    gesture.cancel();
    expect(store.doc.timelines[0].clips).toEqual([1]);
    expect(store.canUndo).toBe(false);
  });

  it("gesture without changes records nothing", () => {
    const store = make();
    store.beginGesture("Trim").commit();
    expect(store.canUndo).toBe(false);
  });

  it("undo and redo restore the captured context", () => {
    const store = make();
    let selection = "a";
    store.context = { capture: () => selection, restore: (value) => void (selection = value as string) };
    store.perform("Delete", () => {
      store.doc.timelines[0].clips.pop();
      selection = "none";
    });
    selection = "later";
    store.undo();
    expect(selection).toBe("a");
    store.redo();
    expect(selection).toBe("none");
  });

  it("reset replaces the document and clears history", () => {
    const store = make();
    store.perform("One", () => void store.doc.timelines[0].clips.push(2));
    store.reset({ timelines: [{ id: "z", clips: [] }], manifest: { names: [] } });
    expect(store.canUndo).toBe(false);
    expect(store.doc.timelines[0].id).toBe("z");
  });
});
