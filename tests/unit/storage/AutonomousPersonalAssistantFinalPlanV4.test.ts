import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { hashAutomaticCaptureV2 } from '../../../src/schemas/AutomaticCapture.schema';
import { AutomaticCaptureOperationV2Schema } from '../../../src/schemas/AutomaticCaptureOperation.schema';
import { AutonomousPersonalAssistantFinalPlanDataV4OwnedDataSchema } from '../../../src/schemas/AutonomousPersonalAssistantFinalV4.schema';
import { AutonomousPersonalNativeMemoryConfigV4OwnedDataSchema } from '../../../src/schemas/AutonomousPersonalNativeMemoryConfigV4.schema';
import { AutonomousPersonalNativeOriginV4OwnedDataSchema } from '../../../src/schemas/AutonomousPersonalNativeOriginV4.schema';
import { EpisodicNodeSchema } from '../../../src/schemas/EpisodicNode.schema';
import type { AutonomousPersonalTypedSyntaxWorkV1 } from '../../../src/schemas/AutonomousPersonalTypedSyntaxV1.schema';
import type { GraphData } from '../../../src/schemas/GraphData.schema';
import {
  assertAutomaticLedgerSourceIntegrity,
  WRITE_OWNER_V2_ATTRIBUTE,
} from '../../../src/storage/AutomaticIdentity';
import { assertAutonomousPersonalRecordIntegrityV4 } from '../../../src/storage/AutonomousPersonalRecordIntegrityV4';
import {
  prepareAutonomousPersonalAssistantFinalV4,
  reconcileAutonomousPersonalAssistantFinalV4,
} from '../../../src/storage/AutonomousPersonalAssistantFinalPlanV4';
import { autonomousPersonalQualifiedClaimFixtureV4 } from '../../helpers/autonomousPersonalQualifiedClaimV4';

const query = 'I prefer concise explanations.';

function work(signal = new AbortController().signal, deadline = performance.now() + 30_000) {
  return Object.freeze({
    absoluteMonotonicDeadlineMs: deadline,
    signal,
  }) as AutonomousPersonalTypedSyntaxWorkV1;
}

