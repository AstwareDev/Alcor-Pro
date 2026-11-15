// Browser-only preview of the Settings window: `?dev=settings`. Outside Tauri the credential store is stubbed in memory.
import { setProvidersWithKeys } from "../generation/providers/registry";
import { SettingsView } from "./SettingsView";

export default function SettingsDev() {
  setProvidersWithKeys(["elevenlabs"]);
  return (
    <div style={{ position: "fixed", inset: "0" }}>
      <SettingsView onClose={() => undefined} />
    </div>
  );
}
