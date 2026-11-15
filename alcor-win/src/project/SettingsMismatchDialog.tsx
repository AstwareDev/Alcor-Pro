import { onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import {
  answerSettingsMismatch, dismissSettingsMismatch, pendingSettingsMismatch,
} from "../editor/mutations/settingsMismatchPrompt";
import { CapsuleButton } from "../ui/CapsuleButton";
import "../ui/Dialog.css";
import "./SettingsMismatchDialog.css";

function Sheet() {
  onMount(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !pendingSettingsMismatch()) return;
      e.stopPropagation();
      dismissSettingsMismatch();
    };
    document.addEventListener("keydown", key, true);
    onCleanup(() => document.removeEventListener("keydown", key, true));
  });
  return (
    <Show when={pendingSettingsMismatch()}>
      {(pending) => {
        const timeline = () => pending().editor.timeline;
        const m = () => pending().mismatch;
        return (
          <Portal>
            <div class="dialog-scrim">
              <div class="dialog mismatch-sheet" role="alertdialog" aria-modal="true" aria-label="Clip Settings Mismatch">
                <div class="mismatch-title">Clip Settings Mismatch</div>
                <div class="mismatch-message">The clip you're adding has different settings than the current project.</div>
                <div class="mismatch-grid">
                  <span />
                  <span class="mismatch-head">Project</span>
                  <span class="mismatch-head">Clip</span>
                  <span class="mismatch-label">FPS</span>
                  <span class="mismatch-value">{timeline().fps}</span>
                  <span class="mismatch-value" classList={{ differs: m().clipFPS !== timeline().fps }}>{m().clipFPS}</span>
                  <span class="mismatch-label">Resolution</span>
                  <span class="mismatch-value">{timeline().width} x {timeline().height}</span>
                  <span
                    class="mismatch-value"
                    classList={{ differs: m().clipWidth !== timeline().width || m().clipHeight !== timeline().height }}
                  >
                    {m().clipWidth} x {m().clipHeight}
                  </span>
                </div>
                <div class="dialog-buttons mismatch-buttons">
                  <CapsuleButton size="regular" onClick={() => answerSettingsMismatch(false)}>Keep Current</CapsuleButton>
                  <CapsuleButton size="regular" variant="prominent" onClick={() => answerSettingsMismatch(true)}>Change to Match</CapsuleButton>
                </div>
              </div>
            </div>
          </Portal>
        );
      }}
    </Show>
  );
}

/** Port of ProjectSettingsMismatchView: the sheet shown when the first clip's resolution or fps differs from the project. */
export function SettingsMismatchDialog() {
  return <Sheet />;
}
