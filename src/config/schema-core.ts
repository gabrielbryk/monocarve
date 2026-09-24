import { z } from "zod";

import { projectReferences, publicSurface, relativePath, scaffoldTemplateOverrides, templateSource } from "./primitives.ts";

/**
 * A first-party package that lives at an exact workspace root — the root
 * itself *is* the package, not a directory holding one package per
 * subdirectory the way `packageRoots` entries are. `name` is declared rather
 * than read from disk so dependency inference can attribute a bare-specifier
 * import to this package before, or without, a `package.json` scan.
 */
export const firstPartyPackage = z.strictObject({
  /** Workspace-relative directory that is the package, e.g. `"shared"`. */
  root: relativePath.describe("Workspace-relative directory that is the package itself."),
  /** Declared package name, e.g. `"@acme/shared"`. */
  name: z.string().min(1).describe("Declared package name, e.g. `@acme/shared`."),
});

export const application = z.strictObject({
  /** Stable identifier used on the CLI (`--app web`) and in plan manifests. */
  name: z.string().min(1).describe("Stable application identifier used on the CLI (`--app`) and in plan manifests."),
  /** Directory scanned for extractable code, repo-relative (e.g. `apps/web/src`). */
  sourceRoot: relativePath.describe("Repo-relative directory scanned for extractable code, e.g. `apps/web/src`."),
  /** tsconfig that resolves this application's imports; handed to the graph scanner. */
  tsconfig: relativePath.describe("tsconfig that resolves this application's imports for the graph scanner."),
  /**
   * First-party source directories that may consume this application's code
   * but are not extraction donors themselves (for example fixture or build
   * scripts adjacent to `src`). They participate in consumer discovery and
   * audit only.
   */
  consumerRoots: z
    .array(relativePath)
    .default([])
    .describe("First-party directories that may consume this application's code but are never extraction donors."),
  /**
   * Workspace package directory that owns this application. Defaults to the
   * conventional parent of `sourceRoot` (`apps/web/src` -> `apps/web`). Set it
   * when the scan root is the package itself, so consumer dependency updates
   * never target its parent directory.
   */
  ownerRoot: relativePath.optional().describe("Workspace package directory owning the application; defaults to the parent of `sourceRoot`."),
  /**
   * Workspace package name of the application itself. Needed so consumer
   * rewrites can tell "this app imports the extracted code" from "another
   * package does".
   */
  packageName: z.string().min(1).optional().describe("Workspace package name of the application itself, used to target consumer rewrites."),
  /**
   * Task-runner project id for this application, when it differs from `name`.
   * Feeds the `{project}` placeholder in gate commands.
   */
  project: z.string().min(1).optional().describe("Task-runner project id when it differs from `name`; feeds the `{project}` gate placeholder."),
  /**
   * Files that compose the application at runtime (entrypoints, DI wiring,
   * route registries). A candidate closure containing one of these is a
   * composition root and is never eligible for extraction.
   */
  compositionRoots: z
    .array(relativePath)
    .default([])
    .describe("Runtime composition files (entrypoints, DI wiring, route registries) that make a closure ineligible."),
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
      lib: z.array(z.string().min(1)).default(["lib.es2022.d.ts"]).describe("TypeScript `lib` files for the compile proof, e.g. `lib.dom.d.ts`."),
      /** Ambient `types` packages, e.g. `["node"]` or `["bun"]`. */
      types: z.array(z.string().min(1)).default([]).describe("Ambient `types` packages for the compile proof, e.g. `node` or `bun`."),
      /** Compile the proof fixture with `react-jsx` when the closure has JSX. */
      jsx: z.boolean().default(false).describe("Compile the proof fixture with `react-jsx` when the closure contains JSX."),
      /**
       * Module-resolution mode for the proof. It must match the one the
       * application's own tsconfig uses: under `nodenext` a relative import
       * needs an explicit extension, under `bundler` it must not have a `.js`
       * one — so proving a bundler-resolved package with `nodenext` rejects
       * every file the application itself compiles happily.
       */
      moduleResolution: z
        .enum(["nodenext", "bundler"])
        .default("nodenext")
        .describe("Module-resolution mode for the compile proof; must match the application's own tsconfig."),
      /** Match the application's TypeScript CommonJS default-import interop setting. */
      esModuleInterop: z.boolean().default(false).describe("Match the application's `esModuleInterop` setting."),
      /** Match the application's acceptance of synthetic default imports from CommonJS declarations. */
      allowSyntheticDefaultImports: z.boolean().default(false).describe("Match the application's `allowSyntheticDefaultImports` setting."),
    })
    .prefault({})
    .describe("Ambient compilation surface (libs, types, JSX, resolution) the application's code expects."),
  /** Per-application scaffold overrides; unset keys fall back to the root templates. */
  scaffoldTemplates: scaffoldTemplateOverrides.optional().describe("Per-application scaffold overrides; unset keys fall back to the root `scaffoldTemplates`."),
  description: z.string().optional().describe("Free-form human description of the application."),
});

