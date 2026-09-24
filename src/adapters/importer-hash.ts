import { hashText, type Sha256 } from "../util/hash.ts";

/**
 * `lockfileImporterHash` for a text lockfile: the hash of one importer's block
 * as the adapter's own `importerBlock` extracts it, or undefined when absent.
 */
export function importerHasher(importerBlock: (text: string, root: string) => string | undefined): (text: string, root: string) => Sha256 | undefined {
  return (text, root) => {
    const block = importerBlock(text, root);
    return block === undefined ? undefined : hashText(block);
  };
}
