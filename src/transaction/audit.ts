/** Independent post-transaction proofs. Each proof fails independently. */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createPackageManagerAdapter } from "../adapters/registry.ts";
import { inventoryModuleReferences, resetCodemodCaches } from "../codemod/imports.ts";
import { isFirstPartyPackagePath, isPackageOwner } from "../config.ts";
import { showBaseline } from "../util/git.ts";
import { hashText, MISSING } from "../util/hash.ts";
import { relativePosix } from "../util/paths.ts";
import { sourceExportsFromFile } from "../plan/public-surface.ts";
import {
  isAnyMove,
  type MoveWithRewriteOperation,
  type WriteFileOperation,
} from "../plan/manifest.ts";
import { findStaticFsReferences } from "../plan/static-fs-references.ts";
import { compileExternalConsumer } from "./external-consumer.ts";
import { sourceConservation as proveSourceConservation } from "./audit-conservation.ts";
import {
  firstExportTarget,
  relativeCandidates,
  repositorySources,
  showBaselineHash,
  stateAt,
  textAt,
  unauditableManifest,
  unauditableReport,
} from "./audit-helpers.ts";
import {
  dynamicImportDelta,
  entrypointRelativeKey,
  evaluatedModuleKeys,
  replayFailure,
  stillNamesADonor,
} from "./audit-graph.ts";
import { proof, type AuditOptions, type AuditReport, type GraphEvidence } from "./audit-types.ts";

export type { AuditOptions, AuditReport, GraphEvidence, ProofResult } from "./audit-types.ts";

export async function auditPlan(options: AuditOptions): Promise<AuditReport> {
  return auditPlanSync(options);
}

