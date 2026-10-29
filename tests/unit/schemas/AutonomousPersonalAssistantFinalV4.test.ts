import { GraphDataSchema } from '../../../src/schemas/GraphData.schema';
import {
  AutonomousPersonalAssistantFinalPlanDataV4OwnedDataSchema,
  AutonomousPersonalAssistantFinalPreparationV4OwnedDataSchema,
  AutonomousPersonalAssistantFinalReconciliationV4OwnedDataSchema,
  AutonomousPersonalAssistantNativeSnapshotV4OwnedDataSchema,
} from '../../../src/schemas/AutonomousPersonalAssistantFinalV4.schema';

const H1 = '1'.repeat(64);
const H2 = '2'.repeat(64);
const H3 = '3'.repeat(64);
const H4 = '4'.repeat(64);
const H5 = '5'.repeat(64);
const PARENT_SOURCE = '00000000-0000-4000-8000-000000000001';
const PARENT_OPERATION = '00000000-0000-4000-8000-000000000002';
const ASSISTANT_SOURCE = '00000000-0000-4000-8000-000000000003';
const ASSISTANT_OPERATION = '00000000-0000-4000-8000-000000000004';
const SUBJECT = '00000000-0000-4000-8000-000000000005';
const BINDING = '00000000-0000-4000-8000-000000000006';
const TERMINAL_AT = '2026-10-28T12:00:00.000Z';

function sourceVerdictReceipt() {
  return {
    version: 4,
    kind: 'human_autonomous_source_verdict_committed',
    operationId: PARENT_OPERATION,
    sourceId: PARENT_SOURCE,
    sourceHash: H1,
    descriptorHash: H2,
    policyFingerprint: H3,
    terminalAt: TERMINAL_AT,
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
  } as const;
}

function assistantReceipt() {
  return {
    version: 2,
    kind: 'assistant_final_saved',
    operationId: ASSISTANT_OPERATION,
    sourceId: ASSISTANT_SOURCE,
    sourceHash: H4,
    descriptorHash: H5,
    terminalAt: TERMINAL_AT,
    persisted: true,
  } as const;
}

function planData() {
  const receipt = sourceVerdictReceipt();
  return {
    origin: {
      version: 4,
      identity: {
        version: 4,
        lifecycle: 'replaySafeV2',
        storeHash: H1,
        namespace: 'memory:synthetic',
        issuer: 'synthetic-issuer',
        actorReference: 'synthetic-actor',
        turn: 'synthetic-human-turn',
        role: 'human',
        purpose: 'human_turn_memory',
        sourceId: PARENT_SOURCE,
        sourceHash: H1,
        contentHash: H2,
        producerHash: H3,
        geometryHash: H4,
        eventTimeMode: 'first_capture',
        eventTimeHash: H5,
        settingsHash: H1,
        descriptorHash: H2,
        policyFingerprint: H3,
        requestedAuthorityHash: H4,
        binding: {
          bindingId: BINDING,
          revision: 1,
          subjectId: SUBJECT,
          fingerprint: H5,
        },
      },
      instance: 'synthetic-memory-instance',
      workflow: 'synthetic-memory-workflow',
      execution: 'synthetic-memory-execution',
      attemptHash: H1,
      completionCallHash: H2,
      terminalReceipt: receipt,
    },
    nativeSnapshot: {
      config: {
        version: 4,
        native: {
          instance: 'synthetic-memory-instance',
          workflow: 'synthetic-memory-workflow',
          execution: 'synthetic-memory-execution',
        },
        storeHash: H1,
        namespace: 'memory:synthetic',
        issuer: 'synthetic-issuer',
        actorReference: 'synthetic-actor',
        turn: 'synthetic-human-turn',
        sourceId: PARENT_SOURCE,
        profileId: 'conservative',
        explicitIntent: false,
        currentHumanQuery: 'What games are on today?',
        rawHumanContent: 'What games are on today?',
        sourceMapping: { mode: 'full_body' },
        quoteRegions: [],
        invocationDeadlineMs: 30_000,
        providerReference: {
          routeId: 'route:synthetic',
          configurationFingerprint: H5,
          protocol: 'openai-compatible-json-v1',
          configuredRequestLimit: 2,
          configuredTimeoutMs: 30_000,
          configuredRequestBytes: 262_144,
          configuredResponseBytes: 65_536,
          temperature: { mode: 'legacy' },
          responseFormat: 'json_object',
          outputTokenLimit: { mode: 'omit' },
        },
      },
      memoryAttemptHash: H3,
    },
    intent: {
      version: 4,
      purpose: 'assistant_final_save',
      humanObservation: { kind: 'configured_query' },
      finalAssistant: {
        content: 'Synthetic final answer.',
        sourceMessageId: null,
        conversationId: null,
        senderId: null,
        senderName: null,
        sourceWorkflowId: null,
        originalSourceExecutionId: null,
        sourceType: 'message',
        quotedMessageId: null,
        eventTime: { mode: 'first_capture' },
      },
      memoryAttemptHash: H3,
      invocationDeadlineMs: 30_000,
    },
    sourceId: ASSISTANT_SOURCE,
    operationId: ASSISTANT_OPERATION,
    beginCallHash: H4,
    completionCallHash: H5,
  };
}

