/**
 * ops-v1: the rules of the contract the IDL cannot express (README.md "Versioning and bounds"). Everything else (the
 * methods, every message, enum and code list, every value rule: formats, allowed values, sizes, bounds) is in
 * proto/ops/v1/ops.proto, whose generated code each app uses (`@ziyixi/proto/ops/v1/ops_pb`, the wire JSON types of
 * `ops_wire.ts`, the bounds through `fieldRules`); ops-v1.schema.json is generated from it.
 *
 * What is left here is relative to a clock or to a whole message, so no codec can check it: each app checks it in its
 * own code. Dependency-free and erasable-only TypeScript, imported by relative path (the TypeScript Workers bundle
 * it); todofy-core's Python keeps the same numbers (todofy/worker/todofy/core/ops.py, which its tests compare with
 * this file).
 */
export const OPS_LIMITS = {
  /** setGuard: `until` at most this far ahead of the app's clock. */
  guardMaxAheadSeconds: 36 * 3600,
  /** Callers poll status() no more often than this (each call runs a few bounded D1 queries). */
  statusMinIntervalSeconds: 600,
} as const;
