// Browser-only preview of HomeView against fake data: `?dev=home`. Not used by the app.
import { isTauri } from "@tauri-apps/api/core";
import { swiftDateNow } from "../model";
import { MemoryFileSystem } from "../project/memoryFileSystem";
import { ProjectRegistry } from "../project/projectRegistry";
import { HomeView } from "./HomeView";
import type { HomeServices } from "./homeServices";

const dir = "C:/Users/you/Documents/Alcor Pro";
const day = 86400;

// 5:4 gradient placeholder thumbnails.
const thumb = (a: string, b: string) =>
  `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="320"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="400" height="320" fill="url(#g)"/></svg>`,
  )}`;

async function fakeServices(): Promise<HomeServices> {
  const fs = new MemoryFileSystem();
  const now = swiftDateNow();
  const projects: [string, number, number, string | null, boolean][] = [
    ["Summer Trip", 2 * day, 3600, thumb("#2b5876", "#4e4376"), true],
    ["Product Launch", 9 * day, 2 * day, thumb("#614385", "#516395"), true],
    ["Interview Rough Cut", 30 * day, 5 * day, null, true],
    ["Conference Recap", 60 * day, 21 * day, thumb("#134e5e", "#71b280"), true],
    ["Moved Project", 80 * day, 40 * day, null, false],
  ];
  const thumbs = new Map<string, string>();
  const registry = new ProjectRegistry({ fs, directory: dir, now: () => now });
  await registry.load();
  for (const [name, created, opened, img, exists] of projects) {
    const path = `${dir}/${name}.palmier`;
    if (exists) fs.seedText(`${path}/project.json`, "{}");
    if (img) thumbs.set(path, img);
    await registry.register(path);
    const entry = registry.entries().find((e) => e.path === path);
    if (entry) {
      entry.createdDate = now - created;
      entry.lastOpenedDate = now - opened;
    }
  }
  return {
    registry,
    createProject: async () => `${dir}/Untitled Project.palmier`,
    chooseProject: async () => null,
    revealInExplorer: async () => {},
    isOpen: () => false,
    thumbnailSrc: (p) => thumbs.get(p),
    samples: {
      list: [{ slug: "demo", title: "Sample Project", posterUrl: thumb("#7b4397", "#dc2430"), resolveUrl: "about:blank" }],
      prepare: async (_, onProgress, signal) => {
        for (let i = 1; i <= 10; i++) {
          await new Promise((resolve) => setTimeout(resolve, 300));
          if (signal?.aborted) throw new Error("cancelled");
          onProgress(i / 10);
        }
        return `${dir}/Sample Project.palmier`;
      },
    },
  };
}

export default function HomeDev() {
  return (
    <HomeView
      services={isTauri() ? undefined : fakeServices()}
      onOpenProject={(path) => console.log("open", path)}
      onOpenSettings={() => console.log("settings")}
    />
  );
}
