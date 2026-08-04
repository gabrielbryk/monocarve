import { dirname } from "node:path";
import ts from "typescript";

import { applicationFor, type MonocarveConfig } from "../config.ts";
import { workspacePath } from "../util/paths.ts";

/** Load the owning application's exact TypeScript resolution policy. */
export function preparationCompilerOptions(rootDir: string, config: MonocarveConfig, sourcePath: string): ts.CompilerOptions {
  const application = applicationFor(config, sourcePath);
  if (!application) throw new Error(`no configured application owns ${sourcePath}`);
  const configPath = workspacePath(rootDir, application.tsconfig);
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error) throw new Error(`cannot read TypeScript config ${application.tsconfig}`);
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(configPath), undefined, configPath);
  if (parsed.errors.some((item) => item.category === ts.DiagnosticCategory.Error)) {
    throw new Error(`cannot resolve TypeScript config ${application.tsconfig}`);
  }
  return parsed.options;
}
