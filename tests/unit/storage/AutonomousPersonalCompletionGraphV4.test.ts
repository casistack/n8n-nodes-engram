import { randomUUID } from 'node:crypto';
import { planAutonomousPersonalCaptureCompletionV4 } from '../../../src/storage/AutonomousPersonalCompletionPlanV4';
import { hashAutomaticCaptureV2 } from '../../../src/schemas/AutomaticCapture.schema';
import { AUTOMATIC_LEDGER_LIMITS } from '../../../src/schemas/AutomaticLedgerPrimitives.schema';
import {
  prepareAutonomousPersonalCompletionGraphCandidateV4,
  validateAutonomousPersonalCompletionReadbackV4,
} from '../../../src/storage/AutonomousPersonalCompletionGraphV4';
import type { GraphData } from '../../../src/schemas/GraphData.schema';
import {
  getAutomaticClaimReadScope,
  reserveAutomaticClaimSnapshotBytes,
} from '../../../src/storage/AutomaticClaimReadScope';
import {
  autonomousPersonalCompletionPlanFixtureV4,
  autonomousPersonalCompletionPlanNextStageV4,
  type AutonomousPersonalCompletionPlanFixtureV4,
} from '../../helpers/autonomousPersonalCompletionPlanV4';

type Planned = Extract<
  ReturnType<typeof planAutonomousPersonalCaptureCompletionV4>,
  { kind: 'planned' }
>;
type PlanFixture = Pick<
  AutonomousPersonalCompletionPlanFixtureV4,
  'input' | 'graph' | 'response' | 'selection' | 'work' | 'check' | 'budget'
>;

let fixture: AutonomousPersonalCompletionPlanFixtureV4;

beforeEach(async () => {
  fixture = await autonomousPersonalCompletionPlanFixtureV4();
});

afterEach(async () => {
  await fixture?.close();
});

function planFor(value: PlanFixture): Planned {
  if (value.selection === null) throw new Error('Expected complete provider selection');
  const plan = planAutonomousPersonalCaptureCompletionV4(
    value.input,
    value.graph,
    value.response,
    value.selection,
    value.work,
    value.check,
    value.budget,
  );
  if (plan.kind !== 'planned') throw new Error(`Expected planned DATA, got ${plan.reason}`);
  return plan;
}

function candidateFor(
  value: PlanFixture,
  plan: Planned = planFor(value),
  extractionEpoch: string | null = randomUUID(),
) {
  return prepareAutonomousPersonalCompletionGraphCandidateV4(
    value.graph,
    value.input,
    plan,
    extractionEpoch,
    value.work,
    value.check,
  );
}

function appendPriorPlan(
  current: Pick<AutonomousPersonalCompletionPlanFixtureV4, 'graph' | 'budget'>,
  prior: Planned,
): void {
  const originalBytes = Buffer.byteLength(JSON.stringify(current.graph), 'utf8');
  current.graph.automatic_operations_v1!.operations =
    current.graph.automatic_operations_v1!.operations.map((operation) =>
      operation.operationId === prior.operation.operationId
        ? structuredClone(prior.operation)
        : operation,
    );
  current.graph.entities.push(...structuredClone(prior.createEntities));
  current.graph.edges.push(...structuredClone(prior.createEdges));
  const addedBytes = Buffer.byteLength(JSON.stringify(current.graph), 'utf8') - originalBytes;
  if (!reserveAutomaticClaimSnapshotBytes(getAutomaticClaimReadScope(current.budget), addedBytes)) {
    throw new Error('Unable to reserve synthetic prior plan rows');
  }
}

