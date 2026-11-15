import { splitProps, type JSX } from "solid-js";
import "./CapsuleButton.css";

/** Port of `CapsuleButtonStyle`. `fill` overrides the variant background (a CSS color or variable). */
export function CapsuleButton(
  props: {
    variant?: "secondary" | "prominent";
    size?: "small" | "regular";
    fill?: string;
  } & JSX.ButtonHTMLAttributes<HTMLButtonElement>,
) {
  const [own, rest] = splitProps(props, ["variant", "size", "fill", "class", "style"]);
  return (
    <button
      type="button"
      {...rest}
      class={`capsule-button ${own.variant ?? "secondary"} ${own.size ?? "small"} ${own.class ?? ""}`}
      style={{ ...(typeof own.style === "object" ? own.style : {}), ...(own.fill ? { "--capsule-fill": own.fill } : {}) }}
    />
  );
}
