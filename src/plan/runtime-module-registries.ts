/** Exact, config-declared rewrites for JSON runtime-module registries. */
import { posix } from "node:path";

import { PlanningError } from "./context.ts";
import type { PathMove } from "./manifest-operations.ts";
import type { PathReferenceRewriteMatch } from "./path-reference-rewrites.ts";

export interface RuntimeModuleRegistryDeclaration {
  readonly file: string;
  readonly pointer: string;
  readonly resolveFrom: string;
  readonly stripPrefix?: string;
}

interface PointerValue {
  readonly pointer: string;
  readonly value: string;
}

function unescapePointer(segment: string): string {
  return segment.replaceAll("~1", "/").replaceAll("~0", "~");
}

function escapePointer(segment: string): string {
  return segment.replaceAll("~", "~0").replaceAll("/", "~1");
}

function selectedValues(value: unknown, pattern: readonly string[], at: readonly string[] = []): PointerValue[] {
  if (pattern.length === 0) return typeof value === "string" ? [{ pointer: `/${at.map(escapePointer).join("/")}`, value }] : [];
  if (value === null || typeof value !== "object") return [];
  const [head, ...tail] = pattern;
  if (head === "*") {
    return Object.entries(value).flatMap(([key, child]) => selectedValues(child, tail, [...at, key]));
  }
  const key = unescapePointer(head!);
  return Object.prototype.hasOwnProperty.call(value, key) ? selectedValues((value as Record<string, unknown>)[key], tail, [...at, key]) : [];
}

function positionAt(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, offset);
  const lines = before.split("\n");
  return { line: lines.length, column: lines.at(-1)!.length + 1 };
}

function normalized(path: string): string {
  return posix.normalize(path).replace(/^\.\//, "");
}

function registryTarget(resolveFrom: string, target: string, prefix = ""): string {
  const relative = posix.relative(resolveFrom, target);
  if (prefix !== "") return `${prefix}${relative}`;
  const path = relative.startsWith(".") ? relative : `./${relative}`;
  return path;
}

/**
 * Parse only the declared JSON pointer pattern, then bind each selected value
 * to exactly one raw JSON string occurrence. Duplicate raw values refuse: a
 * pointer without an independently locatable byte span is not replay proof.
 */
export function scanRuntimeModuleRegistry(
  text: string,
  declaration: RuntimeModuleRegistryDeclaration,
  moves: readonly PathMove[],
): PathReferenceRewriteMatch[] {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    throw new PlanningError(`runtime module registry is not valid JSON: ${declaration.file}`);
  }
  const pattern = declaration.pointer.slice(1).split("/");
  const selected = selectedValues(document, pattern);
  const results: PathReferenceRewriteMatch[] = [];
  for (const entry of selected) {
    const encoded = JSON.stringify(entry.value);
    if (encoded.slice(1, -1) !== entry.value)
      throw new PlanningError(`runtime module registry value requires JSON escaping at ${declaration.file}${entry.pointer}`);
    const first = text.indexOf(encoded);
    if (first < 0 || text.indexOf(encoded, first + encoded.length) >= 0) {
      throw new PlanningError(`runtime module registry value is not byte-unique at ${declaration.file}${entry.pointer}`);
    }
    const stripped =
      declaration.stripPrefix === undefined
        ? entry.value
        : entry.value.startsWith(declaration.stripPrefix)
          ? entry.value.slice(declaration.stripPrefix.length)
          : null;
    if (stripped === null) throw new PlanningError(`runtime module registry value lacks configured prefix at ${declaration.file}${entry.pointer}`);
    const donorPath = normalized(posix.join(declaration.resolveFrom, stripped));
    const matching = moves.filter((move) => normalized(move.source) === donorPath);
    if (matching.length === 0) continue;
    if (matching.length !== 1) throw new PlanningError(`runtime module registry value matches multiple moves at ${declaration.file}${entry.pointer}`);
    const move = matching[0]!;
    const start = first + 1;
    const position = positionAt(text, start);
    results.push({
      from: entry.value,
      to: registryTarget(declaration.resolveFrom, move.target, declaration.stripPrefix),
      donor: move.source,
      line: position.line,
      column: position.column,
      jsonPointer: entry.pointer,
      resolutionBase: declaration.resolveFrom,
      ...(declaration.stripPrefix === undefined ? {} : { strippedPrefix: declaration.stripPrefix }),
      span: { start, end: first + encoded.length - 1 },
    });
  }
  return results.sort((left, right) => left.line - right.line || left.column - right.column);
}

export function expectedRuntimeModuleRegistryTarget(resolutionBase: string, moveTarget: string, strippedPrefix?: string): string {
  return registryTarget(resolutionBase, moveTarget, strippedPrefix);
}
