import { randomUUID } from 'crypto';
import { makeHumanFixture } from '../../helpers/automaticCommittedFixture';
import { ExtractionDiagnostics } from '../../../src/extraction/ExtractionDiagnostics';
import {
  AUTOMATIC_CLAIM,
  committedAutomaticReceipt,
  planAutomaticClaims,
  validateStoredAutomaticClaim,
} from '../../../src/extraction/AutomaticClaims';
import { canonical, graphFingerprint } from '../../../src/extraction/QueueState';
import { AutomaticCaptureTerminalReceiptV2Schema } from '../../../src/schemas/AutomaticCaptureReceipt.schema';
import { AutomaticCaptureOperationV2Schema } from '../../../src/schemas/AutomaticCaptureOperation.schema';
import {
  AutomaticWriteOwnerSchema,
  type AutomaticReceipt,
} from '../../../src/schemas/AutomaticClaim.schema';
import { GraphDataSchema, type StagedExtraction } from '../../../src/schemas';
import { AUTOMATIC_LEDGER_LIMITS } from '../../../src/schemas/AutomaticLedgerPrimitives.schema';
import { buildHumanCaptureSourceV2 } from '../../../src/storage/AutomaticCaptureSource';
import { applyHumanLiteralPlanV2 } from '../../../src/storage/AutomaticCapturePlan';
import {
  AutomaticCaptureLeaseFenceV2Schema,
  createAutomaticCaptureHandleRegistry,
  type PrivateConsumedAutomaticCaptureInvocation,
} from '../../../src/storage/AutomaticCaptureHandles';
import { hashAutomaticCaptureV2 } from '../../../src/schemas/AutomaticCapture.schema';
import { cloneBoundedAutomaticCaptureJson } from '../../../src/storage/BoundedAutomaticCaptureJson';
import {
  assertAutomaticLedgerSourceIntegrity,
  automaticCaptureOperationIdentityForOwnedSource,
  reconcileAutomaticCaptureOperationIdentity,
  WRITE_OWNER_ATTRIBUTE,
} from '../../../src/storage/AutomaticIdentity';

const NOW = '2026-10-25T12:00:00.000Z';
const COMMIT_AT = '2026-10-25T12:00:05.000Z';