export function auditPlanSync(options: AuditOptions): AuditReport {
  const { config, manifest, rootDir } = options;
  // Before anything reads the manifest as though it were one. See
  // `unauditableManifest` for what a failure here looks like without it.
  const unauditable = unauditableManifest(config, manifest);
  if (unauditable.length > 0) return unauditableReport(manifest, rootDir, unauditable);
  // Proof 2 says every reference was re-resolved authoritatively. Resolution
  // answers cached by an earlier audit — of this root before it changed, or of a
  // simulation worktree — would make that a replay of a tree that is gone.
  resetCodemodCaches();
  const adapter = createPackageManagerAdapter(config);
  const moves = manifest.operations.filter(isAnyMove);

  /* -- 1. byte fidelity -------------------------------------------------- */

  const byteFailures: string[] = [];
  const compatibilitySource = manifest.modulePromotion?.retireSource === false ? manifest.modulePromotion.source : undefined;
  for (const move of moves) {
    if (stateAt(rootDir, move.source) !== MISSING && move.source !== compatibilitySource) byteFailures.push(`moved source still present: ${move.source}`);
    const landed = stateAt(rootDir, move.target);
    if (landed !== move.resultHash) {
      byteFailures.push(`moved bytes differ at ${move.target} (expected ${move.resultHash}, got ${landed})`);
    }
  }
  for (const [path, expected] of Object.entries(manifest.sourceBlobs)) {
    const baseline = showBaselineHash(rootDir, manifest.baselineCommit, path);
    if (baseline !== expected) byteFailures.push(`baseline blob does not match sourceBlobs: ${path}`);
  }
  for (const operation of manifest.operations) {
    if (operation.kind !== "rewrite-import" && operation.kind !== "rewrite-fs-reference" && operation.kind !== "rewrite-path-reference") continue;
    if (stateAt(rootDir, operation.file) !== operation.resultHash) {
      byteFailures.push(`rewritten consumer does not match its declared result: ${operation.file}`);
    }
  }
  // Unconditional, and there is no exemption for it. A `write-file` operation
  // carries the bytes verbatim, so unlike a `generatedFiles` entry — whose
  // post-move content a regenerating tool decides, which is what `exemptReason`
  // exists for — what these bytes should be is never unknowable at plan time.
  // A path is written at most once per journal (the validator rejects a second
  // operation mutating it), so `resultHash` is the plan's final word on it.
  const writes = manifest.operations.filter(
    (operation): operation is WriteFileOperation => operation.kind === "write-file",
  );
  for (const operation of writes) {
    const landed = stateAt(rootDir, operation.path);
    if (landed !== operation.resultHash) {
      byteFailures.push(
        `written file does not match its declared result: ${operation.path} (expected ${operation.resultHash}, got ${landed})`,
      );
    }
  }
  const migrations = manifest.operations.filter(
    (operation) => operation.kind === "migrate-path-keys",
  );
  for (const operation of migrations) {
    const landed = stateAt(rootDir, operation.path);
    if (landed !== operation.resultHash) {
      byteFailures.push(
        `path-keyed artifact does not match its declared migration result: ${operation.path} ` +
          `(expected ${operation.resultHash}, got ${landed})`,
      );
    }
  }
  const byteFidelity = proof(
    byteFailures,
    moves.length + Object.keys(manifest.sourceBlobs).length + writes.length + migrations.length,
  );

  /* -- 2. consumer completeness ------------------------------------------ */

  const movedSourcePaths = new Set(moves.map((move) => resolve(rootDir, move.source)));
  const movedTargets = new Set(moves.map((move) => move.target));
  const consumerFailures: string[] = [];
  const boundaryFailures: string[] = [];
  const movedPathEdges: string[] = [];

  const sources = repositorySources(config, rootDir);
  for (const file of sources) {
    const absolute = resolve(rootDir, file);
    if (!existsSync(absolute)) continue;
    const current = readFileSync(absolute, "utf8");
    const references = inventoryModuleReferences(current, absolute, true, rootDir, config.moduleSpecifierCalls);

    if (isPackageOwner(config, file) || isFirstPartyPackagePath(config, file)) {
      for (const reference of references) {
        if (!reference.resolved) continue;
        const inApplication = config.applications.some((app) =>
          resolve(reference.resolved!).startsWith(`${resolve(rootDir, app.sourceRoot)}/`),
        );
        if (inApplication) boundaryFailures.push(`${file} imports application code: ${reference.specifier}`);
      }
    }

    for (const reference of references) {
      const specifier = reference.specifier;
      if (!specifier) continue;
      if (specifier.startsWith(".")) {
        const candidates = relativeCandidates(config, absolute, specifier);
        if (candidates.some((candidate) => movedSourcePaths.has(candidate))) {
          movedPathEdges.push(`${file} -> ${specifier}`);
        } else if (movedTargets.has(file) && !candidates.some(existsSync)) {
          // A moved file whose relative import now resolves to nothing was
          // orphaned from something that stayed behind — typically an asset.
          movedPathEdges.push(`${file} -> ${specifier} (unresolved)`);
        }
      } else if (reference.resolved && movedSourcePaths.has(resolve(reference.resolved))) {
        movedPathEdges.push(`${file} -> ${specifier}`);
      }
    }

    // Re-derived independently of every operation the plan declares: a static
    // filesystem reference (`resolve(import.meta.dir, "…")`) is invisible to
    // `inventoryModuleReferences` above, so this is the only place that would
    // ever notice one still naming a path nothing occupies any more.
    for (const match of findStaticFsReferences(current, absolute)) {
      if (movedSourcePaths.has(match.resolvedAbsolute)) {
        movedPathEdges.push(`${file} -> ${match.literal} (static fs reference)`);
      }
    }

    if (file.startsWith(`${manifest.target.packageRoot}/`)) continue;
    if (stillNamesADonor(config, rootDir, absolute, references, moves)) {
      consumerFailures.push(`old-path consumer remains: ${file}`);
    }
  }

  for (const consumer of manifest.consumers) {
    const operation = manifest.operations.find(
      (candidate) => candidate.kind === "rewrite-import" && candidate.file === consumer.file,
    );
    if (!operation) {
      consumerFailures.push(`declared consumer has no rewrite operation: ${consumer.file}`);
      continue;
    }
    const baseline = showBaseline(rootDir, manifest.baselineCommit, consumer.file);
    if (baseline === null || !baseline.includes(consumer.expectedImporter)) {
      consumerFailures.push(`baseline of ${consumer.file} never contained ${consumer.expectedImporter}`);
    }
    if (!existsSync(resolve(rootDir, consumer.file))) {
      consumerFailures.push(`declared consumer no longer exists: ${consumer.file}`);
    }
    // Retained tests are consumers too, but the runtime package must not leak
    // into their owner's production graph.  The manifest makes this claim
    // explicit, so verify the landed owner manifest rather than trusting the
    // wiring operation that happened to be planned.
    const manifestPath = resolve(rootDir, consumer.owner, "package.json");
    // A low-level journal fixture can model an import rewrite without modelling
    // the owning workspace package at all. There is no package section to
    // inspect in that deliberately partial fixture; compiler manifests always
    // have an owner manifest before emitting consumer wiring.
    if (!existsSync(manifestPath)) continue;
    try {
      const ownerManifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        dependencies?: Record<string, unknown>;
        devDependencies?: Record<string, unknown>;
      };
      const section = consumer.dependencySection === "dev" ? ownerManifest.devDependencies : ownerManifest.dependencies;
      const opposite = consumer.dependencySection === "dev" ? ownerManifest.dependencies : ownerManifest.devDependencies;
      // Some low-level transaction fixtures declare a consumer rewrite without
      // the package-wiring operation; they are not full compiler manifests and
      // therefore make no section claim this proof can test. Every compiler
      // manifest that wires a new consumer either writes its owner package.json
      // or starts from one already declaring the package, and must satisfy the
      // exact-section proof below.
      const declaredByPlan = manifest.operations.some(
        (operation) => operation.kind === "write-file" && operation.path === `${consumer.owner}/package.json`,
      );
      const declaredOnDisk = section?.[manifest.target.packageName] !== undefined || opposite?.[manifest.target.packageName] !== undefined;
      if ((declaredByPlan || declaredOnDisk) && (section?.[manifest.target.packageName] === undefined || opposite?.[manifest.target.packageName] !== undefined)) {
        consumerFailures.push(`consumer dependency section does not match manifest: ${consumer.file}`);
      }
    } catch {
      consumerFailures.push(`cannot verify consumer dependency section: ${consumer.file}`);
    }
  }
  if (movedPathEdges.length > 0) {
    consumerFailures.push(`references into moved paths remain: ${[...new Set(movedPathEdges)].sort()[0]}`);
  }
  const consumerCompleteness = proof(consumerFailures, manifest.consumers.length + sources.length);

  /* -- 3. boundary rules ------------------------------------------------- */

  const entrypoint = resolve(rootDir, manifest.target.packageRoot, manifest.target.entrypoint);
  if (!existsSync(entrypoint)) {
    boundaryFailures.push(`target entrypoint does not exist: ${manifest.target.entrypoint}`);
  } else {
    try {
      const entrypointDeclared = manifest.operations.some(
        (operation) =>
          operation.kind === "write-file" &&
          operation.path === `${manifest.target.packageRoot}/${manifest.target.entrypoint}`,
      );
      // When the plan wrote the barrel, it alone defines the surface. When it
      // did not — extraction into a package that already had one — the moved
      // modules are inspected too.
      const moduleTargets = moves
        .filter((move) => /\.[cm]?[jt]sx?$/.test(move.target))
        .map((move) => resolve(rootDir, move.target));
      const files = [entrypoint, ...(entrypointDeclared ? [] : moduleTargets)].filter(existsSync);
      const actual = files.flatMap((file) => sourceExportsFromFile(file));
      for (const required of manifest.target.requiredExports) {
        if (!actual.some((entry) => entry.name === required.name && entry.typeOnly === required.typeOnly)) {
          boundaryFailures.push(`target entrypoint does not expose ${required.name}`);
        }
      }
    } catch (error) {
      boundaryFailures.push(`target surface could not be read: ${(error as Error).message}`);
    }
  }
  const packageManifestPath = resolve(rootDir, manifest.target.packageRoot, "package.json");
  if ((manifest.target.publicModules?.length ?? 0) > 0 && existsSync(packageManifestPath)) {
    try {
      const packageManifest = JSON.parse(readFileSync(packageManifestPath, "utf8")) as { exports?: unknown };
      const exportsMap = packageManifest.exports && typeof packageManifest.exports === "object" && !Array.isArray(packageManifest.exports)
        ? packageManifest.exports as Record<string, unknown>
        : {};
      for (const module of manifest.target.publicModules ?? []) {
        const declared = firstExportTarget(exportsMap[module.exportKey]);
        if (declared !== module.exportTarget) {
          boundaryFailures.push(`package subpath ${module.exportKey} does not target ${module.exportTarget}`);
          continue;
        }
        const resolved = relativePosix(rootDir, resolve(rootDir, manifest.target.packageRoot, declared));
        if (resolved !== module.target) {
          boundaryFailures.push(`package subpath ${module.exportKey} resolves to ${resolved}, not ${module.target}`);
          continue;
        }
        const actual = sourceExportsFromFile(resolve(rootDir, module.target), module.target);
        for (const required of module.requiredExports) {
          if (!actual.some((entry) => entry.name === required.name && entry.typeOnly === required.typeOnly)) {
            boundaryFailures.push(`package subpath ${module.exportKey} does not expose ${required.name}`);
          }
        }
      }
    } catch (error) {
      boundaryFailures.push(`package subpaths could not be read: ${(error as Error).message}`);
    }
  }
  const boundaryRules = proof(
    [...new Set(boundaryFailures)],
    manifest.target.requiredExports.length + (manifest.target.publicModules?.length ?? 0),
  );

  /* -- 4. external-consumer compile proof -------------------------------- */

  const externalConsumerCompile = options.skipCompileProof
    ? proof([], 0)
    : (() => {
        const result = compileExternalConsumer({
          config,
          manifest,
          rootDir,
          ...(options.installedRoot === undefined ? {} : { installedRoot: options.installedRoot }),
        });
        return proof(result.passed ? [] : result.diagnostics, 1);
      })();

  /* -- 5. codemod replay proof ------------------------------------------- */

  const replays = manifest.operations.filter(
    (operation): operation is MoveWithRewriteOperation => operation.kind === "move-with-rewrite",
  );
  const replayFailures = replays.flatMap((operation) => replayFailure(config, manifest, operation, rootDir));
  const codemodReplay = proof(replayFailures, replays.length);

  /* -- 6. entrypoint evaluation closure ---------------------------------- */

  const entrypointRelative = `${manifest.target.packageRoot}/${manifest.target.entrypoint}`;
  const closureFailures: string[] = [];
  let closureChecks = 0;
  // "The entrypoint exists" belongs to proof 3; failing here too would only
  // duplicate its message.
  if (existsSync(entrypoint)) {
    const productionSources = new Set(manifest.source.files);
    const productionTargets = moves.filter((move) => productionSources.has(move.source)).map((move) => move.target);
    const declared = new Set(productionTargets.map((target) => entrypointRelativeKey(entrypointRelative, target)));
    // Modules the entrypoint already reached at the baseline are not part of
    // this extraction's delta: every importer of this package was evaluating
    // them before the plan existed. Read from git rather than from the plan, so
    // a plan cannot widen its own allowance by describing the barrel it wants.
    const inherited = evaluatedModuleKeys(
      showBaseline(rootDir, manifest.baselineCommit, entrypointRelative) ?? "",
      entrypointRelative,
    );
    const landed = evaluatedModuleKeys(readFileSync(entrypoint, "utf8"), entrypointRelative);
    // Counted, not merely sized: only the inventory records this proof actually
    // examines belong here. Adding `evaluationEffects.length` would credit the
    // proof with having checked every `reached` module and every third-party
    // package too, which it does not and cannot — and a check count that grows
    // with unchecked declarations is how a proof starts looking stronger than it
    // is.
    const inventoried = manifest.evaluationEffects.filter(
      (record) => record.subject === "module" && record.reach !== "reached",
    );
    closureChecks = declared.size + landed.size + inventoried.length;

    // One direction only, and the direction matters. "The entrypoint reaches
    // nothing beyond the declared set" is an invariant: anything extra is a
    // module consumers evaluate that the plan never inventoried. The converse —
    // "the entrypoint reaches everything moved" — is *not* an invariant of this
    // system, because two moved modules can export the same name and cannot both
    // be star-re-exported; a barrel that drops a module is caught by proof 3 or
    // proof 4 when something needed it, and by the simulation's own gates
    // otherwise.
    for (const key of [...landed].sort()) {
      if (declared.has(key) || inherited.has(key)) continue;
      closureFailures.push(`package entrypoint evaluates a module the plan never declared: ${key}`);
    }
    // The inventory is only worth reading if it describes the files this plan
    // actually produces. A path it names that no operation lands is either a
    // stale inventory or one derived from the wrong side of the move.
    //
    // Scoped to the records that *claim* the plan produces the file. A `reached`
    // record names a module the plan deliberately does not touch — it stays
    // where it is, which is the entire content of the claim — so holding it to
    // the produced set would fail on exactly the entries the closure exists to
    // add. A `package` record names no path at all.
    const inventoriable = new Set([...productionTargets, entrypointRelative]);
    for (const record of inventoried) {
      if (record.subject !== "module" || inventoriable.has(record.path)) continue;
      closureFailures.push(`declared evaluation effects name a path this plan does not produce: ${record.path}`);
    }
  }
  const entrypointClosure = proof(closureFailures, closureChecks);

  /* -- lockfile + generated artifacts ------------------------------------ */

  // An internal-consistency check, and only that. Both sides of this comparison
  // come from the same adapter: the landed block is re-read with the adapter's
  // parser and hashed against the block the plan spliced with it. So it fails on
  // a lockfile that was hand-edited, half-applied, or replayed from a different
  // plan — the tampering it exists for — and it cannot fail on a splice whose
  // shape the package manager itself would never write. That question is the
  // opt-in `--verify-lockfile` run's, and nothing here answers it.
  const lockfileFailures: string[] = [];
  let lockfileChecks = 0;
  for (const operation of manifest.operations) {
    if (operation.kind !== "lockfile-importer") continue;
    lockfileChecks += 1;
    const text = textAt(rootDir, operation.lockfile);
    const current = text === "" ? undefined : adapter.lockfileImporterHash(text, operation.packageRoot);
    if (current !== hashText(operation.block)) {
      lockfileFailures.push(`lockfile importer block does not match the worktree: ${operation.packageRoot}`);
    }
  }
  if (manifest.lockfileImporter) {
    lockfileChecks += 1;
    const text = textAt(rootDir, adapter.lockfileName);
    const current = text === "" ? undefined : adapter.lockfileImporterHash(text, manifest.lockfileImporter.packageRoot);
    if (current !== manifest.lockfileImporter.hash) {
      lockfileFailures.push("lockfile importer declaration does not match the worktree");
    }
  }
  const lockfileIntegrity = proof(lockfileFailures, lockfileChecks);

  const regenerated = options.regeneratedArtifacts;
  const generatedFailures = manifest.generatedFiles.flatMap((generated) => {
    if (!existsSync(resolve(rootDir, generated.path))) return [`generated file is missing: ${generated.path}`];
    if (!existsSync(resolve(rootDir, generated.source))) {
      return [`generated file ${generated.path} declares a source that does not exist: ${generated.source}`];
    }
    if (regenerated !== undefined && generated.regenerateOnApply) {
      // The exemption covers "the plan could not know these bytes", not "these
      // bytes are nobody's business". Once the transaction has regenerated the
      // artifact, the bytes the generator produced are known, and an artifact
      // that no longer matches them is stale again — by a later step, a hook,
      // or a second generator undoing the first.
      const produced = regenerated[generated.path];
      if (produced === undefined) {
        return [`generated artifact declares a regeneration this transaction never ran: ${generated.path}`];
      }
      if (stateAt(rootDir, generated.path) !== produced) {
        return [`generated artifact was changed after it was regenerated: ${generated.path}`];
      }
    }
    if (generated.exemptReason) return [];
    if (generated.expectedHash) {
      return stateAt(rootDir, generated.path) === generated.expectedHash
        ? []
        : [`generated file does not match its recorded hash: ${generated.path}`];
    }
    return [`generated file ${generated.path} carries neither a hash nor an exemption`];
  });
  const generatedArtifacts = proof(generatedFailures, manifest.generatedFiles.length);

  /* -- source/test/asset conservation ----------------------------------- */

  const sourceConservation = proveSourceConservation(rootDir, manifest, moves);

  /* -- graph evidence ---------------------------------------------------- */

  const observed = dynamicImportDelta(manifest, rootDir);
  const expected = manifest.expectedDynamicImportDelta;
  const deltaMatches =
    observed.added.join("\n") === [...expected.added].join("\n") &&
    observed.removed.join("\n") === [...expected.removed].join("\n");
  const graphEvidence: GraphEvidence = {
    dynamicImportDelta: observed,
    movedPathEdges: [...new Set(movedPathEdges)].sort(),
    passed: deltaMatches && movedPathEdges.length === 0,
  };

  const proofs = {
    byteFidelity,
    consumerCompleteness,
    boundaryRules,
    externalConsumerCompile,
    codemodReplay,
    entrypointClosure,
    lockfileIntegrity,
    generatedArtifacts,
    sourceConservation,
  };
  const failures = [
    ...Object.values(proofs).flatMap((entry) => entry.failures),
    ...(deltaMatches ? [] : ["dynamic-import evidence does not match the declared plan"]),
  ];

  return {
    planId: manifest.planId,
    baselineCommit: manifest.baselineCommit,
    auditedRoot: rootDir,
    passed: failures.length === 0,
    ...proofs,
    graphEvidence,
    failures,
  };
}

/**
 * A module identity that three different sources can be reduced to and
 * compared: a specifier written in the entrypoint, a specifier written in the
 * *baseline* entrypoint, and a target path the plan declares.
 *
 * Extensionless and lexically normalised, because the same module is written
 * `./widget/widget.ts`, `./widget/widget.js` and `./widget/widget` depending on
 * the configured barrel style, and none of those is more true than the others.
 * Deliberately lexical: it touches no filesystem, so it means the same thing for
 * the baseline blob — whose targets may no longer exist — as for the landed one.
 */
