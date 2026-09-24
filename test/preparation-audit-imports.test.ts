import { afterEach, describe, expect, test } from "bun:test";

import { verifyTargetImportProofs } from "../src/prepare/audit-imports.ts";
import type { ExtractTypeDeclarationsOperation } from "../src/prepare/manifest-types.ts";
import { hashText } from "../src/util/hash.ts";
import { cleanupFixtures, fixtureConfig, fixtureRepo } from "./support/fixture-repo.ts";

describe("preparation inline import audit", () => {
  afterEach(cleanupFixtures);

  test("independently rejects provenance that resolves the rewritten inline type to another module", () => {
    const donor = 'export type Shape = import("./models.ts").Shape;\n';
    const target = 'export type Shape = import("../wrong.ts").Shape;\n';
    const root = fixtureRepo({
      "apps/api/tsconfig.json": '{"compilerOptions":{"module":"NodeNext","moduleResolution":"NodeNext"},"include":["src"]}\n',
      "apps/api/src/contracts.ts": donor,
      "apps/api/src/models.ts": "export interface Shape {}\n",
      "apps/api/src/types/contracts.ts": target,
      "apps/api/src/wrong.ts": "export interface Shape {}\n",
    });
    const operation = {
      donor: { path: "apps/api/src/contracts.ts", preconditionHash: hashText(donor) },
      target: { path: "apps/api/src/types/contracts.ts" },
      targetContents: target,
      targetImportProofs: [],
      inlineImportTypeProofs: [
        {
          originalSpecifier: "./models.ts",
          targetSpecifier: "../wrong.ts",
          resolvedSourcePath: "apps/api/src/models.ts",
          start: donor.indexOf('"./models.ts"'),
          end: donor.indexOf('"./models.ts"') + '"./models.ts"'.length,
          sourceHash: hashText('"./models.ts"'),
          proofBaselineHash: hashText(donor),
        },
      ],
    } as unknown as ExtractTypeDeclarationsOperation;
    const failures: string[] = [];

    verifyTargetImportProofs(root, fixtureConfig(root), [operation], new Map([["apps/api/src/contracts.ts", new TextEncoder().encode(donor)]]), failures);

    expect(failures).toContain("inline import type rewrite resolves to a different module: apps/api/src/types/contracts.ts:../wrong.ts");
  });

  test.each([
    {
      label: "extensionless",
      donorPath: "apps/api/src/contracts.ts",
      targetPath: "apps/api/src/types/contracts.ts",
      original: "./models",
      rewritten: "../models",
      resolved: "apps/api/src/models.ts",
      files: { "apps/api/src/models.ts": "export interface Shape {}\n" },
    },
    {
      label: "directory index",
      donorPath: "apps/api/src/contracts.ts",
      targetPath: "apps/api/src/types/contracts.ts",
      original: "./models",
      rewritten: "../models",
      resolved: "apps/api/src/models/index.ts",
      files: { "apps/api/src/models/index.ts": "export interface Shape {}\n" },
    },
    {
      label: "same directory",
      donorPath: "apps/api/src/contracts.ts",
      targetPath: "apps/api/src/contracts-types.ts",
      original: "./models",
      rewritten: "./models",
      resolved: "apps/api/src/models.ts",
      files: { "apps/api/src/models.ts": "export interface Shape {}\n" },
    },
  ])("accepts TypeScript-resolved $label inline import provenance", ({ donorPath, targetPath, original, rewritten, resolved, files }) => {
    const donor = `export type Shape = import(${JSON.stringify(original)}).Shape;\n`;
    const target = `export type Shape = import(${JSON.stringify(rewritten)}).Shape;\n`;
    const root = fixtureRepo({
      "apps/api/tsconfig.json": '{"compilerOptions":{"module":"NodeNext","moduleResolution":"NodeNext"},"include":["src"]}\n',
      ...files,
      [donorPath]: donor,
      [targetPath]: target,
    });
    const literal = JSON.stringify(original);
    const operation = {
      donor: { path: donorPath, preconditionHash: hashText(donor) },
      target: { path: targetPath },
      targetContents: target,
      targetImportProofs: [],
      inlineImportTypeProofs: [
        {
          originalSpecifier: original,
          targetSpecifier: rewritten,
          resolvedSourcePath: resolved,
          start: donor.indexOf(literal),
          end: donor.indexOf(literal) + literal.length,
          sourceHash: hashText(literal),
          proofBaselineHash: hashText(donor),
        },
      ],
    } as unknown as ExtractTypeDeclarationsOperation;
    const failures: string[] = [];
    verifyTargetImportProofs(root, fixtureConfig(root), [operation], new Map([[donorPath, new TextEncoder().encode(donor)]]), failures);
    expect(failures).toEqual([]);
  });
});
