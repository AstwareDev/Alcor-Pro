import type { Effect } from "../../model";

/** Seams to features outside this module (account / provider keys, color grading) that fill in later. */
export interface AgentToolHooks {
  /** `Self.canGenerate`: whether generation and upscale tools can run (reported by get_timeline). */
  canGenerate?: () => boolean;
  /** `Self.colorObject(from:)`: the clip's grade in apply_color vocabulary; undefined when ungraded. */
  colorObject?: (effects: readonly Effect[]) => Record<string, unknown> | undefined;
}

export const agentToolHooks: AgentToolHooks = {};
