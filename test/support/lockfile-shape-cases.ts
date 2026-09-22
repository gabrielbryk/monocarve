import type { PackageShape, WorkspaceShape } from "./lockfile-shape-harness.ts";

function pkg(root: string, name: string, sections: Omit<PackageShape, "root" | "name"> = {}): PackageShape {
  return { root, name, ...sections };
}

const FLAT_GLOBS = ["apps/*", "libs/*"] as const;

/**
 * The enumeration.
 *
 * Grouped by the property each group varies, because that is the only reason a
 * shape earns its pnpm run. Anything that does not change what pnpm serializes
 * — file contents, package versions, how many source files a package has — is
 * held fixed; every entry below differs from its neighbours in the structure of
 * the `importers:` section or in what the splicer has to resolve to build one.
 */
export const CORE_SHAPES: readonly WorkspaceShape[] = [
  // --- which neighbours are inline, which are blocks -------------------------
  {
    id: "block-neighbours",
    why: "every importer around the insertion point has dependencies, so all of them are block form",
    globs: FLAT_GLOBS,
    packages: [
      pkg("apps/api", "@acme/api", { dependencies: { "@acme/format": "workspace:*" } }),
      pkg("libs/format", "@acme/format", { dependencies: { "@acme/logger": "workspace:*" } }),
      pkg("libs/logger", "@acme/logger", { dependencies: { "@acme/format": "workspace:*" } }),
    ],
    target: pkg("libs/analytics", "@acme/analytics", { dependencies: { "@acme/format": "workspace:*" } }),
    consumers: ["apps/api"],
    expect: "match",
  },
  {
    id: "inline-siblings",
    why: "the importers that sort after the new package are `{}`, the form `parseImporters` was once blind to",
    globs: FLAT_GLOBS,
    packages: [
      pkg("apps/api", "@acme/api", { dependencies: { "@acme/format": "workspace:*" } }),
      pkg("libs/format", "@acme/format"),
      pkg("libs/logger", "@acme/logger"),
    ],
    target: pkg("libs/analytics", "@acme/analytics", { dependencies: { "@acme/format": "workspace:*" } }),
    consumers: ["apps/api"],
    expect: "match",
  },
  {
    id: "all-inline",
    why: "the consumer is inline too, so wiring has to expand `apps/api: {}` back to block form",
    globs: FLAT_GLOBS,
    packages: [pkg("apps/api", "@acme/api"), pkg("libs/format", "@acme/format"), pkg("libs/logger", "@acme/logger")],
    target: pkg("libs/analytics", "@acme/analytics"),
    consumers: ["apps/api"],
    expect: "match",
  },
  {
    id: "inline-target-between-blocks",
    why: "a new package with no dependencies inserted between two block importers",
    packages: [
      pkg("apps/api", "@acme/api", { dependencies: { "@acme/format": "workspace:*" } }),
      pkg("libs/aardvark", "@acme/aardvark", { dependencies: { "@acme/format": "workspace:*" } }),
      pkg("libs/format", "@acme/format", { dependencies: { "@acme/aardvark": "workspace:*" } }),
    ],
    target: pkg("libs/analytics", "@acme/analytics"),
    consumers: ["apps/api"],
    expect: "match",
  },

  // --- package names ---------------------------------------------------------
  {
    id: "unscoped-names",
    why: "no `@scope/`, so every lockfile key is unquoted and `yamlKey` takes its other branch",
    packages: [pkg("apps/api", "acme-api", { dependencies: { "acme-format": "workspace:*" } }), pkg("libs/format", "acme-format")],
    target: pkg("libs/analytics", "acme-analytics", { dependencies: { "acme-format": "workspace:*" } }),
    consumers: ["apps/api"],
    expect: "match",
  },
  {
    id: "mixed-scoped-and-unscoped",
    why: "quoted and unquoted keys inside one dependency map, which is where a sort by rendered key would slip",
    packages: [
      pkg("apps/api", "acme-api", { dependencies: { "@acme/format": "workspace:*", "acme-logger": "workspace:*" } }),
      pkg("libs/format", "@acme/format"),
      pkg("libs/logger", "acme-logger"),
    ],
    target: pkg("libs/analytics", "@acme/analytics", { dependencies: { "@acme/format": "workspace:*", "acme-logger": "workspace:*" } }),
    consumers: ["apps/api"],
    expect: "match",
  },

  // --- directory names, nesting, and sort order ------------------------------
  {
    id: "nested-roots",
    why: "package roots several directories deep, where the link version has to climb out and back down",
    packages: [
      pkg("apps/api", "@acme/api", { dependencies: { "@acme/inner": "workspace:*" } }),
      pkg("libs/a/b", "@acme/inner"),
      pkg("libs/a/b/c", "@acme/innermost", { dependencies: { "@acme/inner": "workspace:*" } }),
    ],
    target: pkg("libs/a/b/analytics", "@acme/analytics", { dependencies: { "@acme/inner": "workspace:*" } }),
    consumers: ["apps/api"],
    expect: "match",
  },
  {
    id: "creation-order-differs-from-sort-order",
    why: "the workspace manifest lists roots in reverse-sorted order, so a splice that appended would be visible",
    packages: [
      pkg("libs/zulu", "@acme/zulu"),
      pkg("libs/mike", "@acme/mike", { dependencies: { "@acme/zulu": "workspace:*" } }),
      pkg("apps/api", "@acme/api", { dependencies: { "@acme/mike": "workspace:*" } }),
    ],
    target: pkg("libs/alpha", "@acme/alpha", { dependencies: { "@acme/zulu": "workspace:*" } }),
    consumers: ["apps/api"],
    expect: "match",
  },
  {
    id: "code-unit-sort-uppercase",
    why: "`libs/Mid` and `libs/Zeta` sort before every lowercase sibling by code unit and after them by locale",
    packages: [
      pkg("apps/api", "@acme/api", { dependencies: { "@acme/alpha": "workspace:*" } }),
      pkg("libs/Zeta", "@acme/zeta"),
      pkg("libs/alpha", "@acme/alpha"),
      pkg("libs/beta", "@acme/beta", { dependencies: { "@acme/alpha": "workspace:*" } }),
    ],
    target: pkg("libs/Mid", "@acme/mid", { dependencies: { "@acme/alpha": "workspace:*" } }),
    consumers: ["apps/api"],
    expect: "match",
  },
  {
    id: "code-unit-sort-punctuation",
    why: "`-`, `.` and `/` are adjacent code points that most locale collations ignore entirely",
    packages: [
      pkg("apps/api", "@acme/api", { dependencies: { "@acme/ab": "workspace:*" } }),
      pkg("libs/a-b", "@acme/a-hyphen-b"),
      pkg("libs/a/b", "@acme/a-slash-b"),
      pkg("libs/ab", "@acme/ab"),
    ],
    target: pkg("libs/a.b", "@acme/a-dot-b", { dependencies: { "@acme/ab": "workspace:*" } }),
    consumers: ["apps/api"],
    expect: "match",
  },
  {
    id: "target-sorts-first",
    why: "the insertion point is the first entry after the workspace root",
    packages: [pkg("apps/api", "@acme/api", { dependencies: { "@acme/format": "workspace:*" } }), pkg("libs/format", "@acme/format")],
    target: pkg("apps/aaa", "@acme/aaa", { dependencies: { "@acme/format": "workspace:*" } }),
    consumers: ["apps/api"],
    expect: "match",
  },
  {
    id: "target-sorts-last-workspace-only",
    why: "insertion at the end of the section when `importers:` is the last block in the file",
    packages: [pkg("apps/api", "@acme/api", { dependencies: { "@acme/format": "workspace:*" } }), pkg("libs/format", "@acme/format")],
    target: pkg("libs/zzz", "@acme/zzz"),
    consumers: ["apps/api"],
    expect: "match",
  },
  {
    id: "target-sorts-last-with-packages-section",
    why: "the same end-of-section insertion, but with `packages:` immediately below it",
    packages: [pkg("apps/api", "@acme/api", { dependencies: { "@acme/format": "workspace:*", "left-pad": "1.3.0" } }), pkg("libs/format", "@acme/format")],
    target: pkg("libs/zzz", "@acme/zzz", { dependencies: { "left-pad": "1.3.0" } }),
    consumers: ["apps/api"],
    expect: "match",
  },

  // --- the workspace root importer -------------------------------------------
  {
    id: "root-importer-non-empty",
    why: "`.` carries dependencies, so the first entry in the section is a block rather than `.: {}`",
    rootDependencies: { "left-pad": "1.3.0" },
    packages: [pkg("apps/api", "@acme/api", { dependencies: { "@acme/format": "workspace:*" } }), pkg("libs/format", "@acme/format")],
    target: pkg("libs/analytics", "@acme/analytics", { dependencies: { "left-pad": "1.3.0" } }),
    consumers: ["apps/api"],
    expect: "match",
  },
  {
    id: "workspace-root-is-the-consumer",
    why: "wiring the `.` importer, whose link version has no `../` to climb",
    rootDependencies: { "left-pad": "1.3.0" },
    packages: [pkg("libs/format", "@acme/format")],
    target: pkg("libs/analytics", "@acme/analytics", { dependencies: { "@acme/format": "workspace:*" } }),
    consumers: ["."],
    expect: "match",
  },
  {
    id: "workspace-root-is-an-empty-consumer",
    why: "the same wiring when `.` starts as `.: {}` and has to be expanded",
    packages: [pkg("libs/format", "@acme/format")],
    target: pkg("libs/analytics", "@acme/analytics", { dependencies: { "@acme/format": "workspace:*" } }),
    consumers: ["."],
    expect: "match",
  },

  // --- more than one consumer ------------------------------------------------
  {
    id: "three-consumers-insertion-positions",
    why: "the new dependency sorts before, after, and between the ones a consumer already has — and one consumer already depends on the new package's own dependency",
    packages: [
      pkg("apps/api", "@acme/api", { dependencies: { "@acme/format": "workspace:*" } }),
      pkg("apps/edge", "@acme/edge", { dependencies: { "@acme/aardvark": "workspace:*", "@acme/format": "workspace:*" } }),
      pkg("apps/web", "@acme/web", { dependencies: { "@acme/aardvark": "workspace:*" } }),
      pkg("libs/aardvark", "@acme/aardvark"),
      pkg("libs/format", "@acme/format"),
    ],
    target: pkg("libs/analytics", "@acme/analytics", { dependencies: { "@acme/format": "workspace:*" } }),
    consumers: ["apps/api", "apps/edge", "apps/web"],
    expect: "match",
  },
  {
    id: "consumer-has-only-dev-dependencies",
    why: "wiring must create a `dependencies:` section above the existing `devDependencies:`, in pnpm's order",
    packages: [pkg("apps/api", "@acme/api", { devDependencies: { "@acme/format": "workspace:*" } }), pkg("libs/format", "@acme/format")],
    target: pkg("libs/analytics", "@acme/analytics"),
    consumers: ["apps/api"],
    expect: "match",
  },
  {
    id: "consumer-has-dev-and-optional-dependencies",
    why: "the same insertion with two existing sections below it, one of which the renderer cannot express",
    packages: [
      pkg("apps/api", "@acme/api", { devDependencies: { "@acme/format": "workspace:*" }, optionalDependencies: { "@acme/logger": "workspace:*" } }),
      pkg("libs/format", "@acme/format"),
      pkg("libs/logger", "@acme/logger"),
    ],
    target: pkg("libs/analytics", "@acme/analytics"),
    consumers: ["apps/api"],
    expect: "match",
  },

  // --- what the new package itself declares ----------------------------------
  {
    id: "target-dev-dependencies-only",
    why: "a new package whose only section is `devDependencies:`",
    packages: [pkg("apps/api", "@acme/api", { dependencies: { "@acme/format": "workspace:*" } }), pkg("libs/format", "@acme/format")],
    target: pkg("libs/analytics", "@acme/analytics", { devDependencies: { "@acme/format": "workspace:*" } }),
    consumers: ["apps/api"],
    expect: "match",
  },
  {
    id: "target-runtime-and-dev-dependencies",
    why: "both sections on the new package, in the order the renderer emits them",
    packages: [
      pkg("apps/api", "@acme/api", { dependencies: { "@acme/format": "workspace:*" } }),
      pkg("libs/format", "@acme/format"),
      pkg("libs/logger", "@acme/logger"),
    ],
    target: pkg("libs/analytics", "@acme/analytics", { dependencies: { "@acme/format": "workspace:*" }, devDependencies: { "@acme/logger": "workspace:*" } }),
    consumers: ["apps/api"],
    expect: "match",
  },
  {
    id: "external-dependency-already-in-the-workspace",
    why: "a registry dependency the new package copies from an importer that already resolved it",
    packages: [
      pkg("apps/api", "@acme/api", { dependencies: { "left-pad": "1.3.0" } }),
      pkg("libs/format", "@acme/format", { dependencies: { "left-pad": "1.3.0" } }),
    ],
    target: pkg("libs/analytics", "@acme/analytics", { dependencies: { "left-pad": "1.3.0" } }),
    consumers: ["apps/api"],
    expect: "match",
  },
  {
    id: "pinned-version-the-lockfile-already-carries",
    why: "no importer resolves `1.3.0` — the workspace declares `^1.3.0` — but `packages:`/`snapshots:` carry left-pad@1.3.0, so the version is taken from the lockfile rather than invented",
    packages: [pkg("apps/api", "@acme/api", { dependencies: { "left-pad": "^1.3.0" } }), pkg("libs/format", "@acme/format")],
    target: pkg("libs/analytics", "@acme/analytics", { dependencies: { "left-pad": "1.3.0" } }),
    consumers: ["apps/api"],
    expect: "match",
  },
  {
    id: "pinned-version-nothing-in-the-lockfile-carries",
    why: "the fallback that used to echo any digit-leading specifier; the lockfile has no left-pad at all, and an importer entry with nothing behind it is what `--frozen-lockfile` refuses",
    packages: [pkg("apps/api", "@acme/api", { dependencies: { "@acme/format": "workspace:*" } }), pkg("libs/format", "@acme/format")],
    target: pkg("libs/analytics", "@acme/analytics", { dependencies: { "left-pad": "1.3.0" } }),
    consumers: ["apps/api"],
    expect: "throw",
    throwMessage: /cannot resolve a lockfile version for left-pad@1\.3\.0/,
  },
  {
    id: "pinned-version-whose-snapshot-carries-a-peer-suffix",
    why: "`packages:` has react-dom@18.3.1 but the snapshot is react-dom@18.3.1(react@18.3.1); measured on pnpm 11.17.0, an importer naming the unsuffixed version regenerates byte-identically and then fails `--frozen-lockfile`, so a `packages:`-only attestation would not be one",
    packages: [pkg("apps/api", "@acme/api", { dependencies: { react: "^18.0.0", "react-dom": "^18.0.0" } }), pkg("libs/format", "@acme/format")],
    target: pkg("libs/analytics", "@acme/analytics", { dependencies: { "react-dom": "18.3.1" } }),
    consumers: ["apps/api"],
    expect: "throw",
    throwMessage: /cannot resolve a lockfile version for react-dom@18\.3\.1/,
  },

  // --- peer suffixes ---------------------------------------------------------
  {
    id: "peer-suffixed-versions-agree",
    why: "`18.3.1(react@18.3.1)` in every importer, so copying one is unambiguous",
    packages: [
      pkg("apps/api", "@acme/api", { dependencies: { react: "18.3.1", "react-dom": "18.3.1" } }),
      pkg("libs/format", "@acme/format", { dependencies: { react: "18.3.1", "react-dom": "18.3.1" } }),
    ],
    target: pkg("libs/analytics", "@acme/analytics", { dependencies: { react: "18.3.1", "react-dom": "18.3.1" } }),
    consumers: ["apps/api"],
    expect: "match",
  },
  {
    id: "peer-suffixed-versions-agree-without-declaring-the-peer",
    why: "the new package takes the suffixed version but does not declare the peer itself",
    packages: [
      pkg("apps/api", "@acme/api", { dependencies: { react: "18.3.1", "react-dom": "18.3.1" } }),
      pkg("libs/format", "@acme/format", { dependencies: { react: "18.3.1", "react-dom": "18.3.1" } }),
    ],
    target: pkg("libs/analytics", "@acme/analytics", { dependencies: { "react-dom": "18.3.1" } }),
    consumers: ["apps/api"],
    expect: "match",
  },
  {
    id: "peer-suffixed-versions-disagree",
    why: "one release built against two peers; the adapter must refuse rather than take the first",
    packages: [
      pkg("apps/api", "@acme/api", { dependencies: { react: "18.3.1", "react-dom": "18.3.1" } }),
      pkg("apps/web", "@acme/web", { dependencies: { react: "18.2.0", "react-dom": "18.3.1" } }),
    ],
    target: pkg("libs/analytics", "@acme/analytics", { dependencies: { "react-dom": "18.3.1" } }),
    consumers: ["apps/api"],
    expect: "throw",
    throwMessage: /resolves react-dom@18\.3\.1 to more than one version/,
  },

  // --- catalogs --------------------------------------------------------------
  {
    id: "catalog-specifier-another-importer-already-resolved",
    why: "`catalog:` is a YAML mapping indicator, and the version has to come from an importer that already has it",
    catalog: { "left-pad": "1.3.0" },
    packages: [
      pkg("apps/api", "@acme/api", { dependencies: { "left-pad": "catalog:" } }),
      pkg("libs/format", "@acme/format", { dependencies: { "left-pad": "catalog:" } }),
    ],
    target: pkg("libs/analytics", "@acme/analytics", { dependencies: { "left-pad": "catalog:" } }),
    consumers: ["apps/api"],
    expect: "match",
  },
  {
    id: "catalog-specifier-nothing-else-declares",
    why: "no importer holds a version to copy, and inventing one is the thing the adapter refuses to do",
    catalog: { "left-pad": "1.3.0", "is-odd": "3.0.1" },
    packages: [pkg("apps/api", "@acme/api", { dependencies: { "left-pad": "catalog:" } }), pkg("libs/format", "@acme/format")],
    target: pkg("libs/analytics", "@acme/analytics", { dependencies: { "is-odd": "catalog:" } }),
    consumers: ["apps/api"],
    expect: "throw",
    throwMessage: /cannot resolve a lockfile version for is-odd@catalog:/,
  },
];
