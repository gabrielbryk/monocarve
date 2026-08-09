/**
 * Files named by a path written as a string, as opposed to files named by an
 * import.
 *
 * Why this exists: a test read a source file with
 * `readFileSync("<app>/src/<feature>/protocol.ts")` — the path as a string,
 * never imported. That reference is invisible to every import graph, so the
 * module was correctly absent from the closure, correctly not a containment
 * violation, and correctly not rewritten by any codemod. The extraction was
 * sound and the test still failed with ENOENT the moment the file moved,
 * because nothing in the pipeline was looking at strings. The engine's analysis
 * was not wrong; it was answering a different question.
 *
 * ## What this is, exactly
 *
 * A **heuristic risk inventory, not a proof, in either direction.**
 *
 * It cannot be complete: a path can be concatenated, interpolated, joined from
 * segments, read out of a config file, or computed at runtime, and none of
 * those reach the scanner as one contiguous string. It cannot be sound either:
 * a literal that happens to reproduce a path is not necessarily a reference to
 * that file — it may be a fixture name, a log line, a route, or a path in some
 * other tree entirely.
 *
 * So per the agent contract's proof discipline, stated before anything is built
 * on it: **an empty result is not "nothing references this file by path."** It
 * means "no string literal in the scanned corpus reproduced this path under the
 * rule below". This check cannot fail on a plausible bug — a workspace that
 * builds its paths one segment at a time defeats it entirely, and it will still
 * come back empty and green. It is a warning, never a rejection, and nothing
 * downstream may treat its silence as evidence.
 *
 * ## The rule
 *
 * Text is reduced to *path-shaped tokens*: maximal runs of `[A-Za-z0-9_@.-]`,
 * `/` and `\` containing at least one separator. A token is normalized —
 * backslashes to slashes, leading `./` removed, trailing `/` removed — and then
 * matched against a moved path P two ways:
 *
 *  - **path form**: the normalized token equals P. An *absolute* token (one
 *    that began with `/`) also matches when it ends with P at a segment
 *    boundary, since an absolute path is the one form that legitimately carries
 *    a prefix nobody in the repository wrote.
 *  - **stem form**: the token equals P without its extension, and the token's
 *    own last segment carries no dot. That second condition is what keeps
 *    `apps/web/src/widgets/chart.tsx` from matching `…/chart.ts`.
 *
 * Equality rather than "ends with" is the false-positive boundary, and it is
 * chosen deliberately: `dist/apps/web/src/widgets/chart.ts` and
 * `vendor/apps/web/src/widgets/chart.ts` are *different files* that a suffix
 * rule would report as references to the moved one. Build output mirrors source
 * layout, so that is not a hypothetical. `pathReferences.minSegments` is the
 * second boundary: a path short enough to be a coincidence (`src/index.ts`) is
 * not indexed and never reported.
 *
 * ## What is scanned
 *
 *  - Every first-party source module — applications, package roots, declared
 *    first-party roots — **parsed**, with only string literals and untagged
 *    no-substitution templates considered. Parsing rather than grepping is what
 *    lets the scan skip module specifiers (`import … from "…"`, `require(…)`,
 *    `import(…)`, `import type … from "…"`): those are import edges, the graph
 *    already sees them, the codemod already rewrites them, and reporting them
 *    here would be a second warning about a case that is already handled.
 *    Parsing also means a path mentioned in a *comment* is not a finding, which
 *    it should not be — a comment does not stop resolving.
 *  - Trees named by `pathReferences.textRoots`, read as raw text, for the
 *    extensions that config lists. Empty by default. Shell scripts, CI config
 *    and task definitions are where paths live outside source, but reading
 *    arbitrary trees byte-for-byte costs time and buys noise, so a workspace
 *    opts in to the ones it knows about rather than the engine guessing.
 *
 * Everything else is out of the corpus and is a known blind spot: documentation,
 * lockfiles, JSON and YAML that no `textRoots` entry names, generated output,
 * anything in `node_modules`, and any file above `pathReferences.maxBytes`.
 *
 * ## Constructs it knowingly misses, on the record
 *
 * `"apps/web/src/" + name`, `` `${dir}/chart.ts` ``, `join("apps", "web",
 * "src")`, a path assembled from a constant declared elsewhere, a path read out
 * of a JSON config, a glob or bare directory (`apps/web/src/widgets/**`) that
 * covers the moved file without naming it, a relative literal (`../chart.ts`)
 * whose base this scanner has no way to resolve, and any moved path with fewer
 * than `minSegments` segments.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, posix, resolve } from "node:path";

import ts from "typescript";

import type { PathReferencesConfig } from "../config.ts";
import { byCodeUnit } from "../util/hash.ts";
import type { WorkspaceContext } from "./context.ts";
import { keysFor, normalizeToken, PATH_TOKEN, segmentCount, stripExtension } from "./path-tokens.ts";

/** How a literal named the path: with its extension, or without. */
export type PathReferenceForm = "path" | "stem";

