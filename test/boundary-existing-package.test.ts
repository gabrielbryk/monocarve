/**
 * `planExistingPackageBoundary` — the "existing-package" strategy: rewrite
 * every consumer of an app shim to the config-declared real package
 * specifier, and (opt-in) delete the shim once its consumers are rewritten
 * in the same manifest.
 */

import { describe, expect, test, afterAll } from "bun:test";

import { BoundaryImportError, planExistingPackageBoundary, type RetainedImporterInput } from "../src/prepare/boundary-imports.ts";
import type { ResolvedExistingPackageBoundary } from "../src/prepare/boundary-resolve.ts";
import { hashText } from "../src/util/hash.ts";
import { cleanupFixtures, fixtureRepo, read } from "./support/fixture-repo.ts";

afterAll(cleanupFixtures);

const RETAINED = "apps/api/src/config/env.ts";
const RETAINED_SOURCE = 'export const env = "prod";\n';
const CONSUMER_PATH = "apps/api/src/orders/service.ts";
const CONSUMER_SOURCE = 'import { env } from "../config/env.ts";\nexport const value = env;\n';

function boundary(overrides: Partial<ResolvedExistingPackageBoundary> = {}): ResolvedExistingPackageBoundary {
  return {
    id: "env-shim",
    source: "compositionBoundaries",
    strategy: "existing-package",
    retained: RETAINED,
    replacementSpecifier: "@acme/env",
    replacementSymbols: ["env"],
    retire: false,
    selective: false,
    ...overrides,
  };
}

function repo(): string {
  return fixtureRepo({
    [RETAINED]: RETAINED_SOURCE,
    [CONSUMER_PATH]: CONSUMER_SOURCE,
  });
}

function importer(overrides: Partial<RetainedImporterInput> = {}): RetainedImporterInput {
  return {
    path: CONSUMER_PATH,
    preconditionHash: hashText(CONSUMER_SOURCE),
    mode: 0o644,
    text: CONSUMER_SOURCE,
    specifier: "../config/env.ts",
    importedSymbols: ["env"],
    ...overrides,
  };
}

describe("planExistingPackageBoundary", () => {
  test("rewrites a consumer of the shim to the real package specifier, byte-exactly", () => {
    const root = repo();
    const result = planExistingPackageBoundary({
      rootDir: root,
      boundary: boundary(),
      retainedPrecondition: hashText(read(root, RETAINED)),
      retainedMode: 0o644,
      importers: [importer()],
    });

    const expectedContents = 'import { env } from "@acme/env";\nexport const value = env;\n';
    expect(result.rewrites).toHaveLength(1);
    expect(result.rewrites[0]?.contents).toBe(expectedContents);
    expect(result.rewrites[0]?.file).toMatchObject({
      path: CONSUMER_PATH,
      preconditionHash: hashText(CONSUMER_SOURCE),
      resultHash: hashText(expectedContents),
    });
    expect(result.rewrites[0]?.rewrites).toEqual([{ from: "../config/env.ts", to: "@acme/env", symbols: ["env"] }]);
    expect(result.deletion).toBeUndefined();
  });

  test("a consumer importing a symbol not in the declared replacement is refused, naming the symbol", () => {
    const root = repo();
    const badSource = 'import { env, other } from "../config/env.ts";\nexport const value = env;\nexport const otherValue = other;\n';
    const plan = () =>
      planExistingPackageBoundary({
        rootDir: root,
        boundary: boundary(),
        retainedPrecondition: hashText(read(root, RETAINED)),
        retainedMode: 0o644,
        importers: [importer({ text: badSource, importedSymbols: ["env", "other"] })],
      });

    expect(plan).toThrow(BoundaryImportError);
    expect(plan).toThrow(/imports other from apps\/api\/src\/config\/env\.ts, which is not in the declared replacement symbol list for boundary env-shim/);
  });

  test("retire:true emits a delete-module operation whose importerProof exactly matches the manifest's own rewrites", () => {
    const root = repo();
    const result = planExistingPackageBoundary({
      rootDir: root,
      boundary: boundary({ retire: true }),
      retainedPrecondition: hashText(read(root, RETAINED)),
      retainedMode: 0o644,
      importers: [importer()],
    });

    expect(result.deletion).toBeDefined();
    expect(result.deletion?.importerProof).toEqual(result.rewrites.map((rewrite) => rewrite.file.path));
    expect(result.deletion?.file).toMatchObject({ path: RETAINED, preconditionHash: hashText(read(root, RETAINED)) });
  });

  test("retire:true with zero remaining importers deletes the shim with an empty importerProof", () => {
    const root = fixtureRepo({ [RETAINED]: RETAINED_SOURCE });
    const result = planExistingPackageBoundary({
      rootDir: root,
      boundary: boundary({ retire: true }),
      retainedPrecondition: hashText(read(root, RETAINED)),
      retainedMode: 0o644,
      importers: [],
    });

    expect(result.deletion?.importerProof).toEqual([]);
  });

  test("a remaining importer whose symbol usage is outside the replacement blocks retirement — the whole plan refuses rather than deleting around it", () => {
    const root = repo();
    const badSource = 'import { other } from "../config/env.ts";\nexport const value = other;\n';

    expect(() =>
      planExistingPackageBoundary({
        rootDir: root,
        boundary: boundary({ retire: true }),
        retainedPrecondition: hashText(read(root, RETAINED)),
        retainedMode: 0o644,
        importers: [importer(), importer({ path: "apps/api/src/orders/other.ts", text: badSource, importedSymbols: ["other"] })],
      }),
    ).toThrow(/imports other from apps\/api\/src\/config\/env\.ts, which is not in the declared replacement symbol list/);
  });
});
