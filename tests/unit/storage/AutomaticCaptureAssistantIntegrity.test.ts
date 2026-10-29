import { createHash, randomUUID } from 'crypto';
import { buildAutomaticOperationDescriptorV2 } from '../../../src/extraction/AutomaticCaptureDescriptor';
import {
  planAutomaticClaims,
  validateAutomaticPlan,
  committedAutomaticReceipt,
  AUTOMATIC_CLAIM,
  validateAutomaticClaimEvidence,
  validateAutomaticClaimReadContext,
  validateStoredAutomaticClaim,
} from '../../../src/extraction/AutomaticClaims';
import {
  boundedAutomaticClaimReadJsonBytes,
  buildAutomaticClaimReadIndices,
  projectAutomaticClaimReadContext,
  projectAutomaticClaimReadContextWithUsage,
} from '../../../src/extraction/AutomaticClaimCommitProof';
import { automaticClaimVisible } from '../../../src/search/AutomaticRetrieval';
import { ExtractionDiagnostics } from '../../../src/extraction/ExtractionDiagnostics';
import { captureEnvelope, compileAutomaticPolicy } from '../../../src/extraction/AutomaticEvidence';
import {
  AutomaticOperationDescriptorV2Schema,
  AutomaticCaptureSourceOwnerV2Schema,
  automaticOperationDescriptorSettingsHashV2,
  hashAutomaticCaptureV2,
  type AutomaticCaptureSourceOwnerV2,
  type AutomaticOperationDescriptorV2,
} from '../../../src/schemas/AutomaticCapture.schema';
import {
  AutomaticCaptureOperationV2Schema,
  type AutomaticCaptureOperationV2,
} from '../../../src/schemas/AutomaticCaptureOperation.schema';
import type { AutomaticClaimReadScope } from '../../../src/storage/AutomaticClaimReadScope';
import { beginAutomaticClaimReadAttempt } from '../../../src/storage/AutomaticClaimReadScope';
import {
  AutomaticCaptureTerminalReceiptV2Schema,
  type AutomaticCaptureTerminalReceiptV2,
} from '../../../src/schemas/AutomaticCaptureReceipt.schema';
import {
  EntityNodeSchema,
  EpisodicNodeSchema,
  GraphDataSchema,
  type GraphData,
  type EpisodicNode,
} from '../../../src/schemas';
import type { AutomaticWriteOwner } from '../../../src/schemas/AutomaticClaim.schema';
import {
  applyAutomaticBindingCommand,
  assertAutomaticBinding,
  assertAutomaticLedgerSourceIntegrity,
  automaticCaptureOperationIdentityForOwnedSource,
  automaticWriteOwnerIdempotencyKey,
  SOURCE_ENVELOPE_ATTRIBUTE,
  WRITE_OWNER_ATTRIBUTE,
  WRITE_OWNER_V2_ATTRIBUTE,
} from '../../../src/storage/AutomaticIdentity';

const NOW = '2026-10-25T12:00:00.000Z';
const NAMESPACE = 'assistant-integrity-fixture';
const ISSUER = 'synthetic-workflow';
const ACTOR = 'synthetic-human-actor';
const TURN = 'synthetic-turn-001';
const STORE_HASH = digest('synthetic logical store');

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function makeAcceptedSubject(): ReturnType<typeof EntityNodeSchema.parse> {
  return EntityNodeSchema.parse({
    uuid: randomUUID(),
    group_id: NAMESPACE,
    name: 'Synthetic manually reviewed subject',
    entity_type: 'person',
    summary: '',
    created_at: NOW,
    updated_at: NOW,
    attributes: {
      engram_extraction: {
        version: 2,
        source: 'manual',
        confidence: null,
        review_status: 'accepted',
        threshold_decision: 'manually_reviewed',
        extracted_at: NOW,
        episode_uuids: [],
        reviewed_at: NOW,
        reviewed_by: 'synthetic-reviewer',
      },
    },
  });
}

function producerHash(episode: EpisodicNode): string {
  return hashAutomaticCaptureV2({
    source_workflow_id: episode.source_workflow_id,
    source_message_id: episode.source_message_id,
    conversation_id: episode.conversation_id,
    sender_id: episode.sender_id,
    source_type: episode.source_type,
    episode_kind: episode.episode_kind,
    quoted_message_id: episode.quoted_message_id,
  });
}

function makeCommittedHumanOperation(
  episode: EpisodicNode,
  descriptor: AutomaticOperationDescriptorV2,
  identity: ReturnType<typeof automaticCaptureOperationIdentityForOwnedSource>,
  outcome: ReturnType<ExtractionDiagnostics['finish']>,
): AutomaticCaptureOperationV2 {
  const receipt = outcome.automatic;
  if (!receipt) throw new Error('Expected a planned automatic receipt');
  const operationId = randomUUID();
  const descriptorHash = hashAutomaticCaptureV2(descriptor);
  const dependencies = receipt.items.map((item, itemIndex) => ({
    sourceId: episode.uuid,
    dependencyHash: hashAutomaticCaptureV2({
      sourceId: episode.uuid,
      sourceHash: identity.sourceHash,
      itemIndex,
      item,
    }),
    itemIndex,
    ...(item.claimId === undefined ? {} : { claimId: item.claimId }),
    state: item.state,
    persisted: item.persisted,
    reasons: item.reasons,
  }));
  const accepted = receipt.items.filter(
    (item) => item.persisted && (item.state === 'accepted' || item.state === 'unchanged'),
  );
  const terminalReceipt = AutomaticCaptureTerminalReceiptV2Schema.parse({
    version: 2,
    kind: 'human_capture_committed',
    operationId,
    sourceId: episode.uuid,
    sourceHash: identity.sourceHash,
    descriptorHash,
    terminalAt: NOW,
    receiptInspectionComplete: receipt.coverageComplete,
    interpretationCoverage: 'complete',
    acceptedCoverage:
      accepted.length === 0 ? 'none' : accepted.length === receipt.items.length ? 'all' : 'partial',
    dependencies,
    receipt,
  });
  return AutomaticCaptureOperationV2Schema.parse({
    version: 2,
    operationId,
    identity,
    descriptor,
    createdAt: NOW,
    lastObservedAt: NOW,
    attempts: [],
    overflowCount: 0,
    beginCallHash: hashAutomaticCaptureV2({ operationId, call: 'begin-human' }),
    retryCount: 0,
    state: 'committed',
    generation: 1,
    completionCallHash: hashAutomaticCaptureV2({ operationId, call: 'complete-human' }),
    terminalReceipt,
  });
}

