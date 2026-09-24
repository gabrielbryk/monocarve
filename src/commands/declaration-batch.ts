import { analyzeDeclarationBatch, BatchAnalysisError } from "../assessment/batch.ts";
import { loadReplaySnapshot } from "../assessment/bundle-replay.ts";
import { defaultAssessmentArguments, publishDeclarationBatch } from "../assessment/bundle.ts";
import { assertEvidenceDestination, EvidenceError } from "../assessment/evidence.ts";
import { AssessmentQualificationError, captureAssessmentSnapshot } from "../assessment/snapshot.ts";
import { flagBool, flagString, flagStrings, type ParsedArgs } from "../cli/args.ts";
import { ConfigError, IoError, UsageError } from "../errors.ts";
import { byCodeUnit } from "../util/hash.ts";
import { load, print } from "./shared.ts";

const MUTATION_ONLY_FLAGS = [
  "plan",
  "apply",
  "approve",
  "simulate",
  "prepare",
  "journal",
  "allow-dirty",
  "write",
  "commit",
  "commit-approval",
  "resume",
  "recover",
  "skip-gates",
  "force",
  "replace",
  "delete",
  "execute",
  "target",
  "package-name",
  "package-root",
  "retire-donors",
] as const;

interface BatchInvocation {
  readonly application: string;
  readonly destination: string;
  readonly files: readonly string[];
  readonly hotspotCount?: number;
  readonly maxBytes?: number;
  readonly replay?: string;
}

export function isDeclarationBatchArgs(args: ParsedArgs): boolean {
  return (
    (args.repeated.get("file")?.length ?? 0) > 1 ||
    args.flags.has("split-hotspots") ||
    args.flags.has("evidence-dir") ||
    args.flags.has("replace-generated") ||
    args.flags.has("max-bytes") ||
    args.flags.has("allow-empty") ||
    args.flags.has("replay")
  );
}

export async function runDeclarationBatch(args: ParsedArgs): Promise<void> {
  const invocation = parseBatchInvocation(args);
  try {
    await executeDeclarationBatch(args, invocation);
  } catch (error) {
    handleBatchFailure(args, error);
  }
}

function parseBatchInvocation(args: ParsedArgs): BatchInvocation {
  const application = flagString(args, "app");
  const destination = flagString(args, "evidence-dir");
  if (application === undefined || destination === undefined) throw new UsageError("batch split-candidates requires --app <name> and --evidence-dir <path>");
  const mutation = MUTATION_ONLY_FLAGS.find((name) => args.flags.has(name));
  if (mutation) throw new UsageError(`batch split-candidates does not accept mutation-only --${mutation}`);
  if (args.positionals.length > 0 || args.flags.has("out")) throw new UsageError("batch split-candidates rejects positional targets and --out");
  if (args.repeated.has("graph")) throw new UsageError("ASSESSMENT_REPLAY_PROVENANCE_REQUIRED: batch analysis refuses bare --graph reports; use --replay");
  const files = flagStrings(args, "file");
  if ((args.repeated.get("split-hotspots")?.length ?? 0) > 1) throw new UsageError("batch split-candidates accepts --split-hotspots only once");
  const hotspotRaw = flagString(args, "split-hotspots");
  if (files.length > 0 === (hotspotRaw !== undefined))
    throw new UsageError("batch split-candidates requires exactly one of repeated --file or --split-hotspots <n>");
  const hotspotCount = hotspotRaw === undefined ? undefined : positiveInteger(hotspotRaw, "--split-hotspots");
  const maxRaw = flagString(args, "max-bytes");
  const maxBytes = maxRaw === undefined ? undefined : positiveInteger(maxRaw, "--max-bytes");
  const replay = flagString(args, "replay");
  return {
    application,
    destination,
    files,
    ...(hotspotCount === undefined ? {} : { hotspotCount }),
    ...(maxBytes === undefined ? {} : { maxBytes }),
    ...(replay === undefined ? {} : { replay }),
  };
}