/** One string literal that names one moved path. */
export interface PathReference {
  /** File containing the literal, workspace-relative. */
  readonly file: string;
  /** 1-based line of the literal (of the literal, not of the token inside it). */
  readonly line: number;
  /** 1-based column of the literal. */
  readonly column: number;
  /** The moved path the literal names. */
  readonly target: string;
  readonly form: PathReferenceForm;
  /** The path-shaped token as normalized, for a message a human can act on. */
  readonly text: string;
}

/** Where one path-shaped token was found. Keyed by the token in the index. */
interface Occurrence {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly text: string;
}

/**
 * Repo-wide index of path-shaped tokens, built once and queried per candidate.
 *
 * The shape matters as much as the content: `portfolio` ranks every candidate
 * in an application and closures overlap heavily, so a scan per candidate would
 * re-read the repository dozens of times to answer a question whose corpus
 * never changes. One pass, then map lookups.
 */
export class PathReferenceIndex {
  constructor(
    /** Token with extension -> occurrences. */
    private readonly byPath: ReadonlyMap<string, readonly Occurrence[]>,
    /** Token without extension -> occurrences. */
    private readonly byStem: ReadonlyMap<string, readonly Occurrence[]>,
    /**
     * How many files this index read. Diagnostics — and the one observable that
     * distinguishes "scanned once" from "scanned per candidate".
     */
    readonly filesScanned: number,
    private readonly settings: PathReferencesConfig,
  ) {}

  /** An index over nothing. What a disabled scan returns. */
  static empty(settings: PathReferencesConfig): PathReferenceIndex {
    return new PathReferenceIndex(new Map(), new Map(), 0, settings);
  }

  /**
   * Every literal naming any of `paths`, sorted by file then position.
   *
   * Sorted rather than returned in index order because a candidate's warning
   * quotes the first entry, and "first" has to mean the same thing on every
   * machine — the determinism invariant reaches anything a plan or a report
   * derives from this.
   */
  referencesTo(paths: Iterable<string>): PathReference[] {
    const found: PathReference[] = [];
    for (const target of new Set(paths)) {
      if (segmentCount(target) < this.settings.minSegments) continue;
      for (const occurrence of this.byPath.get(target) ?? []) {
        found.push({ ...occurrence, target, form: "path" });
      }
      if (!this.settings.matchExtensionless) continue;
      for (const occurrence of this.byStem.get(stripExtension(target)) ?? []) {
        found.push({ ...occurrence, target, form: "stem" });
      }
    }
    return found.sort(
      (left, right) =>
        byCodeUnit(left.file, right.file) ||
        left.line - right.line ||
        left.column - right.column ||
        byCodeUnit(left.target, right.target),
    );
  }
}

/**
 * Scan the workspace once.
 *
 * Source files go through {@link WorkspaceContext.parsedSource}, which caches,
 * so a file another planning stage has already parsed costs nothing here and a
 * file this scan parses first is free for the stage that comes after it.
 */
export function buildPathReferenceIndex(context: WorkspaceContext): PathReferenceIndex {
  const settings = context.config.pathReferences;
  if (!settings.enabled) return PathReferenceIndex.empty(settings);

  const byPath = new Map<string, Occurrence[]>();
  const byStem = new Map<string, Occurrence[]>();
  const scanned = new Set<string>();

  const record = (raw: string, occurrence: Occurrence, referenceBases: readonly string[] = []): void => {
    const normalized = normalizeToken(raw, { allowParentSegments: referenceBases.length > 0 });
    if (normalized === null) return;
    const segments = normalized.path.split("/");
    const extended = segments.at(-1)!.includes(".");
    if (!extended && !settings.matchExtensionless) return;
    const index = extended ? byPath : byStem;
    if (!segments.includes("..")) {
      for (const key of keysFor(segments, normalized.absolute, settings.minSegments)) {
        const entries = index.get(key) ?? [];
        entries.push({ ...occurrence, text: normalized.path });
        index.set(key, entries);
      }
    }
    if (!normalized.absolute) {
      for (const referenceBase of referenceBases) {
        const based = posix.normalize(posix.join(referenceBase, normalized.path));
        if (based === ".." || based.startsWith("../")) continue;
        const entries = index.get(based) ?? [];
        entries.push({ ...occurrence, text: normalized.path });
        index.set(based, entries);
      }
    }
  };

  for (const file of context.repositorySources()) {
    scanned.add(file);
    scanParsedSource(context, file, record);
  }

  for (const scanRoot of settings.textRoots) {
    for (const absolute of textFiles(resolve(context.rootDir, scanRoot.root), scanRoot.extensions)) {
      const file = context.relative(absolute);
      // A tree that overlaps the source roots keeps the precise treatment: the
      // parsed pass already saw this file and skipped its module specifiers,
      // and re-reading it as text would report every import as a finding.
      if (scanned.has(file)) continue;
      if ((statSync(absolute, { throwIfNoEntry: false })?.size ?? 0) > settings.maxBytes) continue;
      scanned.add(file);
      const referenceBases = context.config.pathReferenceRewrites.enabled
        ? context.config.pathReferenceRewrites.roots
          .filter((root) => root.referenceBase !== undefined && (file === root.root || file.startsWith(root.root + "/")) && root.extensions.includes(extname(file)))
          .map((root) => root.referenceBase!)
        : [];
      scanText(readFileSync(absolute, "utf8"), file, (raw, occurrence) => record(raw, occurrence, referenceBases));
    }
  }

  return new PathReferenceIndex(byPath, byStem, scanned.size, settings);
}

