// Port of GenerationService.swift: placeholders, multi-output, reference preparation, job execution against the
// provider contract, download & finalize, retry download and resuming pending generations on project open.
// Not ported: enhanceDraft (a Palmier-backend feature the provider contract has no equivalent for).
import { joinPath, makeMediaAsset, mediaAssetIsRecoveringGeneration, swiftDateNow, type ClipType, type GenerationInput, type GenerationStatus, type MediaAsset } from "../model";
import type { Editor } from "../editor/editor";
import { clipTypeFromFileExtension } from "../model";
import { httpDownload } from "../platform/backend";
import { finalizeImportedAsset } from "../media/library";
import { commitStagedProjectMedia, importMediaAsset } from "../media/mediaLibrary";
import { updateManifestMetadata } from "../media/libraryCore";
import { folder } from "../media/folders";
import { mediaIo } from "../media/io";
import { lastPathComponent, pathExtension } from "../media/paths";
import { newId } from "../util/id";
import { generationHooks, setGenerationProgress } from "./generationState";
import { getJobRunner, parseJobHandle, serializeJobHandle, type JobRunner } from "./jobRunner";
import { realPreprocessOps } from "./preprocessing/realOps";
import type { GenerationPlan } from "./submission";
import { prepareReferences, type PreprocessOps } from "./referencePreparation";
import { catalogEntry } from "./providers/registry";
import type { CatalogEntry, GenerationParams, JobHandle, JobOutput, JobState } from "./providers/types";

/** Everything the service needs from the outside world; tests and the dev page substitute these. */
export interface GenerationDeps {
  jobs: () => JobRunner;
  ops: PreprocessOps;
  /** Makes a job output a local staged file: downloads remote URLs, passes local paths through. */
  fetchOutput: (source: string, extension: string, onProgress: (fraction: number | undefined) => void) => Promise<string>;
  commitStaged: (editor: Editor, stagedPath: string, filename: string) => Promise<string>;
  finalize: (editor: Editor, assetId: string) => Promise<boolean>;
  /** Synchronous: used only for the placeholder's provisional path when no project is open. */
  tempDirHint: () => string;
}

export interface GenerationCallbacks {
  onComplete?: (asset: MediaAsset) => void;
  onFailure?: () => void;
}

const remoteScheme = /^(https?|blob|data):/i;
let tempDirCache = "";

