// Extracted from core.ts's assertPreparerManifest: pure-shape validation is
// split from configuration-consistency validation, and the latter is split
// again by concern (commands/replacements/creates, then generation scope,
// then create-vs-mutation cross-checks). Every check below is a verbatim
// lift — same order, same short-circuiting, same thrown messages — so a
// caller chaining these functions observes exactly the original behavior.
import type { MonocarveConfig, PreparerConfig } from "../config.ts";
import { configDigest } from "../config/digest.ts";
import { preparationPostJournalRecords } from "../prepare/post-journal.ts";
import { byCodeUnit, hashJson, hashText, MISSING } from "../util/hash.ts";
import { renderTemplate } from "../util/template.ts";
import {
  expandCreatesPolicy,
  expandDeclaredOutputs,
  expandGeneratedArtifacts,
  expandReplacementsPolicy,
  findPolicy,
  renderCommit,
  sameOptionalPolicy,
  unique,
  validatedPath,
  assertNoDuplicatePaths,
} from "./core-support.ts";
import { PreparerError } from "./error.ts";
import { PREPARER_MANIFEST_SCHEMA_VERSION, type PreparerManifest } from "./manifest.ts";

type ManifestShape = Partial<PreparerManifest>;
type ReplacementRecord = NonNullable<ManifestShape["preparer"]>["replacements"] extends readonly (infer Item)[] | undefined ? Item : never;
type CreateRecord = NonNullable<ManifestShape["preparer"]>["creates"] extends readonly (infer Item)[] | undefined ? Item : never;
type MutationRecord = ManifestShape["mutations"] extends readonly (infer Item)[] | undefined ? Item : never;

/** A replacement record must carry string path/before/after and, if present, string prefix/suffix. */
function isInvalidReplacementRecord(item: ReplacementRecord): boolean {
  return (
    item === null ||
    typeof item !== "object" ||
    typeof item.path !== "string" ||
    typeof item.before !== "string" ||
    typeof item.after !== "string" ||
    (item.prefix !== undefined && typeof item.prefix !== "string") ||
    (item.suffix !== undefined && typeof item.suffix !== "string")
  );
}

/** A create record must carry a string path/contents and a 0o644/0o755 mode. */
function isInvalidCreateRecord(item: CreateRecord): boolean {
  return (
    item === null ||
    typeof item !== "object" ||
    typeof item.path !== "string" ||
    typeof item.contents !== "string" ||
    (item.mode !== 0o644 && item.mode !== 0o755)
  );
}

/** A mutation record must carry a string path and contents (hashes/modes are checked elsewhere). */
function isInvalidMutationRecord(item: MutationRecord): boolean {
  return item === null || typeof item !== "object" || typeof item.path !== "string" || typeof item.contents !== "string";
}

/** A bootstrap config, when present, must be an exact-hash, valid-mode mutation record. */
function isInvalidBootstrapConfig(bootstrapConfig: ManifestShape["bootstrapConfig"]): boolean {
  return (
    bootstrapConfig === null ||
    typeof bootstrapConfig !== "object" ||
    typeof bootstrapConfig.path !== "string" ||
    typeof bootstrapConfig.contents !== "string" ||
    bootstrapConfig.resultHash !== hashText(bootstrapConfig.contents) ||
    ![0o644, 0o755].includes(bootstrapConfig.preconditionMode as number) ||
    ![0o644, 0o755].includes(bootstrapConfig.resultMode)
  );
}

/** The manifest must be a plain object carrying the schema version this codebase understands. */
function assertManifestIsObject(value: unknown): asserts value is ManifestShape {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new PreparerError("preparer manifest must be a JSON object");
  const manifest = value as ManifestShape;
  if (manifest.schemaVersion !== PREPARER_MANIFEST_SCHEMA_VERSION) throw new PreparerError("unsupported preparer manifest schema");
}

/** The manifest's own identity, baseline, bootstrap config and preparer id/command fields. */
function assertManifestEnvelopeFields(manifest: ManifestShape): void {
  if (typeof manifest.planId !== "string" || typeof manifest.extractionPlanId !== "string")
    throw new PreparerError("preparer manifest identities must be strings");
  if (manifest.baseline === undefined || typeof manifest.baseline.commit !== "string" || typeof manifest.baseline.configDigest !== "string")
    throw new PreparerError("preparer manifest baseline is invalid");
  if (manifest.bootstrapConfig !== undefined && isInvalidBootstrapConfig(manifest.bootstrapConfig))
    throw new PreparerError("preparer manifest bootstrap config is invalid");
  if (manifest.preparer === undefined || typeof manifest.preparer.id !== "string") throw new PreparerError("preparer manifest policy is invalid");
  if (manifest.preparer.command !== undefined && typeof manifest.preparer.command !== "string") throw new PreparerError("preparer manifest command is invalid");
}

