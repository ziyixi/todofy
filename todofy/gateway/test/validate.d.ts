// Types of the dependency-free ops-v1 validator (contracts/ops-v1/validate.mjs, plain JavaScript).
declare module '*/contracts/ops-v1/validate.mjs' {
  /** Errors of `value` against `root.$defs[name]`; empty when it is valid. */
  export function validate(root: { $defs: Record<string, unknown> }, name: string, value: unknown): string[];
}
