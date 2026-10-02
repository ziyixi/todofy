/**
 * The list bounds the Worker reads from dashboard.ui.v1 (src/idl.ts): each is the IDL's `max_items`, the copies the
 * IDL cannot express stay equal to it, and the values are the ones the view body budgets were measured with.
 */
import { describe, expect, it } from 'vitest';
import { FlowCanaryViewSchema } from '@ziyixi/proto/dashboard/ui/v1/canary_pb';
import { fieldRules } from '@ziyixi/proto/wire-json';
import { HOME_QUOTA_IDS } from '../src/api-types.ts';
import {
  CANARY_RECENT_RUNS,
  CF_VIEW_WORKERS_MAX,
  DIGEST_ITEMS_MAX,
  DRIFT_VIEW_FINDINGS_MAX,
  FLOW_STAGES_MAX,
  HOME_QUOTA_MAX,
  QUOTA_BREAKDOWN_MAX,
  TOP_SIGNALS_MAX,
} from '../src/idl.ts';
import { REPORT_MAX_ITEMS } from '../src/ops-client.ts';

describe('the IDL list bounds', () => {
  it('are the values the view body budgets were measured with (VIEW_BODY_BUDGET, VIEW_BODY_MAX)', () => {
    // Raising one in the IDL changes what a view may hold: measure the bodies again (test/views.test.ts) first.
    expect({
      CANARY_RECENT_RUNS,
      CF_VIEW_WORKERS_MAX,
      DRIFT_VIEW_FINDINGS_MAX,
      TOP_SIGNALS_MAX,
      QUOTA_BREAKDOWN_MAX,
      FLOW_STAGES_MAX,
      DIGEST_ITEMS_MAX,
      HOME_QUOTA_MAX,
    }).toEqual({
      CANARY_RECENT_RUNS: 14,
      CF_VIEW_WORKERS_MAX: 50,
      DRIFT_VIEW_FINDINGS_MAX: 20,
      TOP_SIGNALS_MAX: 3,
      QUOTA_BREAKDOWN_MAX: 5,
      FLOW_STAGES_MAX: 8,
      DIGEST_ITEMS_MAX: 20,
      HOME_QUOTA_MAX: 4,
    });
  });

  it('agree where one list is copied into another message', () => {
    // The flows view's canary strip is the same runs as the ops view's.
    expect(fieldRules(FlowCanaryViewSchema.field.recent).maxItems).toBe(CANARY_RECENT_RUNS);
    // The ops view's digest is the last OpsReport the dashboard built (ops.v1 bounds its items).
    expect(DIGEST_ITEMS_MAX).toBe(REPORT_MAX_ITEMS);
    // 首页 shows every quota of HOME_QUOTA_IDS, and the IDL holds exactly that many.
    expect(HOME_QUOTA_IDS).toHaveLength(HOME_QUOTA_MAX);
  });
});
