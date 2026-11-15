import { createSignal, Show, type JSX } from "solid-js";
import { Dialog, type DialogButton } from "../ui/Dialog";

interface DialogState {
  title: string;
  message: string;
  buttons: DialogButton[];
}

export interface DialogHost {
  element: () => JSX.Element;
  alert(title: string, message: string): void;
  /** Resolves true when the destructive/confirm button is chosen. */
  confirm(options: { title: string; message: string; confirmLabel: string; destructive?: boolean }): Promise<boolean>;
}

/** One modal at a time; `element()` must be rendered once by the owner. */
export function createDialogHost(): DialogHost {
  const [state, setState] = createSignal<DialogState | null>(null);
  const close = () => setState(null);
  return {
    element: () => (
      <Show when={state()}>{(s) => <Dialog title={s().title} message={s().message} buttons={s().buttons} />}</Show>
    ),
    alert(title, message) {
      setState({ title, message, buttons: [{ label: "OK", role: "cancel", onClick: close }] });
    },
    confirm({ title, message, confirmLabel, destructive }) {
      return new Promise<boolean>((resolve) => {
        const answer = (value: boolean) => () => {
          close();
          resolve(value);
        };
        setState({
          title,
          message,
          buttons: [
            { label: "Cancel", role: "cancel", onClick: answer(false) },
            { label: confirmLabel, role: destructive ? "destructive" : undefined, onClick: answer(true) },
          ],
        });
      });
    },
  };
}
