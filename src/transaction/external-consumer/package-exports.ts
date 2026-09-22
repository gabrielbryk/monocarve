import { existsSync } from "node:fs";
import { resolve } from "node:path";

/** First file target in an `exports` value, following condition objects and arrays. */
export function exportTarget(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(exportTarget).find((target) => target !== undefined);
  if (!value || typeof value !== "object") return undefined;
  const conditions = value as Record<string, unknown>;
  return ["types", "import", "default", "require"].map((key) => exportTarget(conditions[key])).find((target) => target !== undefined);
}

/** The `types` condition of an `exports` value, and only that. */
export function typesCondition(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  if (Array.isArray(value)) return value.map(typesCondition).find((target) => target !== undefined);
  const conditions = value as Record<string, unknown>;
  if (typeof conditions.types === "string") return conditions.types;
  return ["import", "default", "require"].map((key) => typesCondition(conditions[key])).find((target) => target !== undefined);
}

/** The `./sub` keys of an `exports` map; empty when the field is absent or bare. */
export function subpathExports(manifest: { readonly exports?: unknown } | undefined): Record<string, unknown> {
  const field = manifest?.exports;
  if (!field || typeof field !== "object" || Array.isArray(field)) return {};
  const record = field as Record<string, unknown>;
  return Object.keys(record).some((key) => key.startsWith(".")) ? record : {};
}

/** `types`, or its legacy `typings` alias, whichever the manifest declares. */
export function declaredTypings(manifest: { readonly types?: string } | undefined): string | undefined {
  if (manifest === undefined) return undefined;
  const typings = (manifest as { typings?: unknown }).typings;
  return manifest.types ?? (typeof typings === "string" ? typings : undefined);
}

/** An `exports` target resolved against its package root, when it exists on disk. */
export function resolveTarget(packageRoot: string, target: string | undefined): string | undefined {
  if (target === undefined) return undefined;
  const candidate = resolve(packageRoot, target);
  return existsSync(candidate) ? candidate : undefined;
}
