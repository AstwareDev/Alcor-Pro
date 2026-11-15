import { sub } from "./e2lib.mjs";
const o = "src/preview/overlays/MotionPathOverlay.tsx";
sub(o, `import { For, Show, createMemo, onCleanup } from "solid-js";`, `import { Index, Show, createMemo, onCleanup } from "solid-js";`);
sub(o, `          <For each={dots()}>
            {(d) => (
              <circle
                class="motion-path-dot"
                cx={d.point.x}
                cy={d.point.y}
                r={dotRadius}
                onPointerDown={(e) => startDrag(e, c().id, d.offset)}
              />
            )}
          </For>`, `          {/* Index keeps each dot's element (and its pointer capture) alive while its keyframe moves. */}
          <Index each={dots()}>
            {(d) => (
              <circle
                class="motion-path-dot"
                cx={d().point.x}
                cy={d().point.y}
                r={dotRadius}
                onPointerDown={(e) => startDrag(e, c().id, d().offset)}
              />
            )}
          </Index>`);
