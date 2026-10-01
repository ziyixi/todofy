/**
 * google.protobuf.FieldMask in the wire JSON profile (proto/README.md) and the AIP-134 `update_mask` rule the
 * HTTP transcoder and client share.
 *
 * Wire form: one string of comma-separated paths, each a dotted path of proto field names (snake_case, as
 * every name in the profile), e.g. `"send_mode,author.display_name"`; `""` is a mask without paths. ProtoJSON
 * writes the same string with lowerCamelCase names; the profile keeps the names it uses everywhere else. A
 * path is `*` (AIP-161: every field) or matches PATH; nothing else reads or writes (the Python twin,
 * wire_json.py, applies the same rule).
 *
 * Update rule (AIP-134): an absent mask, an empty one and `*` replace every field the client may set; any
 * other mask replaces exactly the fields it names. `*` cannot be combined with other paths.
 */

/** One path: field names joined by dots. Map keys and list indices are not paths of this profile. */
const PATH = /^[a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)*$/;

export class FieldMaskError extends Error {}

function checkPaths(paths: readonly string[]): void {
  for (const path of paths) {
    if (path !== '*' && !PATH.test(path)) throw new FieldMaskError('a field mask path is malformed');
  }
}

/** The paths of a wire FieldMask string; throws FieldMaskError when a path is malformed. */
export function parseFieldMask(text: string): string[] {
  if (text === '') return [];
  const paths = text.split(',');
  checkPaths(paths);
  return paths;
}

/** The wire string of a FieldMask's paths; throws FieldMaskError when a path is malformed. */
export function formatFieldMask(paths: readonly string[]): string {
  checkPaths(paths);
  return paths.join(',');
}

/**
 * The fields an AIP-134 update replaces: '*' for all of them (no mask, no paths, or exactly `*`), else the
 * paths in the order given, duplicates removed. Throws FieldMaskError when `*` comes with other paths.
 */
export function updatePaths(mask: { readonly paths: readonly string[] } | undefined): '*' | readonly string[] {
  const paths = [...new Set(mask?.paths ?? [])];
  if (paths.length === 0) return '*';
  if (paths.includes('*')) {
    if (paths.length > 1) throw new FieldMaskError('`*` cannot be combined with other paths');
    return '*';
  }
  return paths;
}