async function fixture(options: { readonly wrapper?: boolean } = {}) {
  const prefix = options.wrapper ? 'Speaker 🧭: ' : '';
  const parent = await autonomousPersonalQualifiedClaimFixtureV4({ content: query, prefix });
  const operation = parent.operation;
  const source = parent.source;
  if (operation.version !== 4 || operation.state !== 'committed') {
    throw new Error('Expected synthetic committed Source4 parent DATA');
  }
  const workflow = 'workflow:current';
  const instance = 'instance:synthetic';
  const execution = source.source_execution_id;
  if (!execution || !operation.attempts[0])
    throw new Error('Expected complete synthetic parent tuple');

  const origin = AutonomousPersonalNativeOriginV4OwnedDataSchema.parse({
    version: 4,
    identity: operation.identity,
    instance,
    workflow,
    execution,
    attemptHash: operation.attempts[0].attemptHash,
    completionCallHash: operation.completionCallHash,
    terminalReceipt: operation.terminalReceipt,
  });

  const provider = operation.descriptor.provider;
  const sourceMapping = options.wrapper
    ? {
        mode: 'application_region' as const,
        humanRegion: { start: prefix.length, end: prefix.length + query.length },
      }
    : { mode: 'full_body' as const };
  const config = AutonomousPersonalNativeMemoryConfigV4OwnedDataSchema.parse({
    version: 4,
    native: { instance, workflow, execution },
    storeHash: operation.identity.storeHash,
    namespace: operation.identity.namespace,
    issuer: operation.identity.issuer,
    actorReference: operation.identity.actorReference,
    turn: operation.identity.turn,
    sourceId: operation.identity.sourceId,
    profileId: operation.descriptor.policy.profileId,
    explicitIntent: operation.descriptor.intentSetting,
    currentHumanQuery: query,
    ...(options.wrapper ? { rawHumanContent: query } : {}),
    sourceMapping,
    quoteRegions: [],
    invocationDeadlineMs: operation.descriptor.invocationDeadlineMs,
    providerReference: {
      routeId: provider.routeId,
      configurationFingerprint: provider.configurationFingerprint,
      protocol: provider.protocol,
      configuredRequestLimit: provider.configuredRequestLimit,
      configuredTimeoutMs: provider.configuredTimeoutMs,
      configuredRequestBytes: provider.configuredRequestBytes,
      configuredResponseBytes: provider.configuredResponseBytes,
      temperature: provider.temperature,
      responseFormat: provider.responseFormat,
      outputTokenLimit: provider.outputTokenLimit,
    },
  });
  const memoryAttemptHash = 'f'.repeat(64);
  const planData = AutonomousPersonalAssistantFinalPlanDataV4OwnedDataSchema.parse({
    origin,
    nativeSnapshot: { config, memoryAttemptHash },
    intent: {
      version: 4,
      purpose: 'assistant_final_save',
      humanObservation: { kind: 'message', content: query },
      finalAssistant: {
        content: 'I will keep the explanations concise.',
        sourceMessageId: 'assistant-message:final',
        conversationId: null,
        senderId: null,
        senderName: null,
        sourceWorkflowId: null,
        originalSourceExecutionId: null,
        sourceType: 'message',
        quotedMessageId: null,
        eventTime: { mode: 'first_capture' },
      },
      memoryAttemptHash,
      invocationDeadlineMs: config.invocationDeadlineMs,
    },
    sourceId: randomUUID(),
    operationId: randomUUID(),
    beginCallHash: 'a'.repeat(64),
    completionCallHash: 'b'.repeat(64),
  });

  return {
    ...parent,
    config,
    origin,
    planData,
    query,
    async close() {},
  };
}

function prepare(graph: GraphData, planData: unknown, backendNow: string, check = () => {}) {
  return prepareAutonomousPersonalAssistantFinalV4(graph, planData, backendNow, work(), check);
}

