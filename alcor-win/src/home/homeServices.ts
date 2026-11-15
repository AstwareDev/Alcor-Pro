import { convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { Project } from "../model";
import { createSampleDeps, openableSamplePath, sampleProjectList, type SampleSummary } from "../onboarding/sampleProjects";
import { appPaths } from "../platform/backend";
import { backendFileSystem } from "../project/fileSystem";
import { basename, joinPath, nativePath } from "../project/projectPaths";
import { sharedProjectRegistry, type ProjectRegistry } from "../project/projectRegistry";
import { thumbnailCacheBuster } from "../project/projectThumbnail";
import { isProjectOpen, newProject } from "../project/projectSession";

/** Everything the Home screen needs from the outside world; the dev page substitutes fakes. */
export interface HomeServices {
  registry: ProjectRegistry;
  /** Creates and saves "Untitled Project" (or the next free name); resolves with its path. */
  createProject(): Promise<string>;
  /** Folder picker; `null` when cancelled. Rejects when the choice is not a project. */
  chooseProject(): Promise<string | null>;
  revealInExplorer(path: string): Promise<void>;
  isOpen(path: string): boolean;
  thumbnailSrc(projectPath: string): string | undefined;
  /** Sample projects offered on Home and by onboarding; none by default (see `sampleProjectList`). */
  samples: {
    list: readonly SampleSummary[];
    /** Downloads the sample if it is not cached yet and resolves with its package path. */
    prepare(sample: SampleSummary, onProgress: (fraction: number) => void): Promise<string>;
  };
}

export async function createHomeServices(): Promise<HomeServices> {
  const registry = await sharedProjectRegistry();
  return {
    registry,
    async createProject() {
      const editor = await newProject();
      if (editor.projectPath === null) throw new Error("New project has no path.");
      return editor.projectPath;
    },
    async chooseProject() {
      const picked = await open({
        directory: true,
        multiple: false,
        title: "Open Project",
        defaultPath: nativePath((await appPaths()).projects),
      });
      if (picked === null) return null;
      const isPackage =
        basename(picked).toLowerCase().endsWith(`.${Project.fileExtension}`) ||
        (await backendFileSystem.exists(joinPath(picked, Project.timelineFilename)));
      if (!isPackage) throw new Error(`Choose a .${Project.fileExtension} project folder.`);
      return picked;
    },
    revealInExplorer: (path) => revealItemInDir(nativePath(path)),
    isOpen: isProjectOpen,
    samples: {
      list: sampleProjectList,
      prepare: async (sample, onProgress) => openableSamplePath(await createSampleDeps(), sample, onProgress),
    },
    thumbnailSrc: (projectPath) =>
      `${convertFileSrc(nativePath(joinPath(projectPath, Project.thumbnailFilename)))}?v=${thumbnailCacheBuster(projectPath)}`,
  };
}
