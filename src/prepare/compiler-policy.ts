import { dirname } from "node:path";
import ts from "typescript";

import { applicationFor, type MonocarveConfig } from "../config.ts";
import { ConfigError } from "../errors.ts";
import { workspacePath } from "../util/paths.ts";

/** Load the owning application's exact TypeScript resolution policy. */
export function preparationCompilerOptions(rootDir: string, config: MonocarveConfig, sourcePath: string): ts.CompilerOptions {
  const application = applicationFor(config, sourcePath);
  if (!application) {
    throw new ConfigError(`no configured application owns ${sourcePath}`, {
      hint: "add an `applications` entry whose sourceRoot contains this path to the monocarve config",
    });
  }
  const configPath = workspacePath(rootDir, application.tsconfig);
  const read = ts.readConfigFile(configPath, (path) => ts.sys.readFile(path));
  if (read.error) {
    throw new ConfigError(`cannot read TypeScript config ${application.tsconfig}`, {
      hint: `check that ${application.tsconfig} exists and is valid JSON with comments`,
      cause: new Error(ts.flattenDiagnosticMessageText(read.error.messageText, "\n")),
    });
  }
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(configPath), undefined, configPath);
  const errors = parsed.errors.filter((item) => item.category === ts.DiagnosticCategory.Error);
  if (errors.length > 0) {
    throw new ConfigError(`cannot resolve TypeScript config ${application.tsconfig}`, {
      hint: `run \`tsc -p ${application.tsconfig} --showConfig\` to see the resolution errors`,
      cause: new Error(errors.map((item) => ts.flattenDiagnosticMessageText(item.messageText, "\n")).join("\n")),
    });
  }
  return parsed.options;
}
