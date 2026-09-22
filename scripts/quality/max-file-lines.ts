import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

import {
  baselinePath,
  judge,
  readBaseline,
  report,
  reportBaselineUpdate,
  summarizeBaselineUpdate,
  writeBaseline,
  type BaselinedFinding,
} from "./baseline.ts";

export interface LineViolation {
  readonly path: string;
  readonly lines: number;
  readonly limit: number;
}

const EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"];

export function findLineViolations(rootDir: string, targets: readonly string[], limit: number): LineViolation[] {
  return targets.flatMap((target) => files(resolve(rootDir, target)))
    .map((path) => ({ path, lines: lineCount(readFileSync(path, "utf8")), limit }))
    .filter((entry) => entry.lines > limit)
    .map((entry) => ({ ...entry, path: entry.path.slice(resolve(rootDir).length + 1).replaceAll("\\", "/") }))
    .sort((left, right) => right.lines - left.lines || left.path.localeCompare(right.path));
}

function files(path: string): string[] {
  const state = statSync(path);
  if (state.isFile()) return EXTENSIONS.some((extension) => path.endsWith(extension)) ? [path] : [];
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules" || entry.name === ".git") return [];
    return files(resolve(path, entry.name));
  });
}

function lineCount(text: string): number {
  if (text.length === 0) return 0;
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

if (import.meta.main) {
  const rootDir = process.cwd();
  const argv = process.argv.slice(2);
  const updating = argv.includes("--update-baseline");
  const targets = argv.filter((arg) => !arg.startsWith("--"));
  const limit = Number(process.env.MAX_FILE_LINES ?? "500");
  const findings: BaselinedFinding[] = findLineViolations(rootDir, targets.length > 0 ? targets : ["src", "test", "scripts"], limit)
    .map((entry) => ({ path: entry.path, metric: "lines", actual: entry.lines, detail: `${entry.lines} lines (limit ${entry.limit})` }));
  const file = baselinePath(rootDir, "max-file-lines");
  if (updating) {
    const summary = summarizeBaselineUpdate(findings, readBaseline(file));
    reportBaselineUpdate("max-file-lines", summary, (text) => process.stderr.write(text));
    writeBaseline(file, findings);
    process.stderr.write(`max-file-lines: baseline rewritten with ${findings.length} measurement(s)\n`);
  } else {
    process.exitCode = report("max-file-lines", judge(findings, readBaseline(file)), (text) => process.stderr.write(text));
  }
}
