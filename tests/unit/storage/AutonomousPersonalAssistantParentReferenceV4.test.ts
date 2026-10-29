import { createHash, randomUUID } from 'crypto';
import {
  AutomaticCaptureSourceOwnerStoredV2Schema,
  AssistantWriteAuthorityReferenceV2Schema,
  AutomaticCaptureSourceOwnerV2Schema,
  AutomaticOperationIdentityV2Schema,
  AutomaticOperationDescriptorSettingsV2Schema,
  AutomaticOperationDescriptorV2Schema,
  automaticOperationDescriptorSettingsHashV2,
  canonicalAutomaticCaptureV2,
  hashAutomaticCaptureV2,
  type AssistantWriteAuthorityReferenceV2,
} from '../../../src/schemas/AutomaticCapture.schema';
import {
  AutomaticAssistantCaptureAuthorizationDataV2Schema,
  AutomaticAssistantCaptureIntentV2Schema,
  AutomaticAssistantDescriptorSettingsV2Schema,
} from '../../../src/schemas/AutomaticAssistantCapture.schema';
import { AutomaticCaptureOperationV2Schema } from '../../../src/schemas/AutomaticCaptureOperation.schema';
import {
  AssistantWriteAuthorityReferenceV4Schema,
  type AssistantWriteAuthorityReferenceV4,
} from '../../../src/schemas/AssistantWriteAuthorityReferenceV4.schema';
import {
  AutonomousPersonalOperationV4OwnedDataSchema,
  AutonomousPersonalReceiptV4OwnedDataSchema,
} from '../../../src/schemas/AutonomousPersonalOperationV4.schema';
import { EpisodicNodeSchema, GraphDataSchema, type GraphData } from '../../../src/schemas';
import {
  automaticWriteOwnerIdempotencyKey,
  automaticCaptureOperationIdentityForOwnedSource,
  autonomousPersonalAssistantOperationIdentityV4,
  assertAutomaticLedgerSourceIntegrity,
  WRITE_OWNER_V2_ATTRIBUTE,
} from '../../../src/storage/AutomaticIdentity';
import { autonomousPersonalQualifiedClaimFixtureV4 } from '../../helpers/autonomousPersonalQualifiedClaimV4';

const NOW = '2026-10-25T12:00:00.000Z';

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

type ParentGraph = Awaited<ReturnType<typeof autonomousPersonalQualifiedClaimFixtureV4>>['graph'];
type ParentAuthority = AssistantWriteAuthorityReferenceV2 | AssistantWriteAuthorityReferenceV4;
type AssistantScopeMutation = Partial<{
  storeHash: string;
  namespace: string;
  issuer: string;
  actorReference: string;
  turn: string;
}>;

function committedParentOperation(graph: ParentGraph) {
  const operation = graph.automatic_operations_v1?.operations.find(
    (candidate) => candidate.version === 4,
  );
  if (!operation || operation.version !== 4 || operation.state !== 'committed') {
    throw new Error('Expected a synthetic committed V4 parent operation');
  }
  return operation;
}

