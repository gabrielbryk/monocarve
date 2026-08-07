import { z } from "zod";

import { ConfigError } from "../errors.ts";
import { renderTemplate, templatePlaceholders } from "../util/template.ts";
import type { ApplicationConfig, RenderedExtractionProfile, ResolvedExtractionProfile, ScaffoldTemplatesConfig } from "./schema-core.ts";
import type { MonocarveConfig } from "./schema.ts";
import type { ScaffoldTemplateOverrides } from "./primitives.ts";
import { packageNameMatcher } from "./helpers.ts";

export function scaffoldFor(config: MonocarveConfig, app: ApplicationConfig): ScaffoldTemplatesConfig {
  const override = app.scaffoldTemplates;
  if (!override) return config.scaffoldTemplates;
  return {
    ...config.scaffoldTemplates,
    ...(override.packageJson ? { packageJson: override.packageJson } : {}),
    ...(override.tsconfig ? { tsconfig: override.tsconfig } : {}),
    ...(override.taskFile ? { taskFile: override.taskFile } : {}),
    ...(override.extraFiles ? { extraFiles: override.extraFiles } : {}),
    ...(override.projectReferences ? { projectReferences: override.projectReferences } : {}),
    ...(override.devDependencies ? { devDependencies: override.devDependencies } : {}),
    ...(override.devDependenciesByDependency ? { devDependenciesByDependency: override.devDependenciesByDependency } : {}),
    ...(override.publicSurface ? { publicSurface: override.publicSurface } : {}),
  };
}

/**
 * Resolve a package-kind profile for later planning stages. Absence is not a
 * special case downstream: it becomes a synthetic profile that reproduces the
 * pre-profile root, naming, scaffold, and gate behavior exactly.
 */
export function resolveExtractionProfile(
  config: MonocarveConfig,
  app: ApplicationConfig,
  requested?: string,
): ResolvedExtractionProfile {
  const name = requested ?? config.extractionProfiles.default;
  if (name === undefined) {
    return {
      name: undefined,
      kind: "library",
      destinationRoot: config.packageRoots[0]!,
      directoryTemplate: "{name}",
      packageNameTemplate: "{scope}{name}",
      projectIdTemplate: undefined,
      scaffoldTemplates: scaffoldFor(config, app),
      gates: config.gates,
    };
  }

  const profile = config.extractionProfiles.profiles[name];
  if (!profile) {
    const known = Object.keys(config.extractionProfiles.profiles).sort().join(", ") || "(none)";
    throw new ConfigError(`unknown extraction profile ${JSON.stringify(name)}; configured: ${known}`);
  }

  return {
    name,
    kind: profile.kind,
    destinationRoot: profile.destinationRoot,
    directoryTemplate: profile.directoryTemplate,
    packageNameTemplate: profile.packageNameTemplate,
    projectIdTemplate: profile.projectIdTemplate,
    // An application is the narrowest workspace context, so its explicit
    // override wins: root baseline < package-kind profile < application.
    scaffoldTemplates: mergeScaffoldTemplates(
      mergeScaffoldTemplates(config.scaffoldTemplates, profile.scaffoldTemplates),
      app.scaffoldTemplates,
    ),
    gates: {
      ...config.gates,
      ...(profile.gates?.package === undefined ? {} : { package: profile.gates.package }),
      ...(profile.gates?.project === undefined ? {} : { project: profile.gates.project }),
      ...(profile.gates?.workspace === undefined ? {} : { workspace: profile.gates.workspace }),
    },
  };
}

/**
 * Render a resolved profile at the candidate-name boundary. Config validation
 * can prove a template is structurally sound, but only this boundary sees the
 * actual requested name and can reject a slash, traversal, or invalid package
 * name before a planner turns it into paths.
 */
export function renderExtractionProfile(
  config: MonocarveConfig,
  app: ApplicationConfig,
  profile: ResolvedExtractionProfile,
  name: string,
): RenderedExtractionProfile {
  const base = profileTemplateVars(config, app, profile.name, name);
  const directory = renderTemplate(profile.directoryTemplate, base);
  if (!isDirectChildDirectory(directory)) {
    throw new ConfigError(`extraction profile directory must render one direct-child directory: ${JSON.stringify(directory)}`);
  }
  const packageName = renderTemplate(profile.packageNameTemplate, base);
  if (!packageNameMatcher(config).test(packageName)) {
    throw new ConfigError(`extraction profile package name does not match the configured pattern: ${JSON.stringify(packageName)}`);
  }
  const packageRoot = `${profile.destinationRoot}/${directory}`;
  const projectId =
    profile.projectIdTemplate === undefined
      ? undefined
      : renderTemplate(profile.projectIdTemplate, { ...base, package: packageName });
  if (projectId !== undefined && projectId.length === 0) {
    throw new ConfigError("extraction profile project id must not render empty");
  }
  return { packageName, packageRoot, projectId };
}

