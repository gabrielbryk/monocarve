/**
 * The three proof obligations `boundary-port.ts` must discharge before a
 * "port" promotion can be treated as an ordinary reviewable write:
 * `assertTypeOnlyPromotion`, `assertNoRetainedValueImport`, and
 * `assertAdapterSurfaceMatchesContract`. Every refusal here must name the
 * offending symbol, file, or specifier — a refusal nobody can act on is not a
 * good refusal.
 *
 * The single most important case in this file is the first one: a promoted
 * declaration whose *type name* is listed in port policy, but which a
 * consumer actually uses in VALUE space (`new Client()`), must still be
 * refused. Listing a name in config is not proof it denotes a pure contract.
 */

import { describe, expect, test } from "bun:test";

import {
  assertAdapterSurfaceMatchesContract,
  assertNoRetainedValueImport,
  assertTypeOnlyPromotion,
  BoundaryProofError,
} from "../src/prepare/boundary-proofs.ts";

describe("assertTypeOnlyPromotion", () => {
  test("refuses a promoted declaration used in VALUE space even though its type name is listed in port policy", () => {
    const consumers = [
      {
        path: "apps/api/src/orders/service.ts",
        text: 'import { Client } from "../db/client.ts";\nconst instance = new Client();\nvoid instance;\n',
        localName: "Client",
      },
    ];

    expect(() => assertTypeOnlyPromotion(consumers)).toThrow(BoundaryProofError);
    expect(() => assertTypeOnlyPromotion(consumers)).toThrow(
      /apps\/api\/src\/orders\/service\.ts uses Client in value space; a port promotion requires every use to be type-only/,
    );
  });

  test("a genuinely type-only use of the promoted name passes", () => {
    const consumers = [
      {
        path: "apps/api/src/orders/service.ts",
        text: 'import type { Widget } from "@acme/ports/widget";\nexport function run(input: Widget): void { void input; }\n',
        localName: "Widget",
      },
    ];

    expect(() => assertTypeOnlyPromotion(consumers)).not.toThrow();
  });

  test("the import binding itself is never mistaken for a value-space use", () => {
    const consumers = [{ path: "apps/api/src/orders/service.ts", text: 'import type { Widget } from "@acme/ports/widget";\n', localName: "Widget" }];

    expect(() => assertTypeOnlyPromotion(consumers)).not.toThrow();
  });
});

describe("assertNoRetainedValueImport", () => {
  const retainedRoots = ["apps/api/src/db"];

  test("refuses a residual value-level import from a retained root, naming the importer and specifier", () => {
    const rewrittenText = 'import { helper } from "../db/util.ts";\nexport function run(): void { helper(); }\n';

    expect(() => assertNoRetainedValueImport(rewrittenText, "apps/api/src/orders/service.ts", retainedRoots)).toThrow(BoundaryProofError);
    expect(() => assertNoRetainedValueImport(rewrittenText, "apps/api/src/orders/service.ts", retainedRoots)).toThrow(
      /apps\/api\/src\/orders\/service\.ts still imports a value binding from retained root \.\.\/db\/util\.ts after promotion/,
    );
  });

  test("a type-only import from a retained root is not a residual value import", () => {
    const rewrittenText = 'import type { Client } from "../db/client.ts";\nexport type Alias = Client;\n';

    expect(() => assertNoRetainedValueImport(rewrittenText, "apps/api/src/orders/service.ts", retainedRoots)).not.toThrow();
  });

  test("a value import from outside every retained root is left unchecked", () => {
    const rewrittenText = 'import { helper } from "../utils/format.ts";\nexport function run(): void { helper(); }\n';

    expect(() => assertNoRetainedValueImport(rewrittenText, "apps/api/src/orders/service.ts", retainedRoots)).not.toThrow();
  });
});

describe("assertAdapterSurfaceMatchesContract", () => {
  test("refuses an adapter whose surface does not match the contract, naming missing and unexpected symbols", () => {
    const adapterText = "export class Helper {}\n";

    expect(() => assertAdapterSurfaceMatchesContract(adapterText, "apps/api/src/widget-adapter.ts", ["Widget"])).toThrow(BoundaryProofError);
    expect(() => assertAdapterSurfaceMatchesContract(adapterText, "apps/api/src/widget-adapter.ts", ["Widget"])).toThrow(
      /adapter apps\/api\/src\/widget-adapter\.ts surface does not match its contract; missing: Widget; unexpected: Helper/,
    );
  });

  test("an adapter whose exported surface exactly matches the contract passes", () => {
    const adapterText = "export class Widget {\n  amount = 0;\n}\n";

    expect(() => assertAdapterSurfaceMatchesContract(adapterText, "apps/api/src/widget-adapter.ts", ["Widget"])).not.toThrow();
  });
});

describe("a genuinely type-only promotion passes all three proofs together", () => {
  test("consumer usage, rewritten import, and adapter surface all satisfy their proof", () => {
    const consumers = [
      {
        path: "apps/api/src/orders/service.ts",
        text: 'import type { Widget } from "@acme/ports/widget";\nexport function run(input: Widget): void { void input; }\n',
        localName: "Widget",
      },
    ];
    const rewrittenText = consumers[0]!.text;
    const adapterText = "export class Widget {\n  amount = 0;\n}\n";

    expect(() => assertTypeOnlyPromotion(consumers)).not.toThrow();
    expect(() => assertNoRetainedValueImport(rewrittenText, "apps/api/src/orders/service.ts", ["apps/api/src/widget.ts"])).not.toThrow();
    expect(() => assertAdapterSurfaceMatchesContract(adapterText, "apps/api/src/widget-adapter.ts", ["Widget"])).not.toThrow();
  });
});
