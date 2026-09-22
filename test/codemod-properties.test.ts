/**
 * Properties of the splicer, as properties — not as a list of examples.
 *
 * `src/codemod/imports.ts` opens by stating what the whole design rests on:
 * rewrites are textual splices at AST-located offsets, not a printer round-trip,
 * so *every byte that changed, changed because the plan said so*. The audit's
 * replay proof cashes that in — it re-derives a landed file by running this same
 * codemod against the baseline blob and demanding byte equality. A codemod that
 * reformats, renormalises, or edits anything incidentally does not merely produce
 * an ugly diff: it makes the replay proof fail on correct work, or (worse) makes
 * a corrupted file look like the codemod's own output.
 *
 * `test/codemod.test.ts` covers specific cases. This file covers the property,
 * over a generated corpus, with an *independent* expectation.
 *
 * ## How inputs are generated
 *
 * Deterministically and exhaustively — no randomness, so nothing here can be
 * flaky and every case has a stable name.
 *
 *   fragment corpus  x  fragment corpus  x  file shapes  (+ a decoy fragment)
 *
 * A *fragment* is one construct (`import type`, `export * from`, `import()`,
 * `require.resolve`, `import x = require()`, a backtick-delimited specifier, a
 * multi-line declaration, a declaration with a comment inside it, …). A *shape*
 * is the file-level formatting: LF or CRLF, BOM or none, trailing newline or
 * none, tab indent, trailing whitespace on every line, `.ts` or `.tsx`. Every
 * case also carries a *decoy*: the donor's specifier text sitting somewhere
 * that is not a module specifier, which must never be touched.
 *
 * ## How a failure is reproduced
 *
 * Every case has a stable id. A failure prints the id, the offset of the first
 * differing byte, and both sides quoted with `JSON.stringify`, so the
 * reproducing source is in the failure message verbatim. `caseById("…")`
 * returns the exact case for a human reproducing one at a REPL.
 *
 * ## The oracle
 *
 * The expectation is *not* "what the codemod did last time". For each case the
 * test walks the AST itself, takes the offsets of the module-specifier literal
 * nodes that name the donor, and splices the source between the delimiters.
 *
 * The selection rule necessarily mirrors the implementation. The offsets used
 * not to: the implementation searched declaration text with a regular
 * expression while the oracle used the AST. The fix moved the implementation
 * onto AST offsets too, so this property now proves that the splice does
 * nothing *else*. Identity, skeleton, quote preservation, idempotence, and
 * commutativity still compare output directly against input.
 *
 * ## Proof that these properties can fail
 *
 * Each property was verified by mutating `src/codemod/imports.ts` and watching
 * it fail. The corpus is 825 cases:
 *
 * | mutation | caught by | cases |
 * | --- | --- | --- |
 * | rewrite the whole literal with `"` around it | AST-offset equality | 770 |
 * | apply replacements ascending so later offsets are stale | AST-offset equality | 312 |
 * | trim whitespace and add a final newline | non-matching identity | 824 |
 * | append a newline inside `applyEscapeRewrites` | empty-list identity | 825 |
 *
 * The declaration-text regressions live in `codemod-regressions.test.ts`.
 */

import { afterAll, describe, expect, test } from "bun:test";

import { applyEscapeRewrites, inventoryModuleReferences, rewriteResolvedImportSpecifier, unsupportedModuleReferences } from "../src/codemod/imports.ts";
import {
  assertNoFailures,
  createCodemodPropertyHarness,
  LONG_PACKAGE,
  render,
  report,
  SHAPES,
  SHORT_PACKAGE,
  skeleton,
  specifierSpans,
  spliceAll,
  type GeneratedCase,
} from "./support/codemod-property-harness.ts";

const harness = createCodemodPropertyHarness();
const { workspace, DONOR, ABSENT_DONOR, TS_IMPORTER, CASES, MATCHING_CASES, NON_MATCHING_CASES, rewrite } = harness;

afterAll(harness.cleanup);

export function caseById(id: string): GeneratedCase | undefined {
  return harness.caseById(id);
}

