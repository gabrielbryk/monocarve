import { posix } from "node:path";

import { byCodeUnit } from "../util/hash.ts";
import { PlanningError } from "./context.ts";
import type { PathMove } from "./manifest-operations.ts";
import type { PathReferenceRewriteMatch } from "./path-reference-rewrites.ts";

export interface EmittedModuleSpecifierDeclaration {
  readonly source: string;
  readonly resolutionBase: string;
}

function normalized(path: string): string { return posix.normalize(path).replace(/^\.\//, ""); }
function targetFrom(output: string, target: string): string {
  const relative = posix.relative(posix.dirname(output), target);
  return relative.startsWith(".") ? relative : `./${relative}`;
}
function positionAt(text: string, offset: number): { line: number; column: number } {
  const lines = text.slice(0, offset).split("\n");
  return { line: lines.length, column: lines.at(-1)!.length + 1 };
}

/** Find exact quoted strings a generator emits as module specifiers. */
export function scanEmittedModuleSpecifiers(
  text: string,
  declaration: EmittedModuleSpecifierDeclaration,
  moves: readonly PathMove[],
): PathReferenceRewriteMatch[] {
  const results: PathReferenceRewriteMatch[] = [];
  const quoted = /(["'])([^"'\n\\]+)\1/g;
  for (const match of text.matchAll(quoted)) {
    const value = match[2]!;
    if (!value.startsWith(".")) continue;
    const donor = normalized(posix.join(posix.dirname(declaration.resolutionBase), value));
    const matching = moves.filter((move) => normalized(move.source) === donor);
    if (matching.length === 0) continue;
    if (matching.length !== 1) throw new PlanningError(`emitted module specifier matches multiple moves in ${declaration.source}: ${value}`);
    const move = matching[0]!;
    const start = match.index + 1;
    const position = positionAt(text, start);
    results.push({
      from: value,
      to: targetFrom(declaration.resolutionBase, move.target),
      donor: move.source,
      line: position.line,
      column: position.column,
      resolutionBase: declaration.resolutionBase,
      emittedModuleSpecifier: true,
      span: { start, end: start + value.length },
    });
  }
  return results.sort((left, right) => left.line - right.line || left.column - right.column || byCodeUnit(left.donor, right.donor));
}

export function expectedEmittedModuleSpecifierTarget(resolutionBase: string, moveTarget: string): string {
  return targetFrom(resolutionBase, moveTarget);
}
