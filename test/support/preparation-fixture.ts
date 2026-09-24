import type { MonocarveConfig } from "../../src/config.ts";
import { fixtureConfig, fixtureRepo } from "./fixture-repo.ts";

export const PREPARATION_DONOR = "apps/api/src/contracts.ts";
export const PREPARATION_TARGET = "apps/api/src/contracts-types.ts";

export interface PreparationFixture {
  readonly root: string;
  readonly config: MonocarveConfig;
}

/** A synthetic workspace with external and retained type-only consumers. */
export function preparationFixture(): PreparationFixture {
  const root = fixtureRepo({
    "package.json": '{"name":"@acme/workspace","private":true}\n',
    "apps/api/tsconfig.json": JSON.stringify({
      compilerOptions: { strict: true, noEmit: true, module: "esnext", moduleResolution: "bundler" },
      include: ["src/**/*.ts"],
    }),
    [PREPARATION_DONOR]: [
      "/** The contract owned by the billing boundary. */",
      "export interface Contract { readonly id: string; }",
      "export type ContractResult = { readonly contract: Contract };",
      "export const runtimeMarker = 1;",
      "",
    ].join("\n"),
    "apps/api/src/billing/use-contract.ts": [
      'import type { Contract } from "../contracts";',
      "export const contractId = (contract: Contract): string => contract.id;",
      "",
    ].join("\n"),
  });
  return {
    root,
    config: fixtureConfig(root, {
      preparation: { gates: { package: [], project: [], workspace: ["true"] }, commit: { subject: "refactor: prepare contract types" } },
    }),
  };
}