/** First half of the structural shape checks: the manifest envelope through the preparer's own command. */
function assertManifestEnvelopeShape(value: unknown): asserts value is ManifestShape {
  assertManifestIsObject(value);
  assertManifestEnvelopeFields(value);
}

/** The preparer policy's own declared records: replacements, creates and commit metadata. */
function assertManifestPreparerRecordsShape(preparer: NonNullable<ManifestShape["preparer"]>): void {
  if (preparer.replacements !== undefined && (!Array.isArray(preparer.replacements) || preparer.replacements.some(isInvalidReplacementRecord)))
    throw new PreparerError("preparer manifest replacements are invalid");
  if (preparer.creates !== undefined && (!Array.isArray(preparer.creates) || preparer.creates.some(isInvalidCreateRecord)))
    throw new PreparerError("preparer manifest creates are invalid");
  if (preparer.commit === undefined || typeof preparer.commit.subject !== "string") throw new PreparerError("preparer manifest commit policy is invalid");
}

/** The manifest's move binding and effective mutation/generation scope. */
function assertManifestScopeShape(manifest: ManifestShape): void {
  if (manifest.binding === undefined || Object.values(manifest.binding).some((item) => typeof item !== "string"))
    throw new PreparerError("preparer manifest move binding is invalid");
  if (!Array.isArray(manifest.mutations) || manifest.mutations.some(isInvalidMutationRecord))
    throw new PreparerError("preparer manifest mutations are invalid");
  if (
    !Array.isArray(manifest.generatedArtifacts) ||
    !Array.isArray(manifest.postJournalPreparers) ||
    !Array.isArray(manifest.triggerPaths) ||
    !Array.isArray(manifest.changedFiles)
  )
    throw new PreparerError("preparer manifest generation scope is invalid");
}

/** Second half of the structural shape checks: the preparer's declared records through generation scope. */
function assertManifestRecordsShape(manifest: ManifestShape): asserts manifest is PreparerManifest {
  assertManifestPreparerRecordsShape(manifest.preparer!);
  assertManifestScopeShape(manifest);
}

/** Structural shape validation only — no configuration lookups. */
export function assertPreparerManifestShape(value: unknown): asserts value is PreparerManifest {
  assertManifestEnvelopeShape(value);
  assertManifestRecordsShape(value);
}

/** Configuration-consistency validation of an already shape-checked manifest. */
export function assertPreparerManifestMatchesConfig(config: MonocarveConfig, manifest: PreparerManifest): void {
  if (manifest.baseline.configDigest !== configDigest(config)) throw new PreparerError("preparer manifest configuration digest mismatch");
  const { planId: _planId, ...draft } = manifest;
  if (manifest.planId !== hashJson(draft)) throw new PreparerError("preparer manifest identity mismatch");
  const policy = findPolicy(config, manifest.preparer.id);
  if (policy.phase !== manifest.preparer.phase) throw new PreparerError("preparer manifest phase differs from configuration");
  const vars = {
    app: manifest.binding.application,
    package: manifest.binding.packageName,
    packageRoot: manifest.binding.packageRoot,
    planId: manifest.extractionPlanId,
    sourcePath: manifest.binding.sourcePath,
    targetPath: manifest.binding.targetPath,
  };
  const { renderedOutputs, expectedCreates } = assertPreparerCommandsMatch(policy, vars, manifest);
  assertPreparerScopeMatches(config, manifest, renderedOutputs, expectedCreates);
}

