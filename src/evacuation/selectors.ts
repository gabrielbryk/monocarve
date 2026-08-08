import { isAbsolute } from "node:path";

import { MonocarveError } from "../errors.ts";
import type { DependencyGraph } from "../graph/model.ts";
import { byCodeUnit } from "../util/hash.ts";
import { normalizePath } from "../util/paths.ts";

/** An evacuation selector is invalid or does not identify the requested application. */
export class EvacuationSelectorError extends MonocarveError {
  override readonly name = "EvacuationSelectorError";
}

/**
 * Resolve workspace-relative file, directory, and glob selectors against the
 * production dependency graph for exactly one application.
 *
 * `*` stays within one path segment; `**` may cross directory boundaries.
 * Tests and other files omitted from the production graph cannot be selected.
 */
export function resolveEvacuationSelectors(
  graph: DependencyGraph,
  application: string,
  selectors: readonly string[],
): string[] {
  if (selectors.length === 0) {
    throw new EvacuationSelectorError("evacuation requires at least one selector");
  }

  const normalized = [...new Set(selectors.map(normalizeSelector))].sort(byCodeUnit);
  const selected = new Set<string>();

  for (const selector of normalized) {
    const matches = graph.paths.filter((path) => matchesSelector(path, selector));
    if (matches.length === 0) {
      throw new EvacuationSelectorError(
        `evacuation selector ${JSON.stringify(selector)} matches no production graph nodes`,
      );
    }

    const outside = matches.filter((path) => {
      const node = graph.nodes.get(path);
      return node?.zone !== "application" || node.application !== application;
    });
    if (outside.length > 0) {
      throw new EvacuationSelectorError(
        `evacuation selector ${JSON.stringify(selector)} crosses application ${JSON.stringify(application)}: ${outside.join(", ")}`,
      );
    }

    for (const path of matches) selected.add(path);
  }

  return [...selected].sort(byCodeUnit);
}

function normalizeSelector(selector: string): string {
  if (isAbsolute(selector)) {
    throw new EvacuationSelectorError(`evacuation selector must be workspace-relative: ${selector}`);
  }
  const normalized = normalizePath(selector).replace(/\/+$/, "");
  if (!normalized || normalized.split("/").some((part) => part === ".." || part === "")) {
    throw new EvacuationSelectorError(`evacuation selector must be workspace-relative: ${selector}`);
  }
  return normalized;
}

function matchesSelector(path: string, selector: string): boolean {
  if (selector.includes("*")) return globPattern(selector).test(path);
  return path === selector || path.startsWith(`${selector}/`);
}

function globPattern(selector: string): RegExp {
  let source = "^";
  for (let index = 0; index < selector.length; index += 1) {
    const character = selector[index]!;
    if (character === "*" && selector[index + 1] === "*") {
      if (selector[index + 2] === "/") {
        source += "(?:.*/)?";
        index += 2;
      } else {
        source += ".*";
        index += 1;
      }
    } else if (character === "*") {
      source += "[^/]*";
    } else {
      source += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return new RegExp(`${source}$`);
}
