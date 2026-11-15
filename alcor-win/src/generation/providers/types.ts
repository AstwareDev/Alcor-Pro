// Contract between the generation UI (port of Generation/**) and AI provider adapters.
// The macOS app sends everything to Palmier's backend; here each catalog entry is served by a provider adapter
// that talks to the vendor directly with the user's own API key (held by Rust, never visible to the webview).

export type ModelKind = "video" | "image" | "audio" | "upscale";
export type ResponseShape = "video" | "images" | "audio" | "upscaledImage";

/** Swift `VideoCaps`, field-for-field. */
export interface VideoCaps {
  supportsPrompt?: boolean;
  durations: number[];
  resolutions?: string[];
  aspectRatios: string[];
  supportsFirstFrame: boolean;
  supportsLastFrame: boolean;
  maxReferenceImages: number;
  maxReferenceVideos: number;
  maxReferenceAudios: number;
  maxTotalReferences?: number;
  maxCombinedVideoRefSeconds?: number;
  maxCombinedAudioRefSeconds?: number;
  framesAndReferencesExclusive: boolean;
  referenceTagNoun: string;
  requiresSourceVideo: boolean;
  maxSourceVideoSeconds?: number;
  maxSourceVideoResolution?: "720p" | "1080p" | "4k";
  requiredSourceVideoEncoding?: "h264-mp4";
  requiresReferenceImage: boolean;
  requiresReferenceAudio?: boolean;
  /** Provider supports a native audio track (Swift `generateAudio` toggle). */
  supportsGenerateAudio?: boolean;
}

/** Swift `ImageCaps`. */
export interface ImageCaps {
  resolutions?: string[];
  aspectRatios: string[];
  qualities?: string[];
  supportsImageReference: boolean;
  maxImages: number;
}

/** Swift `AudioCaps`. `category` values match the Swift: "tts", "music", "sfx", "videoToAudio", "voiceChange", "dubbing"… */
export interface AudioCaps {
  category: string;
  voices?: string[];
  defaultVoice?: string;
  supportsLyrics: boolean;
  supportsInstrumental: boolean;
  supportsStyleInstructions: boolean;
  durations?: number[];
  durationRange?: { minimum: number; maximum: number; defaultValue: number };
  minPromptLength: number;
  maxReferenceImages?: number;
  maxReferenceAudios?: number;
  maxReferenceAudioSeconds?: number;
  referenceAudioExtensions?: string[];
  referenceImagesAndAudiosExclusive?: boolean;
  supportsMultilingual?: boolean;
  inputs?: string[];
  promptLabel?: string;
  minSeconds?: number;
  maxSeconds?: number;
  targetLanguages?: string[];
  defaultTargetLanguage?: string;
}

export interface UpscaleSelectSetting {
  key: string;
  label: string;
  options: string[];
  defaultValue: string;
}
export interface UpscaleNumericSetting {
  key: string;
  label: string;
  minimum: number;
  maximum: number;
  step: number;
  defaultValue: number;
}
export interface UpscaleToggleSetting {
  key: string;
  label: string;
  defaultValue: boolean;
}

/** Swift `UpscaleCaps`. */
export interface UpscaleCaps {
  speed: "Fast" | "Medium" | "Slow";
  p75DurationSeconds: number;
  maximumUpscaleFactor?: number;
  supportedTypes: ("video" | "image")[];
  selectSettings?: UpscaleSelectSetting[];
  numericSettings?: UpscaleNumericSetting[];
  toggleSettings?: UpscaleToggleSetting[];
}

/** Optional USD price hint shown next to the submit button (replaces Palmier credits). */
export type PriceHint =
  | { mode: "perSecond"; usd: number; byResolution?: Record<string, number> }
  | { mode: "perImage"; usd: number; byResolution?: Record<string, number> }
  | { mode: "perThousandChars"; usd: number }
  | { mode: "flat"; usd: number };

