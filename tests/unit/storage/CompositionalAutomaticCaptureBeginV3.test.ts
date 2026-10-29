import { createHash, randomUUID } from 'crypto';
import { makeCompositionalCaptureFixture } from '../../helpers/compositionalCaptureFixture';
import { makeHumanFixture } from '../../helpers/automaticCommittedFixture';
import { prepareHumanCaptureBeginV2 } from '../../../src/storage/AutomaticCaptureBegin';
import { AutomaticWriteOwnerSchema } from '../../../src/schemas/AutomaticClaim.schema';
import { GraphDataSchema, type GraphData } from '../../../src/schemas/GraphData.schema';
import { EpisodicNodeSchema } from '../../../src/schemas/EpisodicNode.schema';
import { EntityEdgeSchema } from '../../../src/schemas/EntityEdge.schema';
import {
  CompositionalAutomaticCaptureBeginRequestV3Schema,
  type CompositionalAutomaticCaptureBeginRequestV3,
} from '../../../src/schemas/CompositionalAutomaticCaptureV3.schema';
import {
  CompositionalAutomaticCaptureOperationV3Schema,
  CompositionalAutomaticCaptureTerminalReceiptV3Schema,
} from '../../../src/schemas/CompositionalAutomaticCaptureV3.schema';
import { buildCompositionalAutomaticDescriptorForRequestV3 } from '../../../src/schemas/CompositionalAutomaticCaptureV3.schema';
import { createCompositionalAutomaticCaptureHandleRegistryV3 } from '../../../src/storage/CompositionalAutomaticCaptureHandlesV3';
import { prepareCompositionalHumanCaptureBeginV3 } from '../../../src/storage/CompositionalAutomaticCaptureBeginV3';

const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const NOW = '2026-10-25T12:05:00.000Z';

type Setup = ReturnType<typeof setup>;

function setup(): {
  graph: GraphData;
  request: CompositionalAutomaticCaptureBeginRequestV3;
  context: { storeHash: string; backendNow: string; previousEpisodeId: string | null };
  registry: ReturnType<typeof createCompositionalAutomaticCaptureHandleRegistryV3>;
  begin: ReturnType<
    ReturnType<typeof createCompositionalAutomaticCaptureHandleRegistryV3>['startInitialBegin']
  >;
  baseSourceId: string;
} {
  const fixture = makeCompositionalCaptureFixture();
  const graph = GraphDataSchema.parse({
    ...fixture.graph,
    automatic_operations_v1: { version: 1, operations: [fixture.operation] },
  });
  const request = CompositionalAutomaticCaptureBeginRequestV3Schema.parse({
    ...fixture.input.request,
    turn: `begin-turn-${randomUUID()}`,
    attemptIdHash: hash(`attempt-${randomUUID()}`),
    source: {
      ...fixture.input.request.source,
      content: 'I prefer concise explanations.',
      sourceMessageId: `message-${randomUUID()}`,
      conversationId: `conversation-${randomUUID()}`,
      senderId: `sender-${randomUUID()}`,
      senderName: 'Synthetic display name',
      sourceWorkflowId: 'synthetic-producer',
      originalSourceExecutionId: `original-${randomUUID()}`,
    },
  });
  const built = buildCompositionalAutomaticDescriptorForRequestV3(request);
  const registry = createCompositionalAutomaticCaptureHandleRegistryV3();
  const begin = registry.startInitialBegin(request.attemptIdHash, built.descriptor);
  return {
    graph,
    request,
    context: {
      storeHash: fixture.input.storeHash,
      backendNow: NOW,
      previousEpisodeId: fixture.source.uuid,
    },
    registry,
    begin,
    baseSourceId: fixture.source.uuid,
  };
}

function prepare(
  value: Setup,
  graph = value.graph,
  request = value.request,
  context = value.context,
  workCheck: () => void = () => {},
) {
  return prepareCompositionalHumanCaptureBeginV3(
    graph,
    request,
    context,
    value.begin.scope,
    value.registry,
    workCheck,
  );
}

function getNewOperation(graph: GraphData, turn: string) {
  const found = graph.automatic_operations_v1?.operations.find(
    (operation) => operation.identity.turn === turn,
  );
  if (!found || found.version !== 3) throw new Error('Expected V3 operation');
  return found;
}

function replaceOperation(graph: GraphData, operationId: string, replacement: unknown): GraphData {
  return GraphDataSchema.parse({
    ...graph,
    automatic_operations_v1: {
      version: 1,
      operations: graph.automatic_operations_v1!.operations.map((operation) =>
        operation.operationId === operationId ? replacement : operation,
      ),
    },
  });
}

