import * as fs from 'fs';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';
import { join } from 'path';
import { AIMessage } from '@langchain/core/messages';
import { performance } from 'perf_hooks';
import * as RuntimeReader from '../../src/search/CompositionalRuntimeReaderV3';
import { GraphologyStorage } from '../../src/storage/GraphologyStorage';
import { EngramChatMemory, type EngramChatMemoryInput } from '../../src/memory/EngramChatMemory';
import type { EngramChatMessageHistory } from '../../src/memory/EngramChatMessageHistory';
import { seedAutomaticCaptureSubject } from '../helpers/automaticCaptureBackend';
import { CompositionalAutomaticCaptureBeginRequestV3Schema } from '../../src/schemas/CompositionalAutomaticCaptureV3.schema';
import { embeddedAutomaticCaptureStoreHash } from '../../src/storage/AutomaticCaptureStore';
import type { AutomaticBindingRecord } from '../../src/schemas/AutomaticOperations.schema';
import type { EpisodicNode } from '../../src/schemas/EpisodicNode.schema';

const RICH_PREFERENCE =
  'I prefer explanations in plain British English, with one practical example before any technical terminology.';

async function captureMemoryParent(
  storage: GraphologyStorage,
  file: string,
  options: {
    content?: string;
    profileId?: 'conservative' | 'reviewFirst';
    includeConversation?: boolean;
  } = {},
) {
  const seeded = await seedAutomaticCaptureSubject(storage);
  const content = options.content ?? RICH_PREFERENCE;
  const profileId = options.profileId ?? 'conservative';
  if (options.includeConversation) {
    await storage.appendEpisodes([
      {
        group_id: seeded.request.namespace,
        role: 'human',
        content: '{"genuine":"human JSON stays conversation history"}',
        episode_kind: 'active_human',
        reference_time: '2026-10-24T10:00:00.000Z',
      },
      {
        group_id: seeded.request.namespace,
        role: 'ai',
        content: 'Earlier answer in this conversation.',
        episode_kind: 'assistant_reply',
        reference_time: '2026-10-24T10:01:00.000Z',
      },
      {
        group_id: seeded.request.namespace,
        role: 'system',
        content: 'Synthetic tool audit that must stay out of history.',
        episode_kind: 'tool_output',
        reference_time: '2026-10-24T10:02:00.000Z',
        trust_level: 'unverified',
        review_status: 'proposed',
        attributes: { engram_audit: true },
      },
    ]);
  }

  const request = CompositionalAutomaticCaptureBeginRequestV3Schema.parse({
    ...seeded.request,
    version: 3,
    preferenceInterpreter: 'compositionalV2',
    settings: { ...seeded.request.settings, profileId },
    source: { ...seeded.request.source, content },
  });
  const begin = await storage.beginAndClaimCompositionalCaptureV3!({
    mode: 'existingStore',
    request,
  });
  if (begin.kind !== 'claimed') throw new Error(`Expected V3 claim, got ${begin.kind}`);
  const completed = await storage.completeCompositionalHumanCaptureV3!(begin.handle);
  if (!completed.eligibleFirstCommit) throw new Error('Expected a committed first human capture');

  const graph = await storage.readExtractionSnapshot!();
  const sourceId = completed.terminalReceipt.sourceId;
  const operation = graph.automatic_operations_v1?.operations.find(
    (candidate) =>
      candidate.version === 3 &&
      candidate.state === 'committed' &&
      candidate.identity.sourceId === sourceId,
  );
  if (!operation || operation.version !== 3 || operation.state !== 'committed')
    throw new Error('Expected the actual committed V3 operation');
  const initialAttempt = operation.attempts[0];
  if (initialAttempt?.disposition !== 'claim_won')
    throw new Error('Expected the actual initial claim_won attempt');
  const capturedSource = graph.episodes.find((episode) => episode.uuid === sourceId);
  if (!capturedSource) throw new Error('Expected the actual captured source episode');
  const storeIdentity = embeddedAutomaticCaptureStoreHash(file);
  if (!storeIdentity) throw new Error('Expected the configured embedded store identity');

  const fields: EngramChatMemoryInput = {
    storage,
    groupId: seeded.request.namespace,
    captureLifecycle: 'replaySafeV2',
    automaticPreferenceInterpreter: 'compositionalV2',
    expectedHumanProcessingAttemptHash: initialAttempt.attemptHash,
    // This remains the separate assistant2 processing-attempt value.
    processingAttemptHash: 'b'.repeat(64),
    currentHumanQuery: content,
    automaticMemory: {
      profileId,
      storeIdentity,
      turnId: request.turn,
      capturedSourceId: capturedSource.uuid,
      explicitIntent: false,
      actor: {
        namespace: request.namespace,
        issuer: request.issuer,
        actorReference: request.actorReference,
      },
    },
    extractionPolicy: {
      mode: 'bounded',
      quality: 'durableTemporal',
      deadline_ms: request.settings.invocationDeadlineMs,
    },
    policy: {
      finalTurnWrites: true,
      storeToolAudit: true,
      historyFilter: 'provenance',
      maxHistoryScan: 20,
    },
    returnMessages: true,
    contextWindow: 2,
    minRelevanceScore: 0,
    acceptedOnlyRetrieval: true,
    enableExtraction: false,
    extractAi: false,
    extractSystemTool: false,
  };
  return {
    namespace: seeded.request.namespace,
    binding: seeded.binding,
    content,
    fields,
    capturedSource,
    operation,
  };
}

