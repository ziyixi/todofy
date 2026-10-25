import { create } from '@ziyixi/proto/protobuf';
import { timestampFromMs } from '@ziyixi/proto/protobuf/wkt';
import {
  GoalProgressSchema,
  KeyResultSchema,
  KeyResultMilestoneSchema,
  KeyResultSummarySchema,
  ObjectiveSchema,
  type KeyResultMilestone,
} from '@ziyixi/proto/tasks/ui/v1/goals_pb';
import { checkedId, type BaseRow } from './model.ts';
import { invalid } from './errors.ts';

export const OBJECTIVE_LIMIT = 20;
export const KEY_RESULT_LIMIT = 100;
export const MILESTONE_LIMIT = 20;

export interface ObjectiveRow extends BaseRow {
  description: string;
  year: number;
  source_url: string;
  archived: number;
}
export interface KeyResultRow extends BaseRow {
  objective_id: string;
  year: number;
  objective_archived: number;
  floor_text: string;
  target_text: string;
  notes: string;
  kind: string;
  completed: number;
  milestones: string;
  milestone_count?: number;
  completed_milestone_count?: number;
  focus_start_month: string;
  focus_end_month: string;
  focus_text: string;
  source_url: string;
  archived: number;
}
export interface ProgressRow {
  id: string;
  key_result_id: string;
  note: string;
  evidence_url: string;
  revision: number;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}
export interface StoredMilestone {
  id: string;
  title: string;
  completed?: boolean;
  complete_time?: string;
}

export function goalId(name: string, collection: 'objectives' | 'keyResults' | 'goalProgress'): string {
  if (!name.startsWith(`${collection}/`)) invalid('Invalid goal resource name');
  return checkedId(name.slice(collection.length + 1));
}
function revision(row: { revision: number; created_at: number; updated_at: number }) {
  return {
    etag: String(row.revision),
    createTime: timestampFromMs(row.created_at),
    updateTime: timestampFromMs(row.updated_at),
  };
}
export function objectiveMessage(row: ObjectiveRow) {
  return create(ObjectiveSchema, {
    name: `objectives/${row.id}`,
    id: row.id,
    title: row.title,
    description: row.description,
    year: row.year,
    sourceUrl: row.source_url,
    sortOrder: row.sort_order,
    archived: Boolean(row.archived),
    ...revision(row),
  });
}
function keyResultFields(row: KeyResultRow) {
  return {
    name: `keyResults/${row.id}`,
    id: row.id,
    objectiveId: row.objective_id,
    year: row.year,
    title: row.title,
    kind: row.kind,
    completed: Boolean(row.completed),
    focusStartMonth: row.focus_start_month,
    focusEndMonth: row.focus_end_month,
    focusText: row.focus_text,
    sourceUrl: row.source_url,
    sortOrder: row.sort_order,
    archived: Boolean(row.archived),
    objectiveArchived: Boolean(row.objective_archived),
    ...revision(row),
  };
}
export function keyResultMessage(row: KeyResultRow) {
  const milestones = JSON.parse(row.milestones) as StoredMilestone[];
  return create(KeyResultSchema, {
    ...keyResultFields(row),
    floorText: row.floor_text,
    targetText: row.target_text,
    notes: row.notes,
    milestones: milestones.map((milestone) =>
      create(KeyResultMilestoneSchema, {
        id: milestone.id,
        title: milestone.title,
        completed: Boolean(milestone.completed),
        ...(milestone.complete_time
          ? {
              completeTime: timestampFromMs(Date.parse(milestone.complete_time)),
            }
          : {}),
      }),
    ),
  });
}
export function keyResultSummary(row: KeyResultRow) {
  return create(KeyResultSummarySchema, {
    ...keyResultFields(row),
    milestoneCount: row.milestone_count ?? 0,
    completedMilestoneCount: row.completed_milestone_count ?? 0,
  });
}
export function progressMessage(row: ProgressRow) {
  return create(GoalProgressSchema, {
    name: `goalProgress/${row.id}`,
    id: row.id,
    keyResultId: row.key_result_id,
    note: row.note,
    evidenceUrl: row.evidence_url,
    ...revision(row),
  });
}
/** New completions use server time; retained milestones keep their known or unknown completion time. */
export function storedMilestones(given: KeyResultMilestone[], previous: string, now: number): string {
  if (given.length > MILESTONE_LIMIT) invalid('A Key Result holds at most 20 milestones');
  const old = new Map((JSON.parse(previous) as StoredMilestone[]).map((milestone) => [milestone.id, milestone]));
  const seen = new Set<string>();
  return JSON.stringify(
    given.map((milestone): StoredMilestone => {
      const id = milestone.id ? checkedId(milestone.id) : crypto.randomUUID();
      const title = milestone.title.trim();
      if (!title || title.length > 300 || seen.has(id)) invalid('Milestones need unique IDs and titles');
      seen.add(id);
      const before = old.get(id);
      const completeTime = milestone.completed
        ? before?.completed
          ? before.complete_time
          : new Date(now).toISOString()
        : undefined;
      return {
        id,
        title,
        ...(milestone.completed ? { completed: true } : {}),
        ...(completeTime ? { complete_time: completeTime } : {}),
      };
    }),
  );
}
