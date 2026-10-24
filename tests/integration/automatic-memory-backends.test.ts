import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { GraphologyStorage } from '../../src/storage/GraphologyStorage';
import { Neo4jStorage } from '../../src/storage/Neo4jStorage';
import type { IGraphStorage } from '../../src/storage/IGraphStorage';
import type { EngramChatMemoryInput } from '../../src/memory/EngramChatMemory';
import { captureHumanMemory } from '../../src/memory/AutomaticCapture';
import { compileAutomaticPolicy } from '../../src/extraction/AutomaticEvidence';
import { processExtractionJobs, queueBinding } from '../../src/extraction/DurableExtraction';
import { planAutomaticClaims } from '../../src/extraction/AutomaticClaims';
import { ExtractionDiagnostics } from '../../src/extraction/ExtractionDiagnostics';
import { jobs } from '../../src/extraction/QueueState';

jest.setTimeout(30000);

for (const backend of ['embedded', 'neo4j'] as const) {
  const suite = backend === 'neo4j' && !process.env.NEO4J_TEST_URI ? describe.skip : describe;
  suite(`${backend} automatic-memory preservation and durable ownership`, () => {
    let storage: IGraphStorage, directory: string, fields: EngramChatMemoryInput;
    let bindingId: string;
    const group = `automatic-conformance-${randomUUID()}`;
    const llm = {
      apiKey: 'synthetic-only',
      baseUrl: 'https://provider.invalid/v1',
      model: 'unused',
    };
    const automaticPolicy = compileAutomaticPolicy({ profileId: 'conservative' });
    function create(): IGraphStorage {
      return backend === 'embedded'
        ? new GraphologyStorage(join(directory, 'store.json'))
        : new Neo4jStorage(
            process.env.NEO4J_TEST_URI!,
            'neo4j',
            process.env.NEO4J_TEST_PASSWORD ?? 'password',
          );
    }
    beforeEach(async () => {
      directory = mkdtempSync(join(tmpdir(), 'engram-automatic-'));
      storage = create();
      await storage.initialize();
      const now = new Date().toISOString();
      const subject = await storage.addEntity({
        group_id: group,
        name: 'Synthetic subject',
        entity_type: 'person',
        attributes: {
          engram_extraction: {
            version: 2,
            source: 'manual',
            confidence: null,
            review_status: 'accepted',
            threshold_decision: 'manually_reviewed',
            extracted_at: now,
            episode_uuids: [],
            reviewed_at: now,
            reviewed_by: 'test-operator',
          },
        },
      });
      const binding = await storage.automaticBindingCommand!({
        action: 'create',
        namespace: group,
        issuer: 'test-app',
        actorReference: 'synthetic-actor',
        subjectId: subject.uuid,
        authorizedBy: 'test-operator',
        reason: 'synthetic verified application identity',
      });
      bindingId = binding.bindingId;
      fields = {
        storage,
        groupId: group,
        enableExtraction: true,
        llmConfig: llm,
        extractAi: false,
        extractSystemTool: false,
        extractionPolicy: { mode: 'bounded', quality: 'durableTemporal' },
        policy: { finalTurnWrites: true, storeToolAudit: true, historyFilter: 'provenance' },
        automaticMemory: {
          profileId: 'conservative',
          actor: { namespace: group, issuer: 'test-app', actorReference: 'synthetic-actor' },
          turnId: 'event-1',
          storeIdentity: 'a'.repeat(64),
        },
      };
      jest.spyOn(global, 'fetch').mockRejectedValue(new Error('No provider requests permitted'));
    });
    afterEach(async () => {
      jest.restoreAllMocks();
      await storage.clearGroup(group, { allowQueued: true });
      await storage.close();
      rmSync(directory, { recursive: true, force: true });
    });
    it('preserves original records, serializes duplicate captures, and rejects changed ownership', async () => {
      const oldEpisode = await storage.addEpisode({
        group_id: group,
        content: 'Historical synthetic conversation',
        role: 'human',
        reference_time: new Date().toISOString(),
      });
      const before = await storage.exportGraph(group);
      const results = await Promise.all([
        captureHumanMemory(fields, 'I prefer concise explanations.'),
        captureHumanMemory(fields, 'I prefer concise explanations.'),
      ]);
      expect(new Set(results.map((result) => result.sourceId)).size).toBe(1);
      const graph = await storage.exportGraph(group);
      expect(graph.episodes.filter((ep) => ep.role === 'human')).toHaveLength(2);
      expect(graph.edges).toHaveLength(1);
      expect(await storage.getEpisode(oldEpisode.uuid)).toEqual(before.episodes[0]);
      expect(await storage.getEntity(before.entities[0].uuid)).toEqual(before.entities[0]);
      await expect(
        captureHumanMemory(
          {
            ...fields,
            automaticMemory: { ...fields.automaticMemory!, storeIdentity: 'b'.repeat(64) },
          },
          'I prefer concise explanations.',
        ),
      ).rejects.toThrow();
      expect(global.fetch).not.toHaveBeenCalled();
    });
    it('recovers a durable captured job after reopening without duplicate facts or provider calls', async () => {
      const capture = await captureHumanMemory(
        { ...fields, extractionExecution: 'durable', extractionRouteId: 'synthetic-route' },
        'I prefer bullet points.',
      );
      expect(capture.acknowledgement).toBe('queued');
      expect((await storage.exportGraph(group)).edges).toHaveLength(0);
      await storage.close();
      storage = create();
      await storage.initialize();
      const config = {
        llm,
        policy: fields.extractionPolicy,
        types: ['person', 'organization', 'location', 'concept', 'event'],
        automaticPolicy,
      };
      expect(queueBinding('synthetic-route', config).config_hash).toMatch(/^[a-f0-9]{64}$/);
      const processed = await processExtractionJobs(storage, group, 'synthetic-route', config);
      expect(processed[0]?.state).toBe('completed');
      expect(processed[0]?.outcome?.automatic).toMatchObject({
        persisted: true,
        items: [{ state: 'accepted', persisted: true, mutation: 'created' }],
      });
      expect(await processExtractionJobs(storage, group, 'synthetic-route', config)).toEqual([]);
      const graph = await storage.readExtractionSnapshot!(group);
      expect(graph.edges).toHaveLength(1);
      expect(jobs(graph)[0].outcome?.automatic?.persisted).toBe(true);
      expect(global.fetch).not.toHaveBeenCalled();
    });
    it('rechecks revoked ownership at atomic apply and leaves the graph unchanged', async () => {
      await captureHumanMemory(
        { ...fields, extractionExecution: 'durable', extractionRouteId: 'synthetic-route' },
        'I prefer plain text.',
      );
      const graph = await storage.readExtractionSnapshot!(group);
      const source = graph.episodes.find((ep) => ep.role === 'human')!;
      const plan = planAutomaticClaims(
        graph,
        group,
        [source.uuid],
        automaticPolicy,
        new ExtractionDiagnostics().finish(),
      );
      await storage.automaticBindingCommand!({
        action: 'revoke',
        namespace: group,
        bindingId,
        expectedRevision: 1,
        authorizedBy: 'test-operator',
        reason: 'test withdrawal',
      });
      await expect(storage.applyStagedExtraction!(plan)).rejects.toThrow();
      expect((await storage.exportGraph(group)).edges).toHaveLength(0);
      expect((await storage.exportGraph(group)).episodes.map((ep) => ep.uuid)).toContain(
        source.uuid,
      );
    });
    it('caps bidirectional high-degree edge hydration at the requested sentinel limit', async () => {
      jest.setTimeout(120000);
      const source = await storage.addEntity({
        group_id: group,
        name: 'High-degree source',
        entity_type: 'person',
      });
      const target = await storage.addEntity({
        group_id: group,
        name: 'High-degree target',
        entity_type: 'person',
      });
      for (let index = 0; index < 300; index++) {
        const forward = index % 2 === 0;
        await storage.addEdge({
          group_id: group,
          source_node_uuid: forward ? source.uuid : target.uuid,
          target_node_uuid: forward ? target.uuid : source.uuid,
          name: 'RELATED',
          fact: `Synthetic edge ${index}`,
        });
      }
      const complete = await storage.getEdgesBetween(source.uuid, target.uuid);
      expect(complete).toHaveLength(300);
      expect(new Set(complete.map((edge) => edge.source_node_uuid))).toEqual(
        new Set([source.uuid, target.uuid]),
      );
      expect(await storage.getEdgesBetween(source.uuid, target.uuid, 129)).toHaveLength(129);
    });
  });
}
