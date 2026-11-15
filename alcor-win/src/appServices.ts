import { exportVideoToFile } from "./export/exportEngine";
import { buildVideoJobSpec } from "./export/exportRunner";
import { musicHooks } from "./generation/musicGeneration";
import { inspectorServices } from "./inspector/services";
import { appPaths, fsCopy, fsMkdir, fsReadText, fsRemove } from "./platform/backend";
import { chooseLutFile } from "./platform/luts";
import { parseCubeLUT } from "./preview/effects/lutLoader";
import { basename, joinPath, samePath } from "./project/projectPaths";
import { newId } from "./util/id";

/** Platform-backed implementations of feature hooks. Call once at startup inside Tauri. */
export function installAppServices(): void {
  inspectorServices.chooseLutFile = chooseLutFile;

  // Port of LUTLoader.store: validate, then copy into app storage so the project keeps working if the source moves.
  inspectorServices.storeLut = async (path) => {
    const lut = parseCubeLUT(await fsReadText(path));
    if (!lut) throw new Error(`${basename(path)} is not a valid .cube LUT.`);
    const dir = joinPath((await appPaths()).appData, "luts/default");
    const dest = joinPath(dir, basename(path));
    if (!samePath(path, dest)) {
      await fsMkdir(dir);
      await fsCopy(path, dest);
    }
    return dest;
  };

  // Video-to-music needs the timeline span as a video file; the export engine renders it.
  musicHooks.renderTimelineSpan = async (editor, span) => {
    const dest = joinPath((await appPaths()).temp, `span-${newId()}.mp4`);
    const spec = buildVideoJobSpec(editor, editor.doc.activeTimelineId, {
      codec: "H.264",
      resolution: "720p",
      range: { startFrame: span.startFrame, endFrame: span.startFrame + span.frameCount },
      includeAudio: true,
    });
    await exportVideoToFile(spec, dest);
    return dest;
  };
  musicHooks.removeTempFile = (path) => fsRemove(path);
}
