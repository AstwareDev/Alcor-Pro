import { effectRegistryAll } from "../../../preview/effects/effectRegistry";

// Swift `n(_:)`: integers print bare, others use %g.
function formatNumber(v: number): string {
  return v === Math.round(v) ? String(Math.trunc(v)) : String(Number(v.toPrecision(6)));
}

/** One line per non-color effect for apply_effect's description, generated from the registry. */
export function effectCatalog(): string {
  return effectRegistryAll
    .filter((d) => !d.id.startsWith("color."))
    .map((d) => {
      const params = d.params
        .map((p) => `${p.key} (${formatNumber(p.min)}…${formatNumber(p.max)}${p.unit}, default ${formatNumber(p.defaultValue)})`)
        .join(", ");
      return `• ${d.id} — ${d.displayName}: ${params === "" ? "no params" : params}`;
    })
    .join("\n");
}
