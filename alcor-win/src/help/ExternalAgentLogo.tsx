// Port of UI/ExternalAgentLogo.swift. The macOS app bundles PNG logos; here a neutral letter badge stands in.
export type ExternalAgent = "claude" | "codex" | "cursor";

const letters: Record<ExternalAgent, string> = { claude: "C", codex: "X", cursor: "▲" };

export function ExternalAgentLogo(props: { agent: ExternalAgent; size?: number }) {
  const size = (): string => `${props.size ?? 28}px`;
  return (
    <span class="external-agent-logo" style={{ width: size(), height: size() }} aria-hidden="true">
      {letters[props.agent]}
    </span>
  );
}