function sourceProducerHash(episode: ReturnType<typeof EpisodicNodeSchema.parse>): string {
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

function makeAssistantGraph(
  parentGraph: ParentGraph,
  options: {
    authority?: ParentAuthority;
    referenceMutation?: Partial<AssistantWriteAuthorityReferenceV4>;
    scopeMutation?: AssistantScopeMutation;
  } = {},
): GraphData {
  // This synthetic stored assistant DATA isolates the global structural join;
  // it does not exercise or claim a native assistant write/origin proof.
  const parent = committedParentOperation(parentGraph);
  const rawAuthority: ParentAuthority =
    options.authority ??
    AssistantWriteAuthorityReferenceV4Schema.parse({
      kind: 'owned_human_turn_v4',
      parentFamily: 'autonomous-personal-v1',
      parentOperationId: parent.operationId,
      sourceId: parent.identity.sourceId,
      sourceHash: parent.identity.sourceHash,
      descriptorHash: parent.identity.descriptorHash,
      requestedAuthorityHash: parent.identity.requestedAuthorityHash,
    });
  const authority =
    rawAuthority.kind === 'owned_human_turn_v4'
      ? AssistantWriteAuthorityReferenceV4Schema.parse({
          ...rawAuthority,
          ...options.referenceMutation,
        })
      : AssistantWriteAuthorityReferenceV2Schema.parse(rawAuthority);
  const scope = {
    storeHash: parent.identity.storeHash,
    namespace: parent.identity.namespace,
    issuer: parent.identity.issuer,
    actorReference: parent.identity.actorReference,
    turn: parent.identity.turn,
    ...options.scopeMutation,
  };
  const content = 'A synthetic final assistant answer.';
  const episode = EpisodicNodeSchema.parse({
    uuid: randomUUID(),
    group_id: scope.namespace,
    content,
    role: 'ai',
    source_type: 'message',
    reference_time: NOW,
    previous_episode_uuid: null,
    created_at: NOW,
    updated_at: NOW,
    source_message_id: `assistant-source-${randomUUID()}`,
    source_workflow_id: 'synthetic-assistant-producer',
    source_execution_id: 'synthetic-assistant-execution',
    conversation_id: 'synthetic-assistant-conversation',
    sender_id: scope.actorReference,
    sender_name: 'Synthetic assistant',
    idempotency_key: automaticWriteOwnerIdempotencyKey({ turn: scope.turn, role: 'assistant' }),
    episode_kind: 'assistant_reply',
    quoted_message_id: null,
    trust_level: 'standard',
    review_status: 'accepted',
    attributes: {},
  });
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
  const settingsHash = hashAutomaticCaptureV2(settings);
  const descriptor = AutomaticOperationDescriptorV2Schema.parse({
    version: 2,
    executionMode: 'synchronous',
    ...settings,
    settingsHash,
  });
  const owner = AutomaticCaptureSourceOwnerStoredV2Schema.parse({
    version: 2,
    lifecycle: 'replaySafeV2',
    ...scope,
    role: 'assistant',
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
    stableProducerHash: sourceProducerHash(episode),
    sourceContentHash: digest(content),
    settingsHash,
    policy: null,
  });
  episode.attributes[WRITE_OWNER_V2_ATTRIBUTE] = owner;

  const sourceFields = Object.fromEntries(
    Object.entries(episode).filter(([key]) => key !== 'updated_at'),
  );
  const immutableProducerProvenance = {
    uuid: episode.uuid,
    group_id: episode.group_id,
    content: episode.content,
    role: episode.role,
    source_type: episode.source_type,
    episode_kind: episode.episode_kind,
    reference_time: episode.reference_time,
    previous_episode_uuid: episode.previous_episode_uuid,
    source_message_id: episode.source_message_id,
    idempotency_key: episode.idempotency_key,
    conversation_id: episode.conversation_id,
    sender_id: episode.sender_id,
    source_workflow_id: episode.source_workflow_id,
    source_execution_id: episode.source_execution_id,
    quoted_message_id: episode.quoted_message_id,
    created_at: episode.created_at,
  };
  const identity = AutomaticOperationIdentityV2Schema.parse({
    lifecycle: owner.lifecycle,
    storeHash: owner.storeHash,
    namespace: owner.namespace,
    issuer: owner.issuer,
    actorReference: owner.actorReference,
    turn: owner.turn,
    role: owner.role,
    purpose: owner.purpose,
    binding: owner.binding,
    sourceId: episode.uuid,
    sourceHash: digest(canonicalAutomaticCaptureV2(sourceFields)),
    originalProducerHash: hashAutomaticCaptureV2({
      v2Owner: owner,
      exactV1OwnerOrNull: null,
      exactV1EnvelopeOrNull: null,
      immutableProducerProvenance,
    }),
    stableProducerHash: owner.stableProducerHash,
    requestedAuthorityHash: hashAutomaticCaptureV2({
      lifecycle: owner.lifecycle,
      storeHash: owner.storeHash,
      namespace: owner.namespace,
      issuer: owner.issuer,
      actorReference: owner.actorReference,
      turn: owner.turn,
      role: owner.role,
      purpose: owner.purpose,
      sourceId: episode.uuid,
      sourceContentHash: owner.sourceContentHash,
      stableProducerHash: owner.stableProducerHash,
      eventTimeMode: owner.eventTimeMode,
      eventTimeHash: owner.eventTimeHash,
      settingsHash: owner.settingsHash,
      binding: owner.binding,
    }),
  });
  const operationId = randomUUID();
  const descriptorHash = hashAutomaticCaptureV2(descriptor);
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
    terminalReceipt: {
      version: 2,
      kind: 'assistant_final_saved',
      operationId,
      sourceId: identity.sourceId,
      sourceHash: identity.sourceHash,
      descriptorHash,
      terminalAt: NOW,
      persisted: true,
    },
  });
  const graph = structuredClone(parentGraph);
  graph.episodes.push(episode);
  graph.automatic_operations_v1?.operations.push(operation);
  return GraphDataSchema.parse(graph);
}

