export function formatNumber(value: number): string {
  return value.toFixed(1);
}

export function formatPercent(value: number): string {
  return `${(value * 100).toFixed(0)}%`;
}

/**
 * Registered when this module is evaluated, not when anything is called.
 *
 * Here on purpose, and it is the only reason this file is interesting. Nothing
 * in `apps/web` imports it: the widget closure reaches it by importing
 * `@acme/format`, whose entrypoint re-exports this module. So a moved file with
 * a spotless top level still causes this line to run, for every consumer the
 * extraction repoints at the new package — which is exactly what the evaluation
 * closure exists to find, and what a per-file scan of the moved set cannot see.
 */
export const registry = new Map<string, (value: number) => string>();

registry.set("number", formatNumber);
