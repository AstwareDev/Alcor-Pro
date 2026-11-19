import Cog from "lucide-solid/icons/cog";
import FolderOpen from "lucide-solid/icons/folder-open";
import Plus from "lucide-solid/icons/plus";
import { createResource, onCleanup, onMount, Show } from "solid-js";
import { SidebarRowButton } from "../ui/SidebarRowButton";
import { AlcorBrand } from "../ui/AlcorBrand";
import { WindowControls } from "../ui/WindowControls";
import type { SampleSummary } from "../onboarding/sampleProjects";
import { createDialogHost } from "./dialogs";
import { createHomeServices, type HomeServices } from "./homeServices";
import { MyProjectsSection } from "./MyProjectsSection";
import { SampleProjectsStrip } from "./SampleProjectsStrip";
import { OnboardingOverlay } from "../onboarding/OnboardingOverlay";
import { OnboardingStore } from "../onboarding/onboardingStore";
import "./home.css";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Port of HomeView (sidebar + welcome header + sample projects + My Projects + onboarding overlay). The update overlay
 * and account UI are not ported. `services` is injectable for the browser dev page.
 */
export function HomeView(props: {
  onOpenProject: (path: string) => void;
  onOpenSettings?: () => void;
  services?: HomeServices | Promise<HomeServices>;
}) {
  const [services] = createResource(() => props.services ?? createHomeServices());
  const dialogs = createDialogHost();

  const openSample = async (sample: SampleSummary, onProgress: (fraction: number) => void, signal?: AbortSignal) => {
    const s = services();
    if (s) props.onOpenProject(await s.samples.prepare(sample, onProgress, signal));
  };
  const onboarding = new OnboardingStore({
    sampleAvailable: () => (services()?.samples.list.length ?? 0) > 0,
    openSample: async () => {
      const first = services()?.samples.list[0];
      if (!first) return false;
      await openSample(first, () => undefined);
      return true;
    },
  });

  const run = async (title: string, work: (s: HomeServices) => Promise<void>) => {
    const s = services();
    if (!s) return;
    try {
      await work(s);
    } catch (error) {
      dialogs.alert(title, errorText(error));
    }
  };

  const newProject = () =>
    run("Project Couldn’t Be Created", async (s) => {
      props.onOpenProject(await s.createProject());
    });

  const openProject = () =>
    run("Project Couldn’t Be Opened", async (s) => {
      const path = await s.chooseProject();
      if (path !== null) props.onOpenProject(path);
    });

  onMount(() => {
    const key = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.shiftKey || e.altKey || e.metaKey) return;
      if (e.key.toLowerCase() === "n") {
        e.preventDefault();
        void newProject();
      } else if (e.key.toLowerCase() === "o") {
        e.preventDefault();
        void openProject();
      }
    };
    window.addEventListener("keydown", key);
    onCleanup(() => window.removeEventListener("keydown", key));
  });

  return (
    <div class="home">
      <header class="home-titlebar" data-tauri-drag-region>
        <WindowControls />
      </header>

      <aside class="home-sidebar">
        <div class="home-sidebar-rows">
          <div class="home-brand"><AlcorBrand /></div>
          <SidebarRowButton label="New Project" title="New Project (Ctrl+N)" icon={<Plus size={13} />} onClick={newProject} />
          <SidebarRowButton label="Open Project" title="Open Project (Ctrl+O)" icon={<FolderOpen size={13} />} onClick={openProject} />
        </div>
        <div class="home-sidebar-footer">
          <SidebarRowButton
            label="Settings"
            title="Settings (Ctrl+,)"
            icon={<Cog size={13} />}
            onClick={() => props.onOpenSettings?.()}
          />
        </div>
      </aside>

      <main class="home-content">
        <div class="home-header">
          <h1 class="home-welcome">Welcome to Alcor Pro</h1>
        </div>
        <Show when={services()}>
          {(s) => (
            <>
              <SampleProjectsStrip samples={s().samples.list} open={openSample} />
              <MyProjectsSection
                services={s()}
                dialogs={dialogs}
                onOpenProject={props.onOpenProject}
                onNewProject={newProject}
              />
            </>
          )}
        </Show>
      </main>

      <Show when={!onboarding.isComplete()}>
        <OnboardingOverlay onboarding={onboarding} />
      </Show>

      {dialogs.element()}
    </div>
  );
}
