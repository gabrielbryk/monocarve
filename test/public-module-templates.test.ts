import { describe, expect, test } from "bun:test";

import type { PublicSurfaceConfig } from "../src/config.ts";
import { PlanningError } from "../src/plan/context.ts";
import { renderPublicModulePaths } from "../src/plan/public-modules.ts";

const extensions = [
  "modules/plain.ts",
  "modules/component.tsx",
  "modules/module.mts",
  "modules/common.cts",
  "modules/javascript.js",
  "modules/view.jsx",
];

describe("public module templates", () => {
  test("renders path, extensionless, and JavaScript placeholders across supported module extensions", () => {
    const raw = renderPublicModulePaths(
      subpaths("./raw/{path}", "./src/{path}"),
      extensions,
    );
    expect(raw.map(({ exportKey, exportTarget }) => [exportKey, exportTarget])).toEqual([
      ["./raw/modules/plain.ts", "./src/modules/plain.ts"],
      ["./raw/modules/component.tsx", "./src/modules/component.tsx"],
      ["./raw/modules/module.mts", "./src/modules/module.mts"],
      ["./raw/modules/common.cts", "./src/modules/common.cts"],
      ["./raw/modules/javascript.js", "./src/modules/javascript.js"],
      ["./raw/modules/view.jsx", "./src/modules/view.jsx"],
    ]);

    const transformed = renderPublicModulePaths(
      subpaths("./{pathNoExtension}", "./dist/{pathJs}"),
      extensions,
    );
    expect(transformed.map(({ exportKey, exportTarget }) => [exportKey, exportTarget])).toEqual([
      ["./modules/plain", "./dist/modules/plain.js"],
      ["./modules/component", "./dist/modules/component.js"],
      ["./modules/module", "./dist/modules/module.js"],
      ["./modules/common", "./dist/modules/common.js"],
      ["./modules/javascript", "./dist/modules/javascript.js"],
      ["./modules/view", "./dist/modules/view.jsx"],
    ]);
  });

  test("normalizes source separators before rendering", () => {
    expect(renderPublicModulePaths(subpaths("./{pathNoExtension}", "./src/{path}"), ["widgets\\chart.ts"])).toEqual([
      {
        path: "widgets/chart.ts",
        exportKey: "./widgets/chart",
        exportTarget: "./src/widgets/chart.ts",
      },
    ]);
  });

  test("refuses duplicate rendered keys and targets", () => {
    expect(() => renderPublicModulePaths(subpaths("./module", "./src/{path}"), ["a.ts", "b.ts"])).toThrow(
      new PlanningError("two moved modules render the same public subpath export key"),
    );
    expect(() => renderPublicModulePaths(subpaths("./{pathNoExtension}", "./src/module.ts"), ["a.ts", "b.ts"])).toThrow(
      new PlanningError("two moved modules render the same public subpath export target"),
    );
  });

  test.each([
    ["root key", "./", "./src/{path}", "public subpath key"],
    ["key traversal", "./safe/../{path}", "./src/{path}", "public subpath key"],
    ["absolute key", "/{path}", "./src/{path}", "public subpath key"],
    ["root target", "./{pathNoExtension}", "./", "public subpath target"],
    ["target traversal", "./{pathNoExtension}", "./src/../{path}", "public subpath target"],
    ["absolute target", "./{pathNoExtension}", "/src/{path}", "public subpath target"],
  ])("refuses %s", (_name, keyTemplate, targetTemplate, message) => {
    expect(() => renderPublicModulePaths(subpaths(keyTemplate, targetTemplate), ["widgets/chart.ts"])).toThrow(message);
  });

  test("barrel mode declares no module paths", () => {
    expect(renderPublicModulePaths({ mode: "barrel" }, extensions)).toEqual([]);
  });
});

function subpaths(keyTemplate: string, targetTemplate: string): PublicSurfaceConfig {
  return { mode: "subpaths", keyTemplate, targetTemplate };
}
