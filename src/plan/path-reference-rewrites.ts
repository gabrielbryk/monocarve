/**
 * Rewriting a path-shaped token in a non-source document to point at where a
 * moved file landed.
 *
 * `path-references.ts` answers "might this string name a moved file" and
 * refuses to guess further, because its corpus is unbounded and a wrong guess
 * would corrupt a file the engine has no proof it understands. This module
 * asks a narrower question over a narrower corpus: given a document explicitly
 * enrolled by `pathReferenceRewrites.roots`, does an *exact* path-shaped token
 * name a moved source, and if so what is the one byte-for-byte edit that keeps
 * it true. Narrower corpus, narrower claim, so it may act instead of warn.
 *
 * What this deliberately does not do: it does not touch source modules — a
 * `.ts`/`.tsx` file's own literals are `rewriteStaticFsReference`'s and the
 * import codemod's job, both already provably resolvable, and that boundary
 * is enforced by config (`roots`/`extensions`), not here. It does not do
 * fuzzy or substring matching — a token either equals a moved path, or (for
 * an absolute token) ends with one at a segment boundary, or it is untouched.
 * And an empty {@link PathReferenceScan} is not proof nothing references a
 * moved file: a path built by concatenation or interpolation is as invisible
 * here as it is to `path-references.ts`.
 *
 * `minSegments` exists for the same reason it exists in `path-references.ts`:
 * a short path like `src/index.ts` is far more likely a coincidence than a
 * reference. The scanner refuses to even index — let alone warn about — a
 * literal below its floor, so this engine must refuse to rewrite a move whose
 * source is below the same floor. Skipping such a move is not an ambiguity;
 * it is simply out of corpus, exactly as the scanner treats it.
 */

import { existsSync, realpathSync } from "node:fs";
import { dirname, extname, posix, resolve, sep } from "node:path";

import { applyReplacements, type Replacement } from "../codemod/imports.ts";
import { byCodeUnit } from "../util/hash.ts";
import { PlanningError } from "./context.ts";
import type { PathMove } from "./manifest-operations.ts";
import { normalizeToken, PATH_TOKEN, segmentCount, stripExtension } from "./path-tokens.ts";

interface PathReferenceRewrite {
  readonly from: string;
  readonly to: string;
  readonly donor: string;
  readonly line: number;
  readonly column: number;
  readonly jsonPointer?: string;
  readonly resolutionBase?: string;
  readonly strippedPrefix?: string;
  /** This string is emitted by a generator and resolves from `resolutionBase`. */
  readonly emittedModuleSpecifier?: true;
  readonly referenceBase?: string;
}

export interface PathReferenceRewriteSettings {
  readonly onAmbiguousMatch: "refuse" | "skip";
  readonly matchExtensionless: boolean;
  readonly minSegments: number;
  readonly referenceBase?: string;
  readonly workspaceRoot?: string;
}

export interface PathReferenceRewriteMatch extends PathReferenceRewrite {
  readonly span: { readonly start: number; readonly end: number };
}

interface PathReferenceAmbiguity {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly token: string;
  readonly reason: string;
  readonly donors: readonly string[];
}

export interface PathReferenceScan {
  readonly rewrites: readonly PathReferenceRewriteMatch[];
  readonly skipped: readonly PathReferenceAmbiguity[];
}

interface Candidate {
  readonly span: { readonly start: number; readonly end: number };
  readonly line: number;
  readonly column: number;
  readonly from: string;
  readonly to: string;
  readonly donor: string;
  readonly referenceBase?: string;
}

export function documentKindFor(file: string): "markdown" | "json" | "plain-text" {
  const extension = extname(file);
  if (extension === ".md" || extension === ".markdown") return "markdown";
  if (extension === ".json") return "json";
  return "plain-text";
}

function lineStartsOf(text: string): number[] {
  const starts = [0];
  for (let index = text.indexOf("\n"); index >= 0; index = text.indexOf("\n", index + 1)) starts.push(index + 1);
  return starts;
}

function positionAt(lineStarts: readonly number[], offset: number): { line: number; column: number } {
  let line = 0;
  while (line + 1 < lineStarts.length && lineStarts[line + 1]! <= offset) line += 1;
  return { line: line + 1, column: offset - lineStarts[line]! + 1 };
}

function matchedSuffixLength(path: string, absolute: boolean, target: string): number | null {
  const targetSegments = target.split("/");
  if (path === target) return targetSegments.length;
  if (!absolute) return null;
  const pathSegments = path.split("/");
  if (pathSegments.length < targetSegments.length) return null;
  const suffix = pathSegments.slice(pathSegments.length - targetSegments.length).join("/");
  return suffix === target ? targetSegments.length : null;
}

/**
 * Where the matched suffix begins inside the raw token, in the raw token's
 * own byte coordinates. `prefixLength` already accounts for every byte
 * `normalizeToken` peeled off the front ("https://", "./", a doubled leading
 * slash, ...); what remains is finding how far *into* the normalized core
 * the untouched leading segments extend, which is just their combined
 * length plus one separator per segment. Both numbers are added in the same
 * coordinate space raw and normalized share (see `normalizeToken`'s doc), so
 * the sum indexes `rawToken` directly — nothing here is reconstructed.
 */
