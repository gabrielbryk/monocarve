import type { Sha256, FileState } from "../util/hash.ts";

export const PREPARER_MANIFEST_SCHEMA_VERSION = 1 as const;

export interface PreparerMutation {
  readonly path: string;
  readonly preconditionHash: FileState;
  readonly preconditionMode: number | "missing";
  readonly resultHash: Sha256;
  readonly resultMode: number;
  readonly contents: string;
}

/** A separately reviewable transaction compiled by running repository policy. */
export interface PreparerManifest {
  readonly schemaVersion: typeof PREPARER_MANIFEST_SCHEMA_VERSION;
  readonly planId: string;
  readonly createdAt: string;
  readonly baseline: { readonly commit: string; readonly configDigest: Sha256 };
  readonly bootstrapConfig?: PreparerMutation;
  readonly extractionPlanId: string;
  readonly preparer: {
    readonly id: string;
    readonly phase: "pre-extraction";
    readonly command?: string;
    readonly replacements?: readonly {
      readonly path: string;
      readonly before: string;
      readonly after: string;
      readonly prefix?: string;
      readonly suffix?: string;
    }[];
    readonly creates?: readonly {
      readonly path: string;
      readonly contents: string;
      readonly mode: 0o644 | 0o755;
    }[];
    readonly verify?: string;
    readonly commit: { readonly subject: string; readonly body?: string };
  };
  readonly binding: {
    readonly application: string;
    readonly packageName: string;
    readonly packageRoot: string;
    readonly sourcePath: string;
    readonly targetPath: string;
  };
  readonly mutations: readonly PreparerMutation[];
  /** Config-bound generated artifacts invalidated by the preparer's effective source mutations. */
  readonly generatedArtifacts: readonly {
    readonly path: string;
    readonly source: string;
    readonly regenerate: string;
    readonly regenerateOnApply: true;
    readonly exemptReason?: string;
  }[];
  /** Config-bound generators run after the preparer journal and before verification. */
  readonly postJournalPreparers: readonly {
    readonly id: string;
    readonly command?: string;
    readonly outputs: readonly string[];
    readonly replacements?: readonly { readonly path: string; readonly before: string; readonly after: string; readonly prefix?: string; readonly suffix?: string }[];
    readonly creates?: readonly { readonly path: string; readonly contents: string; readonly mode: number }[];
    readonly emittedModuleSpecifiers: readonly { readonly source: string; readonly resolutionBase: string }[];
    readonly verify?: string;
  }[];
  /** Effective preparer mutations which select generation triggers. */
  readonly triggerPaths: readonly string[];
  /** Exact sorted union of preparer and generated output paths. */
  readonly changedFiles: readonly string[];
}
