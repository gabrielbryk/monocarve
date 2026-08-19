/** Target package scaffold operations, decomposed by the file they may change. */

import { resolve } from "node:path";
import ts from "typescript";

import type { AdapterEditResult } from "../adapters/types.ts";
import { hashText } from "../util/hash.ts";
import { relativePosix } from "../util/paths.ts";
import { renderTemplate } from "../util/template.ts";
import { PlanningError } from "./context.ts";
import type { PlanOperation } from "./manifest.ts";
import { barrelSpecifier, type ScaffoldInput } from "./scaffold.ts";
import { sourceExportsFromFile } from "./public-surface.ts";
import { parseJsonFile, render, stringifyJson, templateVars, templatesFor, writeOperation } from "./scaffold-shared.ts";

/** Operations creating (or extending) the target package. */
export function packageOperations(input: ScaffoldInput): PlanOperation[] {
  const templates = templatesFor(input);
  const scaffolding = !input.context.exists(`${input.packageRoot}/package.json`);
  const packageManifest = packageManifestOperation(input, scaffolding);
  const operations = [
    packageManifest,
    entrypointOperation(input, templates, scaffolding),
    ...tsconfigOperations(input, templates),
    taskFileOperation(input, templates, scaffolding),
    knipWorkspaceOperation(input, scaffolding),
    ...extraFileOperations(input, templates),
  ].filter((operation): operation is PlanOperation => operation !== undefined);
  const projected = packageManifest?.kind === "write-file"
    ? parseJsonFile(packageManifest.contents, packageManifest.path)
    : parseJsonFile(input.context.text(`${input.packageRoot}/package.json`), `${input.packageRoot}/package.json`);
  const importer = lockfileImporterOperation(input, record(projected.dependencies), record(projected.devDependencies), scaffolding);
  if (!scaffolding) return [...operations, ...(importer ? [importer] : [])];
  return [...operations, ...registrationOperations(input), importer].filter(
    (operation): operation is PlanOperation => operation !== undefined,
  );
}

/** Register a newly scaffolded package with Knip when the repository uses its
 * explicit workspace-map form. Without this, Knip attributes every declared
 * dependency in the new package to no project and the dead-code ratchet fails
 * despite a correct extraction. Repositories without a root knip map remain
 * untouched.
 */
function knipWorkspaceOperation(input: ScaffoldInput, scaffolding: boolean): PlanOperation | undefined {
  if (!scaffolding || !input.context.exists("knip.jsonc")) return undefined;
  const path = "knip.jsonc";
  const current = input.context.text(path);
  const key = `"${input.packageRoot}"`;
  if (current.includes(`${key}:`)) return undefined;
  const marker = '"workspaces": {';
  const offset = current.indexOf(marker);
  if (offset < 0) return undefined;
  const implicitDependencies = implicitKnipDependencies(input);
  const entry = [
    `    ${key}: {`,
    '      "entry": ["src/**/*.{ts,tsx}"],',
    '      "project": ["src/**/*.{ts,tsx}"],',
    '      "ignore": ["dist/**", "coverage/**"],',
    ...(implicitDependencies.length === 0
      ? []
      : [
        "      // React's automatic JSX runtime is emitted by the compiler, not imported by source.",
        `      "ignoreDependencies": [${implicitDependencies.map((dependency) => JSON.stringify(dependency)).join(", ")}],`,
      ]),
    '      "ignoreExportsUsedInFile": true,',
    '      "includeEntryExports": false',
    "    },",
  ].join("\n");
  const insert = offset + marker.length;
  const next = `${current.slice(0, insert)}\n${entry}${current.slice(insert)}`;
  return writeOperation(input.context, path, next, "scaffold:knip-workspace");
}

/** Dependencies that the TypeScript JSX transform consumes without a source import. */
function implicitKnipDependencies(input: ScaffoldInput): string[] {
  const hasReactJsx = input.application.compilerProfile.jsx
    && input.production.some((source) => source.endsWith(".tsx"))
    && input.config.portfolio.frameworkPackages.includes("react")
    && input.dependencies.runtime.react !== undefined;
  if (!hasReactJsx) return [];
  return ["react", "@types/react", "@types/react-dom"];
}