function suffixOffsetInRawToken(normalizedPath: string, prefixLength: number, suffixLength: number): number {
  const segments = normalizedPath.split("/");
  const untouchedSegments = segments.slice(0, segments.length - suffixLength);
  const coreOffset = untouchedSegments.length === 0 ? 0 : untouchedSegments.join("/").length + 1;
  return prefixLength + coreOffset;
}

/**
 * The replacement text for the matched suffix ALONE — never a reconstructed
 * whole token. Every byte before the suffix (a URL scheme, "./", a doubled
 * leading slash, mixed separators) is not this function's business; the
 * caller narrows the replaced span so those bytes are simply never touched.
 * The suffix keeps the raw token's own separator style ("\\" stays
 * backslashed) but nothing else about the original prefix is consulted.
 */
function buildReplacementSuffix(rawToken: string, replacementTarget: string): string {
  const separator = rawToken.includes("\\") ? "\\" : "/";
  return replacementTarget.split("/").join(separator);
}

/**
 * The exact forward computation {@link candidatesForToken} uses to turn a
 * matched token into its replacement, exposed so a validator can check a
 * recorded rewrite's `to` against a specific move's real target instead of
 * re-deriving a move from the recorded `to` (which would only prove the
 * rewrite agrees with itself). Returns null when `rawToken` cannot name
 * `moveSource` at all (wrong shape, or too short a suffix), matching
 * `candidatesForToken`'s own "no candidate" case.
 */
export function expectedPathReferenceTarget(rawToken: string, moveSource: string, moveTarget: string, referenceBase?: string): string | null {
  const normalized = normalizeToken(rawToken, { allowParentSegments: referenceBase !== undefined });
  if (normalized === null) return null;
  const hasExtension = normalized.path.split("/").at(-1)!.includes(".");
  const target = hasExtension ? moveSource : stripExtension(moveSource);
  if (referenceBase !== undefined) {
    if (normalized.absolute) return null;
    const based = posix.normalize(posix.join(referenceBase, normalized.path));
    if (based === ".." || based.startsWith("../") || based !== target) return null;
    return basedReplacement(rawToken, referenceBase, hasExtension ? moveTarget : stripExtension(moveTarget));
  }
  const suffixLength = matchedSuffixLength(normalized.path, normalized.absolute, target);
  if (suffixLength === null) return null;
  const replacementTarget = hasExtension ? moveTarget : stripExtension(moveTarget);
  return buildReplacementSuffix(rawToken, replacementTarget);
}

function candidatesForToken(
  rawToken: string,
  span: { readonly start: number; readonly end: number },
  lineStarts: readonly number[],
  moves: readonly PathMove[],
  matchExtensionless: boolean,
  referenceBase?: string,
): Candidate[] {
  const normalized = normalizeToken(rawToken, { allowParentSegments: referenceBase !== undefined });
  if (normalized === null) return [];
  const hasExtension = normalized.path.split("/").at(-1)!.includes(".");
  if (!hasExtension && !matchExtensionless) return [];
  const { line, column } = positionAt(lineStarts, span.start);
  const candidates: Candidate[] = [];
  for (const move of moves) {
    const source = hasExtension ? move.source : stripExtension(move.source);
    const directSuffixLength = referenceBase !== undefined && normalized.absolute ? null : matchedSuffixLength(normalized.path, normalized.absolute, source);
    const basedSource = referenceBase === undefined || normalized.absolute ? null : posix.normalize(posix.join(referenceBase, normalized.path));
    const based = basedSource === source && basedSource !== ".." && !basedSource.startsWith("../");
    const suffixLength = directSuffixLength ?? (based ? normalized.path.split("/").length : null);
    if (suffixLength === null) continue;
    const replacementTarget = hasExtension ? move.target : stripExtension(move.target);
    // Narrow the replaced span to exactly the matched suffix so every byte
    // before it — a URL scheme, "./", a doubled leading slash, mixed
    // separators — survives untouched instead of being reconstructed.
    const suffixStart = span.start + suffixOffsetInRawToken(normalized.path, normalized.prefixLength, suffixLength);
    const matchedSpan = directSuffixLength === null && based ? span : { start: suffixStart, end: span.end };
    const to =
      directSuffixLength === null && based
        ? basedReplacement(rawToken, referenceBase!, replacementTarget)
        : buildReplacementSuffix(rawToken, replacementTarget);
    candidates.push({
      span: matchedSpan,
      line,
      column,
      from: rawToken,
      to,
      donor: move.source,
      ...(directSuffixLength === null && based ? { referenceBase: referenceBase! } : {}),
    });
  }
  return candidates;
}

function basedReplacement(rawToken: string, referenceBase: string, moveTarget: string): string {
  const normalizedRaw = rawToken.replaceAll("\\", "/");
  if (!normalizedRaw.startsWith("./") && !normalizedRaw.startsWith("../")) return buildReplacementSuffix(rawToken, moveTarget);
  let relative = posix.relative(referenceBase, moveTarget);
  if (normalizedRaw.startsWith("./") && !relative.startsWith(".")) relative = `./${relative}`;
  return buildReplacementSuffix(rawToken, relative);
}

