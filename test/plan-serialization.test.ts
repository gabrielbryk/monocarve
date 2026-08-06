/**
 * Manifest serialization: the plan's bytes are a function of its content.
 *
 * The serialized manifest *is* the plan — the thing a reviewer diffs, the thing
 * apply replays, the thing "same repo, same commit, same plan, byte for byte"
 * is a claim about. With a plain `JSON.stringify` those bytes are the insertion
 * order of an object literal and the iteration order of every `Record` in it:
 * a field added in the wrong place, or a map built by walking a `Set` whose
 * order follows discovery order, silently changes the file without changing
 * what it says.
 *
 * What this proves that the CLI's two-compilations test cannot: that test
 * builds both manifests in one process from one tree, so their insertion order
 * is identical by construction and no ordering bug can make it fail. Here the
 * two manifests are the same content in deliberately different key order, so
 * only a serializer that sorts keys — recursively, into nested objects, into
 * `Record` fields, and into objects inside arrays — can pass.
 *
 * A failure looks like: `serializeManifest` reverting to `JSON.stringify`, or a
 * sorter that stops at the top level, produces two different strings for two
 * manifests that carry identical data.
 */

import { describe, expect, test } from "bun:test";

import { serializeManifest } from "../src/plan/build.ts";
import type { ExtractionManifest } from "../src/plan/manifest.ts";
import { hashText } from "../src/util/hash.ts";

const DONOR = "apps/api/src/widget/widget.ts";
const TARGET = "libs/analytics/src/widget/widget.ts";
const ASSET = "apps/api/src/widget/widget.css";
const ASSET_TARGET = "libs/analytics/src/widget/widget.css";

const donorHash = hashText("export const widgetValue = 1;\n");
const assetHash = hashText(".widget { color: red; }\n");

/**
 * A manifest with every shape the sorter has to reach into: nested objects,
 * `Record` fields keyed by workspace path and by package name, and objects
 * carried inside arrays.
 */
function manifest(): ExtractionManifest {
  return {
    schemaVersion: 3,
    planId: "shape-fixture",
    createdAt: "2024-01-02T03:04:05.000Z",
    generator: { name: "monocarve", version: "0.0.0" },
    provenance: {
      configDigest: hashText("config"),
      policyDigest: hashText("policy"),
      compiler: { artifactIntegrity: hashText("compiler"), sourceRevision: "0123456789abcdef0123456789abcdef01234567" },
      adapters: {
        packageManager: { id: "synthetic-pm", contractVersion: 2, declaredVersion: "1.2.3" },
        taskRunner: { id: "synthetic-runner", contractVersion: 3 },
      },
    },
    baselineCommit: "0123456789abcdef0123456789abcdef01234567",
    graphDigest: hashText("shape"),
    application: "api",
    target: {
      packageName: "@acme/analytics",
      packageRoot: "libs/analytics",
      entrypoint: "src/index.ts",
      requiredExports: [{ name: "widgetValue", typeOnly: false }],
    },
    source: { files: [DONOR], tests: [], assets: [ASSET], sccs: { "scc-a": [DONOR] } },
    dependencies: { runtime: { "@acme/format": "workspace:*", zod: "^3.0.0" }, dev: {}, packageReferences: ["libs/format"] },
    sourceBlobs: { [DONOR]: donorHash, [ASSET]: assetHash },
    operations: [
      { kind: "move", source: DONOR, target: TARGET, preconditionHash: donorHash, resultHash: donorHash },
      { kind: "move", source: ASSET, target: ASSET_TARGET, preconditionHash: assetHash, resultHash: assetHash },
    ],
    consumers: [],
    generatedFiles: [],
    changedFiles: [ASSET, ASSET_TARGET, DONOR, TARGET].sort(),
    expectedDynamicImportDelta: { added: [], removed: [] },
    evaluationEffects: [
      { subject: "module", reach: "moved", path: TARGET, kinds: ["side-effect-import"] },
      { subject: "package", name: "left-pad", sideEffects: "undeclared" },
    ],
    metrics: { movedFiles: 2, movedLines: 1, applicationLinesBefore: 1, applicationLinesAfter: 0, consumers: 0 },
    commits: {
      plan: { subject: "chore(@acme/analytics): compile extraction plan shape-fixture" },
      move: { subject: "refactor(@acme/analytics): move 2 files into libs/analytics" },
      wiring: { subject: "refactor(@acme/analytics): wire @acme/analytics into the workspace" },
    },
    gates: { package: [], project: [], workspace: [] },
  };
}

/**
 * The same value with every object's keys inserted in the opposite order.
 * Reversing rather than hand-writing one alternative literal is what makes the
 * case general: it perturbs the order at every level of nesting at once, so a
 * sorter that only handles the top level cannot pass by luck.
 */
function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value === null || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source).reverse()) out[key] = reverseKeys(source[key]);
  return out;
}

describe("manifest serialization", () => {
  test("does not depend on the order keys were inserted in", () => {
    const ordered = manifest();
    const reordered = reverseKeys(ordered) as ExtractionManifest;

    // The control: without this the case above could pass vacuously, because a
    // fixture whose two manifests happened to share an insertion order would
    // serialize identically under any serializer at all.
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(ordered));
    // ...and the difference is order alone, not content.
    expect(JSON.parse(serializeManifest(reordered))).toEqual(JSON.parse(serializeManifest(ordered)));

    expect(serializeManifest(reordered)).toBe(serializeManifest(ordered));
  });

  test("stays a readable, parseable file with one trailing newline", () => {
    const text = serializeManifest(manifest());

    expect(text.endsWith("}\n")).toBe(true);
    expect(text).toContain('\n  "planId": "shape-fixture"');
    expect(text).toContain('\n    "packageName": "@acme/analytics"');
    // Sorted, not insertion order: `application` leads and `schemaVersion` does
    // not. Losing the leading `schemaVersion` is the price of the guarantee.
    const keys = Object.keys(JSON.parse(text) as Record<string, unknown>);
    expect(keys).toEqual([...keys].sort());
    expect(keys[0]).toBe("application");
  });
});