/** One configured donor application: its name, source root, owner, and per-application overrides. */
export type ApplicationConfig = z.output<typeof application>;
/** A declared first-party package outside `packageRoots`, attributable by bare specifier. */
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
  package: z.array(z.string().min(1)).default([]).describe("Gate commands run against the newly created package."),
  /** Run against the application that donated the code. */
  project: z.array(z.string().min(1)).default([]).describe("Gate commands run once per consuming application project."),
  /** Whole-workspace gates: lint, format, typecheck, test. The expensive tier. */
  workspace: z.array(z.string().min(1)).default([]).describe("Whole-workspace gate commands such as lint, format, typecheck, and test."),
  /** Per-command timeout in milliseconds. */
  timeoutMs: z
    .number()
    .int()
    .positive()
    .default(20 * 60 * 1000)
    .describe("Per-command gate timeout in milliseconds."),
  /**
   * Maximum number of commands that may run at once within one gate tier.
   * Tiers remain ordered: package gates finish before project gates begin, and
   * project gates finish before workspace gates begin.
   */
  maxConcurrency: z.number().int().positive().default(1).describe("Maximum commands run at once within one gate tier; tiers stay ordered."),
});

/** Gate command templates run after an extraction, per package, workspace, and consuming project. */
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
const preparationGates = z.strictObject({
  package: z.array(z.string().min(1)).optional().describe("Preparation gate commands for the target package tier."),
  project: z.array(z.string().min(1)).optional().describe("Preparation gate commands for the donor project tier."),
  workspace: z.array(z.string().min(1)).optional().describe("Preparation gate commands for the whole workspace."),
});

/** Commit metadata for the one exact-scope source preparation commit. */
const preparationCommitTemplate = z.strictObject({
  /** Conventional-commit subject; it must be supplied by the repository. */
  subject: singleLine().describe("Single-line Conventional Commit subject for the preparation commit."),
  /** Optional body, rendered with the same preparation placeholders. */
  body: z.string().optional().describe("Optional commit body rendered with the preparation placeholders."),
});

/**
 * Opt-in policy for declaration preparation. Omission is legacy-compatible at
 * config load time, but a planner must refuse it rather than certify no gates
 * or invent a commit subject.
 */
export const preparationPolicy = z
  .strictObject({
    gates: preparationGates.optional().describe("Repository gate commands that certify a declaration preparation."),
    commit: preparationCommitTemplate.optional().describe("Commit subject and body for the preparation commit."),
  })
  .prefault({});

