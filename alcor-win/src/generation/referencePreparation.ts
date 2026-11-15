// Port of GenerationService.prepareReferences / uploadReferences with the upload step removed: the result is local files
// the provider adapter makes available to the vendor.
import type { MediaAsset } from "../model";
import { contentTypeForPath, imageRequiresConversion } from "./preprocessing/conversionPlan";
import { trimmedSourceHasTrim, type TrimmedSource } from "./trimmedSource";
import type { LocalReference } from "./providers/types";

export interface PreprocessHooks {
  /** Rewrite of reference `index`; null leaves it unchanged. `currentPath` may already be a trimmed extract. */
  preprocessRef?: (index: number, asset: MediaAsset, currentPath: string) => Promise<string | null>;
  preprocessSourceVideo?: (path: string) => Promise<string | null>;
}

/** Heavy operations, injectable so tests (and the dev page) run without WebCodecs. */
export interface PreprocessOps {
  extractTrim(trim: TrimmedSource): Promise<string>;
  convertImageToJPEG(path: string): Promise<string>;
  removeTempFiles(paths: readonly string[]): Promise<void>;
}

export interface PreparedReferences {
  refs: LocalReference[];
  tempFiles: string[];
}

function referenceType(type: MediaAsset["type"]): LocalReference["type"] {
  return type === "video" || type === "audio" ? type : "image";
}

export async function prepareReferences(
  references: readonly MediaAsset[],
  trim: TrimmedSource | undefined,
  hooks: PreprocessHooks,
  ops: PreprocessOps,
): Promise<PreparedReferences> {
  const tempFiles: string[] = [];
  try {
    const paths = references.map((r) => r.url);
    if (trim && trimmedSourceHasTrim(trim)) {
      const index = paths.indexOf(trim.sourceURL);
      if (index >= 0) {
        const extracted = await ops.extractTrim(trim);
        paths[index] = extracted;
        tempFiles.push(extracted);
      }
    }
    if (hooks.preprocessSourceVideo && paths.length > 0) {
      const processed = await hooks.preprocessSourceVideo(paths[0]);
      if (processed !== null) {
        paths[0] = processed;
        tempFiles.push(processed);
      }
    }
    const preprocessRef = hooks.preprocessRef;
    if (preprocessRef && references.length > 0) {
      const current = [...paths];
      const rewrites = await Promise.all(references.map((asset, i) => preprocessRef(i, asset, current[i])));
      rewrites.forEach((rewritten, i) => {
        if (rewritten === null) return;
        paths[i] = rewritten;
        tempFiles.push(rewritten);
      });
    }
    const refs: LocalReference[] = [];
    for (let i = 0; i < paths.length; i++) {
      const type = referenceType(references[i].type);
      if (type === "image" && imageRequiresConversion(paths[i])) {
        const converted = await ops.convertImageToJPEG(paths[i]);
        tempFiles.push(converted);
        refs.push({ path: converted, type, contentType: "image/jpeg" });
      } else {
        refs.push({ path: paths[i], type, contentType: contentTypeForPath(paths[i], type) });
      }
    }
    return { refs, tempFiles };
  } catch (e) {
    await ops.removeTempFiles(tempFiles).catch(() => undefined);
    throw e;
  }
}