function packageManifestOperation(input: ScaffoldInput, scaffolding: boolean): PlanOperation | undefined {
  const packageFile = `${input.packageRoot}/package.json`;
  const templates = templatesFor(input);
  const current = scaffolding ? render(input, templates.packageJson) : input.context.text(packageFile);
  const manifest = parseJsonFile(current, packageFile);
  const sideEffects = assetSideEffects(input, manifest.sideEffects);
  const dependencies = { ...record(manifest.dependencies), ...input.dependencies.runtime };
  const devDependencies = Object.fromEntries(Object.entries({
    ...record(manifest.devDependencies), ...templateDevDependencies(input, templates, scaffolding),
  }).filter(([name]) => dependencies[name] === undefined));
  const nextManifest = stringifyJson({
    ...manifest,
    ...(sideEffects === undefined ? {} : { sideEffects }),
    ...publicExports(input, manifest.exports, packageFile),
    dependencies,
    devDependencies,
  });
  return scaffolding || nextManifest !== input.context.text(packageFile)
    ? writeOperation(input.context, packageFile, nextManifest, "scaffold:package-json")
    : undefined;
}

function assetSideEffects(input: ScaffoldInput, declared: unknown): unknown {
  if (declared !== false || !input.assets?.length) return declared;
  const extensions = [...new Set(input.assets.flatMap((path) =>
    input.config.assetExtensions.filter((extension) => path.endsWith(extension)),
  ))].sort();
  return extensions.length === 0 ? declared : extensions.map((extension) => `**/*${extension}`);
}

function publicExports(input: ScaffoldInput, exports: unknown, packageFile: string): Record<string, unknown> {
  if (!input.publicModules?.length) return {};
  const next = { ...packageExportsMap(exports, packageFile) };
  for (const module of input.publicModules) {
    const existing = next[module.exportKey];
    if (existing !== undefined && !exportTargetMatches(existing, module.exportTarget)) {
      throw new PlanningError(`${packageFile} export ${module.exportKey} already targets ${JSON.stringify(existing)}, not ${JSON.stringify(module.exportTarget)}`);
    }
    if (existing === undefined) next[module.exportKey] = module.exportTarget;
  }
  return { exports: next };
}

/** A conditional export is equivalent when every selectable leaf reaches the
 * same reviewed module. Preserve that repository-owned condition map instead
 * of flattening it to the shorthand string form. */
function exportTargetMatches(value: unknown, target: string): boolean {
  if (typeof value === "string") return value === target;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const leaves = Object.values(value as Record<string, unknown>);
  return leaves.length > 0 && leaves.every((leaf) => exportTargetMatches(leaf, target));
}

function packageExportsMap(value: unknown, packageFile: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) return { ".": value };
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  const subpaths = keys.filter((key) => key.startsWith("."));
  if (subpaths.length === 0) return keys.length === 0 ? {} : { ".": record };
  if (subpaths.length === keys.length) return record;
  throw new PlanningError(`${packageFile} exports cannot mix package subpaths and root conditions`);
}

function record(value: unknown): Record<string, string> {
  return (value ?? {}) as Record<string, string>;
}

function templateDevDependencies(input: ScaffoldInput, templates: ReturnType<typeof templatesFor>, scaffolding = true): Record<string, string> {
  if (!scaffolding) return input.dependencies.dev;
  const inferred = { ...input.dependencies.runtime, ...input.dependencies.dev };
  const conditional = Object.fromEntries(
    Object.entries(templates.devDependenciesByDependency)
      .filter(([dependency]) => inferred[dependency] !== undefined)
      .flatMap(([, additions]) => Object.entries(additions)),
  );
  return { ...templates.devDependencies, ...conditional, ...input.dependencies.dev };
}

