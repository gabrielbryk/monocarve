import { afterAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  rewriteResolvedImportSpecifier,
  unsupportedModuleReferences,
} from "../src/codemod/imports.ts";
import {
  createCodemodPropertyHarness,
  LONG_PACKAGE,
  report,
  specifierSpans,
  spliceAll,
} from "./support/codemod-property-harness.ts";

const harness = createCodemodPropertyHarness();
const { workspace, DONOR, TS_IMPORTER } = harness;

afterAll(harness.cleanup);

/**
 * Inputs the splicer used to get wrong, kept as cases because the generated
 * corpus has the specifier as each declaration's only quoted run and contains
 * no escaped specifiers.
 *
 * The old locator searched the whole declaration with a quote-matching regular
 * expression. It could therefore select a comment or alias, truncate a
 * specifier containing a quote, and silently skip a backtick-delimited
 * specifier. `ModuleReference.specifierSpan` now comes from the literal AST node
 * and the splice writes only between its delimiters.
 */
describe("regressions: spans the declaration text cannot locate", () => {
  function check(id: string, source: string, donorSpecifiers: readonly string[], donorPath = DONOR): void {
    const path = TS_IMPORTER;
    const spans = specifierSpans(source, path, new Set(donorSpecifiers));
    expect(spans).toHaveLength(1);
    const expected = spliceAll(source, spans, LONG_PACKAGE);
    const actual = rewriteResolvedImportSpecifier(source, path, donorPath, LONG_PACKAGE, workspace);
    if (actual !== expected) throw new Error(report({ id, path, source }, expected, actual));
  }

  test("a quoted string in a comment inside the declaration is not the specifier", () => {
    check("comment", 'import /* see "./unrelated" */ { a } from "./helpers";\n', ["./helpers"]);
    check("comment-after", 'import { a } from "./helpers"; // was "./helpers"\n', ["./helpers"]);
  });

  test("a string alias is not the specifier", () => {
    check("export-alias", 'export { a as "weird name" } from "./helpers";\n', ["./helpers"]);
    check("import-alias", 'import { "a" as weird } from "./helpers";\n', ["./helpers"]);
  });

  test("a specifier containing a quote character is spliced at its own offsets", () => {
    writeFileSync(join(workspace, "o'brien.ts"), "export const a = 1;\n");
    check("apostrophe", `import { a } from "./o'brien";\n`, ["./o'brien"], join(workspace, "o'brien.ts"));
    writeFileSync(join(workspace, 'quo"te.ts'), "export const a = 1;\n");
    check("double-quote", `import { a } from './quo"te';\n`, ['./quo"te'], join(workspace, 'quo"te.ts'));
  });

  test("an escaped specifier is spliced over its raw bytes", () => {
    const source = 'import { a } from "./hel\\u0070ers";\n';
    expect(rewriteResolvedImportSpecifier(source, TS_IMPORTER, DONOR, LONG_PACKAGE, workspace)).toBe(
      `import { a } from "${LONG_PACKAGE}";\n`,
    );
  });

  test("a no-substitution template specifier is rewritten, not reported", () => {
    const source = "const lazy = import(`./helpers`);\n";
    expect(unsupportedModuleReferences(source, TS_IMPORTER, workspace)).toHaveLength(0);
    expect(rewriteResolvedImportSpecifier(source, TS_IMPORTER, DONOR, LONG_PACKAGE, workspace)).toBe(
      `const lazy = import(\`${LONG_PACKAGE}\`);\n`,
    );
  });

  test("a package specifier that cannot be written into the literal is refused", () => {
    const quoted = 'import { a } from "./helpers";\n';
    expect(() => rewriteResolvedImportSpecifier(quoted, TS_IMPORTER, DONOR, '@acme/we"ird', workspace)).toThrow(
      "cannot be written inside",
    );
    const template = "const lazy = import(`./helpers`);\n";
    expect(() => rewriteResolvedImportSpecifier(template, TS_IMPORTER, DONOR, "@acme/${x}", workspace)).toThrow(
      "cannot be written inside",
    );
    const other = 'import { u } from "./unrelated";\n';
    expect(rewriteResolvedImportSpecifier(other, TS_IMPORTER, DONOR, '@acme/we"ird', workspace)).toBe(other);
  });
});
