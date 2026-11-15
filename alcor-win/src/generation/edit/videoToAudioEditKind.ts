// Port of Edit/VideoToAudioEditKind.swift.
import { audioCategory, audioInputs, type AudioCategory, type AudioEntry } from "../modelConfig";
import { audioModels } from "../catalog";
import type { EditAction } from "./editAction";

export type VideoToAudioEditKind = "music" | "sfx";

interface Copy {
  title: string;
  menuTitle: string;
  providerName: string;
  action: EditAction;
  description: string;
  timelineActionName: string;
  preferredModelId: string;
  category: AudioCategory;
}

export const videoToAudioKinds: Record<VideoToAudioEditKind, Copy> = {
  music: {
    title: "Generate Music",
    menuTitle: "Generate Music…",
    providerName: "Sonilo",
    action: "generateMusic",
    description: "Generate music that fits the video",
    timelineActionName: "Add Music",
    preferredModelId: "sonilo-v1.1-video-to-music",
    category: "music",
  },
  sfx: {
    title: "Generate SFX",
    menuTitle: "Generate SFX…",
    providerName: "Mirelo",
    action: "generateSFX",
    description: "Create matching sound for the video",
    timelineActionName: "Add Sound Effects",
    preferredModelId: "mirelo-sfx-v1.5-video-to-audio",
    category: "sfx",
  },
};

export function videoToAudioModel(kind: VideoToAudioEditKind, models: readonly AudioEntry[] = audioModels()): AudioEntry | undefined {
  const c = videoToAudioKinds[kind];
  const candidates = models.filter((m) => audioCategory(m) === c.category && audioInputs(m).includes("video"));
  const preferred = candidates.find((m) => m.id === c.preferredModelId || m.id.endsWith(`/${c.preferredModelId}`));
  if (preferred) return preferred;
  const name = c.providerName.toLowerCase();
  return candidates.find((m) => m.id.toLowerCase().includes(name) || m.displayName.toLowerCase().includes(name));
}
