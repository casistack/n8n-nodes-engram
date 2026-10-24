import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import { EngramChatMessageHistory } from '../../../src/memory/EngramChatMessageHistory';
import { contentHash } from '../../../src/memory/HistorySelection';
import { GraphologyStorage } from '../../../src/storage/GraphologyStorage';
import type { CreateEpisodicNode, MemoryPolicyInput } from '../../../src/schemas';

const payload = '[{"response":{"result":"synthetic tool"}},{"error":null}]';
const input = (
  content: string,
  role: 'human' | 'ai' | 'system',
  episode_kind: CreateEpisodicNode['episode_kind'] = 'legacy',
): CreateEpisodicNode => ({
  group_id: 'history',
  content,
  role,
  episode_kind,
  reference_time: new Date().toISOString(),
});

describe('non-destructive history selection', () => {
  let storage: GraphologyStorage;
  beforeEach(async () => {
    storage = new GraphologyStorage();
    await storage.initialize();
  });
  afterEach(async () => storage.close());
  const history = (storage: GraphologyStorage, policy: MemoryPolicyInput, contextWindow = 3) =>
    new EngramChatMessageHistory({ storage, groupId: 'history', contextWindow, policy });

  it('refills eligible slots across local pages and leaves records/chains untouched', async () => {
    await storage.appendEpisodes([
      input('real human', 'human', 'active_human'),
      input('real reply', 'ai', 'assistant_reply'),
      input('system context', 'system', 'system'),
      ...Array.from({ length: 205 }, (_, i) => input(`tool ${i}`, 'ai', 'tool_output')),
    ]);
    const before = await storage.exportGraph();
    const result = await history(storage, {
      historyFilter: 'provenance',
    }).getMessagesWithDiagnostics();
    expect(result.messages.map((m) => m.content)).toEqual([
      'real human',
      'real reply',
      'system context',
    ]);
    expect(result.messages[2]).toBeInstanceOf(SystemMessage);
    expect(result.history).toMatchObject({
      examined: 208,
      pages: 3,
      returned: 3,
      excluded_provenance: 205,
      scan_truncated: false,
    });
    expect((await storage.exportGraph()).episodes).toEqual(before.episodes);
  });

  it('reports budget truncation separately from snapshot overflow', async () => {
    await storage.appendEpisodes([
      input('older useful', 'human', 'active_human'),
      ...Array.from({ length: 8 }, () => input('audit', 'ai', 'tool_output')),
    ]);
    const result = await history(storage, {
      historyFilter: 'provenance',
      maxHistoryScan: 3,
    }).getMessagesWithDiagnostics();
    expect(result.messages).toEqual([]);
    expect(result.history).toMatchObject({
      fetched: 4,
      examined: 3,
      snapshot_overflow: true,
      scan_truncated: true,
    });
    await storage.appendEpisodes([input('latest useful', 'human', 'active_human')]);
    expect(
      (
        await history(
          storage,
          { historyFilter: 'provenance', maxHistoryScan: 3 },
          1,
        ).getMessagesWithDiagnostics()
      ).history,
    ).toMatchObject({ snapshot_overflow: true, scan_truncated: false, returned: 1 });
  });

  it('retains ambiguous legacy JSON without operator approval', async () => {
    await storage.appendEpisodes([
      input('[]', 'ai'),
      input(payload, 'human'),
      input('final answer', 'ai'),
    ]);
    const result = await history(storage, {
      historyFilter: 'reviewedLegacy',
    }).getMessagesWithDiagnostics();
    expect(result.messages.map((m) => m.content)).toEqual(['[]', payload, 'final answer']);
    expect(result.history).toMatchObject({ legacy_candidates: 1, excluded_legacy: 0 });
  });

  it('excludes only reviewed exact legacy pairs and refills older messages', async () => {
    await storage.appendEpisodes([
      input('older human', 'human'),
      input('older reply', 'ai'),
      input('[]', 'ai'),
      input(payload, 'human'),
      input('final answer', 'ai'),
    ]);
    const before = await storage.exportGraph();
    const result = await history(storage, {
      historyFilter: 'reviewedLegacy',
      legacyArtifactHashes: [contentHash(payload)],
    }).getMessagesWithDiagnostics();
    expect(result.messages.map((m) => m.content)).toEqual([
      'older human',
      'older reply',
      'final answer',
    ]);
    expect(result.history).toMatchObject({ excluded_legacy: 2, returned: 3 });
    expect((await storage.exportGraph()).episodes).toEqual(before.episodes);
  });

  it.each([
    { episode_kind: 'active_human' as const },
    { quoted_message_id: 'quoted' },
    { sender_id: 'real-sender' },
    { source_message_id: 'actual-source' },
    { source_execution_id: 'different-execution' },
  ])('retains genuine/quoted/identified or mismatched JSON: %j', async (extra) => {
    await storage.appendEpisodes([input('[]', 'ai'), { ...input(payload, 'human'), ...extra }]);
    const result = await history(storage, {
      historyFilter: 'reviewedLegacy',
      legacyArtifactHashes: [contentHash(payload)],
    }).getMessages();
    expect(result.map((m) => m.content)).toEqual(['[]', payload]);
  });

  it('requires chain adjacency even when a hash matches', async () => {
    await storage.appendEpisodes([input('[]', 'ai')]);
    await storage.addEpisode({ ...input(payload, 'human'), previous_episode_uuid: null });
    expect(
      (
        await history(storage, {
          historyFilter: 'reviewedLegacy',
          legacyArtifactHashes: [contentHash(payload)],
        }).getMessages()
      ).map((m) => m.content),
    ).toContain(payload);
  });

  it('handles legacy lookbehind across a local page boundary', async () => {
    await storage.appendEpisodes([
      input('older useful', 'human'),
      input('[]', 'ai'),
      input(payload, 'human'),
      ...Array.from({ length: 99 }, () => input('audit', 'ai', 'tool_output')),
    ]);
    const result = await history(
      storage,
      { historyFilter: 'reviewedLegacy', legacyArtifactHashes: [contentHash(payload)] },
      1,
    ).getMessagesWithDiagnostics();
    expect(result.messages[0].content).toBe('older useful');
    expect(result.history).toMatchObject({ pages: 2, excluded_legacy: 2 });
  });

  it('never includes tool audits under final-turn mode even when history filtering is off', async () => {
    await storage.appendEpisodes([
      input('real', 'human', 'active_human'),
      input('audit', 'ai', 'tool_output'),
      { ...input('other audit', 'system', 'system'), attributes: { engram_audit: true } },
    ]);
    const result = await history(
      storage,
      { finalTurnWrites: true },
      1,
    ).getMessagesWithDiagnostics();
    expect(result.messages.map((m) => m.content)).toEqual(['real']);
    expect(result.history.excluded_provenance).toBe(2);
  });

  it('preserves unfiltered legacy history and ordinary human JSON', async () => {
    const h = history(storage, {});
    await h.addMessages([
      new HumanMessage(payload),
      new AIMessage('reply'),
      new SystemMessage('system'),
    ]);
    expect((await h.getMessages()).map((m) => m.content)).toEqual([payload, 'reply', 'system']);
  });

  it.each([
    { maxHistoryScan: 0 },
    { maxHistoryScan: 1.5 },
    { maxHistoryScan: 10001 },
    { legacyArtifactHashes: ['broad-pattern'] },
  ])('rejects invalid policy %j', (policy) => {
    expect(() => history(storage, policy)).toThrow();
  });

  it('uses one bounded detached snapshot despite later appends', async () => {
    await storage.appendEpisodes([input('one', 'human'), input('two', 'ai')]);
    const read = jest.spyOn(storage, 'getRecentEpisodes');
    const result = await history(
      storage,
      { historyFilter: 'provenance', maxHistoryScan: 4 },
      2,
    ).getMessagesWithDiagnostics();
    await storage.appendEpisodes([input('later', 'human')]);
    expect(result.messages.map((m) => m.content)).toEqual(['one', 'two']);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith('history', 5);
  });
});
