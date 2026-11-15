import { createSignal } from "solid-js";
import type { RoutingModelId } from "./promptRouter";

export interface RoutingModelInfo {
  id: RoutingModelId;
  displayName: string;
  vendor: string;
  /** Credential Manager secret the model needs; none for the built-in rules. */
  secret?: string;
  keyLabel?: string;
  description: string;
}

export const routingModels: readonly RoutingModelInfo[] = [
  { id: "rules", displayName: "Built-in rules", vendor: "Alcor Pro", description: "Keyword matching on this PC. Free and offline, but easier to confuse." },
  { id: "gemini-decision-1", displayName: "Gemini Decision 1", vendor: "Google", secret: "google", keyLabel: "Google", description: "Calibrated closed-set decisions. Uses your Google AI Studio key." },
  { id: "mercury-decide", displayName: "Mercury Decide", vendor: "Inception", secret: "inception", keyLabel: "Inception", description: "Fast decision model. Uses an Inception Platform key." },
  { id: "jev", displayName: "Jev 1.14", vendor: "TypeSafe", secret: "openrouter", keyLabel: "OpenRouter", description: "Decision model served through OpenRouter. Uses an OpenRouter key." },
];

const modelKey = "routing.model";
const askKey = "routing.askWhenUnsure";

const read = (key: string): string | null => {
  try { return typeof localStorage === "undefined" ? null : localStorage.getItem(key); } catch { return null; }
};
const write = (key: string, value: string): void => {
  try { if (typeof localStorage !== "undefined") localStorage.setItem(key, value); } catch { /* preference only */ }
};

const stored = read(modelKey);
const [routingModel, setRoutingModelSignal] = createSignal<RoutingModelId>(
  routingModels.some((m) => m.id === stored) ? (stored as RoutingModelId) : "rules",
);
const [askWhenUnsure, setAskSignal] = createSignal(read(askKey) !== "0");

export { askWhenUnsure, routingModel };

export function setRoutingModel(id: RoutingModelId): void {
  setRoutingModelSignal(id);
  write(modelKey, id);
}

export function setAskWhenUnsure(on: boolean): void {
  setAskSignal(on);
  write(askKey, on ? "1" : "0");
}

/** Below this confidence the bar asks which kind to make, when "Ask when unsure" is on. */
export const askThreshold = 0.55;