interface HumanFixture {
  graph: GraphData;
  human: EpisodicNode;
  humanDescriptor: AutomaticOperationDescriptorV2;
  humanIdentity: ReturnType<typeof automaticCaptureOperationIdentityForOwnedSource>;
  humanOperation: AutomaticCaptureOperationV2;
  binding: {
    bindingId: string;
    revision: number;
    subjectId: string;
    fingerprint: string;
  };
}

function makeHumanFixture(): HumanFixture {
  const subject = makeAcceptedSubject();
  const graph = GraphDataSchema.parse({
    version: '2.0',
    exported_at: NOW,
    group_id: NAMESPACE,
    entities: [subject],
    edges: [],
    episodes: [],
  });
  const bindingRecord = applyAutomaticBindingCommand(
    graph,
    {
      action: 'create',
      namespace: NAMESPACE,
      issuer: ISSUER,
      actorReference: ACTOR,
      subjectId: subject.uuid,
      authorizedBy: 'synthetic-reviewer',
      reason: 'Synthetic manual identity verification',
    },
    randomUUID(),
    NOW,
  );
  const binding = {
    bindingId: bindingRecord.bindingId,
    revision: bindingRecord.revision,
    subjectId: bindingRecord.subjectId,
    fingerprint: bindingRecord.fingerprint,
  };
  const policy = compileAutomaticPolicy({ profileId: 'conservative' });
  const content = 'I prefer concise explanations.';
  const captured = captureEnvelope(
    content,
    content,
    { namespace: NAMESPACE, issuer: ISSUER, actorReference: ACTOR },
    binding,
    false,
    policy,
  );
  if (!captured.ok) throw new Error(`Synthetic human capture failed: ${captured.reason}`);

  const legacyOwner: AutomaticWriteOwner = {
    version: 1,
    store: STORE_HASH,
    namespace: NAMESPACE,
    turn: TURN,
    role: 'human',
    actor: ACTOR,
    issuer: ISSUER,
    binding,
    policy,
    contentHash: digest(content),
  };
  const humanDescriptor = buildAutomaticOperationDescriptorV2({
    purpose: 'human_turn_memory',
    profileId: 'conservative',
    requestedTrustLevel: 'standard',
    intentSetting: false,
    invocationDeadlineMs: 30_000,
  }).descriptor;
  const human = EpisodicNodeSchema.parse({
    uuid: randomUUID(),
    group_id: NAMESPACE,
    content,
    role: 'human',
    source_type: 'message',
    reference_time: NOW,
    previous_episode_uuid: null,
    created_at: NOW,
    updated_at: NOW,
    source_message_id: 'synthetic-human-source',
    source_workflow_id: 'synthetic-producer',
    source_execution_id: 'synthetic-original-execution',
    conversation_id: 'synthetic-conversation',
    sender_id: ACTOR,
    sender_name: 'Synthetic human display',
    idempotency_key: automaticWriteOwnerIdempotencyKey(legacyOwner),
    episode_kind: 'active_human',
    quoted_message_id: null,
    trust_level: 'standard',
    review_status: 'accepted',
    attributes: {
      [SOURCE_ENVELOPE_ATTRIBUTE]: captured.envelope,
      [WRITE_OWNER_ATTRIBUTE]: legacyOwner,
    },
  });
  human.attributes[WRITE_OWNER_V2_ATTRIBUTE] = AutomaticCaptureSourceOwnerV2Schema.parse({
    version: 2,
    lifecycle: 'replaySafeV2',
    storeHash: STORE_HASH,
    namespace: NAMESPACE,
    turn: TURN,
    role: 'human',
    issuer: ISSUER,
    actorReference: ACTOR,
    binding,
    assistantWriteAuthority: null,
    purpose: 'human_turn_memory',
    requestedTrustLevel: 'standard',
    intentSetting: false,
    intentEvidence: captured.envelope.explicitIntent,
    eventTimeMode: 'first_capture',
    eventTimeHash: hashAutomaticCaptureV2({
      mode: 'first_capture',
      normalizedReferenceTime: new Date(NOW).toISOString(),
    }),
    stableProducerHash: producerHash(human),
    sourceContentHash: digest(content),
    settingsHash: humanDescriptor.settingsHash,
    policy,
  });
  const humanIdentity = automaticCaptureOperationIdentityForOwnedSource(human, humanDescriptor);
  graph.episodes.push(human);

  const outcome = new ExtractionDiagnostics().finish();
  outcome.status = 'succeeded';
  const plan = planAutomaticClaims(graph, NAMESPACE, [human.uuid], policy, outcome, NOW);
  if (!validateAutomaticPlan(graph, plan)) throw new Error('Expected the V2 plan to validate');
  if (plan.entities.length === 0 || plan.edges.length === 0) {
    throw new Error('Expected the synthetic human preference to produce stored claims');
  }
  graph.entities.push(...plan.entities);
  graph.edges.push(...plan.edges);
  committedAutomaticReceipt(plan.outcome, NOW);
  const humanOperation = makeCommittedHumanOperation(
    human,
    humanDescriptor,
    humanIdentity,
    plan.outcome,
  );
  graph.automatic_operations_v1 = {
    version: 1,
    operations: [humanOperation],
  };

  return {
    graph: GraphDataSchema.parse(graph),
    human,
    humanDescriptor,
    humanIdentity,
    humanOperation,
    binding,
  };
}

interface AssistantMutation {
  owner?: Partial<
    Pick<
      AutomaticCaptureSourceOwnerV2,
      'namespace' | 'storeHash' | 'actorReference' | 'issuer' | 'turn'
    >
  >;
  authority?: Partial<AutomaticCaptureSourceOwnerV2['assistantWriteAuthority']>;
  sourceUuid?: string;
}

interface AssistantFixture {
  episode: EpisodicNode;
  owner: AutomaticCaptureSourceOwnerV2;
  descriptor: AutomaticOperationDescriptorV2;
  operation: AutomaticCaptureOperationV2;
}

