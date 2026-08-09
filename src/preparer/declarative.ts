import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { hashBytes } from "../util/hash.ts";
import { workspacePath } from "../util/paths.ts";
import { PreparerError } from "./error.ts";

export type TextReplacement = { readonly path: string; readonly before: string; readonly after: string; readonly prefix?: string; readonly suffix?: string };
export type FileCreate = { readonly path: string; readonly contents: string; readonly mode: 0o644 | 0o755 };

export function applyFileCreates(root: string, creates: readonly FileCreate[]): void {
  for (const [index, create] of creates.entries()) {
    const absolute = workspacePath(root, create.path);
    if (existsSync(absolute)) {
      if (!statSync(absolute).isFile()) throw new PreparerError(`file create ${index + 1} path is not a file: ${create.path}`);
      const bytes = readFileSync(absolute);
      const mode = statSync(absolute).mode & 0o111 ? 0o755 : 0o644;
      if (hashBytes(bytes) !== hashBytes(Buffer.from(create.contents)) || mode !== create.mode) throw new PreparerError(`file create ${index + 1} found different existing content or mode: ${create.path}`);
      continue;
    }
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, create.contents, { mode: create.mode });
    chmodSync(absolute, create.mode);
  }
}

export function applyTextReplacements(root: string, replacements: readonly TextReplacement[]): void {
  for (const [index, replacement] of replacements.entries()) {
    const absolute = workspacePath(root, replacement.path);
    if (!existsSync(absolute) || !statSync(absolute).isFile()) throw new PreparerError(`text replacement ${index + 1} path is not a file: ${replacement.path}`);
    const contents = readFileSync(absolute, "utf8");
    const beforeState = framed(replacement, replacement.before);
    const afterState = framed(replacement, replacement.after);
    const first = contents.indexOf(beforeState);
    if (first >= 0) {
      if (contents.indexOf(beforeState, first + beforeState.length) >= 0) throw new PreparerError(`text replacement ${index + 1} before text is ambiguous in ${replacement.path}`);
      writeFileSync(absolute, `${contents.slice(0, first)}${afterState}${contents.slice(first + beforeState.length)}`);
      continue;
    }
    const terminalState = terminalReplacementAfter(replacements, index);
    if (uniqueOccurrence(contents, afterState) || uniqueOccurrence(contents, terminalState)) continue;
    throw new PreparerError(`text replacement ${index + 1} matched neither before nor after text in ${replacement.path}`);
  }
}

function terminalReplacementAfter(replacements: readonly TextReplacement[], index: number): string {
  const current = replacements[index]!;
  let terminal = current.after;
  for (const candidate of replacements.slice(index + 1)) if (candidate.path === current.path && candidate.prefix === current.prefix && candidate.suffix === current.suffix && candidate.before === terminal) terminal = candidate.after;
  return framed(current, terminal);
}
function framed(replacement: Pick<TextReplacement, "prefix" | "suffix">, text: string): string { return `${replacement.prefix ?? ""}${text}${replacement.suffix ?? ""}`; }
function uniqueOccurrence(contents: string, state: string): boolean { const first = contents.indexOf(state); return first >= 0 && contents.indexOf(state, first + state.length) < 0; }