describe('pure atomic Autonomous Personal assistant final planner V4', () => {
  it('builds one committed generation-one candidate and preserves the parent chain', async () => {
    const subject = await fixture({ wrapper: true });
    try {
      const before = structuredClone(subject.graph);
      const result = prepare(subject.graph, subject.planData, subject.backendNow);
      expect(result.kind).toBe('candidate');
      if (result.kind !== 'candidate')
        throw new Error(`Expected candidate, received ${result.kind}`);

      const candidate = result.graph;
      expect(candidate).not.toBe(subject.graph);
      expect(subject.graph).toEqual(before);
      expect(candidate.entities).toEqual(subject.graph.entities);
      expect(candidate.edges).toEqual(subject.graph.edges);
      expect(candidate.episodes).toHaveLength(subject.graph.episodes.length + 1);

      const assistant = candidate.episodes.find(
        (episode) => episode.uuid === subject.planData.sourceId,
      );
      expect(assistant).toMatchObject({
        role: 'ai',
        episode_kind: 'assistant_reply',
        trust_level: 'unverified',
        review_status: 'proposed',
        previous_episode_uuid: subject.source.uuid,
        content: subject.planData.intent.finalAssistant.content,
      });
      const owner = assistant?.attributes[WRITE_OWNER_V2_ATTRIBUTE] as Record<string, unknown>;
      expect(owner.assistantWriteAuthority).toMatchObject({
        kind: 'owned_human_turn_v4',
        parentFamily: 'autonomous-personal-v1',
        parentOperationId: subject.operation.operationId,
        sourceId: subject.operation.identity.sourceId,
      });

      const assistantOperation = candidate.automatic_operations_v1?.operations.find(
        (operation) => operation.operationId === subject.planData.operationId,
      );
      if (
        !assistantOperation ||
        assistantOperation.version !== 2 ||
        assistantOperation.state !== 'committed'
      ) {
        throw new Error('Expected committed assistant Operation2');
      }
      expect(assistantOperation).toMatchObject({
        version: 2,
        state: 'committed',
        generation: 1,
        beginCallHash: subject.planData.beginCallHash,
        completionCallHash: subject.planData.completionCallHash,
      });
      expect(assistantOperation).not.toHaveProperty('lease');
      expect(assistantOperation.terminalReceipt).toEqual(result.terminalReceipt);
      expect(result.terminalReceipt).toMatchObject({
        kind: 'assistant_final_saved',
        operationId: subject.planData.operationId,
        sourceId: subject.planData.sourceId,
        persisted: true,
      });
      assertAutomaticLedgerSourceIntegrity(candidate);
      assertAutonomousPersonalRecordIntegrityV4(candidate, work(), () => {});
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(candidate)).toBe(true);
    } finally {
      await subject.close();
    }
  });

  it('accepts the whole formatted wrapper or the exact raw query as the current human observation', async () => {
    const subject = await fixture({ wrapper: true });
    try {
      const sourceObservation = {
        ...structuredClone(subject.planData),
        intent: {
          ...structuredClone(subject.planData.intent),
          humanObservation: { kind: 'message', content: subject.source.content },
        },
      };
      expect(prepare(subject.graph, subject.planData, subject.backendNow).kind).toBe('candidate');
      expect(prepare(subject.graph, sourceObservation, subject.backendNow).kind).toBe('candidate');

      const partialWrapper = {
        ...structuredClone(subject.planData),
        intent: {
          ...structuredClone(subject.planData.intent),
          humanObservation: { kind: 'message', content: 'Speaker 🧭: I prefer' },
        },
      };
      expect(prepare(subject.graph, partialWrapper, subject.backendNow)).toEqual({
        kind: 'decision',
        reason: 'conflict',
      });
    } finally {
      await subject.close();
    }
  });

  it('uses a stable timestamp and UUID tail order and rejects a future predecessor', async () => {
    const subject = await fixture();
    try {
      const tiedGraph = structuredClone(subject.graph);
      const timestamp = subject.source.created_at;
      const low = EpisodicNodeSchema.parse({
        uuid: '00000000-0000-4000-8000-000000000001',
        group_id: subject.config.namespace,
        content: 'Synthetic same-time older tie row.',
        role: 'human',
        reference_time: timestamp,
        created_at: timestamp,
        updated_at: timestamp,
      });
      const high = EpisodicNodeSchema.parse({
        uuid: 'ffffffff-ffff-4fff-afff-ffffffffffff',
        group_id: subject.config.namespace,
        content: 'Synthetic same-time newer tie row.',
        role: 'human',
        reference_time: timestamp,
        created_at: timestamp,
        updated_at: timestamp,
      });
      tiedGraph.episodes.push(low, high);
      const tied = prepare(tiedGraph, subject.planData, subject.backendNow);
      if (tied.kind !== 'candidate') throw new Error('Expected tied candidate');
      const assistant = tied.graph.episodes.find(
        (episode) => episode.uuid === subject.planData.sourceId,
      );
      expect(assistant?.previous_episode_uuid).toBe(high.uuid);

      const futureGraph = structuredClone(subject.graph);
      const futureTime = new Date(Date.parse(subject.backendNow) + 1_000).toISOString();
      futureGraph.episodes.push(
        EpisodicNodeSchema.parse({
          uuid: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
          group_id: subject.config.namespace,
          content: 'Synthetic future source.',
          role: 'human',
          reference_time: futureTime,
          created_at: futureTime,
          updated_at: futureTime,
        }),
      );
      expect(prepare(futureGraph, subject.planData, subject.backendNow)).toEqual({
        kind: 'decision',
        reason: 'clock_regression',
      });
    } finally {
      await subject.close();
    }
  });

  it('returns the existing receipt for semantic replay without allocating another source', async () => {
    const subject = await fixture();
    try {
      const first = prepare(subject.graph, subject.planData, subject.backendNow);
      if (first.kind !== 'candidate') throw new Error('Expected first candidate');
      const redelivery = {
        ...structuredClone(subject.planData),
        sourceId: randomUUID(),
        operationId: randomUUID(),
        beginCallHash: 'c'.repeat(64),
        completionCallHash: 'd'.repeat(64),
      };
      const replay = prepare(first.graph, redelivery, subject.backendNow);
      expect(replay).toEqual({ kind: 'replay', terminalReceipt: first.terminalReceipt });
      expect(replay).not.toHaveProperty('graph');

      const reviewedGraph = structuredClone(first.graph);
      const storedAssistant = reviewedGraph.episodes.find(
        (episode) => episode.uuid === subject.planData.sourceId,
      )!;
      storedAssistant.review_status = 'accepted';
      storedAssistant.trust_level = 'standard';
      expect(prepare(reviewedGraph, redelivery, subject.backendNow)).toEqual({
        kind: 'replay',
        terminalReceipt: first.terminalReceipt,
      });

      const changedFinal = {
        ...structuredClone(redelivery),
        intent: {
          ...structuredClone(redelivery.intent),
          finalAssistant: {
            ...structuredClone(redelivery.intent.finalAssistant),
            content: 'A different final answer.',
          },
        },
      };
      expect(prepare(first.graph, changedFinal, subject.backendNow)).toEqual({
        kind: 'decision',
        reason: 'conflict',
      });
    } finally {
      await subject.close();
    }
  });

  it('requires same-call IDs and hashes during reconciliation', async () => {
    const subject = await fixture();
    try {
      const first = prepare(subject.graph, subject.planData, subject.backendNow);
      if (first.kind !== 'candidate') throw new Error('Expected first candidate');
      expect(
        reconcileAutonomousPersonalAssistantFinalV4(
          first.graph,
          subject.planData,
          subject.backendNow,
          work(),
          () => {},
        ),
      ).toEqual({ kind: 'matched', terminalReceipt: first.terminalReceipt });

      const changedCall = {
        ...structuredClone(subject.planData),
        completionCallHash: 'e'.repeat(64),
      };
      expect(
        reconcileAutonomousPersonalAssistantFinalV4(
          first.graph,
          changedCall,
          subject.backendNow,
          work(),
          () => {},
        ),
      ).toEqual({ kind: 'unconfirmed' });
    } finally {
      await subject.close();
    }
  });

  it('keeps source-only state unconfirmed and never synthesizes a receipt', async () => {
    const subject = await fixture();
    try {
      const first = prepare(subject.graph, subject.planData, subject.backendNow);
      if (first.kind !== 'candidate') throw new Error('Expected first candidate');
      const sourceOnly = structuredClone(first.graph);
      sourceOnly.automatic_operations_v1!.operations =
        sourceOnly.automatic_operations_v1!.operations.filter(
          (operation) => operation.operationId !== subject.planData.operationId,
        );
      const result = reconcileAutonomousPersonalAssistantFinalV4(
        sourceOnly,
        subject.planData,
        subject.backendNow,
        work(),
        () => {},
      );
      expect(result).toEqual({ kind: 'unconfirmed' });
      expect(result).not.toHaveProperty('terminalReceipt');
      expect(prepare(sourceOnly, subject.planData, subject.backendNow)).toEqual({
        kind: 'decision',
        reason: 'source_only_unconfirmed',
      });
    } finally {
      await subject.close();
    }
  });

  it('does not turn an older assistant lease into an atomic committed candidate', async () => {
    const subject = await fixture();
    try {
      const initial = prepare(subject.graph, subject.planData, subject.backendNow);
      if (initial.kind !== 'candidate') throw new Error('Expected initial candidate DATA');
      const leasedGraph = structuredClone(initial.graph);
      const ledger = leasedGraph.automatic_operations_v1!;
      const index = ledger.operations.findIndex(
        (operation) => operation.operationId === subject.planData.operationId,
      );
      const committed = ledger.operations[index]!;
      if (committed.version !== 2 || committed.state !== 'committed') {
        throw new Error('Expected committed assistant Operation2');
      }
      const base = structuredClone(committed) as unknown as Record<string, unknown>;
      delete base.terminalReceipt;
      delete base.completionCallHash;
      ledger.operations[index] = AutomaticCaptureOperationV2Schema.parse({
        ...base,
        state: 'leased',
        generation: 1,
        lease: {
          token: randomUUID(),
          acquiredAt: subject.backendNow,
          renewedAt: subject.backendNow,
          expiresAt: new Date(Date.parse(subject.backendNow) + 60_000).toISOString(),
          claimKind: 'initial',
        },
      });
      expect(prepare(leasedGraph, subject.planData, subject.backendNow)).toEqual({
        kind: 'decision',
        reason: 'in_progress',
      });
    } finally {
      await subject.close();
    }
  });

  it('blocks a no-longer-current parent before returning a candidate', async () => {
    const subject = await fixture();
    try {
      const changedGraph = structuredClone(subject.graph);
      const parentSource = changedGraph.episodes.find(
        (episode) => episode.uuid === subject.source.uuid,
      )!;
      parentSource.review_status = 'rejected';
      expect(prepare(changedGraph, subject.planData, subject.backendNow)).toEqual({
        kind: 'decision',
        reason: 'authority_changed',
      });
    } finally {
      await subject.close();
    }
  });

  it('retains trusted callback error identity, including undefined, and enforces the original work', async () => {
    const subject = await fixture();
    try {
      let calls = 0;
      let threw = false;
      let thrown: unknown;
      try {
        prepareAutonomousPersonalAssistantFinalV4(
          subject.graph,
          subject.planData,
          subject.backendNow,
          work(),
          () => {
            calls += 1;
            throw undefined;
          },
        );
      } catch (error) {
        threw = true;
        thrown = error;
      }
      expect(threw).toBe(true);
      expect(thrown).toBeUndefined();
      expect(calls).toBe(1);

      const controller = new AbortController();
      controller.abort();
      expect(
        prepareAutonomousPersonalAssistantFinalV4(
          subject.graph,
          subject.planData,
          subject.backendNow,
          work(controller.signal),
          () => {},
        ),
      ).toEqual({ kind: 'decision', reason: 'budget_exhausted' });
      expect(
        prepareAutonomousPersonalAssistantFinalV4(
          subject.graph,
          subject.planData,
          subject.backendNow,
          work(new AbortController().signal, 0),
          () => {},
        ),
      ).toEqual({ kind: 'decision', reason: 'budget_exhausted' });
    } finally {
      await subject.close();
    }
  });

  it('rejects hostile graph access without running getters', async () => {
    const subject = await fixture();
    try {
      let getterCalls = 0;
      const hostile = Object.defineProperty({}, 'episodes', {
        enumerable: true,
        get() {
          getterCalls += 1;
          throw new Error('graph_getter_ran');
        },
      });
      expect(prepare(hostile as GraphData, subject.planData, subject.backendNow).kind).toBe(
        'decision',
      );
      expect(getterCalls).toBe(0);
    } finally {
      await subject.close();
    }
  });

  it('rejects changed persisted parent authority through the current-parent assertion', async () => {
    const subject = await fixture();
    try {
      const changedPlan = structuredClone(subject.planData);
      changedPlan.origin.identity.requestedAuthorityHash = hashAutomaticCaptureV2({
        changed: 'authority',
      });
      expect(prepare(subject.graph, changedPlan, subject.backendNow)).toEqual({
        kind: 'decision',
        reason: 'conflict',
      });
    } finally {
      await subject.close();
    }
  });
});
