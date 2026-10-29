import { randomUUID } from 'crypto';
import { makeHumanFixture } from '../../helpers/automaticCommittedFixture';
import {
  prepareHumanCaptureResumeSourceV2,
  prepareHumanCaptureResumeV2,
  prepareHumanCaptureCancelV2,
  projectHumanCaptureOutcomeV2,
} from '../../../src/storage/AutomaticCaptureControl';
import { createAutomaticCaptureHandleRegistry } from '../../../src/storage/AutomaticCaptureHandles';
import {
  prepareHumanCapturePlanV2,
  prepareHumanCaptureCompletionV2,
} from '../../../src/storage/AutomaticCaptureComplete';
import { planAutomaticClaims } from '../../../src/extraction/AutomaticClaims';
import { ExtractionDiagnostics } from '../../../src/extraction/ExtractionDiagnostics';
import { compileAutomaticPolicy } from '../../../src/extraction/AutomaticEvidence';
import { AutomaticCaptureOperationV2Schema } from '../../../src/schemas/AutomaticCaptureOperation.schema';
import { AutomaticOperationSchema } from '../../../src/schemas/AutomaticLedger.schema';
import { AutomaticWriteOwnerSchema } from '../../../src/schemas/AutomaticClaim.schema';
import {
  AutomaticCaptureReadResultV2Schema,
  AutomaticCaptureReceiptSummaryV2Schema,
} from '../../../src/schemas/AutomaticCaptureApi.schema';
import {
  AutomaticHumanCaptureResumePreparationV2Schema,
  AutomaticHumanCaptureCancelPreparationV2Schema,
} from '../../../src/schemas/AutomaticCaptureControl.schema';
import { hashAutomaticCaptureV2 } from '../../../src/schemas/AutomaticCapture.schema';
import {
  assertAutomaticLedgerSourceIntegrity,
  applyAutomaticBindingCommand,
  automaticOperationIdentityForOwnedSource,
  WRITE_OWNER_ATTRIBUTE,
  WRITE_OWNER_V2_ATTRIBUTE,
} from '../../../src/storage/AutomaticIdentity';

const NOW = '2026-10-25T12:00:00.000Z';
const LATER = '2026-10-25T12:00:30.000Z';
function fixture(state: 'failed' | 'interrupted' | 'leased' | 'captured' | 'committed' = 'failed') {
  const original = makeHumanFixture(`control-${randomUUID()}`);
  const graph = original.graph;
  const owner = AutomaticWriteOwnerSchema.parse(original.human.attributes[WRITE_OWNER_ATTRIBUTE]);
  const registry = createAutomaticCaptureHandleRegistry();
  const begin = registry.startBegin('human_turn_memory');
  if (state !== 'committed') {
    graph.entities = graph.entities.filter((item) => item.uuid === original.binding.subjectId);
    graph.edges = [];
    const base: Record<string, unknown> = { ...original.humanOperation };
    delete base.terminalReceipt;
    delete base.completionCallHash;
    graph.automatic_operations_v1!.operations[0] = AutomaticCaptureOperationV2Schema.parse({
      ...base,
      beginCallHash: begin.beginCallHash,
      state,
      generation: state === 'captured' ? 0 : 1,
      ...(state === 'failed' ? { failedAt: NOW, failureCode: 'invalid_plan' } : {}),
      ...(state === 'interrupted'
        ? { interruptedAt: NOW, failureCode: 'invocation_interrupted' }
        : {}),
      ...(state === 'leased'
        ? {
            lease: {
              token: begin.leaseToken,
              acquiredAt: NOW,
              renewedAt: NOW,
              expiresAt: '2026-10-25T12:01:00.000Z',
              claimKind: 'initial',
            },
          }
        : {}),
    });
  }
  const request = {
    version: 2 as const,
    namespace: owner.namespace,
    issuer: owner.issuer,
    actorReference: owner.actor,
    turn: owner.turn,
    role: 'human' as const,
    expectedGeneration: 1,
    attemptIdHash: 'a'.repeat(64),
  };
  const readRequest = {
    version: request.version,
    namespace: request.namespace,
    issuer: request.issuer,
    actorReference: request.actorReference,
    turn: request.turn,
    role: request.role,
  };
  const context = { backendNow: LATER, storeHash: owner.store };
  return { original, graph, owner, registry, begin, request, readRequest, context };
}
function resumeInput(setup: ReturnType<typeof fixture>) {
  const peek = prepareHumanCaptureResumeSourceV2(setup.graph, setup.request, {
    storeHash: setup.context.storeHash,
  });
  if (peek.kind !== 'resume_source')
    throw new Error(`Expected private resume snapshot: ${JSON.stringify(peek)}`);
  const invocation = setup.registry.startResume('human_turn_memory', peek.resumeSource);
  return {
    peek,
    invocation,
    context: {
      ...setup.context,
      previousOperation: peek.operation,
      leaseToken: invocation.leaseToken,
    },
  };
}
function initialFence(setup: ReturnType<typeof fixture>) {
  const operation = setup.graph.automatic_operations_v1!.operations[0];
  if (operation.version !== 2 || operation.state !== 'leased')
    throw new Error('Expected current lease');
  return {
    purpose: 'human_turn_memory' as const,
    state: 'leased' as const,
    operationId: operation.operationId,
    sourceId: operation.identity.sourceId,
    descriptorHash: hashAutomaticCaptureV2(operation.descriptor),
    identityHash: hashAutomaticCaptureV2(operation.identity),
    beginCallHash: operation.beginCallHash,
    generation: operation.generation,
    token: operation.lease.token,
    claimKind: operation.lease.claimKind,
    planTimestamp: operation.lease.renewedAt,
    retryCount: operation.retryCount,
  };
}

