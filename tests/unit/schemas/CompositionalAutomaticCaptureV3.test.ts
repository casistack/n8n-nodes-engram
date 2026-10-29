import { createHash } from 'crypto';
import {
  COMPOSITIONAL_AUTOMATIC_LIMITS,
  CompositionalAutomaticDescriptorV3Schema,
  CompositionalAutomaticPolicyV2Schema,
  compileCompositionalAutomaticDescriptorV3,
} from '../../../src/schemas/CompositionalAutomaticMemory.schema';
import {
  CompositionalAutomaticCaptureBeginRequestV3Schema,
  CompositionalAutomaticCaptureOwnedSourceV3Schema,
  CompositionalAutomaticCaptureOperationV3Schema,
  CompositionalAutomaticCaptureSourceEnvelopeV2Schema,
  CompositionalAutomaticCaptureSourceOwnerV3Schema,
  CompositionalAutomaticCaptureTerminalReceiptV3Schema,
  CompositionalAutomaticOperationIdentityV3Schema,
  buildCompositionalAutomaticDescriptorForRequestV3,
  compositionalCaptureBundleHashV3,
  compositionalCaptureEventTimeHashV3,
  compositionalCaptureInterpreterResultHashV3,
  compositionalCaptureMeaningHashV3,
  compositionalCaptureOperationIdentityHashV3,
  compositionalCaptureOriginalProducerHashV3,
  compositionalCapturePredicateDependenciesV3,
  compositionalCapturePredicateDependencyHashV3,
  compositionalCaptureRequestedAuthorityHashV3,
  compositionalCaptureSourceContentHashV3,
  compositionalCaptureSourceHashV3,
  compositionalCaptureStableProducerHashV3,
  COMPOSITIONAL_CAPTURE_V2_ENVELOPE_ATTRIBUTE,
  COMPOSITIONAL_CAPTURE_V3_OWNER_ATTRIBUTE,
  type CompositionalAutomaticCaptureBeginRequestV3,
  type CompositionalAutomaticBundleReceiptItemV3,
  type CompositionalAutomaticCaptureTerminalReceiptV3,
  type CompositionalAutomaticOperationIdentityV3,
  type CompositionalAutomaticStableProducerFieldsV3,
} from '../../../src/schemas/CompositionalAutomaticCaptureV3.schema';
import { COMPOSITIONAL_PREFERENCE_V2_DESCRIPTOR } from '../../../src/schemas/CompositionalPreferenceV2.schema';
import { interpretCompositionalPreferencesV2 } from '../../../src/extraction/CompositionalPreferenceV2Parser';
import { projectCompositionalPreferenceV2Meaning } from '../../../src/extraction/CompositionalPreferenceV2Meaning';

