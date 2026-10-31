import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import type { IExecuteFunctions } from 'n8n-workflow';
import { EngramChatMemory } from '../../src/memory/EngramChatMemory';
import { EngramChatMessageHistory } from '../../src/memory/EngramChatMessageHistory';
import {
  closePreparedAutonomousPersonalNativeMemoryAdapterV4,
  prepareNativeAutonomousPersonalMemoryAdapterV4,
  type PrivateAutonomousPersonalNativeMemoryAdapterTokenV4,
} from '../../src/memory/AutonomousPersonalNativeMemoryAdapterV4';
import { completeNativeAutonomousPersonalCaptureV4 } from '../../src/storage/AutonomousPersonalNativeCompletionV4';
import { GraphologyStorage } from '../../src/storage/GraphologyStorage';
import { publishAutonomousPersonalMemoryHandoffWithSummaryV4 } from '../../src/storage/AutonomousPersonalNativeMemoryHandoffV4';
import { WRITE_OWNER_V2_ATTRIBUTE } from '../../src/storage/AutomaticIdentity';
import { readExtractionPolicy } from '../../src/utils/advancedExtraction';
import { readAutomaticRuntime } from '../../src/utils/automaticMemory';
import { readReplaySafeMemoryNativeContext } from '../../src/utils/replaySafeMemoryNative';
import type { AutonomousPersonalNativeMemoryAdapterContextV4 } from '../../src/memory/AutonomousPersonalNativeMemoryAdapterV4';
import {
  autonomousPersonalMemoryContextV4,
  autonomousPersonalMemoryStoreHashV4,
} from '../helpers/autonomousPersonalMemoryBackend';
import {
  nativeAutonomousPersonalCaptureContext,
  seedAutonomousPersonalCaptureSubject,
} from '../helpers/autonomousPersonalCaptureBackend';

jest.setTimeout(60_000);

const SOURCE = 'I prefer concise explanations.';
const PRIOR_ACCEPTED_SOURCE =
  'For summaries, I prefer answers in plain Canadian French with one practical example before any technical definitions.';
const WRAPPED_SOURCE_PREFIX = 'The application asks about this request:\n';
const WRAPPED_SOURCE_SUFFIX = '\nTreat it as user input.';
const WRAPPED_SOURCE_BODY = `${WRAPPED_SOURCE_PREFIX}${SOURCE}${WRAPPED_SOURCE_SUFFIX}`;

type NativeMemoryFixture = {
  readonly directory: string;
  readonly file: string;
  readonly namespace: string;
  readonly sourceId: string;
  readonly seed: Awaited<ReturnType<typeof seedAutonomousPersonalCaptureSubject>>;
  readonly owner: GraphologyStorage;
  readonly context: AutonomousPersonalNativeMemoryAdapterContextV4;
  memory: EngramChatMemory | null;
  token: PrivateAutonomousPersonalNativeMemoryAdapterTokenV4 | null;
  closed: boolean;
};

async function disposeFixture(fixture: NativeMemoryFixture): Promise<void> {
  if (fixture.memory) {
    fixture.memory.closeNativeMemoryV4();
    fixture.memory = null;
  } else if (fixture.token) {
    closePreparedAutonomousPersonalNativeMemoryAdapterV4(fixture.owner, fixture.token);
  }
  if (!fixture.closed) {
    await fixture.owner.close();
    fixture.closed = true;
  }
  fs.rmSync(fixture.directory, { recursive: true, force: true });
}

