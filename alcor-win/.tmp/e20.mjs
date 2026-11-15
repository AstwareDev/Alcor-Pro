import { sub } from "./e2lib.mjs";
const p = "src/preview/overlays/PreviewOverlays.tsx";
sub(p, `import { MaskOverlay, maskOverlayActive } from "./MaskOverlay";`, `import { MaskOverlay, maskOverlayActive } from "./MaskOverlay";
import { MotionPathOverlay } from "./MotionPathOverlay";`);
sub(p, `    </Switch>
    <Show when={slipPreview()}>`, `    </Switch>
    <Show when={mode() === "transform"}>
      <MotionPathOverlay editor={props.editor} size={props.size} />
    </Show>
    <Show when={slipPreview()}>`);