function withParentReceiptBranch(
  graphValue: ParentGraph,
  branch: 'occurrences' | 'source_verdict' | 'deferred',
): ParentGraph {
  const graph = structuredClone(graphValue);
  const index = graph.automatic_operations_v1!.operations.findIndex(
    (candidate) => candidate.version === 4,
  );
  const operation = graph.automatic_operations_v1!.operations[index]!;
  if (operation.version !== 4 || operation.state !== 'committed')
    throw new Error('Expected committed V4 parent');
  if (branch === 'occurrences') return graph;

  const common = {
    version: 4 as const,
    operationId: operation.operationId,
    sourceId: operation.identity.sourceId,
    sourceHash: operation.identity.sourceHash,
    descriptorHash: operation.identity.descriptorHash,
    policyFingerprint: operation.descriptor.policy.fingerprint,
    terminalAt: operation.terminalReceipt.terminalAt,
  };
  const terminalReceipt =
    branch === 'source_verdict'
      ? AutonomousPersonalReceiptV4OwnedDataSchema.parse({
          ...common,
          kind: 'human_autonomous_source_verdict_committed',
          interpretationCoverage: 'complete',
          acceptedCoverage: 'none',
          acceptanceSemantics: 'per_item_kind_v1',
          sourceCoverage: {
            status: 'complete',
            scanStatus: 'complete',
            sourceUnitCount: 1,
            candidateUnitCount: 0,
            neutralUnitCount: 1,
            withheldUnitCount: 0,
            unresolvedUnitCount: 0,
            unresolvedReason: null,
          },
          selection: { kind: 'source_verdict', outcome: 'known_no_memory' },
        })
      : AutonomousPersonalReceiptV4OwnedDataSchema.parse({
          ...common,
          kind: 'human_autonomous_source_deferred_committed',
          interpretationCoverage: 'unknown',
          acceptedCoverage: 'none',
          acceptanceSemantics: 'per_item_kind_v1',
          sourceCoverage: {
            status: 'unknown',
            scanStatus: 'complete',
            sourceUnitCount: 1,
            candidateUnitCount: 0,
            neutralUnitCount: 0,
            withheldUnitCount: 0,
            unresolvedUnitCount: 1,
            unresolvedReason: 'provider_failure',
          },
          selection: { kind: 'source_only_deferred', reason: 'provider_network' },
        });
  graph.automatic_operations_v1!.operations[index] =
    AutonomousPersonalOperationV4OwnedDataSchema.parse({
      ...operation,
      lastObservedAt: terminalReceipt.terminalAt,
      terminalReceipt,
    });
  return GraphDataSchema.parse(graph);
}

