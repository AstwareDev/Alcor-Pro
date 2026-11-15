import type { Editor } from "../../editor/editor";
import type { TextMeasurer } from "../../model";
import { closeProject, newProject, openProject } from "../../project/projectSession";
import { projectEntryName, sharedProjectRegistry, type ProjectRegistry } from "../../project/projectRegistry";

/** One registered project as `manage_project action='list'` reports it. */
export interface AgentHostProjectEntry {
  id: string;
  name: string;
  path: string;
  isAccessible: boolean;
}

/**
 * Everything the agent tools need from the application shell. App.tsx implements it (see
 * `projectSessionAgentHost`); tests supply fakes. The Windows workspace shows one project at a time, so the editor
 * the agent edits is always the one the user sees.
 */
export interface AgentHost {
  /** The editor of the project open in the workspace, or null on the home screen. */
  currentEditor(): Editor | null;
  /** Fires when `currentEditor()` changes so the MCP bridge can re-announce its tool list. */
  onCurrentEditorChange?(listener: () => void): () => void;
  /** Registered projects, most recently opened first. */
  listProjects(): Promise<AgentHostProjectEntry[]>;
  /** Opens (or returns the already-open) project and makes it the workspace project. */
  openProject(path: string): Promise<Editor>;
  /** Creates a project (default name when undefined) and makes it the workspace project. */
  createProject(name: string | undefined): Promise<Editor>;
  /** Saves and closes `editor`; rejects (leaving it open) when the save fails. */
  closeProject(editor: Editor): Promise<void>;
  /** Display name of the project, as the title bar shows it. */
  displayName(editor: Editor): string;
  /** Text measurement for text-clip layout; defaults to the canvas measurer. */
  measureText?: TextMeasurer;
  /** Renders the composited timeline frame as base64 JPEG (inspect_timeline); null when it can't be drawn. */
  renderTimelineFrame?(editor: Editor, frame: number, longestEdge: number): Promise<string | null>;
}

export interface ProjectSessionHostOptions {
  getEditor: () => Editor | null;
  setEditor: (editor: Editor | null) => void;
  displayName: (editor: Editor) => string;
  onCurrentEditorChange?: (listener: () => void) => () => void;
  registry?: () => Promise<ProjectRegistry>;
  measureText?: TextMeasurer;
  renderTimelineFrame?: AgentHost["renderTimelineFrame"];
}

/** Default `AgentHost` over `projectSession.ts` and the shared project registry. */
export function projectSessionAgentHost(options: ProjectSessionHostOptions): AgentHost {
  const registry = options.registry ?? sharedProjectRegistry;
  const host: AgentHost = {
    currentEditor: options.getEditor,
    async listProjects() {
      const reg = await registry();
      return Promise.all(
        reg.sortedEntries().map(async (entry) => ({
          id: entry.id,
          name: projectEntryName(entry),
          path: entry.path,
          isAccessible: await reg.isAccessible(entry),
        })),
      );
    },
    async openProject(path) {
      const editor = await openProject(path);
      options.setEditor(editor);
      return editor;
    },
    async createProject(name) {
      const editor = await newProject(name);
      options.setEditor(editor);
      return editor;
    },
    async closeProject(editor) {
      await closeProject(editor);
      if (options.getEditor() === editor) options.setEditor(null);
    },
    displayName: options.displayName,
  };
  if (options.onCurrentEditorChange) host.onCurrentEditorChange = options.onCurrentEditorChange;
  if (options.measureText) host.measureText = options.measureText;
  if (options.renderTimelineFrame) host.renderTimelineFrame = options.renderTimelineFrame;
  return host;
}
