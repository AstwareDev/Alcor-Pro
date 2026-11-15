// Transcription languages offered in the captions tab: ISO 639-1 codes both ElevenLabs Scribe and Whisper accept.
const codes = [
  "ar", "bg", "ca", "cs", "da", "de", "el", "en", "es", "fi", "fr", "he", "hi", "hr", "hu", "id", "it", "ja", "ko",
  "ms", "nl", "no", "pl", "pt", "ro", "ru", "sk", "sv", "ta", "th", "tr", "uk", "vi", "zh",
] as const;

export interface CaptionLanguage {
  code: string;
  name: string;
}

export function captionLanguageName(code: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** Sorted by display name. */
export function captionLanguages(): CaptionLanguage[] {
  return codes.map((code) => ({ code, name: captionLanguageName(code) })).sort((a, b) => a.name.localeCompare(b.name));
}