function committedGraph(
  graph: GraphData,
  operation: ReturnType<typeof getNewOperation>,
): GraphData {
  if (operation.state !== 'leased') throw new Error('Expected initial leased operation');
  const terminalAt = '2026-10-25T12:06:00.000Z';
  const { lease: _lease, ...common } = operation;
  void _lease;
  const terminalReceipt = CompositionalAutomaticCaptureTerminalReceiptV3Schema.parse({
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
      interpreterResultHash: hash('synthetic interpreter result'),
    },
  });
  const committed = CompositionalAutomaticCaptureOperationV3Schema.parse({
    ...common,
    lastObservedAt: terminalAt,
    completionCallHash: hash('synthetic completion call'),
    state: 'committed',
    terminalReceipt,
  });
  return replaceOperation(graph, operation.operationId, committed);
}

function requestForStoredV1(namespace = `legacy-${randomUUID()}`) {
  const fixture = makeHumanFixture(namespace);
  const owner = AutomaticWriteOwnerSchema.parse(fixture.human.attributes.engram_write_owner_v1);
  return {
    graph: fixture.graph,
    request: CompositionalAutomaticCaptureBeginRequestV3Schema.parse({
      version: 3,
      lifecycle: 'replaySafeV2',
      purpose: 'human_turn_memory',
      preferenceInterpreter: 'compositionalV2',
      namespace,
      issuer: owner.issuer,
      actorReference: owner.actor,
      turn: owner.turn,
      settings: {
        profileId: 'conservative',
        requestedTrustLevel: 'standard',
        intentSetting: false,
        invocationDeadlineMs: 30_000,
      },
      source: {
        content: fixture.human.content,
        sourceMessageId: fixture.human.source_message_id,
        conversationId: fixture.human.conversation_id,
        senderId: fixture.human.sender_id,
        senderName: fixture.human.sender_name,
        sourceWorkflowId: fixture.human.source_workflow_id,
        originalSourceExecutionId: fixture.human.source_execution_id,
        sourceType: 'message',
        quotedMessageId: fixture.human.quoted_message_id,
        eventTime: { mode: 'first_capture' },
        applicationOwnedWrapper: null,
        humanRegion: null,
        quoteRegions: [],
      },
      attemptIdHash: hash(`legacy-attempt-${randomUUID()}`),
    }),
    storeHash: owner.store,
  };
}