function isRealWorkspacePath(workspaceRoot: string, path: string): boolean {
  const root = realpathSync(workspaceRoot);
  let probe = resolve(workspaceRoot, path);
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) return false;
    probe = parent;
  }
  const actual = realpathSync(probe);
  return actual === root || actual.startsWith(root + sep);
}

function distinctResolutions(group: readonly Candidate[]): Candidate[] {
  const seen = new Map<string, Candidate>();
  for (const candidate of group) seen.set(`${candidate.donor} ${candidate.to} ${candidate.referenceBase ?? "<repo>"}`, candidate);
  return [...seen.values()];
}

function ambiguityFor(file: string, candidate: Candidate, donors: readonly string[], reason: string): PathReferenceAmbiguity {
  return { file, line: candidate.line, column: candidate.column, token: candidate.from, reason, donors: [...donors].toSorted(byCodeUnit) };
}

function sortByPosition<T extends { readonly line: number; readonly column: number }>(items: readonly T[], tiebreak: (item: T) => string): T[] {
  return [...items].toSorted((left, right) => left.line - right.line || left.column - right.column || byCodeUnit(tiebreak(left), tiebreak(right)));
}

function resolveSpan(file: string, group: readonly Candidate[], ambiguities: PathReferenceAmbiguity[]): PathReferenceRewriteMatch | null {
  const distinct = distinctResolutions(group);
  if (distinct.length === 1) return { ...distinct[0]! };
  const donors = distinct.map((candidate) => candidate.donor);
  for (const candidate of distinct) ambiguities.push(ambiguityFor(file, candidate, donors, "token matches multiple moved sources"));
  return null;
}

function resolveReplacementCollisions(
  file: string,
  resolved: readonly PathReferenceRewriteMatch[],
  ambiguities: PathReferenceAmbiguity[],
): PathReferenceRewriteMatch[] {
  const byReplacement = new Map<string, PathReferenceRewriteMatch[]>();
  for (const match of resolved) {
    const bucket = byReplacement.get(match.to) ?? [];
    bucket.push(match);
    byReplacement.set(match.to, bucket);
  }
  const rewrites: PathReferenceRewriteMatch[] = [];
  for (const bucket of byReplacement.values()) {
    const donors = [...new Set(bucket.map((match) => match.donor))];
    if (donors.length === 1) {
      rewrites.push(...bucket);
      continue;
    }
    for (const match of bucket) {
      ambiguities.push(ambiguityFor(file, match, donors, "would produce the same replacement token as another moved source in this file"));
    }
  }
  return rewrites;
}

/**
 * Scan `text` for tokens naming any of `moves`' sources. Ambiguity — a token
 * matching two sources, two sources producing the same replacement, or one
 * position resolving two ways — is reported in `skipped`; unless
 * `settings.onAmbiguousMatch === "skip"`, the first is also a {@link PlanningError}.
 */
export function scanPathReferenceRewrites(text: string, file: string, moves: readonly PathMove[], settings: PathReferenceRewriteSettings): PathReferenceScan {
  const lineStarts = lineStartsOf(text);
  const ambiguities: PathReferenceAmbiguity[] = [];
  const resolved: PathReferenceRewriteMatch[] = [];
  // A move whose source is shorter than minSegments is out of corpus, not an
  // ambiguity: the scanner would never have warned about a token this short,
  // so the rewriter must never act on one either. See module comment.
  const eligibleMoves = moves.filter((move) => segmentCount(move.source) >= settings.minSegments);
  for (const match of text.matchAll(PATH_TOKEN)) {
    const span = { start: match.index, end: match.index + match[0].length };
    const candidates = candidatesForToken(match[0], span, lineStarts, eligibleMoves, settings.matchExtensionless, settings.referenceBase).filter(
      (candidate) =>
        candidate.referenceBase === undefined || settings.workspaceRoot === undefined || isRealWorkspacePath(settings.workspaceRoot, candidate.donor),
    );
    if (candidates.length === 0) continue;
    const winner = resolveSpan(file, candidates, ambiguities);
    if (winner) resolved.push(winner);
  }

  const rewrites = resolveReplacementCollisions(file, resolved, ambiguities);
  const scan: PathReferenceScan = {
    rewrites: sortByPosition(rewrites, (match) => match.donor),
    skipped: sortByPosition(ambiguities, (ambiguity) => ambiguity.token),
  };
  if (settings.onAmbiguousMatch === "refuse" && scan.skipped.length > 0) {
    const first = scan.skipped[0]!;
    throw new PlanningError(
      `ambiguous path reference in ${file}:${first.line}:${first.column} — ${first.reason} (${JSON.stringify(first.token)}, donors: ${first.donors.join(", ")})`,
    );
  }
  return scan;
}

export function rewritePathReferenceText(text: string, matches: readonly PathReferenceRewriteMatch[]): string {
  const replacements: Replacement[] = matches.map((match) => ({ start: match.span.start, end: match.span.end, text: match.to }));
  return applyReplacements(text, replacements);
}
