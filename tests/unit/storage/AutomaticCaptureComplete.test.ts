import { randomUUID } from 'crypto';
import { makeHumanFixture } from '../../helpers/automaticCommittedFixture';
import { prepareHumanCaptureBeginV2 } from '../../../src/storage/AutomaticCaptureBegin';
import {
  prepareHumanCapturePlanV2,
  prepareHumanCaptureCompletionV2,
} from '../../../src/storage/AutomaticCaptureComplete';
import { createAutomaticCaptureHandleRegistry } from '../../../src/storage/AutomaticCaptureHandles';
import {
  planAutomaticClaims,
  validateStoredAutomaticClaim,
} from '../../../src/extraction/AutomaticClaims';
import { ExtractionDiagnostics } from '../../../src/extraction/ExtractionDiagnostics';
import { compileAutomaticPolicy } from '../../../src/extraction/AutomaticEvidence';
import { hashAutomaticCaptureV2 } from '../../../src/schemas/AutomaticCapture.schema';
import { AutomaticWriteOwnerSchema } from '../../../src/schemas/AutomaticClaim.schema';
import { AutomaticCaptureOperationV2Schema } from '../../../src/schemas/AutomaticCaptureOperation.schema';
import { AutomaticHumanCaptureCompletionPreparationV2Schema } from '../../../src/schemas/AutomaticCaptureComplete.schema';
import { EntityNodeSchema, type GraphData } from '../../../src/schemas';
import {
  applyAutomaticBindingCommand,
  automaticCaptureOperationIdentityForOwnedSource,
  assertAutomaticLedgerSourceIntegrity,
  SOURCE_ENVELOPE_ATTRIBUTE,
  WRITE_OWNER_ATTRIBUTE,
  WRITE_OWNER_V2_ATTRIBUTE,
} from '../../../src/storage/AutomaticIdentity';

const NOW = '2026-10-25T13:00:00.000Z';
const COMMIT_AT = '2026-10-25T13:00:05.000Z';
function fixture(
  content = 'I prefer concise explanations.',
  profileId: 'conservative' | 'explicit' | 'reviewFirst' = 'conservative',
) {
  const original = makeHumanFixture(`complete-${randomUUID()}`);
  const owner = AutomaticWriteOwnerSchema.parse(original.human.attributes[WRITE_OWNER_ATTRIBUTE]);
  const graph = original.graph;
  graph.entities = graph.entities.filter((entity) => entity.uuid === original.binding.subjectId);
  graph.edges = [];
  graph.episodes = [];
  delete graph.automatic_operations_v1;
  const registry = createAutomaticCaptureHandleRegistry();
  const begin = registry.startBegin('human_turn_memory');
  const input = {
    storeHash: owner.store,
    sourceId: randomUUID(),
    operationId: randomUUID(),
    previousEpisodeId: null,
    backendNow: NOW,
    beginCallHash: begin.beginCallHash,
    leaseToken: begin.leaseToken,
    request: {
      version: 2 as const,
      lifecycle: 'replaySafeV2' as const,
      purpose: 'human_turn_memory' as const,
      namespace: original.human.group_id,
      issuer: owner.issuer,
      actorReference: owner.actor,
      turn: 'completion-event',
      attemptIdHash: 'c'.repeat(64),
      settings: {
        profileId,
        requestedTrustLevel: 'standard' as const,
        intentSetting: false,
        invocationDeadlineMs: 30_000,
      },
      source: {
        content,
        sourceMessageId: 'completion-message',
        conversationId: null,
        senderId: null,
        senderName: 'Synthetic display',
        sourceWorkflowId: 'original-workflow',
        originalSourceExecutionId: 'original-execution',
        sourceType: 'message' as const,
        quotedMessageId: null,
        eventTime: { mode: 'first_capture' as const },
        applicationOwnedWrapper: null,
        humanRegion: null,
        quoteRegions: [],
      },
    },
  };
  const admitted = prepareHumanCaptureBeginV2(graph, input);
  if (admitted.kind !== 'prepared_claim') throw new Error('Expected genuine atomic begin fixture');
  const handle = registry.recoverOrIssueInitial(begin.scope, admitted.leaseFence)!;
  const makePlan = (current: GraphData, timestamp: string) => {
    const outcome = new ExtractionDiagnostics().finish();
    outcome.status = 'succeeded';
    return planAutomaticClaims(
      current,
      input.request.namespace,
      [input.sourceId],
      compileAutomaticPolicy({ profileId }),
      outcome,
      timestamp,
    );
  };
  const plan = makePlan(admitted.graph, admitted.leaseFence.planTimestamp);
  const capability = registry.consumeForCompletion(handle, 'human_turn_memory');
  const context = { backendNow: COMMIT_AT, storeHash: input.storeHash };
  return {
    original,
    input,
    registry,
    admitted,
    capability,
    context,
    plan,
    makePlan,
    prepare: () => prepareHumanCapturePlanV2(plan, registry, capability),
  };
}
function complete(setup: ReturnType<typeof fixture>, current = setup.admitted.graph) {
  return prepareHumanCaptureCompletionV2(
    current,
    setup.prepare(),
    setup.registry,
    setup.capability,
    setup.context,
  );
}
function addUnrelated(graph: GraphData) {
  graph.entities.push(
    EntityNodeSchema.parse({
      uuid: randomUUID(),
      group_id: graph.episodes[0].group_id,
      name: 'Unrelated synthetic record',
      entity_type: 'concept',
      summary: '',
      attributes: {},
      created_at: NOW,
      updated_at: NOW,
    }),
  );
}

