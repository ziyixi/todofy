/**
 * Synthetic GraphQL Analytics responses shaped like the verified query's answer (docs/design.md §7.2):
 * made-up script names, database/namespace IDs and buckets. Shared by the unit and workerd suites.
 */

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
            workers: [
              { sum: { requests: Math.round(workers * 0.75), errors: 1, subrequests: 30 }, dimensions: { scriptName: 'mail-hero' }, quantiles: { cpuTimeP50: 900, cpuTimeP99: 4100 } },
              { sum: { requests: workers - Math.round(workers * 0.75), errors: 0, subrequests: 12 }, dimensions: { scriptName: 'todofy' }, quantiles: { cpuTimeP50: 700, cpuTimeP99: 2500 } },
            ],
            d1: [
              { sum: { rowsRead: d1Read, rowsWritten: d1Written, readQueries: 300, writeQueries: 40 }, dimensions: { databaseId: 'db-synthetic-1' } },
            ],
            d1s: (usage.d1Sizes ?? [120_000_000, 40_000_000]).map((size, i) => ({
              max: { databaseSizeBytes: size },
              dimensions: { databaseId: `db-synthetic-${String(i + 1)}` },
            })),
            doInv: [{ sum: { requests: usage.doRequests ?? 800, errors: 0 }, dimensions: { scriptName: 'mail-hero' } }],
            doPer: [
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
