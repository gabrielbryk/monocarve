/** Post-journal preparer records and the journal-path helpers they share with the plan compiler. */
import { statSync } from "node:fs";

import { triggeredArtifacts, triggeredPostJournalPreparers, type MonocarveConfig } from "../config.ts";
import { byCodeUnit, hashText } from "../util/hash.ts";
import { PlanningError, type WorkspaceContext } from "./context.ts";
import type { PlanOperation, PostJournalPreparerRecord } from "./manifest.ts";

type Preparer = ReturnType<typeof triggeredPostJournalPreparers>[number];
type Replacement = NonNullable<PostJournalPreparerRecord["replacements"]>[number];
type Create = NonNullable<PostJournalPreparerRecord["creates"]>[number];
type Mutation = PostJournalPreparerRecord["mutations"][number];

export function operationPathsOf(operation: PlanOperation): string[] {
  switch (operation.kind) {
    case "move":
    case "move-with-rewrite":
      return [operation.source, operation.target];
    case "rewrite-import":
    case "rewrite-fs-reference":
    case "rewrite-path-reference":
      return [operation.file];
    case "write-file":
    case "delete-file":
      return [operation.path];
    case "lockfile-importer":
      return [operation.lockfile];
    case "migrate-path-keys":
      return [operation.path];
  }
  const unreachable: never = operation;
  throw new Error(`invariant: unhandled plan operation kind ${JSON.stringify((unreachable as { kind?: unknown }).kind)}`);
}

export function generatorOwnedOutputs(config: MonocarveConfig, production: readonly string[], operations: readonly PlanOperation[]): ReadonlySet<string> {
  const documents = operations
    .filter((operation): operation is Extract<PlanOperation, { kind: "rewrite-path-reference" }> => operation.kind === "rewrite-path-reference")
    .map((operation) => operation.file);
  return new Set(triggeredPostJournalPreparers(config, [...production, ...documents]).flatMap((preparer) => preparer.outputs));
}

export function postJournalRecordsFor(
  config: MonocarveConfig,
  context: WorkspaceContext,
  operations: readonly PlanOperation[],
  triggers: readonly string[],
): PostJournalPreparerRecord[] {
  const journalPaths = new Set(operations.flatMap(operationPathsOf));
  const generatedPaths = new Set(triggeredArtifacts(config, triggers).map((artifact) => artifact.path));
  const records = triggeredPostJournalPreparers(config, triggers).map((preparer) =>
    postJournalRecord(context, preparer, { journal: journalPaths, generated: generatedPaths }),
  );
  return records.toSorted((left, right) => byCodeUnit(left.id, right.id));
}

function postJournalRecord(
  context: WorkspaceContext,
  preparer: Preparer,
  claimed: { readonly journal: ReadonlySet<string>; readonly generated: ReadonlySet<string> },
): PostJournalPreparerRecord {
  const replacements = preparer.replacements?.map((item): Replacement => ({
    path: item.path,
    before: item.before,
    after: item.after,
    ...(item.prefix === undefined ? {} : { prefix: item.prefix }),
    ...(item.suffix === undefined ? {} : { suffix: item.suffix }),
  }));
  const creates = preparer.creates?.map((item) => ({ ...item, mode: item.mode ?? 0o644 }));
  const declarativePaths = [...new Set([...(replacements?.map((item) => item.path) ?? []), ...(creates?.map((item) => item.path) ?? [])])];
  assertNoDeclarativeCollision(preparer, declarativePaths, claimed);
  const mutations = declarativePaths
    .map((path) => declarativeMutation(context, preparer.id, path, replacements ?? [], creates))
    .toSorted((left, right) => byCodeUnit(left.path, right.path));
  const outputs = [...new Set([...preparer.outputs, ...(creates?.map((item) => item.path) ?? [])])].toSorted(byCodeUnit);
  return {
    id: preparer.id,
    ...(preparer.command === undefined ? {} : { command: preparer.command }),
    outputs,
    ...(replacements === undefined ? {} : { replacements }),
    ...(creates === undefined ? {} : { creates }),
    mutations,
    emittedModuleSpecifiers: preparer.emittedModuleSpecifiers.map((item) => ({ ...item })),
    ...(preparer.verify === undefined ? {} : { verify: preparer.verify }),
  };
}

function assertNoDeclarativeCollision(
  preparer: Preparer,
  declarativePaths: readonly string[],
  claimed: { readonly journal: ReadonlySet<string>; readonly generated: ReadonlySet<string> },
): void {
  const collision = declarativePaths.find((path) => claimed.journal.has(path));
  if (collision !== undefined) throw new PlanningError(`post-journal preparer ${preparer.id} declarative path collides with a journal operation: ${collision}`);
  const generatedCollision = declarativePaths.find((path) => claimed.generated.has(path));
  if (generatedCollision !== undefined)
    throw new PlanningError(`post-journal preparer ${preparer.id} declarative path collides with a generated artifact: ${generatedCollision}`);
  const emittedCollision = declarativePaths.find((path) => preparer.emittedModuleSpecifiers.some((item) => item.source === path));
  if (emittedCollision !== undefined)
    throw new PlanningError(`post-journal preparer ${preparer.id} declarative path collides with emitted module specifier rewriting: ${emittedCollision}`);
}

function declarativeMutation(
  context: WorkspaceContext,
  id: string,
  path: string,
  chain: readonly Replacement[],
  creates: readonly Create[] | undefined,
): Mutation {
  const create = creates?.find((item) => item.path === path);
  if (create !== undefined)
    return { path, preconditionHash: "missing" as const, preconditionMode: "missing" as const, resultHash: hashText(create.contents), resultMode: create.mode };
  if (!context.exists(path)) throw new PlanningError(`post-journal replacement path does not exist at baseline: ${path}`);
  const before = context.text(path);
  let after = before;
  for (const [index, replacement] of chain.entries()) if (replacement.path === path) after = applyExactReplacement(after, replacement, chain, index, id);
  const mode = statSync(context.absolute(path)).mode & 0o111 ? 0o755 : 0o644;
  return { path, preconditionHash: hashText(before), preconditionMode: mode, resultHash: hashText(after), resultMode: mode };
}

function applyExactReplacement(contents: string, replacement: Replacement, all: readonly Replacement[], index: number, id: string): string {
  const framed = (text: string) => `${replacement.prefix ?? ""}${text}${replacement.suffix ?? ""}`;
  const before = framed(replacement.before);
  const first = contents.indexOf(before);
  if (first >= 0) {
    if (contents.indexOf(before, first + before.length) >= 0)
      throw new PlanningError(`post-journal preparer ${id} replacement ${index + 1} before text is ambiguous in ${replacement.path}`);
    return `${contents.slice(0, first)}${framed(replacement.after)}${contents.slice(first + before.length)}`;
  }
  const states = [framed(replacement.after), framed(terminalAfter(replacement, all, index))];
  if (
    states.some((state) => {
      const at = contents.indexOf(state);
      return at >= 0 && contents.indexOf(state, at + state.length) < 0;
    })
  )
    return contents;
  throw new PlanningError(`post-journal preparer ${id} replacement ${index + 1} matched neither before nor after text in ${replacement.path}`);
}

/** The text a chain of same-framed replacements starting at `index` ends with. */
function terminalAfter(replacement: Replacement, all: readonly Replacement[], index: number): string {
  let terminal = replacement.after;
  for (const candidate of all.slice(index + 1))
    if (
      candidate.path === replacement.path &&
      candidate.prefix === replacement.prefix &&
      candidate.suffix === replacement.suffix &&
      candidate.before === terminal
    )
      terminal = candidate.after;
  return terminal;
}