function entrypointOperation(input: ScaffoldInput, templates: ReturnType<typeof templatesFor>, scaffolding: boolean): PlanOperation | undefined {
  const path = `${input.packageRoot}/${templates.entrypoint}`;
  const entrypointOwners = input.publicModules?.filter((module) => module.target === path) ?? [];
  if (entrypointOwners.length > 1) {
    throw new PlanningError(`multiple production modules claim package entrypoint ${path}: ${entrypointOwners.map((module) => module.source).join(", ")}`);
  }
  // A selected production module is the sole owner of this output. In
  // particular, an index module promotion moves its source directly here, so
  // emitting the otherwise useful empty new-package scaffold would create a
  // second mutation with a false "missing" precondition.
  if (entrypointOwners.length === 1) return undefined;
  if (templates.publicSurface.mode === "subpaths") {
    if (!scaffolding || input.context.exists(path)) return undefined;
    return writeOperation(input.context, path, "", "scaffold:entrypoint");
  }
  const barrel = input.context.exists(path) ? input.context.text(path) : "";
  if (input.production.length > 1 || (barrel && !scaffolding)) assertNoBarrelExportCollisions(input, path);
  const missing = input.production.map((source) => renderTemplate(templates.barrelExport, {
    ...templateVars(input, templates), specifier: barrelSpecifier(templates, input.context.targetRelativePath(source)),
  })).flatMap((line, index) => {
    const source = input.production[index]!;
    const specifier = barrelSpecifier(templates, input.context.targetRelativePath(source));
    const typeExports = sourceExportsFromFile(input.context.absolute(source), source).filter((entry) => entry.typeOnly);
    return [line, ...typeExports.map((entry) => `export type { ${entry.name} } from ${JSON.stringify(specifier)};`)]
      .filter((candidate) => !barrel.includes(candidate));
  });
  if (missing.length === 0 && (!scaffolding || input.context.exists(path))) return undefined;
  const separator = barrel && !barrel.endsWith("\n") ? "\n" : "";
  const contents = missing.length > 0 ? `${barrel}${separator}${missing.join("\n")}\n` : "";
  return writeOperation(input.context, path, contents, "scaffold:entrypoint");
}

/** Refuse an invalid package barrel instead of emitting ambiguous export-star
 * bindings when an existing package is extended by another generated module. */
function assertNoBarrelExportCollisions(input: ScaffoldInput, entrypoint: string): void {
  const existing = new Set(input.context.exists(entrypoint) ? sourceExportsFromFile(input.context.absolute(entrypoint), entrypoint).map((entry) => entry.name) : []);
  const collisions = new Set<string>();
  for (const source of input.production) {
    for (const entry of sourceExportsFromFile(input.context.absolute(source), source)) {
      if (existing.has(entry.name)) collisions.add(entry.name);
      existing.add(entry.name);
    }
  }
  if (collisions.size > 0) {
    throw new PlanningError(
      `cannot generate ${input.packageName} entrypoint ${entrypoint} with ambiguous export-star bindings: ${[...collisions].sort().join(", ")}; choose a separate package or configure an explicit export surface`,
    );
  }
}

function tsconfigOperations(input: ScaffoldInput, templates: ReturnType<typeof templatesFor>): PlanOperation[] {
  const target = templates.projectReferences.target;
  const references = projectReferences(input, templates);
  const root = target === "tsconfig.json" ? undefined : rootTsconfigOperation(input, templates, solutionReferences(input));
  const referenced = projectReferenceOperation(input, templates, target, references);
  return [root, referenced].filter((operation): operation is PlanOperation => operation !== undefined);
}

function solutionReferences(input: ScaffoldInput): { path: string }[] {
  return input.dependencies.packageReferences.flatMap((reference) => {
    const rootTarget = `${reference}/tsconfig.json`;
    if (input.context.exists(rootTarget) && !isBuildReferenceableTsconfig(input, rootTarget)) return [];
    return [{ path: relativePosix(resolve("/", input.packageRoot), resolve("/", reference)) }];
  });
}

function rootTsconfigOperation(input: ScaffoldInput, templates: ReturnType<typeof templatesFor>, references: readonly { path: string }[]): PlanOperation | undefined {
  const path = `${input.packageRoot}/tsconfig.json`;
  const exists = input.context.exists(path);
  if (!exists && !templates.tsconfig) return undefined;
  const current = exists ? input.context.text(path) : render(input, templates.tsconfig!);
  const rendered = parseJsonFile(current, path) as { references?: readonly { path?: string }[]; compilerOptions?: Record<string, unknown> };
  const existing = rendered.references ?? [];
  const merged = [...existing, ...references.filter((entry) => !existing.some((item) => item.path === entry.path))];
  const types = ambientCompilerTypes(input);
  const jsx = ambientCompilerOption(input, "jsx");
  const compilerOptions = types.length > 0 || (jsx !== undefined && rendered.compilerOptions?.jsx === undefined)
    ? {
      ...(rendered.compilerOptions ?? {}),
      ...(jsx !== undefined && rendered.compilerOptions?.jsx === undefined ? { jsx } : {}),
      ...(types.length > 0 ? { types: [...new Set([...(Array.isArray(rendered.compilerOptions?.types) ? rendered.compilerOptions.types : []), ...types])] } : {}),
    }
    : rendered.compilerOptions;
  const next = { ...rendered, ...(compilerOptions === undefined ? {} : { compilerOptions }), ...(merged.length > 0 ? { references: merged } : {}) };
  const contents = stringifyJson(next);
  return exists && contents === current ? undefined : writeOperation(input.context, path, contents, "scaffold:tsconfig");
}