function outputExtension(source: string): string {
  const withoutQuery = source.split(/[?#]/)[0] ?? source;
  return remoteScheme.test(source) ? pathExtension(withoutQuery.replace(/^[a-z]+:\/\/[^/]*/i, "")).toLowerCase() : pathExtension(source).toLowerCase();
}

export function makeDefaultDeps(ops: PreprocessOps): GenerationDeps {
  void mediaIo().then((io) => io.tempDir()).then((dir) => { tempDirCache = dir; }, () => undefined);
  return {
    jobs: getJobRunner,
    ops,
    async fetchOutput(source, extension, onProgress) {
      if (!remoteScheme.test(source)) return source;
      const io = await mediaIo();
      const dir = await io.tempDir();
      await io.mkdir(dir);
      const dest = joinPath(dir, `gen-download-${newId()}.${extension === "" ? "bin" : extension}`);
      await httpDownload({ url: source }, dest, (p) => onProgress(p.total ? p.received / p.total : undefined));
      return dest;
    },
    commitStaged: (editor, staged, filename) => commitStagedProjectMedia(editor, staged, filename),
    finalize: (editor, id) => finalizeImportedAsset(editor, id),
    tempDirHint: () => tempDirCache,
  };
}

function outputString(output: JobOutput): string {
  return "url" in output ? output.url : output.path;
}

export function createGenerationService(deps: GenerationDeps) {
  const resumedJobIds = new Set<string>();

  function patchAsset(editor: Editor, id: string, patch: (asset: MediaAsset) => void): void {
    editor.withoutRegistration(() => {
      const asset = editor.doc.mediaAssets.find((a) => a.id === id);
      if (asset) patch(asset);
    });
    const updated = editor.mediaAsset(id);
    if (updated) updateManifestMetadata(editor, [updated]);
  }

  function setStatus(editor: Editor, id: string, status: GenerationStatus, mutateInput?: (input: GenerationInput) => void): void {
    patchAsset(editor, id, (asset) => {
      asset.generationStatus = status;
      if (mutateInput && asset.generationInput) mutateInput(asset.generationInput);
    });
    if (status.kind === "none" || status.kind === "failed" || status.kind === "downloading") setGenerationProgress(id, undefined);
  }

  function checkpoint(editor: Editor): void {
    generationHooks.checkpointRequired?.(editor);
  }

  function failAll(editor: Editor, ids: readonly string[], message: string, mutateInput?: (input: GenerationInput) => void): void {
    for (const id of ids) setStatus(editor, id, { kind: "failed", message }, mutateInput);
  }

  function createPlaceholder(
    editor: Editor,
    p: { type: ClipType; name: string; duration: number; genInput: GenerationInput; folderId: string | undefined; destDir: string; fileExtension: string },
  ): string {
    const id = newId();
    const placeholder = makeMediaAsset({
      id,
      url: joinPath(p.destDir === "" ? "." : p.destDir, `gen-${id.slice(0, 8)}.${p.fileExtension}`),
      type: p.type,
      name: p.name,
      duration: p.duration,
      generationInput: structuredClone(p.genInput),
    });
    placeholder.generationStatus = { kind: "preparing" };
    if (p.folderId !== undefined) placeholder.folderId = p.folderId;
    importMediaAsset(editor, placeholder);
    return id;
  }

  /** Returns the primary placeholder's asset id. Everything after the placeholders exist runs in the background. */
  function generate(editor: Editor, plan: GenerationPlan, callbacks: GenerationCallbacks = {}): string {
    const count = Math.max(1, Math.min(4, plan.numImages));
    const baseName = plan.name ?? Array.from(plan.genInput.prompt).slice(0, 30).join("");
    const folderId = plan.folderId !== undefined && folder(editor, plan.folderId) ? plan.folderId : undefined;
    const destDir = editor.projectPath !== null ? joinPath(editor.projectPath, "media") : deps.tempDirHint();
    const ids: string[] = [];
    for (let outputIndex = 0; outputIndex < count; outputIndex++) {
      ids.push(createPlaceholder(editor, {
        type: plan.assetType,
        name: baseName,
        duration: plan.placeholderDuration,
        genInput: { ...plan.genInput, outputIndex },
        folderId,
        destDir,
        fileExtension: plan.fileExtension,
      }));
    }

    void (async () => {
      let tempFiles: string[] = [];
      try {
        const prepared = await prepareReferences(plan.references, plan.trimmedSourceOverride, plan, deps.ops);
        tempFiles = prepared.tempFiles;
        const final: GenerationInput = structuredClone(plan.genInput);
        const sourcePaths = plan.references.map((r) => r.url);
        if (plan.snapshotRefs) plan.snapshotRefs(final, sourcePaths);
        else if (sourcePaths.length === 0) delete final.imageURLs;
        else final.imageURLs = sourcePaths;
        if (final.createdAt === undefined) final.createdAt = swiftDateNow();
        ids.forEach((id, outputIndex) => patchAsset(editor, id, (a) => { a.generationInput = { ...structuredClone(final), outputIndex }; }));

        const entry = catalogEntry(final.model);
        if (!entry) {
          failAll(editor, ids, "Model no longer available");
          callbacks.onFailure?.();
          return;
        }
        await runJob(editor, ids, entry, plan.buildParams(prepared.refs), callbacks);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        failAll(editor, ids, `Preparing references failed: ${message}`);
        callbacks.onFailure?.();
      } finally {
        await deps.ops.removeTempFiles(tempFiles).catch(() => undefined);
      }
    })();
    return ids[0];
  }

  async function runJob(editor: Editor, ids: readonly string[], entry: CatalogEntry, params: GenerationParams, callbacks: GenerationCallbacks): Promise<void> {
    let handle: JobHandle;
    try {
      handle = await deps.jobs().submit(entry, params);
    } catch (e) {
      failAll(editor, ids, e instanceof Error ? e.message : String(e));
      callbacks.onFailure?.();
      return;
    }
    const jobId = serializeJobHandle(handle);
    for (const id of ids) setStatus(editor, id, { kind: "generating" }, (input) => { input.backendJobId = jobId; });
    checkpoint(editor);
    await monitorJob(editor, handle, ids, true, callbacks);
  }

  async function monitorJob(editor: Editor, handle: JobHandle, ids: readonly string[], failIfUnavailable: boolean, callbacks: GenerationCallbacks): Promise<void> {
    const jobId = serializeJobHandle(handle);
    let terminal: JobState;
    try {
      terminal = await deps.jobs().watch(handle, (state) => applyProgress(editor, jobId, ids, state));
    } catch (e) {
      // Stream ended without a terminal update: finish from persisted URLs, else retry on reopen.
      const persisted = editor.mediaAsset(ids[0])?.generationInput?.resultURLs ?? [];
      if (persisted.length > 0) {
        await finalizeSuccess(editor, persisted, ids, callbacks);
      } else if (failIfUnavailable) {
        failAll(editor, ids, e instanceof Error ? e.message : String(e), (input) => { input.backendJobId = jobId; });
        checkpoint(editor);
        callbacks.onFailure?.();
      }
      return;
    }
    if (terminal.status === "succeeded") {
      await finalizeSuccess(editor, terminal.outputs.map(outputString), ids, callbacks);
    } else if (terminal.status === "failed") {
      failAll(editor, ids, terminal.errorMessage === "" ? "Generation failed" : terminal.errorMessage, (input) => { input.backendJobId = jobId; });
      checkpoint(editor);
      callbacks.onFailure?.();
    }
  }

  function applyProgress(editor: Editor, jobId: string, ids: readonly string[], state: JobState): void {
    if (state.status !== "queued" && state.status !== "running") return;
    let changed = false;
    for (const id of ids) {
      const asset = editor.mediaAsset(id);
      if (!asset || asset.generationStatus.kind === "downloading") continue;
      if (asset.generationStatus.kind !== "generating" || asset.generationInput?.backendJobId !== jobId) {
        setStatus(editor, id, { kind: "generating" }, (input) => { input.backendJobId = jobId; });
        changed = true;
      }
      setGenerationProgress(id, state.progress);
    }
    if (changed) checkpoint(editor);
  }

  async function finalizeSuccess(editor: Editor, sources: readonly string[], ids: readonly string[], callbacks: GenerationCallbacks): Promise<void> {
    if (sources.length === 0) {
      failAll(editor, ids, "No URL in response");
      callbacks.onFailure?.();
      return;
    }
    const finalized: MediaAsset[] = [];
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const outputIndex = editor.mediaAsset(id)?.generationInput?.outputIndex ?? i;
      if (outputIndex >= sources.length) {
        setStatus(editor, id, { kind: "failed", message: "No URL for placeholder" });
        continue;
      }
      setStatus(editor, id, { kind: "downloading" }, (input) => { input.resultURLs = [...sources]; });
      if (await downloadAndFinalize(editor, id, sources[outputIndex])) {
        const asset = editor.mediaAsset(id);
        if (asset) {
          callbacks.onComplete?.(asset);
          finalized.push(asset);
        }
      }
    }
    if (finalized.length > 0) generationHooks.generationComplete?.(editor, finalized[0], finalized.length);
    else callbacks.onFailure?.();
  }

  async function downloadAndFinalize(editor: Editor, id: string, source: string): Promise<boolean> {
    const start = editor.mediaAsset(id);
    if (!start) return false;
    if (start.generationStatus.kind !== "downloading") setStatus(editor, id, { kind: "downloading" });
    try {
      const realExt = outputExtension(source);
      let filename = lastPathComponent(start.url);
      const currentExt = pathExtension(filename).toLowerCase();
      if (realExt !== "" && realExt !== currentExt && clipTypeFromFileExtension(realExt) !== undefined) {
        filename = `${filename.slice(0, filename.length - (currentExt === "" ? 0 : currentExt.length + 1))}.${realExt}`;
      }
      const staged = await deps.fetchOutput(source, realExt === "" ? currentExt : realExt, (f) => setGenerationProgress(id, f));
      const destination = await deps.commitStaged(editor, staged, filename);
      patchAsset(editor, id, (a) => {
        a.url = destination;
        delete a.pendingDownloadURL;
      });
      return await deps.finalize(editor, id);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      patchAsset(editor, id, (a) => { a.pendingDownloadURL = source; });
      setStatus(editor, id, { kind: "failed", message });
      return false;
    }
  }

  function retryDownload(editor: Editor, assetId: string): void {
    const source = editor.mediaAsset(assetId)?.pendingDownloadURL;
    if (source === undefined) return;
    void downloadAndFinalize(editor, assetId, source);
  }

  /** Re-attaches to jobs that were running when the project was closed (also recovers failed downloads with result URLs). */
  function resumePendingGenerations(editor: Editor): void {
    const groups = new Map<string, MediaAsset[]>();
    for (const asset of editor.mediaAssets) {
      const jobId = asset.generationInput?.backendJobId;
      if (!mediaAssetIsRecoveringGeneration(asset) || !jobId) continue;
      const group = groups.get(jobId);
      if (group) group.push(asset);
      else groups.set(jobId, [asset]);
    }
    for (const [jobId, group] of groups) {
      if (resumedJobIds.has(jobId)) continue;
      const handle = parseJobHandle(jobId);
      if (!handle) continue;
      const ids = group
        .sort((a, b) => (a.generationInput?.outputIndex ?? 0) - (b.generationInput?.outputIndex ?? 0))
        .map((a) => a.id);
      resumedJobIds.add(jobId);
      void monitorJob(editor, handle, ids, false, {}).finally(() => resumedJobIds.delete(jobId));
    }
  }

  return { generate, retryDownload, resumePendingGenerations };
}

export type GenerationService = ReturnType<typeof createGenerationService>;

let service: GenerationService | undefined;

export function setGenerationService(next: GenerationService | undefined): void {
  service = next;
}

/** The app-wide service; created on first use with the WebCodecs preprocessors and Tauri I/O. */
export function getGenerationService(): GenerationService {
  service ??= createGenerationService(makeDefaultDeps(realPreprocessOps));
  return service;
}
