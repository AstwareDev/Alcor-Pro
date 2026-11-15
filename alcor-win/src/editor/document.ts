import { createDraft, finishDraft, type Draft } from "immer";
import { batch, createSignal, untrack } from "solid-js";

interface Identified {
  id: string;
}

/** Top-level keys are undo slices; `timelines` is additionally tracked per timeline id. */
export interface DocumentShape {
  timelines: Identified[];
}

type Slices<D> = { [K in keyof D]?: { before: D[K]; after: D[K] } };

interface UndoEntry<D> {
  actionName: string;
  slices: Slices<D>;
  /** Present when only the contents of existing timelines changed. */
  timelines?: { id: string; before: Identified; after: Identified }[];
  contextBefore: unknown;
  contextAfter: unknown;
  /** Extra non-document state restored alongside the slices (e.g. playhead after an fps change). */
  extra?: { undo: () => void; redo: () => void };
}

export interface Gesture {
  commit(): void;
  cancel(): void;
}

const historyLimit = 500;

/**
 * Owns the immutable document tree and its undo history.
 * `doc` is an Immer draft while a `perform` is running, so domain code mutates it Swift-style.
 */
export class DocumentStore<D extends DocumentShape> {
  private readonly state: ReturnType<typeof createSignal<D>>;
  private readonly revisionSignal = createSignal(0);
  private readonly historySignal = createSignal(0);
  private draft: Draft<D> | null = null;
  private gestureBase: D | null = null;
  private recordingDisabled = 0;
  private undoStack: UndoEntry<D>[] = [];
  private redoStack: UndoEntry<D>[] = [];
  onActionCommitted?: (actionName: string) => void;
  /** Non-document state (selection) captured with each action and restored by undo / redo. */
  context?: { capture: () => unknown; restore: (value: unknown) => void };

  constructor(initial: D) {
    this.state = createSignal<D>(initial);
  }

  get doc(): D {
    return (this.draft as D | null) ?? this.state[0]();
  }

  get committed(): D {
    return untrack(this.state[0]);
  }

  /** Bumps on every committed change, undo and redo. */
  get revision(): number {
    return this.revisionSignal[0]();
  }

  get isPerforming(): boolean {
    return this.draft !== null;
  }

  /** Runs synchronous `work` as one undoable action. Nested calls join the outer action. */
  perform<T>(actionName: string, work: () => T): T {
    if (this.draft) return work();
    const before = this.committed;
    const contextBefore = this.context?.capture();
    const draft = createDraft(before as object) as Draft<D>;
    this.draft = draft;
    let result: T;
    try {
      result = work();
    } catch (error) {
      this.draft = null;
      throw error;
    }
    this.draft = null;
    const after = finishDraft(draft) as D;
    if (after === before) return result;
    this.apply(after);
    if (this.recordingDisabled === 0 && this.gestureBase === null) this.record(actionName, before, after, contextBefore);
    return result;
  }

  /** Attaches non-document restore hooks to the newest undo entry; they run inside undo / redo. */
  attachToLastEntry(undo: () => void, redo: () => void): void {
    const entry = this.undoStack.at(-1);
    if (entry) entry.extra = { undo, redo };
  }

  /** Applies changes without creating an undo entry (load, background hydration). */
  withoutRegistration<T>(work: () => T): T {
    this.recordingDisabled += 1;
    try {
      return this.perform("", work);
    } finally {
      this.recordingDisabled -= 1;
    }
  }

  /** Groups every change until `commit` into one undo entry; `cancel` restores the starting state. */
  beginGesture(actionName: string): Gesture {
    if (this.gestureBase) throw new Error("gesture already active");
    const base = this.committed;
    const contextBefore = this.context?.capture();
    this.gestureBase = base;
    const end = () => {
      this.gestureBase = null;
    };
    return {
      commit: () => {
        if (this.gestureBase !== base) return;
        end();
        if (this.committed !== base) this.record(actionName, base, this.committed, contextBefore);
      },
      cancel: () => {
        if (this.gestureBase !== base) return;
        end();
        if (this.committed !== base) this.apply(base);
      },
    };
  }

  /** Replaces the whole document and clears history (open / new project). */
  reset(next: D): void {
    this.undoStack = [];
    this.redoStack = [];
    this.gestureBase = null;
    this.apply(next);
    this.historySignal[1]((n) => n + 1);
  }

  get canUndo(): boolean {
    this.historySignal[0]();
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    this.historySignal[0]();
    return this.redoStack.length > 0;
  }

  get undoActionName(): string | null {
    this.historySignal[0]();
    return this.undoStack.at(-1)?.actionName ?? null;
  }

  get redoActionName(): string | null {
    this.historySignal[0]();
    return this.redoStack.at(-1)?.actionName ?? null;
  }

  undo(): string | null {
    const entry = this.undoStack.pop();
    if (!entry) return null;
    this.redoStack.push(entry);
    this.restore(entry, "before");
    return entry.actionName;
  }

  redo(): string | null {
    const entry = this.redoStack.pop();
    if (!entry) return null;
    this.undoStack.push(entry);
    this.restore(entry, "after");
    return entry.actionName;
  }

  private apply(next: D): void {
    batch(() => {
      this.state[1](() => next);
      this.revisionSignal[1]((n) => n + 1);
    });
  }

  private record(actionName: string, before: D, after: D, contextBefore: unknown): void {
    const entry: UndoEntry<D> = {
      actionName,
      slices: {},
      contextBefore,
      contextAfter: this.context?.capture(),
    };
    for (const key of Object.keys(after) as (keyof D)[]) {
      if (before[key] === after[key]) continue;
      if (key === "timelines" && sameIds(before.timelines, after.timelines)) {
        entry.timelines = after.timelines.flatMap((t, i) =>
          t === before.timelines[i] ? [] : [{ id: t.id, before: before.timelines[i], after: t }],
        );
      } else {
        entry.slices[key] = { before: before[key], after: after[key] };
      }
    }
    this.undoStack.push(entry);
    if (this.undoStack.length > historyLimit) this.undoStack.shift();
    this.redoStack = [];
    this.historySignal[1]((n) => n + 1);
    this.onActionCommitted?.(actionName);
  }

  private restore(entry: UndoEntry<D>, side: "before" | "after"): void {
    const next = { ...this.committed };
    for (const key of Object.keys(entry.slices) as (keyof D)[]) {
      const slice = entry.slices[key];
      if (slice) next[key] = slice[side];
    }
    if (entry.timelines) {
      const byId = new Map(entry.timelines.map((t) => [t.id, t[side]]));
      next.timelines = next.timelines.map((t) => byId.get(t.id) ?? t);
    }
    batch(() => {
      this.apply(next);
      this.historySignal[1]((n) => n + 1);
      this.context?.restore(side === "before" ? entry.contextBefore : entry.contextAfter);
      if (entry.extra) (side === "before" ? entry.extra.undo : entry.extra.redo)();
    });
  }
}

function sameIds(a: Identified[], b: Identified[]): boolean {
  return a.length === b.length && a.every((t, i) => t.id === b[i].id);
}
