import { randomUUID } from 'crypto';
import { makeCompositionalCommittedClaimFixture } from './compositionalCommittedClaimFixture';
import { makeCompositionalCaptureFixture } from './compositionalCaptureFixture';
import { AutomaticAssistantCaptureIntentV2Schema } from '../../src/schemas/AutomaticAssistantCapture.schema';
import { GraphDataSchema, type EpisodicNode, type GraphData } from '../../src/schemas';
import {
  CompositionalAutomaticCaptureOperationV3Schema,
  CompositionalAutomaticCaptureSourceEnvelopeV2Schema,
  CompositionalAutomaticCaptureTerminalReceiptV3Schema,
} from '../../src/schemas/CompositionalAutomaticCaptureV3.schema';
import { compileCompositionalAutomaticDescriptorV3 } from '../../src/schemas/CompositionalAutomaticMemory.schema';
import { AUTOMATIC_LEDGER_LIMITS } from '../../src/schemas/AutomaticLedgerPrimitives.schema';
import { assertAutomaticLedgerSourceIntegrity } from '../../src/storage/AutomaticIdentity';
import { createCompositionalAutomaticCaptureHandleRegistryV3 } from '../../src/storage/CompositionalAutomaticCaptureHandlesV3';
import { buildCompositionalHumanCaptureSourceV3 } from '../../src/storage/CompositionalAutomaticCaptureSourceV3';

export interface CompositionalAssistantHumanParentFixture {
  graph: GraphData;
  source: EpisodicNode;
  operation: Extract<
    ReturnType<typeof CompositionalAutomaticCaptureOperationV3Schema.parse>,
    { state: 'committed' }
  >;
  storeHash: string;
}

/**
 * Build a native-shape committed V3 human parent for final-writer tests.
 * Bundle parents use the checked materialization fixture; the source-verdict
 * case uses the private V3 handle/witness/receipt path before constructing the
 * committed native record.
 */