/** Swift `CatalogEntry` minus credits/paidOnly, plus which provider serves it. */
export type CatalogEntry = {
  /** Stable across releases; persisted in `GenerationInput.model`. Format `<providerId>/<vendor model id>`. */
  id: string;
  providerId: ProviderId;
  displayName: string;
  /** Key into the lab logos (Swift `ProviderLogo` / Resources/Images/LabLogos). */
  providerIconKey?: string;
  providerName?: string;
  description?: string;
  responseShape: ResponseShape;
  price?: PriceHint;
  /** Official docs page the adapter mapping was verified against. */
  docsUrl: string;
} & (
  | { kind: "video"; uiCapabilities: VideoCaps }
  | { kind: "image"; uiCapabilities: ImageCaps }
  | { kind: "audio"; uiCapabilities: AudioCaps }
  | { kind: "upscale"; uiCapabilities: UpscaleCaps }
);

/** A local file the adapter must make available to the vendor (upload, multipart, data URI…). */
export interface LocalReference {
  path: string;
  type: "image" | "video" | "audio";
  /** MIME type when known. */
  contentType?: string;
}

/** Swift `VideoGenerationParams` with local references instead of uploaded URLs. */
export interface VideoParams {
  kind: "video";
  prompt: string;
  duration: number;
  sourceVideoDuration?: number;
  aspectRatio: string;
  resolution?: string;
  sourceVideo?: LocalReference;
  startFrame?: LocalReference;
  endFrame?: LocalReference;
  referenceImages: LocalReference[];
  referenceVideos: LocalReference[];
  referenceAudios: LocalReference[];
  generateAudio: boolean;
  draft?: boolean;
}

/** Swift `ImageGenerationParams`. */
export interface ImageParams {
  kind: "image";
  prompt: string;
  aspectRatio: string;
  resolution?: string;
  quality?: string;
  images: LocalReference[];
  numImages: number;
}

/** Swift `AudioGenerationParams`. */
export interface AudioParams {
  kind: "audio";
  prompt: string;
  voice?: string;
  lyrics?: string;
  styleInstructions?: string;
  instrumental: boolean;
  durationSeconds?: number;
  video?: LocalReference;
  source?: LocalReference;
  targetLanguage?: string;
  referenceImage?: LocalReference;
  referenceAudios?: LocalReference[];
  multilingual?: boolean;
}

/** Swift `UpscaleGenerationParams`. */
export interface UpscaleParams {
  kind: "upscale";
  source: LocalReference;
  durationSeconds: number;
  sourceWidth?: number;
  sourceHeight?: number;
  sourceFPS?: number;
  settings: Record<string, string | number | boolean>;
}

export type GenerationParams = VideoParams | ImageParams | AudioParams | UpscaleParams;

/** Serialisable handle; persisted in `GenerationInput.backendJobId` so generations resume after reopening. */
export interface JobHandle {
  providerId: ProviderId;
  modelId: string;
  /** Provider-specific, opaque to the UI (request id, status URL…). JSON-safe. */
  ref: string;
}

/** Swift `BackendGenerationJob`. */
export type JobState =
  | { status: "queued" | "running"; progress?: number }
  | { status: "succeeded"; outputs: JobOutput[] }
  | { status: "failed"; errorMessage: string; code?: string };

/** Either a remote URL to download, or bytes already saved to a local file by the adapter. */
export type JobOutput = { url: string } | { path: string };

export type ProviderId = "fal" | "elevenlabs" | "openai" | "google" | "replicate";

export interface Provider {
  id: ProviderId;
  displayName: string;
  /** Secret name in Rust's allowlist (`src-tauri/src/secrets.rs`). */
  secretName: string;
  /** Where users create a key; shown in Settings. */
  keyUrl: string;
  catalog: readonly CatalogEntry[];
  /** Validates the stored key with a cheap authenticated request. */
  checkKey(signal?: AbortSignal): Promise<{ ok: true } | { ok: false; message: string }>;
  submit(model: CatalogEntry, params: GenerationParams, signal?: AbortSignal): Promise<JobHandle>;
  /** One status read; the job service owns polling cadence. Synchronous providers return a finished handle state. */
  status(job: JobHandle, signal?: AbortSignal): Promise<JobState>;
  /** Best effort; a provider without cancellation resolves without error. */
  cancel?(job: JobHandle): Promise<void>;
  /** Extra per-provider listing, e.g. ElevenLabs voices; merged into `AudioCaps.voices` by the catalog. */
  listVoices?(signal?: AbortSignal): Promise<{ id: string; name: string }[]>;
}
