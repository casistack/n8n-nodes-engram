import * as fs from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { makeCompositionalCaptureFixture } from '../helpers/compositionalCaptureFixture';
import { GraphologyStorage } from '../../src/storage/GraphologyStorage';
import { embeddedAutomaticCaptureStoreHash } from '../../src/storage/AutomaticCaptureStore';
import { EngramChatMemory } from '../../src/memory/EngramChatMemory';
import { EntityNodeSchema, EntityEdgeSchema } from '../../src/schemas';
import { randomUUID } from 'crypto';
import { buildCompositionalHumanCaptureSourceV3 } from '../../src/storage/CompositionalAutomaticCaptureSourceV3';
import {
  assertAutomaticLedgerSourceIntegrity,
  assertOwnedEpisodeReplay,
} from '../../src/storage/AutomaticIdentity';

describe('embedded compositional source and root registration preservation', () => {
  let directory: string;
  let storage: GraphologyStorage | undefined;
  const file = () => join(directory, 'store.json');
  const fixture = () =>
    makeCompositionalCaptureFixture(undefined, embeddedAutomaticCaptureStoreHash(file())!);
  beforeEach(() => {
    directory = fs.mkdtempSync(join(tmpdir(), 'engram-v3-registration-'));
  });
  afterEach(async () => {
    await storage?.close();
    storage = undefined;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const open = async (graph: ReturnType<typeof fixture>['graph']) => {
    fs.writeFileSync(file(), JSON.stringify(graph));
    storage = new GraphologyStorage(file());
    await storage.initialize();
    return storage;
  };

  it.each(['source_content', 'original_execution', 'mixed_owner'])(
    'does not admit altered captured ownership: %s',
    async (kind) => {
      const f = fixture();
      if (kind === 'source_content') {
        const changed = buildCompositionalHumanCaptureSourceV3(
          { ...f.graph, episodes: [] },
          {
            ...f.input,
            request: {
              ...f.input.request,
              source: { ...f.input.request.source, content: 'I prefer detailed explanations.' },
            },
          },
        );
        f.graph.episodes = [structuredClone(changed.episode)];
      } else if (kind === 'original_execution') {
        f.source.source_execution_id = 'changed-original-producer';
      } else {
        f.source.attributes.engram_write_owner_v1 = {};
      }
      f.graph.automatic_operations_v1 = { version: 1, operations: [f.operation] };
      const before = JSON.stringify(f.graph);
      fs.writeFileSync(file(), before);
      storage = new GraphologyStorage(file());
      await expect(storage.initialize()).rejects.toThrow(
        /invalid_source_owner|mixed_source_versions/,
      );
      expect(fs.readFileSync(file(), 'utf8')).toBe(before);
    },
  );

  it.each(['legacy', 'current', 'historical'] as const)(
    'old %s readers hide new-family claims instead of using generic fallback',
    async (retrievalMode) => {
      const f = fixture();
      f.graph.automatic_operations_v1 = { version: 1, operations: [f.operation] };
      const value = EntityNodeSchema.parse({
        uuid: randomUUID(),
        group_id: f.source.group_id,
        name: 'Synthetic rich value',
        entity_type: 'preference_value',
        created_at: f.graph.exported_at,
        updated_at: f.graph.exported_at,
        attributes: { engram_literal_v1: { version: 2 } },
      });
      f.graph.entities.push(value);
      f.graph.edges.push(
        EntityEdgeSchema.parse({
          uuid: randomUUID(),
          group_id: f.source.group_id,
          source_node_uuid: f.graph.entities[0].uuid,
          target_node_uuid: value.uuid,
          name: 'PREFERS',
          fact: 'RICH_UNCOMMITTED_SENTINEL',
          episodes: [f.source.uuid],
          created_at: f.graph.exported_at,
          updated_at: f.graph.exported_at,
          attributes: {
            engram_claim_v1: { version: 2, sourceId: f.source.uuid },
            engram_extraction: {
              version: 2,
              source: 'manual',
              confidence: 1,
              review_status: 'accepted',
              threshold_decision: 'manually_reviewed',
              extracted_at: f.graph.exported_at,
              episode_uuids: [f.source.uuid],
              reviewed_at: f.graph.exported_at,
              reviewed_by: 'synthetic-operator',
            },
          },
        }),
      );
      const store = await open(f.graph);
      const before = fs.readFileSync(file(), 'utf8');
      const memory = new EngramChatMemory({
        storage: store,
        groupId: f.source.group_id,
        enableExtraction: false,
        retrievalMode,
        minRelevanceScore: 0,
        returnMessages: true,
      });
      const loaded = await memory.loadMemoryVariablesWithDiagnostics({
        input: 'RICH_UNCOMMITTED_SENTINEL',
      });
      expect(loaded.diagnostics.retrieval.fact_messages).toBe(0);
      expect(fs.readFileSync(file(), 'utf8')).toBe(before);
    },
  );

  it.each([false, true])(
    'preserves source and original records across ordinary write and reopen, ledger=%s',
    async (withLedger) => {
      const f = fixture();
      if (withLedger) f.graph.automatic_operations_v1 = { version: 1, operations: [f.operation] };
      assertAutomaticLedgerSourceIntegrity(f.graph);
      const store = await open(f.graph);
      expect(await store.getEpisode(f.source.uuid)).toEqual(f.source);
      await store.addEntity({
        group_id: f.source.group_id,
        name: 'Unrelated new entity',
        entity_type: 'concept',
      });
      await store.close();
      storage = new GraphologyStorage(file());
      await storage.initialize();
      const after = await storage.readExtractionSnapshot();
      for (const row of f.graph.entities)
        expect(after.entities.find((item) => item.uuid === row.uuid)).toEqual(row);
      expect(after.episodes).toEqual(f.graph.episodes);
      expect(after.edges).toEqual(f.graph.edges);
      expect(after.automatic_operations_v1).toEqual(f.graph.automatic_operations_v1);
      expect(fs.readFileSync(file(), 'utf8')).not.toContain('\n  "');
    },
  );

  it('does not recreate a disappeared source-only store on an unrelated write', async () => {
    const f = fixture();
    const store = await open(f.graph);
    fs.unlinkSync(file());
    await expect(
      store.addEntity({
        group_id: f.source.group_id,
        name: 'Must not append',
        entity_type: 'concept',
      }),
    ).rejects.toThrow('store_missing');
    expect(fs.existsSync(file())).toBe(false);
  });

  it.each([false, true])(
    'rejects record normalization without changing native bytes, ledger=%s',
    async (withLedger) => {
      const f = fixture();
      if (withLedger) f.graph.automatic_operations_v1 = { version: 1, operations: [f.operation] };
      Object.defineProperty(f.source.attributes, '__proto__', {
        enumerable: true,
        value: { synthetic: true },
      });
      const before = JSON.stringify(f.graph);
      fs.writeFileSync(file(), before);
      storage = new GraphologyStorage(file());
      await expect(storage.initialize()).rejects.toThrow(
        /record_normalization|invalid_source_tuple/,
      );
      expect(fs.readFileSync(file(), 'utf8')).toBe(before);
    },
  );

  it('rejects generic creation/import of privileged V3 source data and protects original producer execution', async () => {
    const f = fixture();
    const store = await open(f.graph);
    const before = fs.readFileSync(file(), 'utf8');
    await expect(store.appendAutomaticEpisodes([f.source])).rejects.toThrow(
      'trusted_capture_writer_required',
    );
    await expect(store.importGraph(f.graph)).rejects.toThrow(
      /owned_source_import_forbidden|binding_restore_unsupported/,
    );
    expect(() =>
      assertOwnedEpisodeReplay(f.source, {
        ...f.source,
        source_execution_id: 'different-original-producer',
      }),
    ).toThrow('owned_source_mismatch');
    expect(fs.readFileSync(file(), 'utf8')).toBe(before);
  });

  it.each([false, true])(
    'V2 controls decline the new family without auditing or rewriting, ledger=%s',
    async (withLedger) => {
      const f = fixture();
      if (withLedger) f.graph.automatic_operations_v1 = { version: 1, operations: [f.operation] };
      const store = await open(f.graph);
      const before = fs.readFileSync(file(), 'utf8');
      const { preferenceInterpreter: _interpreter, ...common } = f.input.request;
      const request = { ...common, version: 2 as const };
      const locator = {
        version: 2 as const,
        namespace: request.namespace,
        issuer: request.issuer,
        actorReference: request.actorReference,
        turn: request.turn,
        role: 'human' as const,
      };
      const fence = { ...locator, expectedGeneration: 1, attemptIdHash: 'd'.repeat(64) };
      expect(await store.beginAndClaimAutomaticCaptureV2(request)).toMatchObject({
        kind: 'unsupported_mode',
      });
      expect(await store.resumeAutomaticCaptureV2(fence)).toEqual({ kind: 'unsupported_mode' });
      expect(await store.cancelAutomaticCaptureV2(fence)).toMatchObject({
        kind: 'unsupported_mode',
        eligibleFirstCommit: false,
      });
      expect(await store.getAutomaticCaptureOutcomeV2(locator)).toMatchObject({
        status: 'unsupported_mode',
        should_process: false,
        sourceId: null,
      });
      expect(fs.readFileSync(file(), 'utf8')).toBe(before);
    },
  );
});
