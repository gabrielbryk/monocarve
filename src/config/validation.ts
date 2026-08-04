import { z } from "zod";

import { packageNameOf } from "./helpers.ts";
import type { MonocarveConfig } from "./schema.ts";

export function validateIntegrationTestSuites(config: MonocarveConfig, ctx: z.RefinementCtx): void {
  for (const [name, suite] of Object.entries(config.integrationTestSuites)) {
    const path = ["integrationTestSuites", name] as const;
    const app = config.applications.find((candidate) => candidate.name === suite.application);
    if (!app) {
      ctx.addIssue({ code: "custom", path: [...path, "application"], message: "must name a configured application" });
      continue;
    }
    if (!app.packageName) {
      ctx.addIssue({ code: "custom", path: [...path, "application"], message: "must declare application.packageName" });
    }
    const scanRoots = [...config.applications.map((candidate) => candidate.sourceRoot), ...config.packageRoots, ...config.firstPartyRoots];
    if (!scanRoots.some((root) => suite.sourceRoot === root || suite.sourceRoot.startsWith(`${root}/`))) {
      ctx.addIssue({ code: "custom", path: [...path, "sourceRoot"], message: "must be below a configured application, package, or first-party scan root" });
    }
    const suiteProfile = config.extractionProfiles.profiles[suite.profile];
    if (!suiteProfile) {
      ctx.addIssue({ code: "custom", path: [...path, "profile"], message: "must name a configured extraction profile" });
    } else if (suiteProfile.kind !== "leaf-test") {
      ctx.addIssue({ code: "custom", path: [...path, "profile"], message: "must name a leaf-test extraction profile" });
    } else if ((suiteProfile.gates?.package ?? config.gates.package).length === 0) {
      ctx.addIssue({ code: "custom", path: [...path, "profile"], message: "leaf-test profiles must declare or inherit at least one package gate" });
    }
    const seen = new Set<string>();
    for (const [index, donor] of suite.donorImports.entries()) {
      if (seen.has(donor.source)) {
        ctx.addIssue({ code: "custom", path: [...path, "donorImports", index, "source"], message: "must be unique" });
      }
      seen.add(donor.source);
      if (!donor.source.startsWith(`${app.sourceRoot}/`)) {
        ctx.addIssue({ code: "custom", path: [...path, "donorImports", index, "source"], message: "must be below the donating application's sourceRoot" });
      }
      if (app.packageName && packageNameOf(donor.specifier) !== app.packageName) {
        ctx.addIssue({ code: "custom", path: [...path, "donorImports", index, "specifier"], message: "must belong to the donating application's packageName" });
      }
    }
  }
}

/** Equal, or one a directory ancestor of the other. */
function rootsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

/**
 * `firstPartyPackages` roots must not overlap each other or a `packageRoots` /
 * `firstPartyRoots` entry — including ancestor/descendant overlap, not just
 * equality, since a path under two roots would leave `ownerFor` unable to say
 * which model owns it — and every declared package name must be unique so
 * dependency inference has exactly one owner to resolve to.
 */
export function validateFirstPartyPackages(config: MonocarveConfig, ctx: z.RefinementCtx): void {
  const otherRoots = [...config.packageRoots, ...config.firstPartyRoots];
  const seenNames = new Set<string>();
  config.firstPartyPackages.forEach((pkg, index) => {
    const path = ["firstPartyPackages", index] as const;
    const overlappingOther = otherRoots.find((root) => rootsOverlap(pkg.root, root));
    if (overlappingOther !== undefined) {
      ctx.addIssue({ code: "custom", path: [...path, "root"], message: `must not overlap packageRoots/firstPartyRoots entry ${overlappingOther}` });
    }
    const overlappingSibling = config.firstPartyPackages.find((other, otherIndex) => otherIndex !== index && rootsOverlap(pkg.root, other.root));
    if (overlappingSibling !== undefined) {
      ctx.addIssue({ code: "custom", path: [...path, "root"], message: `must not overlap another firstPartyPackages entry: ${overlappingSibling.root}` });
    }
    if (seenNames.has(pkg.name)) {
      ctx.addIssue({ code: "custom", path: [...path, "name"], message: "must be unique among firstPartyPackages" });
    }
    seenNames.add(pkg.name);
  });
}

export function validateTestKinds(config: MonocarveConfig, ctx: z.RefinementCtx): void {
  if (config.testKinds === undefined) return;
  if (config.testPathPatterns.length > 0) {
    ctx.addIssue({ code: "custom", path: ["testKinds"], message: "cannot be combined with legacy testPathPatterns" });
  }
  const seen = new Set<string>();
  for (const [kind, patterns] of Object.entries(config.testKinds)) {
    for (const [index, pattern] of patterns.entries()) {
      if (seen.has(pattern)) ctx.addIssue({ code: "custom", path: ["testKinds", kind, index], message: "must not repeat a pattern across test kinds" });
      seen.add(pattern);
    }
  }
}
