import { setMaximizedPanel, setInspectorPanelVisible, setMediaPanelVisible } from "../editor/workspace";
import { TourController } from "./tourController";

/** The one tour of the app: started automatically after the first project opens and from the title bar's Help button. */
export const tour = new TourController({
  reveal(panel) {
    setMaximizedPanel(null);
    if (panel === "media") setMediaPanelVisible(true);
    else if (panel === "inspector") setInspectorPanelVisible(true);
  },
});
