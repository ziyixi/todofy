/**
 * The UI tests' synthetic answers are answers the Worker could send: every scenario's registry and views read as the
 * client reads them (proto/dashboard/ui/v1, src/api/client.ts) with nothing unrecognized, so a page test never passes
 * on JSON the real client would refuse.
 */
import { CloudflareViewSchema } from '@ziyixi/proto/dashboard/ui/v1/cloudflare_view_pb'
import { FlowsViewSchema } from '@ziyixi/proto/dashboard/ui/v1/flows_view_pb'
import { HomeViewSchema } from '@ziyixi/proto/dashboard/ui/v1/home_view_pb'
import { OpsViewSchema } from '@ziyixi/proto/dashboard/ui/v1/ops_view_pb'
import { RegistrySchema } from '@ziyixi/proto/dashboard/ui/v1/registry_pb'
import type { DescMessage } from '@ziyixi/proto/protobuf'
import { fromWire } from '@ziyixi/proto/wire-json'
import {
  analyticsUnavailable,
  canaryActive,
  canaryDisabled,
  canaryFailed,
  configDrift,
  degradedApps,
  guardShed,
  healthy,
  observedOnly,
  oneWarning,
  todofyUnreachable,
  withLinkOnly,
  withWorkers,
  type Scenario,
} from './fixtures'

const SCENARIOS: Readonly<Record<string, () => Scenario>> = {
  healthy,
  oneWarning,
  todofyUnreachable,
  observedOnly,
  analyticsUnavailable,
  configDrift,
  guardShed,
  degradedApps,
  canaryActive,
  canaryDisabled,
  canaryFailed,
  withLinkOnly,
  withWorkers: () => withWorkers(50),
}

/** Paths a lenient read did not recognize; it throws on a wrong type, a missing REQUIRED field or a broken rule. */
function unrecognized(schema: DescMessage, value: unknown): readonly string[] {
  return fromWire(schema, JSON.parse(JSON.stringify(value))).unrecognized
}

describe('the UI fixtures', () => {
  it.each(Object.entries(SCENARIOS))('%s is what the Worker could answer', (_name, build) => {
    const scenario = build()
    expect(unrecognized(RegistrySchema, scenario.registry)).toEqual([])
    expect(unrecognized(HomeViewSchema, scenario.home)).toEqual([])
    expect(unrecognized(FlowsViewSchema, scenario.flows)).toEqual([])
    expect(unrecognized(CloudflareViewSchema, scenario.cloudflare)).toEqual([])
    expect(unrecognized(OpsViewSchema, scenario.ops)).toEqual([])
  })
})
