// Generates docs/progress.svg and docs/architecture.svg. Run: node docs/progress.mjs
// Progress values are estimates of feature coverage relative to the macOS original; update them here.
import fs from "node:fs";

const areaList = [
  { name: "Data model & undo", pct: 100 },
  { name: "Timeline editing", pct: 95 },
  { name: "Preview & compositor", pct: 85 },
  { name: "Export", pct: 85 },
  { name: "Projects & home", pct: 85 },
  { name: "AI generation (own keys)", pct: 85 },
  { name: "Inspector", pct: 80 },
  { name: "Media panel", pct: 80 },
  { name: "Captions & transcription", pct: 80 },
  { name: "Agent tools (MCP)", pct: 95 },
  { name: "Settings", pct: 75 },
  { name: "On-canvas handles", pct: 90 },
  { name: "Multicam & sync", pct: 85 },
  { name: "Beats, silence, denoise", pct: 85 },
  { name: "Visual search", pct: 0 },
  { name: "Onboarding & samples", pct: 0 },
];

// Highest coverage first so the chart reads top-down.
export const areas = [...areaList].sort((a, b) => b.pct - a.pct);

const c = {
  surface: "#18191c", ink: "#f0efec", secondary: "#c3c2b7", muted: "#898781",
  grid: "#2c2c2a", baseline: "#383835", bar: "#3987e5",
};
const font = `font-family="Segoe UI, system-ui, -apple-system, sans-serif"`;
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

