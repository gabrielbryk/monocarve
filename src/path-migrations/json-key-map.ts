/**
 * Deterministically relocate path-keyed entries in a JSON object.
 *
 * This is a standard path-migration filter for ledgers whose values are
 * immutable history and whose object keys are repository-relative paths. It
 * deliberately moves only entries explicitly named by Monocarve's journal;
 * it never scans a worktree or guesses by content.
 */

import type { PathMigrationInput } from "../plan/path-migrations.ts";

function objectAtPointer(value: unknown, pointer: string): Record<string, unknown> {
  if (!pointer.startsWith("/")) throw new Error(`JSON pointer must start with '/': ${pointer}`);
  let current: unknown = value;
  for (const segment of pointer.slice(1).split("/")) {
    const key = segment.replaceAll("~1", "/").replaceAll("~0", "~");
    if (typeof current !== "object" || current === null || Array.isArray(current) || !(key in current)) {
      throw new Error(`JSON pointer does not resolve to an object: ${pointer}`);
    }
    current = (current as Record<string, unknown>)[key];
  }
  if (typeof current !== "object" || current === null || Array.isArray(current)) {
    throw new Error(`JSON pointer does not resolve to an object: ${pointer}`);
  }
  return current as Record<string, unknown>;
}

export function relocateJsonObjectKeys(input: PathMigrationInput, pointer: string): string {
  let document: unknown;
  try {
    document = JSON.parse(input.contents) as unknown;
  } catch (error) {
    throw new Error(`path-keyed artifact ${input.artifact} is not JSON: ${(error as Error).message}`, { cause: error });
  }
  const entries = objectAtPointer(document, pointer);
  for (const { source, target } of input.moves) {
    if (!(source in entries)) continue;
    if (target in entries) throw new Error(`${input.artifact}: destination key already exists: ${target}`);
    entries[target] = entries[source];
    delete entries[source];
  }
  return `${JSON.stringify(document, null, 2)}\n`;
}

if (import.meta.main) {
  const pointer = process.argv[2];
  if (pointer === undefined) throw new Error("usage: json-key-map.ts /json/pointer");
  const input = JSON.parse(await Bun.stdin.text()) as PathMigrationInput;
  process.stdout.write(relocateJsonObjectKeys(input, pointer));
}