/** Gate command templates run for a single source-preparation move. */
export type PreparationGateTemplatesConfig = z.output<typeof preparationGates>;
/** Commit subject/body templates for the one source-preparation commit. */
export type PreparationCommitTemplateConfig = z.output<typeof preparationCommitTemplate>;
/** Source-preparation policy: optional gate and commit templates. */
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
const preparer = z
  .strictObject({
    id: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]*$/, "must be a lowercase kebab-case identifier")
      .describe("Unique lowercase kebab-case preparer identifier."),
    phase: z.literal("pre-extraction").describe("Lifecycle phase; always `pre-extraction`."),
    command: z.string().min(1).optional().describe("Templated shell command run in a disposable baseline worktree."),
    replacements: z
      .array(
        z
          .strictObject({
            path: z.string().min(1).describe("Templated path of the file to edit."),
            before: z.string().min(1).describe("Literal text to replace."),
            after: z.string().describe("Literal replacement text."),
            prefix: z.string().min(1).optional().describe("Literal context required immediately before `before`."),
            suffix: z.string().min(1).optional().describe("Literal context required immediately after `before`."),
          })
          .superRefine((replacement, ctx) => {
            if (replacement.prefix === undefined && replacement.suffix === undefined) {
              ctx.addIssue({ code: "custom", message: "text replacement must configure prefix or suffix context" });
            }
          }),
      )
      .min(1)
      .optional()
      .describe("Ordered, anchored literal text replacements."),
    creates: z
      .array(
        z.strictObject({
          path: z.string().min(1).describe("Templated path of the new file."),
          contents: z.string().describe("Literal UTF-8 file contents."),
          mode: z
            .union([z.literal(0o644), z.literal(0o755)])
            .optional()
            .describe("File mode, `0o644` (default) or `0o755`."),
        }),
      )
      .min(1)
      .optional()
      .describe("New UTF-8 files to create; their paths are outputs automatically."),
    outputs: z.array(z.string().min(1)).default([]).describe("Templated paths the preparer may change; any other change is refused."),
    verify: z.string().min(1).optional().describe("Optional templated verification command run after the preparer."),
    commit: z
      .strictObject({
        subject: z
          .string()
          .min(1)
          .refine((value) => !value.includes("\n"), { message: "commit subject must be a single line" })
          .describe("Single-line commit subject for the preparer's outputs."),
        body: z.string().optional().describe("Optional commit body."),
      })
      .describe("Commit metadata for the preparer's outputs."),
  })
  .superRefine((item, ctx) => {
    if (item.command === undefined && item.replacements === undefined && item.creates === undefined) {
      ctx.addIssue({ code: "custom", message: "preparer must configure command, replacements, or creates" });
    }
  });

export const preparers = z
  .array(preparer)
  .default([])
  .superRefine((items, ctx) => {
    const seen = new Set<string>();
    for (const [index, item] of items.entries()) {
      if (seen.has(item.id)) ctx.addIssue({ code: "custom", path: [index, "id"], message: "preparer id must be unique" });
      seen.add(item.id);
    }
  });

/** One configured preparer: a reviewed transform run before the extraction journal. */
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
  plan: singleLine().default("chore({package}): compile extraction plan {planId}").describe("Subject of the commit that records the compiled plan manifest."),
  /** Pure-rename commit. Nothing but `move` operations may be staged here. */
  move: singleLine().default("refactor({package}): move {fileCount} files into {packageRoot}").describe("Subject of the pure-rename move commit."),
  /** Content commit: scaffolding, consumer rewrites, lockfile importer. */
  wiring: singleLine()
    .default("refactor({package}): wire {package} into the workspace")
    .describe("Subject of the content commit: scaffolding, consumer rewrites, and lockfile."),
  /** Appended verbatim to every generated commit body (trailers, co-authors). */
  trailer: z.string().default("").describe("Text appended verbatim to every generated commit body, such as trailers."),
});

