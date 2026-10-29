import * as fs from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { performance } from 'perf_hooks';
import type { BaseMessage } from '@langchain/core/messages';
import { GraphologyStorage } from '../../src/storage/GraphologyStorage';
import { EngramChatMessageHistory } from '../../src/memory/EngramChatMessageHistory';
import { seedAutomaticCaptureSubject } from '../helpers/automaticCaptureBackend';
import { CompositionalAutomaticCaptureBeginRequestV3Schema } from '../../src/schemas/CompositionalAutomaticCaptureV3.schema';
import { captureCompositionalHumanMemoryV3 } from '../../src/memory/CompositionalHumanCaptureV3';
import { embeddedAutomaticCaptureStoreHash } from '../../src/storage/AutomaticCaptureStore';
import {
  CompositionalMemoryParentExpectedV3Schema,
  type CompositionalMemoryParentExpectedV3,
} from '../../src/schemas/CompositionalMemoryParentV3.schema';
import { loadCompositionalRuntimeReaderV3 } from '../../src/search/CompositionalRuntimeReaderV3';
import { validateCompositionalMemoryParentV3 } from '../../src/memory/CompositionalMemoryParentV3';
import type { EpisodicNode } from '../../src/schemas/EpisodicNode.schema';
import type { AutomaticBindingRecord } from '../../src/schemas/AutomaticOperations.schema';

describe('history from the same actual reader as its fixed parent check', () => {
  let directory: string;
  let store: GraphologyStorage;
  let history: EngramChatMessageHistory;
  let expected: CompositionalMemoryParentExpectedV3;
  let binding: AutomaticBindingRecord;
  const provider = async () => {
    const loaded = await loadCompositionalRuntimeReaderV3(
      store,
      { namespace: expected.namespace },
      {
        budget: { remaining: 512, deferred: 0 },
      },
    );
    if (loaded.status !== 'ready') throw new Error('synthetic reader unavailable');
    if (validateCompositionalMemoryParentV3(loaded.reader, expected).status !== 'valid_parent_data')
      throw new Error('synthetic current parent rejected');
    return loaded.reader;
  };
  beforeEach(async () => {
    directory = fs.mkdtempSync(join(tmpdir(), 'engram-history-reader-v3-'));
    const path = join(directory, 'store.json');
    store = new GraphologyStorage(path);
    await store.initialize();
    const seeded = await seedAutomaticCaptureSubject(store);
    binding = seeded.binding;
    await store.appendEpisodes([
      {
        group_id: seeded.request.namespace,
        role: 'human',
        content: '{"genuine":"user JSON"}',
        episode_kind: 'active_human',
        reference_time: new Date().toISOString(),
      },
      {
        group_id: seeded.request.namespace,
        role: 'ai',
        content: 'Earlier final reply',
        episode_kind: 'assistant_reply',
        reference_time: new Date().toISOString(),
      },
      {
        group_id: seeded.request.namespace,
        role: 'system',
        content: 'Synthetic private tool audit',
        episode_kind: 'tool_output',
        reference_time: new Date().toISOString(),
        attributes: { engram_audit: true },
      },
    ]);
    const request = CompositionalAutomaticCaptureBeginRequestV3Schema.parse({
      ...seeded.request,
      version: 3,
      preferenceInterpreter: 'compositionalV2',
      source: { ...seeded.request.source, content: 'I prefer British English.' },
    });
    const captured = await captureCompositionalHumanMemoryV3(store, request);
    if (!captured.should_process || !captured.sourceId)
      throw new Error('Expected real first capture');
    expected = CompositionalMemoryParentExpectedV3Schema.parse({
      version: 3,
      preferenceInterpreter: 'compositionalV2',
      namespace: request.namespace,
      currentHumanInput: request.source.content,
      expectedHumanProcessingAttemptHash: request.attemptIdHash,
      invocationDeadlineMs: request.settings.invocationDeadlineMs,
      runtime: {
        profileId: request.settings.profileId,
        storeIdentity: embeddedAutomaticCaptureStoreHash(path),
        turnId: request.turn,
        capturedSourceId: captured.sourceId,
        explicitIntent: false,
        actor: {
          namespace: request.namespace,
          issuer: request.issuer,
          actorReference: request.actorReference,
        },
      },
    });
    history = new EngramChatMessageHistory({
      storage: store,
      groupId: request.namespace,
      contextWindow: 2,
      policy: { historyFilter: 'provenance', maxHistoryScan: 10, finalTurnWrites: true },
    });
    history.excludeCurrentSource(captured.sourceId);
    history.setCompositionalReadProvider(provider);
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('keeps genuine JSON, excludes audits/current source once, and refills without a live getter fallback', async () => {
    const spy = jest.spyOn(store, 'getRecentEpisodes');
    const result = await history.getMessagesWithDiagnostics();
    expect(result.messages.map((m) => m.content)).toEqual([
      '{"genuine":"user JSON"}',
      'Earlier final reply',
    ]);
    expect(result.messages.map((m) => m._getType())).toEqual(['human', 'ai']);
    expect(result.history.returned).toBe(2);
    expect(result.history.excluded_provenance).toBe(1);
    expect(spy).not.toHaveBeenCalled();
  });

  it('creates a fresh guarded snapshot on each direct history read and observes revocation', async () => {
    const source = jest.fn(provider);
    history.setCompositionalReadProvider(source);
    await expect(history.getMessages()).resolves.toHaveLength(2);
    await store.automaticBindingCommand({
      action: 'revoke',
      namespace: expected.namespace,
      bindingId: binding.bindingId,
      expectedRevision: binding.revision,
      authorizedBy: 'synthetic-reviewer',
      reason: 'Synthetic revocation',
    });
    const fallback = jest.spyOn(store, 'getRecentEpisodes');
    await expect(history.getMessages()).rejects.toThrow('synthetic current parent rejected');
    expect(source).toHaveBeenCalledTimes(2);
    expect(fallback).not.toHaveBeenCalled();
  });

  it('does not replace an invalid/copy reader with a live storage read', async () => {
    const reader = await provider();
    history.setCompositionalReadProvider(async () => structuredClone(reader));
    const fallback = jest.spyOn(store, 'getRecentEpisodes');
    await expect(history.getMessages()).rejects.toThrow('snapshot_not_authorized');
    expect(fallback).not.toHaveBeenCalled();
  });

  it('does not publish messages if formatting crosses the reader deadline', async () => {
    const reader = await provider();
    history.setCompositionalReadProvider(async () => reader);
    const target = history as unknown as { episodeToMessage(e: EpisodicNode): BaseMessage };
    const convert = target.episodeToMessage.bind(history);
    let clock: jest.SpyInstance | undefined;
    jest.spyOn(target, 'episodeToMessage').mockImplementation((episode) => {
      const result = convert(episode);
      if (!clock) clock = jest.spyOn(performance, 'now').mockReturnValue(performance.now() + 6000);
      return result;
    });
    try {
      await expect(history.getMessages()).rejects.toThrow('snapshot_not_authorized');
    } finally {
      clock?.mockRestore();
    }
  });

  it('leaves the omitted-provider history path unchanged', async () => {
    const legacy = new EngramChatMessageHistory({
      storage: store,
      groupId: expected.namespace,
      contextWindow: 2,
      policy: { historyFilter: 'provenance', maxHistoryScan: 10 },
    });
    const getter = jest.spyOn(store, 'getRecentEpisodes');
    expect((await legacy.getMessages()).map((m) => m.content)).toEqual([
      'Earlier final reply',
      expected.currentHumanInput,
    ]);
    expect(getter).toHaveBeenCalledTimes(1);
  });
});
