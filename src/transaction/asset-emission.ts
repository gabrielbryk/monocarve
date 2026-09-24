import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { createPackageManagerAdapter } from "../adapters/registry.ts";
import type { AssetEmissionProofConfig, MonocarveConfig } from "../config.ts";
import { packageContainerRoots } from "../config.ts";
import type { ExtractionManifest } from "../plan/manifest.ts";
import { byCodeUnit } from "../util/hash.ts";
import { cssRuleSurface } from "./css-surface.ts";
import { createWorktree } from "./worktree.ts";

interface AssetEmissionCheck {
  readonly id: string;
  readonly passed: boolean;
  readonly baselineFiles: number;
  readonly candidateFiles: number;
  readonly missingSelectors: readonly string[];
  readonly changedDeclarationOrder: readonly string[];
  readonly failure?: string;
}

export interface AssetEmissionReport {
  readonly passed: boolean;
  readonly checks: readonly AssetEmissionCheck[];
}

interface CssSurface {
  readonly files: number;
  readonly declarations: ReadonlyMap<string, readonly string[]>;
}

export async function compareAssetEmission(input: {
  readonly config: MonocarveConfig;
  readonly rootDir: string;
  readonly candidateRoot: string;
  readonly manifest: ExtractionManifest;
}): Promise<AssetEmissionReport> {
  if (input.config.assetEmissionProofs.length === 0) return { passed: true, checks: [] };
  const baseline = await createWorktree({
    rootDir: input.rootDir,
    commit: input.manifest.baselineCommit,
    worktreeRoot: input.config.transaction.worktreeRoot,
    packageRoots: packageContainerRoots(input.config),
    nodeModules: input.config.transaction.nodeModules,
    installCommand: createPackageManagerAdapter(input.config).installCommand(),
    label: `${input.manifest.planId}-asset-baseline`,
  });
  try {
    const checks = input.config.assetEmissionProofs.map((proof) =>
      compareOne(
        proof,
        capture(baseline.workspacePath, proof, input.config.gates.timeoutMs),
        capture(input.candidateRoot, proof, input.config.gates.timeoutMs),
      ),
    );
    return { passed: checks.every((check) => check.passed), checks };
  } finally {
    await baseline.dispose();
  }
}

function capture(root: string, proof: AssetEmissionProofConfig, timeoutMs: number): CssSurface | string {
  const result = Bun.spawnSync(["sh", "-c", proof.command], { cwd: root, stdout: "pipe", stderr: "pipe", timeout: timeoutMs });
  if ((result.exitCode ?? 1) !== 0) {
    const output = `${result.stdout.toString()}\n${result.stderr.toString()}`.trim().slice(-2000);
    return `command failed (${result.exitCode ?? 1}): ${proof.command}${output ? `\n${output}` : ""}`;
  }
  const files = proof.roots
    .flatMap((configuredRoot) => walk(join(root, configuredRoot)))
    .filter((path) => proof.extensions.some((extension) => path.endsWith(extension)))
    .toSorted(byCodeUnit);
  const declarations = new Map<string, readonly string[]>();
  for (const path of files) {
    for (const rule of cssRuleSurface(readFileSync(path, "utf8"))) {
      declarations.set(rule.selector, [...(declarations.get(rule.selector) ?? []), ...rule.properties]);
    }
  }
  return { files: files.length, declarations };
}

function compareOne(proof: AssetEmissionProofConfig, baseline: CssSurface | string, candidate: CssSurface | string): AssetEmissionCheck {
  if (typeof baseline === "string" || typeof candidate === "string") {
    return {
      id: proof.id,
      passed: false,
      baselineFiles: 0,
      candidateFiles: 0,
      missingSelectors: [],
      changedDeclarationOrder: [],
      failure: typeof baseline === "string" ? `baseline ${baseline}` : typeof candidate === "string" ? `candidate ${candidate}` : "",
    };
  }
  if (baseline.files === 0 || candidate.files === 0) {
    return {
      id: proof.id,
      passed: false,
      baselineFiles: baseline.files,
      candidateFiles: candidate.files,
      missingSelectors: [],
      changedDeclarationOrder: [],
      failure: "configured asset-emission roots produced no matching files",
    };
  }
  const missingSelectors = [...baseline.declarations.keys()].filter((selector) => !candidate.declarations.has(selector)).toSorted(byCodeUnit);
  const changedDeclarationOrder = [...baseline.declarations]
    .filter(([selector, properties]) => {
      const observed = candidate.declarations.get(selector);
      return observed !== undefined && observed.join("\n") !== properties.join("\n");
    })
    .map(([selector]) => selector)
    .toSorted(byCodeUnit);
  return {
    id: proof.id,
    passed: missingSelectors.length === 0 && changedDeclarationOrder.length === 0,
    baselineFiles: baseline.files,
    candidateFiles: candidate.files,
    missingSelectors,
    changedDeclarationOrder,
  };
}

function walk(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? walk(path) : entry.isFile() ? [path] : [];
  });
}
