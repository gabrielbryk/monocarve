/** JSON parsing helpers shared by every reader of JSON documents. */

import { UsageError } from "../errors.ts";

/** A parsed JSON value that is an object: not null, not an array. */
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** `JSON.parse`, reporting a syntax error through the caller's error type. */
export function parseJson(text: string, onError: (reason: string) => Error): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw onError(error instanceof Error ? error.message : String(error));
  }
}

/** Parse a user-supplied JSON document that must be an object; failures are usage errors. */
export function parseJsonObject(text: string, path: string, label: string): Record<string, unknown> {
  const parsed = parseJson(text, (reason) => new UsageError(`could not parse ${label} ${path}: ${reason}`));
  if (!isJsonObject(parsed)) throw new UsageError(`${label} ${path} is not a JSON object`);
  return parsed;
}