async function executeDeclarationBatch(args: ParsedArgs, invocation: BatchInvocation): Promise<void> {
  const loaded = await load(args, { refuseStaticFilesystemImports: true, executionBoundary: "snapshot" });
  const analyticalRoots = [
    ...loaded.config.applications.flatMap((entry) => [entry.sourceRoot, ...entry.consumerRoots]),
    ...loaded.config.packageRoots,
    ...loaded.config.firstPartyRoots,
    ...loaded.config.firstPartyPackages.map((entry) => entry.root),
  ];
  const canonicalDestination = assertEvidenceDestination(loaded.rootDir, invocation.destination, analyticalRoots);
  if (invocation.replay !== undefined) assertEvidenceDestination(loaded.rootDir, invocation.replay, analyticalRoots);
  const excludedRoots = [...new Set([canonicalDestination, ...(invocation.replay === undefined ? [] : [invocation.replay])])];
  const snapshot =
    invocation.replay === undefined
      ? await captureAssessmentSnapshot({
          ...loaded,
          application: invocation.application,
          ...(flagBool(args, "allow-empty") ? { allowEmpty: true } : {}),
          excludedRoots,
        })
      : await loadReplaySnapshot({ ...loaded, application: invocation.application, bundleDirectory: invocation.replay, excludedRoots });
  const selection =
    invocation.hotspotCount === undefined ? { mode: "files" as const, paths: invocation.files } : { mode: "hotspots" as const, count: invocation.hotspotCount };
  const batch = analyzeDeclarationBatch(snapshot, selection);
  const analyticalArguments = {
    ...defaultAssessmentArguments(invocation.application),
    splitSelection:
      invocation.hotspotCount === undefined
        ? { mode: "files" as const, paths: [...new Set(invocation.files)].sort(byCodeUnit) }
        : { mode: "hotspots" as const, count: invocation.hotspotCount },
  };
  const result = publishDeclarationBatch({
    snapshot,
    batch,
    destination: canonicalDestination,
    analyticalRoots,
    arguments: analyticalArguments,
    ...(flagBool(args, "replace-generated") ? { replaceGenerated: true } : {}),
    ...(invocation.maxBytes === undefined ? {} : { maxBytes: invocation.maxBytes }),
  });
  print(
    flagBool(args, "json")
      ? {
          ...batch.aggregate,
          status: snapshot.qualification.status,
          exitCode: snapshot.qualification.exitCode,
          published: true,
          overrides: snapshot.qualification.overrides,
        }
      : humanBatch(batch.aggregate, result.destination),
    args,
  );
  process.exitCode = snapshot.qualification.exitCode;
}

function handleBatchFailure(args: ParsedArgs, error: unknown): never | void {
  if (error instanceof BatchAnalysisError) {
    const failure = {
      schemaVersion: 1,
      status: "fatal" as const,
      exitCode: 1 as const,
      published: false,
      code: "SPLIT_ANALYSIS_INCOMPLETE" as const,
      ...error.aggregate,
    };
    print(flagBool(args, "json") ? failure : humanBatchFailure(failure), args);
    process.exitCode = 1;
    return;
  }
  if (error instanceof AssessmentQualificationError) return printFatal(args, error.qualification.diagnostics, error.qualification.overrides);
  if (error instanceof EvidenceError)
    return printFatal(args, [
      { code: error.code, severity: "error", message: error.message, impact: "No new authoritative declaration batch bundle was published." },
    ]);
  if (error instanceof ConfigError || error instanceof IoError)
    return printFatal(args, [
      {
        code: "ASSESSMENT_INPUT_UNREADABLE",
        severity: "error",
        message: error.message,
        impact: "No new authoritative declaration batch bundle was published.",
      },
    ]);
  if (error instanceof Error) throw error;
  throw new Error(String(error));
}

function printFatal(args: ParsedArgs, diagnostics: readonly unknown[], overrides: readonly string[] = []): void {
  print({ schemaVersion: 1, status: "fatal", exitCode: 1, published: false, overrides, diagnostics }, args);
  process.exitCode = 1;
}

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new UsageError(`${name} must be a positive integer`);
  return parsed;
}

function humanBatch(
  aggregate: { completed: readonly string[]; failed: readonly string[]; entries: readonly { sourcePath: string; splitCandidateCount: number }[] },
  destination: string,
): string {
  return [
    `Declaration batch: ${aggregate.completed.length} complete, ${aggregate.failed.length} failed`,
    ...aggregate.entries.map((entry) => `  ${entry.sourcePath}: ${entry.splitCandidateCount} split candidates`),
    `Evidence: ${destination}`,
  ].join("\n");
}

function humanBatchFailure(aggregate: { readonly completed: readonly string[]; readonly failed: readonly string[] }): string {
  return [
    "Declaration batch incomplete; no evidence was published.",
    `Completed (${aggregate.completed.length}): ${aggregate.completed.length === 0 ? "none" : aggregate.completed.join(", ")}`,
    `Failed (${aggregate.failed.length}): ${aggregate.failed.length === 0 ? "none" : aggregate.failed.join(", ")}`,
  ].join("\n");
}
