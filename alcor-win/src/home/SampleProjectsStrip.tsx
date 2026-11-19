import ChevronRight from "lucide-solid/icons/chevron-right";
import Film from "lucide-solid/icons/film";
import X from "lucide-solid/icons/x";
import { createSignal, For, Show } from "solid-js";
import type { SampleSummary } from "../onboarding/sampleProjects";

const expandedKey = "samplesSectionExpanded";

function readExpanded(): boolean {
  try {
    return globalThis.localStorage?.getItem(expandedKey) !== "false";
  } catch {
    return true;
  }
}

interface Download {
  slug: string;
  progress: number;
  failed: boolean;
}

/** Port of SampleProjectsStrip: a collapsible row of sample cards; renders nothing when there are no samples. */
export function SampleProjectsStrip(props: {
  samples: readonly SampleSummary[];
  open: (sample: SampleSummary, onProgress: (fraction: number) => void, signal?: AbortSignal) => Promise<void>;
}) {
  const [expanded, setExpanded] = createSignal(readExpanded());
  const [download, setDownload] = createSignal<Download | null>(null);

  const toggle = () => {
    const next = !expanded();
    setExpanded(next);
    try {
      globalThis.localStorage?.setItem(expandedKey, String(next));
    } catch {
      // persistence is best effort, like @AppStorage
    }
  };

  let abort: AbortController | undefined;

  const start = async (sample: SampleSummary) => {
    if (download() !== null && download()?.failed !== true) return;
    const controller = new AbortController();
    abort = controller;
    setDownload({ slug: sample.slug, progress: 0, failed: false });
    try {
      await props.open(sample, (progress) => setDownload((d) => (d ? { ...d, progress } : d)), controller.signal);
      setDownload(null);
    } catch {
      setDownload(controller.signal.aborted ? null : (d) => (d ? { ...d, failed: true } : d));
    }
  };

  const cancel = () => abort?.abort();

  return (
    <Show when={props.samples.length > 0}>
      <section class="samples">
        <button type="button" class="samples-toggle" aria-expanded={expanded()} onClick={toggle}>
          <span class="samples-title">Sample Project</span>
          <ChevronRight size={10} class="samples-chevron" classList={{ open: expanded() }} />
        </button>
        <Show when={expanded()}>
          <div class="samples-row">
            <For each={props.samples}>
              {(sample) => {
                const active = () => (download()?.slug === sample.slug ? download() : null);
                return (
                  <div class="project-cell sample-cell">
                    <button type="button" class="project-card sample-card" title={sample.title} onClick={() => void start(sample)}>
                      <div class="card-art" classList={{ blurred: active() !== null }}>
                        <Show when={sample.posterUrl} fallback={<div class="card-art-icon"><Film size={22} stroke-width={1.25} /></div>}>
                          {(url) => <img class="card-thumb loaded" src={url()} alt="" draggable={false} />}
                        </Show>
                      </div>
                      <div class="card-fade" />
                      <div class="card-label"><span class="card-name">{sample.title}</span></div>
                      <Show when={active()}>
                        {(d) => (
                          <div class="sample-download">
                            <Show when={d().failed} fallback={<progress max="1" value={d().progress} />}>
                              <span>Retry</span>
                            </Show>
                          </div>
                        )}
                      </Show>
                    </button>
                    <Show when={active() && !active()?.failed}>
                      <button type="button" class="sample-cancel" title="Cancel download" aria-label="Cancel download" onClick={cancel}>
                        <X size={11} />
                      </button>
                    </Show>
                  </div>
                );
              }}
            </For>
          </div>
        </Show>
      </section>
    </Show>
  );
}
