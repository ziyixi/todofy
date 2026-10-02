/**
 * The registry's definitions (docs/design-v2.md §3), as src/registry.ts compiles them into the Worker. Each is the
 * public message GetRegistry answers (proto/dashboard/ui/v1/registry.proto) plus what the public view leaves out on
 * purpose, so the IDL cannot describe it: how an entry's status is obtained (binding names, probe URLs) and the
 * account identifier a storage resource matches. The UI never imports this file.
 */
import type { CanaryDef, EntryGroup, Flow, FlowGroup, RegistryEntry, RegistryResource, RegistryWorker, Stage } from './api-types.ts';

/** Where an entry's own health comes from (docs/design-v2.md §3). Its `type` is RegistryEntry.status_type. */
export type StatusSource =
  /** contracts/ops-v1 `Ops.status()` over the named service binding; guard: receives setGuard. */
  | { readonly type: 'ops_v1'; readonly binding: 'MAIL_HERO' | 'TODOFY' | 'LAB' | 'WATCH'; readonly guard: boolean }
  /**
   * One GET per tick from the Durable Object to a public (not Access-protected) URL: status code, Content-Type
   * header and latency only, `redirect: 'manual'`, body cancelled unread. `enabled: false` shows 未接入 instead.
   */
  | {
      readonly type: 'public_http';
      readonly url: string;
      readonly expect: readonly number[];
      /**
       * The media type (lowercase, without parameters) the answer must carry, e.g. `text/plain`: proves that the
       * app's own Worker answered and not an error or login page of the edge. A mismatch is `content_type`.
       */
      readonly content_type?: string;
      /**
       * The entry's `url` is behind Access but the probe path is not (a bypass application or a path-scoped one).
       * Requires `content_type` and 2xx-only `expect`, so Access's login redirect can never pass as healthy;
       * `.github/scripts/test_infra_config.py` checks the path against infra/access.tf.
       */
      readonly outside_access?: true;
      /** Also judge the error rate of the entry's Workers today (fresh GraphQL only), as an `analytics` stage does. */
      readonly error_rate?: true;
      readonly enabled: boolean;
    }
  /** From the tick's GraphQL data of the entry's workers: error rate and hours since the last request. */
  | { readonly type: 'analytics'; readonly max_idle_hours: number }
  /** The dashboard's own tick freshness (tick_stale). */
  | { readonly type: 'self' }
  /** Access-protected or private: a link, never probed (an anonymous probe sees only Access). */
  | { readonly type: 'link_only' }
  /** Not monitored yet (未接入). */
  | { readonly type: 'none' };

/** An entry: its public view without what GetRegistry computes (status_type, host, scripts), and its status source. */
export type EntryDef = Omit<RegistryEntry, 'status_type' | 'host' | 'scripts'> & { readonly status: StatusSource };

/** A Cloudflare Worker script that belongs to an entry (its flows are computed). */
export type WorkerDef = Omit<RegistryWorker, 'flows'>;

/**
 * A storage resource and its owner. GraphQL names D1 by `databaseId` (UUID), DO periodic data by `namespaceId` (32
 * hex) and R2 by `bucketName`. `match` is that identifier; null is a TODO placeholder (the value lives in a GitHub
 * variable, not in the repo): such a resource matches nothing, and the account's row stays 未登记 with its raw ID
 * until `match` is filled in.
 */
export type ResourceDef = RegistryResource & {
  readonly match: string | null;
  /** Where `match` comes from while it is null. */
  readonly todo?: string;
};

/** A flow, its stages and its canary are exactly their public messages. */
export type FlowDef = Flow;
export type StageDef = Stage;
export type { CanaryDef };

/** The registry as compiled into the Worker. */
export interface RegistryDef {
  readonly entry_groups: readonly EntryGroup[];
  readonly flow_groups: readonly FlowGroup[];
  readonly entries: readonly EntryDef[];
  readonly workers: readonly WorkerDef[];
  readonly resources: readonly ResourceDef[];
  readonly flows: readonly FlowDef[];
}
