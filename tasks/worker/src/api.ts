import { create } from '@ziyixi/proto/protobuf';
import type { ServiceHandlers, ShapeOf } from '@ziyixi/proto/http-transcoder';
import { ProjectSchema, SectionSchema, LabelSchema, SavedFilterSchema } from '@ziyixi/proto/tasks/ui/v1/task_pb';
import { PreviewDateResponseSchema, type TasksUiService } from '@ziyixi/proto/tasks/ui/v1/tasks_ui_service_pb';
import { previewDate, localDate } from '@ziyixi/task-dates';
import { getCatalog, saveCatalog, deleteCatalog } from './catalog.ts';
import { listChanges, listCompletions } from './history.ts';
import { invalid } from './errors.ts';
import { accountZone, type Env } from './env.ts';
import { taskMessage, resourceId } from './model.ts';
import { getTask, listTasks } from './task-read.ts';
import { createTask, updateTask, deleteTask, completeTask, reopenTask } from './task-write.ts';
import { duplicateTask } from './task-copy.ts';
import { reorderTasks } from './task-order.ts';
import { listFocusDays, moveFocusStep } from './focus.ts';
import { commandFocusTimer, getFocusTimer } from './focus-timer.ts';
import { getPlan, updateWeeklyBet } from './plan.ts';
import { createFocusEntry, deleteFocusEntry, updateFocusEntry } from './focus-entries.ts';

export interface ApiContext {
  env: Env;
  now: number;
  owner: string;
  bypassed: boolean;
  internal: boolean;
}
export const handlers: ServiceHandlers<ShapeOf<typeof TasksUiService>, ApiContext> = {
  getCatalog: (input, { env, now }) => getCatalog(env.DB, accountZone(env), now, input.includeTaskCounts !== false),
  listTasks: (input, { env, now }) => listTasks(env.DB, input, accountZone(env), now),
  getTask: async (input, { env, now }) =>
    taskMessage(await getTask(env.DB, resourceId(input.name, 'tasks')), localDate(now, accountZone(env))),
  createTask: (input, { env, now }) => createTask(env.DB, input, now, accountZone(env)),
  updateTask: (input, { env, now }) => updateTask(env.DB, input, now, accountZone(env)),
  deleteTask: (input, { env, now }) => deleteTask(env.DB, input, now),
  completeTask: (input, { env, now }) => completeTask(env.DB, input, now, accountZone(env)),
  reopenTask: (input, { env, now }) => reopenTask(env.DB, input, now, accountZone(env)),
  duplicateTask: (input, { env, now }) => duplicateTask(env.DB, input, now, accountZone(env)),
  reorderTasks: (input, { env, now }) => reorderTasks(env.DB, input, now, accountZone(env)),
  getPlan: (input, { env, now }) => getPlan(env.DB, input, accountZone(env), now),
  updateWeeklyBet: (input, { env, now }) => updateWeeklyBet(env.DB, input, accountZone(env), now),
  listFocusDays: (input, { env, now }) => listFocusDays(env.DB, input, accountZone(env), now),
  moveFocusStep: (input, { env, now }) => moveFocusStep(env.DB, input, now),
  getFocusTimer: (input, { env }) => getFocusTimer(env.DB, input),
  commandFocusTimer: (input, { env, now }) => commandFocusTimer(env.DB, input, now, accountZone(env)),
  createFocusEntry: (input, { env, now }) => createFocusEntry(env.DB, input, now, accountZone(env)),
  updateFocusEntry: (input, { env, now }) => updateFocusEntry(env.DB, input, now),
  deleteFocusEntry: (input, { env, now }) => deleteFocusEntry(env.DB, input, now),
  listChanges: (input, { env, now }) => listChanges(env.DB, input, localDate(now, accountZone(env))),
  listCompletions: (input, { env }) => listCompletions(env.DB, input),
  previewDate(input, { env, now }) {
    try {
      const zone = input.timeZone || accountZone(env);
      return Promise.resolve(
        create(PreviewDateResponseSchema, previewDate(input.text, input.referenceDate || localDate(now, zone), zone)),
      );
    } catch {
      return invalid('Enter a complete supported date or recurrence');
    }
  },
  createProject: (input, { env, now }) => {
    if (!input.project) invalid();
    return saveCatalog(
      env.DB,
      'projects',
      ProjectSchema,
      {
        requestId: input.requestId,
        id: input.projectId,
        resource: input.project,
        request: input,
      },
      true,
      now,
    );
  },
  updateProject: (input, { env, now }) => {
    if (!input.project) invalid();
    return saveCatalog(
      env.DB,
      'projects',
      ProjectSchema,
      {
        requestId: input.requestId,
        id: '',
        etag: input.etag,
        resource: input.project,
        ...(input.updateMask ? { updateMask: input.updateMask } : {}),
        request: input,
      },
      false,
      now,
    );
  },
  deleteProject: (input, { env, now }) => deleteCatalog(env.DB, 'projects', input, now),
  createSection: (input, { env, now }) => {
    if (!input.section) invalid();
    return saveCatalog(
      env.DB,
      'sections',
      SectionSchema,
      {
        requestId: input.requestId,
        id: input.sectionId,
        resource: input.section,
        request: input,
      },
      true,
      now,
    );
  },
  updateSection: (input, { env, now }) => {
    if (!input.section) invalid();
    return saveCatalog(
      env.DB,
      'sections',
      SectionSchema,
      {
        requestId: input.requestId,
        id: '',
        etag: input.etag,
        resource: input.section,
        ...(input.updateMask ? { updateMask: input.updateMask } : {}),
        request: input,
      },
      false,
      now,
    );
  },
  deleteSection: (input, { env, now }) => deleteCatalog(env.DB, 'sections', input, now),
  createLabel: (input, { env, now }) => {
    if (!input.label) invalid();
    return saveCatalog(
      env.DB,
      'labels',
      LabelSchema,
      { requestId: input.requestId, id: input.labelId, resource: input.label, request: input },
      true,
      now,
    );
  },
  updateLabel: (input, { env, now }) => {
    if (!input.label) invalid();
    return saveCatalog(
      env.DB,
      'labels',
      LabelSchema,
      {
        requestId: input.requestId,
        id: '',
        etag: input.etag,
        resource: input.label,
        ...(input.updateMask ? { updateMask: input.updateMask } : {}),
        request: input,
      },
      false,
      now,
    );
  },
  deleteLabel: (input, { env, now }) => deleteCatalog(env.DB, 'labels', input, now),
  createSavedFilter: (input, { env, now }) => {
    if (!input.savedFilter) invalid();
    return saveCatalog(
      env.DB,
      'filters',
      SavedFilterSchema,
      {
        requestId: input.requestId,
        id: input.savedFilterId,
        resource: input.savedFilter,
        request: input,
      },
      true,
      now,
    );
  },
  updateSavedFilter: (input, { env, now }) => {
    if (!input.savedFilter) invalid();
    return saveCatalog(
      env.DB,
      'filters',
      SavedFilterSchema,
      {
        requestId: input.requestId,
        id: '',
        etag: input.etag,
        resource: input.savedFilter,
        ...(input.updateMask ? { updateMask: input.updateMask } : {}),
        request: input,
      },
      false,
      now,
    );
  },
  deleteSavedFilter: (input, { env, now }) => deleteCatalog(env.DB, 'filters', input, now),
};
