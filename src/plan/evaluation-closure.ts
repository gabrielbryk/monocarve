/**
 * What the extracted package's entrypoint actually evaluates, transitively.
 *
 * `../codemod/side-effects.ts` answers "what does *this file's* top level do".
 * That question stops at the file, and the first line of that module's list of
 * things it does not attempt says so: a module whose own top level is spotless
 * can import one that is not. This module is the other half — it decides *which
 * files to ask about*.
 *
 * ## Why the moved set is the wrong set
 *
 * The scaffolded entrypoint `export *`s every moved production file and every
 * consumer is repointed at the package name. ES module semantics evaluate every
 * module the barrel re-exports, and every module *those* import, before the
 * first binding is read. So a consumer that used to deep-import one file now
 * evaluates the whole closure — including code that never moved and never
 * belonged to the donating application.
 *
 * ## Which edges are followed
 *
 * Only edges that cause evaluation:
 *
 * | edge                                   | followed | why |
 * |----------------------------------------|----------|-----|
 * | `import x from "./y"`                  | yes      | evaluates `y` |
 * | `export * from "./y"` / `export {} from`| yes     | evaluates `y` |
 * | `require("./y")`, `import x = require()`| yes     | evaluates `y` |
 * | `import type` / `import { type X }`    | **no**   | erased before anything runs; following it would inflate the closure with modules that never execute |
 * | `await import("./y")`                  | **no**   | lazy by construction, and `expectedDynamicImportDelta` already tracks every dynamic specifier — following it here would report the same risk twice under a name that implies it is eager |
 * | `require.resolve("./y")`               | **no**   | returns a path; it does not evaluate the target |
 * | `import "./styles.css"`                | **no**   | see below |
 *
 * **Assets.** A CSS import *is* a real side effect under a bundler, and it is
 * deliberately not traversed anyway, for a reason that costs nothing: an asset
 * is a leaf. It cannot import first-party code, so entering it adds no module to
 * the closure, and this tool cannot parse it, so it would contribute no effect
 * kinds and be dropped from the inventory as a non-finding. The construct is not
 * lost — a bindingless `import "./chart.css"` is reported by the detector as a
 * `side-effect-import` **on the module that writes it**, which is the file a
 * human would have to open regardless.
 *
 * ## Where the hops come from
 *
 * Two sources, unioned, because neither alone sees the whole relation:
 *
 *  - {@link DependencyGraph.edges}, filtered by {@link EdgeKind}. Note that
 *    `graph.outgoing` cannot be used: it is kind-erased adjacency, so following
 *    it would drag every `type-only` and `dynamic` target into the closure.
 *  - The importing file's own module references, via the shared
 *    {@link WorkspaceContext} cache. This is what reaches modules the graph does
 *    not contain: the graph's nodes come from cruising each application's
 *    `sourceRoot`, so a workspace package's internals are nodes only when the
 *    resolver could follow a bare specifier into them — which needs a
 *    `node_modules` link that a freshly cloned workspace may not have. It is
 *    also the only source that distinguishes `require` from `require.resolve`.
 *
 * Both are over-approximations of the same relation and both are filtered by the
 * same rule, so the union is sound in the direction that matters.
 *
 * ## The third-party boundary
 *
 * The traversal stops at `node_modules`: nothing here parses a dependency. What
 * it records instead is the package *name* reached and whatever that package
 * declares about itself in its own `package.json` `sideEffects` field — the
 * ecosystem's own answer to this question. That is a claim by the package, never
 * a verification, and the four values keep "claims none" apart from "said
 * nothing" apart from "we could not find it to ask".
 */

import type { MonocarveConfig } from "../config.ts";
import type { DependencyGraph } from "../graph/model.ts";
import type { PackageManifest } from "../graph/workspace.ts";
import { byCodeUnit } from "../util/hash.ts";
import type { WorkspaceContext } from "./context.ts";
import { traverseEvaluationClosure } from "./evaluation-traversal.ts";
import type { EscapeRewrite, SideEffectsDeclaration } from "./manifest.ts";

/**
 * Edge kinds whose target is evaluated when the source is.
 *
 * `type-only` and `dynamic` are absent by decision, not by omission; see the
 * table in the module comment.
 */
/** A third-party package the closure reaches, and what it says about itself. */
interface ReachedPackage {
  readonly name: string;
  readonly sideEffects: SideEffectsDeclaration;
}

export interface EvaluationClosure {
  /** The modules the traversal started from, sorted. A subset of {@link modules}. */
  readonly seeds: readonly string[];
  /**
   * First-party modules the seeds evaluate that the seeds do not contain,
   * sorted. These keep their baseline paths: nothing moves them, and the point
   * of the record is that they start running for importers that never named
   * them.
   */
  readonly reached: readonly string[];
  /** Seeds plus reached, sorted. */
  readonly modules: readonly string[];
  /** Third-party packages reached, sorted by name. */
  readonly packages: readonly ReachedPackage[];
  /**
   * Specifiers naming a workspace package the traversal could not follow to a
   * file — an unexported subpath, or an entrypoint the manifest points at that
   * is not on disk. Sorted. These are holes: the closure continues through them
   * and this tool did not.
   */
  readonly opaqueSpecifiers: readonly string[];
}

export interface EvaluationClosureOptions {
  readonly config: MonocarveConfig;
  readonly context: WorkspaceContext;
  readonly graph: DependencyGraph;
  /** Modules the entrypoint will re-export — the moved production files. */
  readonly seeds: readonly string[];
  /**
   * Escape rewrites the plan will apply, keyed by the file that carries them.
   *
   * Supplied because the closure must describe the code *after* the move. A
   * `move-with-rewrite` repoints `../shared/logger` at `@acme/logger`, so
   * following the baseline specifier would record the donating application's
   * copy as reached when the module that actually runs is the package's.
   */
  readonly rewrites?: ReadonlyMap<string, readonly EscapeRewrite[]>;
}

/**
 * The evaluation closure of `seeds`.
 *
 * Terminates on any input: every module is enqueued at most once, guarded by
 * the visited set, so a cycle is walked exactly once around and a module reached
 * by ten paths is scanned once.
 */
export function evaluationClosure(options: EvaluationClosureOptions): EvaluationClosure {
  const traversal = traverseEvaluationClosure(options);
  const packages = [...traversal.packageOwners]
    .map(([name, owners]): ReachedPackage => ({ name, sideEffects: declarationOf(options.context.installedManifest(name, [...owners].toSorted(byCodeUnit))) }))
    .toSorted((left, right) => byCodeUnit(left.name, right.name));

  return { seeds: traversal.seeds, reached: traversal.reached, modules: traversal.modules, packages, opaqueSpecifiers: traversal.opaqueSpecifiers };
}

/**
 * What a package's own manifest declares about evaluating it.
 *
 * `undefined` for the manifest means the package was not found under any
 * `node_modules` this tool looked in — which is a different statement from a
 * package that is installed and declares nothing, and both differ from
 * `"sideEffects": false`. Collapsing any pair of the three would turn "we could
 * not check" into "checked, and it is fine".
 */
function declarationOf(manifest: PackageManifest | undefined): SideEffectsDeclaration {
  if (manifest === undefined) return "unresolved";
  const field = manifest.sideEffects;
  if (field === undefined) return "undeclared";
  if (field === false) return "none";
  // A glob list names the modules that do have effects; an empty one names none.
  if (Array.isArray(field)) return field.length === 0 ? "none" : "some";
  return "some";
}
