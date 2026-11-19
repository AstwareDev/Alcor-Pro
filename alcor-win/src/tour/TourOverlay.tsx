// Port of Editor/Tour/TourOverlay.swift. Spotlights are measured from the DOM only while a step is showing: a
// ResizeObserver and a resize listener live for that step, nothing otherwise.
import ArrowUpRight from "lucide-solid/icons/arrow-up-right";
import { createEffect, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { openShortcutsSheet } from "../help/ShortcutsSheet";
import { CapsuleButton } from "../ui/CapsuleButton";
import type { TourController } from "./tourController";
import { calloutPosition, tourSelector, tourSpotlightCount, type Rect, type TourStep } from "./tourSteps";
import "./tour.css";

const measureRetryFrames = 12;

function measure(selector: string): Rect | null {
  const r = document.querySelector(selector)?.getBoundingClientRect();
  return r && r.width > 1 && r.height > 1 ? { x: r.left, y: r.top, width: r.width, height: r.height } : null;
}

function Layer(props: { controller: TourController; step: TourStep; onOpenSettings?: () => void }) {
  const [frame, setFrame] = createSignal<Rect | null>(null);
  const [viewport, setViewport] = createSignal({ width: window.innerWidth, height: window.innerHeight });
  let primary: HTMLButtonElement | undefined;

  const spotlight = (): boolean => props.step.kind === "spotlight";
  const index = (): number => props.controller.index() ?? 0;

  createEffect(() => {
    const target = props.step.target;
    setFrame(null);
    if (target === undefined) return;
    const selector = tourSelector(target);
    let raf = 0;
    let retries = 0;
    const update = (): void => {
      setViewport({ width: window.innerWidth, height: window.innerHeight });
      setFrame(measure(selector));
    };
    // A panel revealed by this step has no layout until the next frames.
    const settle = (): void => {
      update();
      if (frame() === null && retries++ < measureRetryFrames) raf = requestAnimationFrame(settle);
    };
    settle();
    const element = document.querySelector(selector);
    const observer = element ? new ResizeObserver(update) : undefined;
    if (element) observer?.observe(element);
    window.addEventListener("resize", update);
    onCleanup(() => {
      cancelAnimationFrame(raf);
      observer?.disconnect();
      window.removeEventListener("resize", update);
    });
  });

  createEffect(on(index, () => queueMicrotask(() => primary?.focus())));

  onMount(() => {
    const key = (e: KeyboardEvent): void => {
      if (e.key === "Escape") props.controller.end();
      else if (e.key === "ArrowRight") props.controller.next();
      else if (e.key === "ArrowLeft") props.controller.back();
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", key, true);
    onCleanup(() => window.removeEventListener("keydown", key, true));
  });

  const center = () => (spotlight() ? calloutPosition(frame(), viewport()) : { x: viewport().width / 2, y: viewport().height / 2 });
  const f = (): Rect => frame() ?? { x: viewport().width / 2, y: viewport().height / 2, width: 0, height: 0 };

  const links = [
    { label: "Keyboard Shortcuts", run: openShortcutsSheet },
    { label: "Settings", run: () => props.onOpenSettings?.() },
  ];

  return (
    <div class="tour" role="dialog" aria-modal="true" aria-label="Tour">
      <div class="tour-scrim" classList={{ plain: !spotlight() || frame() === null }} onPointerDown={() => spotlight() && props.controller.end()} />
      <div
        class="tour-spot"
        classList={{ shown: spotlight() && frame() !== null }}
        style={{ transform: `translate(${f().x}px, ${f().y}px)`, width: `${f().width}px`, height: `${f().height}px` }}
      />
      <div class="tour-card" classList={{ bookend: !spotlight() }} style={{ "--tour-x": `${center().x}px`, "--tour-y": `${center().y}px` }}>
        <Show when={spotlight()}>
          <span class="tour-step">Step {index()} of {tourSpotlightCount}</span>
        </Show>
        <h2 class="tour-title" classList={{ display: props.step.kind === "intro" }}>{props.step.title}</h2>
        <p class="tour-text">{props.step.instruction}</p>
        <Show when={props.step.kind === "outro"}>
          <div class="tour-links">
            <For each={links}>
              {(link) => (
                <button type="button" class="tour-link hover-highlight" onClick={link.run}>
                  <span>{link.label}</span>
                  <ArrowUpRight size={11} />
                </button>
              )}
            </For>
          </div>
        </Show>
        <div class="tour-actions">
          <Show when={props.step.kind !== "outro"}>
            <CapsuleButton onClick={() => props.controller.end()}>Skip</CapsuleButton>
          </Show>
          <span class="tour-spacer" />
          <Show when={index() > 0 && props.step.kind !== "outro"}>
            <CapsuleButton onClick={() => props.controller.back()}>Back</CapsuleButton>
          </Show>
          <CapsuleButton variant="prominent" ref={primary} onClick={() => props.controller.next()}>
            {props.step.kind === "outro" ? "Start creating" : "Next"}
          </CapsuleButton>
        </div>
      </div>
    </div>
  );
}

/** Mount once in the editor. Renders nothing (and runs nothing) while the tour is not showing. */
export function TourOverlay(props: { controller: TourController; onOpenSettings?: () => void }) {
  return (
    <Show when={props.controller.step()}>
      {(step) => (
        <Portal>
          <Layer controller={props.controller} step={step()} onOpenSettings={props.onOpenSettings} />
        </Portal>
      )}
    </Show>
  );
}