function ambientCompilerTypes(input: ScaffoldInput): string[] {
  const configPath = resolve(input.context.rootDir, input.application.tsconfig);
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  const types = read.error === undefined ? read.config?.compilerOptions?.types : undefined;
  return Array.isArray(types) ? types.filter((type): type is string => typeof type === "string") : [];
}

function ambientCompilerOption(input: ScaffoldInput, name: string): unknown {
  const configPath = resolve(input.context.rootDir, input.application.tsconfig);
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  return read.error === undefined ? read.config?.compilerOptions?.[name] : undefined;
}

function projectReferences(input: ScaffoldInput, templates: ReturnType<typeof templatesFor>): { path: string }[] {
  return input.dependencies.packageReferences.flatMap((reference) => {
    const configuredTarget = templates.projectReferences.dependencyTarget;
    const configuredPath = configuredTarget === "tsconfig.json"
      ? `${reference}/tsconfig.json`
      : `${reference}/${configuredTarget}`;
    // A workspace can mix solution-style libraries with an exact-root package
    // whose production project is its root tsconfig. Prefer the configured
    // library target when it exists, but do not synthesize a nonexistent
    // tsconfig.lib.json for that exact-root dependency.
    let target: string;
    if (input.context.exists(configuredPath)) {
      target = configuredPath;
    } else if (input.context.exists(`${reference}/tsconfig.json`)) {
      const rootTarget = `${reference}/tsconfig.json`;
      // A non-composite root tsconfig describes editor/typecheck ownership, not
      // a project that `tsc --build` may reference. Keep the workspace package
      // dependency but omit an invalid project reference.
      if (!isBuildReferenceableTsconfig(input, rootTarget)) return [];
      target = rootTarget;
    } else {
      target = configuredTarget === "tsconfig.json" ? reference : configuredPath;
    }
    return [{ path: relativePosix(resolve("/", input.packageRoot), resolve("/", target)) }];
  });
}

function isBuildReferenceableTsconfig(input: ScaffoldInput, path: string): boolean {
  const config = parseJsonFile(input.context.text(path), path) as {
    compilerOptions?: { composite?: unknown };
    references?: unknown;
  };
  return config.compilerOptions?.composite === true || (Array.isArray(config.references) && config.references.length > 0);
}

function projectReferenceOperation(
  input: ScaffoldInput,
  templates: ReturnType<typeof templatesFor>,
  target: string,
  references: readonly { path: string }[],
): PlanOperation | undefined {
  const path = `${input.packageRoot}/${target}`;
  if (!input.context.exists(path)) {
    const template = referenceTemplate(templates, target);
    if (!template) return undefined;
    return initialTsconfigOperation(input, template, path, references);
  }
  const tsconfig = parseJsonFile(input.context.text(path), path);
  const existing = (tsconfig.references ?? []) as { path?: string }[];
  const missing = references.filter((entry) => !new Set(existing.map((item) => item.path)).has(entry.path));
  return missing.length > 0 ? writeOperation(input.context, path, stringifyJson({ ...tsconfig, references: [...existing, ...missing] }), "scaffold:project-references") : undefined;
}

function referenceTemplate(templates: ReturnType<typeof templatesFor>, target: string) {
  if (target === "tsconfig.json") return templates.tsconfig;
  const template = templates.extraFiles[target];
  if (!template) throw new PlanningError(`projectReferences.target ${JSON.stringify(target)} must name a configured scaffold extraFile`);
  return template;
}

