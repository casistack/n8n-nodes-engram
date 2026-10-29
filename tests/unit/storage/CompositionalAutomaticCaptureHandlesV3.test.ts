import { createHash, randomUUID } from 'crypto';
import { makeHumanFixture } from '../../helpers/automaticCommittedFixture';
import { makeCompositionalCommittedClaimFixture } from '../../helpers/compositionalCommittedClaimFixture';
import { buildCompositionalHumanCaptureSourceV3 } from '../../../src/storage/CompositionalAutomaticCaptureSourceV3';
import {
  CompositionalAutomaticCaptureOperationV3Schema,
  CompositionalAutomaticCaptureTerminalReceiptV3Schema,
  compositionalCaptureOperationIdentityHashV3,
} from '../../../src/schemas/CompositionalAutomaticCaptureV3.schema';
import { GraphDataSchema, type GraphData } from '../../../src/schemas/GraphData.schema';
import { compileCompositionalAutomaticDescriptorV3 } from '../../../src/schemas/CompositionalAutomaticMemory.schema';
import { AUTOMATIC_LEDGER_LIMITS } from '../../../src/schemas/AutomaticLedgerPrimitives.schema';
import { z } from 'zod';
import { performance } from 'perf_hooks';
import { interpretCompositionalHumanSourceV3EvidenceWithExecutionReport } from '../../../src/extraction/CompositionalAutomaticCaptureV3Evidence';
import type { CompositionalCaptureWorkBudgetV3 } from '../../../src/schemas/CompositionalCaptureWorkBudgetV3.schema';
import * as RegistrySchemas from '../../../src/schemas/CompositionalAutomaticCaptureRegistryV3.schema';
import {
  createCompositionalAutomaticCaptureHandleRegistryV3,
  isCompositionalFirstCommitResultForHandleV3 as authenticResult,
  type CompositionalAutomaticCaptureHandleRegistryV3,
} from '../../../src/storage/CompositionalAutomaticCaptureHandlesV3';

const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const TEST_NOW = '2026-10-25T12:00:00.000Z';
type V3Operation = z.infer<typeof CompositionalAutomaticCaptureOperationV3Schema>;
type LeasedV3Operation = Extract<V3Operation, { state: 'leased' }>;
type CommittedV3Operation = Extract<V3Operation, { state: 'committed' }>;

function baseGraph(namespace: string): { graph: GraphData; issuer: string; actor: string } {
  const existing = makeHumanFixture(namespace);
  return {
    graph: GraphDataSchema.parse({
      version: '2.0',
      exported_at: TEST_NOW,
      group_id: namespace,
      entities: existing.graph.entities,
      edges: [],
      episodes: [],
    }),
    issuer: 'synthetic-workflow',
    actor: 'synthetic-human-actor',
  };
}

function makeRequest(
  namespace: string,
  issuer: string,
  actorReference: string,
  turn: string,
  content = 'I prefer concise explanations.',
) {
  return {
    version: 3 as const,
    lifecycle: 'replaySafeV2' as const,
    purpose: 'human_turn_memory' as const,
    preferenceInterpreter: 'compositionalV2' as const,
    namespace,
    issuer,
    actorReference,
    turn,
    settings: {
      profileId: 'conservative' as const,
      requestedTrustLevel: 'standard' as const,
      intentSetting: false,
      invocationDeadlineMs: 30_000,
    },
    source: {
      content,
      sourceMessageId: 'synthetic-v3-message',
      conversationId: 'synthetic-v3-conversation',
      senderId: 'synthetic-v3-sender',
      senderName: 'Synthetic V3 display',
      sourceWorkflowId: 'synthetic-v3-producer',
      originalSourceExecutionId: 'synthetic-v3-original-execution',
      sourceType: 'message' as const,
      quotedMessageId: null,
      eventTime: { mode: 'first_capture' as const },
      applicationOwnedWrapper: null,
      humanRegion: null,
      quoteRegions: [],
    },
    attemptIdHash: hash('synthetic-v3-attempt'),
  };
}

function leasedOperation(
  begin: ReturnType<CompositionalAutomaticCaptureHandleRegistryV3['startInitialBegin']>,
  built: ReturnType<typeof buildCompositionalHumanCaptureSourceV3>,
  at = TEST_NOW,
  generation = 1,
  claimKind: 'initial' | 'resume' = 'initial',
  retryCount = 0,
  lastRetryCallHash?: string,
): LeasedV3Operation {
  const durationMs = Math.min(
    AUTOMATIC_LEDGER_LIMITS.maxLeaseMs,
    Math.max(
      built.descriptor.invocationDeadlineMs + AUTOMATIC_LEDGER_LIMITS.storageGraceMs,
      AUTOMATIC_LEDGER_LIMITS.minLeaseMs,
    ),
  );
  const parsed = CompositionalAutomaticCaptureOperationV3Schema.parse({
    version: 3,
    operationId: begin.operationId,
    identity: built.identity,
    descriptor: built.descriptor,
    createdAt: TEST_NOW,
    lastObservedAt: at,
    attempts: [],
    overflowCount: 0,
    beginCallHash: begin.beginCallHash,
    retryCount,
    ...(lastRetryCallHash === undefined ? {} : { lastRetryCallHash }),
    ...(generation > 1 ? { lastResumeCause: 'failed' as const } : {}),
    state: 'leased',
    generation,
    lease: {
      token: begin.leaseToken,
      acquiredAt: at,
      renewedAt: at,
      expiresAt: new Date(Date.parse(at) + durationMs).toISOString(),
      claimKind,
    },
  });
  if (parsed.state !== 'leased') throw new Error('Expected leased operation');
  return parsed;
}

function actualSnapshot(
  graph: GraphData,
  operation: ReturnType<typeof CompositionalAutomaticCaptureOperationV3Schema.parse>,
  backendNow: string,
  storeHash = operation.identity.storeHash,
) {
  const graphWithStoredOperation = GraphDataSchema.parse({
    ...graph,
    automatic_operations_v1: {
      version: 1,
      operations: [...(graph.automatic_operations_v1?.operations ?? []), operation],
    },
  });
  return {
    storeHash,
    namespace: operation.identity.namespace,
    backendNow,
    graph: graphWithStoredOperation,
    operation,
  };
}

function buildInitial(
  budget?: CompositionalCaptureWorkBudgetV3,
  content = 'I prefer concise explanations.',
) {
  const namespace = `v3-registry-${randomUUID()}`;
  const { graph, issuer, actor } = baseGraph(namespace);
  const request = makeRequest(namespace, issuer, actor, `turn-${randomUUID()}`, content);
  const registry = createCompositionalAutomaticCaptureHandleRegistryV3();
  const descriptor = compileCompositionalAutomaticDescriptorV3({
    profileId: request.settings.profileId,
    requestedTrustLevel: request.settings.requestedTrustLevel,
    intentSetting: request.settings.intentSetting,
    invocationDeadlineMs: request.settings.invocationDeadlineMs,
  });
  const begin = registry.startInitialBegin(request.attemptIdHash, descriptor, budget);
  const built = buildCompositionalHumanCaptureSourceV3(graph, {
    sourceId: begin.sourceId,
    storeHash: hash('v3 synthetic store'),
    capturedAt: TEST_NOW,
    previousEpisodeId: null,
    request,
  });
  const withSource = GraphDataSchema.parse({
    ...graph,
    episodes: [...graph.episodes, built.episode],
  });
  const operation = leasedOperation(begin, built);
  operation.attempts.push({
    attemptHash: request.attemptIdHash,
    at: operation.createdAt,
    disposition: 'claim_won',
  });
  return {
    registry,
    begin,
    built,
    graph: withSource,
    operation,
    actual: actualSnapshot(withSource, operation, TEST_NOW),
    initialAttemptHash: request.attemptIdHash,
    request,
  };
}

function committedOperation(
  operation: V3Operation,
  completionCallHash: string,
  terminalAt: string,
  suppliedReceipt?: unknown,
): CommittedV3Operation {
  if (operation.state !== 'leased') throw new Error('Expected leased operation');
  const { lease: _lease, ...common } = operation;
  void _lease;
  const terminalReceipt = CompositionalAutomaticCaptureTerminalReceiptV3Schema.parse(
    suppliedReceipt ?? {
      version: 3,
      kind: 'human_compositional_source_verdict_committed',
      operationId: operation.operationId,
      sourceId: operation.identity.sourceId,
      sourceHash: operation.identity.sourceHash,
      descriptorHash: operation.identity.descriptorHash,
      policyFingerprint: operation.descriptor.policy.fingerprint,
      terminalAt,
      reasons: [],
      interpretationCoverage: 'none',
      acceptedCoverage: 'none',
      selection: {
        kind: 'source_verdict',
        verdict: 'no_supported_preference_detected',
        interpreterResultHash: hash('actual interpreter result'),
      },
    },
  );
  const parsed = CompositionalAutomaticCaptureOperationV3Schema.parse({
    ...common,
    state: 'committed',
    lastObservedAt: terminalAt,
    completionCallHash,
    terminalReceipt,
  });
  if (parsed.state !== 'committed') throw new Error('Expected committed operation');
  return parsed;
}