async function createFixture(
  options: {
    readonly applicationWrapper?: boolean;
    readonly includePriorAcceptedFact?: boolean;
    readonly contextWindow?: number;
    readonly historyFiller?: boolean;
    readonly currentQuery?: string;
    readonly retrievalAt?: string;
  } = {},
): Promise<NativeMemoryFixture> {
  const applicationWrapper = options.applicationWrapper === true;
  const currentQuery = options.currentQuery ?? SOURCE;
  const sourceBody = applicationWrapper ? WRAPPED_SOURCE_BODY : currentQuery;
  const humanRegion = {
    start: WRAPPED_SOURCE_PREFIX.length,
    end: WRAPPED_SOURCE_PREFIX.length + SOURCE.length,
  };
  const directory = fs.mkdtempSync(join(tmpdir(), 'engram-native-memory-v4-'));
  const workflow = `native-memory-workflow-${randomUUID()}`;
  const file = join(directory, `${workflow}-engram.json`);
  let producer: GraphologyStorage | null = new GraphologyStorage(file);
  let owner: GraphologyStorage | null = null;
  let fixture: NativeMemoryFixture | null = null;
  try {
    await producer.initialize();
    const seed = await seedAutonomousPersonalCaptureSubject(producer);
    const native = {
      instance: `native-memory-instance-${randomUUID()}`,
      workflow,
      execution: `native-memory-execution-${randomUUID()}`,
    };
    const turn = `native-memory-turn-${randomUUID()}`;
    const captureContext = nativeAutonomousPersonalCaptureContext(seed, {
      content: sourceBody,
      executionId: native.execution,
      workflowId: native.workflow,
      instanceId: native.instance,
      deadlineMs: 30_000,
      routeId: 'route:native-memory-test',
      model: 'model:native-memory-test',
      interpreter: 'autonomousPersonalV1',
      extraParameters: {
        automaticMemoryProfile: 'explicit',
        automaticIntent: 'disabled',
        automaticTurn: turn,
        automaticRawHuman: applicationWrapper ? SOURCE : '',
        automaticWrapper: applicationWrapper ? 'enabled' : 'disabled',
        ...(applicationWrapper
          ? {
              automaticRegionStart: humanRegion.start,
              automaticRegionEnd: humanRegion.end,
            }
          : {}),
        queueTemperatureMode: 'providerDefault',
      },
    });
    const providerSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        messages: Array<{ role: string; content: string }>;
      };
      const user = JSON.parse(body.messages[1]!.content) as {
        units: Array<{ unitId: string }>;
      };
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  version: 1,
                  units: user.units.map(({ unitId }) => ({
                    unitId,
                    category: 'preference',
                    risk: 'ordinary',
                    usefulness: 'personal_memory',
                    downgrade: [],
                  })),
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    if (options.includePriorAcceptedFact) {
      const priorTurn = `native-memory-prior-turn-${randomUUID()}`;
      const priorContext = nativeAutonomousPersonalCaptureContext(seed, {
        content: PRIOR_ACCEPTED_SOURCE,
        executionId: `native-memory-prior-execution-${randomUUID()}`,
        workflowId: native.workflow,
        instanceId: native.instance,
        deadlineMs: 30_000,
        routeId: 'route:native-memory-test',
        model: 'model:native-memory-test',
        interpreter: 'autonomousPersonalV1',
        extraParameters: {
          automaticMemoryProfile: 'conservative',
          automaticIntent: 'disabled',
          automaticTurn: priorTurn,
          queueTemperatureMode: 'providerDefault',
        },
      });
      const prior = await completeNativeAutonomousPersonalCaptureV4(priorContext, producer);
      if (prior.kind !== 'original_turn')
        throw new Error(`Expected the actual prior C2 capture; got ${prior.kind}`);
      const priorGraph = await producer.exportGraph(seed.request.namespace);
      const priorOperation = priorGraph.automatic_operations_v1?.operations.find(
        (operation) =>
          operation.version === 4 &&
          operation.state === 'committed' &&
          operation.identity.turn === priorTurn,
      );
      const priorReceipt =
        priorOperation?.version === 4 && priorOperation.state === 'committed'
          ? priorOperation.terminalReceipt
          : null;
      if (
        priorReceipt?.kind !== 'human_autonomous_capture_committed' ||
        priorReceipt.selection.kind !== 'occurrences' ||
        !priorReceipt.selection.items.some(
          (item) => item.state === 'accepted' && item.effect === 'created' && item.claimId,
        )
      )
        throw new Error('Expected an actually accepted prior Claim3 row');
      providerSpy.mockImplementation(async () => {
        throw new Error('The current no-claim C2 source must not dispatch the provider');
      });
    }

    if (options.historyFiller) {
      await producer.addEpisode({
        group_id: seed.request.namespace,
        role: 'ai',
        content: 'Synthetic unrelated recent reply.',
        episode_kind: 'assistant_reply',
        trust_level: 'standard',
        review_status: 'accepted',
        reference_time: new Date().toISOString(),
      });
    }

    const completed = await completeNativeAutonomousPersonalCaptureV4(captureContext, producer);
    if (completed.kind !== 'original_turn')
      throw new Error(`Expected original C2 turn, got ${completed.kind}`);
    const published = publishAutonomousPersonalMemoryHandoffWithSummaryV4(
      captureContext,
      producer,
      completed.origin,
    );
    if (published.kind !== 'published') throw new Error('Expected a published native handoff');

    await producer.close();
    producer = null;
    owner = new GraphologyStorage(file);
    await owner.initialize();
    const memoryBase = autonomousPersonalMemoryContextV4({
      persistPath: file,
      storageWorkflowId: workflow,
      native,
      namespace: seed.request.namespace,
      issuer: seed.request.issuer,
      actorReference: seed.request.actorReference,
      turn,
      sourceId: published.sourceId,
      profileId: 'explicit',
      explicitIntent: false,
      currentHumanQuery: currentQuery,
      rawHumanContent: applicationWrapper ? SOURCE : undefined,
      sourceMapping: applicationWrapper
        ? { mode: 'application_region', humanRegion }
        : { mode: 'full_body' },
      routeId: 'route:native-memory-test',
      model: 'model:native-memory-test',
      requestLimit: 2,
      deadlineMs: 30_000,
    });
    const baseNode = memoryBase.getNode();
    const context = {
      ...memoryBase,
      getNode: () => ({
        ...baseNode,
        parameters: {
          ...baseNode.parameters,
          automaticPreferenceInterpreter: 'autonomousPersonalV1',
          extractionTemperatureMode: 'providerDefault',
        },
      }),
      getExecutionCancelSignal: () => undefined,
    } as unknown as AutonomousPersonalNativeMemoryAdapterContextV4;
    const nativeCapture = readReplaySafeMemoryNativeContext(
      context as unknown as IExecuteFunctions,
      0,
    );
    if (!nativeCapture) throw new Error('Expected replay-safe native Memory identity');
    const storeHash = autonomousPersonalMemoryStoreHashV4(file);
    const get = (name: string, fallback: unknown) => context.getNodeParameter(name, 0, fallback);
    const automaticMemory = readAutomaticRuntime(get, seed.request.namespace, storeHash);
    if (!automaticMemory) throw new Error('Expected automatic Memory settings');
    const token = await prepareNativeAutonomousPersonalMemoryAdapterV4(context, 0, owner);
    fixture = {
      directory,
      file,
      namespace: seed.request.namespace,
      sourceId: published.sourceId,
      seed,
      owner,
      context,
      memory: null,
      token,
      closed: false,
    };
    const memory = new EngramChatMemory(
      {
        ...nativeCapture,
        storage: owner,
        groupId: seed.request.namespace,
        automaticMemory,
        policy: {
          historyFilter: 'provenance',
          maxHistoryScan: 100,
          finalTurnWrites: true,
          storeToolAudit: true,
        },
        currentHumanQuery: currentQuery,
        ...(options.retrievalAt === undefined ? {} : { retrievalAt: options.retrievalAt }),
        extractionPolicy: readExtractionPolicy(get),
        extractionExecution: 'synchronous',
        retrievalMode: 'current',
        graphEvidenceBudgets: { durable: 4096, historical: 2048 },
        contextWindow: options.contextWindow ?? 8,
        maxFactsPerQuery: 10,
        minRelevanceScore: 0,
        acceptedOnlyRetrieval: true,
        enableExtraction: false,
        storeHumanEpisodes: true,
        humanEpisodeKind: 'active_human',
        storeAiEpisodes: true,
        extractHuman: true,
        extractAi: false,
        extractSystemTool: false,
      },
      token,
    );
    fixture.memory = memory;
    fixture.token = null;
    return fixture;
  } catch (error) {
    if (fixture) await disposeFixture(fixture);
    else {
      if (producer) await producer.close();
      if (owner) await owner.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
    throw error;
  }
}