function initialTsconfigOperation(input: ScaffoldInput, template: ReturnType<typeof referenceTemplate>, path: string, references: readonly { path: string }[]): PlanOperation {
  const rendered = parseJsonFile(render(input, template!), path);
  const types = ambientCompilerTypes(input);
  const jsx = ambientCompilerOption(input, "jsx");
  const existingOptions = (rendered.compilerOptions ?? {}) as Record<string, unknown>;
  const compilerOptions = types.length > 0 || (jsx !== undefined && existingOptions.jsx === undefined)
    ? {
      ...existingOptions,
      ...(jsx !== undefined && existingOptions.jsx === undefined ? { jsx } : {}),
      ...(types.length > 0 ? { types: [...new Set([...(Array.isArray(existingOptions.types) ? existingOptions.types : []), ...types])] } : {}),
    }
    : rendered.compilerOptions;
  const next = { ...rendered, ...(compilerOptions === undefined ? {} : { compilerOptions }), ...(references.length ? { references } : {}) };
  assertCompilerProfileRepresented(input, next, path);
  return writeOperation(input.context, path, stringifyJson(next), "scaffold:tsconfig");
}

function assertCompilerProfileRepresented(input: ScaffoldInput, rendered: Record<string, unknown>, path: string): void {
  if (!input.application.compilerProfile.jsx) return;
  const compilerOptions = rendered.compilerOptions;
  const jsx = compilerOptions && typeof compilerOptions === "object" && !Array.isArray(compilerOptions)
    ? (compilerOptions as Record<string, unknown>).jsx
    : undefined;
  // An extends chain is repository-owned and may provide the setting; the
  // package gate remains the proof in that case. With neither, failure is
  // certain and should be reported while the plan is compiled.
  if (jsx === undefined && rendered.extends === undefined) {
    throw new PlanningError(
      `${path} is scaffolded for application ${input.application.name}, whose compilerProfile requires JSX, ` +
      "but its configured tsconfig template has neither compilerOptions.jsx nor extends",
    );
  }
}

function taskFileOperation(input: ScaffoldInput, templates: ReturnType<typeof templatesFor>, scaffolding: boolean): PlanOperation | undefined {
  const name = input.taskRunner.projectFileName;
  const path = name ? `${input.packageRoot}/${name}` : undefined;
  return scaffolding && path && templates.taskFile && !input.context.exists(path)
    ? writeOperation(input.context, path, taskFileContents(input, templates), "scaffold:task-file") : undefined;
}

function taskFileContents(input: ScaffoldInput, templates: ReturnType<typeof templatesFor>): string {
  const taskFile = render(input, templates.taskFile!);
  // Moon appends task args to the inherited command. An empty unit-test
  // partition is a known property of this extraction, not permission to hide
  // future tests; the override is generated only for a brand-new Moon package
  // and must be removed when its first test travels in a later extraction.
  if (input.taskRunner.id !== "moon" || input.tests === undefined || input.tests.length > 0) return taskFile;
  const lines = taskFile.trimEnd().split("\n");
  const testIndex = lines.findIndex((line) => line.trim() === "test:");
  if (testIndex < 0) {
    const tasksIndex = lines.findIndex((line) => line.trim() === "tasks:");
    if (tasksIndex < 0) {
      return `${taskFile.trimEnd()}\n\n# Generated for a package with no travelling test files; remove when it gains one.\ntasks:\n  test:\n    args: [${emptySuiteArgument(input, templates)}]\n`;
    }
    lines.push("", "# Generated for a package with no travelling test files; remove when it gains one.", "  test:", `    args: [${emptySuiteArgument(input, templates)}]`);
    return `${lines.join("\n")}\n`;
  }
  const argsIndex = lines.findIndex((line, index) => index > testIndex && /^\s{4}args:/.test(line));
  if (argsIndex < 0) {
    throw new PlanningError("Moon task scaffold must declare a test task with args before applying an empty-test override");
  }
  lines[argsIndex] = `    args: [${emptySuiteArgument(input, templates)}]`;
  return `${lines.join("\n")}\n`;
}

/** The empty-suite flag is runner syntax, not Moon syntax. Infer it from the
 * configured scaffold so a backend Bun library and frontend Vitest library
 * both retain their inherited test task and its dependency graph. */
function emptySuiteArgument(input: ScaffoldInput, templates: ReturnType<typeof templatesFor>): string {
  const manifest = parseJsonFile(render(input, templates.packageJson), `${input.packageRoot}/package.json`);
  const candidate = (manifest.scripts as Record<string, unknown> | undefined)?.test;
  const script = typeof candidate === "string" ? candidate : "";
  if (/\bbun\s+test\b/.test(script)) return "--pass-with-no-tests";
  return "--passWithNoTests";
}

