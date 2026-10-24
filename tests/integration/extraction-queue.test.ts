import { mkdtemp, rm, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { GraphologyStorage } from '../../src/storage/GraphologyStorage';
import { Neo4jStorage } from '../../src/storage/Neo4jStorage';
import type { IGraphStorage } from '../../src/storage/IGraphStorage';
import {
  EntityEdgeSchema,
  QueueLimitsSchema,
  type ExtractionJob,
  type StagedExtraction,
} from '../../src/schemas';
import { ExtractionDiagnostics } from '../../src/extraction/ExtractionDiagnostics';
import {
  QUEUE_ATTRIBUTE,
  graphFingerprint,
  sourceFingerprint,
  exportQueueBackup,
  fingerprint,
} from '../../src/extraction/QueueState';
import { StagedGraph } from '../../src/extraction/StagedGraph';

const binding = { route_id: 'local', config_hash: 'a'.repeat(64) };
const limits = QueueLimitsSchema.parse({});
function suite(name: string, create: (path: string) => IGraphStorage) {
  describe(name, () => {
    let storage: IGraphStorage, directory: string, group: string;
    beforeEach(async () => {
      directory = await mkdtemp(join(tmpdir(), 'engram-queue-'));
      group = `queue-${randomUUID()}`;
      storage = create(join(directory, 'memory.json'));
      await storage.initialize();
    });
    afterEach(async () => {
      await storage.clearGroup(group, { allowQueued: true });
      await storage.close();
      await rm(directory, { recursive: true, force: true });
    });
    const inputs = (group: string, key = 'turn') => [
      {
        group_id: group,
        content: 'Alder likes cobalt.',
        trust_level: 'standard' as const,
        review_status: 'accepted' as const,
        role: 'human' as const,
        episode_kind: 'active_human' as const,
        idempotency_key: `${key}:human`,
        reference_time: '2026-10-24T12:00:00Z',
      },
      {
        group_id: group,
        content: 'Noted.',
        role: 'ai' as const,
        episode_kind: 'assistant_reply' as const,
        idempotency_key: `${key}:ai`,
        reference_time: '2026-10-24T12:00:00Z',
      },
    ];
    async function claim(): Promise<ExtractionJob> {
      return (await storage.extractionQueueCommand!({ action: 'claim', group_id: group, binding }))
        .job!;
    }
    const command = (job: ExtractionJob) => ({
      group_id: job.group_id,
      job_uuid: job.uuid,
      token: job.lease_token!,
      generation: job.generation,
    });
    async function plan(): Promise<StagedExtraction> {
      const snap = await storage.readExtractionSnapshot!(group);
      const view = new StagedGraph(
        snap,
        group,
        true,
        snap.episodes.map((ep) => ep.uuid),
      );
      await view.storage.addEntity({
        name: 'Alder',
        group_id: group,
        entity_type: 'person',
        summary: '',
        attributes: {
          engram_memory_quality: {
            version: 1,
            category: 'durable_fact',
            policy: 'durableTemporal',
            evidence: [
              {
                source_id: snap.episodes.find((ep) => ep.role === 'human')!.uuid,
                start: 0,
                end: snap.episodes.find((ep) => ep.role === 'human')!.content.length,
              },
            ],
            temporal: { status: 'none', source_times: [], timezone: null },
          },
          engram_extraction: {
            version: 2,
            source: 'llm',
            confidence: 1,
            review_status: 'accepted',
            threshold_decision: 'auto_accepted',
            extracted_at: new Date().toISOString(),
            episode_uuids: snap.episodes.filter((ep) => ep.role === 'human').map((ep) => ep.uuid),
          },
        },
      });
      return view.plan(new ExtractionDiagnostics().finish());
    }

    it('atomically enqueues, preserves conversation UUID/chain/timestamps and returns replay ownership', async () => {
      const first = await storage.appendEpisodesWithExtraction!(
        inputs(group),
        [0, 1],
        binding,
        limits,
      );
      const before = await storage.listEpisodes(group, { sort_order: 'asc' });
      const again = await storage.appendEpisodesWithExtraction!(
        inputs(group),
        [0, 1],
        binding,
        limits,
      );
      expect(first.jobs).toHaveLength(1);
      expect(again.jobs[0].uuid).toBe(first.jobs[0].uuid);
      expect(again.results.every((r) => !r.created)).toBe(true);
      expect(await storage.listEpisodes(group, { sort_order: 'asc' })).toEqual(before);
      expect(before[1].previous_episode_uuid).toBe(before[0].uuid);
    });

    it('allocates only the new source on mixed replay without backfilling existing synchronous history', async () => {
      const first = await storage.appendEpisodesWithExtraction!(
        inputs(group),
        [0, 1],
        binding,
        limits,
      );
      const mixed = inputs(group);
      mixed[1].idempotency_key = 'next-ai';
      const result = await storage.appendEpisodesWithExtraction!(mixed, [0, 1], binding, limits);
      expect(result.jobs).toHaveLength(2);
      expect(result.jobs.find((j) => j.uuid !== first.jobs[0].uuid)!.sources).toHaveLength(1);
      const old = inputs(group, 'sync');
      await storage.appendEpisodes(old);
      const replay = await storage.appendEpisodesWithExtraction!(old, [0, 1], binding, limits);
      expect(replay.jobs).toEqual([]);
    });

    it('rejects capacity atomically without partial new episodes', async () => {
      await storage.appendEpisodesWithExtraction!(inputs(group), [0, 1], binding, {
        ...limits,
        max_jobs: 1,
      });
      const before = await storage.listEpisodes(group);
      await expect(
        storage.appendEpisodesWithExtraction!(inputs(group, 'second'), [0, 1], binding, {
          ...limits,
          max_jobs: 1,
        }),
      ).rejects.toThrow('capacity');
      expect(await storage.listEpisodes(group)).toEqual(before);
    });

    it('only one competing worker can lease; unrelated worker binding cannot claim', async () => {
      await storage.appendEpisodesWithExtraction!(inputs(group), [0, 1], binding, limits);
      expect(
        (
          await storage.extractionQueueCommand!({
            action: 'claim',
            group_id: group,
            binding: { ...binding, route_id: 'other' },
          })
        ).job,
      ).toBeNull();
      const results = await Promise.all([claim(), claim()]);
      expect(results.filter(Boolean)).toHaveLength(1);
      const job = results.find(Boolean)!;
      const prior = (await storage.getEpisodes(job.sources.map((s) => s.uuid))).map((ep) => ({
        uuid: ep.uuid,
        created_at: ep.created_at,
        updated_at: ep.updated_at,
        reference_time: ep.reference_time,
        fingerprint: sourceFingerprint(ep),
      }));
      await storage.extractionQueueCommand!({ action: 'renew', ...command(job) });
      const after = (await storage.getEpisodes(job.sources.map((s) => s.uuid))).map((ep) => ({
        uuid: ep.uuid,
        created_at: ep.created_at,
        updated_at: ep.updated_at,
        reference_time: ep.reference_time,
        fingerprint: sourceFingerprint(ep),
      }));
      expect(after).toEqual(prior);
    });

    it('stages with no graph writes then atomically applies and deduplicates lost acknowledgement retry', async () => {
      await storage.appendEpisodesWithExtraction!(inputs(group), [0, 1], binding, limits);
      const job = await claim();
      const staged = await plan();
      await storage.extractionQueueCommand!({ action: 'stage', ...command(job), plan: staged });
      expect(await storage.listEntities(group)).toEqual([]);
      const result = await storage.extractionQueueCommand!({ action: 'commit', ...command(job) });
      expect(result.job!.state).toBe('completed');
      const again = await storage.extractionQueueCommand!({ action: 'commit', ...command(job) });
      expect(again.job!.state).toBe('completed');
      expect((await storage.listEntities(group)).map((e) => e.uuid)).toEqual(
        staged.entities.map((e) => e.uuid),
      );
    });

    it.each([
      'The claim that Alder likes cobalt is incorrect.',
      'If Alder likes cobalt, offer a gift.',
      'Opinions about Alder likes cobalt remain disputed.',
    ])(
      'rejects an accepted affirmative fact staged from qualified evidence: %s',
      async (content) => {
        const records = inputs(group);
        records[0].content = content;
        await storage.appendEpisodesWithExtraction!(records, [0, 1], binding, limits);
        const job = await claim(),
          staged = await plan();
        const person = staged.entities[0];
        const color = { ...structuredClone(person), uuid: randomUUID(), name: 'Cobalt' };
        staged.entities.push(color);
        staged.edges.push(
          EntityEdgeSchema.parse({
            uuid: randomUUID(),
            group_id: group,
            source_node_uuid: person.uuid,
            target_node_uuid: color.uuid,
            name: 'LIKES',
            fact: 'Alder likes cobalt',
            episodes: [job.sources[0].uuid],
            attributes: structuredClone(person.attributes),
            created_at: person.created_at,
            updated_at: person.updated_at,
          }),
        );
        await storage.extractionQueueCommand!({ action: 'stage', ...command(job), plan: staged });
        await expect(
          storage.extractionQueueCommand!({ action: 'commit', ...command(job) }),
        ).rejects.toThrow(/invalid_accepted_evidence|unsupported_claim/);
        expect(await storage.listEntities(group)).toEqual([]);
        expect((await storage.readExtractionSnapshot!(group)).edges).toEqual([]);
      },
    );
    it('rejects stale graph/reviewer changes without partial application or completed marker', async () => {
      await storage.appendEpisodesWithExtraction!(inputs(group), [0, 1], binding, limits);
      const job = await claim();
      const staged = await plan();
      await storage.extractionQueueCommand!({ action: 'stage', ...command(job), plan: staged });
      const concurrent = await storage.addEntity({
        group_id: group,
        name: 'Reviewer change',
        attributes: { manual: true },
      });
      await expect(
        storage.extractionQueueCommand!({ action: 'commit', ...command(job) }),
      ).rejects.toThrow('graph_changed');
      expect((await storage.listEntities(group)).map((e) => e.uuid)).toEqual([concurrent.uuid]);
      const snapshot = await storage.readExtractionSnapshot!(group);
      expect(
        (
          snapshot.episodes.find((ep) => ep.uuid === job.sources[0].uuid)!.attributes[
            QUEUE_ATTRIBUTE
          ] as any
        ).job.state,
      ).toBe('staged');
    });

    it('blocks generic source edit/delete/import/retention from erasing ownership', async () => {
      const saved = await storage.appendEpisodesWithExtraction!(
        inputs(group),
        [0, 1],
        binding,
        limits,
      );
      const ep = saved.results[0].episode;
      await expect(storage.updateEpisode(ep.uuid, { attributes: {} })).rejects.toThrow(
        'protected_source',
      );
      await expect(storage.deleteEpisode(ep.uuid)).rejects.toThrow('protected_source');
      await expect(storage.importGraph(await storage.exportGraph(group))).rejects.toThrow(
        'protected_source',
      );
      await expect(
        storage.applyRetention(group, { type: 'max_episodes', value: 1 }),
      ).rejects.toThrow('protected_source');
    });

    it('refreshes a long-lived reader from separate backend instance without an intervening producer write', async () => {
      await storage.appendEpisodesWithExtraction!(inputs(group), [0, 1], binding, limits);
      const separate = create(join(directory, 'memory.json'));
      await separate.initialize();
      try {
        const job = (
          await separate.extractionQueueCommand!({ action: 'claim', group_id: group, binding })
        ).job!;
        const staged = await plan();
        await separate.extractionQueueCommand!({ action: 'stage', ...command(job), plan: staged });
        await separate.extractionQueueCommand!({ action: 'commit', ...command(job) });
        const captured = await storage.readExtractionSnapshot!(group);
        expect(captured.entities.map((e) => e.name)).toEqual(['Alder']);
        expect(graphFingerprint(captured, group)).not.toBe(staged.graph_hash);
      } finally {
        await separate.close();
      }
    });

    it('rejects cross-kind UUID collisions without losing the source or queued owner', async () => {
      const saved = await storage.appendEpisodesWithExtraction!(
        inputs(group),
        [0, 1],
        binding,
        limits,
      );
      const job = await claim();
      const staged = await plan();
      staged.entities[0].uuid = saved.results[0].episode.uuid;
      await storage.extractionQueueCommand!({ action: 'stage', ...command(job), plan: staged });
      await expect(
        storage.extractionQueueCommand!({ action: 'commit', ...command(job) }),
      ).rejects.toThrow('cross_kind_id');
      expect(await storage.getEpisode(saved.results[0].episode.uuid)).not.toBeNull();
      expect(await storage.listEntities(group)).toEqual([]);
    });

    it('guards direct apply against source edits and namespace clear/import lifetime changes', async () => {
      const saved = await storage.appendEpisodes(inputs(group));
      const snapshot = await storage.readExtractionSnapshot!(group);
      const view = new StagedGraph(
        snapshot,
        group,
        true,
        saved.map((item) => item.episode.uuid),
      );
      await view.storage.addEntity({ group_id: group, name: 'New' });
      const staged = view.plan(new ExtractionDiagnostics().finish());
      await storage.updateEpisode(saved[0].episode.uuid, { content: 'Changed' });
      await expect(storage.applyStagedExtraction!(staged)).rejects.toThrow('source_changed');
      await storage.clearGroup(group, { allowQueued: true });
      await storage.importGraph(snapshot);
      await expect(storage.applyStagedExtraction!(staged)).rejects.toThrow('graph_changed');
      expect(await storage.listEntities(group)).toEqual([]);
    });

    it('pins normalized legacy manual review and immutable edge endpoints', async () => {
      const a = await storage.addEntity({
        group_id: group,
        name: 'A',
        attributes: {
          engram_extraction: {
            version: 1,
            source: 'manual',
            reviewed: true,
            confidence: null,
            extracted_at: new Date().toISOString(),
            episode_uuids: [],
          },
        },
      });
      const b = await storage.addEntity({ group_id: group, name: 'B' });
      const c = await storage.addEntity({ group_id: group, name: 'C' });
      const edge = await storage.addEdge({
        group_id: group,
        source_node_uuid: a.uuid,
        target_node_uuid: b.uuid,
        name: 'LIKES',
        fact: 'A likes B',
      });
      await storage.appendEpisodesWithExtraction!(inputs(group), [0, 1], binding, limits);
      const job = await claim();
      let snapshot = await storage.readExtractionSnapshot!(group),
        view = new StagedGraph(
          snapshot,
          group,
          true,
          job.sources.map((source) => source.uuid),
        );
      await view.storage.updateEntity(a.uuid, { summary: 'Changed automatically' });
      await storage.extractionQueueCommand!({
        action: 'stage',
        ...command(job),
        plan: view.plan(new ExtractionDiagnostics().finish()),
      });
      await expect(
        storage.extractionQueueCommand!({ action: 'commit', ...command(job) }),
      ).rejects.toThrow('pinned_review');
      snapshot = await storage.readExtractionSnapshot!(group);
      view = new StagedGraph(
        snapshot,
        group,
        true,
        job.sources.map((source) => source.uuid),
      );
      await view.storage.updateEdge(edge.uuid, { target_node_uuid: c.uuid });
      await storage.extractionQueueCommand!({
        action: 'stage',
        ...command(job),
        plan: view.plan(new ExtractionDiagnostics().finish()),
      });
      await expect(
        storage.extractionQueueCommand!({ action: 'commit', ...command(job) }),
      ).rejects.toThrow('immutable_identity');
      expect((await storage.getEdge(edge.uuid))!.target_node_uuid).toBe(b.uuid);
    });

    it('controls pending work, fences a cancelled lease, and keeps explicit review history', async () => {
      const saved = await storage.appendEpisodesWithExtraction!(
        inputs(group),
        [0, 1],
        binding,
        limits,
      );
      const id = saved.jobs[0].uuid;
      const control = (operation: 'pause' | 'resume' | 'retry' | 'cancel') =>
        storage.extractionQueueCommand!({
          action: 'control',
          group_id: group,
          job_uuid: id,
          operation,
          binding,
          actor: 'local-test',
          reason: 'Reviewed synthetic decision',
        });
      expect((await control('pause')).job!.state).toBe('paused');
      expect(await claim()).toBeNull();
      await control('resume');
      const job = await claim();
      await control('cancel');
      await expect(
        storage.extractionQueueCommand!({ action: 'renew', ...command(job) }),
      ).rejects.toThrow('stale_lease');
      const status = await storage.extractionQueueCommand!({
        action: 'status',
        group_id: group,
        binding,
      });
      expect(status.pending).toBe(0);
      const ep = await storage.getEpisode(job.sources[0].uuid);
      expect((ep!.attributes[QUEUE_ATTRIBUTE] as any).job.reviews).toHaveLength(3);
    });

    it('exports complete queue state and imports paused; rejects checksum and ID collisions', async () => {
      await storage.appendEpisodesWithExtraction!(inputs(group), [0, 1], binding, limits);
      const snapshot = await storage.readExtractionSnapshot!(group);
      const backup = exportQueueBackup(snapshot);
      await expect(storage.importExtractionBackup!(backup)).rejects.toThrow('import_collision');
      await expect(
        storage.importExtractionBackup!({ ...backup, sha256: 'b'.repeat(64) }),
      ).rejects.toThrow('backup_checksum');
      await storage.clearGroup(group, { allowQueued: true });
      await storage.importExtractionBackup!(backup);
      const restored = await storage.readExtractionSnapshot!(group);
      expect(restored.episodes.map((ep) => ep.uuid).sort()).toEqual(
        snapshot.episodes.map((ep) => ep.uuid).sort(),
      );
      expect(await claim()).toBeNull();
      expect(
        (
          restored.episodes.find((ep) => (ep.attributes[QUEUE_ATTRIBUTE] as any)?.job)!.attributes[
            QUEUE_ATTRIBUTE
          ] as any
        ).job.state,
      ).toBe('paused');
    });
    it('requires reviewed clear and permits a reviewed configuration repair without changing source identities', async () => {
      const saved = await storage.appendEpisodesWithExtraction!(
        inputs(group),
        [0, 1],
        binding,
        limits,
      );
      const before = await storage.readExtractionSnapshot!(group);
      await expect(storage.clearGroup(group)).rejects.toThrow('clear_requires_review');
      const repaired = { ...binding, config_hash: 'c'.repeat(64) };
      const changed = await storage.extractionQueueCommand!({
        action: 'control',
        group_id: group,
        job_uuid: saved.jobs[0].uuid,
        operation: 'rebind',
        binding: repaired,
        actor: 'local-test',
        reason: 'Reviewed provider configuration repair',
      });
      expect(changed.job!.uuid).toBe(saved.jobs[0].uuid);
      expect(changed.job!.sources).toEqual(saved.jobs[0].sources);
      expect(changed.job!.reviews[0]).toMatchObject({
        action: 'rebind',
        previous_config_hash: binding.config_hash,
      });
      expect(await claim()).toBeNull();
      expect(
        (
          await storage.extractionQueueCommand!({
            action: 'claim',
            group_id: group,
            binding: repaired,
          })
        ).job!.uuid,
      ).toBe(saved.jobs[0].uuid);
      const after = await storage.readExtractionSnapshot!(group);
      for (const old of before.episodes) {
        const next = after.episodes.find((ep) => ep.uuid === old.uuid)!;
        expect(sourceFingerprint(next)).toBe(sourceFingerprint(old));
        expect(next.previous_episode_uuid).toBe(old.previous_episode_uuid);
      }
    });

    it('rejects foreign backup scope and missing graph endpoints while retaining dangling legacy provenance', async () => {
      const a = await storage.addEntity({ group_id: group, name: 'A' });
      const b = await storage.addEntity({ group_id: group, name: 'B' });
      const missingSource = randomUUID();
      await storage.addEdge({
        group_id: group,
        source_node_uuid: a.uuid,
        target_node_uuid: b.uuid,
        name: 'LIKES',
        fact: 'A likes B',
        episodes: [missingSource],
      });
      const snapshot = await storage.readExtractionSnapshot!(group);
      const backup = exportQueueBackup(snapshot);
      expect(backup.warnings!.missing_fact_source_references).toBe(1);
      const foreign = structuredClone(snapshot);
      foreign.entities[0].group_id = 'foreign';
      expect(() => exportQueueBackup(foreign)).toThrow('scoped_backup_mismatch');
      const incomplete = structuredClone(snapshot);
      incomplete.entities.pop();
      expect(() => exportQueueBackup(incomplete)).toThrow('incomplete_backup');
      await storage.clearGroup(group);
      await storage.importExtractionBackup!(backup);
      const restored = await storage.readExtractionSnapshot!(group);
      expect(restored.entities).toEqual(snapshot.entities);
      expect(restored.edges).toEqual(snapshot.edges);
    });

    it('rejects relocated owner payloads and inconsistent member hashes before import', async () => {
      await storage.appendEpisodesWithExtraction!(inputs(group), [0, 1], binding, limits);
      const original = await storage.readExtractionSnapshot!(group);
      const relocated = structuredClone(original);
      const first = relocated.episodes.find((ep) => (ep.attributes[QUEUE_ATTRIBUTE] as any)?.job)!;
      const second = relocated.episodes.find((ep) => ep.uuid !== first.uuid)!;
      (second.attributes[QUEUE_ATTRIBUTE] as any).job = (
        first.attributes[QUEUE_ATTRIBUTE] as any
      ).job;
      delete (first.attributes[QUEUE_ATTRIBUTE] as any).job;
      await expect(
        storage.importExtractionBackup!({
          format: 'engram-extraction-backup',
          version: 1,
          graph: relocated,
          sha256: fingerprint(relocated),
        }),
      ).rejects.toThrow('invalid_owner');
      const mismatch = structuredClone(original);
      const member = mismatch.episodes.find((ep) => !(ep.attributes[QUEUE_ATTRIBUTE] as any)?.job)!;
      (member.attributes[QUEUE_ATTRIBUTE] as any).source_hash = 'b'.repeat(64);
      await expect(
        storage.importExtractionBackup!({
          format: 'engram-extraction-backup',
          version: 1,
          graph: mismatch,
          sha256: fingerprint(mismatch),
        }),
      ).rejects.toThrow('incomplete_backup');
      expect((await storage.readExtractionSnapshot!(group)).episodes).toEqual(original.episodes);
    });
    it('rejects a backup with new record UUIDs but conflicting logical episode keys', async () => {
      await storage.appendEpisodes(inputs(group));
      const data = structuredClone(await storage.readExtractionSnapshot!(group));
      const ids = new Map(data.episodes.map((ep) => [ep.uuid, randomUUID()]));
      for (const ep of data.episodes) {
        ep.uuid = ids.get(ep.uuid)!;
        if (ep.previous_episode_uuid) ep.previous_episode_uuid = ids.get(ep.previous_episode_uuid)!;
      }
      const backup = exportQueueBackup(data);
      expect(backup.sha256).toBe(fingerprint(data));
      await expect(storage.importExtractionBackup!(backup)).rejects.toThrow(
        'import_logical_collision',
      );
      expect((await storage.listEpisodes(group)).map((ep) => ep.uuid).sort()).not.toEqual(
        data.episodes.map((ep) => ep.uuid).sort(),
      );
    });

    it('never delegates an unknown staged operation or mutates the original snapshot', async () => {
      const snapshot = await storage.readExtractionSnapshot!(group);
      const before = JSON.stringify(snapshot);
      const view = new StagedGraph(snapshot, group);
      await expect(view.storage.clearAll()).rejects.toThrow('unsupported_snapshot_operation');
      await view.storage.addEntity({ group_id: group, name: 'Staged' });
      expect(JSON.stringify(snapshot)).toBe(before);
    });
    it('keeps equal-timestamp conversation chains ordered when snapshot arrays are shuffled', async () => {
      await storage.appendEpisodes(inputs(group));
      const snapshot = await storage.readExtractionSnapshot!(group);
      for (const ep of snapshot.episodes) ep.created_at = snapshot.exported_at;
      snapshot.episodes.reverse();
      const view = new StagedGraph(snapshot, group, false);
      expect((await view.storage.getRecentEpisodes(group, 2)).map((ep) => ep.role)).toEqual([
        'human',
        'ai',
      ]);
    });
  });
}
suite('durable embedded extraction', (path) => new GraphologyStorage(path));
if (process.env.NEO4J_TEST_URI)
  suite(
    'durable Neo4j extraction',
    () =>
      new Neo4jStorage(
        process.env.NEO4J_TEST_URI!,
        'neo4j',
        process.env.NEO4J_TEST_PASSWORD ?? 'engram-local-test',
      ),
  );

if (process.env.NEO4J_TEST_URI)
  describe('Neo4j managed transaction acknowledgement replay', () => {
    it('replays a committed callback with identical allocated source and job identities', async () => {
      const storage = new Neo4jStorage(
        process.env.NEO4J_TEST_URI!,
        'neo4j',
        process.env.NEO4J_TEST_PASSWORD ?? 'engram-local-test',
      );
      const group = `tx-replay-${randomUUID()}`;
      await storage.initialize();
      const getSession = (storage as any).getSession.bind(storage);
      const sessionSpy = jest.spyOn(storage as any, 'getSession').mockImplementation(() => {
        const session = getSession();
        const write = session.executeWrite.bind(session);
        session.executeWrite = async (callback: any) => {
          await write(callback);
          return write(callback);
        };
        return session;
      });
      try {
        const saved = await storage.appendEpisodesWithExtraction(
          [
            {
              group_id: group,
              role: 'human',
              episode_kind: 'active_human',
              content: 'Alder likes cobalt.',
              reference_time: '2026-10-24T12:00:00Z',
            },
          ],
          [0],
          binding,
          limits,
        );
        sessionSpy.mockRestore();
        const snapshot = await storage.readExtractionSnapshot(group);
        expect(snapshot.episodes).toHaveLength(1);
        expect(snapshot.episodes[0].uuid).toBe(saved.results[0].episode.uuid);
        expect((snapshot.episodes[0].attributes[QUEUE_ATTRIBUTE] as any).job.uuid).toBe(
          saved.jobs[0].uuid,
        );
        const warning = jest.spyOn(console, 'warn').mockImplementation();
        await storage.addEntity({ group_id: group, name: 'Vector test', name_embedding: [1, 0] });
        expect(warning).not.toHaveBeenCalled();
        warning.mockRestore();
      } finally {
        sessionSpy.mockRestore();
        await storage.clearGroup(group, { allowQueued: true });
        await storage.close();
      }
    });
  });
