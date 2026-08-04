/** Compatibility entrypoint for lockfile shape fixtures. */

export * from "./lockfile-shape-harness.ts";
export { MIS_SORTED_SPLICE, ORACLE_BLIND_SPOT } from "./lockfile-shape-negatives.ts";

import { CORE_SHAPES } from "./lockfile-shape-cases.ts";
import { NEGATIVE_SHAPES } from "./lockfile-shape-negatives.ts";

export const SHAPES = [...CORE_SHAPES, ...NEGATIVE_SHAPES];