describe('pure human V2 completion preparation', () => {
  it('creates one detached native commit with pinned plan time and finalized receipt hashes, but no permit', () => {
    const setup = fixture();
    const before = JSON.stringify(setup.admitted.graph);
    const result = complete(setup);
    expect(result.kind).toBe('prepared_commit');
    expect(AutomaticHumanCaptureCompletionPreparationV2Schema.safeParse(result).success).toBe(true);
    if (
      result.kind !== 'prepared_commit' ||
      result.terminalReceipt.kind !== 'human_capture_committed'
    )
      return;
    expect(JSON.stringify(setup.admitted.graph)).toBe(before);
    expect(result.graph.edges).toHaveLength(1);
    expect(result.graph.edges[0].created_at).toBe(NOW);
    expect(result.terminalReceipt.terminalAt).toBe(COMMIT_AT);
    expect(result.terminalReceipt.receipt.commitAt).toBe(COMMIT_AT);
    expect(result.terminalReceipt).toMatchObject({
      interpretationCoverage: 'complete',
      acceptedCoverage: 'all',
      receiptInspectionComplete: true,
    });
    result.terminalReceipt.receipt.items.forEach((item, itemIndex) => {
      expect(
        result.terminalReceipt.kind === 'human_capture_committed' &&
          result.terminalReceipt.dependencies[itemIndex].dependencyHash,
      ).toBe(
        hashAutomaticCaptureV2({
          sourceId: setup.input.sourceId,
          sourceHash: setup.admitted.operation.identity.sourceHash,
          itemIndex,
          item,
        }),
      );
    });
    expect(validateStoredAutomaticClaim(result.graph, result.graph.edges[0])).toBe(true);
    expect(() => assertAutomaticLedgerSourceIntegrity(result.graph)).not.toThrow();
    expect(result).not.toHaveProperty('eligibleFirstCommit');
    expect(result).not.toHaveProperty('should_process');
    expect(result.operation).not.toHaveProperty('lease');
  });

  it('owns the plan before await, preserves the first preparation, and rejects plain/cloned tokens', () => {
    const setup = fixture();
    const token = setup.prepare();
    expect(Object.isFrozen(token)).toBe(true);
    expect(Object.keys(token)).toEqual([]);
    setup.plan.entities[0].name = 'caller mutated after preparation';
    expect(setup.prepare()).toBe(token);
    const result = complete(setup);
    expect(result.kind).toBe('prepared_commit');
    for (const fake of [
      { kind: 'plan', plan: setup.plan },
      { ...token },
      structuredClone(token),
      JSON.parse(JSON.stringify(token)),
    ]) {
      expect(
        prepareHumanCaptureCompletionV2(
          setup.admitted.graph,
          fake as never,
          setup.registry,
          setup.capability,
          setup.context,
        ),
      ).toEqual({ kind: 'decision', reason: 'invalid_plan' });
    }
  });

  it('authenticates the consumed capability before touching plan or graph inputs', () => {
    const setup = fixture();
    let reads = 0;
    const hostile = Object.defineProperty({}, 'entities', {
      enumerable: true,
      get() {
        reads++;
        throw new Error('private');
      },
    });
    expect(() => prepareHumanCapturePlanV2(hostile, setup.registry, {} as never)).toThrow(
      'invalid_handle',
    );
    expect(
      prepareHumanCaptureCompletionV2(
        hostile as never,
        {} as never,
        setup.registry,
        {} as never,
        setup.context,
      ),
    ).toEqual({ kind: 'decision', reason: 'invalid_handle' });
    expect(reads).toBe(0);
    const other = createAutomaticCaptureHandleRegistry();
    expect(
      prepareHumanCaptureCompletionV2(
        setup.admitted.graph,
        setup.prepare(),
        other,
        setup.capability,
        setup.context,
      ),
    ).toEqual({ kind: 'decision', reason: 'invalid_handle' });
  });

  it('keeps invalid-first preparation invalid for the same consumed invocation', () => {
    const setup = fixture();
    const token = prepareHumanCapturePlanV2({}, setup.registry, setup.capability);
    expect(setup.prepare()).toBe(token);
    const result = complete(setup);
    expect(result).toMatchObject({ kind: 'prepared_failure', reason: 'invalid_plan' });
    if (result.kind !== 'prepared_failure') return;
    expect(result.graph.edges).toEqual([]);
    expect(result.graph.episodes).toEqual(setup.admitted.graph.episodes);
    expect(result.graph.automatic_operations_v1!.operations[0]).toMatchObject({
      state: 'failed',
      failureCode: 'invalid_plan',
    });
  });

  it.each(['bytes', 'accessor'] as const)(
    'distinguishes %s preparation failures without invoking getters',
    (kind) => {
      const setup = fixture();
      let visits = 0;
      const bad =
        kind === 'bytes'
          ? { ...setup.plan, huge: 'x'.repeat(2 * 1024 * 1024) }
          : Object.defineProperty({}, 'entities', {
              enumerable: true,
              get() {
                visits++;
                return [];
              },
            });
      prepareHumanCapturePlanV2(bad, setup.registry, setup.capability);
      const result = complete(setup);
      expect(result).toMatchObject({
        kind: 'prepared_failure',
        reason: kind === 'bytes' ? 'resource_exhausted' : 'invalid_plan',
      });
      expect(visits).toBe(0);
    },
  );

  it.each(['token', 'generation', 'timestamp', 'count', 'store', 'expiry', 'clock'] as const)(
    'fences %s mismatches without staged writes',
    (kind) => {
      const setup = fixture();
      const graph = structuredClone(setup.admitted.graph);
      const operation = graph.automatic_operations_v1!.operations[0];
      if (operation.version !== 2 || operation.state !== 'leased')
        throw new Error('Expected lease');
      let context = setup.context;
      if (kind === 'token') operation.lease.token = randomUUID();
      if (kind === 'count') {
        operation.retryCount = 1;
        operation.lastRetryCallHash = 'f'.repeat(64);
      }
      if (kind === 'generation') {
        operation.generation = 2;
        operation.lease.claimKind = 'resume';
      }
      if (kind === 'timestamp') {
        operation.lease.renewedAt = '2026-10-25T13:00:01.000Z';
        operation.lastObservedAt = operation.lease.renewedAt;
        operation.lease.expiresAt = '2026-10-25T13:01:01.000Z';
      }
      if (kind === 'store') context = { ...context, storeHash: 'f'.repeat(64) };
      if (kind === 'expiry') context = { ...context, backendNow: operation.lease.expiresAt };
      if (kind === 'clock') context = { ...context, backendNow: '2026-10-25T12:59:59.999Z' };
      const before = JSON.stringify(graph);
      expect(
        prepareHumanCaptureCompletionV2(
          graph,
          setup.prepare(),
          setup.registry,
          setup.capability,
          context,
        ),
      ).toEqual({ kind: 'decision', reason: kind === 'clock' ? 'clock_regression' : 'fenced' });
      expect(JSON.stringify(graph)).toBe(before);
    },
  );

  it('rejects a coherent source/owner/operation rewrite against the private captured identity hash', () => {
    const setup = fixture();
    const graph = structuredClone(setup.admitted.graph);
    const source = graph.episodes[0];
    for (const key of [
      WRITE_OWNER_ATTRIBUTE,
      WRITE_OWNER_V2_ATTRIBUTE,
      SOURCE_ENVELOPE_ATTRIBUTE,
    ]) {
      const value = source.attributes[key] as Record<string, unknown>;
      value[key === WRITE_OWNER_ATTRIBUTE ? 'actor' : 'actorReference'] = 'coherent-other-actor';
    }
    const operation = graph.automatic_operations_v1!.operations[0];
    if (operation.version !== 2) throw new Error('Expected V2');
    operation.identity = automaticCaptureOperationIdentityForOwnedSource(
      source,
      operation.descriptor,
    );
    expect(() => assertAutomaticLedgerSourceIntegrity(graph)).not.toThrow();
    expect(
      prepareHumanCaptureCompletionV2(
        graph,
        setup.prepare(),
        setup.registry,
        setup.capability,
        setup.context,
      ),
    ).toEqual({ kind: 'decision', reason: 'fenced' });
  });

  it.each(['binding', 'trust', 'review'] as const)(
    'rechecks current %s authority before application',
    (kind) => {
      const setup = fixture();
      const graph = structuredClone(setup.admitted.graph);
      if (kind === 'trust') graph.episodes[0].trust_level = 'trusted';
      if (kind === 'review') graph.episodes[0].review_status = 'rejected';
      if (kind === 'binding')
        applyAutomaticBindingCommand(
          graph,
          {
            action: 'revoke',
            namespace: setup.input.request.namespace,
            bindingId: setup.original.binding.bindingId,
            expectedRevision: setup.original.binding.revision,
            authorizedBy: 'synthetic',
            reason: 'revocation before completion',
          },
          randomUUID(),
          COMMIT_AT,
        );
      expect(
        prepareHumanCaptureCompletionV2(
          graph,
          setup.prepare(),
          setup.registry,
          setup.capability,
          setup.context,
        ),
      ).toEqual({ kind: 'decision', reason: 'authority_changed' });
    },
  );

  it('recovers only the same completion acknowledgement and preserves historical receipts after revocation', () => {
    const setup = fixture();
    const committed = complete(setup);
    if (committed.kind !== 'prepared_commit') throw new Error('Expected commit');
    const before = JSON.stringify(committed.graph);
    const recovered = prepareHumanCaptureCompletionV2(
      committed.graph,
      setup.prepare(),
      setup.registry,
      setup.capability,
      { ...setup.context, backendNow: '2026-10-25T13:02:00.000Z' },
    );
    expect(recovered).toMatchObject({
      kind: 'ack_recovered',
      origin: 'initial',
      currentAuthority: 'active',
      terminalReceipt: committed.terminalReceipt,
    });
    expect(JSON.stringify(committed.graph)).toBe(before);
    const operation = committed.graph.automatic_operations_v1!.operations[0];
    if (operation.version !== 2 || operation.state !== 'committed')
      throw new Error('Expected terminal');
    const hash = operation.completionCallHash;
    operation.completionCallHash = 'd'.repeat(64);
    expect(complete(setup, committed.graph)).toEqual({ kind: 'decision', reason: 'fenced' });
    operation.completionCallHash = hash;
    applyAutomaticBindingCommand(
      committed.graph,
      {
        action: 'revoke',
        namespace: setup.input.request.namespace,
        bindingId: setup.original.binding.bindingId,
        expectedRevision: setup.original.binding.revision,
        authorizedBy: 'synthetic',
        reason: 'postcommit revocation',
      },
      randomUUID(),
      COMMIT_AT,
    );
    expect(complete(setup, committed.graph)).toMatchObject({
      kind: 'ack_recovered',
      currentAuthority: 'revoked',
      terminalReceipt: committed.terminalReceipt,
    });
  });

  it.each([
    ['   ', 'conservative', 'none', 'none'],
    ['Today I visited a garden.', 'conservative', 'unknown', 'none'],
    ['I prefer quiet forests after midnight.', 'conservative', 'unknown', 'none'],
    ['I prefer concise explanations.', 'reviewFirst', 'complete', 'none'],
    ['I prefer concise explanations.', 'explicit', 'unknown', 'none'],
  ] as const)(
    'truthfully wraps the literal/policy outcome for %s (%s)',
    (content, profile, interpretation, acceptance) => {
      const setup = fixture(content, profile);
      const result = complete(setup);
      expect(result).toMatchObject({
        kind: 'prepared_commit',
        terminalReceipt: {
          interpretationCoverage: interpretation,
          acceptedCoverage: acceptance,
          receiptInspectionComplete: true,
        },
      });
    },
  );

  it('does not turn parser bounds or failed outcomes into a successful no-fact receipt', () => {
    const oversized = fixture(`I prefer ${'x'.repeat(5000)}.`);
    const failed = complete(oversized);
    expect(failed).toMatchObject({ kind: 'prepared_failure', reason: 'resource_exhausted' });
    if (failed.kind !== 'prepared_failure') return;
    expect(failed.graph.edges).toEqual([]);
    expect(failed.graph.episodes).toEqual(oversized.admitted.graph.episodes);
    expect(failed.graph.automatic_operations_v1!.operations[0]).not.toHaveProperty(
      'terminalReceipt',
    );
  });

  it.each(['policy', 'source', 'error', 'count', 'budget', 'cancelled'] as const)(
    'rejects known %s failures before stale graph retry',
    (kind) => {
      const setup = fixture();
      setup.plan.graph_hash = 'f'.repeat(64);
      if (kind === 'policy')
        setup.plan.outcome.automatic!.policy = compileAutomaticPolicy({ profileId: 'reviewFirst' });
      if (kind === 'source') setup.plan.source_guards[0].hash = 'f'.repeat(64);
      if (kind === 'error') {
        setup.plan.outcome.status = 'failed';
        setup.plan.outcome.error_count = 1;
      }
      if (kind === 'count') setup.plan.outcome.counts.entities_created++;
      if (kind === 'budget' || kind === 'cancelled')
        setup.plan.outcome.budget = {
          version: 1,
          reason: kind === 'cancelled' ? 'cancelled' : 'deadline',
        };
      expect(complete(setup)).toMatchObject({
        kind: 'prepared_failure',
        reason:
          kind === 'budget'
            ? 'budget_exhausted'
            : kind === 'cancelled'
              ? 'interrupted'
              : 'invalid_plan',
      });
    },
  );

  it('renews one bounded retry and recovers its exact issue callback without double increment', () => {
    const setup = fixture();
    const changed = structuredClone(setup.admitted.graph);
    addUnrelated(changed);
    const result = complete(setup, changed);
    expect(result.kind).toBe('prepared_retry');
    if (result.kind !== 'prepared_retry') return;
    expect(result.leaseFence).toMatchObject({
      retryCount: 1,
      planTimestamp: COMMIT_AT,
      generation: 1,
      token: setup.admitted.leaseFence.token,
    });
    expect(result.graph.edges).toEqual([]);
    expect(result.writeRequired).toBe(true);
    const recovered = complete(setup, result.graph);
    expect(recovered).toMatchObject({
      kind: 'prepared_retry',
      writeRequired: false,
      leaseFence: result.leaseFence,
    });
    const invocation = setup.registry.readConsumedInvocation(setup.capability, 'human_turn_memory');
    const successor = setup.registry.recoverOrIssueSuccessor(
      invocation.retryScope,
      result.leaseFence,
    )!;
    expect(setup.registry.recoverOrIssueSuccessor(invocation.retryScope, result.leaseFence)).toBe(
      successor,
    );
    const cap = setup.registry.consumeForCompletion(successor, 'human_turn_memory');
    const plan = setup.makePlan(result.graph, result.leaseFence.planTimestamp);
    const token = prepareHumanCapturePlanV2(plan, setup.registry, cap);
    expect(
      prepareHumanCaptureCompletionV2(result.graph, token, setup.registry, cap, {
        ...setup.context,
        backendNow: '2026-10-25T13:00:06.000Z',
      }),
    ).toMatchObject({ kind: 'prepared_commit', origin: 'initial' });
  });

  it('limits the operation to three successor cycles and preserves raw source on the fourth conflict', () => {
    const setup = fixture();
    let graph = setup.admitted.graph;
    let capability = setup.capability;
    for (let cycle = 1; cycle <= 4; cycle++) {
      const invocation = setup.registry.readConsumedInvocation(capability, 'human_turn_memory');
      const plan = setup.makePlan(graph, invocation.boundFence.planTimestamp);
      const token = prepareHumanCapturePlanV2(plan, setup.registry, capability);
      const changed = structuredClone(graph);
      addUnrelated(changed);
      const result = prepareHumanCaptureCompletionV2(changed, token, setup.registry, capability, {
        ...setup.context,
        backendNow: new Date(Date.parse(COMMIT_AT) + cycle * 1000).toISOString(),
      });
      if (cycle === 4) {
        expect(result).toMatchObject({ kind: 'prepared_failure', reason: 'resource_exhausted' });
        if (result.kind !== 'prepared_failure') throw new Error('Expected bounded failure');
        expect(result.graph.edges).toEqual([]);
        expect(result.graph.episodes).toEqual(setup.admitted.graph.episodes);
        expect(result.graph.automatic_operations_v1!.operations[0]).toMatchObject({
          state: 'failed',
          failureCode: 'graph_conflict',
          retryCount: 3,
        });
        break;
      }
      if (result.kind !== 'prepared_retry') throw new Error('Expected bounded retry');
      expect(result.leaseFence.retryCount).toBe(cycle);
      const successor = setup.registry.recoverOrIssueSuccessor(
        invocation.retryScope,
        result.leaseFence,
      )!;
      capability = setup.registry.consumeForCompletion(successor, 'human_turn_memory');
      graph = result.graph;
    }
  });

  it('keeps explicit resume origin false-capable through commit and acknowledgement recovery', () => {
    const setup = fixture();
    const graph = structuredClone(setup.admitted.graph);
    const initial = setup.admitted.operation;
    const { lease: _lease, ...base } = initial;
    void _lease;
    graph.automatic_operations_v1!.operations[0] = AutomaticCaptureOperationV2Schema.parse({
      ...base,
      state: 'failed',
      failedAt: NOW,
      failureCode: 'invalid_plan',
    });
    const previous = {
      purpose: 'human_turn_memory' as const,
      operationId: initial.operationId,
      sourceId: initial.identity.sourceId,
      descriptorHash: hashAutomaticCaptureV2(initial.descriptor),
      identityHash: hashAutomaticCaptureV2(initial.identity),
      beginCallHash: initial.beginCallHash,
      retryCount: 0,
      generation: 1,
      state: 'failed',
    };
    const resume = setup.registry.startResume('human_turn_memory', previous);
    const renewedAt = '2026-10-25T13:00:01.000Z';
    const resumed = AutomaticCaptureOperationV2Schema.parse({
      ...base,
      state: 'leased',
      generation: 2,
      lastObservedAt: renewedAt,
      lease: {
        token: resume.leaseToken,
        acquiredAt: renewedAt,
        renewedAt,
        expiresAt: '2026-10-25T13:01:01.000Z',
        claimKind: 'resume',
      },
    });
    graph.automatic_operations_v1!.operations[0] = resumed;
    const fence = {
      ...setup.admitted.leaseFence,
      generation: 2,
      token: resume.leaseToken,
      claimKind: 'resume' as const,
      planTimestamp: renewedAt,
    };
    const handle = setup.registry.recoverOrIssueResume(resume.scope, fence)!;
    const capability = setup.registry.consumeForCompletion(handle, 'human_turn_memory');
    const token = prepareHumanCapturePlanV2(
      setup.makePlan(graph, renewedAt),
      setup.registry,
      capability,
    );
    const result = prepareHumanCaptureCompletionV2(
      graph,
      token,
      setup.registry,
      capability,
      setup.context,
    );
    expect(result).toMatchObject({ kind: 'prepared_commit', origin: 'resume' });
    if (result.kind !== 'prepared_commit') return;
    expect(
      prepareHumanCaptureCompletionV2(
        result.graph,
        token,
        setup.registry,
        capability,
        setup.context,
      ),
    ).toMatchObject({ kind: 'ack_recovered', origin: 'resume' });
    expect(result).not.toHaveProperty('eligibleFirstCommit');
  });

  it('keeps captured identity stable for display changes but enforces the separately prepared source guard', () => {
    const stale = fixture();
    const changed = structuredClone(stale.admitted.graph);
    changed.episodes[0].sender_name = 'Fresh display';
    expect(hashAutomaticCaptureV2(changed.automatic_operations_v1!.operations[0].identity)).toBe(
      stale.admitted.leaseFence.identityHash,
    );
    expect(complete(stale, changed)).toMatchObject({
      kind: 'prepared_failure',
      reason: 'invalid_plan',
    });
    const fresh = fixture();
    const graph = structuredClone(fresh.admitted.graph);
    graph.episodes[0].sender_name = 'Fresh display';
    const token = prepareHumanCapturePlanV2(
      fresh.makePlan(graph, fresh.admitted.leaseFence.planTimestamp),
      fresh.registry,
      fresh.capability,
    );
    const result = prepareHumanCaptureCompletionV2(
      graph,
      token,
      fresh.registry,
      fresh.capability,
      fresh.context,
    );
    expect(result.kind).toBe('prepared_commit');
    if (result.kind === 'prepared_commit')
      expect(result.terminalReceipt.sourceHash).toBe(fresh.admitted.operation.identity.sourceHash);
  });

  it('fails closed before any normalization of stored record metadata', () => {
    const setup = fixture();
    const graph = structuredClone(setup.admitted.graph);
    Object.defineProperty(graph.entities[0].attributes, '__proto__', {
      value: { retained: 'synthetic' },
      enumerable: true,
      configurable: true,
    });
    const before = JSON.stringify(graph);
    expect(complete(setup, graph)).toEqual({ kind: 'decision', reason: 'invalid_input' });
    expect(JSON.stringify(graph)).toBe(before);
  });

  it('rejects proposed plan metadata that schema parsing would silently drop', () => {
    const setup = fixture();
    Object.defineProperty(setup.plan.entities[0].attributes, '__proto__', {
      value: { proposed: true },
      enumerable: true,
    });
    expect(complete(setup)).toMatchObject({ kind: 'prepared_failure', reason: 'invalid_plan' });
  });

  it('fully reconstructs same-hash plans and rejects forged rows without half application', () => {
    const setup = fixture();
    setup.plan.entities[0].name = 'forged literal';
    const before = JSON.stringify(setup.admitted.graph);
    const result = complete(setup);
    expect(result).toMatchObject({ kind: 'prepared_failure', reason: 'invalid_plan' });
    if (result.kind !== 'prepared_failure') return;
    expect(result.graph.entities).toEqual(setup.admitted.graph.entities);
    expect(result.graph.edges).toEqual([]);
    expect(JSON.stringify(setup.admitted.graph)).toBe(before);
  });

  it.each(['trust', 'review'] as const)(
    'rechecks source %s on committed acknowledgement recovery',
    (kind) => {
      const setup = fixture();
      const result = complete(setup);
      if (result.kind !== 'prepared_commit') throw new Error('Expected commit');
      if (kind === 'trust') result.graph.episodes[0].trust_level = 'trusted';
      else result.graph.episodes[0].review_status = 'rejected';
      expect(complete(setup, result.graph)).toMatchObject({
        kind: 'ack_recovered',
        currentAuthority: 'changed',
      });
    },
  );

  it('propagates cooperative cancellation during binding validation without publishing a candidate', () => {
    const setup = fixture();
    const token = setup.prepare();
    const before = JSON.stringify(setup.admitted.graph);
    const cancellation = new Error('synthetic work cancellation');
    let checks = 0;
    expect(() =>
      prepareHumanCaptureCompletionV2(
        setup.admitted.graph,
        token,
        setup.registry,
        setup.capability,
        setup.context,
        () => {
          if (++checks === 3) throw cancellation;
        },
      ),
    ).toThrow(cancellation);
    expect(JSON.stringify(setup.admitted.graph)).toBe(before);
  });
});
