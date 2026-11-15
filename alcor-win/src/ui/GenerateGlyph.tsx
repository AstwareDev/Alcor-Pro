import "./GenerateGlyph.css";

/** Alcor's mark for generating: a bright star with its small companion on an orbit. `working` sets it in motion. */
export function GenerateGlyph(props: { size?: number; working?: boolean; done?: boolean }) {
  return (
    <svg
      class="gen-glyph"
      classList={{ working: props.working === true, done: props.done === true }}
      width={props.size ?? 16}
      height={props.size ?? 16}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path class="gen-glyph-orbit" d="M5.1 17A8.6 8.6 0 0 0 17.8 13.6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
      <path class="gen-glyph-star" d="M10 2.8C10.7 7.3 12.7 9.3 17.2 10C12.7 10.7 10.7 12.7 10 17.2C9.3 12.7 7.3 10.7 2.8 10C7.3 9.3 9.3 7.3 10 2.8Z" />
      <path class="gen-glyph-moon" d="M17.7 3.7C17.95 5.3 18.5 5.85 20.1 6.1C18.5 6.35 17.95 6.9 17.7 8.5C17.45 6.9 16.9 6.35 15.3 6.1C16.9 5.85 17.45 5.3 17.7 3.7Z" />
    </svg>
  );
}
