import { For, onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";
import { CapsuleButton } from "./CapsuleButton";
import "./Dialog.css";

export interface DialogButton {
  label: string;
  onClick: () => void;
  role?: "cancel" | "destructive";
}

/** Modal alert (NSAlert / SwiftUI `.alert`): title, message, right-aligned buttons. Esc triggers the cancel button. */
export function Dialog(props: { title: string; message: string; buttons: DialogButton[] }) {
  const cancel = () => props.buttons.find((b) => b.role === "cancel") ?? props.buttons[props.buttons.length - 1];

  onMount(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        cancel()?.onClick();
      }
    };
    document.addEventListener("keydown", key, true);
    onCleanup(() => document.removeEventListener("keydown", key, true));
  });

  return (
    <Portal>
      <div class="dialog-scrim">
        <div class="dialog" role="alertdialog" aria-modal="true" aria-label={props.title}>
          <div class="dialog-title">{props.title}</div>
          <div class="dialog-message">{props.message}</div>
          <div class="dialog-buttons">
            <For each={props.buttons}>
              {(b) => (
                <CapsuleButton
                  size="regular"
                  variant={b.role === "cancel" ? "secondary" : "prominent"}
                  fill={b.role === "destructive" ? "var(--status-error)" : undefined}
                  ref={(el: HTMLButtonElement) => {
                    if (b === props.buttons[props.buttons.length - 1]) queueMicrotask(() => el.focus());
                  }}
                  onClick={b.onClick}
                >
                  {b.label}
                </CapsuleButton>
              )}
            </For>
          </div>
        </div>
      </div>
    </Portal>
  );
}