function mergeScaffoldTemplates(
  base: ScaffoldTemplatesConfig,
  override: ScaffoldTemplateOverrides | undefined,
): ScaffoldTemplatesConfig {
  if (!override) return base;
  return {
    ...base,
    ...(override.packageJson === undefined ? {} : { packageJson: override.packageJson }),
    ...(override.tsconfig === undefined ? {} : { tsconfig: override.tsconfig }),
    ...(override.taskFile === undefined ? {} : { taskFile: override.taskFile }),
    ...(override.extraFiles === undefined ? {} : { extraFiles: override.extraFiles }),
    ...(override.projectReferences === undefined ? {} : { projectReferences: override.projectReferences }),
    ...(override.devDependencies === undefined ? {} : { devDependencies: override.devDependencies }),
    ...(override.devDependenciesByDependency === undefined ? {} : { devDependenciesByDependency: override.devDependenciesByDependency }),
    ...(override.publicSurface === undefined ? {} : { publicSurface: override.publicSurface }),
  };
}

const PROFILE_TEMPLATE_VARIABLES = ["app", "name", "package", "profile", "scope"] as const;

export function validateExtractionProfiles(config: MonocarveConfig, ctx: z.RefinementCtx): void {
  const configured = config.extractionProfiles;
  const profiles = configured.profiles;
  if (configured.default !== undefined && profiles[configured.default] === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["extractionProfiles", "default"],
      message: `must name a configured profile; configured: ${Object.keys(profiles).sort().join(", ") || "(none)"}`,
    });
  }

  for (const [name, profile] of Object.entries(profiles)) {
    const path = ["extractionProfiles", "profiles", name] as const;
    if (!config.packageRoots.includes(profile.destinationRoot)) {
      ctx.addIssue({
        code: "custom",
        path: [...path, "destinationRoot"],
        message: "must be one of packageRoots",
      });
    }

    for (const app of config.applications) {
      const vars = profileTemplateVars(config, app, name, "profile-candidate");
      validateProfileTemplate(ctx, [...path, "directoryTemplate"], profile.directoryTemplate, vars, ["app", "name", "profile"], (rendered) => {
        return isDirectChildDirectory(rendered)
          ? undefined
          : `must render one direct-child directory without traversal for application ${JSON.stringify(app.name)}`;
      });
      const packageTemplateValid = validateProfileTemplate(ctx, [...path, "packageNameTemplate"], profile.packageNameTemplate, vars, ["app", "name", "profile", "scope"], (rendered) => {
        return packageNameMatcher(config).test(rendered)
          ? undefined
          : `must render a name matching packageNamePattern for application ${JSON.stringify(app.name)} (${rendered})`;
      });
      if (profile.projectIdTemplate !== undefined && packageTemplateValid) {
        const packageName = renderTemplate(profile.packageNameTemplate, vars);
        validateProfileTemplate(ctx, [...path, "projectIdTemplate"], profile.projectIdTemplate, { ...vars, package: packageName }, PROFILE_TEMPLATE_VARIABLES, (rendered) => {
          return rendered.length > 0 ? undefined : `must render a non-empty project id for application ${JSON.stringify(app.name)}`;
        });
      }
    }
  }
}

function profileTemplateVars(
  config: MonocarveConfig,
  app: ApplicationConfig,
  profile: string | undefined,
  name: string,
): Readonly<Record<(typeof PROFILE_TEMPLATE_VARIABLES)[number], string>> {
  return {
    app: app.name,
    name,
    package: `${config.packageScope}${name}`,
    profile: profile ?? "legacy",
    scope: config.packageScope,
  };
}

function validateProfileTemplate(
  ctx: z.RefinementCtx,
  path: readonly (string | number)[],
  template: string,
  vars: Readonly<Record<(typeof PROFILE_TEMPLATE_VARIABLES)[number], string>>,
  allowed: readonly (typeof PROFILE_TEMPLATE_VARIABLES)[number][],
  check: (rendered: string) => string | undefined,
): boolean {
  const unknown = templatePlaceholders(template).filter((placeholder) => !allowed.includes(placeholder as never));
  if (unknown.length > 0) {
    ctx.addIssue({ code: "custom", path: [...path], message: `unknown profile template placeholder(s): ${unknown.join(", ")}` });
    return false;
  }
  const rendered = renderTemplate(template, vars);
  const message = check(rendered);
  if (message !== undefined) ctx.addIssue({ code: "custom", path: [...path], message });
  return message === undefined;
}

function isDirectChildDirectory(path: string): boolean {
  return path !== "" && path !== "." && path !== ".." && !path.includes("/") && !path.includes("\\");
}
