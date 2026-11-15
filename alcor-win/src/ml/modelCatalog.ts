// Verified model files (sha256 recomputed from the downloaded bytes). Hosted on Hugging Face, never bundled.
import type { ModelSpec } from "./modelStore";

/**
 * Beat This! `small0` (CPJKU/beat_this, ISMIR 2024), ONNX fp32 export by jenila-ai, plus the log-mel frontend export
 * by tuneperfect (the frontend is identical for every Beat This checkpoint). Upstream code and weights: MIT.
 */
export const beatThisModel: ModelSpec = {
  id: "beat-this-small0",
  directoryName: "beat-this-small0",
  license: "MIT (CPJKU/beat_this; ONNX conversions jenila-ai/beat-this-small0-onnx and tuneperfect/beat-this-onnx, both MIT)",
  files: [
    {
      fileName: "logmel.onnx",
      url: "https://huggingface.co/tuneperfect/beat-this-onnx/resolve/main/logmel.onnx",
      sha256: "161bf43d3c258a3f5e98c609721dca6d259b8c75404a56c4c135ddd36dcdd8ad",
      bytes: 4_469_774,
    },
    {
      fileName: "beat_this_small0.onnx",
      url: "https://huggingface.co/jenila-ai/beat-this-small0-onnx/resolve/main/beat_this_small0.onnx",
      sha256: "1dbbac9e2410debf083d4002f2c2b12b61a42b3cde9b0f6fb27cc9e1b61e7517",
      bytes: 10_401_066,
    },
  ],
};

/**
 * DeepFilterNet3 (Rikorose/DeepFilterNet, dual MIT / Apache-2.0): the three graphs of the official
 * `models/DeepFilterNet3_onnx.tar.gz` (sha256 c94d91f7...), mirrored unmodified by Alice-Sabrina-Ivy/deepfilternet3-onnx.
 */
export const deepFilterNet3Model: ModelSpec = {
  id: "deepfilternet3",
  directoryName: "deepfilternet3",
  license: "MIT OR Apache-2.0 (Rikorose/DeepFilterNet)",
  files: [
    {
      fileName: "enc.onnx",
      url: "https://huggingface.co/Alice-Sabrina-Ivy/deepfilternet3-onnx/resolve/main/enc.onnx",
      sha256: "7c5399d3da8a50ebef1c1a0ae421b33376aa5e45d0e92df16da7e83c9c131916",
      bytes: 1_954_042,
    },
    {
      fileName: "erb_dec.onnx",
      url: "https://huggingface.co/Alice-Sabrina-Ivy/deepfilternet3-onnx/resolve/main/erb_dec.onnx",
      sha256: "ab669a1d10afe20911728b33053a452071042317a90581092b325da7b2f9d895",
      bytes: 3_292_397,
    },
    {
      fileName: "df_dec.onnx",
      url: "https://huggingface.co/Alice-Sabrina-Ivy/deepfilternet3-onnx/resolve/main/df_dec.onnx",
      sha256: "23114ce3b0f6464b763ee62f7bb8aab6b2a129a21eabd5bcfe59413db05f278a",
      bytes: 3_340_803,
    },
  ],
};

/**
 * SigLIP B/16-256 (google/siglip-base-patch16-256, Apache-2.0), the vision and text towers as 8-bit quantised ONNX plus the
 * SentencePiece tokenizer, from Xenova/siglip-base-patch16-256 (transformers.js export, same Apache-2.0 terms), pinned to
 * commit c9737afcd9728a8ff140700335dc52b5f497d1b7. Both towers emit a 768-d `pooler_output` (L2-normalise for cosine).
 * The Swift original uses SigLIP 2 B/16-256 (Core ML); its tokenizer is a 34 MB Gemma BPE and its ONNX towers are 378 MB,
 * so this uses the first-generation SigLIP of the same size class (about 205 MB in total).
 */
export const siglipModel: ModelSpec = {
  id: "siglip-base-patch16-256",
  directoryName: "siglip-base-patch16-256",
  license: "Apache-2.0 (google/siglip-base-patch16-256; ONNX export Xenova/siglip-base-patch16-256)",
  files: [
    {
      fileName: "vision_model_int8.onnx",
      url: "https://huggingface.co/Xenova/siglip-base-patch16-256/resolve/c9737afcd9728a8ff140700335dc52b5f497d1b7/onnx/vision_model_int8.onnx",
      sha256: "d144a7b5c89105a92358b91c7c5f67dd2934705f1514b1a19110b4b4e10e4397",
      bytes: 94_282_636,
    },
    {
      fileName: "text_model_int8.onnx",
      url: "https://huggingface.co/Xenova/siglip-base-patch16-256/resolve/c9737afcd9728a8ff140700335dc52b5f497d1b7/onnx/text_model_int8.onnx",
      sha256: "b2efff42671c6f30ed8dfb1f8ef65786528ead706120788166f8d33ce7a41495",
      bytes: 110_982_746,
    },
    {
      fileName: "tokenizer.json",
      url: "https://huggingface.co/Xenova/siglip-base-patch16-256/resolve/c9737afcd9728a8ff140700335dc52b5f497d1b7/tokenizer.json",
      sha256: "798a8118466a62b99c98fc111134d76b0905f92debc0536d2602aa5bd97c0ab9",
      bytes: 2_398_746,
    },
  ],
};