function nativeAssistantRows(
  graph: Awaited<ReturnType<GraphologyStorage['readExtractionSnapshot']>>,
  sourceId: string,
) {
  return graph.episodes.filter(
    (episode) =>
      episode.role === 'ai' &&
      episode.episode_kind === 'assistant_reply' &&
      episode.previous_episode_uuid === sourceId,
  );
}

describe('native personal Memory V4 integration', () => {
  const fixtures = new Set<NativeMemoryFixture>();

  afterEach(async () => {
    jest.restoreAllMocks();
    for (const fixture of fixtures) await disposeFixture(fixture);
    fixtures.clear();
  });

  async function addFixture(
    options: {
      readonly applicationWrapper?: boolean;
      readonly includePriorAcceptedFact?: boolean;
      readonly contextWindow?: number;
      readonly historyFiller?: boolean;
      readonly currentQuery?: string;
      readonly retrievalAt?: string;
    } = {},
  ): Promise<NativeMemoryFixture> {
    const fixture = await createFixture(options);
    fixtures.add(fixture);
    return fixture;
  }

  it('loads governed graph context, a redacted creation summary, and conversation through one native read frame', async () => {
    const fixture = await addFixture();
    const legacyFinalSpy = jest.spyOn(fixture.owner, 'saveAssistantFinalV2');
    const nativeFinalSpy = jest.spyOn(fixture.owner, 'saveAssistantFinalV4');

    const loaded = await fixture.memory!.loadMemoryVariablesWithDiagnostics({ input: SOURCE });
    const messages = loaded.variables.chat_history as BaseMessage[];
    const summary = messages.find(
      (message) =>
        message instanceof SystemMessage &&
        String(message.content).includes('Engram creation summary'),
    );

    expect(summary).toBeDefined();
    expect(String(summary?.content)).toContain('Acceptance coverage:');
    expect(String(summary?.content)).not.toContain(fixture.sourceId);
    expect(String(summary?.content)).not.toContain('terminalReceipt');
    expect(loaded.diagnostics.retrieval.query_source).toBe('input');
    expect(nativeFinalSpy).not.toHaveBeenCalled();
    expect(legacyFinalSpy).not.toHaveBeenCalled();
  });

  it('keeps accepted graph facts when the native node supplies a blank hidden timestamp', async () => {
    const baseline = await addFixture({
      includePriorAcceptedFact: true,
      currentQuery: 'French',
    });
    const baselineLoad = await baseline.memory!.loadMemoryVariablesWithDiagnostics({});
    expect(baselineLoad.diagnostics.retrieval.fact_messages).toBe(1);

    const fixture = await addFixture({
      includePriorAcceptedFact: true,
      currentQuery: 'French',
      retrievalAt: '',
    });

    const loaded = await fixture.memory!.loadMemoryVariablesWithDiagnostics({});
    const messages = loaded.variables.chat_history as BaseMessage[];
    const graphFacts = messages.filter(
      (message) =>
        message instanceof SystemMessage &&
        !String(message.content).includes('Engram creation summary'),
    );

    expect(loaded.diagnostics.retrieval.query_source).toBe('configured');
    expect(loaded.diagnostics.retrieval.query_available).toBe(true);
    expect(loaded.diagnostics.retrieval.fact_messages).toBe(1);
    expect(graphFacts).toHaveLength(1);
  });

  it('retrieves the accepted prior preference from graph when its source is outside recent history', async () => {
    const fixture = await addFixture({
      includePriorAcceptedFact: true,
      currentQuery: 'French',
      contextWindow: 1,
      historyFiller: true,
    });
    const loaded = await fixture.memory!.loadMemoryVariablesWithDiagnostics({});
    const messages = loaded.variables.chat_history as BaseMessage[];
    const conversation = messages.filter((message) => !(message instanceof SystemMessage));
    expect(conversation).toHaveLength(1);
    expect(String(conversation[0]!.content)).toBe('Synthetic unrelated recent reply.');
    expect(
      conversation.every((message) => !String(message.content).includes(PRIOR_ACCEPTED_SOURCE)),
    ).toBe(true);
    const facts = messages.filter(
      (message) =>
        message instanceof SystemMessage &&
        !String(message.content).includes('Engram creation summary'),
    );
    expect(loaded.diagnostics.retrieval.fact_messages).toBe(1);
    expect(facts).toHaveLength(1);
    expect(String(facts[0]!.content)).toContain('French');
    expect(String(facts[0]!.content)).toContain('Canadian');
    expect(String(facts[0]!.content)).toContain('practical');
    expect(String(facts[0]!.content)).toContain('before');
  });

  it('uses one native final writer for saveContext and accepts the configured-query replay without resubmission', async () => {
    const fixture = await addFixture();
    const legacyFinalSpy = jest.spyOn(fixture.owner, 'saveAssistantFinalV2');
    const nativeFinalSpy = jest.spyOn(fixture.owner, 'saveAssistantFinalV4');

    const first = await fixture.memory!.saveContextWithDelivery(
      { input: SOURCE },
      { output: 'A synthetic concise final answer.' },
    );
    const firstReceipt = 'replaySafe' in first ? first.replaySafe?.finalAssistant : undefined;
    expect(firstReceipt?.state).toBe('persisted');
    expect(nativeFinalSpy).toHaveBeenCalledTimes(1);
    expect(legacyFinalSpy).not.toHaveBeenCalled();

    const replay = await fixture.memory!.saveMessagesWithDelivery([
      new AIMessage('A synthetic concise final answer.'),
    ]);
    expect('replaySafe' in replay ? replay.replaySafe?.finalAssistant.state : undefined).toBe(
      'persisted',
    );
    expect(nativeFinalSpy).toHaveBeenCalledTimes(1);
    const graph = await fixture.owner.readExtractionSnapshot(fixture.namespace);
    const saved = nativeAssistantRows(graph, fixture.sourceId);
    expect(saved).toHaveLength(1);
    expect(saved[0]?.content).toBe('A synthetic concise final answer.');
  });

  it('buffers and deduplicates repeated tool batches, then appends audit episodes only after a confirmed final', async () => {
    const fixture = await addFixture();
    const legacyFinalSpy = jest.spyOn(fixture.owner, 'saveAssistantFinalV2');
    const nativeFinalSpy = jest.spyOn(fixture.owner, 'saveAssistantFinalV4');
    const auditSpy = jest.spyOn(fixture.owner, 'appendEpisodes');
    const toolBatch = [
      new HumanMessage(SOURCE),
      new AIMessage({
        content: '',
        tool_calls: [
          {
            id: 'call-native-memory-1',
            name: 'lookup',
            args: { query: 'synthetic' },
            type: 'tool_call',
          },
        ],
      }),
      new ToolMessage({ content: 'synthetic tool result', tool_call_id: 'call-native-memory-1' }),
    ];

    const before = await fixture.owner.readExtractionSnapshot(fixture.namespace);
    const firstBatch = await fixture.memory!.saveMessagesWithDelivery(toolBatch);
    const repeatedBatch = await fixture.memory!.saveMessagesWithDelivery(toolBatch);
    expect('replaySafe' in firstBatch ? firstBatch.replaySafe?.audit : undefined).toMatchObject({
      state: 'failed',
      reason: 'interrupted',
      requested: 2,
    });
    expect(
      'replaySafe' in repeatedBatch ? repeatedBatch.replaySafe?.audit : undefined,
    ).toMatchObject({ state: 'failed', reason: 'interrupted', requested: 2 });
    expect(nativeFinalSpy).not.toHaveBeenCalled();
    expect(auditSpy).not.toHaveBeenCalled();
    expect(
      nativeAssistantRows(
        await fixture.owner.readExtractionSnapshot(fixture.namespace),
        fixture.sourceId,
      ),
    ).toHaveLength(0);

    const final = await fixture.memory!.saveMessagesWithDelivery([
      ...toolBatch,
      new AIMessage('Only this final answer is the assistant source.'),
    ]);
    expect('replaySafe' in final ? final.replaySafe?.finalAssistant.state : undefined).toBe(
      'persisted',
    );
    expect('replaySafe' in final ? final.replaySafe?.audit : undefined).toMatchObject({
      state: 'complete',
      requested: 2,
      confirmedNew: 2,
    });
    expect(nativeFinalSpy).toHaveBeenCalledTimes(1);
    expect(legacyFinalSpy).not.toHaveBeenCalled();
    expect(auditSpy).toHaveBeenCalledTimes(1);

    const after = await fixture.owner.readExtractionSnapshot(fixture.namespace);
    const saved = nativeAssistantRows(after, fixture.sourceId);
    expect(saved).toHaveLength(1);
    expect(saved[0]?.content).toBe('Only this final answer is the assistant source.');
    const audits = after.episodes.filter((episode) => episode.attributes.engram_audit === true);
    expect(audits).toHaveLength(2);
    expect(audits.every((episode) => episode.review_status === 'proposed')).toBe(true);
    expect(audits.some((episode) => episode.content.includes('Only this final answer'))).toBe(
      false,
    );
    expect(after.entities).toEqual(before.entities);
    expect(after.edges).toEqual(before.edges);
  });

  it('rejects a current-parent review change before saving a final assistant source', async () => {
    const fixture = await addFixture();
    const legacyFinalSpy = jest.spyOn(fixture.owner, 'saveAssistantFinalV2');
    const nativeFinalSpy = jest.spyOn(fixture.owner, 'saveAssistantFinalV4');
    await fixture.owner.updateEpisode(fixture.sourceId, { review_status: 'rejected' });

    await expect(
      fixture.memory!.saveContextWithDelivery({ input: SOURCE }, { output: 'Must not persist.' }),
    ).rejects.toThrow('Engram native Memory: final_not_authorized');
    expect(nativeFinalSpy).toHaveBeenCalledTimes(1);
    expect(legacyFinalSpy).not.toHaveBeenCalled();
    const after = await fixture.owner.readExtractionSnapshot(fixture.namespace);
    expect(nativeAssistantRows(after, fixture.sourceId)).toHaveLength(0);
  });

  it('rechecks the current parent before reusing a cached final receipt', async () => {
    const fixture = await addFixture();
    const nativeFinalSpy = jest.spyOn(fixture.owner, 'saveAssistantFinalV4');
    await fixture.memory!.saveContextWithDelivery(
      { input: SOURCE },
      { output: 'Cached final answer.' },
    );
    await fixture.owner.updateEpisode(fixture.sourceId, { review_status: 'rejected' });

    await expect(
      fixture.memory!.saveMessagesWithDelivery([new AIMessage('Cached final answer.')]),
    ).rejects.toThrow(/authority_changed|final_not_authorized/);
    expect(nativeFinalSpy).toHaveBeenCalledTimes(1);
  });

  it('accepts exact stored source-body replay for an application wrapper after revalidating its parent', async () => {
    const fixture = await addFixture({ applicationWrapper: true });
    const nativeFinalSpy = jest.spyOn(fixture.owner, 'saveAssistantFinalV4');
    const finalText = 'The final answer for the wrapped human request.';

    const first = await fixture.memory!.saveMessagesWithDelivery([new AIMessage(finalText)]);
    expect('replaySafe' in first ? first.replaySafe?.finalAssistant.state : undefined).toBe(
      'persisted',
    );
    expect(nativeFinalSpy).toHaveBeenCalledTimes(1);

    const parentSnapshotSpy = jest.spyOn(fixture.owner, 'readCompositionalRetrievalSnapshotV3');
    const backendEpisodeLookupSpy = jest.spyOn(fixture.owner, 'getEpisode');
    const exactSourceBodyReplay = await fixture.memory!.saveMessagesWithDelivery([
      new HumanMessage(WRAPPED_SOURCE_BODY),
      new AIMessage(finalText),
    ]);
    expect(
      'replaySafe' in exactSourceBodyReplay
        ? exactSourceBodyReplay.replaySafe?.finalAssistant.state
        : undefined,
    ).toBe('persisted');
    expect(nativeFinalSpy).toHaveBeenCalledTimes(1);
    expect(parentSnapshotSpy).toHaveBeenCalledTimes(1);
    expect(backendEpisodeLookupSpy).not.toHaveBeenCalled();

    await expect(
      fixture.memory!.saveMessagesWithDelivery([
        new HumanMessage(WRAPPED_SOURCE_BODY),
        new AIMessage('A changed final answer.'),
      ]),
    ).rejects.toThrow('Engram native Memory: final_already_attempted');
    await expect(
      fixture.memory!.saveMessagesWithDelivery([
        new HumanMessage(`${WRAPPED_SOURCE_BODY} `),
        new AIMessage(finalText),
      ]),
    ).rejects.toThrow('Engram native Memory: invalid_current_turn');

    await fixture.owner.updateEpisode(fixture.sourceId, { review_status: 'rejected' });
    await expect(
      fixture.memory!.saveMessagesWithDelivery([
        new HumanMessage(WRAPPED_SOURCE_BODY),
        new AIMessage(finalText),
      ]),
    ).rejects.toThrow(/authority_changed|final_not_authorized/);
    expect(nativeFinalSpy).toHaveBeenCalledTimes(1);
    expect(
      nativeAssistantRows(
        await fixture.owner.readExtractionSnapshot(fixture.namespace),
        fixture.sourceId,
      ),
    ).toHaveLength(1);
  });

  it('clears pending audit data and never falls back after native adapter close', async () => {
    const fixture = await addFixture();
    const legacyFinalSpy = jest.spyOn(fixture.owner, 'saveAssistantFinalV2');
    const nativeFinalSpy = jest.spyOn(fixture.owner, 'saveAssistantFinalV4');
    const appendSpy = jest.spyOn(fixture.owner, 'appendEpisodes');
    const buffered = await fixture.memory!.saveMessagesWithDelivery([
      new SystemMessage('synthetic buffered tool data'),
    ]);
    expect('replaySafe' in buffered ? buffered.replaySafe?.audit.requested : undefined).toBe(1);
    expect(appendSpy).not.toHaveBeenCalled();

    fixture.memory!.closeNativeMemoryV4();
    await expect(
      fixture.memory!.loadMemoryVariablesWithDiagnostics({ input: SOURCE }),
    ).rejects.toThrow('Engram native Memory: invalid_adapter');
    await expect(
      fixture.memory!.saveMessagesWithDelivery([new AIMessage('Must not use a legacy writer.')]),
    ).rejects.toThrow('Engram native Memory: invalid_adapter');
    expect(legacyFinalSpy).not.toHaveBeenCalled();
    expect(nativeFinalSpy).not.toHaveBeenCalled();
    expect(appendSpy).not.toHaveBeenCalled();
  });

  it('keeps the public history facade target-free for direct clear and append calls', async () => {
    const fixture = await addFixture();
    const before = await fixture.owner.readExtractionSnapshot(fixture.namespace);
    const history = fixture.memory!.chatHistory as EngramChatMessageHistory;

    await expect(history.clear()).rejects.toThrow('Engram native Memory: unsupported_operation');
    await expect(
      history.appendMessageWrites([{ message: new HumanMessage('bypass attempt') }]),
    ).rejects.toThrow('Engram native Memory: unsupported_operation');
    expect(await history.getMessages()).toEqual([]);

    const after = await fixture.owner.readExtractionSnapshot(fixture.namespace);
    expect(after.entities).toEqual(before.entities);
    expect(after.edges).toEqual(before.edges);
    expect(after.episodes).toEqual(before.episodes);
    expect(after.metadata).toEqual(before.metadata);

    const nativeFinalSpy = jest.spyOn(fixture.owner, 'saveAssistantFinalV4');
    const appendSpy = jest.spyOn(fixture.owner, 'appendEpisodes');
    await history.addMessages([new AIMessage('Direct history final uses the fixed writer.')]);
    expect(nativeFinalSpy).toHaveBeenCalledTimes(1);
    expect(appendSpy).not.toHaveBeenCalled();
  });

  it('keeps the old default Memory path on the ordinary conversation writer', async () => {
    const fixture = await addFixture();
    const v4Spy = jest.spyOn(fixture.owner, 'saveAssistantFinalV4');
    const before = await fixture.owner.readExtractionSnapshot('legacy-default-memory');
    const legacy = new EngramChatMemory({
      storage: fixture.owner,
      groupId: 'legacy-default-memory',
      policy: { finalTurnWrites: false },
      enableExtraction: false,
    });

    await legacy.saveContextWithDelivery(
      { input: 'ordinary legacy question' },
      { output: 'ordinary legacy answer' },
    );

    const after = await fixture.owner.readExtractionSnapshot('legacy-default-memory');
    expect(after.episodes).toHaveLength(before.episodes.length + 2);
    expect(v4Spy).not.toHaveBeenCalled();
  });
});