describe("splice fidelity", () => {
  test("the corpus is large enough to be worth calling a corpus", () => {
    // Prevent a generator refactor from making every property pass vacuously.
    expect(CASES.length).toBeGreaterThan(500);
    expect(MATCHING_CASES.length).toBeGreaterThan(400);
    expect(NON_MATCHING_CASES.length).toBeGreaterThan(50);
    expect(CASES.every((kase) => kase.donorSpecifiers.size > 0)).toBe(true);
    expect(new Set(CASES.map((kase) => kase.id)).size).toBe(CASES.length);
  });

  test("a rewrite that matches nothing returns the source byte for byte", () => {
    const failures: string[] = [];
    for (const kase of CASES) {
      for (const packageSpecifier of [SHORT_PACKAGE, LONG_PACKAGE]) {
        const actual = rewrite(kase, ABSENT_DONOR, packageSpecifier);
        if (actual !== kase.source) failures.push(report(kase, kase.source, actual));
      }
    }
    assertNoFailures(failures);
  });

  test("the donor's own text, outside a module specifier, is never rewritten", () => {
    const failures: string[] = [];
    for (const kase of NON_MATCHING_CASES) {
      const actual = rewrite(kase, DONOR, LONG_PACKAGE);
      if (actual !== kase.source) failures.push(report(kase, kase.source, actual));
    }
    assertNoFailures(failures);
  });

  test("a matching rewrite equals the source spliced at the AST's own offsets", () => {
    const failures: string[] = [];
    for (const kase of MATCHING_CASES) {
      for (const packageSpecifier of [SHORT_PACKAGE, LONG_PACKAGE]) {
        const spans = specifierSpans(kase.source, kase.path, kase.donorSpecifiers);
        const expected = spliceAll(kase.source, spans, packageSpecifier);
        const actual = rewrite(kase, DONOR, packageSpecifier);
        if (actual !== expected) failures.push(report(kase, expected, actual));
      }
    }
    assertNoFailures(failures);
  });

  test("every byte outside the quoted spans survives the rewrite", () => {
    const failures: string[] = [];
    for (const kase of MATCHING_CASES) {
      const before = specifierSpans(kase.source, kase.path, kase.donorSpecifiers);
      const actual = rewrite(kase, DONOR, LONG_PACKAGE);
      const after = specifierSpans(actual, kase.path, new Set([LONG_PACKAGE]));
      if (skeleton(kase.source, before) !== skeleton(actual, after)) {
        failures.push(report(kase, skeleton(kase.source, before), skeleton(actual, after)));
      }
    }
    assertNoFailures(failures);
  });

  test("the rewritten file still parses, and each specifier keeps its own quote", () => {
    const failures: string[] = [];
    for (const kase of MATCHING_CASES) {
      const spans = specifierSpans(kase.source, kase.path, kase.donorSpecifiers);
      const actual = rewrite(kase, DONOR, LONG_PACKAGE);
      const rewritten = specifierSpans(actual, kase.path, new Set([LONG_PACKAGE]));
      const quotesBefore = spans.map((span) => kase.source[span.start - 1]).join("");
      const quotesAfter = rewritten.map((span) => actual[span.start - 1]).join("");
      if (rewritten.length !== spans.length || quotesBefore !== quotesAfter) {
        failures.push(`case ${kase.id}\n  quotes before ${quotesBefore}\n  quotes after  ${quotesAfter}`);
      }
    }
    assertNoFailures(failures);
  });

  test("rewriting twice changes nothing the second time", () => {
    const failures: string[] = [];
    for (const kase of MATCHING_CASES) {
      const once = rewrite(kase, DONOR, LONG_PACKAGE);
      const twice = rewriteResolvedImportSpecifier(once, kase.path, DONOR, LONG_PACKAGE, workspace);
      if (twice !== once) failures.push(report(kase, once, twice));
    }
    assertNoFailures(failures);
  });
});

describe("the recorded specifier span", () => {
  test("is the literal itself, delimiters included, in every case", () => {
    const failures: string[] = [];
    for (const kase of CASES) {
      for (const reference of inventoryModuleReferences(kase.source, kase.path, false, workspace)) {
        const span = reference.specifierSpan;
        const note = (why: string): void => {
          failures.push(`case ${kase.id}\n  ${reference.kind} ${JSON.stringify(reference.specifier)}: ${why}`);
        };
        if ((span === null) !== (reference.specifier === null)) {
          note(`span ${span === null ? "missing" : "present"} but specifier says otherwise`);
          continue;
        }
        if (span === null) continue;
        const raw = kase.source.slice(span.start, span.end);
        const delimiter = raw.slice(0, 1);
        if (!['"', "'", "`"].includes(delimiter)) note(`starts with ${JSON.stringify(delimiter)}`);
        else if (!raw.endsWith(delimiter) || raw.length < 2) note(`does not close with ${delimiter}: ${raw}`);
        else if (raw.slice(1, -1) !== reference.specifier) note(`interior ${raw} is not the specifier`);
        else if (span.start < reference.start || span.end > reference.end) note("outside the declaration");
      }
    }
    assertNoFailures(failures);
  });
});

