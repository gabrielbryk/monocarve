import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { analyzeDeclarationBatch } from "../assessment/batch.ts";
import { loadReplaySnapshot } from "../assessment/bundle-replay.ts";
import { defaultAssessmentArguments, publishAssessment, reportsForSnapshot } from "../assessment/bundle.ts";
import { assertEvidenceDestination } from "../assessment/evidence.ts";
import { captureAssessmentSnapshot } from "../assessment/snapshot.ts";
import { flagBool, flagNumber, flagString, flagStrings, type ParsedArgs } from "../cli/args.ts";
import { UsageError } from "../errors.ts";
import { byCodeUnit } from "../util/hash.ts";
import { analyticalRootsFor, handleAssessmentFailure, MUTATION_ONLY_FLAGS, positiveInteger, setQualificationExitCode } from "./assessment-outcome.ts";
import { load, print } from "./shared.ts";
import type { CommandSpec } from "./types.ts";

interface AssessmentInvocation {
  readonly application: string;
  readonly destination: string;
  readonly files: readonly string[];
  readonly hotspotCount?: number;
  readonly limit: number;
  readonly maxBytes?: number;
  readonly replay?: string;
}

async function assess(args: ParsedArgs): Promise<void> {
  const invocation = parseInvocation(args);
  try {
    await runAssessment(args, invocation);
  } catch (error) {
    handleAssessmentFailure(args, error, {
      impact: "No new authoritative assessment bundle was published.",
      batchFailureHeadline: "Declaration batch incomplete; no assessment evidence was published.",
    });
  }
}

function parseInvocation(args: ParsedArgs): AssessmentInvocation {
  const application = flagString(args, "app");
  const destination = flagString(args, "evidence-dir");
  if (application === undefined || destination === undefined) throw new UsageError("assess requires --app <name> and --evidence-dir <path>");
  if (args.positionals.length > 0) throw new UsageError("assess rejects positional targets; use repeated --file or --split-hotspots");
  if (args.flags.has("out")) throw new UsageError("assess rejects --out; use --evidence-dir");
  if (args.repeated.has("graph"))
    throw new UsageError("ASSESSMENT_REPLAY_PROVENANCE_REQUIRED: assess refuses bare --graph reports; use --replay with a complete assessment bundle");
  const mutation = MUTATION_ONLY_FLAGS.find((name) => args.flags.has(name));
  if (mutation) throw new UsageError(`assess does not accept mutation-only --${mutation}`);
  const files = flagStrings(args, "file");
  if ((args.repeated.get("split-hotspots")?.length ?? 0) > 1) throw new UsageError("assess accepts --split-hotspots only once");
  const hotspot = flagString(args, "split-hotspots");
  if (files.length > 0 && hotspot !== undefined) throw new UsageError("--file and --split-hotspots are mutually exclusive");
  const hotspotCount = hotspot === undefined ? undefined : positiveInteger(Number(hotspot), "--split-hotspots");
  const limit = positiveInteger(flagNumber(args, "limit", 20), "--limit");
  const maxBytesRaw = flagString(args, "max-bytes");
  const maxBytes = maxBytesRaw === undefined ? undefined : positiveInteger(Number(maxBytesRaw), "--max-bytes");
  const replay = flagString(args, "replay");
  return {
    application,
    destination,
    files,
    limit,
    ...(hotspotCount === undefined ? {} : { hotspotCount }),
    ...(maxBytes === undefined ? {} : { maxBytes }),
    ...(replay === undefined ? {} : { replay }),
  };
}

async function runAssessment(args: ParsedArgs, invocation: AssessmentInvocation): Promise<void> {
  const loaded = await load(args, { refuseStaticFilesystemImports: true, executionBoundary: "snapshot" });
  const analyticalRoots = analyticalRootsFor(loaded);
  const canonicalDestination = assertEvidenceDestination(loaded.rootDir, invocation.destination, analyticalRoots);
  const replayDestination = replayDestinationFor(loaded.rootDir, invocation.replay, analyticalRoots);
  const excludedRoots = [...new Set([canonicalDestination, ...(replayDestination === undefined ? [] : [replayDestination])])];
  const snapshot =
    invocation.replay === undefined
      ? await captureAssessmentSnapshot({
          ...loaded,
          application: invocation.application,
          ...(flagBool(args, "allow-empty") ? { allowEmpty: true } : {}),
          excludedRoots,
        })
      : await loadReplaySnapshot({ ...loaded, application: invocation.application, bundleDirectory: invocation.replay, excludedRoots });
  const baseArguments = defaultAssessmentArguments(invocation.application, {
    limit: invocation.limit,
    ...(flagBool(args, "full-portfolio") ? { fullPortfolio: true } : {}),
  });
  const selection =
    invocation.files.length > 0
      ? { mode: "files" as const, paths: invocation.files }
      : invocation.hotspotCount === undefined
        ? undefined
        : { mode: "hotspots" as const, count: invocation.hotspotCount };
  const batch = selection === undefined ? undefined : analyzeDeclarationBatch(snapshot, selection);
  const analyticalArguments =
    selection === undefined
      ? baseArguments
      : {
          ...baseArguments,
          splitSelection:
            selection.mode === "files"
              ? { mode: "files" as const, paths: [...new Set(invocation.files)].toSorted(byCodeUnit) }
              : { mode: "hotspots" as const, count: selection.count },
        };
  const reports = reportsForSnapshot(snapshot, analyticalArguments, batch);
  const result = publishAssessment({
    snapshot,
    reports,
    destination: canonicalDestination,
    analyticalRoots,
    arguments: analyticalArguments,
    ...(flagBool(args, "replace-generated") ? { replaceGenerated: true } : {}),
    ...(invocation.maxBytes === undefined ? {} : { maxBytes: invocation.maxBytes }),
    ...(batch === undefined ? {} : { batch }),
  });
  print(
    {
      schemaVersion: 1,
      status: snapshot.qualification.status,
      exitCode: snapshot.qualification.exitCode,
      published: true,
      overrides: snapshot.qualification.overrides,
      evidenceDirectory: result.destination,
      totalBytes: result.totalBytes,
      diagnostics: snapshot.qualification.diagnostics,
    },
    args,
  );
  setQualificationExitCode(snapshot.qualification);
}

function replayDestinationFor(rootDir: string, replay: string | undefined, analyticalRoots: readonly string[]): string | undefined {
  if (replay === undefined || !existsSync(resolve(rootDir, replay))) return replay;
  return assertEvidenceDestination(rootDir, replay, analyticalRoots);
}

export const assessmentCommands: Record<string, CommandSpec> = {
  assess: {
    summary: "capture a reproducible architecture assessment",
    usage:
      "assess --app <name> --evidence-dir <path> [--file <path> ... | --split-hotspots <n>] [--replay <bundle>] [--allow-empty] [--replace-generated] [--max-bytes <n>] [--limit <n>] [--full-portfolio]",
    details:
      "Captures one read-only scanner baseline, derives normalized architecture evidence, and publishes a manifest-bound bundle. Bare --graph replay and mutation-only flags are refused.",
    run: assess,
  },
};
