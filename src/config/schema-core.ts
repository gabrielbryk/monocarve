import { z } from "zod";

import { publicSurface, relativePath, scaffoldTemplateOverrides, templateSource } from "./primitives.ts";

/**
 * A first-party package that lives at an exact workspace root — the root
 * itself *is* the package, not a directory holding one package per
 * subdirectory the way `packageRoots` entries are. `name` is declared rather
 * than read from disk so dependency inference can attribute a bare-specifier
 * import to this package before, or without, a `package.json` scan.
 */
export const firstPartyPackage = z.strictObject({
  /** Workspace-relative directory that is the package, e.g. `"shared"`. */
  root: relativePath,
  /** Declared package name, e.g. `"@acme/shared"`. */
  name: z.string().min(1),
});

export const application = z.strictObject({
  /** Stable identifier used on the CLI (`--app web`) and in plan manifests. */
  name: z.string().min(1),
  /** Directory scanned for extractable code, repo-relative (e.g. `apps/web/src`). */
  sourceRoot: relativePath,
  /** tsconfig that resolves this application's imports; handed to the graph scanner. */
  tsconfig: relativePath,
  /**
   * Workspace package directory that owns this application. Defaults to the
   * conventional parent of `sourceRoot` (`apps/web/src` -> `apps/web`). Set it
   * when the scan root is the package itself, so consumer dependency updates
   * never target its parent directory.
   */
  ownerRoot: relativePath.optional(),
  /**
   * Workspace package name of the application itself. Needed so consumer
   * rewrites can tell "this app imports the extracted code" from "another
   * package does".
   */
  packageName: z.string().min(1).optional(),
  /**
   * Task-runner project id for this application, when it differs from `name`.
   * Feeds the `{project}` placeholder in gate commands.
   */
  project: z.string().min(1).optional(),
  /**
   * Files that compose the application at runtime (entrypoints, DI wiring,
   * route registries). A candidate closure containing one of these is a
   * composition root and is never eligible for extraction.
   */
  compositionRoots: z.array(relativePath).default([]),
  /**
   * Ambient compilation surface this application's code expects, used by the
   * external-consumer compile proof and by any scaffold template that renders
   * `{lib}` / `{types}`. A package carved out of a browser application needs
   * DOM typings to typecheck in isolation; one carved out of a server
   * application needs its runtime's globals instead. Getting this wrong makes
   * the compile proof reject packages that are in fact correct, so it is
   * declared rather than guessed.
   */
  compilerProfile: z
    .strictObject({
      /** TypeScript `lib` files, e.g. `["lib.es2022.d.ts", "lib.dom.d.ts"]`. */
      lib: z.array(z.string().min(1)).default(["lib.es2022.d.ts"]),
      /** Ambient `types` packages, e.g. `["node"]` or `["bun"]`. */
      types: z.array(z.string().min(1)).default([]),
      /** Compile the proof fixture with `react-jsx` when the closure has JSX. */
      jsx: z.boolean().default(false),
      /**
       * Module-resolution mode for the proof. It must match the one the
       * application's own tsconfig uses: under `nodenext` a relative import
       * needs an explicit extension, under `bundler` it must not have a `.js`
       * one — so proving a bundler-resolved package with `nodenext` rejects
       * every file the application itself compiles happily.
       */
      moduleResolution: z.enum(["nodenext", "bundler"]).default("nodenext"),
    })
    .prefault({}),
  /** Per-application scaffold overrides; unset keys fall back to the root templates. */
  scaffoldTemplates: scaffoldTemplateOverrides.optional(),
  description: z.string().optional(),
});

export type ApplicationConfig = z.output<typeof application>;
export type FirstPartyPackageConfig = z.output<typeof firstPartyPackage>;

/* -------------------------------------------------------------------------- */
/* Gates                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Command templates the transaction stage runs — first inside the disposable
 * simulation worktree, then (optionally) in the real checkout. These are the
 * repository's OWN gates: this tool never ships its own notion of "valid".
 *
 * Placeholders: `{package}` (new package name), `{packageRoot}` (its directory),
 * `{project}` (task-runner project id), `{app}` (application name), `{owner}`
 * (that application's directory).
 *
 * The `project` tier is rendered once per *consuming* application, and there
 * `{app}`, `{owner}` and `{project}` name that consumer rather than the donor.
 */
