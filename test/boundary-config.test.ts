/**
 * `compositionBoundaries`/`portPromotions` schema refusals, and
 * `resolveBoundaries`'s normalization of both vocabularies into one
 * deterministically ordered `ResolvedBoundary` list.
 *
 * `compositionBoundaries` and `portPromotions` are NOT symmetric: a
 * `compositionBoundaries` entry with `strategy: "port"` writes a NEW contract
 * and adapter from a reviewed template, while a `portPromotions` entry
 * extracts an EXISTING declaration in place and never authors an adapter.
 * Every case below exercises one origin or the other explicitly so that
 * asymmetry cannot regress into an accidental symmetry.
 */

import { describe, expect, test } from "bun:test";

import { parseConfig, type MonocarveConfig } from "../src/config.ts";
import { BoundaryConfigError, resolveBoundaries } from "../src/prepare/boundary-resolve.ts";

const APP = "apps/api/src";

function config(overrides: Record<string, unknown> = {}): MonocarveConfig {
  return parseConfig({
    applications: [{ name: "api", sourceRoot: APP, tsconfig: "apps/api/tsconfig.json", packageName: "@acme/api" }],
    packageRoots: ["libs"],
    packageScope: "@acme/",
    portfolio: { minFiles: 1 },
    scaffoldTemplates: { packageJson: { contents: "{}" } },
    ...overrides,
  });
}

describe("compositionBoundaries schema refusals", () => {
  test("strategy \"port\" missing contract is rejected at config load", () => {
    expect(() =>
      config({
        compositionBoundaries: [
          {
            id: "widget-port",
            retained: `${APP}/widget.ts`,
            strategy: "port",
            contractModule: "widget",
            appAdapter: `${APP}/widget-adapter.ts`,
            packageImport: "@acme/ports/widget",
            symbols: ["Widget"],
            template: "widget-adapter",
          },
        ],
      }),
    ).toThrow(/strategy "port" requires "contract"/);
  });

  test("strategy \"port\" missing contractModule is rejected at config load", () => {
    expect(() =>
      config({
        compositionBoundaries: [
          {
            id: "widget-port",
            retained: `${APP}/widget.ts`,
            strategy: "port",
            contract: "Widget",
            appAdapter: `${APP}/widget-adapter.ts`,
            packageImport: "@acme/ports/widget",
            symbols: ["Widget"],
            template: "widget-adapter",
          },
        ],
      }),
    ).toThrow(/strategy "port" requires "contractModule"/);
  });

  test("strategy \"port\" missing appAdapter is rejected at config load", () => {
    expect(() =>
      config({
        compositionBoundaries: [
          {
            id: "widget-port",
            retained: `${APP}/widget.ts`,
            strategy: "port",
            contract: "Widget",
            contractModule: "widget",
            packageImport: "@acme/ports/widget",
            symbols: ["Widget"],
            template: "widget-adapter",
          },
        ],
      }),
    ).toThrow(/strategy "port" requires "appAdapter"/);
  });

  test("strategy \"port\" missing packageImport is rejected at config load", () => {
    expect(() =>
      config({
        compositionBoundaries: [
          {
            id: "widget-port",
            retained: `${APP}/widget.ts`,
            strategy: "port",
            contract: "Widget",
            contractModule: "widget",
            appAdapter: `${APP}/widget-adapter.ts`,
            symbols: ["Widget"],
            template: "widget-adapter",
          },
        ],
      }),
    ).toThrow(/strategy "port" requires "packageImport"/);
  });

  test("strategy \"port\" missing symbols is rejected at config load", () => {
    expect(() =>
      config({
        compositionBoundaries: [
          {
            id: "widget-port",
            retained: `${APP}/widget.ts`,
            strategy: "port",
            contract: "Widget",
            contractModule: "widget",
            appAdapter: `${APP}/widget-adapter.ts`,
            packageImport: "@acme/ports/widget",
            template: "widget-adapter",
          },
        ],
      }),
    ).toThrow(/strategy "port" requires a non-empty "symbols" list/);
  });

  test("strategy \"existing-package\" missing replacement is rejected at config load", () => {
    expect(() =>
      config({
        compositionBoundaries: [
          { id: "env-shim", retained: `${APP}/config/env.ts`, strategy: "existing-package" },
        ],
      }),
    ).toThrow(/strategy "existing-package" requires a "replacement"/);
  });

  test("duplicate ids within compositionBoundaries are rejected at config load", () => {
    expect(() =>
      config({
        compositionBoundaries: [
          { id: "env-shim", retained: `${APP}/config/env.ts`, strategy: "existing-package", replacement: { specifier: "@acme/env", symbols: ["env"] } },
          { id: "env-shim", retained: `${APP}/config/env2.ts`, strategy: "existing-package", replacement: { specifier: "@acme/env2", symbols: ["env2"] } },
        ],
      }),
    ).toThrow(/compositionBoundaries id must be unique/);
  });

  test("selective existing-package boundaries cannot retire mixed donors", () => {
    expect(() => config({ compositionBoundaries: [{ id: "env-shim", retained: `${APP}/config/env.ts`, strategy: "existing-package", replacement: { specifier: "@acme/env", symbols: ["env"] }, selective: true, retire: true }] })).toThrow(/selective boundaries require existing-package strategy with retire false/);
  });

  test("duplicate ids within portPromotions are rejected at config load", () => {
    expect(() =>
      config({
        portPromotions: [
          portPromotion({ id: "db-port" }),
          portPromotion({ id: "db-port", appConcreteType: `${APP}/db/other.ts#Client` }),
        ],
      }),
    ).toThrow(/portPromotions id must be unique/);
  });
});

