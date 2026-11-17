/** Shared result of the speech-to-text helpers (ElevenLabs Scribe, OpenAI) used by the captions feature. */
export interface TranscriptWord {
  text: string;
  /** Seconds. */
  start: number;
  end: number;
  speakerId?: string;
}

export interface Transcript {
  text: string;
  language?: string;
  words: TranscriptWord[];
}

export interface TranscribeOptions {
  /** ISO 639-1 code; omit to auto-detect. */
  language?: string;
  diarize?: boolean;
  /** Length of the audio when known; lets slow on-device transcription report progress. */
  durationSeconds?: number;
  /** On-device transcription only: called with the completed fraction. */
  onProgress?: (fraction: number) => void;
}