describe('pure compositional V3 begin preparation', () => {
  it('prepares a full-root source and generation-one lease together without granting permission', () => {
    const value = setup();
    const before = JSON.stringify(value.graph);
    const result = prepare(value);
    expect(JSON.stringify(value.graph)).toBe(before);
    expect(result.kind).toBe('prepared_claim');
    if (result.kind !== 'prepared_claim') return;

    expect(result.writeRequired).toBe(true);
    expect(result.graph.episodes).toHaveLength(value.graph.episodes.length + 1);
    expect(result.graph.automatic_operations_v1?.operations).toHaveLength(
      value.graph.automatic_operations_v1!.operations.length + 1,
    );
    expect(result.graph.episodes.at(-1)).toMatchObject({
      uuid: value.begin.sourceId,
      previous_episode_uuid: value.context.previousEpisodeId,
      created_at: value.context.backendNow,
    });
    const operation = getNewOperation(result.graph, value.request.turn);
    expect(operation).toMatchObject({
      operationId: value.begin.operationId,
      version: 3,
      state: 'leased',
      generation: 1,
      retryCount: 0,
      beginCallHash: value.begin.beginCallHash,
      attempts: [
        {
          attemptHash: value.request.attemptIdHash,
          at: value.context.backendNow,
          disposition: 'claim_won',
        },
      ],
    });
    expect(operation.state === 'leased' && operation.lease).toMatchObject({
      token: value.begin.leaseToken,
      acquiredAt: value.context.backendNow,
      renewedAt: value.context.backendNow,
      claimKind: 'initial',
    });
    expect(result.leaseFence).toMatchObject({
      operationId: value.begin.operationId,
      sourceId: value.begin.sourceId,
      beginCallHash: value.begin.beginCallHash,
      generation: 1,
    });
    expect(result).not.toHaveProperty('handle');
    expect(result).not.toHaveProperty('should_process');
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.graph.automatic_operations_v1!.operations)).toBe(true);
    expect(Object.isFrozen(operation.identity)).toBe(true);
    expect(value.graph.episodes).toHaveLength(1);
    expect(result.graph.automatic_operations_v1!.operations[0]).toEqual(
      value.graph.automatic_operations_v1!.operations[0],
    );
  });

  it('recovers only the exact same scope lease on callback reentry', () => {
    const value = setup();
    const initial = prepare(value);
    if (initial.kind !== 'prepared_claim') throw new Error('Expected initial claim');
    const displayOnlyRequest = CompositionalAutomaticCaptureBeginRequestV3Schema.parse({
      ...value.request,
      source: { ...value.request.source, senderName: 'Updated display only' },
    });
    const recovered = prepare(value, initial.graph, displayOnlyRequest, {
      ...value.context,
      backendNow: '2026-10-25T12:05:01.000Z',
    });
    expect(recovered.kind).toBe('prepared_claim');
    if (recovered.kind !== 'prepared_claim') return;
    expect(recovered.writeRequired).toBe(false);
    expect(recovered.graph).toEqual(initial.graph);
    expect(recovered.leaseFence).toEqual(initial.leaseFence);
  });

  it('does not turn an independent exact delivery into another claim', () => {
    const value = setup();
    const initial = prepare(value);
    if (initial.kind !== 'prepared_claim') throw new Error('Expected initial claim');
    const secondRegistry = createCompositionalAutomaticCaptureHandleRegistryV3();
    const secondRequest = CompositionalAutomaticCaptureBeginRequestV3Schema.parse({
      ...value.request,
      attemptIdHash: hash('different-delivery-attempt'),
    });
    const descriptor = buildCompositionalAutomaticDescriptorForRequestV3(secondRequest);
    const scope = secondRegistry.startInitialBegin(
      secondRequest.attemptIdHash,
      descriptor.descriptor,
    );
    const observed = prepare(
      { ...value, request: secondRequest, registry: secondRegistry, begin: scope },
      initial.graph,
      secondRequest,
      { ...value.context, backendNow: '2026-10-25T12:05:01.000Z' },
    );
    expect(observed.kind).toBe('prepared_decision');
    if (observed.kind !== 'prepared_decision') return;
    expect(observed.decision.kind).toBe('in_progress');
    expect(getNewOperation(observed.graph, secondRequest.turn).attempts).toHaveLength(2);
    expect(observed.decision).not.toHaveProperty('operationId');
    expect(observed.decision).not.toHaveProperty('should_process');
  });

  it('does not append a duplicate attempt hash from an independent method call', () => {
    const value = setup();
    const initial = prepare(value);
    if (initial.kind !== 'prepared_claim') throw new Error('Expected initial claim');
    const duplicateRegistry = createCompositionalAutomaticCaptureHandleRegistryV3();
    const scope = duplicateRegistry.startInitialBegin(
      value.request.attemptIdHash,
      buildCompositionalAutomaticDescriptorForRequestV3(value.request).descriptor,
    );
    const result = prepare(
      { ...value, registry: duplicateRegistry, begin: scope },
      initial.graph,
      value.request,
      { ...value.context, backendNow: '2026-10-25T12:05:01.000Z' },
    );
    expect(result).toEqual({
      kind: 'decision',
      decision: { kind: 'in_progress', eligibleFirstCommit: false },
    });
    expect(getNewOperation(initial.graph, value.request.turn).attempts).toHaveLength(1);
  });

  it('does not adopt a V3 source that has no matching operation', () => {
    const fixture = makeCompositionalCaptureFixture();
    const request = CompositionalAutomaticCaptureBeginRequestV3Schema.parse(fixture.input.request);
    const registry = createCompositionalAutomaticCaptureHandleRegistryV3();
    const descriptor = buildCompositionalAutomaticDescriptorForRequestV3(request);
    const begin = registry.startInitialBegin(request.attemptIdHash, descriptor.descriptor);
    const graph = GraphDataSchema.parse(fixture.graph);
    const before = JSON.stringify(graph);
    const result = prepareCompositionalHumanCaptureBeginV3(
      graph,
      request,
      {
        storeHash: fixture.input.storeHash,
        backendNow: '2026-10-25T12:01:00.000Z',
        previousEpisodeId: fixture.source.uuid,
      },
      begin.scope,
      registry,
      () => {},
    );
    expect(result).toEqual({
      kind: 'decision',
      decision: { kind: 'source_only_unconfirmed', eligibleFirstCommit: false },
    });
    expect(JSON.stringify(graph)).toBe(before);
  });

  it('rejects V1-owned locators without reinterpreting or rewriting them', () => {
    const fixture = requestForStoredV1();
    const registry = createCompositionalAutomaticCaptureHandleRegistryV3();
    const descriptor = buildCompositionalAutomaticDescriptorForRequestV3(fixture.request);
    const begin = registry.startInitialBegin(fixture.request.attemptIdHash, descriptor.descriptor);
    const before = JSON.stringify(fixture.graph);
    const result = prepareCompositionalHumanCaptureBeginV3(
      fixture.graph,
      fixture.request,
      { storeHash: fixture.storeHash, backendNow: NOW, previousEpisodeId: null },
      begin.scope,
      registry,
      () => {},
    );
    expect(result).toEqual({
      kind: 'decision',
      decision: { kind: 'unsupported_mode', eligibleFirstCommit: false },
    });
    expect(JSON.stringify(fixture.graph)).toBe(before);
  });

  it('treats a legacy human with the same explicit message ID as an unsupported locator', () => {
    const fixture = makeCompositionalCaptureFixture();
    const messageId = `legacy-message-${randomUUID()}`;
    const request = CompositionalAutomaticCaptureBeginRequestV3Schema.parse({
      ...fixture.input.request,
      turn: `new-turn-${randomUUID()}`,
      attemptIdHash: hash(`legacy-collision-${randomUUID()}`),
      source: { ...fixture.input.request.source, sourceMessageId: messageId },
    });
    const legacyHuman = EpisodicNodeSchema.parse({
      uuid: randomUUID(),
      group_id: request.namespace,
      content: 'A migrated human message.',
      role: 'human',
      source_type: 'message',
      reference_time: NOW,
      previous_episode_uuid: null,
      created_at: NOW,
      updated_at: null,
      source_message_id: messageId,
      idempotency_key: null,
      episode_kind: 'legacy',
      attributes: {},
    });
    const graph = GraphDataSchema.parse({ ...fixture.graph, episodes: [legacyHuman] });
    const registry = createCompositionalAutomaticCaptureHandleRegistryV3();
    const descriptor = buildCompositionalAutomaticDescriptorForRequestV3(request);
    const begin = registry.startInitialBegin(request.attemptIdHash, descriptor.descriptor);
    const before = JSON.stringify(graph);

    const result = prepareCompositionalHumanCaptureBeginV3(
      graph,
      request,
      {
        storeHash: fixture.input.storeHash,
        backendNow: NOW,
        previousEpisodeId: legacyHuman.uuid,
      },
      begin.scope,
      registry,
      () => {},
    );

    expect(result).toEqual({
      kind: 'decision',
      decision: { kind: 'unsupported_mode', eligibleFirstCommit: false },
    });
    expect(JSON.stringify(graph)).toBe(before);
  });

  it('does not treat an AI tool episode with the same message ID as a human locator', () => {
    const fixture = makeCompositionalCaptureFixture();
    const messageId = `tool-message-${randomUUID()}`;
    const request = CompositionalAutomaticCaptureBeginRequestV3Schema.parse({
      ...fixture.input.request,
      turn: `new-turn-${randomUUID()}`,
      attemptIdHash: hash(`tool-noncollision-${randomUUID()}`),
      source: { ...fixture.input.request.source, sourceMessageId: messageId },
    });
    const toolEpisode = EpisodicNodeSchema.parse({
      uuid: randomUUID(),
      group_id: request.namespace,
      content: 'A tool response.',
      role: 'ai',
      source_type: 'message',
      reference_time: NOW,
      previous_episode_uuid: null,
      created_at: NOW,
      updated_at: null,
      source_message_id: messageId,
      idempotency_key: null,
      episode_kind: 'tool_output',
      attributes: {},
    });
    const graph = GraphDataSchema.parse({ ...fixture.graph, episodes: [toolEpisode] });
    const registry = createCompositionalAutomaticCaptureHandleRegistryV3();
    const descriptor = buildCompositionalAutomaticDescriptorForRequestV3(request);
    const begin = registry.startInitialBegin(request.attemptIdHash, descriptor.descriptor);

    const result = prepareCompositionalHumanCaptureBeginV3(
      graph,
      request,
      { storeHash: fixture.input.storeHash, backendNow: NOW, previousEpisodeId: null },
      begin.scope,
      registry,
      () => {},
    );

    expect(result.kind).toBe('prepared_claim');
    if (result.kind !== 'prepared_claim') return;
    expect(result.graph.episodes).toHaveLength(2);
    expect(result.graph.episodes.find((episode) => episode.role === 'ai')).toEqual(toolEpisode);
  });

  it('rejects V2 operation locators before attempting V3 source admission', () => {
    const legacy = makeHumanFixture(`v2-locator-${randomUUID()}`);
    const owner = AutomaticWriteOwnerSchema.parse(legacy.human.attributes.engram_write_owner_v1);
    const graph = GraphDataSchema.parse({
      ...legacy.graph,
      episodes: [],
      automatic_operations_v1: undefined,
    });
    const v2Request = {
      version: 2 as const,
      lifecycle: 'replaySafeV2' as const,
      purpose: 'human_turn_memory' as const,
      namespace: legacy.human.group_id,
      issuer: owner.issuer,
      actorReference: owner.actor,
      turn: `v2-turn-${randomUUID()}`,
      attemptIdHash: hash('v2-source-attempt'),
      settings: {
        profileId: 'conservative' as const,
        requestedTrustLevel: 'standard' as const,
        intentSetting: false,
        invocationDeadlineMs: 30_000,
      },
      source: {
        content: legacy.human.content,
        sourceMessageId: legacy.human.source_message_id,
        conversationId: legacy.human.conversation_id,
        senderId: legacy.human.sender_id,
        senderName: legacy.human.sender_name,
        sourceWorkflowId: legacy.human.source_workflow_id,
        originalSourceExecutionId: legacy.human.source_execution_id,
        sourceType: 'message' as const,
        quotedMessageId: legacy.human.quoted_message_id,
        eventTime: { mode: 'first_capture' as const },
        applicationOwnedWrapper: null,
        humanRegion: null,
        quoteRegions: [],
      },
    };
    const v2Prepared = prepareHumanCaptureBeginV2(graph, {
      storeHash: owner.store,
      sourceId: randomUUID(),
      operationId: randomUUID(),
      previousEpisodeId: null,
      backendNow: NOW,
      beginCallHash: hash('v2-begin-call'),
      leaseToken: randomUUID(),
      request: v2Request,
    });
    if (v2Prepared.kind !== 'prepared_claim') throw new Error('Expected V2 source and operation');
    const request = CompositionalAutomaticCaptureBeginRequestV3Schema.parse({
      ...v2Request,
      version: 3,
      purpose: 'human_turn_memory',
      preferenceInterpreter: 'compositionalV2',
      attemptIdHash: hash('v3-same-locator'),
    });
    const registry = createCompositionalAutomaticCaptureHandleRegistryV3();
    const descriptor = buildCompositionalAutomaticDescriptorForRequestV3(request);
    const begin = registry.startInitialBegin(request.attemptIdHash, descriptor.descriptor);
    const before = JSON.stringify(v2Prepared.graph);
    const result = prepareCompositionalHumanCaptureBeginV3(
      v2Prepared.graph,
      request,
      { storeHash: owner.store, backendNow: '2026-10-25T12:05:01.000Z', previousEpisodeId: null },
      begin.scope,
      registry,
      () => {},
    );
    expect(result).toEqual({
      kind: 'decision',
      decision: { kind: 'unsupported_mode', eligibleFirstCommit: false },
    });
    expect(JSON.stringify(v2Prepared.graph)).toBe(before);
  });

  it('returns identity conflicts before reporting a regressed clock', () => {
    const value = setup();
    const initial = prepare(value);
    if (initial.kind !== 'prepared_claim') throw new Error('Expected initial claim');
    const changed = CompositionalAutomaticCaptureBeginRequestV3Schema.parse({
      ...value.request,
      source: { ...value.request.source, content: 'I prefer a different source.' },
    });
    const result = prepare(value, initial.graph, changed, {
      ...value.context,
      backendNow: '2026-10-25T12:04:59.000Z',
    });
    expect(result).toEqual({
      kind: 'decision',
      decision: { kind: 'conflict', eligibleFirstCommit: false },
    });
    expect(JSON.stringify(initial.graph)).not.toContain('different source');
  });

  it('latches the first failed work check and never converts it into an ordinary decision', () => {
    const value = setup();
    const initial = prepare(value);
    if (initial.kind !== 'prepared_claim') throw new Error('Expected initial claim');

    let totalChecks = 0;
    prepare(value, initial.graph, value.request, value.context, () => {
      totalChecks += 1;
    });
    expect(totalChecks).toBeGreaterThan(0);

    for (let failOnCheck = 1; failOnCheck <= totalChecks; failOnCheck += 1) {
      let currentCheck = 0;
      const firstFailure = new Error(`work check ${failOnCheck} failed`);
      let caught: unknown;
      try {
        prepare(value, initial.graph, value.request, value.context, () => {
          currentCheck += 1;
          if (currentCheck === failOnCheck) throw firstFailure;
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBe(firstFailure);
    }
  });

  it('checks the work deadline again after parsing a graph-bearing final result', () => {
    const value = setup();
    let baselineChecks = 0;
    const baseline = prepare(value, value.graph, value.request, value.context, () => {
      baselineChecks += 1;
    });
    expect(baseline.kind).toBe('prepared_claim');

    let currentCheck = 0;
    const deadlineFailure = new Error('deadline elapsed during result parsing');
    let caught: unknown;
    try {
      prepare(value, value.graph, value.request, value.context, () => {
        currentCheck += 1;
        if (currentCheck === baselineChecks) throw deadlineFailure;
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(deadlineFailure);
  });

  it('rejects immutable original producer and descriptor changes without audit', () => {
    const value = setup();
    const initial = prepare(value);
    if (initial.kind !== 'prepared_claim') throw new Error('Expected initial claim');

    const changedProducer = CompositionalAutomaticCaptureBeginRequestV3Schema.parse({
      ...value.request,
      source: {
        ...value.request.source,
        originalSourceExecutionId: 'different-original-execution',
      },
    });
    const producerConflict = prepare(value, initial.graph, changedProducer, {
      ...value.context,
      backendNow: '2026-10-25T12:04:59.000Z',
    });
    expect(producerConflict).toMatchObject({
      kind: 'decision',
      decision: { kind: 'conflict', eligibleFirstCommit: false },
    });

    const changedSettings = CompositionalAutomaticCaptureBeginRequestV3Schema.parse({
      ...value.request,
      attemptIdHash: hash('changed-descriptor-delivery'),
      settings: { ...value.request.settings, profileId: 'reviewFirst' },
    });
    const registry = createCompositionalAutomaticCaptureHandleRegistryV3();
    const scope = registry.startInitialBegin(
      changedSettings.attemptIdHash,
      buildCompositionalAutomaticDescriptorForRequestV3(changedSettings).descriptor,
    );
    const descriptorConflict = prepare(
      { ...value, registry, begin: scope, request: changedSettings },
      initial.graph,
      changedSettings,
      { ...value.context, backendNow: '2026-10-25T12:05:02.000Z' },
    );
    expect(descriptorConflict).toMatchObject({
      kind: 'decision',
      decision: { kind: 'conflict', eligibleFirstCommit: false },
    });
    expect(getNewOperation(initial.graph, value.request.turn).attempts).toHaveLength(1);
  });

  it('records a bounded nonterminal observation only after current authority checks', () => {
    const value = setup();
    const initial = prepare(value);
    if (initial.kind !== 'prepared_claim') throw new Error('Expected initial claim');
    const secondRegistry = createCompositionalAutomaticCaptureHandleRegistryV3();
    const request = CompositionalAutomaticCaptureBeginRequestV3Schema.parse({
      ...value.request,
      attemptIdHash: hash('nonterminal-observation'),
    });
    const descriptor = buildCompositionalAutomaticDescriptorForRequestV3(request);
    const scope = secondRegistry.startInitialBegin(request.attemptIdHash, descriptor.descriptor);
    const changedGraph = GraphDataSchema.parse({
      ...initial.graph,
      episodes: initial.graph.episodes.map((episode) =>
        episode.uuid === value.begin.sourceId ? { ...episode, trust_level: 'trusted' } : episode,
      ),
    });
    const before = JSON.stringify(changedGraph);
    const result = prepare(
      { ...value, registry: secondRegistry, begin: scope, request },
      changedGraph,
      request,
      { ...value.context, backendNow: '2026-10-25T12:05:02.000Z' },
    );
    expect(result).toEqual({
      kind: 'decision',
      decision: { kind: 'authority_changed', eligibleFirstCommit: false },
    });
    expect(JSON.stringify(changedGraph)).toBe(before);
  });

  it('sets only the truncation marker at the shared 32-attempt limit', () => {
    const value = setup();
    const initial = prepare(value);
    if (initial.kind !== 'prepared_claim') throw new Error('Expected initial claim');
    const operation = getNewOperation(initial.graph, value.request.turn);
    const observations = Array.from({ length: 31 }, (_, index) => ({
      attemptHash: hash(`prior-attempt-${index}`),
      at: '2026-10-25T12:05:01.000Z',
      disposition: 'in_progress' as const,
    }));
    const atLimit = CompositionalAutomaticCaptureOperationV3Schema.parse({
      ...operation,
      lastObservedAt: '2026-10-25T12:05:01.000Z',
      attempts: [...operation.attempts, ...observations],
    });
    const graph = replaceOperation(initial.graph, operation.operationId, atLimit);
    const registry = createCompositionalAutomaticCaptureHandleRegistryV3();
    const request = CompositionalAutomaticCaptureBeginRequestV3Schema.parse({
      ...value.request,
      attemptIdHash: hash('attempt-after-limit'),
    });
    const scope = registry.startInitialBegin(
      request.attemptIdHash,
      buildCompositionalAutomaticDescriptorForRequestV3(request).descriptor,
    );
    const result = prepare({ ...value, registry, begin: scope, request }, graph, request, {
      ...value.context,
      backendNow: '2026-10-25T12:05:02.000Z',
    });
    expect(result.kind).toBe('prepared_decision');
    if (result.kind !== 'prepared_decision') return;
    const truncated = getNewOperation(result.graph, request.turn);
    expect(truncated.attempts).toHaveLength(32);
    expect(truncated.auditTruncated).toBe(true);
    expect(truncated.overflowCount).toBe(0);
  });

  it('reports capacity before creating either source or operation at the full record bound', () => {
    const value = setup();
    const entitiesNeeded =
      100_000 -
      value.graph.entities.length -
      value.graph.edges.length -
      value.graph.episodes.length;
    const filler = Array.from({ length: entitiesNeeded }, (_, index) => ({
      uuid: `00000000-0000-4000-8000-${(index + 1).toString(16).padStart(12, '0')}`,
      name: 'Bounded fixture entity',
      group_id: value.request.namespace,
      summary: '',
      entity_type: 'unknown',
      name_embedding: null,
      attributes: {},
      created_at: NOW,
      updated_at: NOW,
    }));
    const fullGraph = {
      ...value.graph,
      entities: [...value.graph.entities, ...filler],
    } as GraphData;
    const beforeEpisodeCount = fullGraph.episodes.length;
    const beforeOperationCount = fullGraph.automatic_operations_v1!.operations.length;
    const result = prepare(value, fullGraph);
    expect(result).toEqual({
      kind: 'decision',
      decision: { kind: 'capacity', eligibleFirstCommit: false },
    });
    expect(fullGraph.episodes).toHaveLength(beforeEpisodeCount);
    expect(fullGraph.automatic_operations_v1!.operations).toHaveLength(beforeOperationCount);
  }, 60_000);

  it('persists one terminal replay attempt while preserving the exact receipt', () => {
    const value = setup();
    const initial = prepare(value);
    if (initial.kind !== 'prepared_claim') throw new Error('Expected initial claim');
    const operation = getNewOperation(initial.graph, value.request.turn);
    const terminal = committedGraph(initial.graph, operation);
    const stored = getNewOperation(terminal, value.request.turn);
    if (stored.state !== 'committed') throw new Error('Expected committed operation');
    const receiptBefore = JSON.stringify(stored.terminalReceipt);
    const secondRegistry = createCompositionalAutomaticCaptureHandleRegistryV3();
    const request = CompositionalAutomaticCaptureBeginRequestV3Schema.parse({
      ...value.request,
      attemptIdHash: hash('terminal-replay-attempt'),
    });
    const descriptor = buildCompositionalAutomaticDescriptorForRequestV3(request);
    const scope = secondRegistry.startInitialBegin(request.attemptIdHash, descriptor.descriptor);
    const result = prepare(
      { ...value, registry: secondRegistry, begin: scope, request },
      terminal,
      request,
      { ...value.context, backendNow: '2026-10-25T12:06:01.000Z' },
    );
    expect(result.kind).toBe('prepared_decision');
    if (result.kind !== 'prepared_decision') return;
    expect(result.decision).toMatchObject({
      kind: 'committed',
      invocation: 'committed_replay',
      currentAuthority: 'active',
      eligibleFirstCommit: false,
    });
    expect(result.graph.episodes).toEqual(terminal.episodes);
    const updated = getNewOperation(result.graph, value.request.turn);
    if (updated.state !== 'committed') throw new Error('Expected committed operation');
    expect(JSON.stringify(updated.terminalReceipt)).toBe(receiptBefore);
    expect(updated.attempts.at(-1)).toMatchObject({
      attemptHash: request.attemptIdHash,
      at: '2026-10-25T12:06:01.000Z',
      disposition: 'committed_replay',
    });
  });

  it('returns terminal history without mutation after authority changes or clock regression', () => {
    const value = setup();
    const initial = prepare(value);
    if (initial.kind !== 'prepared_claim') throw new Error('Expected initial claim');
    const terminal = committedGraph(
      initial.graph,
      getNewOperation(initial.graph, value.request.turn),
    );
    const operation = getNewOperation(terminal, value.request.turn);
    if (operation.state !== 'committed') throw new Error('Expected committed operation');
    const request = CompositionalAutomaticCaptureBeginRequestV3Schema.parse({
      ...value.request,
      attemptIdHash: hash('terminal-history-read'),
    });
    const registry = createCompositionalAutomaticCaptureHandleRegistryV3();
    const descriptor = buildCompositionalAutomaticDescriptorForRequestV3(request);
    const begin = registry.startInitialBegin(request.attemptIdHash, descriptor.descriptor);

    const regressedBefore = JSON.stringify(terminal);
    const regressed = prepareCompositionalHumanCaptureBeginV3(
      terminal,
      request,
      { ...value.context, backendNow: '2026-10-25T12:05:59.000Z' },
      begin.scope,
      registry,
      () => {},
    );
    expect(regressed).toMatchObject({
      kind: 'decision',
      decision: { kind: 'committed', invocation: 'committed_replay', currentAuthority: 'active' },
    });
    expect(JSON.stringify(terminal)).toBe(regressedBefore);

    const changedTrust = GraphDataSchema.parse({
      ...terminal,
      episodes: terminal.episodes.map((episode) =>
        episode.uuid === operation.identity.sourceId
          ? { ...episode, trust_level: 'trusted' }
          : episode,
      ),
    });
    const before = JSON.stringify(changedTrust);
    const changed = prepareCompositionalHumanCaptureBeginV3(
      changedTrust,
      request,
      { ...value.context, backendNow: '2026-10-25T12:06:02.000Z' },
      begin.scope,
      registry,
      () => {},
    );
    expect(changed).toMatchObject({
      kind: 'decision',
      decision: { kind: 'committed', invocation: 'committed_replay', currentAuthority: 'changed' },
    });
    expect(JSON.stringify(changedTrust)).toBe(before);
  });

  it('reads a terminal receipt when the attempt stream is already truncated', () => {
    const value = setup();
    const initial = prepare(value);
    if (initial.kind !== 'prepared_claim') throw new Error('Expected initial claim');
    const terminal = committedGraph(
      initial.graph,
      getNewOperation(initial.graph, value.request.turn),
    );
    const operation = getNewOperation(terminal, value.request.turn);
    if (operation.state !== 'committed') throw new Error('Expected committed operation');
    const truncated = CompositionalAutomaticCaptureOperationV3Schema.parse({
      ...operation,
      auditTruncated: true,
    });
    const graph = replaceOperation(terminal, operation.operationId, truncated);
    const request = CompositionalAutomaticCaptureBeginRequestV3Schema.parse({
      ...value.request,
      attemptIdHash: hash('truncated-terminal-replay'),
    });
    const registry = createCompositionalAutomaticCaptureHandleRegistryV3();
    const scope = registry.startInitialBegin(
      request.attemptIdHash,
      buildCompositionalAutomaticDescriptorForRequestV3(request).descriptor,
    );
    const result = prepare({ ...value, registry, begin: scope, request }, graph, request, {
      ...value.context,
      backendNow: '2026-10-25T12:06:01.000Z',
    });
    expect(result).toMatchObject({
      kind: 'decision',
      decision: {
        kind: 'committed',
        invocation: 'committed_replay',
        currentAuthority: 'active',
        eligibleFirstCommit: false,
      },
    });
    expect(getNewOperation(graph, request.turn)).toEqual(truncated);
  });

  it('propagates cancellation and work-check failures without returning candidates', () => {
    const value = setup();
    value.registry.markInvocationCancelled(value.begin.scope);
    expect(() => prepare(value)).toThrow('Engram compositional capture: interrupted');

    const second = setup();
    const expected = new Error('synthetic_budget_stop');
    expect(() =>
      prepare(second, second.graph, second.request, second.context, () => {
        throw expected;
      }),
    ).toThrow(expected);
  });

  it.each(['entity_edge', 'operation_edge'] as const)(
    'rejects an unrelated full-root %s UUID collision before event selection',
    (kind) => {
      const value = setup();
      const graph = structuredClone(value.graph);
      const id =
        kind === 'entity_edge'
          ? graph.entities[0].uuid
          : graph.automatic_operations_v1!.operations[0].operationId;
      graph.edges.push(
        EntityEdgeSchema.parse({
          uuid: id,
          group_id: graph.entities[0].group_id,
          source_node_uuid: graph.entities[0].uuid,
          target_node_uuid: graph.entities[0].uuid,
          name: 'SYNTHETIC',
          fact: 'Unrelated synthetic record',
          created_at: NOW,
          updated_at: NOW,
        }),
      );
      const before = structuredClone(graph);
      expect(prepare(value, graph)).toMatchObject({
        kind: 'decision',
        decision: { kind: 'invalid_input' },
      });
      expect(graph).toEqual(before);
    },
  );
});