function makeAssistantFixture(
  parent: HumanFixture,
  mutation: AssistantMutation = {},
): AssistantFixture {
  const namespace = mutation.owner?.namespace ?? NAMESPACE;
  const storeHash = mutation.owner?.storeHash ?? STORE_HASH;
  const actorReference = mutation.owner?.actorReference ?? ACTOR;
  const issuer = mutation.owner?.issuer ?? ISSUER;
  const turn = mutation.owner?.turn ?? TURN;
  const content = 'Synthetic final assistant response.';
  const authority = {
    kind: 'owned_human_turn' as const,
    sourceId: parent.humanIdentity.sourceId,
    sourceHash: parent.humanIdentity.sourceHash,
    descriptorHash: hashAutomaticCaptureV2(parent.humanDescriptor),
    requestedAuthorityHash: parent.humanIdentity.requestedAuthorityHash,
    ...mutation.authority,
  };
  const settings = {
    lifecycle: 'replaySafeV2' as const,
    purpose: 'assistant_final_save' as const,
    interpreterId: 'assistant-final-write-v1' as const,
    semanticVersion: 1 as const,
    grammarVersion: null,
    lexiconVersion: null,
    requestedTrustLevel: null,
    intentSetting: null,
    invocationDeadlineMs: 30_000,
    policy: null,
    assistantWriteAuthority: authority,
  };
  const descriptor = AutomaticOperationDescriptorV2Schema.parse({
    version: 2,
    executionMode: 'synchronous',
    ...settings,
    settingsHash: automaticOperationDescriptorSettingsHashV2(settings),
  });
  const episode = EpisodicNodeSchema.parse({
    uuid: mutation.sourceUuid ?? randomUUID(),
    group_id: namespace,
    content,
    role: 'ai',
    source_type: 'message',
    reference_time: NOW,
    previous_episode_uuid: null,
    created_at: NOW,
    updated_at: NOW,
    source_message_id: 'synthetic-assistant-source',
    source_workflow_id: 'synthetic-producer',
    source_execution_id: 'synthetic-assistant-execution',
    conversation_id: 'synthetic-conversation',
    sender_id: actorReference,
    sender_name: 'Synthetic assistant display',
    idempotency_key: automaticWriteOwnerIdempotencyKey({ turn, role: 'assistant' }),
    episode_kind: 'assistant_reply',
    quoted_message_id: null,
    trust_level: 'standard',
    review_status: 'accepted',
    attributes: {},
  });
  const owner = AutomaticCaptureSourceOwnerV2Schema.parse({
    version: 2,
    lifecycle: 'replaySafeV2',
    storeHash,
    namespace,
    turn,
    role: 'assistant',
    issuer,
    actorReference,
    binding: null,
    assistantWriteAuthority: authority,
    purpose: 'assistant_final_save',
    requestedTrustLevel: null,
    intentSetting: null,
    intentEvidence: null,
    eventTimeMode: 'first_capture',
    eventTimeHash: hashAutomaticCaptureV2({
      mode: 'first_capture',
      normalizedReferenceTime: new Date(NOW).toISOString(),
    }),
    stableProducerHash: producerHash(episode),
    sourceContentHash: digest(episode.content),
    settingsHash: descriptor.settingsHash,
    policy: null,
  });
  episode.attributes[WRITE_OWNER_V2_ATTRIBUTE] = owner;
  const identity = automaticCaptureOperationIdentityForOwnedSource(episode, descriptor);
  const operationId = randomUUID();
  const terminalReceipt: AutomaticCaptureTerminalReceiptV2 = {
    version: 2,
    kind: 'assistant_final_saved',
    operationId,
    sourceId: identity.sourceId,
    sourceHash: identity.sourceHash,
    descriptorHash: hashAutomaticCaptureV2(descriptor),
    terminalAt: NOW,
    persisted: true,
  };
  const operation = AutomaticCaptureOperationV2Schema.parse({
    version: 2,
    operationId,
    identity,
    descriptor,
    createdAt: NOW,
    lastObservedAt: NOW,
    attempts: [],
    overflowCount: 0,
    beginCallHash: hashAutomaticCaptureV2({ operationId, call: 'begin-assistant' }),
    retryCount: 0,
    state: 'committed',
    generation: 1,
    completionCallHash: hashAutomaticCaptureV2({ operationId, call: 'complete-assistant' }),
    terminalReceipt,
  });
  return { episode, owner, descriptor, operation };
}

function graphWithAssistant(
  parent: HumanFixture,
  assistant = makeAssistantFixture(parent),
): GraphData {
  const graph = structuredClone(parent.graph);
  graph.episodes.push(assistant.episode);
  graph.automatic_operations_v1?.operations.push(assistant.operation);
  return GraphDataSchema.parse(graph);
}

function expectIntegrityFailure(graph: GraphData, code: string): void {
  expect(() => assertAutomaticLedgerSourceIntegrity(graph)).toThrow(code);
}