function fixture(content: string) {
  const original = makeHumanFixture(`capture-plan-${randomUUID()}`);
  const legacyOwner = AutomaticWriteOwnerSchema.parse(
    original.human.attributes[WRITE_OWNER_ATTRIBUTE],
  );
  const sourceId = randomUUID();
  const operationId = randomUUID();
  const registry = createAutomaticCaptureHandleRegistry();
  const begin = registry.startBegin('human_turn_memory');
  const request = {
    version: 2 as const,
    lifecycle: 'replaySafeV2' as const,
    purpose: 'human_turn_memory' as const,
    namespace: original.human.group_id,
    issuer: legacyOwner.issuer,
    actorReference: legacyOwner.actor,
    turn: `capture-plan-turn-${randomUUID()}`,
    attemptIdHash: 'c'.repeat(64),
    settings: {
      profileId: 'conservative' as const,
      requestedTrustLevel: 'standard' as const,
      intentSetting: false,
      invocationDeadlineMs: 30_000,
    },
    source: {
      content,
      sourceMessageId: `capture-plan-message-${randomUUID()}`,
      conversationId: 'synthetic-capture-plan-conversation',
      senderId: legacyOwner.actor,
      senderName: 'Synthetic source display',
      sourceWorkflowId: 'synthetic-original-producer',
      originalSourceExecutionId: 'synthetic-original-execution',
      sourceType: 'message' as const,
      quotedMessageId: null,
      eventTime: { mode: 'first_capture' as const },
      applicationOwnedWrapper: null,
      humanRegion: null,
      quoteRegions: [],
    },
  };
  const built = buildHumanCaptureSourceV2(original.graph, {
    request,
    sourceId,
    storeHash: legacyOwner.store,
    capturedAt: NOW,
    previousEpisodeId: original.human.uuid,
  });
  const leaseMs = Math.min(
    AUTOMATIC_LEDGER_LIMITS.maxLeaseMs,
    Math.max(
      built.descriptor.invocationDeadlineMs + AUTOMATIC_LEDGER_LIMITS.storageGraceMs,
      AUTOMATIC_LEDGER_LIMITS.minLeaseMs,
    ),
  );
  const expiresAt = new Date(Date.parse(NOW) + leaseMs).toISOString();
  const descriptorHash = hashAutomaticCaptureV2(built.descriptor);
  const fence = AutomaticCaptureLeaseFenceV2Schema.parse({
    purpose: 'human_turn_memory',
    operationId,
    sourceId,
    descriptorHash,
    identityHash: hashAutomaticCaptureV2(built.identity),
    beginCallHash: begin.beginCallHash,
    state: 'leased',
    generation: 1,
    token: begin.leaseToken,
    claimKind: 'initial',
    retryCount: 0,
    planTimestamp: NOW,
  });
  const operation = AutomaticCaptureOperationV2Schema.parse({
    version: 2,
    operationId,
    identity: built.identity,
    descriptor: built.descriptor,
    createdAt: NOW,
    lastObservedAt: NOW,
    attempts: [],
    overflowCount: 0,
    beginCallHash: begin.beginCallHash,
    retryCount: 0,
    state: 'leased',
    generation: 1,
    lease: {
      token: begin.leaseToken,
      acquiredAt: NOW,
      renewedAt: NOW,
      expiresAt,
      claimKind: 'initial',
    },
  });
  const handle = registry.recoverOrIssueInitial(begin.scope, fence);
  if (!handle) throw new Error('Failed to prepare a synthetic consumed invocation');
  const capability = registry.consumeForCompletion(handle, 'human_turn_memory');

  const graph = GraphDataSchema.parse({
    ...original.graph,
    episodes: [...original.graph.episodes, built.episode],
    automatic_operations_v1: {
      ...original.graph.automatic_operations_v1!,
      operations: [...original.graph.automatic_operations_v1!.operations, operation],
    },
  });
  const outcome = new ExtractionDiagnostics().finish();
  outcome.status = 'succeeded';
  const plan = planAutomaticClaims(
    graph,
    request.namespace,
    [sourceId],
    built.descriptor.policy!,
    outcome,
    NOW,
  );
  return { graph, plan, registry, capability, operation, built, sourceId, request };
}

function apply(f: ReturnType<typeof fixture>, graph = f.graph, plan = f.plan): StagedExtraction {
  return applyHumanLiteralPlanV2(graph, plan, f.registry, f.capability);
}

function completeReceipt(f: ReturnType<typeof fixture>, plan: StagedExtraction): void {
  committedAutomaticReceipt(plan.outcome, COMMIT_AT);
  const receipt = plan.outcome.automatic as AutomaticReceipt;
  const accepted = receipt.items.filter(
    (item) => item.persisted && ['accepted', 'unchanged'].includes(item.state),
  );
  const terminalReceipt = AutomaticCaptureTerminalReceiptV2Schema.parse({
    version: 2,
    kind: 'human_capture_committed',
    operationId: f.operation.operationId,
    sourceId: f.sourceId,
    sourceHash: f.built.identity.sourceHash,
    descriptorHash: hashAutomaticCaptureV2(f.built.descriptor),
    terminalAt: COMMIT_AT,
    receiptInspectionComplete: receipt.coverageComplete,
    interpretationCoverage: accepted.length > 0 ? 'complete' : 'none',
    acceptedCoverage:
      accepted.length === 0 ? 'none' : accepted.length === receipt.items.length ? 'all' : 'partial',
    dependencies: receipt.items.map((item, itemIndex) => ({
      sourceId: f.sourceId,
      dependencyHash: hashAutomaticCaptureV2({
        sourceId: f.sourceId,
        sourceHash: f.built.identity.sourceHash,
        itemIndex,
        item,
      }),
      itemIndex,
      ...(item.claimId === undefined ? {} : { claimId: item.claimId }),
      state: item.state,
      persisted: item.persisted,
      reasons: item.reasons,
    })),
    receipt,
  });
  if (f.operation.state !== 'leased') throw new Error('Expected leased fixture operation');
  const base: Record<string, unknown> = { ...f.operation };
  delete base.lease;
  const committed = AutomaticCaptureOperationV2Schema.parse({
    ...base,
    state: 'committed',
    lastObservedAt: COMMIT_AT,
    terminalReceipt,
    completionCallHash: f.registry.readConsumedInvocation(f.capability, 'human_turn_memory')
      .completionCallHash,
  });
  const index = f.graph.automatic_operations_v1!.operations.findIndex(
    (operation) => operation.operationId === f.operation.operationId,
  );
  f.graph.automatic_operations_v1!.operations[index] = committed;
  const finalized = GraphDataSchema.parse(f.graph);
  const claimId = receipt.items.find((item) => item.claimId)?.claimId;
  const persistedEdge = finalized.edges.find((edge) => edge.uuid === claimId);
  expect(persistedEdge).toBeDefined();
  expect(validateStoredAutomaticClaim(finalized, persistedEdge!)).toBe(true);
}

