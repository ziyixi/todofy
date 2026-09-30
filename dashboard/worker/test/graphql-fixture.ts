/**
 * Synthetic GraphQL Analytics responses shaped like the verified query's answer (docs/design.md §7.2):
 * made-up database/namespace IDs and buckets (the script names are the public wrangler names of the
 * repo's Workers). Shared by the unit and workerd suites.
 */

/** One `workers` row: a script's day so far. CPU quantiles are microseconds (floats, as GraphQL sends them). */
export interface SyntheticScript {
  readonly script: string;
  readonly requests: number;
  readonly errors: number;
  readonly subrequests: number;
  readonly cpuP50?: number;
  readonly cpuP99?: number;
}

export interface SyntheticUsage {
  readonly workersRequests?: number;
  readonly d1RowsRead?: number;
  readonly d1RowsWritten?: number;
  readonly d1Sizes?: readonly number[];
  readonly doRequests?: number;
  /** Microseconds of Durable Object active time. */
  readonly doActiveTimeUs?: number;
  readonly doRowsRead?: number;
  readonly doRowsWritten?: number;
  /** Empty (the default) like the live account: do_storage has no data. */
  readonly doStoredBytes?: readonly number[];
  readonly r2Ops?: readonly { readonly actionType: string; readonly bucketName: string; readonly requests: number }[];
  readonly r2Storage?: readonly { readonly bucketName: string; readonly payloadSize: number; readonly metadataSize: number }[];
  /** The `workers` rows; default: mail-hero and todofy sharing workersRequests 3:1. */
  readonly scripts?: readonly SyntheticScript[];
  /** The `doInv` rows; default: one mail-hero row with doRequests. */
  readonly doScripts?: readonly { readonly script: string; readonly requests: number; readonly errors: number }[];
  /** The `d1` rows; default: one database with d1RowsRead/d1RowsWritten. */
  readonly d1Databases?: readonly { readonly id: string; readonly rowsRead: number; readonly rowsWritten: number }[];
  /** The `doPer` rows; default: one namespace with the doActiveTimeUs/doRowsRead/doRowsWritten. */
  readonly doNamespaces?: readonly { readonly id: string; readonly activeTimeUs: number; readonly rowsRead: number; readonly rowsWritten: number }[];
}

/** Synthetic D1 database IDs and DO namespace IDs (not the account's; the registry leaves them unmapped). */
export const SYNTHETIC_D1 = ['0b7d3c1e-5a2f-4c8d-9e61-3f0a2b4c5d6e', '7e1f2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b'] as const;
export const SYNTHETIC_NS = ['1f2e3d4c5b6a79880f1e2d3c4b5a6978', 'a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5', '5d4c3b2a1f0e9d8c7b6a5f4e3d2c1b0a'] as const;

/**
 * The mockup's day (dash-redesign/mockup-content.md §0.3–§0.5) as GraphQL would answer it at 14:30:
 * five scripts (712 requests, 3 errors), DO invocations on the scripts defining the classes (todofy-core
 * defines TodofyCore, so the gateway `todofy` has none), two D1 databases, three DO namespaces, the Mail
 * Hero store bucket and an unregistered backup bucket.
 */
export const REALISTIC_USAGE: SyntheticUsage = {
  scripts: [
    { script: 'mail-hero', requests: 268, errors: 0, subrequests: 41, cpuP50: 1123.4, cpuP99: 4810.9 },
    { script: 'todofy', requests: 214, errors: 2, subrequests: 58, cpuP50: 902.1, cpuP99: 3598.6 },
    { script: 'home', requests: 118, errors: 0, subrequests: 29, cpuP50: 811, cpuP99: 2904 },
    { script: 'todofy-core', requests: 96, errors: 0, subrequests: 37, cpuP50: 1402.5, cpuP99: 6207.2 },
    { script: 'ziyixi-notion-publish', requests: 16, errors: 1, subrequests: 48, cpuP50: 2311.7, cpuP99: 7402.3 },
  ],
  doScripts: [
    { script: 'mail-hero', requests: 612, errors: 0 },
    { script: 'todofy-core', requests: 632, errors: 0 },
    { script: 'home', requests: 136, errors: 0 },
  ],
  d1Databases: [
    { id: SYNTHETIC_D1[0], rowsRead: 5210, rowsWritten: 318 },
    { id: SYNTHETIC_D1[1], rowsRead: 1932, rowsWritten: 168 },
  ],
  d1Sizes: [38_900_000, 7_300_000],
  doNamespaces: [
    { id: SYNTHETIC_NS[0], activeTimeUs: 900_000_000, rowsRead: 12_100, rowsWritten: 1040 },
    { id: SYNTHETIC_NS[1], activeTimeUs: 600_000_000, rowsRead: 7_300, rowsWritten: 610 },
    { id: SYNTHETIC_NS[2], activeTimeUs: 156_000_000, rowsRead: 2_000, rowsWritten: 270 },
  ],
  r2Ops: [
    { actionType: 'PutObject', bucketName: 'mail-hero-store', requests: 15_900 },
    { actionType: 'GetObject', bucketName: 'mail-hero-store', requests: 52_800 },
    { actionType: 'PutObject', bucketName: 'backup-synthetic', requests: 1_210 },
    { actionType: 'GetObject', bucketName: 'backup-synthetic', requests: 3_100 },
    { actionType: 'DeleteObject', bucketName: 'mail-hero-store', requests: 40 },
  ],
  r2Storage: [
    { bucketName: 'mail-hero-store', payloadSize: 780_000_000, metadataSize: 1_000_000 },
    { bucketName: 'backup-synthetic', payloadSize: 56_000_000, metadataSize: 0 },
  ],
};