describe('native assistant capture source integrity', () => {
  it('validates a full historical human capture, committed plan, and assistant-only source', () => {
    const parent = makeHumanFixture();
    const assistant = makeAssistantFixture(parent);
    expect(Object.keys(assistant.episode.attributes)).toEqual([WRITE_OWNER_V2_ATTRIBUTE]);
    expect(assistant.owner.assistantWriteAuthority).toMatchObject({
      kind: 'owned_human_turn',
      sourceId: parent.human.uuid,
      sourceHash: parent.humanIdentity.sourceHash,
      descriptorHash: hashAutomaticCaptureV2(parent.humanDescriptor),
      requestedAuthorityHash: parent.humanIdentity.requestedAuthorityHash,
    });
    expect(() =>
      assertAutomaticLedgerSourceIntegrity(graphWithAssistant(parent, assistant)),
    ).not.toThrow();
  });

  it('accepts an assistant-only source with no assistant ledger operation when its parent is committed', () => {
    const parent = makeHumanFixture();
    const assistant = makeAssistantFixture(parent);
    const graph = structuredClone(parent.graph);
    graph.episodes.push(assistant.episode);
    expect(() => assertAutomaticLedgerSourceIntegrity(GraphDataSchema.parse(graph))).not.toThrow();
  });

  it('requires a human parent operation and requires it to be committed, not cancelled', () => {
    const parent = makeHumanFixture();
    const assistant = makeAssistantFixture(parent);

    const missing = structuredClone(graphWithAssistant(parent, assistant));
    missing.automatic_operations_v1!.operations = [assistant.operation];
    expectIntegrityFailure(missing, 'invalid_source_reference');

    const captured = structuredClone(parent.humanOperation) as Record<string, unknown>;
    delete captured.terminalReceipt;
    delete captured.completionCallHash;
    captured.state = 'captured';
    captured.generation = 0;
    const noncommitted = structuredClone(graphWithAssistant(parent, assistant));
    noncommitted.automatic_operations_v1!.operations[0] =
      AutomaticCaptureOperationV2Schema.parse(captured);
    expectIntegrityFailure(noncommitted, 'invalid_source_reference');

    const cancelled = structuredClone(graphWithAssistant(parent, assistant));
    const cancelledHuman = AutomaticCaptureOperationV2Schema.parse({
      version: 2,
      operationId: parent.humanOperation.operationId,
      identity: parent.humanOperation.identity,
      descriptor: parent.humanOperation.descriptor,
      createdAt: NOW,
      lastObservedAt: NOW,
      attempts: [],
      overflowCount: 0,
      beginCallHash: parent.humanOperation.beginCallHash,
      retryCount: 0,
      state: 'cancelled',
      generation: 1,
      terminalReceipt: {
        version: 2,
        kind: 'cancelled',
        operationId: parent.humanOperation.operationId,
        sourceId: parent.humanIdentity.sourceId,
        sourceHash: parent.humanIdentity.sourceHash,
        descriptorHash: hashAutomaticCaptureV2(parent.humanDescriptor),
        terminalAt: NOW,
        acceptedCoverage: 'none',
      },
    });
    cancelled.automatic_operations_v1!.operations[0] = cancelledHuman;
    expectIntegrityFailure(cancelled, 'invalid_source_reference');
  });

  it.each([
    ['namespace', { owner: { namespace: 'crossed-namespace' } }],
    ['store', { owner: { storeHash: digest('crossed store') } }],
    ['actor', { owner: { actorReference: 'crossed-actor' } }],
    ['issuer', { owner: { issuer: 'crossed-issuer' } }],
    ['turn', { owner: { turn: 'crossed-turn' } }],
    ['source', { authority: { sourceId: randomUUID() } }],
    ['source hash', { authority: { sourceHash: digest('crossed human source') } }],
    ['descriptor hash', { authority: { descriptorHash: digest('crossed descriptor') } }],
    [
      'requested authority hash',
      { authority: { requestedAuthorityHash: digest('crossed authority') } },
    ],
  ] as const)('rejects a coherent assistant owner crossed on %s', (_field, mutation) => {
    const parent = makeHumanFixture();
    const assistant = makeAssistantFixture(parent, mutation);
    expectIntegrityFailure(graphWithAssistant(parent, assistant), 'invalid_source_reference');
  });

  it('rejects a human source envelope copied onto an assistant episode', () => {
    const parent = makeHumanFixture();
    const assistant = makeAssistantFixture(parent);
    const graph = graphWithAssistant(parent, assistant);
    const storedAssistant = graph.episodes.find(
      (episode) => episode.uuid === assistant.episode.uuid,
    )!;
    storedAssistant.attributes[SOURCE_ENVELOPE_ATTRIBUTE] =
      parent.human.attributes[SOURCE_ENVELOPE_ATTRIBUTE];
    storedAssistant.attributes[WRITE_OWNER_ATTRIBUTE] =
      parent.human.attributes[WRITE_OWNER_ATTRIBUTE];
    expectIntegrityFailure(graph, 'invalid_source_envelope');
  });

  it('rejects changed parent content after rebuilding its envelope and both source owners', () => {
    const parent = makeHumanFixture();
    const assistant = makeAssistantFixture(parent);
    const graph = graphWithAssistant(parent, assistant);
    const human = graph.episodes.find((episode) => episode.uuid === parent.human.uuid)!;
    const legacyOwner = human.attributes[WRITE_OWNER_ATTRIBUTE] as AutomaticWriteOwner;
    const v2Owner = human.attributes[WRITE_OWNER_V2_ATTRIBUTE] as AutomaticCaptureSourceOwnerV2;
    if (!v2Owner.binding) throw new Error('Expected a bound human source owner');
    const content = 'I prefer concise answers.';
    const captured = captureEnvelope(
      content,
      content,
      {
        namespace: v2Owner.namespace,
        issuer: v2Owner.issuer,
        actorReference: v2Owner.actorReference,
      },
      v2Owner.binding,
      v2Owner.intentSetting,
      v2Owner.policy,
    );
    if (!captured.ok) throw new Error(`Synthetic parent recapture failed: ${captured.reason}`);

    human.content = content;
    human.attributes[SOURCE_ENVELOPE_ATTRIBUTE] = captured.envelope;
    human.attributes[WRITE_OWNER_ATTRIBUTE] = { ...legacyOwner, contentHash: digest(content) };
    human.attributes[WRITE_OWNER_V2_ATTRIBUTE] = {
      ...v2Owner,
      sourceContentHash: digest(content),
      intentEvidence: captured.envelope.explicitIntent,
    };
    expectIntegrityFailure(graph, 'invalid_source_owner');
  });

  it('rejects an assistant reference after the parent descriptor and identity are coherently rebuilt', () => {
    const parent = makeHumanFixture();
    const assistant = makeAssistantFixture(parent);
    const graph = graphWithAssistant(parent, assistant);
    const human = graph.episodes.find((episode) => episode.uuid === parent.human.uuid)!;
    const descriptor = buildAutomaticOperationDescriptorV2({
      purpose: 'human_turn_memory',
      profileId: 'conservative',
      requestedTrustLevel: 'standard',
      intentSetting: false,
      invocationDeadlineMs: 30_001,
    }).descriptor;
    const sourceOwner = human.attributes[WRITE_OWNER_V2_ATTRIBUTE] as AutomaticCaptureSourceOwnerV2;
    human.attributes[WRITE_OWNER_V2_ATTRIBUTE] = {
      ...sourceOwner,
      settingsHash: descriptor.settingsHash,
    };
    const identity = automaticCaptureOperationIdentityForOwnedSource(human, descriptor);
    const operations = graph.automatic_operations_v1!.operations;
    const humanIndex = operations.findIndex(
      (operation) => operation.identity.sourceId === parent.human.uuid,
    );
    const prior = operations[humanIndex];
    if (!prior || prior.version !== 2 || prior.state !== 'committed') {
      throw new Error('Expected the historical human operation to be committed V2');
    }
    operations[humanIndex] = AutomaticCaptureOperationV2Schema.parse({
      ...prior,
      descriptor,
      identity,
      terminalReceipt: {
        ...prior.terminalReceipt,
        sourceHash: identity.sourceHash,
        descriptorHash: hashAutomaticCaptureV2(descriptor),
      },
    });
    expectIntegrityFailure(graph, 'invalid_source_reference');
  });

  it('rejects an assistant identity that reuses a human source UUID with the wrong role', () => {
    const parent = makeHumanFixture();
    const assistant = makeAssistantFixture(parent);
    const graph = graphWithAssistant(parent, assistant);
    const storedAssistant = graph.episodes.find(
      (episode) => episode.uuid === assistant.episode.uuid,
    )!;
    storedAssistant.uuid = parent.human.uuid;
    expectIntegrityFailure(graph, 'invalid_source_reference');
  });

  it('rejects malformed and unknown source-owner versions', () => {
    const parent = makeHumanFixture();
    const assistant = makeAssistantFixture(parent);

    const malformed = graphWithAssistant(parent, assistant);
    const malformedEpisode = malformed.episodes.find(
      (episode) => episode.uuid === assistant.episode.uuid,
    )!;
    malformedEpisode.attributes[WRITE_OWNER_V2_ATTRIBUTE] = { version: 2, purpose: 'unknown' };
    expectIntegrityFailure(malformed, 'invalid_write_owner');

    const unknown = graphWithAssistant(parent, assistant);
    const unknownEpisode = unknown.episodes.find(
      (episode) => episode.uuid === assistant.episode.uuid,
    )!;
    unknownEpisode.attributes.engram_write_owner_v99 = {};
    expectIntegrityFailure(unknown, 'invalid_write_owner');
  });

  it('keeps historical integrity after mutable review changes and binding revocation', () => {
    const parent = makeHumanFixture();
    const assistant = makeAssistantFixture(parent);
    const graph = graphWithAssistant(parent, assistant);
    const storedHuman = graph.episodes.find((episode) => episode.uuid === parent.human.uuid)!;
    storedHuman.review_status = 'rejected';
    storedHuman.trust_level = 'untrusted';
    storedHuman.sender_name = 'Changed display';
    storedHuman.updated_at = '2026-10-25T12:01:00.000Z';

    const revoked = applyAutomaticBindingCommand(
      graph,
      {
        action: 'revoke',
        namespace: NAMESPACE,
        bindingId: parent.binding.bindingId,
        expectedRevision: parent.binding.revision,
        authorizedBy: 'synthetic-reviewer',
        reason: 'Synthetic identity revocation after capture',
      },
      randomUUID(),
      '2026-10-25T12:02:00.000Z',
    );
    expect(revoked.state).toBe('revoked');
    expect(() => assertAutomaticLedgerSourceIntegrity(graph)).not.toThrow();

    const envelope = graph.episodes.find((episode) => episode.uuid === parent.human.uuid)!
      .attributes[SOURCE_ENVELOPE_ATTRIBUTE];
    expect(() => assertAutomaticBinding(graph, envelope as never)).toThrow('binding_revoked');
  });
});

