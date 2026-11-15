import type { JSX } from "solid-js";
import { Toggle } from "../ui/Toggle";

/** Port of `SettingsSection`: titled prominent surface. */
export function SettingsSection(props: { title: string; children: JSX.Element }) {
  return (
    <section class="settings-section">
      <h3 class="settings-section-title">{props.title}</h3>
      <div class="settings-section-body">{props.children}</div>
    </section>
  );
}

/** Port of `SettingsGroup`: title with free content. */
export function SettingsGroup(props: { title: string; children: JSX.Element }) {
  return (
    <section class="settings-group">
      <h3 class="settings-section-title">{props.title}</h3>
      {props.children}
    </section>
  );
}

/** Port of `SettingsToggleRow`. */
export function SettingsToggleRow(props: { title: string; subtitle: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div class="settings-row">
      <div class="settings-row-text">
        <div class="settings-row-title">{props.title}</div>
        <div class="settings-row-subtitle">{props.subtitle}</div>
      </div>
      <Toggle checked={props.checked} onChange={props.onChange} label={props.title} title={props.subtitle} />
    </div>
  );
}