/** Compare the manifest's captured command/replacements/creates/verify/commit against what the policy renders now. */
function assertPreparerCommandsMatch(
  policy: PreparerConfig,
  vars: Readonly<Record<string, string>>,
  manifest: PreparerManifest,
): { renderedOutputs: string[]; expectedCreates: ReturnType<typeof expandCreatesPolicy> } {
  const expectedCommand = policy.command === undefined ? undefined : renderTemplate(policy.command, vars);
  // Validate replacement paths the same way the compile path does, so a hand-edited manifest cannot carry a path the compiler would have rejected.
  const expectedReplacements = expandReplacementsPolicy(policy.replacements, vars, (path) => validatedPath(".", path));
  const expectedCreates = expandCreatesPolicy(".", policy.creates, vars);
  const renderedOutputs = expandDeclaredOutputs(policy, vars, (path) => validatedPath(".", path));
  assertNoDuplicatePaths(renderedOutputs, "duplicate declared preparer output path");
  const redundantCreateOutput = expectedCreates?.find((create) => renderedOutputs.includes(create.path));
  if (redundantCreateOutput !== undefined)
    throw new PreparerError(`created path is automatically an output and must not be declared twice: ${redundantCreateOutput.path}`);
  const expectedVerify = policy.verify === undefined ? undefined : renderTemplate(policy.verify, vars);
  const expectedCommit = renderCommit(policy, vars);
  if (
    manifest.preparer.command !== expectedCommand ||
    !sameOptionalPolicy(manifest.preparer.replacements, expectedReplacements) ||
    !sameOptionalPolicy(manifest.preparer.creates, expectedCreates) ||
    manifest.preparer.verify !== expectedVerify ||
    hashJson(manifest.preparer.commit) !== hashJson(expectedCommit)
  ) {
    throw new PreparerError("preparer manifest commands differ from configuration");
  }
  return { renderedOutputs, expectedCreates };
}

/** Compare the manifest's declared generation scope and output set against what the policy renders now. */
function assertPreparerScopeMatches(
  config: MonocarveConfig,
  manifest: PreparerManifest,
  renderedOutputs: readonly string[],
  expectedCreates: ReturnType<typeof expandCreatesPolicy>,
): void {
  const expectedPrimaryOutputs = unique([...renderedOutputs, ...(expectedCreates?.map((create) => create.path) ?? [])]);
  const expectedTriggerPaths = [...expectedPrimaryOutputs].sort(byCodeUnit);
  if (hashJson(manifest.triggerPaths) !== hashJson(expectedTriggerPaths))
    throw new PreparerError("preparer manifest trigger paths differ from declared mutations");
  const expectedArtifacts = expandGeneratedArtifacts(config, manifest.triggerPaths);
  const expectedPostJournal = preparationPostJournalRecords(config, manifest.triggerPaths);
  if (hashJson(manifest.generatedArtifacts) !== hashJson(expectedArtifacts) || hashJson(manifest.postJournalPreparers) !== hashJson(expectedPostJournal))
    throw new PreparerError("preparer manifest generation policy differs from configuration");
  const expectedOutputs = unique([
    ...expectedPrimaryOutputs,
    ...expectedArtifacts.map((item) => item.path),
    ...expectedPostJournal.flatMap((item) => item.outputs),
  ]);
  if (hashJson(manifest.changedFiles) !== hashJson(expectedOutputs)) throw new PreparerError("preparer manifest changed scope differs from configuration");
  const actualOutputs = manifest.mutations.map((item) => item.path).sort(byCodeUnit);
  if (manifest.bootstrapConfig !== undefined) {
    validatedPath(".", manifest.bootstrapConfig.path);
    if (actualOutputs.includes(manifest.bootstrapConfig.path)) throw new PreparerError("bootstrap config cannot also be a preparer output");
  }
  if (expectedOutputs.length !== actualOutputs.length || expectedOutputs.some((path, index) => path !== actualOutputs[index])) {
    throw new PreparerError("preparer manifest outputs differ from configuration");
  }
  assertPreparerCreatesMatchMutations(manifest);
}

/** Every declared create must appear as an exact-result mutation with a missing-or-already-created precondition. */
function assertPreparerCreatesMatchMutations(manifest: PreparerManifest): void {
  for (const create of manifest.preparer.creates ?? []) {
    const mutation = manifest.mutations.find((item) => item.path === create.path);
    if (
      mutation === undefined ||
      mutation.contents !== create.contents ||
      mutation.resultHash !== hashText(create.contents) ||
      mutation.resultMode !== create.mode
    ) {
      throw new PreparerError(`preparer manifest create result differs from policy: ${create.path}`);
    }
    const absent = mutation.preconditionHash === MISSING && mutation.preconditionMode === MISSING;
    const alreadyCreated = mutation.preconditionHash === mutation.resultHash && mutation.preconditionMode === mutation.resultMode;
    if (!absent && !alreadyCreated) throw new PreparerError(`preparer manifest create precondition is neither missing nor exact: ${create.path}`);
  }
}
