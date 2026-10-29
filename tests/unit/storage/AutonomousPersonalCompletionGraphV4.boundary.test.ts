import { randomUUID } from 'node:crypto';
import { EntityNodeSchema } from '../../../src/schemas/EntityNode.schema';
import { planAutonomousPersonalCaptureCompletionV4 } from '../../../src/storage/AutonomousPersonalCompletionPlanV4';
import {
  prepareAutonomousPersonalCompletionGraphCandidateV4,
  validateAutonomousPersonalCompletionReadbackV4,
} from '../../../src/storage/AutonomousPersonalCompletionGraphV4';
import {
  autonomousPersonalCompletionPlanFixtureV4,
  autonomousPersonalCompletionPlanNextStageV4,
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

function planned() {
  const plan = planAutonomousPersonalCaptureCompletionV4(
    fixture.input,
    fixture.graph,
    fixture.response,
    fixture.selection,
    fixture.work,
    fixture.check,
    fixture.budget,
  );
  if (plan.kind !== 'planned') throw new Error('Expected a complete synthetic plan');
  return plan;
}

function candidate(plan = planned()) {
  const result = prepareAutonomousPersonalCompletionGraphCandidateV4(
    fixture.graph,
    fixture.input,
    plan,
    randomUUID(),
    fixture.work,
    fixture.check,
  );
  if (result.kind !== 'candidate') throw new Error('Expected a complete synthetic candidate');
  return { plan, graph: result.graph };
}

it('retains regional language and ordering evidence through the complete candidate/readback', async () => {
  await fixture.close();
  const content =
    'I prefer explanations in plain British English, with one practical example before any technical terminology.';
  fixture = await autonomousPersonalCompletionPlanFixtureV4({ content });
  const { plan, graph } = candidate();
  expect(plan.createEdges.length).toBeGreaterThan(0);
  const storedClaims = JSON.stringify(plan.createEdges);
  for (const term of ['British', 'English', 'practical', 'example', 'before', 'terminology'])
    expect(storedClaims).toContain(term);
  expect(graph.episodes.find((row) => row.uuid === fixture.input.scope.sourceId)?.content).toBe(
    content,
  );
  expect(
    validateAutonomousPersonalCompletionReadbackV4(
      graph,
      fixture.input,
      plan,
      fixture.work,
      fixture.check,
    ),
  ).toEqual({ kind: 'matched' });
});

it('matches actual candidate data with an unrelated appended record and a changed global epoch', () => {
  const { plan, graph } = candidate();
  const actual = structuredClone(graph);
  actual.entities.push(
    EntityNodeSchema.parse({
      uuid: randomUUID(),
      group_id: 'synthetic:unrelated-namespace',
      name: 'Independent synthetic record',
      entity_type: 'concept',
      created_at: fixture.input.backendNow,
      updated_at: fixture.input.backendNow,
    }),
  );
  actual.metadata = { ...actual.metadata, extraction_epoch: randomUUID() };
  expect(
    validateAutonomousPersonalCompletionReadbackV4(
      actual,
      fixture.input,
      plan,
      fixture.work,
      fixture.check,
    ),
  ).toEqual({ kind: 'matched' });
  expect(actual).not.toHaveProperty('eligibleFirstCommit');
});

it('does not join a real terminal plan to a different real capture input', async () => {
  const { plan } = candidate();
  const next = await autonomousPersonalCompletionPlanNextStageV4(fixture.store, fixture.seed, {
    content: 'I prefer tables.',
    turn: 'synthetic:another-event',
    executionId: 'synthetic:another-execution',
  });
  try {
    const graph = structuredClone(next.graph);
    graph.automatic_operations_v1!.operations = graph.automatic_operations_v1!.operations.map(
      (operation) =>
        operation.operationId === plan.operation.operationId ? plan.operation : operation,
    );
    graph.entities.push(...plan.createEntities);
    graph.edges.push(...plan.createEdges);
    expect(
      validateAutonomousPersonalCompletionReadbackV4(
        graph,
        fixture.input,
        plan,
        next.work,
        next.check,
      ),
    ).toEqual({ kind: 'matched' });
    expect(
      validateAutonomousPersonalCompletionReadbackV4(
        graph,
        next.input,
        plan,
        next.work,
        next.check,
      ),
    ).toEqual({ kind: 'unconfirmed' });
  } finally {
    next.close();
  }
});

it.each(['completionCallHash', 'auditAttempt', 'scopeSource', 'scopeOperation'] as const)(
  'does not confirm a detached %s input even when the plan rows are present',
  (field) => {
    const { plan, graph } = candidate();
    const input = structuredClone(fixture.input);
    if (field === 'completionCallHash') input.completionCallHash = 'd'.repeat(64);
    else if (field === 'auditAttempt') input.audit.attemptIdHash = 'e'.repeat(64);
    else if (field === 'scopeSource') input.scope.sourceId = randomUUID();
    else input.scope.operationId = randomUUID();
    expect(
      validateAutonomousPersonalCompletionReadbackV4(
        graph,
        input,
        plan,
        fixture.work,
        fixture.check,
      ),
    ).toEqual({ kind: 'unconfirmed' });
  },
);

it.each([
  { kind: 'deferred', reason: 'provider_auth' },
  { kind: 'no_dispatch', reason: 'policy_not_selected' },
  { kind: 'no_dispatch', reason: 'unit_count' },
] as const)('does not attach outcome $kind/$reason to a successful response plan', (outcome) => {
  const { plan, graph } = candidate();
  const input = { ...fixture.input, outcome };
  expect(
    prepareAutonomousPersonalCompletionGraphCandidateV4(
      fixture.graph,
      input,
      plan,
      randomUUID(),
      fixture.work,
      fixture.check,
    ).kind,
  ).toBe('no_write');
  expect(
    validateAutonomousPersonalCompletionReadbackV4(graph, input, plan, fixture.work, fixture.check),
  ).toEqual({ kind: 'unconfirmed' });
});

it('requires the exact provider deferral reason while preserving a genuine source-only result', async () => {
  await fixture.close();
  fixture = await autonomousPersonalCompletionPlanFixtureV4({ providerAuthFailure: true });
  const plan = planned();
  expect(fixture.input.outcome).toEqual({ kind: 'deferred', reason: 'provider_auth' });
  const result = prepareAutonomousPersonalCompletionGraphCandidateV4(
    fixture.graph,
    fixture.input,
    plan,
    null,
    fixture.work,
    fixture.check,
  );
  expect(result.kind).toBe('candidate');
  if (result.kind !== 'candidate') throw new Error('Expected a source-only candidate');
  expect(
    validateAutonomousPersonalCompletionReadbackV4(
      result.graph,
      fixture.input,
      plan,
      fixture.work,
      fixture.check,
    ),
  ).toEqual({ kind: 'matched' });
  const changed = {
    ...fixture.input,
    outcome: { kind: 'deferred' as const, reason: 'provider_network' as const },
  };
  expect(
    prepareAutonomousPersonalCompletionGraphCandidateV4(
      fixture.graph,
      changed,
      plan,
      null,
      fixture.work,
      fixture.check,
    ).kind,
  ).toBe('no_write');
  expect(
    validateAutonomousPersonalCompletionReadbackV4(
      result.graph,
      changed,
      plan,
      fixture.work,
      fixture.check,
    ),
  ).toEqual({ kind: 'unconfirmed' });
});

it.each(['source', 'created_value', 'created_claim', 'terminal_operation'] as const)(
  'does not confirm a changed %s from only a matching operation ID',
  (target) => {
    const { plan, graph } = candidate();
    const actual = structuredClone(graph);
    if (target === 'source') {
      actual.episodes.find((row) => row.uuid === fixture.input.scope.sourceId)!.content +=
        ' altered';
    } else if (target === 'created_value') {
      actual.entities.find((row) => row.uuid === plan.createEntities[0]!.uuid)!.summary = 'altered';
    } else if (target === 'created_claim') {
      actual.edges.find((row) => row.uuid === plan.createEdges[0]!.uuid)!.fact += ' altered';
    } else {
      const operation = actual.automatic_operations_v1!.operations.find(
        (row) => row.operationId === plan.operation.operationId,
      )!;
      operation.lastObservedAt = new Date(Date.parse(operation.lastObservedAt) + 1).toISOString();
    }
    const before = JSON.stringify(actual);
    expect(
      validateAutonomousPersonalCompletionReadbackV4(
        actual,
        fixture.input,
        plan,
        fixture.work,
        fixture.check,
      ),
    ).toEqual({ kind: 'unconfirmed' });
    expect(JSON.stringify(actual)).toBe(before);
  },
);

it('rejects a plan whose deterministic ID is now occupied without editing the input graph', () => {
  const plan = planned();
  const graph = structuredClone(fixture.graph);
  graph.entities.push(
    EntityNodeSchema.parse({
      uuid: plan.createEdges[0]!.uuid,
      group_id: 'synthetic:other-namespace',
      name: 'Occupied synthetic identifier',
      entity_type: 'concept',
      created_at: fixture.input.backendNow,
      updated_at: fixture.input.backendNow,
    }),
  );
  const before = JSON.stringify(graph);
  expect(
    prepareAutonomousPersonalCompletionGraphCandidateV4(
      graph,
      fixture.input,
      plan,
      randomUUID(),
      fixture.work,
      fixture.check,
    ).kind,
  ).toBe('no_write');
  expect(JSON.stringify(graph)).toBe(before);
});

it('does not execute hostile graph or plan proxy traps', () => {
  const plan = planned();
  const trap = jest.fn(() => {
    throw new Error('Synthetic private trap');
  });
  const proxy = new Proxy({}, { get: trap, ownKeys: trap, getPrototypeOf: trap });
  expect(
    prepareAutonomousPersonalCompletionGraphCandidateV4(
      proxy,
      fixture.input,
      plan,
      randomUUID(),
      fixture.work,
      fixture.check,
    ).kind,
  ).toBe('no_write');
  expect(
    validateAutonomousPersonalCompletionReadbackV4(
      fixture.graph,
      fixture.input,
      proxy,
      fixture.work,
      fixture.check,
    ),
  ).toEqual({ kind: 'unconfirmed' });
  expect(trap).not.toHaveBeenCalled();
});

it('preserves the original trusted cancellation identity in both pure helpers', () => {
  const { plan, graph } = candidate();
  const sentinel = new Error('Synthetic trusted cancellation');
  const fail = () => {
    throw sentinel;
  };
  const captureFailure = (run: () => unknown) => {
    try {
      run();
      return undefined;
    } catch (error) {
      return error;
    }
  };
  expect(
    captureFailure(() =>
      prepareAutonomousPersonalCompletionGraphCandidateV4(
        fixture.graph,
        fixture.input,
        plan,
        randomUUID(),
        fixture.work,
        fail,
      ),
    ),
  ).toBe(sentinel);
  expect(
    captureFailure(() =>
      validateAutonomousPersonalCompletionReadbackV4(
        graph,
        fixture.input,
        plan,
        fixture.work,
        fail,
      ),
    ),
  ).toBe(sentinel);
});

it.each(['candidate', 'readback'] as const)(
  'checks the supplied native signal after the final %s callback',
  (kind) => {
    const { plan, graph } = candidate();
    const controller = new AbortController();
    const work = { ...fixture.work, signal: controller.signal };
    const epoch = randomUUID();
    const run = (check: () => void) =>
      kind === 'candidate'
        ? prepareAutonomousPersonalCompletionGraphCandidateV4(
            fixture.graph,
            fixture.input,
            plan,
            epoch,
            work,
            check,
          )
        : validateAutonomousPersonalCompletionReadbackV4(graph, fixture.input, plan, work, check);
    let baselineCalls = 0;
    const baseline = run(() => {
      fixture.check();
      baselineCalls++;
    });
    expect(baseline.kind).toBe(kind === 'candidate' ? 'candidate' : 'matched');
    expect(baselineCalls).toBeGreaterThan(0);
    let calls = 0;
    let result: ReturnType<typeof run> | undefined;
    let failed = false;
    try {
      result = run(() => {
        fixture.check();
        calls++;
        if (calls === baselineCalls) controller.abort();
      });
    } catch {
      failed = true;
    }
    expect(controller.signal.aborted).toBe(true);
    expect(failed || result?.kind === (kind === 'candidate' ? 'no_write' : 'unconfirmed')).toBe(
      true,
    );
  },
);
