import { afterAll, expect, test } from "bun:test";

import { appendConsumerOperations } from "../src/plan/build-phases.ts";
import { WorkspaceContext } from "../src/plan/context.ts";
import { parseConfig } from "../src/config.ts";
import { cleanupFixtures, fixtureConfig, fixtureRepo } from "./support/fixture-repo.ts";

afterAll(cleanupFixtures);

test("CSS import parsing is explicitly bound to configured asset extensions", () => {
  expect(() => parseConfig({ applications: [{ name: "app", sourceRoot: "apps/app/src", tsconfig: "apps/app/tsconfig.json" }], packageRoots: ["libs"], cssImportExtensions: [".css"], scaffoldTemplates: { packageJson: { contents: "{}" } } })).toThrow("CSS import extension must also be an asset extension");
});

test("retained bare and query asset imports become exact package-subpath consumers", () => {
  const asset = "apps/api/src/estimating/estimating.css";
  const retained = "apps/api/src/EstimatingPage.tsx";
  const retainedCss = "apps/api/src/app.css";
  const root = fixtureRepo({
    "apps/api/src/estimating/Panel.tsx": 'import "./estimating.css"; export const Panel = 1;\n',
    [asset]: ".panel { color: red; }\n",
    [retained]: 'import "./estimating/estimating.css"; import url from "./estimating/estimating.css?url"; export { url };\n',
    [retainedCss]: '@import "./estimating/estimating.css";\n.keep { color: blue; }\n',
  });
  const config = fixtureConfig(root, { assetExtensions: [".css"], cssImportExtensions: [".css"] });
  const context = new WorkspaceContext(config, root);
  const operations: Parameters<typeof appendConsumerOperations>[0]["operations"] = [];
  const result = appendConsumerOperations({
    context, sources: ["apps/api/src/estimating/Panel.tsx", asset], packageName: "@acme/estimating",
    publicSpecifierFor: new Map([[asset, "@acme/estimating/estimating/estimating.css"]]), operations,
  });

  expect(result.consumers).toContainEqual(expect.objectContaining({
    file: retained, donors: [asset], rewrites: [
      { from: "./estimating/estimating.css", to: "@acme/estimating/estimating/estimating.css", donor: asset },
      { from: "./estimating/estimating.css?url", to: "@acme/estimating/estimating/estimating.css?url", donor: asset },
    ],
  }));
  expect(operations).toContainEqual(expect.objectContaining({ kind: "rewrite-import", file: retained }));
  expect(result.consumers).toContainEqual(expect.objectContaining({
    file: retainedCss, rewrites: [{ from: "./estimating/estimating.css", to: "@acme/estimating/estimating/estimating.css", donor: asset }],
  }));
  const cssOperation = operations.find((operation) => operation.kind === "rewrite-import" && operation.file === retainedCss);
  expect(cssOperation?.kind === "rewrite-import" && cssOperation.resultHash).toBeDefined();
});