export const gates = z.strictObject({
  /** Run against the newly created package only. */
  package: z.array(z.string().min(1)).default([]),
  /** Run against the application that donated the code. */
  project: z.array(z.string().min(1)).default([]),
  /** Whole-workspace gates: lint, format, typecheck, test. The expensive tier. */
  workspace: z.array(z.string().min(1)).default([]),
  /** Per-command timeout in milliseconds. */
  timeoutMs: z.number().int().positive().default(20 * 60 * 1000),
  /**
   * Maximum number of commands that may run at once within one gate tier.
   * Tiers remain ordered: package gates finish before project gates begin, and
   * project gates finish before workspace gates begin.
   */
  maxConcurrency: z.number().int().positive().default(1),
});

export type GatesConfig = z.output<typeof gates>;

/* -------------------------------------------------------------------------- */
/* Declaration-preparation policy                                             */
/* -------------------------------------------------------------------------- */

/**
 * Repository-owned commands for a source-level declaration preparation.
 *
 * These tiers intentionally have no defaults. A preparation changes source
 * before the ordinary R100 move, so certifying it with zero repository gates
 * would manufacture a claim the workspace never made. A configured tier may
 * be empty when another tier carries the repository's proof commands.
 *
 * Placeholders: `{app}`, `{owner}`, `{sourcePath}`, `{targetPath}`, and
 * `{moduleSpecifier}`. They are rendered only after the donor and target are
 * known, then copied verbatim into the preparation manifest.
 */
export const preparationGates = z.strictObject({
  package: z.array(z.string().min(1)).optional(),
  project: z.array(z.string().min(1)).optional(),
  workspace: z.array(z.string().min(1)).optional(),
});

/** Commit metadata for the one exact-scope source preparation commit. */
export const preparationCommitTemplate = z.strictObject({
  /** Conventional-commit subject; it must be supplied by the repository. */
  subject: singleLine(),
  /** Optional body, rendered with the same preparation placeholders. */
  body: z.string().optional(),
});

/**
 * Opt-in policy for declaration preparation. Omission is legacy-compatible at
 * config load time, but a planner must refuse it rather than certify no gates
 * or invent a commit subject.
 */
export const preparationPolicy = z.strictObject({
  gates: preparationGates.optional(),
  commit: preparationCommitTemplate.optional(),
}).prefault({});

export type PreparationGateTemplatesConfig = z.output<typeof preparationGates>;
export type PreparationCommitTemplateConfig = z.output<typeof preparationCommitTemplate>;
export type PreparationPolicyConfig = z.output<typeof preparationPolicy>;

/* -------------------------------------------------------------------------- */
/* Pre-extraction preparers                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A repository-owned command which prepares an exact move destination before
 * extraction (for example, promoting a checked-in ratchet). The engine knows
 * neither the file format nor the command's purpose: it only constrains the
 * command to the declared output set.
 *
 * Templates receive `{app}`, `{package}`, `{packageRoot}`, `{planId}`,
 * `{sourcePath}`, and `{targetPath}` from one reviewed move operation.
 */
export const preparer = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "must be a lowercase kebab-case identifier"),
  phase: z.literal("pre-extraction"),
  command: z.string().min(1),
  outputs: z.array(z.string().min(1)).min(1),
  verify: z.string().min(1).optional(),
  commit: z.strictObject({
    subject: z.string().min(1).refine((value) => !value.includes("\n"), { message: "commit subject must be a single line" }),
    body: z.string().optional(),
  }),
});

export const preparers = z.array(preparer).default([]).superRefine((items, ctx) => {
  const seen = new Set<string>();
  for (const [index, item] of items.entries()) {
    if (seen.has(item.id)) ctx.addIssue({ code: "custom", path: [index, "id"], message: "preparer id must be unique" });
    seen.add(item.id);
  }
});

export type PreparerConfig = z.output<typeof preparer>;

/* -------------------------------------------------------------------------- */
/* Commit templates                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Conventional Commit subjects for the commits `apply` creates.
 *
 * The two-commit shape is load-bearing: the `move` commit must be a pure rename
 * so `git log --follow` and R100 similarity detection stay intact, and all
 * content edits (import rewrites, scaffolding, lockfile) land in `wiring`.
 *
 * Placeholders: `{package}`, `{packageRoot}`, `{app}`, `{planId}`, `{fileCount}`.
 * Subjects must be single-line; a newline is rejected at validation time.
 */
export const commitTemplates = z.strictObject({
  /** Commit that records the compiled plan manifest, when plans are committed. */
  plan: singleLine().default("chore({package}): compile extraction plan {planId}"),
  /** Pure-rename commit. Nothing but `move` operations may be staged here. */
  move: singleLine().default("refactor({package}): move {fileCount} files into {packageRoot}"),
  /** Content commit: scaffolding, consumer rewrites, lockfile importer. */
  wiring: singleLine().default("refactor({package}): wire {package} into the workspace"),
  /** Appended verbatim to every generated commit body (trailers, co-authors). */
  trailer: z.string().default(""),
});

