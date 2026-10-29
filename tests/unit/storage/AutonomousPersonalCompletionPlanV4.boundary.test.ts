import { performance } from 'node:perf_hooks';
import { EntityNodeSchema } from '../../../src/schemas';
import { planAutonomousPersonalCaptureCompletionV4 } from '../../../src/storage/AutonomousPersonalCompletionPlanV4';
import {
  autonomousPersonalCompletionPlanFixtureV4,
  type AutonomousPersonalCompletionPlanFixtureV4,
} from '../../helpers/autonomousPersonalCompletionPlanV4';

let fixture: AutonomousPersonalCompletionPlanFixtureV4;
beforeEach(async () => {
  fixture = await autonomousPersonalCompletionPlanFixtureV4();
});
afterEach(async () => {
  jest.restoreAllMocks();
  await fixture?.close();
});
function plan(
  input: unknown = fixture.input,
  graph: unknown = fixture.graph,
  response: unknown = fixture.response,
  selection: unknown = fixture.selection,
  check: () => void = fixture.check,
  work = fixture.work,
) {
  return planAutonomousPersonalCaptureCompletionV4(
    input,
    graph,
    response,
    selection,
    work,
    check,
    fixture.budget,
  );
}
it.each(['value', 'claim'] as const)(
  'rejects a deterministic %s ID occupied by another record class/namespace',
  (kind) => {
    const baseline = plan();
    expect(baseline.kind).toBe('planned');
    if (baseline.kind !== 'planned') throw new Error('Expected baseline DATA plan');
    const id = kind === 'value' ? baseline.createEntities[0]!.uuid : baseline.createEdges[0]!.uuid;
    fixture.graph.entities.push(
      EntityNodeSchema.parse({
        uuid: id,
        group_id: 'synthetic:other-namespace',
        name: 'Synthetic collision',
        entity_type: 'concept',
        summary: '',
        name_embedding: null,
        attributes: {},
        created_at: fixture.input.backendNow,
        updated_at: fixture.input.backendNow,
      }),
    );
    const before = JSON.stringify(fixture.graph);
    expect(plan()).toEqual({ kind: 'no_write', reason: 'conflict' });
    expect(JSON.stringify(fixture.graph)).toBe(before);
  },
);
it('refuses caller permission flags and exposes no private completion permission', () => {
  expect(plan({ ...fixture.input, should_process: true })).toEqual({
    kind: 'no_write',
    reason: 'invalid_input',
  });
  const result = plan();
  expect(result).not.toHaveProperty('proof');
  expect(result).not.toHaveProperty('eligibleFirstCommit');
  expect(result).not.toHaveProperty('should_process');
});
it('does not observe arbitrary input or graph Proxy traps', () => {
  const trap = jest.fn(() => {
    throw new Error('synthetic private input');
  });
  const proxy = new Proxy({}, { get: trap, ownKeys: trap, getPrototypeOf: trap });
  expect(plan(proxy).kind).toBe('no_write');
  expect(plan(fixture.input, proxy).kind).toBe('no_write');
  expect(trap).not.toHaveBeenCalled();
});
it('does not repair an altered source or partially apply any rows', () => {
  const source = fixture.graph.episodes.find((row) => row.uuid === fixture.input.scope.sourceId)!;
  source.content += ' Synthetic changed text.';
  const before = JSON.stringify(fixture.graph);
  expect(plan().kind).toBe('no_write');
  expect(JSON.stringify(fixture.graph)).toBe(before);
});
it('retains the exact original trusted failure identity', () => {
  const sentinel = new Error('synthetic private cancellation detail');
  let error: unknown;
  try {
    plan(fixture.input, fixture.graph, fixture.response, fixture.selection, () => {
      throw sentinel;
    });
  } catch (caught) {
    error = caught;
  }
  expect(error).toBe(sentinel);
});
it('rechecks an earlier supplied deadline after the final trusted callback', () => {
  let calls = 0;
  const enteredAt = performance.now();
  const suppliedWork = { ...fixture.work, absoluteMonotonicDeadlineMs: enteredAt + 1_000 };
  const baseline = plan(
    fixture.input,
    fixture.graph,
    fixture.response,
    fixture.selection,
    () => {
      calls++;
      fixture.check();
    },
    suppliedWork,
  );
  expect(baseline.kind).toBe('planned');
  let expired = false;
  let current = 0;
  jest
    .spyOn(performance, 'now')
    .mockImplementation(() => (expired ? enteredAt + 1_001 : enteredAt));
  const result = plan(
    fixture.input,
    fixture.graph,
    fixture.response,
    fixture.selection,
    () => {
      current++;
      fixture.check();
      if (current === calls) expired = true;
    },
    suppliedWork,
  );
  expect(result).toEqual({ kind: 'no_write', reason: 'budget_exhausted' });
});
