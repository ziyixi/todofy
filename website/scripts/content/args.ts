import { ContentError } from "../../src/lib/content/errors";

export interface CliArguments {
  values: Map<string, string>;
  flags: Set<string>;
}

export function parseCliArguments(argv: string[]): CliArguments {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (const argument of argv) {
    if (!argument.startsWith("--")) {
      throw new ContentError("INVALID_ARGUMENT", `Unexpected positional argument: ${argument}`);
    }
    const separator = argument.indexOf("=");
    if (separator === -1) {
      flags.add(argument.slice(2));
      continue;
    }
    const key = argument.slice(2, separator);
    const value = argument.slice(separator + 1);
    if (!key || !value) {
      throw new ContentError("INVALID_ARGUMENT", `Malformed argument: ${argument}`);
    }
    values.set(key, value);
  }
  return { values, flags };
}

export function assertKnownArguments(
  args: CliArguments,
  knownValues: string[],
  knownFlags: string[],
): void {
  for (const key of args.values.keys()) {
    if (!knownValues.includes(key)) {
      throw new ContentError("UNKNOWN_ARGUMENT", `Unknown argument: --${key}`);
    }
  }
  for (const key of args.flags) {
    if (!knownFlags.includes(key)) {
      throw new ContentError("UNKNOWN_ARGUMENT", `Unknown flag: --${key}`);
    }
  }
}
