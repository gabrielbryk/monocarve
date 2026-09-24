/**
 * Consumer discovery: who imports the code that is about to move.
 *
 * A missed consumer is the failure mode this whole tool exists to prevent — the
 * one file left pointing at a path that still happens to resolve, found weeks
 * later. So discovery is exhaustive over first-party sources and driven by
 * resolved paths rather than by string matching on specifiers.
 */

import type { ConsumerDependencySection } from "../adapters/types.ts";
import { applicationOwner } from "../config/helpers.ts";
import { byCodeUnit } from "../util/hash.ts";
import { PlanningError, type WorkspaceContext } from "./context.ts";
export { partitionTests } from "./test-relocation.ts";

export interface Consumer {
  /** Owning directory of the consuming file. */
  readonly package: string;
  /** The consuming file, workspace-relative. */
  readonly file: string;
  /** A specifier it currently uses to reach the closure, for the audit to check. */
  readonly expectedImporter: string;
  /**
   * Every distinct specifier this file uses to reach the closure, in declaration
   * order. A consumer that imports two donor modules names two specifiers, and
   * the plan repoints both — so both belong here, or the manifest under-reports
   * the edit it performs and validation only ever sees the first one.
   */
  readonly rewrites: readonly { readonly from: string; readonly to: string; readonly donor: string }[];
  /** Donor files this consumer reaches, workspace-relative. */
  readonly donors: readonly string[];
  /**
   * The package.json section that must reference the extracted package.
   * Production consumers default to runtime; a later test-retention stage can
   * mark retained tests as dev without changing the wiring protocol.
   */
  readonly dependencySection: ConsumerDependencySection;
}

/** One owner and the strongest dependency section required by its consumers. */
export interface ConsumerDependencyOwner {
  readonly owner: string;
  readonly dependencySection: ConsumerDependencySection;
}

export interface TestRelocationPartition {
  /** Tests that can move without reaching outside the package closure. */
  readonly travelling: readonly string[];
  /** Tests left in their owner and rewired as dev-only package consumers. */
  readonly retained: readonly string[];
}

/**
 * Every file outside `donors` that imports one of them.
 *
 * Consumer membership is established only by a resolved, statically rewritable
 * reference to a donor. A separate computed reference in the same file does not
 * make that proven edge ambiguous: the journal rewrites the exact declaration
 * span below and audit replays that same splice against the baseline blob.
 *
 * Computed references remain fail-closed in files that move (see the portfolio
 * assessment). They are not guessed into this index: a consumer reachable only
 * through `import(variable)` has no resolved donor edge and is therefore never
 * silently treated as rewritable.
 */
export function findConsumers(
  context: WorkspaceContext,
  donors: readonly string[],
  packageName: string,
  publicSpecifierFor: ReadonlyMap<string, string> = new Map(),
  includeDonorFiles = false,
): Consumer[] {
  const absoluteDonors = donors.map((donor) => context.absolute(donor));
  const donorSet = new Set(donors);
  const index = context.consumerIndex();
  const candidates = [...new Set(absoluteDonors.flatMap((donor) => index.get(donor) ?? []))].filter((file) => includeDonorFiles || !donorSet.has(file));

  return (
    candidates
      .flatMap((file): Consumer[] => {
        const references = context
          .moduleReferences(file)
          .filter((reference) => reference.specifier && reference.resolved && absoluteDonors.includes(reference.resolved));
        if (references.length === 0) return [];
        // Insertion-ordered, so `expectedImporter` stays the first specifier the
        // file declares and the rewrite list reads in source order.
        const specifiers = [...new Set(references.map((reference) => reference.specifier!))];
        const from = specifiers[0]!;
        const donorsForFile = [
          ...new Set(
            references
              .map((reference) => absoluteDonors.find((donor) => donor === reference.resolved))
              .filter((donor): donor is string => donor !== undefined)
              .map((donor) => context.relative(donor)),
          ),
        ];
        return [
          {
            package: context.ownerOf(file),
            file,
            expectedImporter: from,
            rewrites: specifiers.map((specifier) => {
              const reference = references.find((entry) => entry.specifier === specifier)!;
              const donor = absoluteDonors.find((entry) => entry === reference.resolved);
              const relativeDonor = donor === undefined ? undefined : context.relative(donor);
              if (relativeDonor === undefined) {
                throw new PlanningError(`resolved consumer edge ${file} -> ${specifier} has no selected donor identity`);
              }
              const publicSpecifier = relativeDonor === undefined ? undefined : publicSpecifierFor.get(relativeDonor);
              const resourceSuffix =
                relativeDonor !== undefined && context.config.assetExtensions.some((extension) => relativeDonor.endsWith(extension))
                  ? (specifier.match(/[?#].*$/u)?.[0] ?? "")
                  : "";
              return {
                from: specifier,
                to: publicSpecifier === undefined ? packageName : `${publicSpecifier}${resourceSuffix}`,
                // A resolved consumer edge always has a known donor. Keep that
                // identity even when its public destination is the package root:
                // one consumer can legitimately target a mix of root and
                // subpath exports, and journal replay must never have to combine
                // the old one-target representation with donor-specific edits.
                donor: relativeDonor,
              };
            }),
            donors: donorsForFile,
            dependencySection: "runtime",
          },
        ];
      })
      // This order is the manifest's bytes, so it is by code unit, never by locale.
      .toSorted((left, right) => byCodeUnit(left.file, right.file))
  );
}

/**
 * Collapse file-level consumers to the package edits they require. Runtime
 * wins deliberately: an owner with both production and retained-test imports
 * must not hide a production dependency in devDependencies. Sorting makes the
 * resulting operations and lockfile splice independent of graph traversal.
 */
export function consumerDependencyOwners(consumers: readonly Consumer[]): ConsumerDependencyOwner[] {
  const sections = new Map<string, ConsumerDependencySection>();
  for (const consumer of consumers) {
    const previous = sections.get(consumer.package);
    if (previous === "runtime" || consumer.dependencySection === "runtime") {
      sections.set(consumer.package, "runtime");
    } else {
      sections.set(consumer.package, "dev");
    }
  }
  return [...sections].map(([owner, dependencySection]) => ({ owner, dependencySection })).toSorted((left, right) => byCodeUnit(left.owner, right.owner));
}

/** Applications among a consumer set — the projects whose gates must be run. */
export function consumerApplications(context: WorkspaceContext, consumers: readonly { readonly package: string }[]): string[] {
  const applications = new Set(context.config.applications.map(applicationOwner));
  return [...new Set(consumers.map((consumer) => consumer.package).filter((owner) => applications.has(owner)))].toSorted();
}