describe('committed automatic claim read proof', () => {
  it('projects only an exact committed human operation and receipt dependency', () => {
    const parent = makeHumanFixture();
    const edge = parent.graph.edges[0];
    const indices = buildAutomaticClaimReadIndices(parent.graph);
    const result = projectAutomaticClaimReadContext(parent.graph, NAMESPACE, edge.uuid, indices);
    expect(result.status).toBe('committed');
    if (result.status !== 'committed') return;
    expect(result.context.proof).toMatchObject({
      kind: 'committed_human_capture',
      operationId: parent.humanOperation.operationId,
    });
    expect(result.context.proof.terminalReceipt.kind).toBe('human_capture_committed');
    expect(result.context.proof).not.toHaveProperty('attempts');
    expect(validateAutomaticClaimReadContext(edge, result.context)).toBe(true);
    expect(validateStoredAutomaticClaim(parent.graph, edge)).toBe(true);
    const staleCandidates = [
      { ...edge, fact: `${edge.fact} changed` },
      { ...edge, source_node_uuid: randomUUID() },
      { ...edge, target_node_uuid: randomUUID() },
      { ...edge, episodes: [] },
      { ...edge, attributes: { ...edge.attributes, changed: true } },
    ];
    for (const stale of staleCandidates) {
      expect(validateAutomaticClaimReadContext(stale, result.context)).toBe(false);
    }
  });

  it('accounts each located full-root row once and stops bounded inspection at cap plus one', () => {
    const parent = makeHumanFixture();
    const edge = parent.graph.edges[0];
    const source = parent.graph.episodes.find((episode) => episode.uuid === parent.human.uuid)!;
    const subject = parent.graph.entities.find((entity) => entity.uuid === edge.source_node_uuid)!;
    const value = parent.graph.entities.find((entity) => entity.uuid === edge.target_node_uuid)!;
    const usage = projectAutomaticClaimReadContextWithUsage(
      parent.graph,
      NAMESPACE,
      edge.uuid,
      buildAutomaticClaimReadIndices(parent.graph),
    );
    const expectedBytes = [edge, source, subject, value, parent.humanOperation].reduce(
      (total, record) => total + Buffer.byteLength(JSON.stringify(record), 'utf8'),
      0,
    );
    expect(usage.result.status).toBe('committed');
    expect(usage.inspectedBytes).toBe(expectedBytes);

    const oversized = structuredClone(parent.graph);
    const oversizedSubject = oversized.entities.find(
      (entity) => entity.uuid === edge.source_node_uuid,
    )!;
    oversizedSubject.summary = 'x'.repeat(600 * 1024);
    const tooLarge = projectAutomaticClaimReadContextWithUsage(
      oversized,
      NAMESPACE,
      edge.uuid,
      undefined,
      512 * 1024,
    );
    expect(tooLarge).toMatchObject({
      result: { status: 'invalid', reason: 'context_too_large' },
      inspectedBytes: 512 * 1024 + 1,
    });
    expect(boundedAutomaticClaimReadJsonBytes('x'.repeat(1000), 10)).toBe(11);
    const hugeString = 'x'.repeat(5 * 1024 * 1024);
    const charCodeAtSpy = jest.spyOn(String.prototype, 'charCodeAt');
    let hugeStringBytes: number;
    let hugeStringScanCount: number;
    try {
      hugeStringBytes = boundedAutomaticClaimReadJsonBytes(hugeString, 512 * 1024);
      hugeStringScanCount = charCodeAtSpy.mock.calls.length;
    } finally {
      charCodeAtSpy.mockRestore();
    }
    expect(hugeStringBytes).toBe(512 * 1024 + 1);
    expect(hugeStringScanCount).toBe(0);
    const wideUnknown = Object.fromEntries(
      Array.from({ length: 10_001 }, (_unused, index) => [`unknown_${index}`, undefined]),
    );
    expect(boundedAutomaticClaimReadJsonBytes(wideUnknown, 100)).toBe(101);
    const sparse = new Array(10_001);
    expect(boundedAutomaticClaimReadJsonBytes(sparse, 100)).toBe(101);
  });

  it('keeps evidence-only precommit validation separate from stored proof validation', () => {
    const parent = makeHumanFixture();
    const graph = structuredClone(parent.graph);
    const edge = graph.edges[0];
    delete graph.automatic_operations_v1;

    expect(validateAutomaticClaimEvidence(graph, edge)).toBe(true);
    expect(validateStoredAutomaticClaim(graph, edge)).toBe(false);
    expect(projectAutomaticClaimReadContext(graph, NAMESPACE, edge.uuid)).toMatchObject({
      status: 'uncommitted',
      reason: 'missing_operation',
    });
  });

  it('bounds untrusted direct contexts before schema parsing can read accessors', () => {
    const parent = makeHumanFixture();
    const edge = parent.graph.edges[0];
    const projected = projectAutomaticClaimReadContext(parent.graph, NAMESPACE, edge.uuid);
    if (projected.status !== 'committed') throw new Error('Expected committed fixture context');

    let getterCalled = false;
    const untrusted: Record<string, unknown> = { ...projected.context };
    Object.defineProperty(untrusted, 'extra', {
      enumerable: true,
      get: () => {
        getterCalled = true;
        return 'untrusted getter';
      },
    });

    expect(validateAutomaticClaimReadContext(edge, untrusted as never)).toBe(false);
    expect(getterCalled).toBe(false);
  });

  it('revalidates same-batch staged duplicates as evidence, without requiring a prior commit', () => {
    const parent = makeHumanFixture();
    const graph = structuredClone(parent.graph);
    const source = graph.episodes.find((episode) => episode.uuid === parent.human.uuid)!;
    const duplicate = structuredClone(source);
    const secondTurn = `${TURN}-second`;
    duplicate.uuid = randomUUID();
    duplicate.idempotency_key = automaticWriteOwnerIdempotencyKey({
      turn: secondTurn,
      role: 'human',
    });
    duplicate.attributes[WRITE_OWNER_ATTRIBUTE] = {
      ...(duplicate.attributes[WRITE_OWNER_ATTRIBUTE] as AutomaticWriteOwner),
      turn: secondTurn,
    };
    duplicate.attributes[WRITE_OWNER_V2_ATTRIBUTE] = {
      ...(duplicate.attributes[WRITE_OWNER_V2_ATTRIBUTE] as AutomaticCaptureSourceOwnerV2),
      turn: secondTurn,
    };
    const subject = graph.entities.find((entity) => entity.uuid === parent.binding.subjectId)!;
    graph.entities = [subject];
    graph.edges = [];
    graph.episodes = [source, duplicate];
    delete graph.automatic_operations_v1;

    const outcome = new ExtractionDiagnostics().finish();
    outcome.status = 'succeeded';
    const plan = planAutomaticClaims(
      graph,
      NAMESPACE,
      [source.uuid, duplicate.uuid],
      compileAutomaticPolicy({ profileId: 'conservative' }),
      outcome,
      NOW,
    );
    expect(plan.edges).toHaveLength(1);
    expect(() => validateAutomaticPlan(graph, plan)).not.toThrow();
  });

  it.each(['captured', 'leased', 'failed', 'interrupted', 'cancelled'] as const)(
    'hides %s source operations from current and historical views',
    (state) => {
      const parent = makeHumanFixture();
      const noncommitted = structuredClone(parent.humanOperation) as Record<string, unknown>;
      delete noncommitted.terminalReceipt;
      delete noncommitted.completionCallHash;
      if (state === 'captured') {
        noncommitted.state = 'captured';
        noncommitted.generation = 0;
      } else if (state === 'leased') {
        noncommitted.state = 'leased';
        noncommitted.generation = 1;
        noncommitted.lease = {
          token: randomUUID(),
          acquiredAt: NOW,
          renewedAt: NOW,
          expiresAt: new Date(Date.parse(NOW) + 60_000).toISOString(),
          claimKind: 'initial',
        };
      } else if (state === 'failed') {
        noncommitted.state = 'failed';
        noncommitted.generation = 1;
        noncommitted.failedAt = NOW;
        noncommitted.failureCode = 'provider_error';
      } else if (state === 'interrupted') {
        noncommitted.state = 'interrupted';
        noncommitted.generation = 1;
        noncommitted.interruptedAt = NOW;
        noncommitted.failureCode = 'invocation_interrupted';
      } else {
        noncommitted.state = 'cancelled';
        noncommitted.generation = 1;
        noncommitted.terminalReceipt = {
          version: 2,
          kind: 'cancelled',
          operationId: parent.humanOperation.operationId,
          sourceId: parent.humanIdentity.sourceId,
          sourceHash: parent.humanIdentity.sourceHash,
          descriptorHash: hashAutomaticCaptureV2(parent.humanDescriptor),
          terminalAt: NOW,
          acceptedCoverage: 'none',
        };
      }
      const graph = structuredClone(parent.graph);
      graph.automatic_operations_v1!.operations[0] =
        AutomaticCaptureOperationV2Schema.parse(noncommitted);
      for (const historicalEvidence of [false, true]) {
        expect(
          projectAutomaticClaimReadContext(graph, NAMESPACE, graph.edges[0].uuid),
        ).toMatchObject({ status: 'uncommitted' });
        expect(
          validateStoredAutomaticClaim(graph, graph.edges[0], undefined, historicalEvidence),
        ).toBe(false);
      }
    },
  );

  it('rejects ambiguous operations and dependencies that do not bind the exact claim item', () => {
    const parent = makeHumanFixture();
    const ambiguousGraph = structuredClone(parent.graph);
    ambiguousGraph.automatic_operations_v1!.operations.push(structuredClone(parent.humanOperation));
    expect(
      projectAutomaticClaimReadContext(ambiguousGraph, NAMESPACE, ambiguousGraph.edges[0].uuid),
    ).toMatchObject({ status: 'ambiguous', reason: 'ambiguous_operation' });

    const tamperDependency = [
      (dependency: Record<string, unknown>) => (dependency.claimId = randomUUID()),
      (dependency: Record<string, unknown>) => (dependency.sourceId = randomUUID()),
      (dependency: Record<string, unknown>) => (dependency.itemIndex = 31),
      (dependency: Record<string, unknown>) => (dependency.state = 'rejected'),
    ];
    for (const tamper of tamperDependency) {
      const graph = structuredClone(parent.graph);
      const operation = graph.automatic_operations_v1!.operations[0];
      if (
        operation.version !== 2 ||
        operation.state !== 'committed' ||
        operation.terminalReceipt.kind !== 'human_capture_committed'
      ) {
        throw new Error('Expected a committed human operation');
      }
      const dependency = operation.terminalReceipt.dependencies.find(
        (item) => item.claimId === graph.edges[0].uuid,
      );
      if (!dependency) throw new Error('Expected a claim dependency');
      tamper(dependency as unknown as Record<string, unknown>);
      expect(
        projectAutomaticClaimReadContext(graph, NAMESPACE, graph.edges[0].uuid),
      ).not.toMatchObject({ status: 'committed' });
    }
  });

  it('rejects wrong claim policy, source, subject, issuer, and terminal operation links', () => {
    const parent = makeHumanFixture();
    const claimMutations = [
      (claim: Record<string, unknown>) =>
        (claim.policy = compileAutomaticPolicy({ profileId: 'reviewFirst' })),
      (claim: Record<string, unknown>) => (claim.subjectId = randomUUID()),
      (claim: Record<string, unknown>) => (claim.sourceId = randomUUID()),
      (claim: Record<string, unknown>) => (claim.issuer = 'crossed-issuer'),
    ];
    for (const mutate of claimMutations) {
      const graph = structuredClone(parent.graph);
      const claim = graph.edges[0].attributes[AUTOMATIC_CLAIM] as Record<string, unknown>;
      mutate(claim);
      expect(
        projectAutomaticClaimReadContext(graph, NAMESPACE, graph.edges[0].uuid),
      ).not.toMatchObject({ status: 'committed' });
    }

    for (const field of ['operationId', 'sourceHash'] as const) {
      const graph = structuredClone(parent.graph);
      const operation = graph.automatic_operations_v1!.operations[0];
      if (operation.version !== 2 || operation.state !== 'committed') {
        throw new Error('Expected a committed V2 operation');
      }
      if (field === 'operationId') operation.operationId = randomUUID();
      else operation.identity.sourceHash = digest('crossed source hash');
      expect(
        projectAutomaticClaimReadContext(graph, NAMESPACE, graph.edges[0].uuid),
      ).not.toMatchObject({ status: 'committed' });
    }
  });

  it('requires the exact source and edge item dependency, without comparing mutable review state', () => {
    const parent = makeHumanFixture();
    const graph = structuredClone(parent.graph);
    const edge = graph.edges[0];
    const operation = graph.automatic_operations_v1!.operations[0];
    if (
      operation.version !== 2 ||
      operation.state !== 'committed' ||
      operation.terminalReceipt.kind !== 'human_capture_committed'
    ) {
      throw new Error('Expected a committed V2 human operation');
    }
    const dependency = operation.terminalReceipt.dependencies.find(
      (item) => item.claimId === edge.uuid,
    );
    if (!dependency) throw new Error('Expected exact claim dependency');
    dependency.claimId = randomUUID();
    expect(projectAutomaticClaimReadContext(graph, NAMESPACE, edge.uuid)).toMatchObject({
      status: 'invalid',
      reason: 'invalid_operation',
    });

    const historical = structuredClone(parent.graph);
    const target = historical.entities.find((entity) => entity.uuid === edge.target_node_uuid)!;
    (target.attributes.engram_extraction as { review_status: string }).review_status = 'rejected';
    applyAutomaticBindingCommand(
      historical,
      {
        action: 'revoke',
        namespace: NAMESPACE,
        bindingId: parent.binding.bindingId,
        expectedRevision: parent.binding.revision,
        authorizedBy: 'synthetic-reviewer',
        reason: 'Synthetic post-capture revocation',
      },
      parent.binding.bindingId,
      NOW,
    );
    const historicalEdge = historical.edges[0];
    expect(validateStoredAutomaticClaim(historical, historicalEdge)).toBe(false);
    expect(validateStoredAutomaticClaim(historical, historicalEdge, undefined, true)).toBe(true);
  });

  it('uses the optional V2 capability after the legacy three source hydrations', async () => {
    const parent = makeHumanFixture();
    const edge = parent.graph.edges[0];
    const budget = { remaining: 512, deferred: 0 };
    const readAutomaticClaimContext = jest.fn(
      async (groupId: string, edgeId: string, scope: AutomaticClaimReadScope) => {
        expect(beginAutomaticClaimReadAttempt(scope)).toBe(true);
        return projectAutomaticClaimReadContext(parent.graph, groupId, edgeId);
      },
    );
    const storage = {
      getEntity: async (uuid: string) =>
        parent.graph.entities.find((entity) => entity.uuid === uuid) ?? null,
      getEpisode: async (uuid: string) =>
        parent.graph.episodes.find((episode) => episode.uuid === uuid) ?? null,
      getEdgesBetween: async () => [],
      readAutomaticClaimContext,
    };
    const view = await automaticClaimVisible(storage as never, edge, budget, { remaining: 128 });
    expect(view).toBe('current');
    expect(readAutomaticClaimContext).toHaveBeenCalledTimes(1);
    expect(budget.remaining).toBe(505);
    expect(budget.deferred).toBe(0);
  });

  it('uses the shared capability scope to validate a related V2 polarity conflict', async () => {
    const parent = makeHumanFixture();
    const graph = structuredClone(parent.graph);
    const policy = compileAutomaticPolicy({ profileId: 'conservative' });
    const content = 'I do not like concise explanations.';
    const captured = captureEnvelope(
      content,
      content,
      { namespace: NAMESPACE, issuer: ISSUER, actorReference: ACTOR },
      parent.binding,
      false,
      policy,
    );
    if (!captured.ok) throw new Error(`Synthetic conflicting capture failed: ${captured.reason}`);

    const second = structuredClone(parent.human);
    const secondTurn = `${TURN}-opposite`;
    second.uuid = randomUUID();
    second.content = content;
    second.idempotency_key = automaticWriteOwnerIdempotencyKey({
      turn: secondTurn,
      role: 'human',
    });
    second.attributes[SOURCE_ENVELOPE_ATTRIBUTE] = captured.envelope;
    second.attributes[WRITE_OWNER_ATTRIBUTE] = {
      ...(second.attributes[WRITE_OWNER_ATTRIBUTE] as AutomaticWriteOwner),
      turn: secondTurn,
      contentHash: digest(content),
    };
    second.attributes[WRITE_OWNER_V2_ATTRIBUTE] = {
      ...(second.attributes[WRITE_OWNER_V2_ATTRIBUTE] as AutomaticCaptureSourceOwnerV2),
      turn: secondTurn,
      sourceContentHash: digest(content),
      intentEvidence: captured.envelope.explicitIntent,
    };
    graph.episodes.push(second);
    const outcome = new ExtractionDiagnostics().finish();
    outcome.status = 'succeeded';
    const plan = planAutomaticClaims(graph, NAMESPACE, [second.uuid], policy, outcome, NOW);
    expect(plan.edges).toHaveLength(1);
    expect(
      (plan.edges[0].attributes.engram_extraction as { review_status: string }).review_status,
    ).toBe('proposed');
    graph.entities.push(...plan.entities);
    graph.edges.push(...plan.edges);
    committedAutomaticReceipt(plan.outcome, NOW);
    graph.automatic_operations_v1!.operations.push(
      makeCommittedHumanOperation(
        second,
        parent.humanDescriptor,
        automaticCaptureOperationIdentityForOwnedSource(second, parent.humanDescriptor),
        plan.outcome,
      ),
    );
    const validGraph = GraphDataSchema.parse(graph);
    const candidate = validGraph.edges.find((edge) => edge.uuid === parent.graph.edges[0].uuid)!;
    const budget = { remaining: 512, deferred: 0 };
    const scopes: AutomaticClaimReadScope[] = [];
    const readAutomaticClaimContext = jest.fn(
      async (groupId: string, edgeId: string, scope: AutomaticClaimReadScope) => {
        scopes.push(scope);
        expect(beginAutomaticClaimReadAttempt(scope)).toBe(true);
        return projectAutomaticClaimReadContext(validGraph, groupId, edgeId);
      },
    );
    const storage = {
      getEntity: async (uuid: string) =>
        validGraph.entities.find((entity) => entity.uuid === uuid) ?? null,
      getEpisode: async (uuid: string) =>
        validGraph.episodes.find((episode) => episode.uuid === uuid) ?? null,
      getEdgesBetween: async (sourceUuid: string, targetUuid: string) =>
        validGraph.edges.filter(
          (edge) => edge.source_node_uuid === sourceUuid && edge.target_node_uuid === targetUuid,
        ),
      readAutomaticClaimContext,
    };
    await expect(
      automaticClaimVisible(storage as never, candidate, budget, { remaining: 128 }),
    ).resolves.toBe('hidden');
    expect(readAutomaticClaimContext).toHaveBeenCalledTimes(2);
    expect(scopes[1]).toBe(scopes[0]);
    expect(budget.remaining).toBe(500);
    expect(budget.deferred).toBe(0);
  });

  it.each(['deferred', 'throw'] as const)(
    'counts one shared deferral when a V2 capability %s',
    async (failure) => {
      const parent = makeHumanFixture();
      const edge = parent.graph.edges[0];
      const budget = { remaining: 512, deferred: 0 };
      const readAutomaticClaimContext = jest.fn(
        async (_groupId: string, _edgeId: string, scope: AutomaticClaimReadScope) => {
          expect(beginAutomaticClaimReadAttempt(scope)).toBe(true);
          if (failure === 'throw') throw new Error('internal backend detail must not escape');
          return { status: 'deferred', reason: 'budget_exhausted' } as const;
        },
      );
      const storage = {
        getEntity: async (uuid: string) =>
          parent.graph.entities.find((entity) => entity.uuid === uuid) ?? null,
        getEpisode: async (uuid: string) =>
          parent.graph.episodes.find((episode) => episode.uuid === uuid) ?? null,
        getEdgesBetween: async () => [],
        readAutomaticClaimContext,
      };
      await expect(
        automaticClaimVisible(storage as never, edge, budget, { remaining: 128 }),
      ).resolves.toBe('hidden');
      expect(budget.remaining).toBe(505);
      expect(budget.deferred).toBe(1);
      expect(JSON.stringify(budget)).not.toContain('internal backend detail');
    },
  );

  it('reuses the same registered scope across repeated candidate reads on one budget', async () => {
    const parent = makeHumanFixture();
    const edge = parent.graph.edges[0];
    const budget = { remaining: 512, deferred: 0 };
    const scopes: AutomaticClaimReadScope[] = [];
    const readAutomaticClaimContext = jest.fn(
      async (groupId: string, edgeId: string, scope: AutomaticClaimReadScope) => {
        scopes.push(scope);
        expect(beginAutomaticClaimReadAttempt(scope)).toBe(true);
        return projectAutomaticClaimReadContext(parent.graph, groupId, edgeId);
      },
    );
    const storage = {
      getEntity: async (uuid: string) =>
        parent.graph.entities.find((entity) => entity.uuid === uuid) ?? null,
      getEpisode: async (uuid: string) =>
        parent.graph.episodes.find((episode) => episode.uuid === uuid) ?? null,
      getEdgesBetween: async () => [],
      readAutomaticClaimContext,
    };
    const first = await automaticClaimVisible(storage as never, edge, budget, { remaining: 128 });
    const second = await automaticClaimVisible(storage as never, edge, budget, { remaining: 128 });
    expect([first, second]).toEqual(['current', 'current']);
    expect(scopes).toHaveLength(2);
    expect(scopes[1]).toBe(scopes[0]);
    expect(budget.remaining).toBe(498);
    expect(budget.deferred).toBe(0);
  });

  it('hides V2 claims and counts one deferral when the optional capability is absent', async () => {
    const parent = makeHumanFixture();
    const edge = parent.graph.edges[0];
    const budget = { remaining: 512, deferred: 0 };
    const storage = {
      getEntity: async (uuid: string) =>
        parent.graph.entities.find((entity) => entity.uuid === uuid) ?? null,
      getEpisode: async (uuid: string) =>
        parent.graph.episodes.find((episode) => episode.uuid === uuid) ?? null,
    };
    await expect(
      automaticClaimVisible(storage as never, edge, budget, { remaining: 128 }),
    ).resolves.toBe('hidden');
    expect(budget.remaining).toBe(509);
    expect(budget.deferred).toBe(1);
  });
});