describe("portPromotions schema refusals", () => {
  test("accepts an atomic concrete declaration group and rejects mixed singleton/group forms", () => {
    expect(config({ portPromotions: [portPromotion({
      appConcreteType: undefined,
      libraryPort: undefined,
      appConcreteTypes: [`${APP}/db/client.ts#DownloadedObject`, `${APP}/db/client.ts#ObjectStorage`],
      libraryPorts: ["DownloadedObject", "ObjectStorage"],
    })] }).portPromotions[0]?.appConcreteTypes).toHaveLength(2);

    expect(() => config({ portPromotions: [portPromotion({ appConcreteTypes: [`${APP}/db/client.ts#Other`], libraryPorts: ["Other"] })] }))
      .toThrow(/exactly one of appConcreteType\/libraryPort or appConcreteTypes\/libraryPorts/);
  });

  test("rejects incomplete and differently-sized declaration groups", () => {
    expect(() => config({ portPromotions: [portPromotion({ appConcreteType: undefined, libraryPort: undefined, appConcreteTypes: [`${APP}/db/client.ts#Client`] })] }))
      .toThrow(/appConcreteTypes and libraryPorts must be declared together/);
    expect(() => config({ portPromotions: [portPromotion({ appConcreteType: undefined, libraryPort: undefined, appConcreteTypes: [`${APP}/db/client.ts#Client`], libraryPorts: ["Client", "Other"] })] }))
      .toThrow(/same length/);
  });

  test("appConcreteType not in \"path/file.ts#TypeName\" form is rejected at config load", () => {
    expect(() =>
      config({
        portPromotions: [portPromotion({ appConcreteType: `${APP}/db/client.ts` })],
      }),
    ).toThrow(/path\/to\/file\.ts#TypeName/);
  });

  test("appConcreteType naming a non-.ts/.tsx file is rejected at config load", () => {
    expect(() =>
      config({
        portPromotions: [portPromotion({ appConcreteType: `${APP}/db/client.js#Client` })],
      }),
    ).toThrow(/path\/to\/file\.ts#TypeName/);
  });
});

describe("resolveBoundaries", () => {
  test("a collision ACROSS compositionBoundaries and portPromotions is rejected", () => {
    const cfg = config({
      compositionBoundaries: [
        { id: "shared-id", retained: `${APP}/config/env.ts`, strategy: "existing-package", replacement: { specifier: "@acme/env", symbols: ["env"] } },
      ],
      portPromotions: [portPromotion({ id: "shared-id" })],
    });

    expect(() => resolveBoundaries(cfg)).toThrow(BoundaryConfigError);
    expect(() => resolveBoundaries(cfg)).toThrow(/shared-id is declared more than once across compositionBoundaries and portPromotions/);
  });

  test("resolves \"existing-package\" boundaries and normalizes their sorted symbols", () => {
    const cfg = config({
      compositionBoundaries: [
        { id: "env-shim", retained: `${APP}/config/env.ts`, strategy: "existing-package", replacement: { specifier: "@acme/env", symbols: ["envB", "envA"] }, retire: true },
      ],
    });

    const [resolved] = resolveBoundaries(cfg);

    expect(resolved).toEqual({
      id: "env-shim",
      source: "compositionBoundaries",
      strategy: "existing-package",
      retained: `${APP}/config/env.ts`,
      replacementSpecifier: "@acme/env",
      replacementSymbols: ["envA", "envB"],
      retire: true,
      selective: false,
    });
  });

  test("resolves \"port\" boundaries from compositionBoundaries with a template-authored adapter", () => {
    const cfg = config({
      compositionBoundaries: [
        {
          id: "widget-port",
          retained: `${APP}/widget.ts`,
          strategy: "port",
          contract: "Widget",
          contractModule: "widget",
          appAdapter: `${APP}/widget-adapter.ts`,
          packageImport: "@acme/ports/widget",
          symbols: ["WidgetB", "WidgetA"],
          template: "widget-adapter",
        },
      ],
    });

    const [resolved] = resolveBoundaries(cfg);

    expect(resolved).toEqual({
      id: "widget-port",
      source: "compositionBoundaries",
      strategy: "port",
      retained: `${APP}/widget.ts`,
      declarationName: "Widget",
      contractName: "Widget",
      contractPackage: "@acme/ports/widget",
      contractModule: "widget",
      packageImport: "@acme/ports/widget",
      symbols: ["WidgetA", "WidgetB"],
      appAdapter: `${APP}/widget-adapter.ts`,
      template: "widget-adapter",
      retainedRoots: [`${APP}/widget.ts`],
      retire: false,
    });
  });

  test("resolves \"port\" boundaries from portPromotions with no adapter or template", () => {
    const cfg = config({
      portPromotions: [portPromotion({})],
    });

    const [resolved] = resolveBoundaries(cfg);

    expect(resolved).toEqual({
      id: "db-port",
      source: "portPromotions",
      strategy: "port",
      retained: `${APP}/db/client.ts`,
      declarationName: "Client",
      contractName: "Client",
      contractPackage: "@acme/ports",
      contractModule: "db",
      packageImport: "@acme/ports",
      symbols: ["Client"],
      appAdapter: undefined,
      template: undefined,
      retainedRoots: [`${APP}/db`],
      retire: false,
    });
  });

  test("a portPromotion whose libraryPort does not name the same declaration as appConcreteType is rejected", () => {
    const cfg = config({
      portPromotions: [portPromotion({ libraryPort: "DifferentName" })],
    });

    expect(() => resolveBoundaries(cfg)).toThrow(/library port \(DifferentName\) must name the same declaration as app concrete type \(Client\)/);
  });

  test("resolves an atomic declaration group with deterministic symbols and one donor", () => {
    const cfg = config({ portPromotions: [portPromotion({
      appConcreteType: undefined, libraryPort: undefined,
      appConcreteTypes: [`${APP}/db/client.ts#ObjectStorage`, `${APP}/db/client.ts#DownloadedObject`],
      libraryPorts: ["ObjectStorage", "DownloadedObject"],
    })] });
    const [resolved] = resolveBoundaries(cfg);
    expect(resolved).toMatchObject({
      retained: `${APP}/db/client.ts`,
      declarationName: "ObjectStorage",
      atomicDeclarationGroup: true,
      symbols: ["DownloadedObject", "ObjectStorage"],
    });
  });

  test("rejects declaration groups spanning files or renaming a member", () => {
    const spanning = config({ portPromotions: [portPromotion({
      appConcreteType: undefined, libraryPort: undefined,
      appConcreteTypes: [`${APP}/db/client.ts#Client`, `${APP}/db/other.ts#Other`], libraryPorts: ["Client", "Other"],
    })] });
    expect(() => resolveBoundaries(spanning)).toThrow(/same retained file/);
    const renamed = config({ portPromotions: [portPromotion({
      appConcreteType: undefined, libraryPort: undefined,
      appConcreteTypes: [`${APP}/db/client.ts#Client`, `${APP}/db/client.ts#Other`], libraryPorts: ["Client", "Renamed"],
    })] });
    expect(() => resolveBoundaries(renamed)).toThrow(/does not synthesize renames/);
  });

  test("produces a deterministic byCodeUnit order across both origins", () => {
    const cfg = config({
      compositionBoundaries: [
        { id: "zzz-shim", retained: `${APP}/config/z.ts`, strategy: "existing-package", replacement: { specifier: "@acme/z", symbols: ["z"] } },
        { id: "aaa-shim", retained: `${APP}/config/a.ts`, strategy: "existing-package", replacement: { specifier: "@acme/a", symbols: ["a"] } },
      ],
      portPromotions: [portPromotion({ id: "mmm-port" })],
    });

    const resolved = resolveBoundaries(cfg);

    expect(resolved.map((boundary) => boundary.id)).toEqual(["aaa-shim", "mmm-port", "zzz-shim"]);
  });
});

function portPromotion(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "db-port",
    retainedRoots: [`${APP}/db`],
    contractPackage: "@acme/ports",
    contractModule: "db",
    appConcreteType: `${APP}/db/client.ts#Client`,
    libraryPort: "Client",
    targetPackage: "@acme/ports",
    ...overrides,
  };
}