describe('stored assistant reference to autonomous human parent V4', () => {
  let parentGraph: ParentGraph;

  beforeAll(async () => {
    parentGraph = (await autonomousPersonalQualifiedClaimFixtureV4()).graph;
  });

  it('keeps the public V2 reference and authorization/settings inputs V2-only', () => {
    const parent = committedParentOperation(parentGraph);
    const reference = AssistantWriteAuthorityReferenceV4Schema.parse({
      kind: 'owned_human_turn_v4',
      parentFamily: 'autonomous-personal-v1',
      parentOperationId: parent.operationId,
      sourceId: parent.identity.sourceId,
      sourceHash: parent.identity.sourceHash,
      descriptorHash: parent.identity.descriptorHash,
      requestedAuthorityHash: parent.identity.requestedAuthorityHash,
    });
    const legacySettings = {
      lifecycle: 'replaySafeV2',
      purpose: 'assistant_final_save',
      interpreterId: 'assistant-final-write-v1',
      semanticVersion: 1,
      grammarVersion: null,
      lexiconVersion: null,
      requestedTrustLevel: null,
      intentSetting: null,
      invocationDeadlineMs: 30_000,
      policy: null,
      assistantWriteAuthority: reference,
    };
    const intent = AutomaticAssistantCaptureIntentV2Schema.parse({
      version: 2,
      lifecycle: 'replaySafeV2',
      purpose: 'assistant_final_save',
      humanTurn: {
        namespace: parent.identity.namespace,
        issuer: parent.identity.issuer,
        actorReference: parent.identity.actorReference,
        turn: parent.identity.turn,
        input: {
          content: 'Synthetic source turn.',
          applicationOwnedWrapper: null,
          humanRegion: null,
          quoteRegions: [],
        },
      },
      finalAssistant: {
        content: 'Synthetic final answer.',
        sourceMessageId: 'assistant-message-v2',
        conversationId: 'assistant-conversation-v2',
        senderId: 'synthetic-assistant',
        senderName: 'Synthetic assistant',
        sourceWorkflowId: 'synthetic-workflow',
        originalSourceExecutionId: 'synthetic-execution',
        sourceType: 'message',
        quotedMessageId: null,
        eventTime: { mode: 'first_capture' },
      },
      attemptIdHash: 'a'.repeat(64),
      invocationDeadlineMs: 30_000,
    });

    expect(AssistantWriteAuthorityReferenceV2Schema.safeParse(reference).success).toBe(false);
    const storedOwner = makeAssistantGraph(parentGraph).episodes.find(
      (episode) => episode.role === 'ai',
    )!.attributes[WRITE_OWNER_V2_ATTRIBUTE];
    expect(AutomaticCaptureSourceOwnerV2Schema.safeParse(storedOwner).success).toBe(false);
    expect(AutomaticCaptureSourceOwnerStoredV2Schema.safeParse(storedOwner).success).toBe(true);
    expect(AutomaticOperationDescriptorSettingsV2Schema.safeParse(legacySettings).success).toBe(
      false,
    );
    expect(AutomaticAssistantDescriptorSettingsV2Schema.safeParse(legacySettings).success).toBe(
      false,
    );
    expect(
      AutomaticAssistantCaptureAuthorizationDataV2Schema.safeParse({
        intent,
        intentHash: 'b'.repeat(64),
        storeHash: parent.identity.storeHash,
        humanOperationId: parent.operationId,
        humanIdentityHash: 'c'.repeat(64),
        humanAuthority: reference,
      }).success,
    ).toBe(false);
    expect(
      AutomaticAssistantCaptureIntentV2Schema.safeParse({
        ...intent,
        assistantWriteAuthority: reference,
      }).success,
    ).toBe(false);
    expect(
      AssistantWriteAuthorityReferenceV4Schema.safeParse({
        ...reference,
        unexpected: true,
      }).success,
    ).toBe(false);
    expect(
      AssistantWriteAuthorityReferenceV4Schema.safeParse({
        ...reference,
        parentFamily: 'other-family',
      }).success,
    ).toBe(false);
  });

  it.each(['occurrences', 'source_verdict', 'deferred'] as const)(
    'joins the exact committed V4 source, operation and receipt for the %s branch',
    (branch) => {
      const graph = withParentReceiptBranch(parentGraph, branch);
      const combined = makeAssistantGraph(graph);
      assertAutomaticLedgerSourceIntegrity(combined);
      const assistant = combined.episodes.find((episode) => episode.role === 'ai')!;
      const operation = combined.automatic_operations_v1!.operations.find(
        (row) => row.identity.role === 'assistant',
      )!;
      if (operation.version !== 2) throw new Error('Expected assistant Operation2 DATA');
      expect(
        autonomousPersonalAssistantOperationIdentityV4(assistant, operation.descriptor),
      ).toEqual(operation.identity);
      expect(() =>
        automaticCaptureOperationIdentityForOwnedSource(assistant, operation.descriptor),
      ).toThrow();
    },
  );

  it.each([
    ['parent operation id', { parentOperationId: randomUUID() }],
    ['source id', { sourceId: randomUUID() }],
    ['source hash', { sourceHash: '1'.repeat(64) }],
    ['descriptor hash', { descriptorHash: '2'.repeat(64) }],
    ['requested authority hash', { requestedAuthorityHash: '3'.repeat(64) }],
  ] as const)('rejects a mismatched V4 reference %s', (_axis, referenceMutation) => {
    expect(() =>
      assertAutomaticLedgerSourceIntegrity(makeAssistantGraph(parentGraph, { referenceMutation })),
    ).toThrow('invalid_source_reference');
  });

  it.each([
    ['store hash', { storeHash: '4'.repeat(64) }],
    ['namespace', { namespace: 'other-assistant-namespace' }],
    ['issuer', { issuer: 'other-assistant-issuer' }],
    ['actor', { actorReference: 'other-assistant-actor' }],
    ['turn', { turn: 'other-assistant-turn' }],
  ] as const)('rejects a mismatched assistant-owner %s join', (_axis, scopeMutation) => {
    expect(() =>
      assertAutomaticLedgerSourceIntegrity(makeAssistantGraph(parentGraph, { scopeMutation })),
    ).toThrow('invalid_source_reference');
  });

  it('keeps V2 references on V2/V3 parents and does not let one refer to an Op4 parent', () => {
    const parent = committedParentOperation(parentGraph);
    const legacyReference: AssistantWriteAuthorityReferenceV2 =
      AssistantWriteAuthorityReferenceV2Schema.parse({
        kind: 'owned_human_turn',
        sourceId: parent.identity.sourceId,
        sourceHash: parent.identity.sourceHash,
        descriptorHash: parent.identity.descriptorHash,
        requestedAuthorityHash: parent.identity.requestedAuthorityHash,
      });
    expect(() =>
      assertAutomaticLedgerSourceIntegrity(
        makeAssistantGraph(parentGraph, { authority: legacyReference }),
      ),
    ).toThrow('invalid_source_reference');
  });

  it('treats the parent join as historical structure, independent of mutable source review state', () => {
    const graph = structuredClone(parentGraph);
    const source = graph.episodes.find(
      (episode) => episode.uuid === committedParentOperation(graph).identity.sourceId,
    )!;
    source.review_status = 'rejected';
    const checked = GraphDataSchema.parse(graph);
    assertAutomaticLedgerSourceIntegrity(makeAssistantGraph(checked));
  });

  it('retains the original V2 descriptor settings hash preimage for V2 references', () => {
    const parent = committedParentOperation(parentGraph);
    const reference = {
      kind: 'owned_human_turn' as const,
      sourceId: parent.identity.sourceId,
      sourceHash: parent.identity.sourceHash,
      descriptorHash: parent.identity.descriptorHash,
      requestedAuthorityHash: parent.identity.requestedAuthorityHash,
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
      assistantWriteAuthority: reference,
    };
    expect(automaticOperationDescriptorSettingsHashV2(settings)).toBe(
      hashAutomaticCaptureV2(settings),
    );
    expect(AutomaticOperationDescriptorSettingsV2Schema.parse(settings)).toEqual(settings);
  });
});