describe("computed specifiers", () => {
  const SUBSTITUTED = ["const c = import(`./${name}`);", "const d = require(`./helpers${suffix}`);"];
  const STATIC = ["const a = import(`./helpers`);", "const b = require(`./helpers`);", "type E = import(`./helpers`).B;"];

  test("a specifier with a substitution is never mangled", () => {
    const failures: string[] = [];
    for (const shape of SHAPES) {
      for (const [index, template] of SUBSTITUTED.entries()) {
        const source = render([template], shape);
        const path = shape.tsx ? harness.TSX_IMPORTER : TS_IMPORTER;
        for (const packageSpecifier of [SHORT_PACKAGE, LONG_PACKAGE]) {
          const actual = rewriteResolvedImportSpecifier(source, path, DONOR, packageSpecifier, workspace);
          if (actual !== source) {
            failures.push(report({ id: `template:${index}/shape:${shape.id}`, path, source }, source, actual));
          }
        }
      }
    }
    assertNoFailures(failures);
  });

  test("a specifier with a substitution is reported as unsupported", () => {
    expect(SUBSTITUTED.length).toBeGreaterThan(0);
    const counts = SUBSTITUTED.map((template) => unsupportedModuleReferences(render([template], SHAPES[0]!), TS_IMPORTER, workspace).length);
    expect(counts.every((count) => count > 0)).toBe(true);
  });

  test("a no-substitution template specifier is repointed, backticks and all", () => {
    const failures: string[] = [];
    for (const shape of SHAPES) {
      for (const [index, template] of STATIC.entries()) {
        const source = render([template], shape);
        const path = shape.tsx ? harness.TSX_IMPORTER : TS_IMPORTER;
        for (const packageSpecifier of [SHORT_PACKAGE, LONG_PACKAGE]) {
          const expected = spliceAll(source, specifierSpans(source, path, new Set(["./helpers"])), packageSpecifier);
          expect(expected).not.toBe(source);
          const actual = rewriteResolvedImportSpecifier(source, path, DONOR, packageSpecifier, workspace);
          if (actual !== expected) {
            failures.push(report({ id: `static-template:${index}/shape:${shape.id}`, path, source }, expected, actual));
          }
        }
      }
    }
    assertNoFailures(failures);
    const one = rewriteResolvedImportSpecifier(STATIC[0]!, TS_IMPORTER, DONOR, SHORT_PACKAGE, workspace);
    expect(one).toBe("const a = import(`@a/b`);");
    expect(unsupportedModuleReferences(STATIC[0]!, TS_IMPORTER, workspace)).toHaveLength(0);
  });
});

describe("applyEscapeRewrites", () => {
  const ESCAPES = [
    { donorlessSpecifier: "./helpers.ts", packageSpecifier: LONG_PACKAGE },
    { donorlessSpecifier: "./unrelated.ts", packageSpecifier: SHORT_PACKAGE },
  ] as const;
  const OTHER_DONOR_SPECIFIERS = new Set(["./unrelated", "./unrelated.js"]);

  test("an empty rewrite list is the identity", () => {
    const failures: string[] = [];
    for (const kase of CASES) {
      const actual = applyEscapeRewrites(kase.source, kase.path, [], workspace);
      if (actual !== kase.source) failures.push(report(kase, kase.source, actual));
    }
    assertNoFailures(failures);
  });

  test("the reduction equals one splice of every span it should touch", () => {
    const failures: string[] = [];
    for (const kase of CASES) {
      const actual = applyEscapeRewrites(kase.source, kase.path, ESCAPES, workspace);
      const afterFirst = spliceAll(kase.source, specifierSpans(kase.source, kase.path, kase.donorSpecifiers), LONG_PACKAGE);
      const expected = spliceAll(afterFirst, specifierSpans(afterFirst, kase.path, OTHER_DONOR_SPECIFIERS), SHORT_PACKAGE);
      if (actual !== expected) failures.push(report(kase, expected, actual));
    }
    assertNoFailures(failures);
  });

  test("rewrites for different donors commute", () => {
    const failures: string[] = [];
    for (const kase of CASES) {
      const forward = applyEscapeRewrites(kase.source, kase.path, ESCAPES, workspace);
      const backward = applyEscapeRewrites(kase.source, kase.path, [...ESCAPES].reverse(), workspace);
      if (forward !== backward) failures.push(report(kase, forward, backward));
    }
    assertNoFailures(failures);
  });

  test("applying the same list twice changes nothing the second time", () => {
    const failures: string[] = [];
    for (const kase of CASES) {
      const once = applyEscapeRewrites(kase.source, kase.path, ESCAPES, workspace);
      const twice = applyEscapeRewrites(once, kase.path, ESCAPES, workspace);
      if (twice !== once) failures.push(report(kase, once, twice));
    }
    assertNoFailures(failures);
  });
});
