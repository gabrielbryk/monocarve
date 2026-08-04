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