describe('human capture explicit control preparation', () => {
  it.each(['failed', 'interrupted'] as const)(
    'prepares a %s resume only after fresh validation and never mints a handle',
    (state) => {
      const setup = fixture(state);
      const { context, invocation } = resumeInput(setup);
      const before = JSON.stringify(setup.graph);
      const result = prepareHumanCaptureResumeV2(setup.graph, setup.request, context);
      expect(AutomaticHumanCaptureResumePreparationV2Schema.safeParse(result).success).toBe(true);
      expect(result.kind).toBe('prepared_resume');
      if (result.kind !== 'prepared_resume') return;
      expect(result.writeRequired).toBe(true);
      expect(result.graph.automatic_operations_v1!.operations[0]).toMatchObject({
        lastResumeCause: state,
      });
      expect(result.leaseFence).toMatchObject({
        generation: 2,
        token: invocation.leaseToken,
        claimKind: 'resume',
        planTimestamp: LATER,
      });
      expect(result.graph.episodes).toEqual(setup.graph.episodes);
      expect(result.graph.edges).toEqual(setup.graph.edges);
      expect(JSON.stringify(setup.graph)).toBe(before);
      expect(result).not.toHaveProperty('leaseHandle');
      expect(result).not.toHaveProperty('eligibleFirstCommit');
      const handle = setup.registry.recoverOrIssueResume(invocation.scope, result.leaseFence)!;
      expect(setup.registry.isLiveHandle(handle, 'human_turn_memory', 'resume')).toBe(true);
    },
  );

  it('recovers a lost resume acknowledgement only for its unique token and exact successor', () => {
    const setup = fixture();
    const a = resumeInput(setup);
    const b = resumeInput(setup);
    const first = prepareHumanCaptureResumeV2(setup.graph, setup.request, a.context);
    const competitor = prepareHumanCaptureResumeV2(setup.graph, setup.request, b.context);
    expect(competitor.kind).toBe('prepared_resume');
    if (first.kind !== 'prepared_resume') throw new Error('Expected first resume');
    const before = JSON.stringify(first.graph);
    const recovered = prepareHumanCaptureResumeV2(first.graph, setup.request, {
      ...a.context,
      backendNow: '2026-10-25T12:00:31.000Z',
    });
    expect(recovered).toMatchObject({
      kind: 'prepared_resume',
      writeRequired: false,
      leaseFence: first.leaseFence,
    });
    expect(prepareHumanCaptureResumeV2(first.graph, setup.request, b.context)).toEqual({
      kind: 'decision',
      decision: { kind: 'fenced' },
    });
    expect(setup.registry.recoverOrIssueResume(b.invocation.scope, first.leaseFence)).toBeNull();
    const handle = setup.registry.recoverOrIssueResume(a.invocation.scope, first.leaseFence);
    expect(setup.registry.recoverOrIssueResume(a.invocation.scope, first.leaseFence)).toBe(handle);
    expect(JSON.stringify(first.graph)).toBe(before);
  });

  it('requires explicit expiry at equality; reads and pre-reads never resume a lease', () => {
    const setup = fixture('leased');
    const snapshot = resumeInput(setup);
    const before = JSON.stringify(setup.graph);
    expect(prepareHumanCaptureResumeV2(setup.graph, setup.request, snapshot.context)).toEqual({
      kind: 'decision',
      decision: { kind: 'in_progress' },
    });
    const atExpiry = { ...snapshot.context, backendNow: '2026-10-25T12:01:00.000Z' };
    expect(
      projectHumanCaptureOutcomeV2(setup.graph, setup.readRequest, {
        ...setup.context,
        backendNow: atExpiry.backendNow,
      }),
    ).toMatchObject({
      status: 'resume_available',
      should_process: false,
    });
    expect(JSON.stringify(setup.graph)).toBe(before);
    const result = prepareHumanCaptureResumeV2(setup.graph, setup.request, atExpiry);
    expect(result).toMatchObject({
      kind: 'prepared_resume',
      leaseFence: { generation: 2, claimKind: 'resume', planTimestamp: atExpiry.backendNow },
    });
    if (result.kind === 'prepared_resume')
      expect(result.graph.automatic_operations_v1!.operations[0]).not.toHaveProperty(
        'interruptedAt',
      );
  });

  it.each(['token', 'renewedAt', 'expiresAt', 'identity'] as const)(
    'checks the complete fresh old %s fence',
    (field) => {
      const setup = fixture('leased');
      const snapshot = resumeInput(setup);
      const graph = structuredClone(setup.graph);
      const operation = graph.automatic_operations_v1!.operations[0];
      if (operation.version !== 2 || operation.state !== 'leased')
        throw new Error('Expected lease');
      if (field === 'token') operation.lease.token = randomUUID();
      if (field === 'renewedAt') {
        operation.lease.renewedAt = '2026-10-25T12:00:01.000Z';
        operation.lastObservedAt = operation.lease.renewedAt;
        operation.lease.expiresAt = '2026-10-25T12:01:01.000Z';
      }
      if (field === 'expiresAt')
        snapshot.context.previousOperation = {
          ...operation,
          lease: {
            ...operation.lease,
            expiresAt: '2026-10-25T12:01:01.000Z',
            renewedAt: '2026-10-25T12:00:01.000Z',
          },
          lastObservedAt: '2026-10-25T12:00:01.000Z',
        };
      if (field === 'identity')
        snapshot.context.previousOperation = {
          ...operation,
          identity: { ...operation.identity, storeHash: 'f'.repeat(64) },
        };
      expect(
        prepareHumanCaptureResumeV2(graph, setup.request, {
          ...snapshot.context,
          backendNow: '2026-10-25T12:02:00.000Z',
        }),
      ).toMatchObject({ decision: { kind: 'fenced' } });
    },
  );

  it('preserves current audit observations made after the nonauthoritative pre-read', () => {
    const setup = fixture();
    const snapshot = resumeInput(setup);
    const operation = setup.graph.automatic_operations_v1!.operations[0];
    operation.attempts.push({
      attemptHash: 'b'.repeat(64),
      at: '2026-10-25T12:00:01.000Z',
      disposition: 'resume_available',
    });
    operation.lastObservedAt = '2026-10-25T12:00:01.000Z';
    const result = prepareHumanCaptureResumeV2(setup.graph, setup.request, snapshot.context);
    expect(result.kind).toBe('prepared_resume');
    if (result.kind === 'prepared_resume')
      expect(
        result.graph.automatic_operations_v1!.operations[0].attempts.map(
          (item) => item.attemptHash,
        ),
      ).toEqual(['b'.repeat(64), 'a'.repeat(64)]);
  });

  it.each(['binding', 'trust', 'review'] as const)(
    'rechecks current %s before issuing resume work',
    (kind) => {
      const setup = fixture();
      const snapshot = resumeInput(setup);
      if (kind === 'trust') setup.graph.episodes[0].trust_level = 'trusted';
      if (kind === 'review') setup.graph.episodes[0].review_status = 'rejected';
      if (kind === 'binding')
        applyAutomaticBindingCommand(
          setup.graph,
          {
            action: 'revoke',
            namespace: setup.request.namespace,
            bindingId: setup.original.binding.bindingId,
            expectedRevision: setup.original.binding.revision,
            authorizedBy: 'operator',
            reason: 'test',
          },
          randomUUID(),
          LATER,
        );
      const before = JSON.stringify(setup.graph);
      expect(prepareHumanCaptureResumeV2(setup.graph, setup.request, snapshot.context)).toEqual({
        kind: 'decision',
        decision: { kind: 'authority_changed' },
      });
      expect(JSON.stringify(setup.graph)).toBe(before);
    },
  );

  it('allows an explicitly authorized operator abort after revocation/rejection without deleting facts', () => {
    const setup = fixture('leased');
    const unrelated = makeHumanFixture(`unrelated-${randomUUID()}`);
    setup.graph.entities.push(...unrelated.graph.entities);
    setup.graph.episodes.push(...unrelated.graph.episodes);
    setup.graph.edges.push(...unrelated.graph.edges);
    setup.graph.automatic_operations_v1!.operations.push(
      ...unrelated.graph.automatic_operations_v1!.operations,
    );
    setup.graph.episodes[0].review_status = 'rejected';
    setup.graph.episodes[0].trust_level = 'untrusted';
    applyAutomaticBindingCommand(
      setup.graph,
      {
        action: 'revoke',
        namespace: setup.request.namespace,
        bindingId: setup.original.binding.bindingId,
        expectedRevision: setup.original.binding.revision,
        authorizedBy: 'operator',
        reason: 'test',
      },
      randomUUID(),
      LATER,
    );
    const before = JSON.stringify(setup.graph);
    const result = prepareHumanCaptureCancelV2(setup.graph, setup.request, setup.context);
    expect(AutomaticHumanCaptureCancelPreparationV2Schema.safeParse(result).success).toBe(true);
    expect(result.kind).toBe('prepared_cancel');
    if (result.kind !== 'prepared_cancel') return;
    expect(result.graph.edges).toEqual(setup.graph.edges);
    expect(result.graph.episodes).toEqual(setup.graph.episodes);
    expect(result.terminalReceipt).toMatchObject({
      kind: 'cancelled',
      acceptedCoverage: 'none',
      terminalAt: LATER,
    });
    expect(result.terminalReceipt).not.toHaveProperty('receipt');
    expect(result).not.toHaveProperty('eligibleFirstCommit');
    expect(JSON.stringify(setup.graph)).toBe(before);
    expect(prepareHumanCaptureCancelV2(result.graph, setup.request, setup.context)).toEqual({
      kind: 'decision',
      decision: { kind: 'already_terminal' },
    });
  });

  it('fences stale completion after cancellation and never cancels a completed receipt', () => {
    const setup = fixture('leased');
    const f = initialFence(setup);
    const handle = setup.registry.recoverOrIssueInitial(setup.begin.scope, f)!;
    const capability = setup.registry.consumeForCompletion(handle, 'human_turn_memory');
    const outcome = new ExtractionDiagnostics().finish();
    outcome.status = 'succeeded';
    const plan = planAutomaticClaims(
      setup.graph,
      setup.request.namespace,
      [f.sourceId],
      compileAutomaticPolicy({ profileId: 'conservative' }),
      outcome,
      f.planTimestamp,
    );
    const token = prepareHumanCapturePlanV2(plan, setup.registry, capability);
    const cancelled = prepareHumanCaptureCancelV2(setup.graph, setup.request, setup.context);
    if (cancelled.kind !== 'prepared_cancel') throw new Error('Expected cancellation');
    expect(
      prepareHumanCaptureCompletionV2(
        cancelled.graph,
        token,
        setup.registry,
        capability,
        setup.context,
      ),
    ).toEqual({ kind: 'decision', reason: 'fenced' });
    const committed = prepareHumanCaptureCompletionV2(
      setup.graph,
      token,
      setup.registry,
      capability,
      setup.context,
    );
    if (committed.kind !== 'prepared_commit')
      throw new Error('Expected commit in competing original snapshot');
    const before = JSON.stringify(committed.graph);
    expect(prepareHumanCaptureCancelV2(committed.graph, setup.request, setup.context)).toEqual({
      kind: 'decision',
      decision: { kind: 'already_terminal' },
    });
    expect(JSON.stringify(committed.graph)).toBe(before);
  });

  it.each(['resume', 'cancel', 'read'] as const)(
    'returns strict private-free %s conflicts for another actor',
    (method) => {
      const setup = fixture();
      const snapshot = resumeInput(setup);
      const before = JSON.stringify(setup.graph);
      const request = { ...setup.request, actorReference: 'different-actor' };
      const result =
        method === 'resume'
          ? prepareHumanCaptureResumeV2(setup.graph, request, snapshot.context)
          : method === 'cancel'
            ? prepareHumanCaptureCancelV2(setup.graph, request, setup.context)
            : projectHumanCaptureOutcomeV2(
                setup.graph,
                { ...setup.readRequest, actorReference: request.actorReference },
                setup.context,
              );
      expect(JSON.stringify(result)).not.toContain(setup.graph.episodes[0].uuid);
      expect(JSON.stringify(result)).not.toContain(setup.graph.episodes[0].content);
      expect(JSON.stringify(result)).not.toContain(setup.context.storeHash);
      expect(result).toMatchObject(
        method === 'read'
          ? {
              status: 'conflict',
              sourcePersistence: 'unknown',
              sourceId: null,
              should_process: false,
            }
          : { decision: { kind: 'conflict' } },
      );
      expect(JSON.stringify(setup.graph)).toBe(before);
    },
  );

  it('never adopts source-only V2 or genuine V1 operations', () => {
    const setup = fixture();
    const snapshot = resumeInput(setup);
    delete setup.graph.automatic_operations_v1;
    expect(prepareHumanCaptureResumeV2(setup.graph, setup.request, snapshot.context)).toMatchObject(
      { decision: { kind: 'source_only_unconfirmed' } },
    );
    expect(prepareHumanCaptureCancelV2(setup.graph, setup.request, setup.context)).toMatchObject({
      decision: { kind: 'source_only_unconfirmed' },
    });
    expect(
      projectHumanCaptureOutcomeV2(setup.graph, setup.readRequest, setup.context),
    ).toMatchObject({
      status: 'source_only_unconfirmed',
      should_process: false,
      receiptSummary: null,
    });
    delete setup.graph.episodes[0].attributes[WRITE_OWNER_V2_ATTRIBUTE];
    const identity = automaticOperationIdentityForOwnedSource(setup.graph.episodes[0], setup.owner);
    setup.graph.automatic_operations_v1 = {
      version: 1,
      operations: [
        AutomaticOperationSchema.parse({
          version: 1,
          operationId: randomUUID(),
          identity,
          descriptor: null,
          createdAt: NOW,
          lastObservedAt: NOW,
          attempts: [],
          overflowCount: 0,
          state: 'legacy_unconfirmed',
          generation: 0,
        }),
      ],
    };
    const before = JSON.stringify(setup.graph);
    expect(() => assertAutomaticLedgerSourceIntegrity(setup.graph)).not.toThrow();
    expect(
      AutomaticOperationSchema.safeParse({
        ...setup.graph.automatic_operations_v1!.operations[0],
        lastResumeCause: 'failed',
      }).success,
    ).toBe(false);
    expect(prepareHumanCaptureResumeV2(setup.graph, setup.request, snapshot.context)).toMatchObject(
      { decision: { kind: 'legacy_unconfirmed' } },
    );
    expect(prepareHumanCaptureCancelV2(setup.graph, setup.request, setup.context)).toMatchObject({
      decision: { kind: 'legacy_unconfirmed' },
    });
    expect(
      projectHumanCaptureOutcomeV2(setup.graph, setup.readRequest, setup.context),
    ).toMatchObject({ status: 'legacy_unconfirmed', should_process: false, receiptSummary: null });
    expect(JSON.stringify(setup.graph)).toBe(before);
  });

  it.each(['issuer', 'store'] as const)(
    'does not leak another %s through any control path',
    (field) => {
      const setup = fixture();
      const snapshot = resumeInput(setup);
      const before = JSON.stringify(setup.graph);
      const request = {
        ...setup.request,
        ...(field === 'issuer' ? { issuer: 'other-issuer' } : {}),
      };
      const context = {
        ...setup.context,
        ...(field === 'store' ? { storeHash: 'f'.repeat(64) } : {}),
      };
      expect(
        prepareHumanCaptureResumeV2(setup.graph, request, { ...snapshot.context, ...context }),
      ).toEqual({ kind: 'decision', decision: { kind: 'conflict' } });
      expect(prepareHumanCaptureCancelV2(setup.graph, request, context)).toEqual({
        kind: 'decision',
        decision: { kind: 'conflict' },
      });
      expect(
        projectHumanCaptureOutcomeV2(
          setup.graph,
          { ...setup.readRequest, issuer: request.issuer },
          context,
        ),
      ).toMatchObject({
        status: 'conflict',
        sourceId: null,
        receiptSummary: null,
        sourcePersistence: 'unknown',
      });
      expect(JSON.stringify(setup.graph)).toBe(before);
    },
  );

  it('keeps namespaces isolated and rejects ambiguous owned source locators', () => {
    const setup = fixture();
    const snapshot = resumeInput(setup);
    expect(
      projectHumanCaptureOutcomeV2(
        setup.graph,
        { ...setup.readRequest, namespace: 'other-namespace' },
        setup.context,
      ),
    ).toMatchObject({ status: 'not_found', sourceId: null, sourcePersistence: 'not_persisted' });
    const duplicate = structuredClone(setup.graph.episodes[0]);
    duplicate.uuid = randomUUID();
    setup.graph.episodes.push(duplicate);
    expect(prepareHumanCaptureResumeV2(setup.graph, setup.request, snapshot.context)).toEqual({
      kind: 'decision',
      decision: { kind: 'conflict' },
    });
    expect(prepareHumanCaptureCancelV2(setup.graph, setup.request, setup.context)).toEqual({
      kind: 'decision',
      decision: { kind: 'conflict' },
    });
    expect(
      projectHumanCaptureOutcomeV2(setup.graph, setup.readRequest, setup.context),
    ).toMatchObject({ status: 'conflict', sourceId: null });
  });

  it('does not allocate a scope at exhausted generation but still permits an authorized abort', () => {
    const setup = fixture();
    const operation = setup.graph.automatic_operations_v1!.operations[0];
    if (operation.version !== 2) throw new Error('Expected V2');
    operation.generation = 2_147_483_647;
    const request = { ...setup.request, expectedGeneration: operation.generation };
    expect(
      prepareHumanCaptureResumeSourceV2(setup.graph, request, {
        storeHash: setup.context.storeHash,
      }),
    ).toEqual({ kind: 'decision', decision: { kind: 'capacity' } });
    expect(
      prepareHumanCaptureResumeV2(setup.graph, request, {
        ...setup.context,
        previousOperation: operation,
        leaseToken: randomUUID(),
      }),
    ).toEqual({ kind: 'decision', decision: { kind: 'capacity' } });
    expect(
      projectHumanCaptureOutcomeV2(setup.graph, setup.readRequest, setup.context),
    ).toMatchObject({ status: 'capacity', sourceId: null, should_process: false });
    expect(prepareHumanCaptureCancelV2(setup.graph, request, setup.context).kind).toBe(
      'prepared_cancel',
    );
  });

  it('retains retry budget and fences callback recovery at the resumed expiry boundary', () => {
    const setup = fixture();
    const operation = setup.graph.automatic_operations_v1!.operations[0];
    if (operation.version !== 2) throw new Error('Expected V2');
    operation.retryCount = 3;
    operation.lastRetryCallHash = 'f'.repeat(64);
    const snapshot = resumeInput(setup);
    const result = prepareHumanCaptureResumeV2(setup.graph, setup.request, snapshot.context);
    if (result.kind !== 'prepared_resume') throw new Error('Expected resume');
    expect(result.leaseFence).toMatchObject({
      retryCount: 3,
      lastRetryCallHash: operation.lastRetryCallHash,
    });
    const resumed = result.graph.automatic_operations_v1!.operations[0];
    if (resumed.version !== 2 || resumed.state !== 'leased')
      throw new Error('Expected resumed lease');
    expect(
      prepareHumanCaptureResumeV2(result.graph, setup.request, {
        ...snapshot.context,
        backendNow: resumed.lease.expiresAt,
      }),
    ).toEqual({ kind: 'decision', decision: { kind: 'fenced' } });
  });

  it('does not return a resume handle basis when authority changes after a durable resume', () => {
    const setup = fixture();
    const snapshot = resumeInput(setup);
    const result = prepareHumanCaptureResumeV2(setup.graph, setup.request, snapshot.context);
    if (result.kind !== 'prepared_resume') throw new Error('Expected resume');
    result.graph.episodes[0].review_status = 'rejected';
    const before = JSON.stringify(result.graph);
    expect(prepareHumanCaptureResumeV2(result.graph, setup.request, snapshot.context)).toEqual({
      kind: 'decision',
      decision: { kind: 'authority_changed' },
    });
    expect(JSON.stringify(result.graph)).toBe(before);
  });

  it('keeps captured generation zero visible but unaddressable by the frozen positive control fence', () => {
    const setup = fixture('captured');
    expect(
      projectHumanCaptureOutcomeV2(setup.graph, setup.readRequest, setup.context),
    ).toMatchObject({ status: 'in_progress', should_process: false });
    expect(
      prepareHumanCaptureResumeSourceV2(setup.graph, setup.request, {
        storeHash: setup.context.storeHash,
      }),
    ).toMatchObject({ decision: { kind: 'fenced' } });
    expect(prepareHumanCaptureCancelV2(setup.graph, setup.request, setup.context)).toMatchObject({
      decision: { kind: 'fenced' },
    });
  });

  it('returns honest commit-time counts after source revocation and later fact rejection', () => {
    const setup = fixture('committed');
    const committed = setup.original.humanOperation;
    if (committed.state !== 'committed') throw new Error('Expected genuine committed fixture');
    (setup.graph.edges[0].attributes.engram_extraction as { review_status: string }).review_status =
      'rejected';
    setup.graph.episodes[0].review_status = 'rejected';
    applyAutomaticBindingCommand(
      setup.graph,
      {
        action: 'revoke',
        namespace: setup.request.namespace,
        bindingId: setup.original.binding.bindingId,
        expectedRevision: setup.original.binding.revision,
        authorizedBy: 'operator',
        reason: 'postcommit test',
      },
      randomUUID(),
      LATER,
    );
    const before = JSON.stringify(setup.graph);
    const result = projectHumanCaptureOutcomeV2(setup.graph, setup.readRequest, setup.context);
    expect(AutomaticCaptureReadResultV2Schema.safeParse(result).success).toBe(true);
    expect(result).toMatchObject({
      status: 'committed_replay',
      should_process: false,
      currentAuthority: 'revoked',
      sourceId: setup.original.human.uuid,
      receiptSummary: {
        persisted: true,
        commitAt: committed.terminalReceipt.terminalAt,
        itemCounts: { accepted: 1, rejected: 0 },
        acceptedCoverage: 'all',
      },
    });
    for (const privateValue of [
      setup.graph.episodes[0].content,
      committed.beginCallHash,
      committed.identity.sourceHash,
    ])
      expect(JSON.stringify(result)).not.toContain(privateValue);
    expect(JSON.stringify(setup.graph)).toBe(before);
  });

  it('requires summary persistence and actual commit time to agree', () => {
    const setup = fixture('committed');
    const summary = projectHumanCaptureOutcomeV2(
      setup.graph,
      setup.readRequest,
      setup.context,
    ).receiptSummary!;
    expect(
      AutomaticCaptureReceiptSummaryV2Schema.safeParse({ ...summary, commitAt: null }).success,
    ).toBe(false);
    expect(
      AutomaticCaptureReceiptSummaryV2Schema.safeParse({ ...summary, persisted: false }).success,
    ).toBe(false);
  });

  it('reports monotonic clock failures without mutation', () => {
    const setup = fixture();
    const snapshot = resumeInput(setup);
    const past = '2026-10-25T11:59:59.999Z';
    const before = JSON.stringify(setup.graph);
    expect(
      prepareHumanCaptureResumeV2(setup.graph, setup.request, {
        ...snapshot.context,
        backendNow: past,
      }),
    ).toMatchObject({ decision: { kind: 'clock_regression' } });
    expect(
      prepareHumanCaptureCancelV2(setup.graph, setup.request, {
        ...setup.context,
        backendNow: past,
      }),
    ).toMatchObject({ decision: { kind: 'clock_regression' } });
    expect(
      projectHumanCaptureOutcomeV2(setup.graph, setup.readRequest, {
        ...setup.context,
        backendNow: past,
      }),
    ).toMatchObject({ status: 'clock_regression', should_process: false });
    expect(JSON.stringify(setup.graph)).toBe(before);
  });

  it('reads immutable committed and cancelled history through a regressed clock without permission', () => {
    const committed = fixture('committed');
    const previous = projectHumanCaptureOutcomeV2(
      committed.graph,
      committed.readRequest,
      committed.context,
    );
    const before = JSON.stringify(committed.graph);
    expect(
      projectHumanCaptureOutcomeV2(committed.graph, committed.readRequest, {
        ...committed.context,
        backendNow: '2026-10-25T11:59:59.000Z',
      }),
    ).toEqual(previous);
    expect(previous).toMatchObject({ status: 'committed_replay', should_process: false });
    expect(JSON.stringify(committed.graph)).toBe(before);
    const pending = fixture();
    const cancellation = prepareHumanCaptureCancelV2(
      pending.graph,
      pending.request,
      pending.context,
    );
    if (cancellation.kind !== 'prepared_cancel') throw new Error('Expected cancellation');
    const cancelledBefore = JSON.stringify(cancellation.graph);
    expect(
      projectHumanCaptureOutcomeV2(cancellation.graph, pending.readRequest, {
        ...pending.context,
        backendNow: NOW,
      }),
    ).toMatchObject({
      status: 'cancelled',
      should_process: false,
      sourceId: pending.original.human.uuid,
      receiptSummary: null,
    });
    expect(JSON.stringify(cancellation.graph)).toBe(cancelledBefore);
  });

  it('shares unique bounded transition audits and truncates without fabricated overflow counts', () => {
    const setup = fixture();
    const operation = setup.graph.automatic_operations_v1!.operations[0];
    operation.attempts = Array.from({ length: 32 }, (_, index) => ({
      attemptHash: index.toString(16).padStart(64, '0'),
      at: NOW,
      disposition: 'claim_won' as const,
    }));
    const snapshot = resumeInput(setup);
    const result = prepareHumanCaptureResumeV2(setup.graph, setup.request, snapshot.context);
    if (result.kind !== 'prepared_resume') throw new Error('Expected resumed candidate');
    expect(result.graph.automatic_operations_v1!.operations[0]).toMatchObject({
      auditTruncated: true,
      overflowCount: 0,
    });
    expect(result.graph.automatic_operations_v1!.operations[0].attempts).toHaveLength(32);
    const request = { ...setup.request, expectedGeneration: 2, attemptIdHash: 'f'.repeat(64) };
    const cancelled = prepareHumanCaptureCancelV2(result.graph, request, setup.context);
    if (cancelled.kind !== 'prepared_cancel') throw new Error('Expected operator cancellation');
    expect(cancelled.graph.automatic_operations_v1!.operations[0]).toMatchObject({
      auditTruncated: true,
      overflowCount: 0,
    });
    expect(cancelled.graph.automatic_operations_v1!.operations[0].attempts).toHaveLength(32);
  });

  it.each(['reused_hash', 'truncated_audit'] as const)(
    'retains expired-lease cause through completion/cancel despite %s',
    (audit) => {
      const setup = fixture('leased');
      const operation = setup.graph.automatic_operations_v1!.operations[0];
      operation.attempts =
        audit === 'reused_hash'
          ? [{ attemptHash: setup.request.attemptIdHash, at: NOW, disposition: 'claim_won' }]
          : Array.from({ length: 32 }, (_, index) => ({
              attemptHash: index.toString(16).padStart(64, '0'),
              at: NOW,
              disposition: 'claim_won' as const,
            }));
      if (operation.version !== 2) throw new Error('Expected V2');
      if (audit === 'truncated_audit') operation.auditTruncated = true;
      const snapshot = resumeInput(setup);
      const atExpiry = { ...snapshot.context, backendNow: '2026-10-25T12:01:00.000Z' };
      const resumed = prepareHumanCaptureResumeV2(setup.graph, setup.request, atExpiry);
      if (resumed.kind !== 'prepared_resume') throw new Error('Expected expired lease resume');
      expect(resumed.graph.automatic_operations_v1!.operations[0]).toMatchObject({
        lastResumeCause: 'lease_expired',
        overflowCount: 0,
      });
      expect(resumed.graph.automatic_operations_v1!.operations[0].attempts).toHaveLength(
        audit === 'reused_hash' ? 1 : 32,
      );
      expect(prepareHumanCaptureResumeV2(resumed.graph, setup.request, atExpiry)).toMatchObject({
        kind: 'prepared_resume',
        writeRequired: false,
      });
      const altered = structuredClone(resumed.graph);
      const alteredOperation = altered.automatic_operations_v1!.operations[0];
      if (alteredOperation.version !== 2) throw new Error('Expected V2');
      alteredOperation.lastResumeCause = 'failed';
      expect(prepareHumanCaptureResumeV2(altered, setup.request, atExpiry)).toEqual({
        kind: 'decision',
        decision: { kind: 'fenced' },
      });

      const handle = setup.registry.recoverOrIssueResume(
        snapshot.invocation.scope,
        resumed.leaseFence,
      )!;
      const capability = setup.registry.consumeForCompletion(handle, 'human_turn_memory');
      const outcome = new ExtractionDiagnostics().finish();
      outcome.status = 'succeeded';
      const plan = planAutomaticClaims(
        resumed.graph,
        setup.request.namespace,
        [resumed.leaseFence.sourceId],
        compileAutomaticPolicy({ profileId: 'conservative' }),
        outcome,
        resumed.leaseFence.planTimestamp,
      );
      const token = prepareHumanCapturePlanV2(plan, setup.registry, capability);
      const later = { ...setup.context, backendNow: '2026-10-25T12:01:01.000Z' };
      const committed = prepareHumanCaptureCompletionV2(
        resumed.graph,
        token,
        setup.registry,
        capability,
        later,
      );
      expect(committed).toMatchObject({
        kind: 'prepared_commit',
        origin: 'resume',
        operation: { lastResumeCause: 'lease_expired' },
      });
      if (committed.kind === 'prepared_commit')
        expect(committed.graph.automatic_operations_v1!.operations[0]).toHaveProperty(
          'lastResumeCause',
          'lease_expired',
        );
      const cancelled = prepareHumanCaptureCancelV2(
        resumed.graph,
        { ...setup.request, expectedGeneration: 2 },
        later,
      );
      if (cancelled.kind !== 'prepared_cancel') throw new Error('Expected cancellation');
      expect(cancelled.graph.automatic_operations_v1!.operations[0]).toHaveProperty(
        'lastResumeCause',
        'lease_expired',
      );
      expect(projectHumanCaptureOutcomeV2(cancelled.graph, setup.readRequest, later)).toMatchObject(
        { status: 'cancelled', should_process: false },
      );
    },
  );

  it('adds no resume cause on old loads and rejects causes before generation two', () => {
    const setup = fixture();
    const operation = setup.graph.automatic_operations_v1!.operations[0];
    expect(
      Object.prototype.hasOwnProperty.call(
        AutomaticCaptureOperationV2Schema.parse(operation),
        'lastResumeCause',
      ),
    ).toBe(false);
    expect(
      AutomaticCaptureOperationV2Schema.safeParse({ ...operation, lastResumeCause: 'failed' })
        .success,
    ).toBe(false);
    const snapshot = resumeInput(setup);
    const result = prepareHumanCaptureResumeV2(setup.graph, setup.request, snapshot.context);
    if (result.kind !== 'prepared_resume') throw new Error('Expected resume');
    const resumed = result.graph.automatic_operations_v1!.operations[0];
    expect(
      AutomaticCaptureOperationV2Schema.safeParse({ ...resumed, lastResumeCause: 'unknown_reason' })
        .success,
    ).toBe(false);
  });

  it('rejects assistant roles before reading the graph and never treats caller booleans as authorization', () => {
    const setup = fixture();
    const snapshot = resumeInput(setup);
    let reads = 0;
    const hostile = Object.defineProperty({}, 'episodes', {
      enumerable: true,
      get() {
        reads++;
        throw new Error('private');
      },
    });
    expect(
      prepareHumanCaptureResumeSourceV2(
        hostile as never,
        { ...setup.request, role: 'assistant' },
        { storeHash: setup.context.storeHash },
      ),
    ).toMatchObject({ decision: { kind: 'unsupported_mode' } });
    expect(
      prepareHumanCaptureResumeV2(
        hostile as never,
        { ...setup.request, role: 'assistant' },
        snapshot.context,
      ),
    ).toMatchObject({ decision: { kind: 'unsupported_mode' } });
    expect(
      prepareHumanCaptureCancelV2(
        hostile as never,
        { ...setup.request, role: 'assistant' },
        setup.context,
      ),
    ).toMatchObject({ decision: { kind: 'unsupported_mode' } });
    expect(
      projectHumanCaptureOutcomeV2(
        hostile as never,
        { ...setup.readRequest, role: 'assistant' },
        setup.context,
      ),
    ).toMatchObject({ status: 'unsupported_mode', should_process: false, sourceId: null });
    expect(
      prepareHumanCaptureCancelV2(
        hostile as never,
        { ...setup.request, authorized: true } as never,
        setup.context,
      ),
    ).toMatchObject({ decision: { kind: 'invalid_input' } });
    expect(reads).toBe(0);
  });

  it('bounds malformed actual graphs without invoking accessors or leaking errors', () => {
    const setup = fixture();
    const snapshot = resumeInput(setup);
    let reads = 0;
    const hostile = Object.defineProperty({}, 'episodes', {
      enumerable: true,
      get() {
        reads++;
        throw new Error('private raw secret');
      },
    });
    expect(prepareHumanCaptureResumeV2(hostile as never, setup.request, snapshot.context)).toEqual({
      kind: 'decision',
      decision: { kind: 'invalid_input' },
    });
    expect(prepareHumanCaptureCancelV2(hostile as never, setup.request, setup.context)).toEqual({
      kind: 'decision',
      decision: { kind: 'invalid_input' },
    });
    expect(
      projectHumanCaptureOutcomeV2(hostile as never, setup.readRequest, setup.context),
    ).toMatchObject({
      status: 'failed',
      sourceId: null,
      sourcePersistence: 'unknown',
      should_process: false,
    });
    expect(reads).toBe(0);
  });

  it('reports a bounded actual snapshot as capacity before traversing oversized record arrays', () => {
    const setup = fixture();
    const snapshot = resumeInput(setup);
    const graph = { ...setup.graph, entities: new Array(100_001) };
    expect(prepareHumanCaptureResumeV2(graph, setup.request, snapshot.context)).toEqual({
      kind: 'decision',
      decision: { kind: 'capacity' },
    });
    expect(prepareHumanCaptureCancelV2(graph, setup.request, setup.context)).toEqual({
      kind: 'decision',
      decision: { kind: 'capacity' },
    });
    expect(projectHumanCaptureOutcomeV2(graph, setup.readRequest, setup.context)).toMatchObject({
      status: 'capacity',
      sourceId: null,
      sourcePersistence: 'unknown',
      should_process: false,
    });
  });

  it.each(['resume', 'read'] as const)(
    'propagates cooperative %s cancellation without publishing state',
    (method) => {
      const setup = fixture();
      const snapshot = resumeInput(setup);
      const before = JSON.stringify(setup.graph);
      const abort = new Error('synthetic control cancellation');
      let calls = 0;
      const check = () => {
        if (++calls === 5) throw abort;
      };
      expect(() =>
        method === 'resume'
          ? prepareHumanCaptureResumeV2(setup.graph, setup.request, snapshot.context, check)
          : projectHumanCaptureOutcomeV2(setup.graph, setup.readRequest, setup.context, check),
      ).toThrow(abort);
      expect(JSON.stringify(setup.graph)).toBe(before);
    },
  );
});