describe('pure V2 literal capture plan application', () => {
  it('applies only fresh literal creations and validates the committed receipt dependency', () => {
    const f = fixture('I prefer bullet points.');
    const beforeEntityIds = new Set(f.graph.entities.map((entity) => entity.uuid));
    const beforeEdgeIds = new Set(f.graph.edges.map((edge) => edge.uuid));
    expect(f.plan.entities.length).toBeGreaterThan(0);
    expect(f.plan.edges.length).toBeGreaterThan(0);

    const validatedPlan = apply(f);

    expect(f.graph.entities.every((entity) => beforeEntityIds.has(entity.uuid))).toBe(false);
    expect(f.graph.edges.every((edge) => beforeEdgeIds.has(edge.uuid))).toBe(false);
    expect(f.graph.entities.slice(0, beforeEntityIds.size).map((item) => item.uuid)).toEqual([
      ...beforeEntityIds,
    ]);
    completeReceipt(f, validatedPlan);
  });

  it('leaves reused claim rows unchanged for an already-stored literal claim', () => {
    const f = fixture('I prefer concise explanations.');
    expect(f.plan.entities).toHaveLength(0);
    expect(f.plan.edges).toHaveLength(0);
    expect(f.plan.outcome.automatic?.items[0]).toMatchObject({
      state: 'unchanged',
      persisted: true,
      mutation: 'none',
    });
    const originalEntities = canonical(f.graph.entities);
    const originalEdges = canonical(f.graph.edges);

    const validatedPlan = apply(f);

    expect(canonical(f.graph.entities)).toBe(originalEntities);
    expect(canonical(f.graph.edges)).toBe(originalEdges);
    completeReceipt(f, validatedPlan);
  });

  it('detaches published claim, quality, literal and receipt objects from the caller plan', () => {
    const f = fixture('I prefer bullet points.');
    const validatedPlan = apply(f);
    const edgeId = validatedPlan.edges[0].uuid;
    const entityId = validatedPlan.entities[0].uuid;
    const beforeEntity = structuredClone(
      f.graph.entities.find((entity) => entity.uuid === entityId),
    );
    const beforeEdge = structuredClone(f.graph.edges.find((edge) => edge.uuid === edgeId));
    const safeReceiptBefore = canonical(validatedPlan.outcome.automatic);

    (f.plan.entities[0].attributes.engram_literal_v1 as Record<string, unknown>).literal =
      'mutated caller literal';
    const claim = f.plan.edges[0].attributes[AUTOMATIC_CLAIM] as {
      claim: { literal: string };
    };
    claim.claim.literal = 'mutated caller claim';
    const quality = f.plan.edges[0].attributes.engram_memory_quality as {
      evidence: Array<{ start: number; end: number }>;
    };
    quality.evidence[0].start += 1;
    f.plan.outcome.automatic!.items[0].reasons[0] = 'binding_changed';

    expect(f.graph.entities.find((entity) => entity.uuid === entityId)).toEqual(beforeEntity);
    expect(f.graph.edges.find((edge) => edge.uuid === edgeId)).toEqual(beforeEdge);
    expect(canonical(validatedPlan.outcome.automatic)).toBe(safeReceiptBefore);

    (validatedPlan.entities[0].attributes.engram_literal_v1 as Record<string, unknown>).literal =
      'mutated returned plan literal';
    const returnedClaim = validatedPlan.edges[0].attributes[AUTOMATIC_CLAIM] as {
      claim: { literal: string };
    };
    returnedClaim.claim.literal = 'mutated returned plan claim';
    expect(f.graph.entities.find((entity) => entity.uuid === entityId)).toEqual(beforeEntity);
    expect(f.graph.edges.find((edge) => edge.uuid === edgeId)).toEqual(beforeEdge);
    completeReceipt(f, validatedPlan);
  });

  it('validates a no-output plan at the private lease timestamp without a caller clock', () => {
    const f = fixture('Hello, this is a neutral update.');
    expect(f.plan.entities).toHaveLength(0);
    expect(f.plan.edges).toHaveLength(0);
    const before = canonical(f.graph);

    apply(f);

    expect(canonical(f.graph)).toBe(before);
  });

  it('allows the same consumed capability on an identical rolled-back callback snapshot', () => {
    const f = fixture('I prefer bullet points.');
    const original = GraphDataSchema.parse(f.graph);
    const firstCallbackGraph = GraphDataSchema.parse(original);
    const retryCallbackGraph = GraphDataSchema.parse(original);

    apply(f, firstCallbackGraph);
    apply(f, retryCallbackGraph);

    expect(firstCallbackGraph.entities).toEqual(retryCallbackGraph.entities);
    expect(firstCallbackGraph.edges).toEqual(retryCallbackGraph.edges);
  });

  it('keeps the private identity hash pinned while reconciling mutable source projection separately', () => {
    const f = fixture('I prefer bullet points.');
    const invocation = f.registry.readConsumedInvocation(f.capability, 'human_turn_memory');
    const capturedIdentityHash = hashAutomaticCaptureV2(f.operation.identity);
    expect(invocation.boundFence.identityHash).toBe(capturedIdentityHash);

    const mutableSource = structuredClone(f.built.episode);
    mutableSource.sender_name = 'Updated display';
    mutableSource.trust_level = 'untrusted';
    mutableSource.review_status = 'rejected';
    const currentProjection = automaticCaptureOperationIdentityForOwnedSource(
      mutableSource,
      f.operation.descriptor,
    );

    expect(hashAutomaticCaptureV2(currentProjection)).not.toBe(capturedIdentityHash);
    expect(
      reconcileAutomaticCaptureOperationIdentity(currentProjection, f.operation.identity),
    ).toEqual(f.operation.identity);
    expect(invocation.boundFence.identityHash).toBe(capturedIdentityHash);
  });

  it('rejects a coherent owner, source and operation identity rewrite made under an old handle', () => {
    const f = fixture('I prefer bullet points.');
    const operations = f.graph.automatic_operations_v1!.operations;
    const withoutCapturedSourceAndOperation = GraphDataSchema.parse({
      ...f.graph,
      episodes: f.graph.episodes.filter((episode) => episode.uuid !== f.sourceId),
      automatic_operations_v1: {
        version: 1,
        operations: operations.filter(
          (operation) => operation.operationId !== f.operation.operationId,
        ),
      },
    });
    const rewrittenRequest = structuredClone(f.request);
    rewrittenRequest.source.content = 'I prefer serif typefaces.';
    const rewrittenSource = buildHumanCaptureSourceV2(withoutCapturedSourceAndOperation, {
      request: rewrittenRequest,
      sourceId: f.sourceId,
      storeHash: f.operation.identity.storeHash,
      capturedAt: NOW,
      previousEpisodeId: f.built.episode.previous_episode_uuid,
    });
    const rewrittenOperation = AutomaticCaptureOperationV2Schema.parse({
      ...f.operation,
      identity: rewrittenSource.identity,
    });
    const rewrittenGraph = GraphDataSchema.parse({
      ...withoutCapturedSourceAndOperation,
      episodes: [...withoutCapturedSourceAndOperation.episodes, rewrittenSource.episode],
      automatic_operations_v1: {
        version: 1,
        operations: [
          ...withoutCapturedSourceAndOperation.automatic_operations_v1!.operations,
          rewrittenOperation,
        ],
      },
    });
    assertAutomaticLedgerSourceIntegrity(rewrittenGraph);
    expect(hashAutomaticCaptureV2(rewrittenOperation.identity)).not.toBe(
      f.registry.readConsumedInvocation(f.capability, 'human_turn_memory').boundFence.identityHash,
    );
    const before = canonical(rewrittenGraph);

    expect(() => apply(f, rewrittenGraph)).toThrow('invalid_plan');
    expect(canonical(rewrittenGraph)).toBe(before);
  });

  it.each(['entity', 'edge', 'episode'] as const)(
    'rejects top-level __proto__ metadata on a stored %s before plan mutation',
    (recordKind) => {
      const f = fixture('I prefer bullet points.');
      const record =
        recordKind === 'entity'
          ? f.graph.entities[0]
          : recordKind === 'edge'
            ? f.graph.edges[0]
            : f.graph.episodes[0];
      const special = JSON.parse('{"__proto__":{"synthetic":"preserve"}}') as Record<
        string,
        unknown
      >;
      record.attributes = { ...record.attributes, ...special };
      expect(Object.prototype.hasOwnProperty.call(record.attributes, '__proto__')).toBe(true);
      const before = canonical(f.graph);

      expect(() => apply(f)).toThrow('invalid_plan');
      expect(canonical(f.graph)).toBe(before);
    },
  );

  it('rejects replay after the graph has changed and leaves the changed graph untouched', () => {
    const f = fixture('I prefer bullet points.');
    apply(f);
    f.graph.metadata = { ...f.graph.metadata, extraction_epoch: randomUUID() };
    const before = canonical(f.graph);

    expect(() => apply(f)).toThrow('invalid_plan');

    expect(canonical(f.graph)).toBe(before);
  });

  it.each(['fake', 'copied', 'cross-registry', 'wrong-purpose'] as const)(
    'rejects a %s consumed capability before mutation',
    (mutation) => {
      const f = fixture('I prefer bullet points.');
      const before = canonical(f.graph);
      let capability: unknown = f.capability;
      let registry = f.registry;
      if (mutation === 'fake') capability = Object.freeze(Object.create(null));
      if (mutation === 'copied') capability = { ...f.capability };
      if (mutation === 'cross-registry') registry = createAutomaticCaptureHandleRegistry();
      if (mutation === 'wrong-purpose') {
        const begin = f.registry.startBegin('assistant_final_save');
        const assistantFence = AutomaticCaptureLeaseFenceV2Schema.parse({
          purpose: 'assistant_final_save',
          operationId: randomUUID(),
          sourceId: randomUUID(),
          descriptorHash: 'a'.repeat(64),
          identityHash: 'f'.repeat(64),
          beginCallHash: begin.beginCallHash,
          state: 'leased',
          generation: 1,
          token: begin.leaseToken,
          claimKind: 'initial',
          retryCount: 0,
          planTimestamp: NOW,
        });
        const assistantHandle = f.registry.recoverOrIssueInitial(begin.scope, assistantFence);
        if (!assistantHandle) throw new Error('Expected synthetic assistant handle');
        capability = f.registry.consumeForCompletion(
          assistantHandle,
          'assistant_final_save',
        ) as unknown as PrivateConsumedAutomaticCaptureInvocation<'human_turn_memory'>;
      }

      expect(() =>
        applyHumanLiteralPlanV2(
          f.graph,
          f.plan,
          registry,
          capability as PrivateConsumedAutomaticCaptureInvocation<'human_turn_memory'>,
        ),
      ).toThrow('invalid_handle');
      expect(canonical(f.graph)).toBe(before);
    },
  );

  it.each(['stale-graph', 'source-hash', 'binding', 'renewed-fence'] as const)(
    'rejects %s plan context without partial graph mutation',
    (mutation) => {
      const f = fixture('I prefer bullet points.');
      const plan = structuredClone(f.plan);
      if (mutation === 'stale-graph') {
        f.graph.entities[0].summary = 'Changed after planning';
      }
      if (mutation === 'source-hash') {
        plan.source_guards[0].hash = 'd'.repeat(64);
      }
      if (mutation === 'binding') {
        f.graph.entities[0].attributes.engram_actor_bindings_v1 = [];
        plan.graph_hash = graphFingerprint(f.graph, plan.group_id);
      }
      if (mutation === 'renewed-fence') {
        const stored = f.graph.automatic_operations_v1!.operations.find(
          (operation) => operation.operationId === f.operation.operationId,
        );
        if (!stored || stored.version !== 2 || stored.state !== 'leased') {
          throw new Error('Expected the synthetic leased operation');
        }
        stored.lastObservedAt = COMMIT_AT;
        stored.lease.renewedAt = COMMIT_AT;
        stored.lease.expiresAt = new Date(
          Date.parse(COMMIT_AT) +
            Math.min(
              AUTOMATIC_LEDGER_LIMITS.maxLeaseMs,
              Math.max(
                stored.descriptor.invocationDeadlineMs + AUTOMATIC_LEDGER_LIMITS.storageGraceMs,
                AUTOMATIC_LEDGER_LIMITS.minLeaseMs,
              ),
            ),
        ).toISOString();
      }
      const before = canonical(f.graph);

      expect(() => apply(f, f.graph, plan)).toThrow();

      expect(canonical(f.graph)).toBe(before);
    },
  );

  it('rejects existing-row replacement and cross-kind UUID collisions before publishing', () => {
    const f = fixture('I prefer bullet points.');
    const plan = structuredClone(f.plan);
    plan.entities[0] = { ...plan.entities[0], uuid: f.graph.edges[0].uuid };
    const before = canonical(f.graph);

    expect(() => apply(f, f.graph, plan)).toThrow('invalid_plan');

    expect(canonical(f.graph)).toBe(before);
  });

  it('does not partially append a valid entity when a later staged edge is invalid', () => {
    const f = fixture('I prefer bullet points.');
    const plan = structuredClone(f.plan);
    plan.edges[0].target_node_uuid = randomUUID();
    const before = canonical(f.graph);

    expect(() => apply(f, f.graph, plan)).toThrow('invalid_plan');

    expect(canonical(f.graph)).toBe(before);
  });

  it('does not accept an additional source guard', () => {
    const f = fixture('I prefer bullet points.');
    const plan = structuredClone(f.plan);
    plan.source_guards.push({ uuid: f.built.episode.uuid, hash: 'e'.repeat(64) });
    const before = canonical(f.graph);

    expect(() => apply(f, f.graph, plan)).toThrow('invalid_plan');

    expect(canonical(f.graph)).toBe(before);
  });

  it('clones valid escaped request and a graph with 100,000 records under separate bounds', () => {
    const escapedRequest = cloneBoundedAutomaticCaptureJson<{ content: string }>(
      { content: '\u0001'.repeat(65_536) },
      'beginRequest',
    );
    expect(escapedRequest.content).toHaveLength(65_536);

    const graphInput = { entities: [], edges: [], episodes: new Array(100_000).fill(null) };
    const graphCopy = cloneBoundedAutomaticCaptureJson<typeof graphInput>(graphInput, 'graph');
    expect(graphCopy.episodes).toHaveLength(100_000);
    expect(graphCopy).not.toBe(graphInput);
    expect(graphCopy.episodes).not.toBe(graphInput.episodes);
    expect(() =>
      cloneBoundedAutomaticCaptureJson(
        { entities: [], edges: [], episodes: new Array(100_001).fill(null) },
        'graph',
      ),
    ).toThrow('bounded_json_invalid');
  });

  it.each(['accessor', 'toJSON', 'cycle', 'proxy', 'sparse-array'] as const)(
    'rejects %s plan input without executing it or mutating the graph',
    (mutation) => {
      const f = fixture('I prefer bullet points.');
      const plan = structuredClone(f.plan) as StagedExtraction & Record<string, unknown>;
      let getterCalled = false;
      if (mutation === 'accessor') {
        Object.defineProperty(plan.entities[0].attributes, 'unsafe', {
          enumerable: true,
          get() {
            getterCalled = true;
            return true;
          },
        });
      }
      if (mutation === 'toJSON') {
        Object.defineProperty(plan.outcome, 'toJSON', {
          enumerable: false,
          value() {
            getterCalled = true;
            return {};
          },
        });
      }
      if (mutation === 'cycle') {
        (plan.outcome as Record<string, unknown>).cycle = plan;
      }
      if (mutation === 'sparse-array') plan.entities = new Array(1) as typeof plan.entities;
      const suppliedPlan: unknown = mutation === 'proxy' ? new Proxy(plan, {}) : plan;
      const before = canonical(f.graph);

      expect(() =>
        applyHumanLiteralPlanV2(
          f.graph,
          suppliedPlan as StagedExtraction,
          f.registry,
          f.capability,
        ),
      ).toThrow('invalid_plan');

      expect(getterCalled).toBe(false);
      expect(canonical(f.graph)).toBe(before);
    },
  );
});
