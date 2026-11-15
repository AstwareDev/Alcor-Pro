import { Show } from "solid-js";
import "./AlcorBrand.css";

export function AlcorBrand(props: { compact?: boolean }) {
  return (
    <span class="alcor-brand" classList={{ compact: props.compact }} role="img" aria-label="Alcor">
      <svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true">
        <path fill-rule="evenodd" clip-rule="evenodd" d="M108 50C116 34 139 34 147 50L226 207C229 213 225 218 218 218H183C178 218 175 216 173 211L156 177H101L84 211C82 216 79 218 74 218H39C32 218 28 213 31 207L108 50ZM111 91V140L151 115.5L111 91Z" />
        <path d="M205 32L209.5 46.5L224 51L209.5 55.5L205 70L200.5 55.5L186 51L200.5 46.5L205 32Z" />
      </svg>
      <Show when={!props.compact}><span class="alcor-brand-name">Alcor</span></Show>
    </span>
  );
}