function hiddenFrozen(value: object): void {
  expect(Object.isFrozen(value)).toBe(true);
  expect(Reflect.ownKeys(value)).toEqual([]);
  expect(Object.getPrototypeOf(value)).toBeNull();
}

describe('private compositional V3 capture registry', () => {
  it('authenticates the exact live result against its original consumed handle without minting authority', () => {
    const create = () => {
      const f = buildInitial(undefined, 'What games are on today?');
      const handle = f.registry.issueInitialAfterAcknowledgedBegin(f.begin.scope, f.actual);
      if (!handle) throw new Error('Expected handle');
      const cap = f.registry.consumeForCompletion(handle, hash('exact result handle pair'));
      const invocation = f.registry.readConsumedInvocation(cap);
      const witness = f.registry.prepareSourceVerdictWitness(cap, f.actual);
      if (!witness) throw new Error('Expected witness');
      const terminalAt = new Date(Date.parse(TEST_NOW) + 1000).toISOString();
      const receipt = f.registry.prepareSourceVerdictReceipt(
        cap,
        witness,
        actualSnapshot(f.graph, f.operation, terminalAt),
      );
      if (!receipt) throw new Error('Expected receipt');
      const operation = committedOperation(
        f.operation,
        invocation.completionCallHash,
        terminalAt,
        receipt,
      );
      const proof = f.registry.confirmInitialCommitAfterAcknowledgement(
        cap,
        actualSnapshot(f.graph, operation, terminalAt),
      );
      if (!proof) throw new Error('Expected proof');
      const result = f.registry.createInitialFirstCommitResult(proof);
      if (!result) throw new Error('Expected result');
      return { ...f, handle, cap, result };
    };
    const a = create();
    const b = create();
    expect(authenticResult(a.result, a.handle)).toBe(true);
    expect(authenticResult(a.result, b.handle)).toBe(false);
    expect(authenticResult(b.result, a.handle)).toBe(false);
    expect(authenticResult(structuredClone(a.result), a.handle)).toBe(false);
    expect(authenticResult(a.result, structuredClone(a.handle))).toBe(false);
    let traps = 0;
    const hostile = new Proxy({}, { get: () => ++traps });
    expect(authenticResult(hostile, a.handle)).toBe(false);
    expect(authenticResult(a.result, hostile)).toBe(false);
    expect(traps).toBe(0);
    const clock = jest.spyOn(performance, 'now').mockReturnValue(performance.now() + 120_001);
    try {
      expect(authenticResult(a.result, a.handle)).toBe(false);
    } finally {
      clock.mockRestore();
    }
    expect(authenticResult(a.result, a.handle)).toBe(false);
    expect(a.registry.resultSchemas().completion.safeParse(a.result).success).toBe(false);
    a.registry.markInvocationCancelled(a.cap);
    expect(authenticResult(a.result, a.handle)).toBe(false);
    expect(authenticResult(b.result, b.handle)).toBe(true);
    b.registry.markInvocationCancelled(b.cap);
    expect(authenticResult(b.result, b.handle)).toBe(false);
  });

  it.each(['prepare', 'apply'] as const)(
    'owns graph input before Zod can inspect then/getters/proxies during %s',
    (phase) => {
      for (const kind of ['then', 'field', 'proxy'] as const) {
        const f = buildInitial();
        const handle = f.registry.issueInitialAfterAcknowledgedBegin(f.begin.scope, f.actual);
        if (!handle) throw new Error('Expected handle');
        const cap = f.registry.consumeForCompletion(handle, hash(`raw graph ${phase} ${kind}`));
        const prepared =
          phase === 'apply'
            ? f.registry.prepareBundleStage(cap, f.actual, { remaining: 512, deferred: 0 })
            : null;
        if (prepared && prepared.status !== 'prepared_stage')
          throw new Error(JSON.stringify(prepared));
        let traps = 0;
        const graph =
          kind === 'proxy'
            ? new Proxy(
                {},
                {
                  get: () => ++traps,
                  ownKeys: () => {
                    ++traps;
                    return [];
                  },
                },
              )
            : Object.defineProperty({}, kind === 'then' ? 'then' : 'entities', {
                enumerable: true,
                get: () => ++traps,
              });
        const hostileActual = { ...f.actual, graph };
        const result =
          phase === 'prepare'
            ? f.registry.prepareBundleStage(cap, hostileActual, { remaining: 512, deferred: 0 })
            : f.registry.prepareBundleApply(
                cap,
                prepared && prepared.status === 'prepared_stage' ? prepared.stage : null,
                hostileActual,
              );
        expect(result).toEqual({ status: 'deferred', reason: 'invalid_snapshot' });
        expect(traps).toBe(0);
        expect(() => f.registry.readActiveConsumedInvocation(cap)).toThrow('invalid_handle');
      }
    },
  );

  it.each(['complete', 'missing_rows', 'wrong_receipt'] as const)(
    'requires its internally verified stage and actual committed rows (%s)',
    (mode) => {
      const f = buildInitial(undefined, 'I prefer concise explanations.');
      const handle = f.registry.issueInitialAfterAcknowledgedBegin(f.begin.scope, f.actual);
      if (!handle) throw new Error('Expected handle');
      const cap = f.registry.consumeForCompletion(handle, hash(`bundle proof ${mode}`));
      const prepared = f.registry.prepareBundleStage(cap, f.actual, {
        remaining: 512,
        deferred: 0,
      });
      expect(prepared.status).toBe('prepared_stage');
      if (prepared.status !== 'prepared_stage') throw new Error(JSON.stringify(prepared));
      const terminalAt = new Date(Date.parse(TEST_NOW) + 1000).toISOString();
      const applied = f.registry.prepareBundleApply(
        cap,
        prepared.stage,
        actualSnapshot(f.graph, f.operation, terminalAt),
      );
      expect(applied.status).toBe('prepared_apply');
      if (applied.status !== 'prepared_apply') throw new Error(JSON.stringify(applied));
      const { plan, operation } = applied.candidate;
      if (operation.state !== 'committed') throw new Error('Expected committed candidate');
      const graph = GraphDataSchema.parse({
        ...f.graph,
        entities: [...f.graph.entities, ...(mode === 'missing_rows' ? [] : plan.createEntities)],
        edges: [...f.graph.edges, ...(mode === 'missing_rows' ? [] : plan.createEdges)],
      });
      const stored =
        mode === 'wrong_receipt'
          ? CompositionalAutomaticCaptureOperationV3Schema.parse({
              ...operation,
              terminalReceipt: { ...operation.terminalReceipt, reasons: ['question'] },
            })
          : operation;
      const proof = f.registry.confirmInitialCommitAfterAcknowledgement(
        cap,
        actualSnapshot(graph, stored, terminalAt),
      );
      if (mode === 'complete') {
        expect(proof).not.toBeNull();
        if (!proof) throw new Error('Expected internally verified proof');
        expect(f.registry.createInitialFirstCommitResult(proof)?.eligibleFirstCommit).toBe(true);
        expect(plan.createEdges).toHaveLength(1);
        expect(plan.createEntities[0].created_at).toBe(TEST_NOW);
        expect(applied.candidate.receipt.terminalAt).toBe(terminalAt);
      } else {
        expect(proof).toBeNull();
      }
    },
  );

  it('authenticates copied/foreign stage capabilities before inspecting actual data', () => {
    const f = buildInitial();
    const handle = f.registry.issueInitialAfterAcknowledgedBegin(f.begin.scope, f.actual);
    if (!handle) throw new Error('Expected handle');
    const cap = f.registry.consumeForCompletion(handle, hash('private stage copy'));
    const stage = f.registry.prepareBundleStage(cap, f.actual, { remaining: 512, deferred: 0 });
    if (stage.status !== 'prepared_stage') throw new Error(JSON.stringify(stage));
    let getters = 0;
    const hostile = Object.defineProperty({}, 'graph', { get: () => ++getters });
    expect(f.registry.prepareBundleApply(cap, structuredClone(stage.stage), hostile)).toEqual({
      status: 'deferred',
      reason: 'invalid_stage',
    });
    const foreign = createCompositionalAutomaticCaptureHandleRegistryV3();
    expect(foreign.prepareBundleApply(cap, stage.stage, hostile)).toEqual({
      status: 'deferred',
      reason: 'invalid_capability',
    });
    expect(getters).toBe(0);
  });

  it('cannot turn a structural bundle receipt into first-processing permission without its private stage', () => {
    const f = buildInitial();
    const handle = f.registry.issueInitialAfterAcknowledgedBegin(f.begin.scope, f.actual);
    if (!handle) throw new Error('Expected handle');
    const cap = f.registry.consumeForCompletion(handle, hash('structural bundle is not proof'));
    const invocation = f.registry.readConsumedInvocation(cap);
    const reference = makeCompositionalCommittedClaimFixture();
    const terminalAt = new Date(Date.parse(TEST_NOW) + 1000).toISOString();
    const operation = committedOperation(f.operation, invocation.completionCallHash, terminalAt, {
      ...reference.operation.terminalReceipt,
      operationId: f.operation.operationId,
      sourceId: f.operation.identity.sourceId,
      sourceHash: f.operation.identity.sourceHash,
      descriptorHash: f.operation.identity.descriptorHash,
      policyFingerprint: f.operation.descriptor.policy.fingerprint,
      terminalAt,
    });
    expect(
      f.registry.confirmInitialCommitAfterAcknowledgement(
        cap,
        actualSnapshot(f.graph, operation, terminalAt),
      ),
    ).toBeNull();
  });
  it.each(['witness', 'receipt', 'proof'] as const)(
    'denies global record collisions introduced after begin during %s validation',
    (phase) => {
      const f = buildInitial(undefined, 'Do I prefer concise explanations?');
      const handle = f.registry.issueInitialAfterAcknowledgedBegin(f.begin.scope, f.actual);
      if (!handle) throw new Error('Expected handle');
      const cap = f.registry.consumeForCompletion(handle, hash(`collision-${phase}`));
      const invocation = f.registry.readConsumedInvocation(cap);
      const witness =
        phase === 'witness' ? null : f.registry.prepareSourceVerdictWitness(cap, f.actual);
      const terminalAt = new Date(Date.parse(TEST_NOW) + 1000).toISOString();
      const receipt =
        phase === 'proof' && witness
          ? f.registry.prepareSourceVerdictReceipt(
              cap,
              witness,
              actualSnapshot(f.graph, f.operation, terminalAt),
            )
          : null;
      const operation =
        phase === 'proof' && receipt
          ? committedOperation(f.operation, invocation.completionCallHash, terminalAt, receipt)
          : f.operation;
      const collided = GraphDataSchema.parse({
        ...f.graph,
        entities: [...f.graph.entities, { ...f.graph.entities[0], uuid: operation.operationId }],
      });
      const actual = actualSnapshot(collided, operation, terminalAt);
      const result =
        phase === 'witness'
          ? f.registry.prepareSourceVerdictWitness(cap, actual)
          : phase === 'receipt'
            ? f.registry.prepareSourceVerdictReceipt(cap, witness!, actual)
            : f.registry.confirmInitialCommitAfterAcknowledgement(cap, actual);
      expect(result).toBeNull();
      expect(() => f.registry.readActiveConsumedInvocation(cap)).toThrow('invalid_handle');
    },
  );

  it('issues only one exact initial handle after matching acknowledged V3 state', () => {
    const fixture = buildInitial();
    const other = createCompositionalAutomaticCaptureHandleRegistryV3();
    const handle = fixture.registry.issueInitialAfterAcknowledgedBegin(
      fixture.begin.scope,
      fixture.actual,
    );
    expect(handle).not.toBeNull();
    if (!handle) throw new Error('Expected handle');
    expect(fixture.actual.graph.automatic_operations_v1?.operations).toEqual([fixture.operation]);
    hiddenFrozen(handle);
    expect(fixture.registry.isLiveHandle(handle)).toBe(true);
    expect(
      fixture.registry.issueInitialAfterAcknowledgedBegin(fixture.begin.scope, fixture.actual),
    ).toBe(handle);
    expect(other.isLiveHandle(handle)).toBe(false);
    expect(fixture.registry.isLiveHandle({ ...handle })).toBe(false);
    expect(fixture.registry.isLiveHandle(structuredClone(handle))).toBe(false);

    if (fixture.operation.state !== 'leased') throw new Error('Expected leased operation');
    const tamperedOperation = CompositionalAutomaticCaptureOperationV3Schema.parse({
      ...fixture.operation,
      lease: { ...fixture.operation.lease, token: randomUUID() },
    });
    const tampered = actualSnapshot(fixture.graph, tamperedOperation, TEST_NOW);
    expect(
      fixture.registry.issueInitialAfterAcknowledgedBegin(fixture.begin.scope, tampered),
    ).toBeNull();
    expect(
      fixture.registry.issueInitialAfterAcknowledgedBegin(fixture.begin.scope, fixture.actual),
    ).toBeNull();
    expect(Object.isFrozen(fixture.begin)).toBe(true);
    expect(Object.isFrozen(fixture.begin.audit)).toBe(true);
  });

  it('recovers one handle on the exact unknown-ack path and denies path switching', () => {
    const fixture = buildInitial();
    const handle = fixture.registry.recoverInitialAfterUnknownAcknowledgement(
      fixture.begin.scope,
      fixture.actual,
    );
    expect(handle).not.toBeNull();
    expect(
      fixture.registry.recoverInitialAfterUnknownAcknowledgement(
        fixture.begin.scope,
        fixture.actual,
      ),
    ).toBe(handle);
    expect(
      fixture.registry.issueInitialAfterAcknowledgedBegin(fixture.begin.scope, fixture.actual),
    ).toBeNull();
    expect(fixture.registry.isLiveHandle(handle)).toBe(false);
  });

  it('permanently denies a coherently rewritten source and identity after first binding', () => {
    const fixture = buildInitial();
    const handle = fixture.registry.issueInitialAfterAcknowledgedBegin(
      fixture.begin.scope,
      fixture.actual,
    );
    expect(handle).not.toBeNull();

    const base = GraphDataSchema.parse({ ...fixture.graph, episodes: [] });
    const alternate = buildCompositionalHumanCaptureSourceV3(base, {
      sourceId: fixture.operation.identity.sourceId,
      storeHash: fixture.operation.identity.storeHash,
      capturedAt: TEST_NOW,
      previousEpisodeId: null,
      request: {
        ...fixture.request,
        source: { ...fixture.request.source, content: 'I prefer detailed explanations.' },
      },
    });
    const rewrittenOperation = leasedOperation(fixture.begin, alternate);
    const rewrittenGraph = GraphDataSchema.parse({ ...base, episodes: [alternate.episode] });
    const rewrittenActual = actualSnapshot(rewrittenGraph, rewrittenOperation, TEST_NOW);

    expect(
      fixture.registry.issueInitialAfterAcknowledgedBegin(fixture.begin.scope, rewrittenActual),
    ).toBeNull();
    expect(
      fixture.registry.issueInitialAfterAcknowledgedBegin(fixture.begin.scope, fixture.actual),
    ).toBeNull();
  });

  it('allocates a new identity for a new method call even when the attempt hash repeats', () => {
    const fixture = buildInitial();
    const second = fixture.registry.startInitialBegin(
      fixture.initialAttemptHash,
      fixture.built.descriptor,
    );
    expect(second.sourceId).not.toBe(fixture.begin.sourceId);
    expect(second.operationId).not.toBe(fixture.begin.operationId);
    expect(second.beginCallHash).not.toBe(fixture.begin.beginCallHash);
    expect(
      fixture.registry.issueInitialAfterAcknowledgedBegin(second.scope, fixture.actual),
    ).toBeNull();
  });

  it('binds consumed invocation and three distinct audit capabilities to exact private records', () => {
    const fixture = buildInitial();
    const handle = fixture.registry.issueInitialAfterAcknowledgedBegin(
      fixture.begin.scope,
      fixture.actual,
    );
    if (!handle) throw new Error('Expected handle');
    const initialAudit = fixture.registry.readAttemptAudit(fixture.begin.audit);
    expect(initialAudit.action).toBe('initial');
    expect(initialAudit.attemptIdHash).toBe(fixture.initialAttemptHash);

    const consumed = fixture.registry.consumeForCompletion(handle, hash('completion attempt'));
    hiddenFrozen(consumed);
    expect(fixture.registry.isLiveHandle(handle)).toBe(false);
    expect(() => fixture.registry.consumeForCompletion(handle, hash('second completion'))).toThrow(
      'invalid_handle',
    );
    const first = fixture.registry.readConsumedInvocation(consumed);
    const second = fixture.registry.readConsumedInvocation(consumed);
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first.boundFence).not.toBe(second.boundFence);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.boundFence)).toBe(true);
    expect(first.audit).toBe(second.audit);
    expect(first.boundFence.identityHash).toBe(
      compositionalCaptureOperationIdentityHashV3(fixture.operation.identity),
    );
    expect(first.storeHash).toBe(fixture.operation.identity.storeHash);
    expect(first.namespace).toBe(fixture.operation.identity.namespace);
    expect(fixture.registry.readAttemptAudit(first.audit).action).toBe('completion');
    expect(() => fixture.registry.readConsumedInvocation(structuredClone(consumed))).toThrow(
      'invalid_handle',
    );
    const otherRegistry = createCompositionalAutomaticCaptureHandleRegistryV3();
    expect(() => otherRegistry.readConsumedInvocation(consumed)).toThrow('invalid_handle');
    expect(() => otherRegistry.readAttemptAudit(first.audit)).toThrow('invalid_handle');
    expect(
      fixture.registry.issueInitialAfterAcknowledgedBegin(fixture.begin.scope, fixture.actual),
    ).toBeNull();
  });

  it('reads only an active consumed invocation and fences hostile input before inspection', () => {
    const fixture = buildInitial(undefined, 'Do I prefer concise explanations?');
    const handle = fixture.registry.issueInitialAfterAcknowledgedBegin(
      fixture.begin.scope,
      fixture.actual,
    );
    if (!handle) throw new Error('Expected handle');
    const consumed = fixture.registry.consumeForCompletion(handle, hash('active reader attempt'));
    const active = fixture.registry.readActiveConsumedInvocation(consumed);
    expect(active.boundFence).toEqual(fixture.registry.readConsumedInvocation(consumed).boundFence);
    expect(Object.isFrozen(active)).toBe(true);
    expect(Object.isFrozen(active.boundFence)).toBe(true);

    let traps = 0;
    const hostile = new Proxy(
      {},
      {
        ownKeys: () => {
          traps += 1;
          return [];
        },
        getOwnPropertyDescriptor: () => {
          traps += 1;
          return undefined;
        },
      },
    );
    expect(() => fixture.registry.prepareSourceVerdictWitness({} as never, hostile)).toThrow(
      'invalid_handle',
    );
    expect(() =>
      fixture.registry.prepareSourceVerdictWitness(structuredClone(consumed), hostile),
    ).toThrow('invalid_handle');
    const other = createCompositionalAutomaticCaptureHandleRegistryV3();
    expect(() => other.prepareSourceVerdictWitness(consumed, hostile)).toThrow('invalid_handle');
    expect(traps).toBe(0);
  });

  it.each([
    ['The weather is mild today.', 'completed_none', []],
    ['Do I prefer concise explanations?', 'completed_none', ['question']],
    ['If asked, say "I prefer French".', 'completed_none', ['quoted_content']],
    ['I prefer Canadian spelling.', 'unsupported_meaning', ['unsupported_topic']],
  ] as const)(
    'mints one opaque source-verdict witness only from the actual parser branch (%s)',
    (content, expectedBranch, expectedReasons) => {
      const fixture = buildInitial(undefined, content);
      const handle = fixture.registry.issueInitialAfterAcknowledgedBegin(
        fixture.begin.scope,
        fixture.actual,
      );
      if (!handle) throw new Error('Expected handle');
      const consumed = fixture.registry.consumeForCompletion(handle, hash(`attempt ${content}`));
      const report = interpretCompositionalHumanSourceV3EvidenceWithExecutionReport(
        fixture.graph.episodes[0],
        fixture.operation.descriptor,
        fixture.operation.identity,
      );
      expect(report.branch).toBe(expectedBranch);
      expect(report.evidence.result.reasons).toEqual(expectedReasons);

      const witness = fixture.registry.prepareSourceVerdictWitness(consumed, fixture.actual);
      expect(witness).not.toBeNull();
      if (!witness) throw new Error('Expected source-verdict witness');
      hiddenFrozen(witness);
      const receipt = fixture.registry.prepareSourceVerdictReceipt(
        consumed,
        witness,
        fixture.actual,
      );
      expect(receipt?.selection.kind).toBe('source_verdict');
      if (!receipt || receipt.selection.kind !== 'source_verdict')
        throw new Error('Expected source-verdict receipt');
      expect(receipt.selection.verdict).toBe(
        expectedBranch === 'completed_none'
          ? 'no_supported_preference_detected'
          : 'unsupported_preference_meaning',
      );
      expect(receipt.reasons).toEqual(expectedReasons);
      expect(fixture.registry.prepareSourceVerdictWitness(consumed, fixture.actual)).toBe(witness);
      expect(
        fixture.registry.prepareSourceVerdictWitness(
          consumed,
          actualSnapshot(
            fixture.graph,
            fixture.operation,
            new Date(Date.parse(TEST_NOW) + 1000).toISOString(),
          ),
        ),
      ).toBe(witness);
      expect(fixture.registry.resultSchemas().completion.safeParse(witness).success).toBe(false);
      expect(fixture.registry.isLiveHandle(witness)).toBe(false);
      expect(() => fixture.registry.readActiveConsumedInvocation(witness)).toThrow(
        'invalid_handle',
      );
      expect(() =>
        fixture.registry.prepareSourceVerdictWitness(witness as never, fixture.actual),
      ).toThrow('invalid_handle');
      expect(fixture.registry.readActiveConsumedInvocation(consumed).boundFence).toEqual(
        fixture.registry.readConsumedInvocation(consumed).boundFence,
      );

      // The witness is deliberately empty: its branch, result hash, authority,
      // source, descriptor and completion nonce remain in the private WeakMap.
      expect(Reflect.ownKeys(witness)).toEqual([]);
      expect(Object.getPrototypeOf(witness)).toBeNull();
      expect(JSON.stringify(witness)).toBe('{}');
    },
  );

  it('does not turn quote-token resource exhaustion or a full AST into a source-verdict witness', () => {
    const resource = buildInitial(undefined, '"'.repeat(320));
    const resourceHandle = resource.registry.issueInitialAfterAcknowledgedBegin(
      resource.begin.scope,
      resource.actual,
    );
    if (!resourceHandle) throw new Error('Expected handle');
    const resourceCap = resource.registry.consumeForCompletion(
      resourceHandle,
      hash('quote token resource attempt'),
    );
    expect(resource.registry.prepareSourceVerdictWitness(resourceCap, resource.actual)).toBeNull();
    expect(() => resource.registry.readActiveConsumedInvocation(resourceCap)).not.toThrow();

    const complete = buildInitial();
    const completeHandle = complete.registry.issueInitialAfterAcknowledgedBegin(
      complete.begin.scope,
      complete.actual,
    );
    if (!completeHandle) throw new Error('Expected handle');
    const completeCap = complete.registry.consumeForCompletion(
      completeHandle,
      hash('full ast is not a source verdict'),
    );
    expect(complete.registry.prepareSourceVerdictWitness(completeCap, complete.actual)).toBeNull();
    expect(() => complete.registry.readActiveConsumedInvocation(completeCap)).not.toThrow();
  });

  it('permanently denies the consumed invocation after actual source or authority changes', () => {
    const fixture = buildInitial(undefined, 'Do I prefer concise explanations?');
    const handle = fixture.registry.issueInitialAfterAcknowledgedBegin(
      fixture.begin.scope,
      fixture.actual,
    );
    if (!handle) throw new Error('Expected handle');
    const consumed = fixture.registry.consumeForCompletion(handle, hash('source verdict changed'));
    const first = fixture.registry.prepareSourceVerdictWitness(consumed, fixture.actual);
    expect(first).not.toBeNull();

    const changedSource = GraphDataSchema.parse({
      ...fixture.graph,
      episodes: fixture.graph.episodes.map((episode) =>
        episode.uuid === fixture.operation.identity.sourceId
          ? { ...episode, content: 'Today is sunny.' }
          : episode,
      ),
    });
    expect(
      fixture.registry.prepareSourceVerdictWitness(
        consumed,
        actualSnapshot(changedSource, fixture.operation, TEST_NOW),
      ),
    ).toBeNull();
    expect(() => fixture.registry.prepareSourceVerdictWitness(consumed, fixture.actual)).toThrow(
      'invalid_handle',
    );

    const revoked = buildInitial(undefined, 'Do I prefer concise explanations?');
    const revokedHandle = revoked.registry.issueInitialAfterAcknowledgedBegin(
      revoked.begin.scope,
      revoked.actual,
    );
    if (!revokedHandle) throw new Error('Expected handle');
    const revokedCap = revoked.registry.consumeForCompletion(
      revokedHandle,
      hash('revoked source verdict'),
    );
    expect(revoked.registry.prepareSourceVerdictWitness(revokedCap, revoked.actual)).not.toBeNull();
    const revokedGraph = GraphDataSchema.parse({
      ...revoked.graph,
      episodes: revoked.graph.episodes.map((episode) =>
        episode.uuid === revoked.operation.identity.sourceId
          ? { ...episode, review_status: 'rejected' }
          : episode,
      ),
    });
    expect(
      revoked.registry.prepareSourceVerdictWitness(
        revokedCap,
        actualSnapshot(revokedGraph, revoked.operation, TEST_NOW),
      ),
    ).toBeNull();
    expect(() => revoked.registry.prepareSourceVerdictWitness(revokedCap, revoked.actual)).toThrow(
      'invalid_handle',
    );

    const fenced = buildInitial(undefined, 'Do I prefer concise explanations?');
    const fencedHandle = fenced.registry.issueInitialAfterAcknowledgedBegin(
      fenced.begin.scope,
      fenced.actual,
    );
    if (!fencedHandle) throw new Error('Expected handle');
    const fencedCap = fenced.registry.consumeForCompletion(
      fencedHandle,
      hash('changed actual lease fence'),
    );
    expect(fenced.registry.prepareSourceVerdictWitness(fencedCap, fenced.actual)).not.toBeNull();
    if (fenced.operation.state !== 'leased') throw new Error('Expected leased operation');
    const renewedAt = new Date(Date.parse(TEST_NOW) + 1000).toISOString();
    const shiftedExpiry = new Date(
      Date.parse(fenced.operation.lease.expiresAt) + 1000,
    ).toISOString();
    const changedLease = CompositionalAutomaticCaptureOperationV3Schema.parse({
      ...fenced.operation,
      lastObservedAt: renewedAt,
      lease: { ...fenced.operation.lease, renewedAt, expiresAt: shiftedExpiry },
    });
    expect(
      fenced.registry.prepareSourceVerdictWitness(
        fencedCap,
        actualSnapshot(fenced.graph, changedLease, renewedAt),
      ),
    ).toBeNull();
    expect(() => fenced.registry.prepareSourceVerdictWitness(fencedCap, fenced.actual)).toThrow(
      'invalid_handle',
    );
  });

  it('does not return a memoized witness after cancellation or monotonic lease expiry', () => {
    const fixture = buildInitial(undefined, 'Do I prefer concise explanations?');
    const handle = fixture.registry.issueInitialAfterAcknowledgedBegin(
      fixture.begin.scope,
      fixture.actual,
    );
    if (!handle) throw new Error('Expected handle');
    const consumed = fixture.registry.consumeForCompletion(handle, hash('cancel witness'));
    const witness = fixture.registry.prepareSourceVerdictWitness(consumed, fixture.actual);
    expect(witness).not.toBeNull();
    fixture.registry.markInvocationCancelled(consumed);
    expect(() => fixture.registry.prepareSourceVerdictWitness(consumed, fixture.actual)).toThrow(
      'interrupted',
    );

    const expiring = buildInitial(undefined, 'Do I prefer concise explanations?');
    const expiringHandle = expiring.registry.issueInitialAfterAcknowledgedBegin(
      expiring.begin.scope,
      expiring.actual,
    );
    if (!expiringHandle) throw new Error('Expected handle');
    const expiringCap = expiring.registry.consumeForCompletion(
      expiringHandle,
      hash('expired witness'),
    );
    const expiringWitness = expiring.registry.prepareSourceVerdictWitness(
      expiringCap,
      expiring.actual,
    );
    expect(expiringWitness).not.toBeNull();
    const now = performance.now();
    const clock = jest.spyOn(performance, 'now').mockReturnValue(now + 120_001);
    try {
      expect(() =>
        expiring.registry.prepareSourceVerdictWitness(expiringCap, expiring.actual),
      ).toThrow('budget_exhausted');
    } finally {
      clock.mockRestore();
    }
    expect(() =>
      expiring.registry.prepareSourceVerdictWitness(expiringCap, expiring.actual),
    ).toThrow('invalid_handle');
  });

  it('permanently denies a source-verdict witness when authoritative backend time reaches expiry', () => {
    const fixture = buildInitial(undefined, 'Do I prefer concise explanations?');
    const handle = fixture.registry.issueInitialAfterAcknowledgedBegin(
      fixture.begin.scope,
      fixture.actual,
    );
    if (!handle) throw new Error('Expected handle');
    const consumed = fixture.registry.consumeForCompletion(handle, hash('backend lease expiry'));
    if (fixture.operation.state !== 'leased') throw new Error('Expected leased operation');
    expect(fixture.registry.prepareSourceVerdictWitness(consumed, fixture.actual)).not.toBeNull();

    expect(
      fixture.registry.prepareSourceVerdictWitness(
        consumed,
        actualSnapshot(fixture.graph, fixture.operation, fixture.operation.lease.expiresAt),
      ),
    ).toBeNull();
    expect(() => fixture.registry.prepareSourceVerdictWitness(consumed, fixture.actual)).toThrow(
      'invalid_handle',
    );
  });

  it('requires actual initial commit, active current binding, and same-cap proof for true result', () => {
    const fixture = buildInitial(undefined, 'Do I prefer concise explanations?');
    const handle = fixture.registry.issueInitialAfterAcknowledgedBegin(
      fixture.begin.scope,
      fixture.actual,
    );
    if (!handle) throw new Error('Expected handle');
    const consumed = fixture.registry.consumeForCompletion(handle, hash('completion-attempt'));
    const invocation = fixture.registry.readConsumedInvocation(consumed);
    const terminalAt = new Date(Date.parse(TEST_NOW) + 1000).toISOString();
    const witness = fixture.registry.prepareSourceVerdictWitness(consumed, fixture.actual);
    if (!witness) throw new Error('Expected source-verdict witness');
    const receipt = fixture.registry.prepareSourceVerdictReceipt(
      consumed,
      witness,
      actualSnapshot(fixture.graph, fixture.operation, terminalAt),
    );
    expect(receipt?.terminalAt).toBe(terminalAt);
    if (!receipt) throw new Error('Expected source-verdict receipt');
    const operation = committedOperation(
      fixture.operation,
      invocation.completionCallHash,
      terminalAt,
      receipt,
    );
    const actual = actualSnapshot(fixture.graph, operation, terminalAt);
    expect(fixture.registry.prepareSourceVerdictReceipt(consumed, witness, actual)).toBeNull();
    const proof = fixture.registry.confirmInitialCommitAfterAcknowledgement(consumed, actual);
    expect(proof).not.toBeNull();
    if (!proof) throw new Error('Expected proof');
    hiddenFrozen(proof);
    const result = fixture.registry.createInitialFirstCommitResult(proof);
    expect(result).not.toBeNull();
    if (!result) throw new Error('Expected true result');
    expect(result).toEqual({
      kind: 'committed',
      invocation: 'initial_owner',
      terminalReceipt: operation.state === 'committed' ? operation.terminalReceipt : null,
      currentAuthority: 'active',
      eligibleFirstCommit: true,
    });
    expect(fixture.registry.createInitialFirstCommitResult(proof)).toBe(result);
    const schemas = fixture.registry.resultSchemas();
    expect(schemas.completion.safeParse(result).success).toBe(true);
    expect(schemas.completion.parse(result)).toBe(result);
    expect(schemas.completion.parse(schemas.completion.parse(result))).toBe(result);
    expect(schemas.completion.safeParse({ ...result, eligibleFirstCommit: true }).success).toBe(
      false,
    );
    expect(schemas.completion.safeParse(structuredClone(result)).success).toBe(false);

    const alteredReceipt = { ...receipt, terminalAt: TEST_NOW };
    const changedReceipt = committedOperation(
      fixture.operation,
      invocation.completionCallHash,
      terminalAt,
      alteredReceipt,
    );
    expect(
      fixture.registry.confirmInitialCommitAfterAcknowledgement(consumed, {
        ...actual,
        operation: {
          ...changedReceipt,
          terminalReceipt: { ...changedReceipt.terminalReceipt, terminalAt: TEST_NOW },
        },
      }),
    ).toBeNull();
    expect(fixture.registry.createInitialFirstCommitResult(proof)).toBeNull();
  });

  it('recovers a true result only for an exact same-call completion acknowledgment', () => {
    const fixture = buildInitial(undefined, 'Do I prefer concise explanations?');
    const handle = fixture.registry.recoverInitialAfterUnknownAcknowledgement(
      fixture.begin.scope,
      fixture.actual,
    );
    if (!handle) throw new Error('Expected recovered handle');
    const consumed = fixture.registry.consumeForCompletion(handle, hash('completion ack recovery'));
    const invocation = fixture.registry.readConsumedInvocation(consumed);
    const terminalAt = new Date(Date.parse(TEST_NOW) + 1000).toISOString();
    const witness = fixture.registry.prepareSourceVerdictWitness(consumed, fixture.actual);
    if (!witness) throw new Error('Expected source-verdict witness');
    const receipt = fixture.registry.prepareSourceVerdictReceipt(
      consumed,
      witness,
      actualSnapshot(fixture.graph, fixture.operation, terminalAt),
    );
    if (!receipt) throw new Error('Expected source-verdict receipt');
    const operation = committedOperation(
      fixture.operation,
      invocation.completionCallHash,
      terminalAt,
      receipt,
    );
    const actual = actualSnapshot(fixture.graph, operation, terminalAt);
    const proof = fixture.registry.recoverInitialCommitAfterUnknownAcknowledgement(
      consumed,
      actual,
    );
    expect(proof).not.toBeNull();
    if (!proof) throw new Error('Expected exact same-call proof');
    const result = fixture.registry.createInitialFirstCommitResult(proof);
    expect(result?.invocation).toBe('same_call_ack_recovered');
    expect(result?.terminalReceipt).toEqual(operation.terminalReceipt);
  });

  it('requires a cached source-verdict witness and exact prepared receipt for a positive proof', () => {
    const fixture = buildInitial(undefined, 'Do I prefer concise explanations?');
    const handle = fixture.registry.issueInitialAfterAcknowledgedBegin(
      fixture.begin.scope,
      fixture.actual,
    );
    if (!handle) throw new Error('Expected handle');
    const consumed = fixture.registry.consumeForCompletion(handle, hash('receipt guard'));
    const invocation = fixture.registry.readConsumedInvocation(consumed);
    const terminalAt = new Date(Date.parse(TEST_NOW) + 1000).toISOString();
    const structuralOnly = committedOperation(
      fixture.operation,
      invocation.completionCallHash,
      terminalAt,
    );
    expect(
      fixture.registry.confirmInitialCommitAfterAcknowledgement(
        consumed,
        actualSnapshot(fixture.graph, structuralOnly, terminalAt),
      ),
    ).toBeNull();

    const valid = buildInitial(undefined, 'Do I prefer concise explanations?');
    const validHandle = valid.registry.issueInitialAfterAcknowledgedBegin(
      valid.begin.scope,
      valid.actual,
    );
    if (!validHandle) throw new Error('Expected handle');
    const validCap = valid.registry.consumeForCompletion(validHandle, hash('mutated receipt'));
    const validInvocation = valid.registry.readConsumedInvocation(validCap);
    const witness = valid.registry.prepareSourceVerdictWitness(validCap, valid.actual);
    if (!witness) throw new Error('Expected witness');
    const receipt = valid.registry.prepareSourceVerdictReceipt(
      validCap,
      witness,
      actualSnapshot(valid.graph, valid.operation, terminalAt),
    );
    if (!receipt) throw new Error('Expected receipt');
    const operation = committedOperation(
      valid.operation,
      validInvocation.completionCallHash,
      terminalAt,
      { ...receipt, reasons: ['question', 'question'] },
    );
    expect(
      valid.registry.confirmInitialCommitAfterAcknowledgement(
        validCap,
        actualSnapshot(valid.graph, operation, terminalAt),
      ),
    ).toBeNull();
  });

  it('authenticates a same-registry source-verdict witness before inspecting receipt input', () => {
    const target = buildInitial(undefined, 'Do I prefer concise explanations?');
    const targetHandle = target.registry.issueInitialAfterAcknowledgedBegin(
      target.begin.scope,
      target.actual,
    );
    if (!targetHandle) throw new Error('Expected target handle');
    const targetCap = target.registry.consumeForCompletion(
      targetHandle,
      hash('receipt witness target'),
    );

    const foreign = buildInitial(undefined, 'Do I prefer concise explanations?');
    const foreignHandle = foreign.registry.issueInitialAfterAcknowledgedBegin(
      foreign.begin.scope,
      foreign.actual,
    );
    if (!foreignHandle) throw new Error('Expected foreign handle');
    const foreignCap = foreign.registry.consumeForCompletion(
      foreignHandle,
      hash('foreign receipt witness'),
    );
    const foreignWitness = foreign.registry.prepareSourceVerdictWitness(foreignCap, foreign.actual);
    if (!foreignWitness) throw new Error('Expected foreign witness');

    let traps = 0;
    const hostile = new Proxy(
      {},
      {
        ownKeys: () => {
          traps += 1;
          return [];
        },
        getOwnPropertyDescriptor: () => {
          traps += 1;
          return undefined;
        },
      },
    );
    expect(
      target.registry.prepareSourceVerdictReceipt(targetCap, foreignWitness, hostile),
    ).toBeNull();
    expect(traps).toBe(0);
  });

  it('refreshes a staged receipt on a later leased retry and proves only the latest stage', () => {
    const makeStaged = () => {
      const fixture = buildInitial(undefined, 'Do I prefer concise explanations?');
      const handle = fixture.registry.issueInitialAfterAcknowledgedBegin(
        fixture.begin.scope,
        fixture.actual,
      );
      if (!handle) throw new Error('Expected handle');
      const consumed = fixture.registry.consumeForCompletion(handle, hash('restage receipt'));
      const invocation = fixture.registry.readConsumedInvocation(consumed);
      const witness = fixture.registry.prepareSourceVerdictWitness(consumed, fixture.actual);
      if (!witness) throw new Error('Expected witness');
      const firstAt = new Date(Date.parse(TEST_NOW) + 1000).toISOString();
      const first = fixture.registry.prepareSourceVerdictReceipt(
        consumed,
        witness,
        actualSnapshot(fixture.graph, fixture.operation, firstAt),
      );
      if (!first) throw new Error('Expected first staged receipt');
      expect(
        fixture.registry.prepareSourceVerdictReceipt(
          consumed,
          witness,
          actualSnapshot(fixture.graph, fixture.operation, firstAt),
        ),
      ).toBe(first);
      const secondAt = new Date(Date.parse(TEST_NOW) + 2000).toISOString();
      const second = fixture.registry.prepareSourceVerdictReceipt(
        consumed,
        witness,
        actualSnapshot(fixture.graph, fixture.operation, secondAt),
      );
      expect(second).not.toBe(first);
      expect(second?.terminalAt).toBe(secondAt);
      return { fixture, consumed, invocation, witness, first, second, secondAt };
    };

    const failedStage = makeStaged();
    if (!failedStage.second) throw new Error('Expected refreshed staged receipt');
    const oldStageOperation = committedOperation(
      failedStage.fixture.operation,
      failedStage.invocation.completionCallHash,
      failedStage.secondAt,
      failedStage.first,
    );
    expect(
      failedStage.fixture.registry.confirmInitialCommitAfterAcknowledgement(
        failedStage.consumed,
        actualSnapshot(failedStage.fixture.graph, oldStageOperation, failedStage.secondAt),
      ),
    ).toBeNull();

    const successfulStage = makeStaged();
    if (!successfulStage.second) throw new Error('Expected refreshed staged receipt');
    const operation = committedOperation(
      successfulStage.fixture.operation,
      successfulStage.invocation.completionCallHash,
      successfulStage.secondAt,
      successfulStage.second,
    );
    const actual = actualSnapshot(
      successfulStage.fixture.graph,
      operation,
      successfulStage.secondAt,
    );
    expect(
      successfulStage.fixture.registry.prepareSourceVerdictReceipt(
        successfulStage.consumed,
        successfulStage.witness,
        actual,
      ),
    ).toBeNull();
    const proof = successfulStage.fixture.registry.confirmInitialCommitAfterAcknowledgement(
      successfulStage.consumed,
      actual,
    );
    expect(proof).not.toBeNull();
  });

  it('denies a backend clock regression below the latest staged receipt time', () => {
    const fixture = buildInitial(undefined, 'Do I prefer concise explanations?');
    const handle = fixture.registry.issueInitialAfterAcknowledgedBegin(
      fixture.begin.scope,
      fixture.actual,
    );
    if (!handle) throw new Error('Expected handle');
    const consumed = fixture.registry.consumeForCompletion(
      handle,
      hash('receipt clock regression'),
    );
    const witness = fixture.registry.prepareSourceVerdictWitness(consumed, fixture.actual);
    if (!witness) throw new Error('Expected witness');
    const stagedAt = new Date(Date.parse(TEST_NOW) + 2000).toISOString();
    expect(
      fixture.registry.prepareSourceVerdictReceipt(
        consumed,
        witness,
        actualSnapshot(fixture.graph, fixture.operation, stagedAt),
      ),
    ).not.toBeNull();
    const regressedAt = new Date(Date.parse(TEST_NOW) + 1000).toISOString();
    expect(
      fixture.registry.prepareSourceVerdictReceipt(
        consumed,
        witness,
        actualSnapshot(fixture.graph, fixture.operation, regressedAt),
      ),
    ).toBeNull();
    expect(() => fixture.registry.readActiveConsumedInvocation(consumed)).toThrow('invalid_handle');
  });

  it.each(['foreign_scope', 'wrong_nonce'] as const)(
    'permanently denies a nonmatching committed receipt input: %s',
    (kind) => {
      const makeStaged = () => {
        const f = buildInitial(undefined, 'Do I prefer concise explanations?');
        const handle = f.registry.issueInitialAfterAcknowledgedBegin(f.begin.scope, f.actual);
        if (!handle) throw new Error('Expected handle');
        const cap = f.registry.consumeForCompletion(handle, hash('committed scope gate'));
        const invocation = f.registry.readConsumedInvocation(cap);
        const witness = f.registry.prepareSourceVerdictWitness(cap, f.actual);
        if (!witness) throw new Error('Expected witness');
        const terminalAt = '2026-10-25T12:00:01.000Z';
        const receipt = f.registry.prepareSourceVerdictReceipt(
          cap,
          witness,
          actualSnapshot(f.graph, f.operation, terminalAt),
        );
        if (!receipt) throw new Error('Expected receipt');
        const committed = committedOperation(
          f.operation,
          invocation.completionCallHash,
          terminalAt,
          receipt,
        );
        return {
          f,
          cap,
          invocation,
          witness,
          committed,
          terminalAt,
          actual: actualSnapshot(f.graph, committed, terminalAt),
        };
      };
      const target = makeStaged();
      let wrongActual = target.actual;
      if (kind === 'foreign_scope') wrongActual = makeStaged().actual;
      else
        wrongActual = actualSnapshot(
          target.f.graph,
          committedOperation(
            target.f.operation,
            hash('foreign-completion-nonce'),
            target.terminalAt,
            target.committed.terminalReceipt,
          ),
          target.terminalAt,
        );
      expect(
        target.f.registry.prepareSourceVerdictReceipt(target.cap, target.witness, wrongActual),
      ).toBeNull();
      expect(() => target.f.registry.readActiveConsumedInvocation(target.cap)).toThrow();
      expect(
        target.f.registry.confirmInitialCommitAfterAcknowledgement(target.cap, target.actual),
      ).toBeNull();
    },
  );

  it('rechecks the active invocation after freezing a receipt before retaining a stage', () => {
    let time = 1000;
    const clock = jest.spyOn(performance, 'now').mockImplementation(() => time);
    const f = buildInitial(undefined, 'Do I prefer concise explanations?');
    const handle = f.registry.issueInitialAfterAcknowledgedBegin(f.begin.scope, f.actual);
    if (!handle) throw new Error('Expected handle');
    const cap = f.registry.consumeForCompletion(handle, hash('postfreeze receipt'));
    const witness = f.registry.prepareSourceVerdictWitness(cap, f.actual);
    if (!witness) throw new Error('Expected witness');
    const original = Object.freeze;
    let hit = false;
    const frozen = jest.spyOn(Object, 'freeze').mockImplementation((value) => {
      const result = original(value);
      if (
        value !== null &&
        typeof value === 'object' &&
        Object.getOwnPropertyDescriptor(value, 'kind')?.value ===
          'human_compositional_source_verdict_committed'
      ) {
        hit = true;
        time = 121_001;
      }
      return result;
    });
    try {
      expect(() =>
        f.registry.prepareSourceVerdictReceipt(
          cap,
          witness,
          actualSnapshot(f.graph, f.operation, '2026-10-25T12:00:01.000Z'),
        ),
      ).toThrow();
      expect(hit).toBe(true);
      time = 1000;
      expect(() => f.registry.readActiveConsumedInvocation(cap)).toThrow();
    } finally {
      frozen.mockRestore();
      clock.mockRestore();
    }
  });

  it('permanently denies a proof after the registry deadline, including memoized results', () => {
    const fixture = buildInitial(undefined, 'Do I prefer concise explanations?');
    const handle = fixture.registry.issueInitialAfterAcknowledgedBegin(
      fixture.begin.scope,
      fixture.actual,
    );
    if (!handle) throw new Error('Expected handle');
    const consumed = fixture.registry.consumeForCompletion(handle, hash('late memoized result'));
    const invocation = fixture.registry.readConsumedInvocation(consumed);
    const terminalAt = new Date(Date.parse(TEST_NOW) + 1000).toISOString();
    const witness = fixture.registry.prepareSourceVerdictWitness(consumed, fixture.actual);
    if (!witness) throw new Error('Expected source-verdict witness');
    const receipt = fixture.registry.prepareSourceVerdictReceipt(
      consumed,
      witness,
      actualSnapshot(fixture.graph, fixture.operation, terminalAt),
    );
    if (!receipt) throw new Error('Expected source-verdict receipt');
    const operation = committedOperation(
      fixture.operation,
      invocation.completionCallHash,
      terminalAt,
      receipt,
    );
    const proof = fixture.registry.confirmInitialCommitAfterAcknowledgement(
      consumed,
      actualSnapshot(fixture.graph, operation, terminalAt),
    );
    if (!proof) throw new Error('Expected pre-deadline proof');
    const result = fixture.registry.createInitialFirstCommitResult(proof);
    if (!result) throw new Error('Expected initial result');

    const now = performance.now();
    const clock = jest.spyOn(performance, 'now').mockReturnValue(now + 120_001);
    try {
      expect(fixture.registry.createInitialFirstCommitResult(proof)).toBeNull();
      expect(fixture.registry.resultSchemas().completion.safeParse(result).success).toBe(false);
    } finally {
      clock.mockRestore();
    }
  });

  it('fails closed when actual source authority changes and when scope cancellation is marked', () => {
    const second = buildInitial();
    const revokedSourceGraph = GraphDataSchema.parse({
      ...second.graph,
      episodes: second.graph.episodes.map((episode) => ({ ...episode, review_status: 'rejected' })),
    });
    expect(
      second.registry.issueInitialAfterAcknowledgedBegin(
        second.begin.scope,
        actualSnapshot(revokedSourceGraph, second.operation, TEST_NOW),
      ),
    ).toBeNull();
    expect(
      second.registry.issueInitialAfterAcknowledgedBegin(second.begin.scope, second.actual),
    ).toBeNull();

    const third = buildInitial();
    third.registry.markInvocationCancelled(third.begin.scope);
    expect(
      third.registry.issueInitialAfterAcknowledgedBegin(third.begin.scope, third.actual),
    ).toBeNull();
  });

  it('does not issue or complete after monotonic deadline, and cancellation is deny-only', async () => {
    const namespace = `v3-registry-expiry-${randomUUID()}`;
    const { graph, issuer, actor } = baseGraph(namespace);
    const registry = createCompositionalAutomaticCaptureHandleRegistryV3();
    const request = makeRequest(namespace, issuer, actor, `turn-${randomUUID()}`);
    request.settings.invocationDeadlineMs = 100;
    const descriptor = compileCompositionalAutomaticDescriptorV3({
      profileId: request.settings.profileId,
      requestedTrustLevel: request.settings.requestedTrustLevel,
      intentSetting: request.settings.intentSetting,
      invocationDeadlineMs: 100,
    });
    const begin = registry.startInitialBegin(request.attemptIdHash, descriptor);
    const built = buildCompositionalHumanCaptureSourceV3(graph, {
      sourceId: begin.sourceId,
      storeHash: hash('v3 short deadline store'),
      capturedAt: TEST_NOW,
      previousEpisodeId: null,
      request,
    });
    const operation = leasedOperation(begin, built);
    const actual = actualSnapshot(
      GraphDataSchema.parse({ ...graph, episodes: [built.episode] }),
      operation,
      TEST_NOW,
    );
    const handle = registry.issueInitialAfterAcknowledgedBegin(begin.scope, actual);
    expect(handle).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(registry.isLiveHandle(handle)).toBe(false);
    expect(() => registry.consumeForCompletion(handle!, hash('late completion'))).toThrow(
      'invalid_handle',
    );
  });

  it('shortens local work time without changing captured settings or the persisted descriptor', () => {
    const clock = jest.spyOn(performance, 'now').mockReturnValue(1000);
    try {
      const f = buildInitial({ remainingMs: 10 });
      expect(f.operation.descriptor.invocationDeadlineMs).toBe(30_000);
      expect(f.registry.readInitialBeginScope(f.begin.scope).invocationDeadlineMs).toBe(30_000);
      expect(JSON.stringify(f.operation)).not.toContain('remainingMs');
      clock.mockReturnValue(1009);
      const handle = f.registry.issueInitialAfterAcknowledgedBegin(f.begin.scope, f.actual);
      expect(handle).not.toBeNull();
      clock.mockReturnValue(1011);
      expect(f.registry.isLiveHandle(handle)).toBe(false);
      expect(() => f.registry.consumeForCompletion(handle!, hash('shortened-completion'))).toThrow(
        'invalid_handle',
      );
    } finally {
      clock.mockRestore();
    }
  });

  it('rejects work exhausted during its own preflight before returning a scope', () => {
    const f = buildInitial();
    const clock = jest.spyOn(performance, 'now').mockReturnValueOnce(1000).mockReturnValue(1011);
    try {
      expect(() =>
        f.registry.startInitialBegin(hash('slow-preflight'), f.built.descriptor, {
          remainingMs: 10,
        }),
      ).toThrow('budget_exhausted');
    } finally {
      clock.mockRestore();
    }
  });

  it('does not return an invocation if final parsing crosses the work deadline', () => {
    const f = buildInitial();
    let captured:
      | ReturnType<typeof RegistrySchemas.parseCompositionalCaptureBeginInvocationV3>
      | undefined;
    const parse = RegistrySchemas.parseCompositionalCaptureBeginInvocationV3;
    const parsed = jest
      .spyOn(RegistrySchemas, 'parseCompositionalCaptureBeginInvocationV3')
      .mockImplementation((value) => {
        captured = parse(value);
        return captured;
      });
    const clock = jest
      .spyOn(performance, 'now')
      .mockReturnValueOnce(1000)
      .mockReturnValueOnce(1000)
      .mockReturnValue(1011);
    try {
      expect(() =>
        f.registry.startInitialBegin(hash('late-final-parse'), f.built.descriptor, {
          remainingMs: 10,
        }),
      ).toThrow('budget_exhausted');
      expect(captured).toBeDefined();
      clock.mockReturnValue(1000);
      expect(() => f.registry.readInitialBeginScope(captured!.scope)).toThrow('invalid_handle');
    } finally {
      clock.mockRestore();
      parsed.mockRestore();
    }
  });

  it.each(['acknowledged', 'unknown_ack_recovery'] as const)(
    'does not issue a shortened handle after lock wait or late %s acknowledgement',
    (path) => {
      const clock = jest.spyOn(performance, 'now').mockReturnValue(1000);
      try {
        const f = buildInitial({ remainingMs: 10 });
        clock.mockReturnValue(1011);
        const handle =
          path === 'acknowledged'
            ? f.registry.issueInitialAfterAcknowledgedBegin(f.begin.scope, f.actual)
            : f.registry.recoverInitialAfterUnknownAcknowledgement(f.begin.scope, f.actual);
        expect(handle).toBeNull();
        expect(() => f.registry.readInitialBeginScope(f.begin.scope)).toThrow();
      } finally {
        clock.mockRestore();
      }
    },
  );

  it.each([0, 0.5, -1, NaN, Infinity, 30_001, 120_001])(
    'rejects invalid or extending remaining work allowance %s',
    (remainingMs) => {
      const f = buildInitial();
      expect(() =>
        f.registry.startInitialBegin(hash('invalid-work-budget'), f.built.descriptor, {
          remainingMs,
        }),
      ).toThrow('invalid_input');
    },
  );

  it('does not inspect budget or descriptor accessors/proxies before owned-data copying', () => {
    const f = buildInitial();
    let traps = 0;
    const accessor = Object.defineProperty({}, 'remainingMs', {
      enumerable: true,
      get: () => ++traps,
    });
    const proxy = new Proxy({}, { get: () => ++traps });
    for (const budget of [accessor, proxy, null, { remainingMs: 5, extra: true }])
      expect(() =>
        f.registry.startInitialBegin(hash('hostile-budget'), f.built.descriptor, budget as never),
      ).toThrow('invalid_input');
    expect(() => f.registry.startInitialBegin(hash('hostile-descriptor'), proxy)).toThrow(
      'invalid_input',
    );
    expect(traps).toBe(0);
  });

  it('keeps resume generation false-only and preserves the stored retry counter', () => {
    const fixture = buildInitial();
    const failed = CompositionalAutomaticCaptureOperationV3Schema.parse({
      version: 3,
      operationId: fixture.operation.operationId,
      identity: fixture.operation.identity,
      descriptor: fixture.operation.descriptor,
      createdAt: fixture.operation.createdAt,
      lastObservedAt: new Date(Date.parse(TEST_NOW) + 1000).toISOString(),
      attempts: [],
      overflowCount: 0,
      beginCallHash: fixture.operation.beginCallHash,
      retryCount: 2,
      lastRetryCallHash: hash('previous retry call'),
      state: 'failed',
      generation: 1,
      failedAt: new Date(Date.parse(TEST_NOW) + 1000).toISOString(),
      failureCode: 'storage_error',
    });
    const previous = actualSnapshot(
      fixture.graph,
      failed,
      new Date(Date.parse(TEST_NOW) + 1000).toISOString(),
    );
    const resume = fixture.registry.startResume(hash('resume attempt'), previous);
    expect(fixture.registry.readAttemptAudit(resume.audit).action).toBe('resume');
    const resumed = CompositionalAutomaticCaptureOperationV3Schema.parse({
      version: 3,
      operationId: failed.operationId,
      identity: failed.identity,
      descriptor: failed.descriptor,
      createdAt: failed.createdAt,
      lastObservedAt: new Date(Date.parse(TEST_NOW) + 2000).toISOString(),
      attempts: [],
      overflowCount: 0,
      beginCallHash: failed.beginCallHash,
      retryCount: failed.retryCount,
      lastRetryCallHash: failed.lastRetryCallHash,
      lastResumeCause: 'failed',
      state: 'leased',
      generation: 2,
      lease: {
        token: resume.leaseToken,
        acquiredAt: new Date(Date.parse(TEST_NOW) + 2000).toISOString(),
        renewedAt: new Date(Date.parse(TEST_NOW) + 2000).toISOString(),
        expiresAt: new Date(Date.parse(TEST_NOW) + 2000 + 60_000).toISOString(),
        claimKind: 'resume',
      },
    });
    const actual = actualSnapshot(
      fixture.graph,
      resumed,
      new Date(Date.parse(TEST_NOW) + 2000).toISOString(),
    );
    const handle = fixture.registry.issueResumeAfterAcknowledgedWrite(resume.scope, actual);
    expect(handle).not.toBeNull();
    if (!handle) throw new Error('Expected resumed handle');
    const consumed = fixture.registry.consumeForCompletion(handle, hash('resume completion'));
    const completion = fixture.registry.readConsumedInvocation(consumed);
    const terminalAt = new Date(Date.parse(TEST_NOW) + 3000).toISOString();
    const terminal = committedOperation(resumed, completion.completionCallHash, terminalAt);
    expect(
      fixture.registry.confirmInitialCommitAfterAcknowledgement(
        consumed,
        actualSnapshot(fixture.graph, terminal, terminalAt),
      ),
    ).toBeNull();
    expect(() =>
      fixture.registry.consumeForCompletion(handle, hash('resume second completion')),
    ).toThrow('invalid_handle');
    expect(
      fixture.registry.resultSchemas().completion.safeParse({
        kind: 'committed',
        invocation: 'initial_owner',
        terminalReceipt: terminal.terminalReceipt,
        currentAuthority: 'active',
        eligibleFirstCommit: true,
      }).success,
    ).toBe(false);
  });

  it.each(['active', 'revoked', 'changed'] as const)(
    'retains a false historical begin receipt with current authority %s',
    (currentAuthority) => {
      const f = buildInitial();
      const operation = committedOperation(
        f.operation,
        hash('historical-result'),
        '2026-10-25T12:00:01.000Z',
      );
      const observation = {
        kind: 'committed',
        invocation: 'committed_replay',
        terminalReceipt: operation.terminalReceipt,
        currentAuthority,
        eligibleFirstCommit: false,
      };
      const schema = f.registry.resultSchemas().begin;
      expect(schema.parse(observation)).toEqual(observation);
      expect(schema.safeParse({ ...observation, eligibleFirstCommit: true }).success).toBe(false);
      expect(schema.safeParse({ ...observation, handle: {} }).success).toBe(false);
      expect(schema.safeParse({ ...observation, extra: true }).success).toBe(false);
    },
  );
  it('retains a false cancelled begin observation without a lease or extra fields', () => {
    const f = buildInitial();
    const terminalReceipt = {
      version: 3,
      kind: 'cancelled',
      operationId: f.operation.operationId,
      sourceId: f.operation.identity.sourceId,
      sourceHash: f.operation.identity.sourceHash,
      descriptorHash: f.operation.identity.descriptorHash,
      policyFingerprint: f.operation.identity.policyFingerprint,
      terminalAt: '2026-10-25T12:00:01.000Z',
      acceptedCoverage: 'none',
    };
    const result = { kind: 'cancelled', terminalReceipt, eligibleFirstCommit: false };
    const schema = f.registry.resultSchemas().begin;
    expect(schema.parse(result)).toEqual(result);
    expect(schema.safeParse({ ...result, eligibleFirstCommit: true }).success).toBe(false);
    expect(schema.safeParse({ ...result, handle: {} }).success).toBe(false);
  });
});
