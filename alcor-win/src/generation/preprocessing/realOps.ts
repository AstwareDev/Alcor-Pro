import type { PreprocessOps } from "../referencePreparation";
import { removeTempFiles } from "./mediaConvert";
import { convertImageToJPEG, extractVideoTrim } from "./preprocessors";

export const realPreprocessOps: PreprocessOps = {
  extractTrim: (trim) => extractVideoTrim(trim),
  convertImageToJPEG,
  removeTempFiles,
};