/**
 * REALISTIC_USAGE with `count` scripts: the five real ones first, then unregistered `worker-06`, …
 * (0 gives an account with no Worker traffic today).
 */
export function usageWithScripts(count: number): SyntheticUsage {
  const real = REALISTIC_USAGE.scripts ?? [];
  const scripts: SyntheticScript[] = Array.from({ length: count }, (_, i) =>
    real[i] ?? { script: `worker-${String(i + 1).padStart(2, '0')}`, requests: 40 + i, errors: i % 7 === 0 ? 3 : 0, subrequests: i, cpuP50: 700 + i, cpuP99: 3000 + 10 * i },
  );
  const names = new Set(scripts.map((s) => s.script));
  return { ...REALISTIC_USAGE, scripts, doScripts: (REALISTIC_USAGE.doScripts ?? []).filter((d) => names.has(d.script)) };
}

export function graphqlBody(usage: SyntheticUsage = {}): unknown {
  const workers = usage.workersRequests ?? 1200;
  const d1Read = usage.d1RowsRead ?? 40_000;
  const d1Written = usage.d1RowsWritten ?? 900;
  return {
    data: {
      viewer: {
        accounts: [
          {
            workers: usage.scripts
              ? usage.scripts.map((s) => ({
                  sum: { requests: s.requests, errors: s.errors, subrequests: s.subrequests },
                  dimensions: { scriptName: s.script },
                  quantiles: { cpuTimeP50: s.cpuP50 ?? 800, cpuTimeP99: s.cpuP99 ?? 3000 },
                }))
              : [
                  { sum: { requests: Math.round(workers * 0.75), errors: 1, subrequests: 30 }, dimensions: { scriptName: 'mail-hero' }, quantiles: { cpuTimeP50: 900, cpuTimeP99: 4100 } },
                  { sum: { requests: workers - Math.round(workers * 0.75), errors: 0, subrequests: 12 }, dimensions: { scriptName: 'todofy' }, quantiles: { cpuTimeP50: 700, cpuTimeP99: 2500 } },
                ],
            d1: (usage.d1Databases ?? [{ id: 'db-synthetic-1', rowsRead: d1Read, rowsWritten: d1Written }]).map((db) => ({
              sum: { rowsRead: db.rowsRead, rowsWritten: db.rowsWritten, readQueries: 300, writeQueries: 40 },
              dimensions: { databaseId: db.id },
            })),
            d1s: (usage.d1Sizes ?? [120_000_000, 40_000_000]).map((size, i) => ({
              max: { databaseSizeBytes: size },
              dimensions: { databaseId: usage.d1Databases?.[i]?.id ?? `db-synthetic-${String(i + 1)}` },
            })),
            doInv: (usage.doScripts ?? [{ script: 'mail-hero', requests: usage.doRequests ?? 800, errors: 0 }]).map((d) => ({
              sum: { requests: d.requests, errors: d.errors },
              dimensions: { scriptName: d.script },
            })),
            doPer: usage.doNamespaces
              ? usage.doNamespaces.map((ns) => ({
                  sum: { activeTime: ns.activeTimeUs, rowsRead: ns.rowsRead, rowsWritten: ns.rowsWritten, cpuTime: 1_000_000, storageDeletes: 0, storageReadUnits: 10, storageWriteUnits: 10 },
                  dimensions: { namespaceId: ns.id },
                }))
              : [
              {
                sum: {
                  activeTime: usage.doActiveTimeUs ?? 2_000_000_000,
                  rowsRead: usage.doRowsRead ?? 20_000,
                  rowsWritten: usage.doRowsWritten ?? 3_000,
                  cpuTime: 1_000_000,
                  storageDeletes: 0,
                  storageReadUnits: 10,
                  storageWriteUnits: 10,
                },
                dimensions: { namespaceId: 'ns-synthetic-1' },
              },
              ],
            doSto: (usage.doStoredBytes ?? []).map((bytes) => ({ max: { storedBytes: bytes } })),
            r2ops: (
              usage.r2Ops ?? [
                { actionType: 'PutObject', bucketName: 'bucket-synthetic', requests: 3000 },
                { actionType: 'GetObject', bucketName: 'bucket-synthetic', requests: 9000 },
                { actionType: 'DeleteObject', bucketName: 'bucket-synthetic', requests: 500 },
              ]
            ).map((op) => ({ sum: { requests: op.requests }, dimensions: { actionType: op.actionType, bucketName: op.bucketName } })),
            r2sto: (usage.r2Storage ?? [{ bucketName: 'bucket-synthetic', payloadSize: 1_500_000_000, metadataSize: 1_000_000 }]).map((b) => ({
              max: { payloadSize: b.payloadSize, metadataSize: b.metadataSize, objectCount: 100 },
              dimensions: { bucketName: b.bucketName },
            })),
          },
        ],
      },
    },
    errors: null,
  };
}
