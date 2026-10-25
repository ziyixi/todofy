import { expect, test } from 'vitest';
import { create } from '@ziyixi/proto/protobuf';
import { KeyResultMilestoneSchema } from '@ziyixi/proto/tasks/ui/v1/goals_pb';
import { storedMilestones } from '../src/goal-model.ts';

test('editing an imported completed milestone preserves an unknown completion time', () => {
  const before = JSON.stringify([{ id: 'imported', title: 'Synthetic imported milestone', completed: true }]);
  const changed = storedMilestones(
    [create(KeyResultMilestoneSchema, { id: 'imported', title: 'A clearer milestone', completed: true })],
    before,
    Date.parse('2030-04-15T18:00:00Z'),
  );
  expect(JSON.parse(changed)).toEqual([{ id: 'imported', title: 'A clearer milestone', completed: true }]);
});