describe('AutonomousPersonalAssistantFinalV4 DATA schemas', () => {
  it('accepts a consistent synthetic plan DATA value without claiming backend authority', () => {
    const value = planData();
    expect(AutonomousPersonalAssistantFinalPlanDataV4OwnedDataSchema.safeParse(value).success).toBe(
      true,
    );
    expect(
      AutonomousPersonalAssistantNativeSnapshotV4OwnedDataSchema.safeParse(value.nativeSnapshot)
        .success,
    ).toBe(true);
  });

  it.each([
    [
      'native execution tuple',
      (value: ReturnType<typeof planData>) => {
        value.nativeSnapshot.config.native.execution = 'different-execution';
      },
    ],
    [
      'snapshot and intent hashes',
      (value: ReturnType<typeof planData>) => {
        value.nativeSnapshot.memoryAttemptHash = H4;
      },
    ],
    [
      'assistant source ID collision',
      (value: ReturnType<typeof planData>) => {
        value.sourceId = PARENT_SOURCE;
      },
    ],
    [
      'assistant operation ID collision',
      (value: ReturnType<typeof planData>) => {
        value.operationId = PARENT_OPERATION;
      },
    ],
    [
      'source and operation ID collision',
      (value: ReturnType<typeof planData>) => {
        value.operationId = ASSISTANT_SOURCE;
      },
    ],
  ])('rejects a plan with a mismatched %s', (_label, mutate) => {
    const value = structuredClone(planData()) as ReturnType<typeof planData>;
    mutate(value);
    expect(AutonomousPersonalAssistantFinalPlanDataV4OwnedDataSchema.safeParse(value).success).toBe(
      false,
    );
  });

  it('rejects unknown plan and native snapshot fields', () => {
    const value = structuredClone(planData());
    expect(
      AutonomousPersonalAssistantFinalPlanDataV4OwnedDataSchema.safeParse({
        ...value,
        callerProof: true,
      }).success,
    ).toBe(false);
    expect(
      AutonomousPersonalAssistantNativeSnapshotV4OwnedDataSchema.safeParse({
        ...value.nativeSnapshot,
        credentials: { apiKey: 'synthetic-secret' },
      }).success,
    ).toBe(false);
  });

  it('accepts strict candidate, replay and decision preparation DATA branches', () => {
    const emptyGraph = GraphDataSchema.parse({
      version: '2.0',
      exported_at: TERMINAL_AT,
      entities: [],
      edges: [],
      episodes: [],
    });
    const receipt = assistantReceipt();

    expect(
      AutonomousPersonalAssistantFinalPreparationV4OwnedDataSchema.safeParse({
        kind: 'candidate',
        graph: emptyGraph,
        terminalReceipt: receipt,
      }).success,
    ).toBe(true);
    expect(
      AutonomousPersonalAssistantFinalPreparationV4OwnedDataSchema.safeParse({
        kind: 'replay',
        terminalReceipt: receipt,
      }).success,
    ).toBe(true);
    expect(
      AutonomousPersonalAssistantFinalPreparationV4OwnedDataSchema.safeParse({
        kind: 'decision',
        reason: 'capacity',
      }).success,
    ).toBe(true);
  });

  it('rejects non-assistant receipts and unknown fields on preparation branches', () => {
    const emptyGraph = GraphDataSchema.parse({
      version: '2.0',
      exported_at: TERMINAL_AT,
      entities: [],
      edges: [],
      episodes: [],
    });
    const receipt = {
      version: 2,
      kind: 'cancelled',
      operationId: ASSISTANT_OPERATION,
      sourceId: ASSISTANT_SOURCE,
      sourceHash: H4,
      descriptorHash: H5,
      terminalAt: TERMINAL_AT,
      acceptedCoverage: 'none',
    } as const;

    expect(
      AutonomousPersonalAssistantFinalPreparationV4OwnedDataSchema.safeParse({
        kind: 'candidate',
        graph: emptyGraph,
        terminalReceipt: receipt,
      }).success,
    ).toBe(false);
    expect(
      AutonomousPersonalAssistantFinalPreparationV4OwnedDataSchema.safeParse({
        kind: 'replay',
        terminalReceipt: assistantReceipt(),
        nativeProof: true,
      }).success,
    ).toBe(false);
    expect(
      AutonomousPersonalAssistantFinalPreparationV4OwnedDataSchema.safeParse({
        kind: 'decision',
        reason: 'capacity',
        graph: emptyGraph,
      }).success,
    ).toBe(false);
  });

  it('accepts only strict matched/unconfirmed reconciliation DATA with assistant receipts', () => {
    expect(
      AutonomousPersonalAssistantFinalReconciliationV4OwnedDataSchema.safeParse({
        kind: 'matched',
        terminalReceipt: assistantReceipt(),
      }).success,
    ).toBe(true);
    expect(
      AutonomousPersonalAssistantFinalReconciliationV4OwnedDataSchema.safeParse({
        kind: 'unconfirmed',
      }).success,
    ).toBe(true);
    expect(
      AutonomousPersonalAssistantFinalReconciliationV4OwnedDataSchema.safeParse({
        kind: 'matched',
        terminalReceipt: {
          version: 2,
          kind: 'cancelled',
          operationId: ASSISTANT_OPERATION,
          sourceId: ASSISTANT_SOURCE,
          sourceHash: H4,
          descriptorHash: H5,
          terminalAt: TERMINAL_AT,
          acceptedCoverage: 'none',
        },
      }).success,
    ).toBe(false);
    expect(
      AutonomousPersonalAssistantFinalReconciliationV4OwnedDataSchema.safeParse({
        kind: 'unconfirmed',
        terminalReceipt: assistantReceipt(),
      }).success,
    ).toBe(false);
  });
});
