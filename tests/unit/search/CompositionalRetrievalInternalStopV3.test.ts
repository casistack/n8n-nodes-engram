import { performance } from 'perf_hooks';
import { randomUUID } from 'crypto';
import { makeCompositionalCommittedClaimFixture } from '../../helpers/compositionalCommittedClaimFixture';
import { createCompositionalRetrievalSessionFactoryV3 } from '../../../src/search/CompositionalRetrievalSessionV3';
import {
  getAutomaticClaimReadScope,
  getAutomaticClaimReadScopeRemaining,
} from '../../../src/storage/AutomaticClaimReadScope';

const NOW = '2026-10-25T12:00:03.000Z';
type InternalStop = 'budget_exhausted' | 'capacity' | null;
type Budget = { remaining: number; deferred: number };
type Factory = ReturnType<typeof createCompositionalRetrievalSessionFactoryV3>;
type Fixture = ReturnType<typeof makeCompositionalCommittedClaimFixture>;

function begin(factory: Factory, fixture: Fixture, budget: Budget, check?: () => void) {
  const result = factory.begin(
    { namespace: fixture.request.namespace, mode: 'current' },
    { budget, ...(check === undefined ? {} : { check }) },
  );
  if (result.status !== 'intake') throw new Error(`Expected intake: ${result.reason}`);
  const scope = factory.getScope(result.intake);
  if (!scope) throw new Error('Expected original scope');
  return { intake: result.intake, scope };
}

function prepare(factory: Factory, fixture: Fixture, intake: unknown) {
  return factory.prepare(intake, { graph: fixture.graph, backendNow: NOW });
}

function captureThrow(callback: () => unknown): { threw: boolean; value: unknown } {
  try {
    callback();
    return { threw: false, value: undefined };
  } catch (error) {
    return { threw: true, value: error };
  }
}

it.each([
  ['budget stop', 'budget_exhausted'],
  ['resource stop', 'capacity'],
] as const)(
  'does not reserve an attempt when the internal hook stops before begin (%s)',
  (_label, stop) => {
    const fixture = makeCompositionalCommittedClaimFixture();
    const budget = { remaining: 512, deferred: 0 };
    const scope = getAutomaticClaimReadScope(budget);
    const before = getAutomaticClaimReadScopeRemaining(scope)!;
    const factory = createCompositionalRetrievalSessionFactoryV3(() => stop);

    expect(
      factory.begin(
        { namespace: fixture.request.namespace, mode: 'current' },
        { budget },
      ),
    ).toEqual({ status: 'deferred', reason: stop });
    expect(budget).toEqual({ remaining: 512, deferred: 0 });
    expect(getAutomaticClaimReadScope(budget)).toBe(scope);
    const after = getAutomaticClaimReadScopeRemaining(scope)!;
    expect(after).toMatchObject({
      attemptsRemaining: before.attemptsRemaining,
      contextBytesRemaining: before.contextBytesRemaining,
      snapshotBytesRemaining: before.snapshotBytesRemaining,
      sourceHydrationsRemaining: before.sourceHydrationsRemaining,
    });
    expect(after.deadlineRemainingMs).toBeLessThanOrEqual(before.deadlineRemainingMs);
    expect(after.deadlineRemainingMs).toBeGreaterThanOrEqual(0);
  },
);

it('stops a large preparation during its checked index scan without reserving another attempt', () => {
  const fixture = makeCompositionalCommittedClaimFixture();
  const template = structuredClone(fixture.graph.entities[0]);
  for (let index = 0; index < 256; index++) {
    fixture.graph.entities.push({
      ...structuredClone(template),
      uuid: randomUUID(),
      name: `Synthetic unrelated entity ${index}`,
      summary: '',
      entity_type: 'concept',
      name_embedding: null,
      attributes: {},
    });
  }

  let calls = 0;
  let remainingChecks: number | null = null;
  const factory = createCompositionalRetrievalSessionFactoryV3(() => {
    calls += 1;
    if (remainingChecks === null) return null;
    if (remainingChecks === 0) return 'capacity';
    remainingChecks -= 1;
    return null;
  });
  const budget = { remaining: 512, deferred: 0 };
  const originalScope = getAutomaticClaimReadScope(budget);
  const { intake, scope } = begin(factory, fixture, budget);
  expect(scope).toBe(originalScope);
  expect(budget.remaining).toBe(508);
  const beforePrepare = calls;
  remainingChecks = 10;

  expect(prepare(factory, fixture, intake)).toEqual({
    status: 'deferred',
    reason: 'capacity',
  });
  expect(calls - beforePrepare).toBe(11);
  expect(calls - beforePrepare).toBeLessThan(fixture.graph.entities.length);
  expect(budget.remaining).toBe(508);
  expect(getAutomaticClaimReadScope(budget)).toBe(originalScope);
  expect(getAutomaticClaimReadScopeRemaining(originalScope)!.attemptsRemaining).toBe(127);
});

