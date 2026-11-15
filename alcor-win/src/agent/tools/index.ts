// Importing this module registers every ported tool group (each group calls `defineTools` itself).
import "./timelineTools";
import "./clipsGroup";
import "./textsGroup";
import "./mediaGroup";
import "./projectGroup";
import "./captureGroup";
import "./colorGroup";
import "./exportGroup";
import "./generationGroup";
import "./transcriptGroup";
import "./silenceGroup";
import "./metaGroup";
import "../../beats/beatsGroup";
import "../../denoise/denoiseGroup";
import "./multicamGroup";

export { ToolExecutor, agentToolHooks } from "./toolExecutor";
export type { ToolExecutorOptions, ToolSource } from "./toolExecutor";
export type { AgentHost, AgentHostProjectEntry } from "./agentHost";
export { projectSessionAgentHost } from "./agentHost";
export { defineTools, registeredTools, mcpServerTools, inAppAgentTools, onToolRegistryChange } from "./toolRegistry";
export type { ToolDefinition, ToolRegistration } from "./toolRegistry";
export { serverInstructions, projectNavigation, skillsSection } from "./agentInstructions";
import "./maskGroup";
import "./transitionGroup";
