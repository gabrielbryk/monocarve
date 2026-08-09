/** Policy for deciding which first-party tests travel with a production closure. */

import { byCodeUnit } from "../util/hash.ts";
import { PlanningError, type WorkspaceContext } from "./context.ts";
import type { TestRelocationPartition } from "./consumers.ts";

/** Partition direct test importers without moving app-local test support. */
export function partitionTests(
  context: WorkspaceContext,
  production: readonly string[],
  tests: readonly string[],
  assets: readonly string[],
): TestRelocationPartition {
  const classified = [...tests].sort(byCodeUnit);
  const fixedRetained = classified.filter((test) => context.testKind(test) !== "unit");
  const unitTests = classified.filter((test) => context.testKind(test) === "unit");
  fixedRetained.forEach((test) => validateFixedRetainedTest(context, test, assets));
  const partition = partitionUnitTests(
    context,
    production,
    unitTests,
    assets,
    fixedRetained,
    context.config.testRelocation.strategy === "all-importers",
  );
  return retainTestsWithRetainedImporters(context, production, assets, partition);
}

/**
 * Tests are private package implementation, not public modules. A test helper
 * can therefore travel only when every first-party importer travels with it.
 * Demotion is a fixed point because retaining one test can in turn retain the
 * helper it imports. Without this pass a retained test is rewritten to the
 * package root for a travelling helper that the package never exports.
 */
function retainTestsWithRetainedImporters(
  context: WorkspaceContext,
  production: readonly string[],
  assets: readonly string[],
  partition: TestRelocationPartition,
): TestRelocationPartition {
  const movedProduction = new Set([...production, ...assets]);
  const travelling = new Set(partition.travelling);
  let changed = true;
  while (changed) {
    changed = false;
    for (const test of [...travelling].sort(byCodeUnit)) {
      const importers = context.consumerIndex().get(context.absolute(test)) ?? [];
      if (importers.some((importer) => !movedProduction.has(importer) && !travelling.has(importer))) {
        travelling.delete(test);
        changed = true;
      }
    }
  }
  return {
    travelling: [...travelling].sort(byCodeUnit),
    retained: [...new Set([...partition.retained, ...partition.travelling.filter((test) => !travelling.has(test))])].sort(byCodeUnit),
  };
}

function validateFixedRetainedTest(context: WorkspaceContext, test: string, assets: readonly string[]): void {
  const kind = context.testKind(test);
  if (context.hasUnsupportedReference(test)) {
    throw new PlanningError(`unsupported module reference in retained ${kind} test ${test}`);
  }
  for (const reference of context.moduleReferences(test)) {
    if (!reference.specifier?.startsWith(".")) continue;
    const resolved = context.resolveRelative(test, reference.specifier);
    if (!resolved) throw new PlanningError(`unresolved relative module reference in retained ${kind} test ${test}: ${reference.specifier}`);
    if (assets.includes(resolved)) throw new PlanningError(`retained ${kind} test ${test} imports moved asset ${resolved}`);
  }
}

function partitionUnitTests(
  context: WorkspaceContext,
  production: readonly string[],
  tests: readonly string[],
  assets: readonly string[],
  fixedRetained: readonly string[],
  allowUnsupportedReference: boolean,
): TestRelocationPartition {
  const moved = new Set([...production, ...assets]);
  const travelling: string[] = [];
  const retained: string[] = [];
  for (const test of tests) {
    const result = classifyUnitTest(context, test, moved, assets, allowUnsupportedReference);
    if (result === "travelling") travelling.push(test);
    else retained.push(test);
  }
  return { travelling, retained: [...fixedRetained, ...retained].sort(byCodeUnit) };
}

function classifyUnitTest(
  context: WorkspaceContext,
  test: string,
  moved: ReadonlySet<string>,
  assets: readonly string[],
  allowUnsupportedReference: boolean,
): "travelling" | "retained" {
  if (!allowUnsupportedReference && context.hasUnsupportedReference(test)) {
    throw new PlanningError(`unsupported module reference in test importer ${test}`);
  }
  const movedAssets = new Set<string>();
  const selfContained = context.moduleReferences(test).every((reference) =>
    testReferenceTravels(context, test, reference.specifier, reference.resolved, moved, assets, movedAssets),
  );
  if (!selfContained && movedAssets.size > 0) {
    throw new PlanningError(`retained test ${test} imports moved asset ${[...movedAssets].sort(byCodeUnit).join(", ")}`);
  }
  return context.isMovable(test) && selfContained ? "travelling" : "retained";
}

function testReferenceTravels(
  context: WorkspaceContext,
  test: string,
  specifier: string | null,
  preResolved: string | null,
  moved: ReadonlySet<string>,
  assets: readonly string[],
  movedAssets: Set<string>,
): boolean {
  if (!specifier) return true;
  const relative = specifier.startsWith(".");
  const resolved = preResolved ?? (relative ? context.resolveRelative(test, specifier) : undefined);
  if (relative && !resolved) throw new PlanningError(`unresolved relative module reference in test importer ${test}: ${specifier}`);
  if (!resolved) return true;
  const target = context.relative(resolved);
  if (assets.includes(target)) movedAssets.add(target);
  return !relative || moved.has(target);
}
