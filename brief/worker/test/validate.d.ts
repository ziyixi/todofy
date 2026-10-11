// Types of the dependency-free contract validator (contracts/ops-v1/validate.mjs, plain JavaScript), which
// also checks contracts/task-intent-v1.
declare module '*/contracts/ops-v1/validate.mjs' {
  /** Errors of `value` against `root.$defs[name]`; empty when it is valid. */
  export function validate(root: { $defs: Record<string, unknown> }, name: string, value: unknown): string[];
}