/** Sink the scanners hand every path-shaped token to. */
type RecordToken = (raw: string, occurrence: Occurrence) => void;

/* -------------------------------------------------------------------------- */
/* Scanning                                                                   */
/* -------------------------------------------------------------------------- */

/** The specifier position of a node, which the scan must not treat as a path. */
function moduleSpecifierOf(node: ts.Node): ts.Node | undefined {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return node.moduleSpecifier;
  if (ts.isImportTypeNode(node)) return node.argument;
  if (ts.isExternalModuleReference(node)) return node.expression;
  if (ts.isCallExpression(node) && isModuleLoad(node)) return node.arguments[0];
  return undefined;
}

/** `import(…)` and `require(…)`: module edges, not path strings. */
function isModuleLoad(node: ts.CallExpression): boolean {
  if (node.expression.kind === ts.SyntaxKind.ImportKeyword) return true;
  return ts.isIdentifier(node.expression) && node.expression.text === "require";
}

function scanParsedSource(context: WorkspaceContext, file: string, record: RecordToken): void {
  const parsed = context.parsedSource(file);
  if (parsed === undefined) return;

  const visit = (node: ts.Node): void => {
    // A template with substitutions is not a literal and is not reconstructible
    // — `${dir}/chart.ts` is exactly the case this scanner cannot see.
    if (ts.isStringLiteralLike(node)) {
      const start = node.getStart(parsed);
      const position = parsed.getLineAndCharacterOfPosition(start);
      const occurrence = { file, line: position.line + 1, column: position.character + 1, text: node.text };
      for (const match of node.text.matchAll(PATH_TOKEN)) record(match[0], occurrence);
      return;
    }
    const specifier = moduleSpecifierOf(node);
    ts.forEachChild(node, (child) => {
      if (child !== specifier) visit(child);
    });
  };

  visit(parsed);
}

/**
 * Raw text: every path-shaped token, wherever it appears.
 *
 * No parser, so no way to tell a path in a command from a path in a comment,
 * and both are reported. In a shell script or a CI file that is the right call
 * — a commented-out command is still a path someone maintains — but it is a
 * looser rule than the source scan uses, and it is why `textRoots` is opt-in.
 */
function scanText(text: string, file: string, record: RecordToken): void {
  const lineStarts = [0];
  for (let index = text.indexOf("\n"); index >= 0; index = text.indexOf("\n", index + 1)) {
    lineStarts.push(index + 1);
  }
  let line = 0;
  for (const match of text.matchAll(PATH_TOKEN)) {
    const start = match.index;
    while (line + 1 < lineStarts.length && lineStarts[line + 1]! <= start) line += 1;
    record(match[0], { file, line: line + 1, column: start - lineStarts[line]! + 1, text: match[0] });
  }
}

/**
 * Files under `directory` with one of `extensions`, absolute, sorted.
 *
 * Its own walker rather than `sourceFiles()` because that one is fixed to
 * source extensions, which is the whole point of a text root. Symlinked
 * directories are not followed: `Dirent.isDirectory()` is false for them, so a
 * link cannot walk the scan out of the workspace.
 */
function textFiles(directory: string, extensions: readonly string[]): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      if (entry.name === "node_modules" || entry.name === ".git") return [];
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) return textFiles(path, extensions);
      return extensions.includes(extname(entry.name)) ? [path] : [];
    })
    .sort();
}
