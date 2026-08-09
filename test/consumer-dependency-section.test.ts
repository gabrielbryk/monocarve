import { describe, expect, test } from "bun:test";

import { consumerDependencyOwners, type Consumer } from "../src/plan/consumers.ts";

function consumer(packageRoot: string, dependencySection: Consumer["dependencySection"]): Consumer {
  return {
    package: packageRoot,
    file: `${packageRoot}/src/consumer-${dependencySection}.ts`,
    expectedImporter: "./donor.ts",
    rewrites: [{ from: "./donor.ts", to: "@acme/donor", donor: "apps/api/src/donor.ts" }],
    donors: ["apps/donor/src/donor.ts"],
    dependencySection,
  };
}

describe("consumer dependency sections", () => {
  test("aggregates deterministically and makes runtime win over retained-test dev consumers", () => {
    // The negative case is a mixed owner: choosing the first consumer's section
    // would make a production import a devDependency whenever graph traversal
    // happened to visit a test first.
    expect(
      consumerDependencyOwners([
        consumer("apps/zebra", "dev"),
        consumer("apps/zebra", "runtime"),
        consumer("apps/alpha", "dev"),
      ]),
    ).toEqual([
      { owner: "apps/alpha", dependencySection: "dev" },
      { owner: "apps/zebra", dependencySection: "runtime" },
    ]);
  });
});