export function makeCompositionalAssistantHumanParentFixture(
  kind: 'accepted_bundle' | 'proposed_bundle' | 'source_verdict',
  storeHash?: string,
): CompositionalAssistantHumanParentFixture {
  if (kind !== 'source_verdict') {
    const result = makeCompositionalCommittedClaimFixture(
      kind === 'accepted_bundle' ? 'accepted' : 'proposed',
      storeHash,
    );
    assertAutomaticLedgerSourceIntegrity(result.graph);
    if (result.operation.state !== 'committed') throw new Error('Expected committed fixture');
    return {
      graph: result.graph,
      source: result.source,
      operation: result.operation,
      storeHash: result.operation.identity.storeHash,
    };
  }

  const base = makeCompositionalCaptureFixture('The weather is mild today.', storeHash);
  const capturedAt = base.graph.exported_at;
  const request = base.input.request;
  const descriptor = compileCompositionalAutomaticDescriptorV3({
    profileId: request.settings.profileId,
    requestedTrustLevel: request.settings.requestedTrustLevel,
    intentSetting: request.settings.intentSetting,
    invocationDeadlineMs: request.settings.invocationDeadlineMs,
  });
  const registry = createCompositionalAutomaticCaptureHandleRegistryV3();
  const begin = registry.startInitialBegin(request.attemptIdHash, descriptor);
  const built = buildCompositionalHumanCaptureSourceV3(base.graph, {
    sourceId: begin.sourceId,
    storeHash: base.input.storeHash,
    capturedAt,
    previousEpisodeId: null,
    request,
  });
  const durationMs = Math.min(
    AUTOMATIC_LEDGER_LIMITS.maxLeaseMs,
    Math.max(
      descriptor.invocationDeadlineMs + AUTOMATIC_LEDGER_LIMITS.storageGraceMs,
      AUTOMATIC_LEDGER_LIMITS.minLeaseMs,
    ),
  );
  const leased = CompositionalAutomaticCaptureOperationV3Schema.parse({
    version: 3,
    operationId: begin.operationId,
    identity: built.identity,
    descriptor: built.descriptor,
    createdAt: capturedAt,
    lastObservedAt: capturedAt,
    attempts: [],
    overflowCount: 0,
    beginCallHash: begin.beginCallHash,
    retryCount: 0,
    state: 'leased',
    generation: 1,
    lease: {
      token: begin.leaseToken,
      acquiredAt: capturedAt,
      renewedAt: capturedAt,
      expiresAt: new Date(Date.parse(capturedAt) + durationMs).toISOString(),
      claimKind: 'initial',
    },
  });
  if (leased.state !== 'leased') throw new Error('Expected leased V3 fixture');
  const sourceGraph = GraphDataSchema.parse({
    ...base.graph,
    episodes: [built.episode],
    automatic_operations_v1: { version: 1, operations: [leased] },
  });
  const actual = {
    storeHash: base.input.storeHash,
    namespace: request.namespace,
    backendNow: capturedAt,
    graph: sourceGraph,
    operation: leased,
  };
  const handle = registry.issueInitialAfterAcknowledgedBegin(begin.scope, actual);
  if (!handle) throw new Error('Expected registered V3 initial handle');
  const completion = registry.consumeForCompletion(handle, request.attemptIdHash);
  const witness = registry.prepareSourceVerdictWitness(completion, actual);
  if (!witness) throw new Error('Expected registered source-verdict witness');
  const terminalReceipt = registry.prepareSourceVerdictReceipt(completion, witness, actual);
  if (!terminalReceipt) throw new Error('Expected registered source-verdict receipt');
  const parsedReceipt = CompositionalAutomaticCaptureTerminalReceiptV3Schema.parse(terminalReceipt);
  const { lease: _lease, ...common } = leased;
  void _lease;
  const operation = CompositionalAutomaticCaptureOperationV3Schema.parse({
    ...common,
    state: 'committed',
    lastObservedAt: parsedReceipt.terminalAt,
    completionCallHash: registry.readConsumedInvocation(completion).completionCallHash,
    terminalReceipt: parsedReceipt,
  });
  if (operation.state !== 'committed') throw new Error('Expected committed V3 fixture');
  const committedActual = {
    ...actual,
    backendNow: parsedReceipt.terminalAt,
    operation,
    graph: GraphDataSchema.parse({
      ...sourceGraph,
      automatic_operations_v1: { version: 1, operations: [operation] },
    }),
  };
  const proof = registry.confirmInitialCommitAfterAcknowledgement(completion, committedActual);
  if (!proof || !registry.createInitialFirstCommitResult(proof))
    throw new Error('Expected registered V3 source-verdict commit proof');
  assertAutomaticLedgerSourceIntegrity(committedActual.graph);
  return {
    graph: committedActual.graph,
    source: built.episode,
    operation,
    storeHash: base.input.storeHash,
  };
}

export function makeAssistantIntentForCompositionalParent(
  parent: CompositionalAssistantHumanParentFixture,
  attemptIdHash = 'a'.repeat(64),
) {
  const owner = parent.operation.identity;
  const wrapper = CompositionalAutomaticCaptureSourceEnvelopeV2Schema.parse(
    parent.source.attributes.engram_source_envelope_v2,
  ).sourceEnvelope;
  return AutomaticAssistantCaptureIntentV2Schema.parse({
    version: 2,
    lifecycle: 'replaySafeV2',
    purpose: 'assistant_final_save',
    humanTurn: {
      namespace: owner.namespace,
      issuer: owner.issuer,
      actorReference: owner.actorReference,
      turn: owner.turn,
      input: {
        content: parent.source.content,
        applicationOwnedWrapper: wrapper.mappingAuthority === 'application_region' ? true : null,
        humanRegion: wrapper.mappingAuthority === 'application_region' ? wrapper.humanRegion : null,
        quoteRegions: wrapper.quoteRegions,
      },
    },
    finalAssistant: {
      content: 'A synthetic final answer for the V3 parent.',
      sourceMessageId: `assistant-${randomUUID()}`,
      conversationId: `conversation-${randomUUID()}`,
      senderId: 'synthetic-assistant',
      senderName: 'Synthetic assistant',
      sourceWorkflowId: 'synthetic-final-writer',
      originalSourceExecutionId: `assistant-execution-${randomUUID()}`,
      sourceType: 'message',
      quotedMessageId: null,
      eventTime: { mode: 'first_capture' },
    },
    attemptIdHash,
    invocationDeadlineMs: 30_000,
  });
}