function singleLine() {
  return z
    .string()
    .min(1)
    .refine((value) => !value.includes("\n"), { message: "commit subject must be a single line" });
}
export type CommitTemplatesConfig = z.output<typeof commitTemplates>;

/* -------------------------------------------------------------------------- */
/* Scaffold templates                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Files written into a newly created package. Rendered with the same
 * placeholders as commits, plus `{scope}`, `{entrypoint}`, and `{relativeRoot}`
 * (the `../..` prefix back to the repo root, for tsconfig `extends`).
 *
 * `extraFiles` is the escape hatch for anything else a workspace demands —
 * README, eslint config, `.npmignore` — without teaching the engine about it.
 */
export const scaffoldTemplates = z.strictObject({
  packageJson: templateSource,
  tsconfig: templateSource.optional(),
  /** Task-runner project file: `moon.yml`, `project.json`, `turbo.json`. */
  taskFile: templateSource.optional(),
  extraFiles: z.record(z.string().min(1), templateSource).prefault({}),
  /** Entry file within the new package, relative to its root. */
  entrypoint: relativePath.default("src/index.ts"),
  /**
   * devDependencies every generated package gets, on top of the ones inferred
   * from the moved code (`{ "typescript": "catalog:" }`). Inferred entries win.
   */
  devDependencies: z.record(z.string().min(1), z.string().min(1)).prefault({}),
  /**
   * Statement template appended to the generated entrypoint barrel for each
   * moved production file. `{specifier}` is the package-relative specifier.
   */
  barrelExport: z.string().min(1).default('export * from "./{specifier}";'),
  /**
   * How the barrel writes a moved file's specifier. NodeNext resolution needs
   * the real extension (`./chart.ts`); bundler-style resolution conventionally
   * omits it; `js` is for packages that publish compiled output.
   */
  barrelSpecifier: z.enum(["extension", "extensionless", "js"]).default("extension"),
  /** Root-barrel-only (legacy) or barrel plus module-preserving public subpaths. */
  publicSurface,
});

export type ScaffoldTemplatesConfig = z.output<typeof scaffoldTemplates>;

/* -------------------------------------------------------------------------- */
/* Extraction profiles                                                        */
/* -------------------------------------------------------------------------- */

/**
 * A profile declares the workspace-specific shape of a package kind without
 * teaching planning about that workspace's directory or naming conventions.
 * It is intentionally only configuration in this phase: selecting a profile
 * does not yet add a new planning operation.
 */
export const extractionProfile = z.strictObject({
  /** Library profiles publish a barrel; leaf-test profiles are private test packages. */
  kind: z.enum(["library", "leaf-test"]).default("library"),
  /** One of `packageRoots`; generated packages are direct children of it. */
  destinationRoot: relativePath,
  /** Direct-child directory, rendered with `{name}`, `{app}`, and `{profile}`. */
  directoryTemplate: z.string().min(1).default("{name}"),
  /** Package name, rendered with `{scope}`, `{name}`, `{app}`, and `{profile}`. */
  packageNameTemplate: z.string().min(1).default("{scope}{name}"),
  /** Optional task-runner project id template, rendered with the same variables plus `{package}`. */
  projectIdTemplate: z.string().min(1).optional(),
  /** Profile-level scaffold overrides, applied after the application's overrides. */
  scaffoldTemplates: scaffoldTemplateOverrides.optional(),
  /** Profile-level command templates; omitted tiers inherit the workspace gates. */
  gates: z
    .strictObject({
      package: z.array(z.string().min(1)).optional(),
      project: z.array(z.string().min(1)).optional(),
      workspace: z.array(z.string().min(1)).optional(),
    })
    .optional(),
});

export const extractionProfiles = z
  .strictObject({
    /** The profile used when a caller does not request one. Omit to keep legacy behavior. */
    default: z.string().min(1).optional(),
    profiles: z.record(z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "must be a lowercase kebab-case identifier"), extractionProfile).default({}),
  })
  .prefault({});

export type ExtractionProfileConfig = z.output<typeof extractionProfile>;

export interface ResolvedExtractionProfile {
  /** Undefined denotes the synthetic legacy profile used by existing configs. */
  readonly name: string | undefined;
  readonly kind: "library" | "leaf-test";
  readonly destinationRoot: string;
  readonly directoryTemplate: string;
  readonly packageNameTemplate: string;
  readonly projectIdTemplate: string | undefined;
  readonly scaffoldTemplates: ScaffoldTemplatesConfig;
  readonly gates: GatesConfig;
}

export interface RenderedExtractionProfile {
  readonly packageName: string;
  readonly packageRoot: string;
  readonly projectId: string | undefined;
}
