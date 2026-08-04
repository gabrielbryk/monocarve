import { pnpmAdapter } from "../../src/adapters/pnpm.ts";
import type { PackageShape, WorkspaceShape } from "./lockfile-shape-harness.ts";

function pkg(root: string, name: string, sections: Omit<PackageShape, "root" | "name"> = {}): PackageShape {
  return { root, name, ...sections };
}

const FLAT_GLOBS = ["apps/*", "libs/*"] as const;

/** Negative and oracle shapes kept separate from the compatibility matrix. */
export const NEGATIVE_SHAPES: readonly WorkspaceShape[] = [
  {
    id: "target-declares-optional-dependencies",
    why: "the third section pnpm writes, after `dependencies` and `devDependencies`; it used to be unrepresentable in `RenderImporterInput` and vanished from the block",
    packages: [
      pkg("apps/api", "@acme/api", { dependencies: { "@acme/logger": "workspace:*" } }),
      pkg("libs/logger", "@acme/logger"),
    ],
    target: pkg("libs/analytics", "@acme/analytics", { optionalDependencies: { "@acme/logger": "workspace:*" } }),
    consumers: ["apps/api"],
    expect: "match",
  },
  {
    id: "target-declares-all-three-sections",
    why: "the order the sections come out in, which is only visible when a block carries all of them",
    packages: [
      pkg("apps/api", "@acme/api", { dependencies: { "@acme/format": "workspace:*" } }),
      pkg("libs/format", "@acme/format"),
      pkg("libs/logger", "@acme/logger"),
      pkg("libs/opt", "@acme/opt"),
    ],
    target: pkg("libs/analytics", "@acme/analytics", {
      dependencies: { "@acme/format": "workspace:*" },
      devDependencies: { "@acme/logger": "workspace:*" },
      optionalDependencies: { "@acme/opt": "workspace:*" },
    }),
    consumers: ["apps/api"],
    expect: "match",
  },

  // --- the harness's own negative cases ---------------------------------------
  {
    id: "harness-notices-an-over-declared-block",
    why: "a splice every stage of the pipeline agrees with, and pnpm removes; without this the matrix could report `matched` unconditionally and still pass",
    globs: FLAT_GLOBS,
    packages: [
      pkg("apps/api", "@acme/api", { dependencies: { "@acme/format": "workspace:*" } }),
      pkg("libs/format", "@acme/format"),
      pkg("libs/logger", "@acme/logger"),
    ],
    target: pkg("libs/analytics", "@acme/analytics", { dependencies: { "@acme/format": "workspace:*" } }),
    consumers: ["apps/api"],
    mutate: (spliced) =>
      pnpmAdapter.replaceImporter(
        spliced,
        "libs/analytics",
        pnpmAdapter.addBlockDependency(
          pnpmAdapter.importerBlock(spliced, "libs/analytics")!,
          "@acme/logger",
          "workspace:*",
          pnpmAdapter.linkVersion("libs/analytics", "libs/logger"),
        ),
      ),
    expect: "diverge",
    plannedOnly: ["      '@acme/logger':"],
  },
  {
    id: "harness-notices-a-bare-key-instead-of-an-empty-map",
    why: "the renderer writes `  libs/analytics: {}` for a package that declares nothing, on the claim that a bare key is YAML null and the next install would rewrite it; this is that claim, asked of pnpm",
    packages: [
      pkg("apps/api", "@acme/api", { dependencies: { "@acme/format": "workspace:*" } }),
      pkg("libs/format", "@acme/format"),
    ],
    target: pkg("libs/analytics", "@acme/analytics"),
    consumers: ["apps/api"],
    mutate: (spliced) => spliced.replace("  libs/analytics: {}", "  libs/analytics:"),
    expect: "diverge",
    plannedOnly: ["  libs/analytics:"],
    regeneratedOnly: ["  libs/analytics: {}"],
  },
];

/**
 * Deliberately mis-sorted, to show the matrix above is not vacuous.
 *
 * Every sorting shape in `SHAPES` asserts that the splice lands where pnpm
 * would put it. That assertion is only worth having if pnpm would have moved a
 * block that landed somewhere else — otherwise the whole group is testing that
 * two files nobody rewrites are equal. This shape takes a splice that matches,
 * moves the new package's block past the importer it sorts before, and requires
 * the comparison to notice.
 */
export const MIS_SORTED_SPLICE: WorkspaceShape = {
  id: "mis-sorted-splice",
  why: "the block is appended past the importer it sorts before, which is the original bug this suite exists for",
  packages: [
    pkg("apps/api", "@acme/api", { dependencies: { "@acme/format": "workspace:*" } }),
    pkg("libs/format", "@acme/format"),
  ],
  target: pkg("libs/analytics", "@acme/analytics", { dependencies: { "@acme/format": "workspace:*" } }),
  consumers: ["apps/api"],
  mutate: (spliced) => {
    const block = pnpmAdapter.importerBlock(spliced, "libs/analytics");
    if (block === undefined) throw new Error("the splice produced no block to displace");
    // `importers:` is the last section here — every dependency is a workspace
    // link, so pnpm writes no `packages:` — which is what makes appending the
    // block to the file the same thing as appending it to the section.
    return `${spliced.replace(block, "").replace(/\n+$/, "\n")}\n${block.replace(/\n+$/, "\n")}`;
  },
  expect: "diverge",
};

/**
 * The one shape where `--lockfile-only` is the wrong question.
 *
 * An importer names `left-pad@1.3.0` and the lockfile carries no `packages:` or
 * `snapshots:` entry for it. pnpm's canonical round-trip preserves that
 * exactly — same sha256 — so regenerate-and-compare reports agreement, and
 * `--frozen-lockfile` refuses to install the same bytes with
 * `ERR_PNPM_LOCKFILE_MISSING_DEPENDENCY`.
 *
 * The adapter used to write these bytes itself, by echoing a digit-leading
 * specifier as if it were a resolution; `pinned-version-nothing-in-the-lockfile-carries`
 * above is that path, and it now refuses. So the bytes here are built by hand:
 * the manifest declares the dependency (`unrenderedDependencies`, so the next
 * pnpm run keeps the entry rather than deleting it) and `mutate` writes the
 * importer entry the renderer will no longer write. What remains under test is
 * the *oracle*, which is unchanged and still cannot see this — the reason
 * `missingResolutions` exists.
 */
export const ORACLE_BLIND_SPOT: WorkspaceShape = {
  id: "an-importer-entry-with-no-resolution-behind-it",
  why: "a lockfile that is incomplete rather than mis-serialized: it regenerates byte-identically and cannot be installed",
  packages: [
    pkg("apps/api", "@acme/api", { dependencies: { "@acme/format": "workspace:*" } }),
    pkg("libs/format", "@acme/format"),
  ],
  target: pkg("libs/analytics", "@acme/analytics", { unrenderedDependencies: { "left-pad": "1.3.0" } }),
  consumers: ["apps/api"],
  mutate: (spliced) =>
    pnpmAdapter.replaceImporter(
      spliced,
      "libs/analytics",
      // Not `renderImporterBlock`: this is the caller-supplied-version writer,
      // which is how the harness gets bytes the renderer now refuses to produce.
      pnpmAdapter.addBlockDependency(pnpmAdapter.importerBlock(spliced, "libs/analytics")!, "left-pad", "1.3.0", "1.3.0"),
    ),
  expect: "match",
};