describe('compositional V3 Memory on a fresh embedded reader', () => {
  let directory: string;
  let file: string;
  let storage: GraphologyStorage;
  let namespace: string;
  let content: string;
  let binding: AutomaticBindingRecord;
  let fields: EngramChatMemoryInput;
  let capturedSource: EpisodicNode;
  let mockEmbeddingRequests = false;

  beforeEach(async () => {
    mockEmbeddingRequests = false;
    directory = fs.mkdtempSync(join(tmpdir(), 'engram-compositional-memory-'));
    file = join(directory, 'store.json');
    storage = new GraphologyStorage(file);
    await storage.initialize();
    const setup = await captureMemoryParent(storage, file, { includeConversation: true });
    namespace = setup.namespace;
    binding = setup.binding;
    content = setup.content;
    fields = setup.fields;
    capturedSource = setup.capturedSource;

    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('Unexpected provider call'));
  });

  afterEach(async () => {
    if (!mockEmbeddingRequests) expect(global.fetch).not.toHaveBeenCalled();
    jest.useRealTimers();
    jest.restoreAllMocks();
    await storage.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it.each(['legacy', 'current'] as const)(
    'reads rich graph facts with %s presentation and keeps history order, JSON and audit filtering',
    async (retrievalMode) => {
      const memory = new EngramChatMemory({ ...fields, retrievalMode });
      const recentFallback = jest.spyOn(storage, 'getRecentEpisodes');

      const loaded = await memory.loadMemoryVariablesWithDiagnostics({ input: content });
      const messages = loaded.variables.chat_history as Array<{
        _getType(): string;
        content: string;
      }>;
      const systems = messages
        .filter((message) => message._getType() === 'system')
        .map((message) => message.content);
      const conversation = messages.filter((message) => message._getType() !== 'system');

      expect(messages[0]._getType()).toBe('system');
      expect(systems.join('\n')).toMatch(
        /British English|practical example|technical terminology/u,
      );
      expect(conversation.map((message) => message.content)).toEqual([
        '{"genuine":"human JSON stays conversation history"}',
        'Earlier answer in this conversation.',
      ]);
      expect(conversation.some((message) => message.content === content)).toBe(false);
      expect(conversation.some((message) => message.content.includes('Synthetic tool audit'))).toBe(
        false,
      );
      expect(loaded.diagnostics.history.excluded_provenance).toBe(1);
      expect(loaded.diagnostics.capture).toMatchObject({
        version: 3,
        source_id: capturedSource.uuid,
        receipt: { acceptedCoverage: 'all' },
      });
      expect(
        systems.filter((message) => message.startsWith('Memory capture receipt for this turn:')),
      ).toHaveLength(1);
      expect(recentFallback).not.toHaveBeenCalled();

      const graph = await storage.readExtractionSnapshot!();
      expect(graph.edges.length).toBeGreaterThan(0);
      expect(graph.episodes.filter((episode) => episode.uuid === capturedSource.uuid)).toHaveLength(
        1,
      );
    },
  );

  it('recalls the complete rich graph claim after its source leaves the bounded history scan', async () => {
    await storage.appendEpisodes(
      Array.from({ length: 25 }, (_, index) => ({
        group_id: namespace,
        role: 'ai' as const,
        content: `Synthetic later answer ${index}.`,
        episode_kind: 'assistant_reply' as const,
        reference_time: new Date().toISOString(),
      })),
    );
    const memory = new EngramChatMemory({ ...fields, retrievalMode: 'current' });
    const loaded = await memory.loadMemoryVariablesWithDiagnostics({ input: content });
    const messages = loaded.variables.chat_history as Array<{
      _getType(): string;
      content: string;
    }>;
    const facts = messages
      .filter((message) => message._getType() === 'system')
      .map((message) => message.content)
      .join('\n');
    expect(facts).toContain('plain British English');
    expect(facts).toContain('one practical example');
    expect(facts).toContain('before any technical terminology');
    const conversation = messages.filter((message) => message._getType() !== 'system');
    expect(conversation).toHaveLength(2);
    expect(
      conversation.every((message) => message.content.startsWith('Synthetic later answer')),
    ).toBe(true);
    expect(conversation.some((message) => message.content === content)).toBe(false);
    expect(loaded.diagnostics.history.fetched).toBeLessThanOrEqual(22);
  });

  it('uses one fresh reader per concurrent load', async () => {
    const memory = new EngramChatMemory(fields);
    const snapshots = jest.spyOn(storage, 'readCompositionalRetrievalSnapshotV3');

    const [first, second] = await Promise.all([
      memory.loadMemoryVariables({ input: content }),
      memory.loadMemoryVariables({ input: content }),
    ]);

    expect(snapshots).toHaveBeenCalledTimes(2);
    for (const result of [first, second]) {
      const messages = result.chat_history as Array<{ _getType(): string; content: string }>;
      expect(messages[0]._getType()).toBe('system');
      expect(messages.map((message) => message.content).join('\n')).toMatch(
        /British English|practical example|technical terminology/u,
      );
    }
  });

  it('revalidates binding on fresh load and direct history reads before live history fallback', async () => {
    const memory = new EngramChatMemory(fields);
    const recentFallback = jest.spyOn(storage, 'getRecentEpisodes');

    const initialHistory = await memory.chatHistory.getMessages();
    expect(initialHistory.map((message) => message.content)).toEqual([
      '{"genuine":"human JSON stays conversation history"}',
      'Earlier answer in this conversation.',
    ]);

    await storage.automaticBindingCommand!({
      action: 'revoke',
      namespace,
      bindingId: binding.bindingId,
      expectedRevision: binding.revision,
      authorizedBy: 'synthetic-reviewer',
      reason: 'Synthetic memory parent revocation',
    });

    await expect(memory.loadMemoryVariables({ input: content })).rejects.toThrow();
    await expect(memory.chatHistory.getMessages()).rejects.toThrow();
    expect(recentFallback).not.toHaveBeenCalled();
  });

  it('keeps parent, history and search on the same root when revocation races after snapshot capture', async () => {
    const memory = new EngramChatMemory(fields);
    const readSnapshot = storage.readCompositionalRetrievalSnapshotV3!.bind(storage);
    let revoked = false;
    jest
      .spyOn(storage, 'readCompositionalRetrievalSnapshotV3')
      .mockImplementation(async (scope) => {
        const snapshot = await readSnapshot(scope);
        if (!revoked) {
          revoked = true;
          await storage.automaticBindingCommand!({
            action: 'revoke',
            namespace,
            bindingId: binding.bindingId,
            expectedRevision: binding.revision,
            authorizedBy: 'synthetic-reviewer',
            reason: 'Synthetic revocation after the read snapshot was captured',
          });
        }
        return snapshot;
      });
    const recentFallback = jest.spyOn(storage, 'getRecentEpisodes');

    const loaded = await memory.loadMemoryVariables({ input: content });
    const messages = loaded.chat_history as Array<{ _getType(): string; content: string }>;
    expect(
      messages
        .filter((message) => message._getType() === 'system')
        .map((message) => message.content)
        .join('\n'),
    ).toMatch(/British English|practical example|technical terminology/u);
    expect(recentFallback).not.toHaveBeenCalled();

    await expect(memory.loadMemoryVariables({ input: content })).rejects.toThrow();
    await expect(memory.chatHistory.getMessages()).rejects.toThrow();
    expect(recentFallback).not.toHaveBeenCalled();
  });

  it('rejects a missing attempt hash, unsupported lifecycle and unknown interpreter at construction', async () => {
    expect(
      () => new EngramChatMemory({ ...fields, expectedHumanProcessingAttemptHash: undefined }),
    ).toThrow();
    expect(() => new EngramChatMemory({ ...fields, captureLifecycle: 'legacy' })).toThrow(
      'unsupported_configuration',
    );
    expect(
      () =>
        new EngramChatMemory({
          ...fields,
          automaticPreferenceInterpreter:
            'unsupported' as unknown as EngramChatMemoryInput['automaticPreferenceInterpreter'],
        }),
    ).toThrow('unsupported_configuration');
  });

  it('rejects a changed native human attempt before history fallback or final writes', async () => {
    const memory = new EngramChatMemory({
      ...fields,
      expectedHumanProcessingAttemptHash: 'f'.repeat(64),
    });
    const before = await storage.readExtractionSnapshot!();
    const recentFallback = jest.spyOn(storage, 'getRecentEpisodes');
    const finalSave = jest.spyOn(storage, 'saveAssistantFinalV2');

    await expect(memory.loadMemoryVariables({ input: content })).rejects.toThrow();
    await expect(memory.chatHistory.getMessages()).rejects.toThrow();
    await expect(
      memory.saveContextWithDelivery({ input: content }, { output: 'Must not be persisted.' }),
    ).rejects.toThrow();

    expect(recentFallback).not.toHaveBeenCalled();
    expect(finalSave).not.toHaveBeenCalled();
    const after = await storage.readExtractionSnapshot!();
    expect(after.entities).toEqual(before.entities);
    expect(after.edges).toEqual(before.edges);
    expect(after.episodes).toEqual(before.episodes);
    expect(after.automatic_operations_v1).toEqual(before.automatic_operations_v1);
  });

  it('distinguishes repeated statement occurrences from one persisted accepted claim', async () => {
    const query = 'I prefer concise explanations. I prefer concise explanations.';
    const setup = await captureMemoryParent(storage, file, { content: query });
    const loaded = await new EngramChatMemory(setup.fields).loadMemoryVariablesWithDiagnostics({
      input: query,
    });
    const receipt = loaded.diagnostics.capture?.receipt;
    expect(receipt).toMatchObject({
      kind: 'committed',
      acceptedCoverage: 'all',
      counts: { bundleCount: 2, distinctPersistedClaimCount: 1 },
    });
    const systems = (loaded.variables.chat_history as Array<{ content: string }>).map(
      (message) => message.content,
    );
    expect(
      systems.find((message) => message.startsWith('Memory capture receipt for this turn:')),
    ).toContain('1 distinct accepted knowledge claims across 2 accepted statement occurrences');
    expect(systems.join('\n')).toContain('Counts alone do not identify which parts were saved');
    const graph = await storage.readExtractionSnapshot!();
    expect(
      graph.edges.filter(
        (edge) => edge.group_id === setup.fields.groupId && edge.attributes.engram_claim_v1,
      ),
    ).toHaveLength(1);
  });

  it.each([
    ['reviewFirst', 'I prefer concise explanations.'],
    ['conservative', 'What is the forecast in Wellington today?'],
  ] as const)('allows a %s parent with no accepted facts', async (profileId, query) => {
    const setup = await captureMemoryParent(storage, file, {
      profileId,
      content: query,
    });
    const memory = new EngramChatMemory(setup.fields);
    const loaded = await memory.loadMemoryVariablesWithDiagnostics({ input: query });
    const messages = loaded.variables.chat_history as Array<{
      _getType(): string;
      content: string;
    }>;

    expect(loaded.diagnostics.retrieval.fact_messages).toBe(0);
    // The receipt is deliberately separate from graph facts and must not imply accepted knowledge.
    const systems = messages.filter((message) => message._getType() === 'system');
    expect(systems).toHaveLength(1);
    expect(systems[0].content).toMatch(
      /^Memory capture receipt for this turn: at capture commit, 0 distinct accepted knowledge claims/u,
    );
    expect(loaded.diagnostics.capture?.receipt.acceptedCoverage).toBe('none');
    expect(messages.filter((message) => message._getType() !== 'system')).toHaveLength(0);
    if (profileId === 'reviewFirst') {
      const receipt = setup.operation.terminalReceipt;
      if (
        receipt.kind !== 'human_compositional_capture_committed' ||
        receipt.selection.kind !== 'bundles'
      )
        throw new Error('Expected a committed proposed bundle receipt');
      expect(receipt.acceptedCoverage).toBe('none');
      expect(receipt.selection.items[0].state).toBe('proposed');
    } else {
      const receipt = setup.operation.terminalReceipt;
      if (receipt.kind !== 'human_compositional_source_verdict_committed')
        throw new Error('Expected a committed source-verdict receipt');
      expect(receipt.acceptedCoverage).toBe('none');
    }
  });

  it('saves one assistant2 final plus separate audits and treats bulk replay as idempotent', async () => {
    const memory = new EngramChatMemory(fields);
    const finalSave = jest.spyOn(storage, 'saveAssistantFinalV2');
    const before = await storage.readExtractionSnapshot!();
    const originalAuditCount = before.episodes.filter(
      (episode) => episode.attributes.engram_audit === true,
    ).length;

    const saved = await memory.saveContextWithDelivery(
      { input: content, tool_output: 'Synthetic tool output for audit only.' },
      { output: 'Synthetic final answer.' },
    );
    expect(saved).toMatchObject({
      replaySafe: {
        finalAssistant: { state: 'persisted', terminalReceipt: { kind: 'assistant_final_saved' } },
        audit: { state: 'complete', requested: 1, confirmedNew: 1 },
      },
    });
    expect(finalSave).toHaveBeenCalledTimes(1);

    const replay = await (memory.chatHistory as EngramChatMessageHistory).addMessagesWithDelivery([
      new AIMessage('Synthetic final answer.'),
    ]);
    expect(replay).toMatchObject({
      written: 0,
      duplicates: 1,
      replaySafe: { finalAssistant: { state: 'persisted' } },
    });
    const graph = await storage.readExtractionSnapshot!();
    const finals = graph.episodes.filter(
      (episode) => episode.role === 'ai' && episode.content === 'Synthetic final answer.',
    );
    const audits = graph.episodes.filter((episode) => episode.attributes.engram_audit === true);
    const assistantOperations = graph.automatic_operations_v1?.operations.filter(
      (operation) =>
        operation.version === 2 && operation.identity.purpose === 'assistant_final_save',
    );
    expect(finals).toHaveLength(1);
    expect(audits).toHaveLength(originalAuditCount + 1);
    expect(
      audits.filter((episode) => episode.content.includes('Synthetic tool output for audit only')),
    ).toHaveLength(1);
    expect(assistantOperations).toHaveLength(1);
    expect((await storage.readExtractionSnapshot!()).episodes).toEqual(graph.episodes);
    expect(finalSave).toHaveBeenCalledTimes(2);
  });

  it('does not rerun extraction for the captured source even when legacy extraction fields are enabled', async () => {
    const memory = new EngramChatMemory({
      ...fields,
      enableExtraction: true,
      llmConfig: {
        apiKey: 'synthetic-no-provider',
        baseUrl: 'https://example.invalid/v1',
        model: 'synthetic-model',
      },
    });
    await memory.loadMemoryVariables({ input: content });
    const saved = await memory.saveContextWithDelivery(
      { input: content },
      { output: 'Synthetic final without re-extraction.' },
    );
    expect(saved).toMatchObject({
      extraction: { status: 'disabled' },
      replaySafe: { finalAssistant: { state: 'persisted' } },
    });
    expect(global.fetch).not.toHaveBeenCalled();
    const graph = await storage.readExtractionSnapshot!();
    expect(
      graph.episodes.filter((episode) => episode.role === 'human' && episode.content === content),
    ).toHaveLength(1);
  });

  it.each(['headers', 'body'] as const)(
    'aborts delayed embedding %s at the original reader deadline after snapshot work consumes4900ms',
    async (stage) => {
      mockEmbeddingRequests = true;
      jest.useFakeTimers({ doNotFake: ['performance', 'nextTick', 'queueMicrotask'] });
      let clock = 0;
      jest.spyOn(performance, 'now').mockImplementation(() => clock);
      const actual = storage.readCompositionalRetrievalSnapshotV3!.bind(storage);
      jest
        .spyOn(storage, 'readCompositionalRetrievalSnapshotV3')
        .mockImplementation(async (scope) => {
          const snapshot = await actual(scope);
          clock = 4900;
          return snapshot;
        });
      let started!: () => void;
      const dispatched = new Promise<void>((resolve) => {
        started = resolve;
      });
      let signal: AbortSignal | undefined, body: ReadableStream<Uint8Array> | undefined;
      jest.mocked(global.fetch).mockImplementationOnce((_url, init) => {
        signal = init!.signal as AbortSignal;
        started();
        if (stage === 'headers')
          return new Promise<Response>((_resolve, reject) =>
            signal!.addEventListener(
              'abort',
              () => reject(new DOMException('synthetic aborted', 'AbortError')),
              { once: true },
            ),
          );
        body = new ReadableStream<Uint8Array>({
          start(controller) {
            signal!.addEventListener(
              'abort',
              () => controller.error(new DOMException('synthetic body aborted', 'AbortError')),
              { once: true },
            );
          },
        });
        return Promise.resolve(new Response(body, { status: 200 }));
      });
      const memory = new EngramChatMemory({
        ...fields,
        embeddingConfig: {
          apiKey: 'synthetic-embedding',
          baseUrl: 'https://example.invalid/v1',
          model: 'synthetic-vector',
          timeoutMs: 30000,
        },
      });
      const result = expect(memory.loadMemoryVariables({ input: content })).rejects.toThrow(
        'budget_exhausted',
      );
      await dispatched;
      expect(signal!.aborted).toBe(false);
      clock = 4999;
      await jest.advanceTimersByTimeAsync(99);
      expect(signal!.aborted).toBe(false);
      clock = 5000;
      await jest.advanceTimersByTimeAsync(1);
      await result;
      expect(signal!.aborted).toBe(true);
      expect(global.fetch).toHaveBeenCalledTimes(1);
      if (body) expect(body.locked).toBe(false);
      expect(jest.getTimerCount()).toBe(0);
    },
  );

  it('does not dispatch embeddings when time expires between allowance sampling and budget construction', async () => {
    jest.useFakeTimers({ doNotFake: ['performance', 'nextTick', 'queueMicrotask'] });
    let clock = 0;
    jest.spyOn(performance, 'now').mockImplementation(() => clock);
    const allowance = RuntimeReader.getCompositionalRuntimeRequestAllowanceV3;
    jest
      .spyOn(RuntimeReader, 'getCompositionalRuntimeRequestAllowanceV3')
      .mockImplementation((reader) => {
        const result = allowance(reader);
        clock = 5000;
        return result;
      });
    const memory = new EngramChatMemory({
      ...fields,
      embeddingConfig: {
        apiKey: 'synthetic-embedding',
        baseUrl: 'https://example.invalid/v1',
        model: 'synthetic-vector',
      },
    });
    await expect(memory.loadMemoryVariables({ input: content })).rejects.toThrow(
      'budget_exhausted',
    );
    expect(global.fetch).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('keeps parallel embedding requests isolated and disposes each successful load independently', async () => {
    mockEmbeddingRequests = true;
    jest.useFakeTimers({ doNotFake: ['performance', 'nextTick', 'queueMicrotask'] });
    jest.spyOn(performance, 'now').mockReturnValue(0);
    const signals: AbortSignal[] = [],
      resolveRequests: Array<(response: Response) => void> = [];
    let ready!: () => void;
    const dispatched = new Promise<void>((resolve) => {
      ready = resolve;
    });
    jest.mocked(global.fetch).mockImplementation(
      (_url, init) =>
        new Promise<Response>((resolve, reject) => {
          const signal = init!.signal as AbortSignal;
          signals.push(signal);
          resolveRequests.push(resolve);
          signal.addEventListener(
            'abort',
            () => reject(new DOMException('synthetic aborted', 'AbortError')),
            { once: true },
          );
          if (signals.length === 2) ready();
        }),
    );
    const memory = new EngramChatMemory({
      ...fields,
      embeddingConfig: {
        apiKey: 'synthetic-embedding',
        baseUrl: 'https://example.invalid/v1',
        model: 'synthetic-vector',
      },
    });
    const first = memory.loadMemoryVariables({ input: content }),
      second = memory.loadMemoryVariables({ input: content });
    await dispatched;
    const response = () =>
      new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }), { status: 200 });
    resolveRequests[0](response());
    expect((await Promise.race([first, second])).chat_history).toBeDefined();
    expect(signals[0].aborted).toBe(false);
    expect(signals[1].aborted).toBe(false);
    resolveRequests[1](response());
    for (const loaded of await Promise.all([first, second]))
      expect(loaded.chat_history).toBeDefined();
    expect(signals[1].aborted).toBe(false);
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('rechecks the original reader after reservation and before actual embedding dispatch', async () => {
    jest.useFakeTimers({ doNotFake: ['performance', 'nextTick', 'queueMicrotask'] });
    let clock = 0;
    jest.spyOn(performance, 'now').mockImplementation(() => clock);
    const Controller = global.AbortController;
    let created = 0;
    jest.spyOn(global, 'AbortController').mockImplementation(() => {
      const controller = new Controller();
      created++;
      if (created === 2) clock = 5000;
      return controller;
    });
    const memory = new EngramChatMemory({
      ...fields,
      embeddingConfig: {
        apiKey: 'synthetic-embedding',
        baseUrl: 'https://example.invalid/v1',
        model: 'synthetic-vector',
      },
    });
    await expect(memory.loadMemoryVariables({ input: content })).rejects.toThrow(
      'budget_exhausted',
    );
    expect(created).toBe(2);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('binds parent authority to constructor-time runtime settings', async () => {
    const original = structuredClone(fields.automaticMemory!);
    const memory = new EngramChatMemory(fields);
    fields.automaticMemory!.actor.actorReference = 'mutated-after-construction';
    fields.automaticMemory!.capturedSourceId = randomUUID();
    fields.automaticMemory!.storeIdentity = 'f'.repeat(64);
    fields.automaticPreferenceInterpreter = 'literalV1';
    fields.expectedHumanProcessingAttemptHash = 'f'.repeat(64);
    fields.extractionPolicy = { ...fields.extractionPolicy!, deadline_ms: 1 };
    fields.currentHumanQuery = 'mutated-after-construction';

    const result = await memory.saveContextWithDelivery(
      { input: content },
      { output: 'Constructor-bound final answer.' },
    );

    expect(result).toMatchObject({
      replaySafe: { finalAssistant: { state: 'persisted' } },
    });
    const graph = await storage.readExtractionSnapshot!();
    const final = graph.episodes.find(
      (episode) => episode.role === 'ai' && episode.content === 'Constructor-bound final answer.',
    );
    expect(final).toBeDefined();
    expect(JSON.stringify(final?.attributes)).toContain(capturedSource.uuid);
    expect(JSON.stringify(final?.attributes)).not.toContain('mutated-after-construction');
    expect(original.capturedSourceId).toBe(capturedSource.uuid);
  });
});
