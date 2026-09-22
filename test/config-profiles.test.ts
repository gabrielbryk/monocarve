import { describe, expect, test } from "bun:test";

import { parseConfig, renderExtractionProfile, resolveExtractionProfile, scaffoldFor } from "../src/config.ts";

describe("config profiles", () => {
  test("resolves the synthetic legacy profile byte-for-byte when profiles are absent", () => {
    const config = parseConfig({
      applications: [
        {
          name: "web",
          sourceRoot: "apps/web/src",
          tsconfig: "apps/web/tsconfig.json",
          scaffoldTemplates: { packageJson: { contents: '{"name":"application"}' } },
        },
      ],
      packageRoots: ["libs", "packages"],
      packageScope: "@acme/",
      gates: { package: ["package gate"], project: ["project gate"], workspace: ["workspace gate"] },
      scaffoldTemplates: { packageJson: { contents: '{"name":"root"}' } },
    });

    expect(resolveExtractionProfile(config, config.applications[0]!)).toEqual({
      name: undefined,
      kind: "library",
      destinationRoot: "libs",
      directoryTemplate: "{name}",
      packageNameTemplate: "{scope}{name}",
      projectIdTemplate: undefined,
      scaffoldTemplates: scaffoldFor(config, config.applications[0]!),
      gates: config.gates,
    });
  });

  test("resolves a configured profile with scoped templates and profile-local overrides", () => {
    const config = parseConfig({
      applications: [
        {
          name: "web",
          sourceRoot: "apps/web/src",
          tsconfig: "apps/web/tsconfig.json",
          scaffoldTemplates: { packageJson: { contents: '{"name":"application"}' } },
        },
      ],
      packageRoots: ["libs", "test-libs"],
      packageScope: "@acme/",
      gates: { package: ["root package"], project: ["root project"], workspace: ["root workspace"] },
      scaffoldTemplates: { packageJson: { contents: '{"name":"root"}' } },
      extractionProfiles: {
        default: "testing",
        profiles: {
          testing: {
            destinationRoot: "test-libs",
            directoryTemplate: "{app}-{name}",
            packageNameTemplate: "{scope}{app}-{name}",
            projectIdTemplate: "{profile}-{package}",
            scaffoldTemplates: { packageJson: { contents: '{"name":"profile"}' } },
            gates: { package: ["profile package"] },
          },
        },
      },
    });

    expect(resolveExtractionProfile(config, config.applications[0]!)).toMatchObject({
      name: "testing",
      destinationRoot: "test-libs",
      directoryTemplate: "{app}-{name}",
      packageNameTemplate: "{scope}{app}-{name}",
      projectIdTemplate: "{profile}-{package}",
      // Application is the narrowest declaration and therefore wins a
      // same-key collision: root < profile < application.
      scaffoldTemplates: { packageJson: { contents: '{"name":"application"}' } },
      gates: { package: ["profile package"], project: ["root project"], workspace: ["root workspace"] },
    });
  });

  test("applies public-surface precedence from root through profile to application", () => {
    const rootSurface = { mode: "subpaths" as const, keyTemplate: "./root/{pathNoExtension}", targetTemplate: "./src/{path}" };
    const profileSurface = { mode: "subpaths" as const, keyTemplate: "./profile/{pathNoExtension}", targetTemplate: "./src/{path}" };
    const applicationSurface = { mode: "subpaths" as const, keyTemplate: "./application/{pathNoExtension}", targetTemplate: "./src/{path}" };
    const config = parseConfig({
      applications: [
        { name: "web", sourceRoot: "apps/web/src", tsconfig: "apps/web/tsconfig.json", scaffoldTemplates: { publicSurface: applicationSurface } },
        { name: "api", sourceRoot: "apps/api/src", tsconfig: "apps/api/tsconfig.json" },
      ],
      packageRoots: ["libs"],
      scaffoldTemplates: { packageJson: { contents: "{}" }, publicSurface: rootSurface },
      extractionProfiles: { profiles: { modular: { destinationRoot: "libs", scaffoldTemplates: { publicSurface: profileSurface } } } },
    });

    expect(resolveExtractionProfile(config, config.applications[0]!, "modular").scaffoldTemplates.publicSurface).toEqual(applicationSurface);
    expect(resolveExtractionProfile(config, config.applications[1]!, "modular").scaffoldTemplates.publicSurface).toEqual(profileSurface);
    expect(scaffoldFor(config, config.applications[1]!).publicSurface).toEqual(rootSurface);
  });

  test("rejects profile references and rendered names that cannot safely select a package", () => {
    const base = {
      applications: [{ name: "web", sourceRoot: "apps/web/src", tsconfig: "apps/web/tsconfig.json" }],
      packageRoots: ["libs"],
      packageScope: "@acme/",
      scaffoldTemplates: { packageJson: { contents: "{}" } },
    };
    expect(() => parseConfig({ ...base, extractionProfiles: { default: "missing", profiles: {} } })).toThrow(/default/);
    expect(() => parseConfig({ ...base, extractionProfiles: { profiles: { helper: { destinationRoot: "outside" } } } })).toThrow(/destinationRoot/);
    expect(() =>
      parseConfig({ ...base, extractionProfiles: { profiles: { helper: { destinationRoot: "libs", directoryTemplate: "nested/{name}" } } } }),
    ).toThrow(/direct-child directory/);
    expect(() =>
      parseConfig({ ...base, extractionProfiles: { profiles: { helper: { destinationRoot: "libs", packageNameTemplate: "not allowed" } } } }),
    ).toThrow(/packageNamePattern/);
    expect(() => parseConfig({ ...base, extractionProfiles: { profiles: { helper: { destinationRoot: "libs", packageNameTemplate: "{unknown}" } } } })).toThrow(
      /unknown profile template placeholder/,
    );
  });

  test("validates profile templates for every application and validates a requested candidate name at render time", () => {
    const base = {
      applications: [
        { name: "web", sourceRoot: "apps/web/src", tsconfig: "apps/web/tsconfig.json" },
        { name: "bad/app", sourceRoot: "apps/bad/src", tsconfig: "apps/bad/tsconfig.json" },
      ],
      packageRoots: ["libs"],
      packageScope: "@acme/",
      scaffoldTemplates: { packageJson: { contents: "{}" } },
      extractionProfiles: { profiles: { helper: { destinationRoot: "libs", directoryTemplate: "{app}-{name}" } } },
    };
    expect(() => parseConfig(base)).toThrow(/application "bad\/app"/);

    const config = parseConfig({ ...base, applications: [base.applications[0]!], extractionProfiles: { profiles: { helper: { destinationRoot: "libs" } } } });
    const profile = resolveExtractionProfile(config, config.applications[0]!, "helper");
    expect(() => renderExtractionProfile(config, config.applications[0]!, profile, "bad/name")).toThrow(/direct-child directory/);
    expect(renderExtractionProfile(config, config.applications[0]!, profile, "useful-helper")).toEqual({
      packageName: "@acme/useful-helper",
      packageRoot: "libs/useful-helper",
      projectId: undefined,
    });
  });
});