function singleLine() {
  return z
    .string()
    .min(1)
    .refine((value) => !value.includes("\n"), { message: "commit subject must be a single line" });
}
/** Commit subject/body templates for extraction commits; subjects must be single-line. */
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
  packageJson: templateSource.describe("Template for the generated package's `package.json`."),
  tsconfig: templateSource.optional().describe("Template for the generated package's tsconfig."),
  /** Task-runner project file: `moon.yml`, `project.json`, `turbo.json`. */
  taskFile: templateSource.optional().describe("Task-runner project file template, e.g. `moon.yml`."),
  extraFiles: z.record(z.string().min(1), templateSource).prefault({}).describe("Additional files to scaffold, keyed by package-relative path."),
  projectReferences: projectReferences.describe("Which tsconfig files receive and are named by inferred project references."),
  /** Entry file within the new package, relative to its root. */
  entrypoint: relativePath.default("src/index.ts").describe("Entry file of a new package, relative to its root."),
  /**
   * devDependencies every generated package gets, on top of the ones inferred
   * from the moved code (`{ "typescript": "catalog:" }`). Inferred entries win.
   */
  devDependencies: z
    .record(z.string().min(1), z.string().min(1))
    .prefault({})
    .describe("devDependencies added to every generated package; inferred entries win."),
  /** Extra dev dependencies keyed by an inferred runtime or dev dependency. */
  devDependenciesByDependency: z
    .record(z.string().min(1), z.record(z.string().min(1), z.string().min(1)))
    .prefault({})
    .describe("Extra devDependencies keyed by an inferred runtime or dev dependency."),
  /**
   * Statement template appended to the generated entrypoint barrel for each
   * moved production file. `{specifier}` is the package-relative specifier.
   */
  barrelExport: z
    .string()
    .min(1)
    .default('export * from "./{specifier}";')
    .describe("Statement template appended to the entrypoint barrel for each moved production file."),
  /**
   * How the barrel writes a moved file's specifier. NodeNext resolution needs
   * the real extension (`./chart.ts`); bundler-style resolution conventionally
   * omits it; `js` is for packages that publish compiled output.
   */
  barrelSpecifier: z
    .enum(["extension", "extensionless", "js"])
    .default("extension")
    .describe("How barrel specifiers are written: real extension, extensionless, or `.js`."),
  /** Root-barrel-only (legacy) or module-preserving public subpaths with an inert entrypoint. */
  publicSurface: publicSurface.describe("Package public surface: a root barrel or module-preserving subpaths."),
});

/** Templates for the files scaffolded into a new workspace package (package.json, tsconfig, task file, extras). */
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
const extractionProfile = z.strictObject({
  /** Library profiles publish a barrel; leaf-test profiles are private test packages. */
  kind: z.enum(["library", "leaf-test"]).default("library").describe("Package kind: a barrel-publishing library or a private leaf test package."),
  /** One of `packageRoots`; generated packages are direct children of it. */
  destinationRoot: relativePath.describe("One of `packageRoots`; generated packages are its direct children."),
  /** Direct-child directory, rendered with `{name}`, `{app}`, and `{profile}`. */
  directoryTemplate: z.string().min(1).default("{name}").describe("Package directory template using `{name}`, `{app}`, and `{profile}`."),
  /** Package name, rendered with `{scope}`, `{name}`, `{app}`, and `{profile}`. */
  packageNameTemplate: z.string().min(1).default("{scope}{name}").describe("Package name template using `{scope}`, `{name}`, `{app}`, and `{profile}`."),
  /** Optional task-runner project id template, rendered with the same variables plus `{package}`. */
  projectIdTemplate: z.string().min(1).optional().describe("Optional task-runner project id template; also receives `{package}`."),
  /** Profile-level scaffold overrides, applied after the application's overrides. */
  scaffoldTemplates: scaffoldTemplateOverrides.optional().describe("Profile-level scaffold overrides, applied after the application's overrides."),
  /** Profile-level command templates; omitted tiers inherit the workspace gates. */
  gates: z
    .strictObject({
      package: z.array(z.string().min(1)).optional().describe("Package-tier gate commands for this profile."),
      project: z.array(z.string().min(1)).optional().describe("Project-tier gate commands for this profile."),
      workspace: z.array(z.string().min(1)).optional().describe("Workspace-tier gate commands for this profile."),
    })
    .optional()
    .describe("Profile-level gate commands; omitted tiers inherit the workspace `gates`."),
});

export const extractionProfiles = z
  .strictObject({
    /** The profile used when a caller does not request one. Omit to keep legacy behavior. */
    default: z.string().min(1).optional().describe("Profile used when a caller does not request one."),
    profiles: z
      .record(z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "must be a lowercase kebab-case identifier"), extractionProfile)
      .default({})
      .describe("Named extraction profiles keyed by kebab-case name."),
  })
  .prefault({});

/** A named package-kind profile: destination root, naming templates, scaffold and gate overrides. */
export type ExtractionProfileConfig = z.output<typeof extractionProfile>;

/** An extraction profile with every default resolved; the legacy synthetic profile when none is selected. */
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

/** Concrete package name, root, and project id rendered from a resolved profile. */
export interface RenderedExtractionProfile {
  readonly packageName: string;
  readonly packageRoot: string;
  readonly projectId: string | undefined;
}
