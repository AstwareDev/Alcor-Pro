import Minus from "lucide-solid/icons/minus";
import Square from "lucide-solid/icons/square";
import X from "lucide-solid/icons/x";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

export function WindowControls() {
  if (!isTauri()) return null;
  const win = getCurrentWindow();
  return (
    <div class="window-controls">
      <button aria-label="Minimize" onClick={() => win.minimize()}>
        <Minus size={14} />
      </button>
      <button aria-label="Maximize" onClick={() => win.toggleMaximize()}>
        <Square size={11} />
      </button>
      <button class="close" aria-label="Close" onClick={() => win.close()}>
        <X size={15} />
      </button>
    </div>
  );
}
