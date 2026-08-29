/** The `packageManager` declaration carried by a root `package.json`. */

/**
 * `<name>@<version>` from the tracked bytes, or undefined when the field is
 * absent, unparseable, or names a different manager. Undefined is "no
 * unambiguous declaration", never "assume the running binary".
 */
export function declaredPackageManagerVersion(text: string, name: string): string | undefined {
  try {
    const value = (JSON.parse(text) as { packageManager?: unknown }).packageManager;
    if (typeof value !== "string" || !value.startsWith(`${name}@`)) return undefined;
    const version = value.slice(name.length + 1);
    return version === "" ? undefined : version;
  } catch {
    return undefined;
  }
}