const namespace = 'capture-v3-schema-test';
const issuer = 'synthetic-app';
const actorReference = 'synthetic-actor';
const turn = 'turn-v3-schema-test';
const subjectId = '11111111-1111-4111-8111-111111111111';
const bindingId = '33333333-3333-4333-8333-333333333333';
const sourceId = '22222222-2222-4222-8222-222222222222';
const operationId = '44444444-4444-4444-8444-444444444444';
const binding = {
  bindingId,
  revision: 1,
  subjectId,
  fingerprint: 'b'.repeat(64),
};
const sha = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const canonicalDate = '2026-10-25T12:00:00.000Z';
const uuidAt = (index: number) => `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
const semanticReceiptReasons = [
  'reported_statement',
  'third_party',
  'hypothetical',
  'instruction',
  'unsupported_grammar',
  'unsupported_operator',
  'unsupported_topic',
  'unsupported_scope',
  'sensitive_scope',
  'ambiguous_attachment',
  'mixed_clauses',
] as const;

function maximumSemanticReceiptReasons() {
  return Array.from(
    { length: 16 },
    (_, index) => semanticReceiptReasons[index % semanticReceiptReasons.length]!,
  );
}

function requestFixture(): CompositionalAutomaticCaptureBeginRequestV3 {
  return CompositionalAutomaticCaptureBeginRequestV3Schema.parse({
    version: 3,
    lifecycle: 'replaySafeV2',
    purpose: 'human_turn_memory',
    preferenceInterpreter: 'compositionalV2',
    namespace,
    issuer,
    actorReference,
    turn,
    settings: {
      profileId: 'conservative',
      requestedTrustLevel: 'standard',
      intentSetting: false,
      invocationDeadlineMs: 10_000,
    },
    source: {
      content: 'I prefer concise explanations.',
      sourceMessageId: 'human-source-v3',
      conversationId: 'conversation-v3',
      senderId: actorReference,
      senderName: 'Synthetic Human',
      sourceWorkflowId: 'synthetic-workflow',
      originalSourceExecutionId: 'original-human-execution',
      sourceType: 'message',
      quotedMessageId: null,
      eventTime: { mode: 'first_capture' },
      applicationOwnedWrapper: null,
      humanRegion: null,
      quoteRegions: [],
    },
    attemptIdHash: sha('attempt-v3'),
  });
}

function sourceFixture() {
  const request = requestFixture();
  const { descriptor, descriptorHash } = buildCompositionalAutomaticDescriptorForRequestV3(request);
  const rawContent = request.source.content;
  const sourceEnvelope = {
    version: 2 as const,
    namespace,
    issuer,
    actorReference,
    bindingRef: binding,
    contentHash: sha(rawContent),
    rawContentHash: sha(rawContent),
    mappingAuthority: 'whole_source' as const,
    humanRegion: { start: 0, end: rawContent.length },
    mappings: [
      {
        contentStart: 0,
        contentEnd: rawContent.length,
        rawStart: 0,
        rawEnd: rawContent.length,
      },
    ],
    quoteRegions: [],
    explicitIntent: false,
    policy: descriptor.policy,
  };
  const envelope = CompositionalAutomaticCaptureSourceEnvelopeV2Schema.parse({
    version: 2,
    sourceEnvelope,
    settingsHash: descriptor.settingsHash,
    descriptorHash,
  });
  const producerFields: CompositionalAutomaticStableProducerFieldsV3 = {
    source_workflow_id: request.source.sourceWorkflowId,
    source_message_id: request.source.sourceMessageId,
    conversation_id: request.source.conversationId,
    sender_id: request.source.senderId,
    source_type: 'message',
    episode_kind: 'active_human',
    quoted_message_id: request.source.quotedMessageId,
  };
  const stableProducerHash = compositionalCaptureStableProducerHashV3(producerFields);
  const referenceTime = canonicalDate;
  const sourceContentHash = compositionalCaptureSourceContentHashV3(rawContent);
  const owner = CompositionalAutomaticCaptureSourceOwnerV3Schema.parse({
    version: 3,
    lifecycle: 'replaySafeV2',
    purpose: 'human_turn_memory',
    role: 'human',
    storeHash: sha('logical-store-v3'),
    namespace,
    turn,
    issuer,
    actorReference,
    binding,
    eventTimeMode: 'first_capture',
    eventTimeHash: compositionalCaptureEventTimeHashV3('first_capture', referenceTime),
    stableProducerHash,
    sourceContentHash,
    settingsHash: descriptor.settingsHash,
    descriptorHash,
    policyFingerprint: descriptor.policy.fingerprint,
    requestedTrustLevel: descriptor.requestedTrustLevel,
    intentSetting: descriptor.intentSetting,
    intentEvidence: sourceEnvelope.explicitIntent,
  });
  const ownerProvenance = {
    uuid: sourceId,
    group_id: namespace,
    content: rawContent,
    role: 'human' as const,
    source_type: 'message' as const,
    episode_kind: 'active_human' as const,
    reference_time: referenceTime,
    previous_episode_uuid: null,
    source_message_id: request.source.sourceMessageId,
    idempotency_key: 'synthetic-idempotency-key',
    conversation_id: request.source.conversationId,
    sender_id: request.source.senderId,
    source_workflow_id: request.source.sourceWorkflowId,
    source_execution_id: request.source.originalSourceExecutionId,
    quoted_message_id: request.source.quotedMessageId,
    created_at: canonicalDate,
  };
  const originalProducerHash = compositionalCaptureOriginalProducerHashV3(
    owner,
    envelope,
    ownerProvenance,
  );
  const sourceHash = sha('persisted-complete-source-v3');
  const identityBase = {
    version: 3 as const,
    lifecycle: 'replaySafeV2' as const,
    storeHash: owner.storeHash,
    namespace: owner.namespace,
    issuer: owner.issuer,
    actorReference: owner.actorReference,
    turn: owner.turn,
    role: 'human' as const,
    purpose: 'human_turn_memory' as const,
    binding: owner.binding,
    sourceId,
    sourceContentHash: owner.sourceContentHash,
    sourceHash,
    originalProducerHash,
    stableProducerHash: owner.stableProducerHash,
    eventTimeMode: owner.eventTimeMode,
    eventTimeHash: owner.eventTimeHash,
    settingsHash: owner.settingsHash,
    descriptorHash: owner.descriptorHash,
    policyFingerprint: owner.policyFingerprint,
  };
  const requestedAuthorityHash = compositionalCaptureRequestedAuthorityHashV3({
    lifecycle: identityBase.lifecycle,
    storeHash: identityBase.storeHash,
    namespace: identityBase.namespace,
    issuer: identityBase.issuer,
    actorReference: identityBase.actorReference,
    turn: identityBase.turn,
    role: identityBase.role,
    purpose: identityBase.purpose,
    sourceId: identityBase.sourceId,
    sourceContentHash: identityBase.sourceContentHash,
    stableProducerHash: identityBase.stableProducerHash,
    eventTimeMode: identityBase.eventTimeMode,
    eventTimeHash: identityBase.eventTimeHash,
    settingsHash: identityBase.settingsHash,
    descriptorHash: identityBase.descriptorHash,
    policyFingerprint: identityBase.policyFingerprint,
    binding: identityBase.binding,
  });
  const identity = CompositionalAutomaticOperationIdentityV3Schema.parse({
    ...identityBase,
    requestedAuthorityHash,
  });
  const ownedSource = CompositionalAutomaticCaptureOwnedSourceV3Schema.parse({
    owner,
    envelope,
    descriptor,
  });
  return {
    request,
    descriptor,
    descriptorHash,
    sourceEnvelope,
    envelope,
    owner,
    ownerProvenance,
    identity,
    ownedSource,
    rawContent,
  };
}

function bundleMeaningFixture(rawContent = 'I prefer concise explanations.') {
  const preference = interpretCompositionalPreferencesV2({
    descriptor: COMPOSITIONAL_PREFERENCE_V2_DESCRIPTOR,
    rawContent,
    mappedContent: rawContent,
    envelope: {
      version: 1,
      namespace,
      issuer,
      actorReference,
      bindingRef: binding,
      contentHash: sha(rawContent),
      rawContentHash: sha(rawContent),
      mappingAuthority: 'whole_source',
      humanRegion: { start: 0, end: rawContent.length },
      mappings: [
        { contentStart: 0, contentEnd: rawContent.length, rawStart: 0, rawEnd: rawContent.length },
      ],
      quoteRegions: [],
      explicitIntent: false,
    },
  });
  const projected = projectCompositionalPreferenceV2Meaning({ preference, namespace, subjectId });
  if (!projected.ok) throw new Error('Meaning fixture must project');
  return { preference, meaning: projected.meaning };
}

function coupled32MeaningFixture() {
  const rootPaths = Array.from({ length: 32 }, (_, index) => `p${index}`);
  const nodes = rootPaths.flatMap((path) => [
    {
      path,
      kind: 'preference' as const,
      operator: 'prefer' as const,
      polarity: 'affirmed' as const,
      negation: 'none' as const,
      targetPath: `${path}.target`,
    },
    { path: `${path}.target`, kind: 'output' as const, value: 'answer' as const },
  ]);
  const edges = [
    ...rootPaths.map((path) => ({
      relation: 'targets' as const,
      ownerPath: path,
      targetPath: `${path}.target`,
    })),
    ...rootPaths.slice(1).map((targetPath) => ({
      relation: 'all_of' as const,
      ownerPath: rootPaths[0]!,
      targetPath,
    })),
  ];
  const meaning = {
    version: 2 as const,
    descriptor: COMPOSITIONAL_PREFERENCE_V2_DESCRIPTOR,
    namespace,
    subjectId,
    bundles: [
      { relation: 'allOf' as const, coupling: 'coupled' as const, rootPaths, nodes, edges },
    ],
  };
  return { meaning };
}

function bundleItem(index: number, overrides: Record<string, unknown> = {}) {
  return {
    bundleIndex: index,
    bundleHash: sha(`bundle-${index}`),
    meaningHash: sha(`meaning-${index}`),
    state: 'accepted' as const,
    persisted: true,
    mutation: 'created' as const,
    claimId: uuidAt(index + 1),
    predicateDependencies: [{ predicateIndex: 0, dependencyHash: sha(`dependency-${index}`) }],
    ...overrides,
  };
}

function unpersistedBundleItem(
  index: number,
  state: 'proposed' | 'rejected' | 'deferred',
  mutation: 'created' | 'none',
) {
  const { claimId, ...item } = bundleItem(index, { state, persisted: false, mutation });
  void claimId;
  return item;
}

type ReceiptSelection =
  | { kind: 'bundles'; items: CompositionalAutomaticBundleReceiptItemV3[] }
  | {
      kind: 'source_verdict';
      verdict: 'no_supported_preference_detected' | 'unsupported_preference_meaning';
      interpreterResultHash: string;
    };

function committedReceipt(
  selection: ReceiptSelection,
  acceptedCoverage: 'all' | 'partial' | 'none' = selection.kind === 'source_verdict'
    ? 'none'
    : 'all',
) {
  const fixture = sourceFixture();
  return {
    version: 3,
    kind:
      selection.kind === 'source_verdict'
        ? 'human_compositional_source_verdict_committed'
        : 'human_compositional_capture_committed',
    operationId,
    sourceId,
    sourceHash: fixture.identity.sourceHash,
    descriptorHash: fixture.descriptorHash,
    policyFingerprint: fixture.descriptor.policy.fingerprint,
    terminalAt: canonicalDate,
    interpretationCoverage:
      selection.kind === 'source_verdict'
        ? selection.verdict === 'no_supported_preference_detected'
          ? 'none'
          : 'unknown'
        : 'complete',
    acceptedCoverage,
    reasons: [],
    selection,
  };
}

function operationFixture(receipt: CompositionalAutomaticCaptureTerminalReceiptV3) {
  const fixture = sourceFixture();
  return {
    version: 3,
    operationId,
    identity: fixture.identity,
    descriptor: fixture.descriptor,
    createdAt: canonicalDate,
    lastObservedAt: canonicalDate,
    attempts: [
      {
        attemptHash: sha('attempt-operation'),
        at: canonicalDate,
        disposition: 'claim_won',
      },
    ],
    overflowCount: 0,
    auditTruncated: false,
    beginCallHash: sha('begin-call'),
    retryCount: 0,
    state: 'committed',
    generation: 1,
    terminalReceipt: receipt,
    completionCallHash: sha('completion-call'),
  };
}

describe('compositional Capture V3 standalone contracts', () => {
  it('dispatches only an explicit bounded human V3 request and compiles its exact descriptor', () => {
    const request = requestFixture();
    const result = buildCompositionalAutomaticDescriptorForRequestV3(request);
    expect(result.descriptor).toMatchObject({
      version: 3,
      lifecycle: 'replaySafeV2',
      purpose: 'human_turn_memory',
      interpreterId: 'compositional-preferences',
      semanticVersion: 2,
      grammarVersion: 2,
      lexiconVersion: 2,
      policy: { version: 2, policyVersion: 2 },
      assistantWriteAuthority: null,
    });
    expect(result.descriptorHash).toMatch(/^[a-f0-9]{64}$/);
    expect(CompositionalAutomaticDescriptorV3Schema.safeParse(result.descriptor).success).toBe(
      true,
    );
    expect(CompositionalAutomaticPolicyV2Schema.safeParse(result.descriptor.policy).success).toBe(
      true,
    );

    for (const invalid of [
      { ...request, version: 2 },
      { ...request, preferenceInterpreter: 'literalV1' },
      { ...request, policy: {} },
      { ...request, binding },
      { ...request, source: { ...request.source, unexpected: true } },
      { ...request, source: { ...request.source, sourceMessageId: ' padded ' } },
      { ...request, settings: { ...request.settings, invocationDeadlineMs: 120_001 } },
      {
        ...request,
        source: { ...request.source, applicationOwnedWrapper: true },
      },
      {
        ...request,
        source: { ...request.source, content: '\ud800' },
      },
    ]) {
      expect(CompositionalAutomaticCaptureBeginRequestV3Schema.safeParse(invalid).success).toBe(
        false,
      );
    }
  });

  it('binds the V3 owner, V2 source envelope, and compiled descriptor without any literal V1 payload', () => {
    const fixture = sourceFixture();
    expect(COMPOSITIONAL_CAPTURE_V3_OWNER_ATTRIBUTE).toBe('engram_write_owner_v3');
    expect(COMPOSITIONAL_CAPTURE_V2_ENVELOPE_ATTRIBUTE).toBe('engram_source_envelope_v2');
    expect(CompositionalAutomaticCaptureOwnedSourceV3Schema.parse(fixture.ownedSource)).toEqual(
      fixture.ownedSource,
    );
    expect(
      CompositionalAutomaticCaptureSourceOwnerV3Schema.safeParse({
        ...fixture.owner,
        version: 2,
      }).success,
    ).toBe(false);
    expect(
      CompositionalAutomaticCaptureSourceEnvelopeV2Schema.safeParse({
        ...fixture.envelope,
        sourceEnvelope: {
          ...fixture.envelope.sourceEnvelope,
          version: 1,
        },
      }).success,
    ).toBe(false);
    expect(
      CompositionalAutomaticCaptureOwnedSourceV3Schema.safeParse({
        ...fixture.ownedSource,
        envelope: {
          ...fixture.envelope,
          descriptorHash: sha('wrong-descriptor'),
        },
      }).success,
    ).toBe(false);
    expect(
      CompositionalAutomaticCaptureOwnedSourceV3Schema.safeParse({
        ...fixture.ownedSource,
        owner: { ...fixture.owner, policyFingerprint: sha('wrong-policy') },
      }).success,
    ).toBe(false);
    expect(
      CompositionalAutomaticCaptureOwnedSourceV3Schema.safeParse({
        ...fixture.ownedSource,
        owner: { ...fixture.owner, intentEvidence: true },
      }).success,
    ).toBe(false);
  });

  it('requires captured explicit intent when the descriptor requires it', () => {
    const fixture = sourceFixture();
    const descriptor = compileCompositionalAutomaticDescriptorV3({
      profileId: 'explicit',
      requestedTrustLevel: 'standard',
      intentSetting: true,
      invocationDeadlineMs: 10_000,
    });
    const compiledDescriptorHash = buildCompositionalAutomaticDescriptorForRequestV3({
      ...fixture.request,
      settings: { ...fixture.request.settings, profileId: 'explicit', intentSetting: true },
    }).descriptorHash;
    const invalid = {
      owner: {
        ...fixture.owner,
        intentSetting: true,
        settingsHash: descriptor.settingsHash,
        descriptorHash: compiledDescriptorHash,
        policyFingerprint: descriptor.policy.fingerprint,
      },
      envelope: {
        ...fixture.envelope,
        settingsHash: descriptor.settingsHash,
        descriptorHash: compiledDescriptorHash,
        sourceEnvelope: { ...fixture.sourceEnvelope, policy: descriptor.policy },
      },
      descriptor,
    };
    expect(CompositionalAutomaticCaptureOwnedSourceV3Schema.safeParse(invalid).success).toBe(false);
  });

  it('uses independent canonical V3 producer, event-time, source, authority, and identity hashes', () => {
    const fixture = sourceFixture();
    expect(fixture.identity).toMatchObject({
      version: 3,
      role: 'human',
      purpose: 'human_turn_memory',
    });
    expect(compositionalCaptureSourceContentHashV3(fixture.rawContent)).toBe(
      fixture.envelope.sourceEnvelope.rawContentHash,
    );
    expect(
      compositionalCaptureSourceHashV3({
        uuid: sourceId,
        group_id: namespace,
        content: fixture.rawContent,
        role: 'human',
        source_type: 'message',
        reference_time: canonicalDate,
        previous_episode_uuid: null,
        created_at: canonicalDate,
        updated_at: canonicalDate,
        source_message_id: 'human-source-v3',
        idempotency_key: 'synthetic-idempotency-key',
        conversation_id: 'conversation-v3',
        sender_id: actorReference,
        sender_name: 'Synthetic Human',
        episode_kind: 'active_human',
        quoted_message_id: null,
        trust_level: 'standard',
        confidence: null,
        review_status: 'proposed',
        source_workflow_id: 'synthetic-workflow',
        source_execution_id: 'original-human-execution',
        attributes: {
          [COMPOSITIONAL_CAPTURE_V3_OWNER_ATTRIBUTE]: fixture.owner,
          [COMPOSITIONAL_CAPTURE_V2_ENVELOPE_ATTRIBUTE]: fixture.envelope,
          engram_extraction_queue_v1: { version: 1, state: 'queued' },
        },
      }),
    ).toBe(
      compositionalCaptureSourceHashV3({
        uuid: sourceId,
        group_id: namespace,
        content: fixture.rawContent,
        role: 'human',
        source_type: 'message',
        reference_time: canonicalDate,
        previous_episode_uuid: null,
        created_at: canonicalDate,
        updated_at: '2026-10-25T12:01:00.000Z',
        source_message_id: 'human-source-v3',
        idempotency_key: 'synthetic-idempotency-key',
        conversation_id: 'conversation-v3',
        sender_id: actorReference,
        sender_name: 'Synthetic Human',
        episode_kind: 'active_human',
        quoted_message_id: null,
        trust_level: 'standard',
        confidence: null,
        review_status: 'proposed',
        source_workflow_id: 'synthetic-workflow',
        source_execution_id: 'original-human-execution',
        attributes: {
          [COMPOSITIONAL_CAPTURE_V3_OWNER_ATTRIBUTE]: fixture.owner,
          [COMPOSITIONAL_CAPTURE_V2_ENVELOPE_ATTRIBUTE]: fixture.envelope,
        },
      }),
    );

    const producerFields = {
      source_workflow_id: 'workflow',
      source_message_id: 'message',
      conversation_id: 'conversation',
      sender_id: 'actor',
      source_type: 'message' as const,
      episode_kind: 'active_human' as const,
      quoted_message_id: null,
    };
    expect(compositionalCaptureStableProducerHashV3(producerFields)).toBe(
      compositionalCaptureStableProducerHashV3({ ...producerFields }),
    );
    expect(compositionalCaptureEventTimeHashV3('first_capture', canonicalDate)).not.toBe(
      compositionalCaptureEventTimeHashV3('explicit', canonicalDate),
    );
    expect(compositionalCaptureOperationIdentityHashV3(fixture.identity)).toBe(
      compositionalCaptureOperationIdentityHashV3({
        ...fixture.identity,
        namespace: fixture.identity.namespace,
      }),
    );
    expect(
      CompositionalAutomaticOperationIdentityV3Schema.safeParse({
        ...fixture.identity,
        requestedAuthorityHash: sha('tampered-authority'),
      }).success,
    ).toBe(false);

    const changedExecution = {
      ...fixture.ownerProvenance,
      source_execution_id: 'different-original-execution',
    };
    expect(
      compositionalCaptureOriginalProducerHashV3(fixture.owner, fixture.envelope, changedExecution),
    ).not.toBe(fixture.identity.originalProducerHash);
    expect(
      compositionalCaptureRequestedAuthorityHashV3({
        lifecycle: 'replaySafeV2',
        storeHash: fixture.owner.storeHash,
        namespace,
        issuer,
        actorReference,
        turn,
        role: 'human',
        purpose: 'human_turn_memory',
        sourceId,
        sourceContentHash: fixture.owner.sourceContentHash,
        stableProducerHash: fixture.owner.stableProducerHash,
        eventTimeMode: fixture.owner.eventTimeMode,
        eventTimeHash: fixture.owner.eventTimeHash,
        settingsHash: fixture.owner.settingsHash,
        descriptorHash: fixture.owner.descriptorHash,
        policyFingerprint: fixture.owner.policyFingerprint,
        binding,
      }),
    ).toBe(fixture.identity.requestedAuthorityHash);
  });

  it('binds every canonical predicate path to the entire one-bundle meaning', () => {
    const { preference, meaning } = bundleMeaningFixture();
    expect(compositionalCaptureMeaningHashV3(meaning)).toMatch(/^[a-f0-9]{64}$/);
    expect(compositionalCaptureBundleHashV3(preference.bundles[0])).toMatch(/^[a-f0-9]{64}$/);
    const dependencies = compositionalCapturePredicateDependenciesV3(meaning);
    expect(dependencies).toHaveLength(1);
    expect(dependencies[0]).toEqual({
      predicateIndex: 0,
      dependencyHash: compositionalCapturePredicateDependencyHashV3(
        compositionalCaptureMeaningHashV3(meaning),
        0,
        'p0',
      ),
    });
    expect(
      compositionalCapturePredicateDependencyHashV3(
        compositionalCaptureMeaningHashV3(meaning),
        0,
        'p0.target',
      ),
    ).not.toBe(dependencies[0]?.dependencyHash);

    const descriptor = compileCompositionalAutomaticDescriptorV3({
      profileId: 'conservative',
      requestedTrustLevel: 'standard',
      intentSetting: false,
      invocationDeadlineMs: 10_000,
    });
    const interpreted = compositionalCaptureInterpreterResultHashV3(
      sourceId,
      sha('source'),
      sha('descriptor'),
      preference,
    );
    expect(interpreted).toMatch(/^[a-f0-9]{64}$/);
    expect(descriptor.policy.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('has a strict zero-bundle source-verdict branch and a separate cancellation receipt', () => {
    const sourceVerdict = committedReceipt({
      kind: 'source_verdict',
      verdict: 'no_supported_preference_detected',
      interpreterResultHash: sha('actual-empty-result'),
    });
    const parsed = CompositionalAutomaticCaptureTerminalReceiptV3Schema.parse(sourceVerdict);
    expect(parsed).toMatchObject({
      kind: 'human_compositional_source_verdict_committed',
      interpretationCoverage: 'none',
      acceptedCoverage: 'none',
      reasons: [],
      selection: { kind: 'source_verdict', verdict: 'no_supported_preference_detected' },
    });
    expect(
      CompositionalAutomaticCaptureTerminalReceiptV3Schema.safeParse({
        ...sourceVerdict,
        interpretationCoverage: 'unknown',
      }).success,
    ).toBe(false);
    const unsupported = committedReceipt({
      kind: 'source_verdict',
      verdict: 'unsupported_preference_meaning',
      interpreterResultHash: sha('actual-unsupported-result'),
    });
    for (const reason of [
      'metadata_too_large',
      'invalid_ast_integrity',
      'quoted_content',
      'question',
    ]) {
      expect(
        CompositionalAutomaticCaptureTerminalReceiptV3Schema.safeParse({
          ...unsupported,
          reasons: [reason],
        }).success,
      ).toBe(false);
    }
    expect(
      CompositionalAutomaticCaptureTerminalReceiptV3Schema.safeParse({
        ...unsupported,
        reasons: ['unsupported_scope'],
      }).success,
    ).toBe(true);
    expect(
      CompositionalAutomaticCaptureTerminalReceiptV3Schema.safeParse({
        ...sourceVerdict,
        reasons: ['question', 'quoted_content'],
      }).success,
    ).toBe(true);
    expect(
      CompositionalAutomaticCaptureTerminalReceiptV3Schema.safeParse({
        ...sourceVerdict,
        acceptedCoverage: 'all',
      }).success,
    ).toBe(false);
    expect(
      CompositionalAutomaticCaptureTerminalReceiptV3Schema.safeParse({
        ...sourceVerdict,
        selection: { kind: 'bundles', items: [] },
      }).success,
    ).toBe(false);

    const cancelled = CompositionalAutomaticCaptureTerminalReceiptV3Schema.parse({
      version: 3,
      kind: 'cancelled',
      operationId,
      sourceId,
      sourceHash: sha('source'),
      descriptorHash: sha('descriptor'),
      policyFingerprint: sha('policy'),
      terminalAt: canonicalDate,
      acceptedCoverage: 'none',
    });
    expect(cancelled.kind).toBe('cancelled');
  });

  it('measures the 32-simple-bundle receipt and operation at maximum receipt reasons', () => {
    const reasons = maximumSemanticReceiptReasons();
    expect(reasons).toHaveLength(16);
    const receipt = {
      ...committedReceipt(
        { kind: 'bundles', items: Array.from({ length: 32 }, (_, index) => bundleItem(index)) },
        'all',
      ),
      reasons: [...reasons],
    };
    const parsedReceipt = CompositionalAutomaticCaptureTerminalReceiptV3Schema.parse(receipt);
    const receiptBytes = Buffer.byteLength(JSON.stringify(parsedReceipt), 'utf8');
    if (
      parsedReceipt.kind !== 'human_compositional_capture_committed' ||
      parsedReceipt.selection.kind !== 'bundles'
    )
      throw new Error('Expected a committed bundle receipt');
    expect(parsedReceipt.selection.items).toHaveLength(32);
    expect(receiptBytes).toBeLessThanOrEqual(16 * 1024);
    expect(receiptBytes).toBeGreaterThan(10 * 1024);

    const operation = CompositionalAutomaticCaptureOperationV3Schema.parse({
      ...operationFixture(parsedReceipt),
      attempts: Array.from({ length: 32 }, (_, index) => ({
        attemptHash: sha(`attempt-${index}`),
        at: canonicalDate,
        disposition: 'in_progress',
      })),
    });
    const operationBytes = Buffer.byteLength(JSON.stringify(operation), 'utf8');
    expect(operationBytes).toBeLessThanOrEqual(32 * 1024);
    expect(operationBytes).toBeGreaterThan(receiptBytes);
  });

  it('measures a single coupled 32-predicate bundle receipt and operation', () => {
    const { meaning } = coupled32MeaningFixture();
    const meaningHash = compositionalCaptureMeaningHashV3(meaning);
    expect(meaning.bundles[0]?.rootPaths).toHaveLength(32);
    const dependencies = compositionalCapturePredicateDependenciesV3(meaning);
    expect(dependencies).toHaveLength(32);
    const receipt = {
      ...committedReceipt(
        {
          kind: 'bundles',
          items: [
            bundleItem(0, {
              bundleHash: sha('coupled-32-bundle'),
              meaningHash,
              predicateDependencies: dependencies,
            }),
          ],
        },
        'all',
      ),
      reasons: maximumSemanticReceiptReasons(),
    };
    expect(receipt.reasons).toHaveLength(16);
    const parsedReceipt = CompositionalAutomaticCaptureTerminalReceiptV3Schema.parse(receipt);
    const receiptBytes = Buffer.byteLength(JSON.stringify(parsedReceipt), 'utf8');
    expect(receiptBytes).toBeLessThanOrEqual(16 * 1024);
    const operation = CompositionalAutomaticCaptureOperationV3Schema.parse(
      operationFixture(parsedReceipt),
    );
    const operationBytes = Buffer.byteLength(JSON.stringify(operation), 'utf8');
    expect(operationBytes).toBeLessThanOrEqual(32 * 1024);
  });

  it('rejects missing/extra predicate dependencies, wrong coverage and ambiguous duplicate claim links', () => {
    const base = committedReceipt(
      { kind: 'bundles', items: [bundleItem(0), bundleItem(1)] },
      'all',
    );
    expect(CompositionalAutomaticCaptureTerminalReceiptV3Schema.safeParse(base).success).toBe(true);
    expect(
      CompositionalAutomaticCaptureTerminalReceiptV3Schema.safeParse({
        ...base,
        acceptedCoverage: 'partial',
      }).success,
    ).toBe(false);

    const duplicateMeaning = sha('same-meaning');
    const sharedClaimId = uuidAt(500);
    const safeDuplicate = committedReceipt(
      {
        kind: 'bundles',
        items: [
          bundleItem(0, { meaningHash: duplicateMeaning, claimId: sharedClaimId }),
          bundleItem(1, {
            meaningHash: duplicateMeaning,
            claimId: sharedClaimId,
            state: 'unchanged',
            mutation: 'none',
          }),
        ],
      },
      'all',
    );
    expect(
      CompositionalAutomaticCaptureTerminalReceiptV3Schema.safeParse(safeDuplicate).success,
    ).toBe(true);
    const ambiguous = structuredClone(safeDuplicate);
    if (ambiguous.selection.kind !== 'bundles') throw new Error('Expected bundle receipt');
    ambiguous.selection.items[1]!.claimId = uuidAt(501);
    expect(CompositionalAutomaticCaptureTerminalReceiptV3Schema.safeParse(ambiguous).success).toBe(
      false,
    );

    const missing = structuredClone(base);
    if (missing.selection.kind !== 'bundles') throw new Error('Expected bundle receipt');
    missing.selection.items[0]!.predicateDependencies = [];
    expect(CompositionalAutomaticCaptureTerminalReceiptV3Schema.safeParse(missing).success).toBe(
      false,
    );
    const extra = structuredClone(base);
    if (extra.selection.kind !== 'bundles') throw new Error('Expected bundle receipt');
    extra.selection.items[0]!.predicateDependencies = Array.from({ length: 32 }, (_, index) => ({
      predicateIndex: index,
      dependencyHash: sha(`dependency-extra-${index}`),
    }));
    expect(CompositionalAutomaticCaptureTerminalReceiptV3Schema.safeParse(extra).success).toBe(
      false,
    );
  });

  it('rejects created-without-persistence, deferred terminal states and resource reasons', () => {
    for (const state of ['proposed', 'rejected'] as const) {
      const createdWithoutPersist = committedReceipt(
        {
          kind: 'bundles',
          items: [unpersistedBundleItem(0, state, 'created')],
        },
        'none',
      );
      expect(
        CompositionalAutomaticCaptureTerminalReceiptV3Schema.safeParse(createdWithoutPersist)
          .success,
      ).toBe(false);
    }

    const unpersistedProposal = committedReceipt(
      {
        kind: 'bundles',
        items: [unpersistedBundleItem(0, 'proposed', 'none')],
      },
      'none',
    );
    expect(
      CompositionalAutomaticCaptureTerminalReceiptV3Schema.safeParse(unpersistedProposal).success,
    ).toBe(true);

    const deferred = committedReceipt(
      {
        kind: 'bundles',
        items: [unpersistedBundleItem(0, 'deferred', 'none')],
      },
      'none',
    );
    expect(CompositionalAutomaticCaptureTerminalReceiptV3Schema.safeParse(deferred).success).toBe(
      false,
    );

    const resourceReason = {
      ...committedReceipt({ kind: 'bundles', items: [bundleItem(0)] }, 'all'),
      reasons: ['metadata_too_large'],
    };
    expect(
      CompositionalAutomaticCaptureTerminalReceiptV3Schema.safeParse(resourceReason).success,
    ).toBe(false);
  });

  it('fails closed on operation versions, purpose/role, receipt links, time and capacity', () => {
    const receipt = CompositionalAutomaticCaptureTerminalReceiptV3Schema.parse(
      committedReceipt({ kind: 'bundles', items: [bundleItem(0)] }, 'all'),
    );
    const operation = operationFixture(receipt);
    expect(CompositionalAutomaticCaptureOperationV3Schema.safeParse(operation).success).toBe(true);
    expect(
      CompositionalAutomaticCaptureOperationV3Schema.safeParse({ ...operation, version: 2 })
        .success,
    ).toBe(false);
    expect(
      CompositionalAutomaticCaptureOperationV3Schema.safeParse({
        ...operation,
        identity: { ...operation.identity, role: 'assistant' },
      }).success,
    ).toBe(false);
    expect(
      CompositionalAutomaticCaptureOperationV3Schema.safeParse({
        ...operation,
        terminalReceipt: { ...receipt, operationId: uuidAt(999) },
      }).success,
    ).toBe(false);
    expect(
      CompositionalAutomaticCaptureOperationV3Schema.safeParse({
        ...operation,
        createdAt: '2026-10-25T12:01:00.000Z',
      }).success,
    ).toBe(false);
    expect(COMPOSITIONAL_AUTOMATIC_LIMITS.predicates).toBe(32);
  });
});
