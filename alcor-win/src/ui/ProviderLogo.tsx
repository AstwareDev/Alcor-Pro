import { Show } from "solid-js";

// Lab logos from the original app (Resources/Images/LabLogos), keyed by `providerIconKey`.
const logos = import.meta.glob<string>("../assets/labs/logo-*.png", { eager: true, import: "default" });

export function providerLogoUrl(key: string): string | undefined {
  return logos[`../assets/labs/logo-${key}.png`];
}

export function ProviderLogo(props: { iconKey: string; size?: number; opacity?: number }) {
  const size = (): number => props.size ?? 16;
  return (
    <Show
      when={providerLogoUrl(props.iconKey)}
      fallback={<span style={{ width: `${size()}px`, height: `${size()}px`, display: "inline-block" }} />}
    >
      {(src) => (
        <img
          src={src()}
          alt=""
          draggable={false}
          style={{ width: `${size()}px`, height: `${size()}px`, "object-fit": "contain", opacity: props.opacity ?? 1, "flex-shrink": 0 }}
        />
      )}
    </Show>
  );
}