function extraFileOperations(input: ScaffoldInput, templates: ReturnType<typeof templatesFor>): PlanOperation[] {
  return Object.entries(templates.extraFiles).flatMap(([name, source]) => {
    if (name === templates.projectReferences.target) return [];
    const path = `${input.packageRoot}/${name}`;
    return input.context.exists(path) ? [] : [writeOperation(input.context, path, render(input, source), `scaffold:extra:${name}`)];
  });
}

function registrationOperations(input: ScaffoldInput): (PlanOperation | undefined)[] {
  return [workspaceMembershipOperation(input), projectRegistrationOperation(input)];
}

function workspaceMembershipOperation(input: ScaffoldInput): PlanOperation | undefined {
  const path = input.packageManager.workspaceManifestName;
  if (!path) return undefined;
  if (!input.context.exists(path)) throw new PlanningError(`${path} is required to register ${input.packageRoot} as a workspace package`);
  return requiredEditOperation(input, path, input.packageManager.workspaceManifestEdit(input.context.text(path), input.packageRoot), "scaffold:workspace-membership");
}

function projectRegistrationOperation(input: ScaffoldInput): PlanOperation | undefined {
  const path = input.taskRunner.projectRegistryFileName;
  if (!path) return undefined;
  if (!input.context.exists(path)) throw new PlanningError(`${path} is required to register project ${input.projectId}`);
  return requiredEditOperation(input, path, input.taskRunner.registerProject(input.context.text(path), input.packageRoot, input.projectId), "scaffold:project-registration");
}

function requiredEditOperation(input: ScaffoldInput, path: string, outcome: AdapterEditResult, generator: string): PlanOperation | undefined {
  if (outcome.kind === "already-satisfied") return undefined;
  if (outcome.kind === "unmet-precondition") throw new PlanningError(`${generator} cannot update ${path}: ${outcome.reason}`);
  if (outcome.contents === input.context.text(path)) throw new PlanningError(`${generator} reported a change to ${path} without changing its contents`);
  return writeOperation(input.context, path, outcome.contents, generator);
}

function lockfileImporterOperation(input: ScaffoldInput, dependencies: Readonly<Record<string, string>>, devDependencies: Readonly<Record<string, string>>, scaffolding: boolean): PlanOperation | undefined {
  if (!scaffolding && Object.keys(input.dependencies.runtime).length === 0 && Object.keys(input.dependencies.dev).length === 0) return undefined;
  const lockfile = input.packageManager.lockfileName;
  if (!input.context.exists(lockfile)) throw new PlanningError(`${lockfile} is required to add an importer for ${input.packageRoot}`);
  const current = input.context.text(lockfile);
  const existing = input.packageManager.importerBlock(current, input.packageRoot);
  if (!scaffolding) {
    if (existing === undefined) throw new PlanningError(`${lockfile} has no importer entry for existing package ${input.packageRoot}; the lockfile is out of date with the workspace`);
    const block = input.packageManager.addBlockDependencies(existing, {
      packageRoot: input.packageRoot,
      dependencies,
      devDependencies,
      lockfileText: current,
      workspaceRoots: workspaceRootsFor(input),
    });
    if (block === existing) return undefined;
    return { kind: "lockfile-importer", lockfile, packageRoot: input.packageRoot, block, mode: "replace", preconditionHash: hashText(current), resultHash: hashText(input.packageManager.replaceImporter(current, input.packageRoot, block)) };
  }
  if (existing !== undefined) throw new PlanningError(`${lockfile} already has an importer for ${input.packageRoot}, but ${input.packageRoot}/package.json is absent`);
  const workspaceRoots = workspaceRootsFor(input);
  const block = `${input.packageManager.renderImporterBlock({ packageRoot: input.packageRoot, dependencies, devDependencies, lockfileText: current, workspaceRoots })}\n\n`;
  return { kind: "lockfile-importer", lockfile, packageRoot: input.packageRoot, block, mode: "insert", preconditionHash: hashText(current), resultHash: hashText(input.packageManager.insertImporter(current, input.packageRoot, block)) };
}

function workspaceRootsFor(input: ScaffoldInput): Record<string, string> {
  const roots = Object.fromEntries(input.dependencies.packageReferences.flatMap((owner) => {
    const name = input.context.manifest(owner).name;
    return name ? [[name, owner]] : [];
  }));
  return { ...roots, ...input.workspaceDependencyRoots };
}