describe('Autonomous Personal Completion Graph V4 pure candidate and readback', () => {
  it('prepares a lossless candidate without mutating inputs and changes only its terminal rows, appended pairs and epoch', () => {
    const plan = planFor(fixture);
    const graphBefore = JSON.stringify(fixture.graph);
    const inputBefore = JSON.stringify(fixture.input);
    const planBefore = JSON.stringify(plan);
    const epoch = randomUUID();

    const result = candidateFor(fixture, plan, epoch);

    expect(result.kind).toBe('candidate');
    if (result.kind !== 'candidate') throw new Error(`Expected candidate, got ${result.reason}`);
    const candidate = result.graph;
    expect(Object.isFrozen(candidate)).toBe(true);
    expect(JSON.stringify(fixture.graph)).toBe(graphBefore);
    expect(JSON.stringify(fixture.input)).toBe(inputBefore);
    expect(JSON.stringify(plan)).toBe(planBefore);
    expect(candidate.entities.slice(0, fixture.graph.entities.length)).toEqual(
      fixture.graph.entities,
    );
    expect(candidate.edges.slice(0, fixture.graph.edges.length)).toEqual(fixture.graph.edges);
    expect(candidate.episodes).toEqual(fixture.graph.episodes);
    expect(candidate.entities.slice(fixture.graph.entities.length)).toEqual(plan.createEntities);
    expect(candidate.edges.slice(fixture.graph.edges.length)).toEqual(plan.createEdges);
    expect(candidate.metadata?.extraction_epoch).toBe(epoch);
    expect(candidate.automatic_operations_v1?.operations).toHaveLength(
      fixture.graph.automatic_operations_v1?.operations.length ?? 0,
    );
    expect(
      candidate.automatic_operations_v1?.operations.find(
        (operation) => operation.operationId === plan.operation.operationId,
      ),
    ).toEqual(plan.operation);
  });

  it('does not construct a candidate for a no_write plan or accept an unnecessary epoch', () => {
    const noWritePlan = { kind: 'no_write' as const, reason: 'conflict' as const };
    expect(
      prepareAutonomousPersonalCompletionGraphCandidateV4(
        fixture.graph,
        fixture.input,
        noWritePlan,
        randomUUID(),
        fixture.work,
        fixture.check,
      ),
    ).toEqual({ kind: 'no_write', reason: 'conflict' });

    const plan = planFor(fixture);
    expect(candidateFor(fixture, plan, null).kind).toBe('no_write');
  });

  it('prepares a source-only terminal plan without changing graph metadata or requiring an epoch', async () => {
    const deferred = await autonomousPersonalCompletionPlanFixtureV4({ providerAuthFailure: true });
    try {
      const plan = planAutonomousPersonalCaptureCompletionV4(
        deferred.input,
        deferred.graph,
        deferred.response,
        deferred.selection,
        deferred.work,
        deferred.check,
        deferred.budget,
      );
      expect(plan.kind).toBe('planned');
      if (plan.kind !== 'planned') throw new Error('Expected source-only terminal DATA');
      expect(plan.createEntities).toEqual([]);
      expect(plan.createEdges).toEqual([]);
      const before = JSON.stringify(deferred.graph.metadata);
      const result = prepareAutonomousPersonalCompletionGraphCandidateV4(
        deferred.graph,
        deferred.input,
        plan,
        null,
        deferred.work,
        deferred.check,
      );
      expect(result.kind).toBe('candidate');
      if (result.kind !== 'candidate') throw new Error(`Expected candidate, got ${result.reason}`);
      expect(JSON.stringify(result.graph.metadata)).toBe(before);
    } finally {
      await deferred.close();
    }
  });

  it('rejects stale source DATA and a changed predecessor', () => {
    const plan = planFor(fixture);
    const alteredInput = structuredClone(fixture.input);
    alteredInput.stagedFresh.episode.content += ' changed';
    expect(
      prepareAutonomousPersonalCompletionGraphCandidateV4(
        fixture.graph,
        alteredInput,
        plan,
        randomUUID(),
        fixture.work,
        fixture.check,
      ).kind,
    ).toBe('no_write');

    const alteredGraph: GraphData = structuredClone(fixture.graph);
    alteredGraph.episodes[0]!.previous_episode_uuid = randomUUID();
    expect(
      prepareAutonomousPersonalCompletionGraphCandidateV4(
        alteredGraph,
        fixture.input,
        plan,
        randomUUID(),
        fixture.work,
        fixture.check,
      ).kind,
    ).toBe('no_write');
  });

  it('rejects a terminal plan detached from its completion input', () => {
    const plan = planFor(fixture);
    const candidate = candidateFor(fixture, plan);
    if (candidate.kind !== 'candidate')
      throw new Error(`Expected candidate, got ${candidate.reason}`);
    const detachedInput = structuredClone(fixture.input);
    detachedInput.completionCallHash = 'e'.repeat(64);
    expect(
      prepareAutonomousPersonalCompletionGraphCandidateV4(
        fixture.graph,
        detachedInput,
        plan,
        randomUUID(),
        fixture.work,
        fixture.check,
      ).kind,
    ).toBe('no_write');
    expect(
      validateAutonomousPersonalCompletionReadbackV4(
        candidate.graph,
        detachedInput,
        plan,
        fixture.work,
        fixture.check,
      ),
    ).toEqual({ kind: 'unconfirmed' });
  });

  it('fails closed when a valid terminal audit is truncated and has no persisted completion audit hash', () => {
    const operation = fixture.graph.automatic_operations_v1!.operations.find(
      (row) => row.operationId === fixture.input.scope.operationId,
    );
    if (operation?.version !== 4 || operation.state !== 'leased') {
      throw new Error('Expected the current leased Operation4');
    }
    const originalBytes = Buffer.byteLength(JSON.stringify(fixture.graph), 'utf8');
    operation.lastObservedAt = fixture.input.backendNow;
    for (let index = 1; index < AUTOMATIC_LEDGER_LIMITS.attemptsPerOperation; index += 1) {
      operation.attempts.push({
        attemptHash: hashAutomaticCaptureV2({
          domain: 'synthetic-completion-graph-audit-suffix',
          operationId: operation.operationId,
          index,
        }),
        at: fixture.input.backendNow,
        disposition: 'lease_renewed',
      });
    }
    const addedBytes = Buffer.byteLength(JSON.stringify(fixture.graph), 'utf8') - originalBytes;
    if (
      !reserveAutomaticClaimSnapshotBytes(getAutomaticClaimReadScope(fixture.budget), addedBytes)
    ) {
      throw new Error('Unable to reserve synthetic audit suffix bytes');
    }

    const plan = planFor(fixture);
    expect(plan.operation.auditTruncated).toBe(true);
    expect(
      plan.operation.attempts.some(
        (attempt) => attempt.attemptHash === fixture.input.audit.attemptIdHash,
      ),
    ).toBe(false);
    const candidate = candidateFor(fixture, plan);
    if (candidate.kind !== 'candidate')
      throw new Error(`Expected candidate, got ${candidate.reason}`);

    expect(
      validateAutonomousPersonalCompletionReadbackV4(
        candidate.graph,
        fixture.input,
        plan,
        fixture.work,
        fixture.check,
      ),
    ).toEqual({ kind: 'unconfirmed' });
    const changedAudit = structuredClone(fixture.input);
    changedAudit.audit.attemptIdHash = 'f'.repeat(64);
    expect(
      validateAutonomousPersonalCompletionReadbackV4(
        candidate.graph,
        changedAudit,
        plan,
        fixture.work,
        fixture.check,
      ),
    ).toEqual({ kind: 'unconfirmed' });
  });

  it('requires reference source rows and whole-row hashes to match the same actual graph', async () => {
    const first = await autonomousPersonalCompletionPlanFixtureV4({
      content: 'I prefer concise explanations. I prefer concise explanations.',
    });
    try {
      const prior = planFor(first);
      await new Promise((resolve) => setTimeout(resolve, 10));
      const current = await autonomousPersonalCompletionPlanNextStageV4(first.store, first.seed, {
        content: 'I prefer concise explanations.',
        turn: 'turn:completion-reference-guard',
      });
      try {
        appendPriorPlan(current, prior);
        const currentPlan = planFor(current);
        expect(currentPlan.createEntities).toEqual([]);
        expect(currentPlan.createEdges).toEqual([]);
        expect(currentPlan.referenceGuards).toHaveLength(1);

        const result = candidateFor(current, currentPlan, null);
        expect(result.kind).toBe('candidate');
        if (result.kind !== 'candidate')
          throw new Error(`Expected candidate, got ${result.reason}`);

        const changedReference = structuredClone(current.graph);
        const guard = currentPlan.referenceGuards[0]!;
        changedReference.edges.find((row) => row.uuid === guard.claimId)!.fact += ' altered';
        expect(
          prepareAutonomousPersonalCompletionGraphCandidateV4(
            changedReference,
            current.input,
            currentPlan,
            null,
            current.work,
            current.check,
          ).kind,
        ).toBe('no_write');
      } finally {
        current.close();
      }
    } finally {
      await first.close();
    }
  });

  it('matches exact rows on readback while allowing an updated_at-only source change and unrelated appends', () => {
    const plan = planFor(fixture);
    const candidate = candidateFor(fixture, plan);
    if (candidate.kind !== 'candidate')
      throw new Error(`Expected candidate, got ${candidate.reason}`);
    const actual = structuredClone(candidate.graph);
    actual.episodes.find((episode) => episode.uuid === fixture.input.scope.sourceId)!.updated_at =
      fixture.input.backendNow;

    expect(
      validateAutonomousPersonalCompletionReadbackV4(
        actual,
        fixture.input,
        plan,
        fixture.work,
        fixture.check,
      ),
    ).toEqual({ kind: 'matched' });
  });

  it('returns unconfirmed when any protected row changes and for malformed snapshots', () => {
    const plan = planFor(fixture);
    const candidate = candidateFor(fixture, plan);
    if (candidate.kind !== 'candidate')
      throw new Error(`Expected candidate, got ${candidate.reason}`);
    const changed = structuredClone(candidate.graph);
    const terminal = changed.automatic_operations_v1!.operations.find(
      (operation) => operation.operationId === plan.operation.operationId,
    );
    if (terminal?.version !== 4 || terminal.state !== 'committed') {
      throw new Error('Expected committed terminal Operation4');
    }
    terminal.completionCallHash = 'd'.repeat(64);
    expect(
      validateAutonomousPersonalCompletionReadbackV4(
        changed,
        fixture.input,
        plan,
        fixture.work,
        fixture.check,
      ),
    ).toEqual({ kind: 'unconfirmed' });
    expect(
      validateAutonomousPersonalCompletionReadbackV4(
        { ...candidate.graph, episodes: 'not an array' },
        fixture.input,
        plan,
        fixture.work,
        fixture.check,
      ),
    ).toEqual({ kind: 'unconfirmed' });
    expect(
      validateAutonomousPersonalCompletionReadbackV4(
        fixture.graph,
        fixture.input,
        { kind: 'no_write', reason: 'conflict' },
        fixture.work,
        fixture.check,
      ),
    ).toEqual({ kind: 'unconfirmed' });
  });

  it('does not inspect proxied graph or plan values', () => {
    const trap = jest.fn(() => {
      throw new Error('Synthetic hostile proxy access');
    });
    const proxy = new Proxy({}, { get: trap, ownKeys: trap, getPrototypeOf: trap });
    const plan = planFor(fixture);
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

  it('propagates the original trusted callback failure identity from candidate and readback', () => {
    const plan = planFor(fixture);
    const candidate = candidateFor(fixture, plan);
    if (candidate.kind !== 'candidate')
      throw new Error(`Expected candidate, got ${candidate.reason}`);
    const sentinel = new Error('Synthetic cancellation identity');
    const fail = () => {
      throw sentinel;
    };
    const capture = (callback: () => unknown) => {
      try {
        callback();
        return undefined;
      } catch (error) {
        return error;
      }
    };
    expect(
      capture(() =>
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
      capture(() =>
        validateAutonomousPersonalCompletionReadbackV4(
          candidate.graph,
          fixture.input,
          plan,
          fixture.work,
          fail,
        ),
      ),
    ).toBe(sentinel);
  });

  it('preserves a late trusted failure identity even when owned input is malformed', () => {
    const plan = planFor(fixture);
    const candidate = candidateFor(fixture, plan);
    if (candidate.kind !== 'candidate')
      throw new Error(`Expected candidate, got ${candidate.reason}`);
    const sentinel = new Error('Synthetic late trusted failure');
    const capture = (callback: () => unknown) => {
      try {
        callback();
        return undefined;
      } catch (error) {
        return error;
      }
    };
    const failOnSecondCheck = () => {
      let calls = 0;
      return () => {
        calls += 1;
        if (calls === 2) throw sentinel;
      };
    };
    expect(
      capture(() =>
        prepareAutonomousPersonalCompletionGraphCandidateV4(
          fixture.graph,
          {},
          plan,
          randomUUID(),
          fixture.work,
          failOnSecondCheck(),
        ),
      ),
    ).toBe(sentinel);
    expect(
      capture(() =>
        validateAutonomousPersonalCompletionReadbackV4(
          candidate.graph,
          {},
          plan,
          fixture.work,
          failOnSecondCheck(),
        ),
      ),
    ).toBe(sentinel);
  });
});