function progressSvg() {
  const W = 760, labelW = 210, left = 24 + labelW, right = 64, top = 76, row = 26, barH = 14;
  const plotW = W - left - right;
  const H = top + areas.length * row + 40;
  const x = (p) => left + (p / 100) * plotW;
  const overall = Math.round(areas.reduce((s, a) => s + a.pct, 0) / areas.length);
  const out = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-labelledby="t d">`);
  out.push(`<title id="t">Alcor Pro port progress</title><desc id="d">Estimated feature coverage relative to the macOS original, per area. Overall ${overall}%.</desc>`);
  out.push(`<rect width="${W}" height="${H}" rx="12" fill="${c.surface}"/>`);
  out.push(`<text x="24" y="34" ${font} font-size="18" font-weight="600" fill="${c.ink}">Port progress</text>`);
  out.push(`<text x="24" y="56" ${font} font-size="12" fill="${c.muted}">Estimated feature coverage vs. the macOS original · overall ${overall}%</text>`);
  for (const p of [0, 25, 50, 75, 100]) {
    const gx = x(p).toFixed(1);
    out.push(`<line x1="${gx}" y1="${top - 6}" x2="${gx}" y2="${top + areas.length * row}" stroke="${p === 0 ? c.baseline : c.grid}" stroke-width="1"/>`);
    out.push(`<text x="${gx}" y="${top + areas.length * row + 18}" ${font} font-size="11" fill="${c.muted}" text-anchor="middle">${p}%</text>`);
  }
  areas.forEach((a, i) => {
    const cy = top + i * row + row / 2;
    out.push(`<text x="${left - 12}" y="${cy + 4}" ${font} font-size="12.5" fill="${c.secondary}" text-anchor="end">${esc(a.name)}</text>`);
    const w = x(a.pct) - left;
    if (w > 0) {
      const r = Math.min(4, w), y0 = cy - barH / 2, x0 = left, x1 = left + w;
      out.push(`<path d="M${x0},${y0} H${x1 - r} Q${x1},${y0} ${x1},${y0 + r} V${y0 + barH - r} Q${x1},${y0 + barH} ${x1 - r},${y0 + barH} H${x0} Z" fill="${c.bar}"/>`);
    }
    out.push(`<text x="${x(a.pct) + 8}" y="${cy + 4}" ${font} font-size="11.5" fill="${a.pct === 0 ? c.muted : c.ink}">${a.pct}%</text>`);
  });
  out.push(`</svg>`);
  return out.join("\n");
}

function architectureSvg() {
  const W = 900, H = 520;
  const box = (x, y, w, h, title, lines, accent) => {
    const parts = [`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="#202125" stroke="${accent ?? "#3a3b40"}" stroke-width="1"/>`];
    parts.push(`<text x="${x + 14}" y="${y + 24}" ${font} font-size="13.5" font-weight="600" fill="${c.ink}">${esc(title)}</text>`);
    lines.forEach((l, i) => parts.push(`<text x="${x + 14}" y="${y + 44 + i * 17}" ${font} font-size="11.5" fill="${c.secondary}">${esc(l)}</text>`));
    return parts.join("\n");
  };
  const group = (x, y, w, h, label) =>
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="14" fill="none" stroke="${c.baseline}" stroke-dasharray="4 4"/>
<text x="${x + 14}" y="${y + 20}" ${font} font-size="11" letter-spacing="1.2" fill="${c.muted}">${esc(label.toUpperCase())}</text>`;
  const arrow = (x1, y1, x2, y2, label) =>
    `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${c.muted}" stroke-width="1.5" marker-end="url(#arrow)"/>` +
    (label ? `<text x="${(x1 + x2) / 2 + 6}" y="${(y1 + y2) / 2 - 4}" ${font} font-size="10.5" fill="${c.muted}">${esc(label)}</text>` : "");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-labelledby="at ad">
<title id="at">Alcor Pro architecture</title><desc id="ad">WebView2 front end (SolidJS) with the editor core, a thin Rust backend, and external AI providers and MCP clients.</desc>
<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${c.muted}"/></marker></defs>
<rect width="${W}" height="${H}" rx="12" fill="${c.surface}"/>
<text x="24" y="34" ${font} font-size="18" font-weight="600" fill="${c.ink}">Architecture</text>
${group(20, 52, 560, 448, "WebView2 · SolidJS + TypeScript")}
${box(36, 82, 250, 110, "UI panels", ["Home · Media · Preview · Inspector", "Timeline (canvas) · Prompt bar", "Export · Settings · Library"])}
${box(314, 82, 250, 110, "Editor core", ["DocumentStore (Immer, undo)", "Mutations — one per user intent", "Shared by UI and agent tools"], c.bar)}
${box(36, 222, 250, 120, "Rendering", ["Frame graph (pure)", "WebGL2 compositor + effect shaders", "WebCodecs decode · WebAudio"])}
${box(314, 222, 250, 120, "Export worker", ["mediabunny mux + WebCodecs encode", "H.264 · H.265 · VP9 · AAC", "FCPXML · Premiere XML"])}
${box(36, 372, 250, 110, "Agent tools", ["MCP tools, contracts identical", "to the original, plus masks", "Same mutations as the UI"])}
${box(314, 372, 250, 110, "AI providers", ["fal.ai · ElevenLabs · OpenAI", "Google · Replicate (own keys)", "Called from the prompt bar"])}
${group(600, 52, 280, 300, "Rust · Tauri 2")}
${box(616, 82, 248, 76, "Project I/O", ["Atomic writes · streaming export file"])}
${box(616, 168, 248, 76, "Secrets + HTTP proxy", ["Windows Credential Manager", "Keys never reach the webview"], c.bar)}
${box(616, 254, 248, 80, "MCP server", ["127.0.0.1:19789/mcp", "Streamable HTTP · SSE"])}
${group(600, 372, 280, 128, "Outside")}
${box(616, 400, 116, 82, "MCP clients", ["Claude Code", "Cursor · Codex"])}
${box(748, 400, 116, 82, "AI vendors", ["HTTPS APIs"])}
${arrow(286, 137, 312, 137)}
${arrow(439, 192, 161, 220)}
${arrow(439, 192, 439, 220)}
${arrow(161, 342, 161, 370)}
${arrow(286, 427, 312, 427)}
${arrow(564, 137, 614, 120)}
${arrow(564, 427, 614, 210)}
<polyline points="864,206 888,206 888,441 868,441" fill="none" stroke="${c.muted}" stroke-width="1.5" marker-end="url(#arrow)"/>
${arrow(674, 398, 674, 336)}
</svg>`;
}

fs.writeFileSync(new URL("./progress.svg", import.meta.url), progressSvg());
fs.writeFileSync(new URL("./architecture.svg", import.meta.url), architectureSvg());
console.log("wrote docs/progress.svg and docs/architecture.svg");
