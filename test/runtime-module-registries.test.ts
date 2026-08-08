import { expect, test } from "bun:test";
import { posix } from "node:path";

import { rewritePathReferenceText } from "../src/plan/path-reference-rewrites.ts";
import { scanRuntimeModuleRegistry } from "../src/plan/runtime-module-registries.ts";

const declaration = {
  file: "apps/api/config/route-registry.json",
  pointer: "/domains/*/module",
  resolveFrom: "apps/api/src",
};

test("rewrites only declared runtime module fields relative to their declared resolver root", () => {
  const text = JSON.stringify({
    note: "./sales/routes.ts",
    domains: [{ id: "sales", module: "./sales/routes.ts", export: "salesRoutes" }],
  }, null, 2) + "\n";
  // The same string outside the selected field makes its raw byte location
  // ambiguous, so use a different note to prove unrelated strings are ignored.
  const unique = text.replace('"note": "./sales/routes.ts"', '"note": "./sales/routes.ts is documented here"');
  const rewrites = scanRuntimeModuleRegistry(unique, declaration, [{
    source: "apps/api/src/sales/routes.ts",
    target: "libs/sales-runtime/src/routes.ts",
  }]);

  expect(rewrites).toHaveLength(1);
  expect(rewrites[0]).toMatchObject({
    from: "./sales/routes.ts",
    to: "../../../libs/sales-runtime/src/routes.ts",
    donor: "apps/api/src/sales/routes.ts",
    jsonPointer: "/domains/0/module",
    resolutionBase: "apps/api/src",
  });
  const landed = rewritePathReferenceText(unique, rewrites);
  expect(JSON.parse(landed).domains[0].module).toBe("../../../libs/sales-runtime/src/routes.ts");
  expect(JSON.parse(landed).note).toBe("./sales/routes.ts is documented here");
});

test("refuses a selected registry value without a byte-unique location", () => {
  const text = JSON.stringify({ domains: [
    { id: "one", module: "./sales/routes.ts" },
    { id: "two", module: "./sales/routes.ts" },
  ] }, null, 2);
  expect(() => scanRuntimeModuleRegistry(text, declaration, [{
    source: "apps/api/src/sales/routes.ts",
    target: "libs/sales-runtime/src/routes.ts",
  }])).toThrow("runtime module registry value is not byte-unique");
});

test("preserves an exact prefix stripped by the modeled runtime before resolution", () => {
  const text = '{"domains":[{"module":"./sales/routes.ts"}]}\n';
  const rewrites = scanRuntimeModuleRegistry(text, { ...declaration, stripPrefix: "./" }, [{
    source: "apps/api/src/sales/routes.ts",
    target: "libs/sales-runtime/src/routes.ts",
  }]);
  expect(rewrites[0]?.to).toBe("./../../../libs/sales-runtime/src/routes.ts");
  expect(rewrites[0]?.strippedPrefix).toBe("./");
  expect(posix.normalize(posix.join(declaration.resolveFrom, rewrites[0]!.to.slice(2))))
    .toBe("libs/sales-runtime/src/routes.ts");
});
