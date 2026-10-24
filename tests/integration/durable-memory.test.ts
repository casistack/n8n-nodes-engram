import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { GraphologyStorage } from '../../src/storage/GraphologyStorage';
import { Neo4jStorage } from '../../src/storage/Neo4jStorage';
import type { IGraphStorage } from '../../src/storage/IGraphStorage';
import { EngramChatMemory } from '../../src/memory/EngramChatMemory';
import { processExtractionJobs } from '../../src/extraction/DurableExtraction';

const settings = {
  llm: {
    apiKey: 'local-test',
    baseUrl: 'https://provider.test',
    model: 'fixed',
    temperature: { mode: 'providerDefault' as const },
  },
  policy: { mode: 'bounded' as const, quality: 'durableTemporal' as const },
  types: ['person', 'concept'],
  threshold: { autoAcceptThreshold: 0.85, rejectBelowThreshold: 0.3 },
};
function suite(name: string, create: (path: string) => IGraphStorage) {
  describe(name, () => {
    let storage: IGraphStorage, dir: string, group: string;
    const original = global.fetch;
    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'engram-durable-'));
      group = randomUUID();
      storage = create(join(dir, 'memory.json'));
      await storage.initialize();
    });
    afterEach(async () => {
      global.fetch = original;
      await storage.clearGroup(group, { allowQueued: true });
      await storage.close();
      await rm(dir, { recursive: true, force: true });
    });
    function memory(extra = {}) {
      return new EngramChatMemory({
        storage,
        groupId: group,
        enableExtraction: true,
        llmConfig: settings.llm,
        extractionPolicy: settings.policy,
        entityTypes: settings.types,
        extractionThresholdPolicy: settings.threshold,
        extractionExecution: 'durable',
        extractionRouteId: 'local',
        policy: { finalTurnWrites: true, storeToolAudit: true },
        episodeMetadata: { idempotency_key: 'turn', trust_level: 'standard' },
        currentHumanQuery: 'favorite color cobalt',
        minRelevanceScore: 0,
        contextWindow: 2,
        ...extra,
      });
    }
    function mockProvider() {
      global.fetch = jest.fn().mockImplementation(async (_url, request) => {
        const body = JSON.parse(request.body);
        expect(body).not.toHaveProperty('temperature');
        const sources = JSON.parse(body.messages[1].content);
        const human = sources.find((source: any) => source.role === 'human');
        const evidence = [{ source_id: human.source_id, start: 0, end: human.content.length }];
        const data = {
          entities: [
            {
              id: 'p',
              name: 'Alder',
              entity_type: 'person',
              category: 'durable_fact',
              confidence: 0.99,
              evidence,
            },
            {
              id: 'c',
              name: 'Cobalt',
              entity_type: 'concept',
              category: 'preference',
              confidence: 0.99,
              evidence,
            },
          ],
          relationships: [
            {
              source_id: 'p',
              target_id: 'c',
              name: 'FAVORITE_COLOR',
              fact: 'Alder favorite color is cobalt',
              category: 'preference',
              confidence: 0.99,
              evidence,
            },
          ],
        };
        return new Response(
          JSON.stringify({ choices: [{ message: { content: JSON.stringify(data) } }] }),
        );
      });
    }
    it('returns only durable queued delivery, then a separate worker indexes and a long-lived memory recalls', async () => {
      global.fetch = jest.fn();
      const m = memory();
      const result = await m.saveContextWithDelivery(
        { input: 'Alder favorite color is cobalt.' },
        { output: 'Noted.' },
      );
      expect(result).toMatchObject({
        delivery: { status: 'queued', durable: true, graph_fresh: false },
        written: 2,
      });
      expect(result).not.toHaveProperty('extraction');
      expect(global.fetch).not.toHaveBeenCalled();
      expect(await storage.listEntities(group)).toEqual([]);
      const before = await m.loadMemoryVariablesWithDiagnostics({});
      expect(before.diagnostics.queue).toMatchObject({ pending: 1 });
      mockProvider();
      const work = await processExtractionJobs(storage, group, 'local', settings);
      expect(work).toMatchObject([
        {
          state: 'completed',
          outcome: { status: 'succeeded', counts: { entities_created: 2, edges_created: 1 } },
        },
      ]);
      const after = await m.loadMemoryVariablesWithDiagnostics({});
      expect(after.diagnostics.queue).toMatchObject({
        version: 1,
        pending: 0,
        failed: 0,
        graph_fresh: true,
      });
      expect(JSON.stringify(after.variables)).toContain('Alder favorite color is cobalt');
      const calls = (global.fetch as jest.Mock).mock.calls.length;
      const replay = await m.saveContextWithDelivery(
        { input: 'Alder favorite color is cobalt.' },
        { output: 'Noted.' },
      );
      expect(replay).toMatchObject({
        delivery: { jobs: [{ state: 'completed' }] },
        written: 0,
        duplicates: 2,
      });
      expect(await processExtractionJobs(storage, group, 'local', settings)).toEqual([]);
      expect((global.fetch as jest.Mock).mock.calls).toHaveLength(calls);
    });
    it('native tool bulk writes save the final pair and audit once; source content excludes tools', async () => {
      const m = memory();
      global.fetch = jest.fn();
      await m.chatHistory.addMessages([
        new HumanMessage('Alder favorite color is cobalt.'),
        new AIMessage({ content: '', tool_calls: [{ id: 'tool', name: 'probe', args: {} }] }),
        new ToolMessage({ content: 'PRIVATE_TOOL_PAYLOAD', tool_call_id: 'tool' }),
        new AIMessage('Noted.'),
      ]);
      expect(await storage.listEpisodes(group)).toHaveLength(4);
      mockProvider();
      await processExtractionJobs(storage, group, 'local', settings);
      expect(JSON.stringify((global.fetch as jest.Mock).mock.calls)).not.toContain(
        'PRIVATE_TOOL_PAYLOAD',
      );
      const result = await m.loadMemoryVariablesWithDiagnostics({});
      expect(result.diagnostics.history).toMatchObject({ returned: 2, excluded_provenance: 2 });
      expect(JSON.stringify(result.variables)).not.toContain('PRIVATE_TOOL_PAYLOAD');
    });
    it.each([
      { storeHumanEpisodes: false },
      { storeAiEpisodes: false },
      { extractSystemTool: true },
      { policy: { finalTurnWrites: false } },
      { extractionRouteId: '' },
    ])('rejects unsupported queue configuration before append %j', async (extra) => {
      expect(() => memory(extra)).toThrow('unsupported_configuration');
      expect(await storage.listEpisodes(group)).toEqual([]);
    });

    it('keeps bounded extraction fail-soft after history persistence if snapshot storage fails', async () => {
      const m = memory({ extractionExecution: 'synchronous' });
      jest
        .spyOn(storage, 'readExtractionSnapshot')
        .mockRejectedValueOnce(new Error('PRIVATE_STORAGE_ERROR'));
      jest.spyOn(console, 'warn').mockImplementation();
      const result = await m.saveContextWithOutcome(
        { input: 'Alder favorite color is cobalt.' },
        { output: 'Noted.' },
      );
      expect(result.status).toBe('failed');
      expect(result.errors).toEqual([{ stage: 'persistence', kind: 'storage' }]);
      expect(await storage.listEpisodes(group)).toHaveLength(2);
      expect(JSON.stringify(result)).not.toContain('PRIVATE_STORAGE_ERROR');
      jest.restoreAllMocks();
    });

    it('uses captured source authority if trust changes immediately before preparation', async () => {
      const m = memory({ extractionExecution: 'synchronous' });
      const originalRead = storage.readExtractionSnapshot!.bind(storage);
      jest.spyOn(storage, 'readExtractionSnapshot').mockImplementationOnce(async (namespace) => {
        const episodes = await storage.listEpisodes(group);
        const human = episodes.find((ep) => ep.role === 'human')!;
        await storage.updateEpisode(human.uuid, {
          trust_level: 'unverified',
          review_status: 'proposed',
        });
        return originalRead(namespace);
      });
      mockProvider();
      const result = await m.saveContextWithOutcome(
        { input: 'Alder favorite color is cobalt.' },
        { output: 'Noted.' },
      );
      expect(result.status).toBe('succeeded');
      const edges = (await storage.exportGraph(group)).edges;
      expect(edges[0].attributes.engram_extraction).toMatchObject({ review_status: 'proposed' });
      jest.restoreAllMocks();
    });

    it('stops dispatching provider work after heartbeat renewal fails', async () => {
      await memory().saveContextWithDelivery(
        { input: 'Alder favorite color is cobalt.' },
        { output: 'Noted.' },
      );
      const originalCommand = storage.extractionQueueCommand!.bind(storage);
      jest.spyOn(storage, 'extractionQueueCommand').mockImplementation(async (command) => {
        if (command.action === 'renew') throw new Error('Synthetic lease loss');
        return originalCommand(command);
      });
      global.fetch = jest
        .fn()
        .mockImplementation(
          async (_url, request) =>
            new Promise((_resolve, reject) =>
              request.signal.addEventListener('abort', () => reject(new Error('aborted'))),
            ),
        );
      jest.spyOn(console, 'warn').mockImplementation();
      const result = await processExtractionJobs(storage, group, 'local', settings, 1, {
        lease_ms: 1000,
        heartbeat_ms: 20,
      });
      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(result[0].state).not.toBe('completed');
      expect(await storage.listEntities(group)).toEqual([]);
      jest.restoreAllMocks();
    });
    it('worker credential rotation preserves binding while a different model cannot claim', async () => {
      await memory().saveContextWithDelivery(
        { input: 'Alder favorite color is cobalt.' },
        { output: 'Noted.' },
      );
      expect(
        await processExtractionJobs(storage, group, 'local', {
          ...settings,
          llm: { ...settings.llm, model: 'different' },
        }),
      ).toEqual([]);
      mockProvider();
      expect(
        (
          await processExtractionJobs(storage, group, 'local', {
            ...settings,
            llm: { ...settings.llm, apiKey: 'rotated' },
          })
        )[0].state,
      ).toBe('completed');
    });
  });
}
suite('embedded durable memory', (path) => new GraphologyStorage(path));
if (process.env.NEO4J_TEST_URI)
  suite(
    'Neo4j durable memory',
    () =>
      new Neo4jStorage(
        process.env.NEO4J_TEST_URI!,
        'neo4j',
        process.env.NEO4J_TEST_PASSWORD ?? 'engram-local-test',
      ),
  );
