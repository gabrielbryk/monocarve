import { existsSync, readFileSync } from "node:fs";

import { showBaselineBytes } from "../util/git.ts";
import { hashBytes, hashText, MISSING, type FileState } from "../util/hash.ts";
import { workspacePath } from "../util/paths.ts";
import type { PreparationReplayOperation } from "./manifest-types.ts";

/** Independent byte and source-absence proofs for generated-source adoption. */
export function verifyGeneratedSourceOperations(rootDir: string, baseline: string, operations: readonly PreparationReplayOperation[], failures: string[]): void {
  for (const operation of operations) {
    if (operation.kind === "adopt-generated-source") {
      verifyBaseline(rootDir, baseline, operation.file.path, operation.file.preconditionHash, failures);
      if (showBaselineBytes(rootDir, baseline, operation.declaredSource) !== null) failures.push(`declared generated source still exists: ${operation.declaredSource}`);
      const bytes = showBaselineBytes(rootDir, baseline, operation.file.path);
      if (bytes !== null) {
        const removed = leadingLines(new TextDecoder().decode(bytes), operation.removedHeader.lines);
        if (hashText(removed.header) !== operation.removedHeader.hash || removed.rest !== operation.contents) failures.push(`generated-source adoption recipe does not reproduce ${operation.file.path}`);
      }
      verifyCurrent(rootDir, operation.file.path, operation.file.resultHash, failures);
    }
    if (operation.kind === "delete-generated-source-generator") {
      verifyBaseline(rootDir, baseline, operation.file.path, operation.file.preconditionHash, failures);
      verifyCurrent(rootDir, operation.file.path, MISSING, failures);
    }
  }
}

function verifyBaseline(rootDir: string, baseline: string, path: string, expected: FileState, failures: string[]): void {
  const bytes = showBaselineBytes(rootDir, baseline, path);
  const actual = bytes === null ? MISSING : hashBytes(bytes);
  if (actual !== expected) failures.push(`baseline state differs: ${path} (expected ${expected}, got ${actual})`);
}

function verifyCurrent(rootDir: string, path: string, expected: FileState, failures: string[]): void {
  const absolute = workspacePath(rootDir, path);
  const actual = existsSync(absolute) ? hashBytes(readFileSync(absolute)) : MISSING;
  if (actual !== expected) failures.push(`landed bytes differ: ${path} (expected ${expected}, got ${actual})`);
}

function leadingLines(text: string, count: number): { header: string; rest: string } {
  let end = 0;
  for (let index = 0; index < count; index += 1) { const newline = text.indexOf("\n", end); end = newline < 0 ? text.length : newline + 1; }
  return { header: text.slice(0, end), rest: text.slice(end) };
}
