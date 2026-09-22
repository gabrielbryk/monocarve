/** Proof 6: the entrypoint evaluates no newly undeclared module. */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { ExtractionManifest, MoveOperation, MoveWithRewriteOperation } from "../plan/manifest.ts";
import { showBaseline } from "../util/git.ts";
import { entrypointRelativeKey, evaluatedModuleKeys } from "./audit-graph.ts";
import { proof, type ProofResult } from "./audit-types.ts";

type AnyMove = MoveOperation | MoveWithRewriteOperation;

export function entrypointClosureProof(manifest: ExtractionManifest, rootDir: string, moves: readonly AnyMove[]): ProofResult {
  const entrypointRelative = `${manifest.target.packageRoot}/${manifest.target.entrypoint}`;
  const entrypoint = resolve(rootDir, entrypointRelative);
  const closureFailures: string[] = [];
  // "The entrypoint exists" belongs to proof 3; failing here too would only
  // duplicate its message.
  if (!existsSync(entrypoint)) return proof(closureFailures, 0);

  const productionSources = new Set(manifest.source.files);
  const productionTargets = moves.filter((move) => productionSources.has(move.source)).map((move) => move.target);
  const declared = new Set(productionTargets.map((target) => entrypointRelativeKey(entrypointRelative, target)));
  // Modules the entrypoint already reached at the baseline are not part of
  // this extraction's delta: every importer of this package was evaluating
  // them before the plan existed. Read from git rather than from the plan, so
  // a plan cannot widen its own allowance by describing the barrel it wants.
  const inherited = evaluatedModuleKeys(showBaseline(rootDir, manifest.baselineCommit, entrypointRelative) ?? "", entrypointRelative);
  const landed = evaluatedModuleKeys(readFileSync(entrypoint, "utf8"), entrypointRelative);
  // Counted, not merely sized: only the inventory records this proof actually
  // examines belong here. Adding `evaluationEffects.length` would credit the
  // proof with having checked every `reached` module and every third-party
  // package too, which it does not and cannot — and a check count that grows
  // with unchecked declarations is how a proof starts looking stronger than it
  // is.
  const inventoried = manifest.evaluationEffects.filter((record) => record.subject === "module" && record.reach !== "reached");
  const closureChecks = declared.size + landed.size + inventoried.length;

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
  return proof(closureFailures, closureChecks);
}
