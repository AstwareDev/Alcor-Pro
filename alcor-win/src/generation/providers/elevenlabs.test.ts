import { describe, expect, it, vi } from "vitest";

vi.mock("../../platform/backend", () => ({
  fsStat: vi.fn(), httpFetch: vi.fn(), httpCancel: vi.fn(), httpDownload: vi.fn(), appPaths: vi.fn(), fsMkdir: vi.fn(),
}));

import { buildElevenLabsRequest, elevenLabsCatalog, explainMusicRefusal, parseDubbingStatus, parseScribe } from "./elevenlabs";
import { ProviderError } from "./common";
import type { AudioParams, CatalogEntry } from "./types";

const entry = (id: string): CatalogEntry => {
  const e = elevenLabsCatalog.find((c) => c.id === `elevenlabs/${id}`);
  if (!e) throw new Error(id);
  return e;
};
const audio = (over: Partial<AudioParams> = {}): AudioParams => ({ kind: "audio", prompt: "hello", instrumental: false, ...over });

describe("elevenlabs request mapping", () => {
  it("text to speech", () => {
    const r = buildElevenLabsRequest(entry("eleven_multilingual_v2"), audio({ voice: "v 1" }));
    expect(r.url).toBe("https://api.elevenlabs.io/v1/text-to-speech/v%201?output_format=mp3_44100_128");
    expect(r.body).toEqual({ kind: "json", value: { text: "hello", model_id: "eleven_multilingual_v2" } });
    expect(() => buildElevenLabsRequest(entry("eleven_multilingual_v2"), audio())).toThrow(/voice/);
  });

  it("sound effects clamp duration to 0.5..30", () => {
    const r = buildElevenLabsRequest(entry("eleven_text_to_sound_v3"), audio({ durationSeconds: 99 }));
    expect(r.url).toContain("/v1/sound-generation");
    expect(r.body).toEqual({ kind: "json", value: { text: "hello", model_id: "eleven_text_to_sound_v3", duration_seconds: 30 } });
  });

  it("music sends length in ms (3000..600000), lyrics and instrumental flag", () => {
    const r = buildElevenLabsRequest(entry("music_v1"), audio({ durationSeconds: 1, lyrics: "la la", instrumental: true }));
    expect(r.body).toEqual({
      kind: "json",
      value: { prompt: "hello\n\nLyrics:\nla la", model_id: "music_v1", force_instrumental: true, music_length_ms: 3000 },
    });
  });

  it("voice changer uploads the file as multipart", () => {
    const r = buildElevenLabsRequest(entry("eleven_multilingual_sts_v2"), audio({ voice: "v1", source: { path: "C:\\a.wav", type: "audio" } }));
    expect(r.url).toContain("/v1/voice-changer/v1");
    expect(r.body).toEqual({
      kind: "multipart",
      parts: [
        { name: "audio", filename: "a.wav", contentType: "audio/wav", value: { kind: "file", path: "C:\\a.wav" } },
        { name: "model_id", value: { kind: "text", value: "eleven_multilingual_sts_v2" } },
      ],
    });
  });

  it("dubbing is async and needs a target language", () => {
    const src = { path: "C:\\v.mp4", type: "video" as const };
    const r = buildElevenLabsRequest(entry("dubbing"), audio({ source: src, targetLanguage: "es" }));
    expect(r.kind).toBe("dub");
    expect(r.ext).toBe("mp4");
    expect(() => buildElevenLabsRequest(entry("dubbing"), audio({ source: src }))).toThrow(/language/);
  });
});

describe("elevenlabs response parsing", () => {
  it("parses a Scribe response keeping only words", () => {
    const t = parseScribe({
      language_code: "en", language_probability: 0.98, text: "Hello world!",
      words: [
        { text: "Hello", start: 0, end: 0.5, type: "word", speaker_id: "speaker_1", logprob: -0.1 },
        { text: " ", start: 0.5, end: 0.55, type: "spacing" },
        { text: "(laughter)", start: 0.6, end: 0.9, type: "audio_event" },
        { text: "world!", start: 0.55, end: 1, type: "word" },
      ],
    });
    expect(t).toEqual({
      text: "Hello world!", language: "en",
      words: [{ text: "Hello", start: 0, end: 0.5, speakerId: "speaker_1" }, { text: "world!", start: 0.55, end: 1 }],
    });
  });

  it("maps dubbing project status", () => {
    expect(parseDubbingStatus({ status: "dubbing" })).toEqual({ state: "running" });
    expect(parseDubbingStatus({ status: "dubbed" })).toEqual({ state: "done" });
    expect(parseDubbingStatus({ status: "dubbing", error: "bad audio" })).toEqual({ state: "failed", error: "bad audio" });
  });
});

describe("explainMusicRefusal", () => {
  const music = elevenLabsCatalog.find((m) => m.id === "elevenlabs/music_v2_5");
  const speech = elevenLabsCatalog.find((m) => !m.id.startsWith("elevenlabs/music_"));
  it("explains auth and billing refusals for music models only", () => {
    if (!music || !speech) throw new Error("catalog changed");
    const refused = new ProviderError("auth", "ElevenLabs rejected the API key (HTTP 401).");
    const explained = explainMusicRefusal(music, refused);
    expect(explained).toBeInstanceOf(ProviderError);
    expect((explained as ProviderError).message).toContain("paid plans");
    expect((explained as ProviderError).message).toContain("HTTP 401");
    expect(explainMusicRefusal(speech, refused)).toBe(refused);
    const other = new ProviderError("invalid_input", "bad prompt");
    expect(explainMusicRefusal(music, other)).toBe(other);
  });
});
