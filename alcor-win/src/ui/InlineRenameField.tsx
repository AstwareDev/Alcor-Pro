import { onMount } from "solid-js";
import "./InlineRenameField.css";

/** Port of `InlineRenameField`: commit on Enter or blur, Esc cancels, empty or unchanged input cancels. */
export function InlineRenameField(props: {
  originalName: string;
  placeholder?: string;
  maximumLength?: number;
  allowsEmptyCommit?: boolean;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  let input!: HTMLInputElement;
  let finished = false;

  const commit = () => {
    if (finished) return;
    finished = true;
    const trimmed = input.value.trim();
    if (trimmed === props.originalName || (trimmed === "" && !props.allowsEmptyCommit)) props.onCancel();
    else props.onCommit(trimmed);
  };
  const cancel = () => {
    if (finished) return;
    finished = true;
    props.onCancel();
  };

  onMount(() => {
    input.focus();
    input.select();
  });

  return (
    <input
      ref={input}
      class="inline-rename"
      value={props.originalName}
      placeholder={props.placeholder}
      maxLength={props.maximumLength}
      spellcheck={false}
      onClick={(e) => e.stopPropagation()}
      onDblClick={(e) => e.stopPropagation()}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") commit();
        else if (e.key === "Escape") cancel();
      }}
    />
  );
}