it.each([
  ['budget stop', 'budget_exhausted', 'budget_exhausted'],
  ['resource stop', 'capacity', 'capacity'],
] as const)(
  'returns an internal read stop as bounded data and resumes under the same scope when cleared (%s)',
  (_label, stopReason, expectedReason) => {
    const fixture = makeCompositionalCommittedClaimFixture();
    let stop: InternalStop = null;
    const factory = createCompositionalRetrievalSessionFactoryV3(() => stop);
    const budget = { remaining: 512, deferred: 0 };
    const originalScope = getAutomaticClaimReadScope(budget);
    const { intake, scope } = begin(factory, fixture, budget);
    expect(scope).toBe(originalScope);
    const prepared = prepare(factory, fixture, intake);
    if (prepared.status !== 'prepared_data')
      throw new Error(`Expected session: ${prepared.reason}`);

    stop = stopReason;
    expect(factory.readMany(prepared.session, [fixture.request.edgeId])).toEqual({
      status: 'deferred',
      reason: expectedReason,
    });

    stop = null;
    expect(factory.readMany(prepared.session, [fixture.request.edgeId]).status).toBe('data');
    expect(getAutomaticClaimReadScope(budget)).toBe(originalScope);
    expect(getAutomaticClaimReadScopeRemaining(originalScope)).not.toBeNull();
  },
);

it.each([
  ['object rejection', Object.freeze({ kind: 'trusted-parent-failure' })],
  ['undefined rejection', undefined],
] as const)(
  'keeps a trusted check failure sticky and exact ahead of an internal stop (%s)',
  (_label, trustedFailure) => {
    const fixture = makeCompositionalCommittedClaimFixture();
    let shouldThrow = false;
    let stop: InternalStop = null;
    const factory = createCompositionalRetrievalSessionFactoryV3(() => stop);
    const budget = { remaining: 512, deferred: 0 };
    const { intake } = begin(factory, fixture, budget, () => {
      if (shouldThrow) throw trustedFailure;
    });
    const prepared = prepare(factory, fixture, intake);
    if (prepared.status !== 'prepared_data') throw new Error(`Expected session: ${prepared.reason}`);

    shouldThrow = true;
    stop = 'capacity';
    const first = captureThrow(() =>
      factory.readMany(prepared.session, [fixture.request.edgeId]),
    );
    expect(first).toEqual({ threw: true, value: trustedFailure });

    shouldThrow = false;
    stop = null;
    const repeated = captureThrow(() =>
      factory.readMany(prepared.session, [fixture.request.edgeId]),
    );
    expect(repeated).toEqual({ threw: true, value: trustedFailure });
  },
);

it.each([
  ['omitted hook', () => createCompositionalRetrievalSessionFactoryV3()],
  ['explicit undefined hook', () => createCompositionalRetrievalSessionFactoryV3(undefined)],
] as const)('leaves the original factory path unchanged (%s)', (_label, createFactory) => {
  const fixture = makeCompositionalCommittedClaimFixture();
  const factory = createFactory();
  const budget = { remaining: 512, deferred: 0 };
  const originalScope = getAutomaticClaimReadScope(budget);
  const { intake, scope } = begin(factory, fixture, budget);
  expect(scope).toBe(originalScope);
  expect(budget.remaining).toBe(508);

  const prepared = prepare(factory, fixture, intake);
  if (prepared.status !== 'prepared_data') throw new Error(`Expected session: ${prepared.reason}`);
  expect(factory.readMany(prepared.session, [fixture.request.edgeId]).status).toBe('data');
  expect(getAutomaticClaimReadScope(budget)).toBe(originalScope);
});

it('keeps the original absolute scope deadline instead of rebasing it for a new session', () => {
  const now = jest.spyOn(performance, 'now').mockReturnValue(0);
  try {
    const fixture = makeCompositionalCommittedClaimFixture();
    const budget = { remaining: 512, deferred: 0 };
    const originalScope = getAutomaticClaimReadScope(budget);
    const factory = createCompositionalRetrievalSessionFactoryV3(() => null);
    const { intake, scope } = begin(factory, fixture, budget);
    expect(scope).toBe(originalScope);
    expect(budget.remaining).toBe(508);

    now.mockReturnValue(5_000);
    expect(prepare(factory, fixture, intake)).toEqual({
      status: 'deferred',
      reason: 'budget_exhausted',
    });
    expect(getAutomaticClaimReadScope(budget)).toBe(originalScope);
    expect(budget.remaining).toBe(508);
    expect(getAutomaticClaimReadScopeRemaining(originalScope)!.attemptsRemaining).toBe(127);
    expect(
      factory.begin(
        { namespace: fixture.request.namespace, mode: 'current' },
        { budget },
      ),
    ).toEqual({ status: 'deferred', reason: 'budget_exhausted' });
    expect(budget.remaining).toBe(508);
  } finally {
    now.mockRestore();
  }
});
