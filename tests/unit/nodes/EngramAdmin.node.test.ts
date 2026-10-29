import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { EngramAdmin } from '../../../src/nodes/EngramAdmin/EngramAdmin.node';
import { createStorage } from '../../../src/storage/StorageFactory';
import * as storageFactory from '../../../src/storage/StorageFactory';
import { GraphologyStorage } from '../../../src/storage/GraphologyStorage';
import { resolveStoragePath } from '../../../src/utils/helpers';
import { jobs } from '../../../src/extraction/QueueState';

function createExecuteContext(options: {
  tempDir: string;
  operation: string;
  parameters?: Record<string, unknown>;
  executionId?: string | null;
}) {
  const parameters: Record<string, unknown> = {
    backend: 'embedded',
    resource: 'lifecycle',
    operation: options.operation,
    customStoragePath: options.tempDir,
    ...options.parameters,
  };

  return {
    getInputData() {
      return [{ json: {} }];
    },
    getNodeParameter(name: string, itemIndex = 0, fallback?: unknown) {
      void itemIndex;
      return Object.prototype.hasOwnProperty.call(parameters, name) ? parameters[name] : fallback;
    },
    getWorkflow() {
      return { id: 'wf-admin-test' };
    },
    getExecutionId() {
      return options.executionId ?? null;
    },
    async getCredentials() {
      return { apiKey: 'synthetic-only', baseUrl: 'https://provider.invalid/v1' };
    },
    getWorkflowStaticData() {
      return {};
    },
    logger: {
      info: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
    },
    getNode() {
      return { name: 'Engram Admin', typeVersion: 3, parameters };
    },
  } as never;
}

describe('EngramAdmin', () => {
  let tempDir: string;
  let persistPath: string;

  it('closes a new autonomous Neo4j owner when initialization fails and emits only a fixed stopped result', async () => {
    const owner = {
      initialize: jest.fn().mockRejectedValue(new Error('synthetic private backend detail')),
      close: jest.fn().mockResolvedValue(undefined),
    };
    const factory = jest
      .spyOn(storageFactory, 'createStorage')
      .mockReturnValue(owner as unknown as ReturnType<typeof createStorage>);
    try {
      const output = await new EngramAdmin().execute.call(
        createExecuteContext({
          tempDir,
          operation: 'captureHuman',
          parameters: {
            backend: 'neo4j',
            resource: 'automaticMemory',
            automaticCaptureLifecycle: 'replaySafeV2',
            automaticPreferenceInterpreter: 'autonomousPersonalV1',
          },
        }),
      );
      expect(owner.initialize).toHaveBeenCalledTimes(1);
      expect(owner.close).toHaveBeenCalledTimes(1);
      expect(output).toEqual([
        [],
        [
          {
            json: {
              version: 4,
              should_process: false,
              status: 'unconfirmed',
              reason: 'storage_error',
            },
            pairedItem: { item: 0 },
          },
        ],
      ]);
      expect(JSON.stringify(output)).not.toContain('synthetic private backend detail');
    } finally {
      factory.mockRestore();
    }
  });

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-admin-'));
    persistPath = resolveStoragePath({
      customStoragePath: tempDir,
      workflowId: 'wf-admin-test',
    });
  });

  afterEach(async () => {
    const storage = createStorage({
      backend: 'embedded',
      persistPath,
    });
    await storage.initialize();
    await storage.clearAll({ allowQueued: true });
    await storage.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  async function seedAutomaticMemory(groupId: string) {
    const storage = createStorage({ backend: 'embedded', persistPath });
    await storage.initialize();
    const now = new Date().toISOString();
    const subject = await storage.addEntity({
      group_id: groupId,
      name: 'Synthetic verified subject',
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
    await storage.automaticBindingCommand!({
      action: 'create',
      namespace: groupId,
      issuer: 'test-app',
      actorReference: 'synthetic-actor',
      subjectId: subject.uuid,
      authorizedBy: 'test-operator',
      reason: 'synthetic Native Admin test identity',
    });
    await storage.close();
  }

  function nativeCaptureContext(
    groupId: string,
    executionId: string | null,
    automaticInput = 'I prefer concise explanations.',
    extraParameters: Record<string, unknown> = {},
  ) {
    return createExecuteContext({
      tempDir,
      operation: 'captureHuman',
      executionId,
      parameters: {
        backend: 'embedded',
        resource: 'automaticMemory',
        customStoragePath: tempDir,
        automaticWorkflowId: 'wf-admin-test',
        automaticNamespace: groupId,
        automaticMemoryProfile: 'conservative',
        automaticTurn: 'native-admin-turn',
        automaticIssuer: 'test-app',
        automaticActor: 'synthetic-actor',
        automaticIntent: 'disabled',
        automaticWrapper: 'disabled',
        automaticInput,
        automaticExecution: 'synchronous',
        advancedExtractionPolicy: 'bounded',
        knowledgeSelection: 'durableTemporal',
        ...extraParameters,
      },
    });
  }

  async function readAutomaticGraph(groupId: string) {
    const storage = createStorage({ backend: 'embedded', persistPath });
    await storage.initialize();
    const graph = await storage.readExtractionSnapshot!(groupId);
    await storage.close();
    return graph;
  }

  it('blocks Native Admin cross-execution duplicates after exact source validation', async () => {
    const groupId = 'native-admin-legacy-guard';
    await seedAutomaticMemory(groupId);
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockRejectedValue(new Error('Native Admin literal capture must not call a provider'));
    const admin = new EngramAdmin();

    try {
      await expect(admin.execute.call(nativeCaptureContext(groupId, null))).rejects.toThrow(
        'Engram automatic: legacy_cross_execution_duplicate',
      );
      expect(
        (await readAutomaticGraph(groupId)).episodes.filter(
          (episode) => episode.attributes.engram_write_owner_v1,
        ),
      ).toHaveLength(0);

      const first = await admin.execute.call(nativeCaptureContext(groupId, 'execution-first'));
      const firstResult = first[0][0].json;
      expect(firstResult.acknowledgement).toBe('facts_accepted');

      const afterFirst = await readAutomaticGraph(groupId);
      expect(
        afterFirst.episodes.filter((episode) => episode.attributes.engram_write_owner_v1),
      ).toHaveLength(1);
      expect(afterFirst.edges.filter((edge) => edge.attributes.engram_claim_v1)).toHaveLength(1);

      const sameExecutionReplay = await admin.execute.call(
        nativeCaptureContext(groupId, 'execution-first'),
      );
      expect(sameExecutionReplay[0][0].json).toEqual(
        expect.objectContaining({
          sourceId: firstResult.sourceId,
          outcome: expect.objectContaining({ duplicates: 1 }),
        }),
      );

      await expect(
        admin.execute.call(nativeCaptureContext(groupId, 'execution-second')),
      ).rejects.toThrow('Engram automatic: legacy_cross_execution_duplicate');

      let sourceConflict: unknown;
      try {
        await admin.execute.call(
          nativeCaptureContext(groupId, 'execution-first', 'I prefer verbose explanations.'),
        );
      } catch (error) {
        sourceConflict = error;
      }
      expect(sourceConflict).toBeInstanceOf(Error);
      expect((sourceConflict as Error).message).toContain(
        'Engram automatic: legacy_source_conflict',
      );
      expect((sourceConflict as Error).message).not.toContain(String(firstResult.sourceId));
      expect((sourceConflict as Error).message).not.toContain('synthetic-actor');

      await expect(
        admin.execute.call(
          nativeCaptureContext(groupId, 'execution-first', undefined, {
            automaticActor: 'different-actor',
          }),
        ),
      ).rejects.toThrow('Engram automatic: legacy_source_conflict');

      const afterReplays = await readAutomaticGraph(groupId);
      expect(afterReplays.entities).toEqual(afterFirst.entities);
      expect(afterReplays.edges).toEqual(afterFirst.edges);
      expect(afterReplays.episodes).toEqual(afterFirst.episodes);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('lets only the persisted execution win a two-instance Native Admin race', async () => {
    const groupId = 'native-admin-legacy-race';
    await seedAutomaticMemory(groupId);
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockRejectedValue(new Error('Native Admin literal capture must not call a provider'));
    const admin = new EngramAdmin();
    let releaseAppend!: () => void;
    const bothPrepared = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    const instances: GraphologyStorage[] = [];
    let appendArrivals = 0;
    const factorySpy = jest.spyOn(storageFactory, 'createStorage').mockImplementation((config) => {
      if (config.backend !== 'embedded')
        throw new Error('Synthetic race requires embedded storage');
      const instance = new GraphologyStorage(config.persistPath);
      instances.push(instance);
      const append = instance.appendAutomaticEpisodesWithExtraction.bind(instance);
      instance.appendAutomaticEpisodesWithExtraction = async (...args) => {
        // Both independent instances finish their absent-source preflight before
        // either may enter the actual persistent append transaction.
        if (++appendArrivals === 2) releaseAppend();
        await bothPrepared;
        return append(...args);
      };
      return instance;
    });

    try {
      const outcomes = await Promise.allSettled([
        admin.execute.call(
          nativeCaptureContext(groupId, 'race-execution-a', undefined, {
            automaticExecution: 'durable',
            extractionRouteId: 'native-admin-race-route',
            queueModel: 'unused-model',
          }),
        ),
        admin.execute.call(
          nativeCaptureContext(groupId, 'race-execution-b', undefined, {
            automaticExecution: 'durable',
            extractionRouteId: 'native-admin-race-route',
            queueModel: 'unused-model',
          }),
        ),
      ]);
      expect(instances).toHaveLength(2);
      expect(instances[0]).not.toBe(instances[1]);
      expect(appendArrivals).toBe(2);
      const fulfilled = outcomes.filter(
        (outcome): outcome is PromiseFulfilledResult<Awaited<ReturnType<EngramAdmin['execute']>>> =>
          outcome.status === 'fulfilled',
      );
      const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
        message: expect.stringContaining('Engram automatic: legacy_cross_execution_duplicate'),
      });

      const graph = await readAutomaticGraph(groupId);
      const ownedSources = graph.episodes.filter(
        (episode) => episode.attributes.engram_write_owner_v1 !== undefined,
      );
      expect(ownedSources).toHaveLength(1);
      expect(ownedSources[0].source_execution_id).toMatch(/^race-execution-[ab]$/);
      expect(fulfilled[0].value[0][0].json.sourceId).toBe(ownedSources[0].uuid);
      expect(jobs(graph)).toHaveLength(1);
      expect(graph.edges).toHaveLength(0);

      await expect(
        admin.execute.call(
          nativeCaptureContext(groupId, 'race-execution-replay', undefined, {
            automaticExecution: 'durable',
            extractionRouteId: 'native-admin-race-route',
            queueModel: 'unused-model',
          }),
        ),
      ).rejects.toThrow('Engram automatic: legacy_cross_execution_duplicate');
      const afterReplay = await readAutomaticGraph(groupId);
      expect(afterReplay.episodes).toEqual(graph.episodes);
      expect(jobs(afterReplay)).toHaveLength(1);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      factorySpy.mockRestore();
      fetchSpy.mockRestore();
    }
  });

  it('requires confirmation before clearAll executes', async () => {
    const admin = new EngramAdmin();
    const context = createExecuteContext({
      tempDir,
      operation: 'clearAll',
      parameters: {
        confirmDestructive: false,
      },
    });

    await expect(admin.execute.call(context)).rejects.toThrow(
      'Confirm Destructive must be enabled to proceed with Clear All',
    );
  });

  it('previews and confirms bounded episode purges', async () => {
    const storage = createStorage({ backend: 'embedded', persistPath });
    await storage.initialize();
    await storage.appendEpisode({
      group_id: 'cleanup-group',
      content: 'Historical monitor output',
      role: 'system',
      reference_time: '2026-07-15T10:00:00.000Z',
      episode_kind: 'monitor_summary',
      trust_level: 'unverified',
    });
    await storage.appendEpisode({
      group_id: 'cleanup-group',
      content: 'Human message',
      role: 'human',
      reference_time: '2026-07-15T11:00:00.000Z',
      episode_kind: 'active_human',
      trust_level: 'trusted',
    });

    const admin = new EngramAdmin();
    const dryRunContext = createExecuteContext({
      tempDir,
      operation: 'purgeEpisodes',
      parameters: {
        groupId: 'cleanup-group',
        purgeEpisodeKind: 'monitor_summary',
        purgeMode: 'dryRun',
        purgeLimit: 10,
      },
    });

    const preview = await admin.execute.call(dryRunContext);
    expect(preview[0][0].json).toEqual(
      expect.objectContaining({
        operation: 'purgeEpisodes',
        dry_run: true,
        matched_count: 1,
        deleted_count: 0,
      }),
    );
    expect(await storage.getEpisodeCount('cleanup-group')).toBe(2);

    const unconfirmedContext = createExecuteContext({
      tempDir,
      operation: 'purgeEpisodes',
      parameters: {
        groupId: 'cleanup-group',
        purgeEpisodeKind: 'monitor_summary',
        purgeMode: 'delete',
      },
    });
    await expect(admin.execute.call(unconfirmedContext)).rejects.toThrow(
      'Confirm Episode Purge must be set to Confirmed before deleting episodes',
    );

    const deleteContext = createExecuteContext({
      tempDir,
      operation: 'purgeEpisodes',
      parameters: {
        groupId: 'cleanup-group',
        purgeEpisodeKind: 'monitor_summary',
        purgeMode: 'delete',
        confirmEpisodePurge: 'confirmed',
        purgeLimit: 10,
      },
    });
    const deleted = await admin.execute.call(deleteContext);

    expect(deleted[0][0].json).toEqual(
      expect.objectContaining({
        dry_run: false,
        matched_count: 1,
        deleted_count: 1,
      }),
    );
    expect(await storage.getEpisodeCount('cleanup-group')).toBe(1);
  });

  it('previews malformed assistant output and distinctive synthetic content without deleting it', async () => {
    const storage = createStorage({ backend: 'embedded', persistPath });
    await storage.initialize();
    await storage.appendEpisodes([
      {
        group_id: 'hygiene-group',
        content: '[ ]',
        role: 'ai',
        reference_time: '2026-07-15T10:00:00.000Z',
        episode_kind: 'assistant_reply',
      },
      {
        group_id: 'hygiene-group',
        content: 'Return only SYNTHETIC_RESPONSE_MARKER JSON.',
        role: 'human',
        reference_time: '2026-07-15T10:01:00.000Z',
        episode_kind: 'legacy',
      },
      {
        group_id: 'hygiene-group',
        content: 'A valid assistant response',
        role: 'ai',
        reference_time: '2026-07-15T10:02:00.000Z',
        episode_kind: 'assistant_reply',
      },
    ]);

    const admin = new EngramAdmin();
    const emptyAssistantPreview = await admin.execute.call(
      createExecuteContext({
        tempDir,
        operation: 'purgeEpisodes',
        parameters: {
          groupId: 'hygiene-group',
          purgeHygieneRule: 'empty_assistant_output',
          purgeMode: 'dryRun',
          purgeLimit: 10,
        },
      }),
    );
    expect(emptyAssistantPreview[0][0].json).toEqual(
      expect.objectContaining({ dry_run: true, matched_count: 1, deleted_count: 0 }),
    );

    const syntheticContentPreview = await admin.execute.call(
      createExecuteContext({
        tempDir,
        operation: 'purgeEpisodes',
        parameters: {
          groupId: 'hygiene-group',
          purgeContentContains: 'synthetic_response_marker',
          purgeMode: 'dryRun',
          purgeLimit: 10,
        },
      }),
    );
    expect(syntheticContentPreview[0][0].json).toEqual(
      expect.objectContaining({ dry_run: true, matched_count: 1, deleted_count: 0 }),
    );
    expect(await storage.getEpisodeCount('hygiene-group')).toBe(3);
  });

  it('returns quick diagnostics without scanning the full graph by default', async () => {
    const admin = new EngramAdmin();
    const storage = createStorage({
      backend: 'embedded',
      persistPath,
    });
    await storage.initialize();
    await storage.addEntity({
      name: 'Alice',
      group_id: 'diag-group',
      summary: 'A person',
      entity_type: 'person',
    });

    const context = createExecuteContext({
      tempDir,
      operation: 'diagnostics',
      parameters: {
        resource: 'monitoring',
      },
    });

    const result = await admin.execute.call(context);

    expect(result[0][0].json).toEqual(
      expect.objectContaining({
        operation: 'diagnostics',
        status: 'ok',
        storage_backend: 'embedded',
        initialized: true,
        deep_checks: 'disabled',
      }),
    );
    expect(result[0][0].json.quick_checks).toEqual(
      expect.objectContaining({
        group_count: 1,
        entity_count: 1,
        edge_count: 0,
        episode_count: 0,
      }),
    );
    expect(result[0][0].json.embedded_storage).toEqual(
      expect.objectContaining({
        workflow_id: 'wf-admin-test',
        persist_path: persistPath,
        custom_storage_path_configured: true,
        last_mutation: expect.objectContaining({
          operation: 'mutation',
          persistence_enabled: true,
          snapshot_written: true,
          success: true,
        }),
      }),
    );
    expect(result[0][0].json.migration).toEqual(
      expect.objectContaining({
        backend: 'embedded',
        target_version: '2.0',
        migration_required: false,
      }),
    );
  });

  it('reports the verified automatic backup after migrating embedded storage', async () => {
    const timestamp = '2026-06-21T12:00:00.000Z';
    const backupPath = `${persistPath}.pre-schema-2.0.backup.json`;
    fs.mkdirSync(path.dirname(persistPath), { recursive: true });
    fs.writeFileSync(
      persistPath,
      JSON.stringify({
        version: '1.0',
        exported_at: timestamp,
        entities: [],
        edges: [],
        episodes: [
          {
            uuid: '00000000-0000-4000-8000-000000000096',
            group_id: 'legacy-admin',
            content: 'Legacy episode',
            role: 'human',
            reference_time: timestamp,
            created_at: timestamp,
          },
        ],
      }),
      'utf-8',
    );

    const admin = new EngramAdmin();
    const context = createExecuteContext({
      tempDir,
      operation: 'diagnostics',
      parameters: { resource: 'monitoring' },
    });
    const result = await admin.execute.call(context);

    expect(result[0][0].json.migration).toEqual(
      expect.objectContaining({
        source_version: '1.0',
        automatic_migration_completed: true,
        legacy_episode_count: 1,
        backup: {
          created: true,
          verified: true,
          path: backupPath,
        },
      }),
    );
    expect(fs.existsSync(backupPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(persistPath, 'utf-8')).version).toBe('2.0');
  });

  it('requires confirmation before applying storage schema migration', async () => {
    const admin = new EngramAdmin();
    const context = createExecuteContext({
      tempDir,
      operation: 'migrateStorageSchema',
      parameters: {
        resource: 'lifecycle',
        storageMigrationMode: 'migrate',
        confirmStorageMigration: 'notConfirmed',
      },
    });

    await expect(admin.execute.call(context)).rejects.toThrow(
      'Confirm Migration must be set to Confirmed before applying schema changes',
    );
  });

  it('runs opt-in deep diagnostics for graph quality checks', async () => {
    const admin = new EngramAdmin();
    const storage = createStorage({
      backend: 'embedded',
      persistPath,
    });
    await storage.initialize();
    const alice = await storage.addEntity({
      name: 'Alice',
      group_id: 'diag-group',
      summary: 'A person',
      entity_type: 'person',
      name_embedding: [0.1, 0.2],
    });
    const bob = await storage.addEntity({
      name: 'Bob',
      group_id: 'diag-group',
      summary: 'A person',
      entity_type: 'person',
    });
    await storage.addEdge({
      group_id: 'diag-group',
      source_node_uuid: alice.uuid,
      target_node_uuid: bob.uuid,
      name: 'KNOWS',
      fact: 'Alice knows Bob',
      fact_embedding: [0.3, 0.4],
    });

    const context = createExecuteContext({
      tempDir,
      operation: 'diagnostics',
      parameters: {
        resource: 'monitoring',
        includeDeepChecks: 'enabled',
      },
    });

    const result = await admin.execute.call(context);

    expect(result[0][0].json.deep_checks).toEqual(
      expect.objectContaining({
        scanned_full_graph: true,
        active_edge_count: 1,
        expired_edge_count: 0,
        invalidated_edge_count: 0,
        dangling_edge_count: 0,
        duplicate_entity_name_groups: 0,
        entities_with_name_embeddings: 1,
        edges_with_fact_embeddings: 1,
      }),
    );
  });

  it('reports embedding coverage for semantic search readiness', async () => {
    const admin = new EngramAdmin();
    const storage = createStorage({
      backend: 'embedded',
      persistPath,
    });
    await storage.initialize();
    const alice = await storage.addEntity({
      name: 'Alice',
      group_id: 'coverage-group',
      entity_type: 'person',
      name_embedding: [0.1, 0.2],
    });
    const bob = await storage.addEntity({
      name: 'Bob',
      group_id: 'coverage-group',
      entity_type: 'person',
    });
    await storage.addEdge({
      group_id: 'coverage-group',
      source_node_uuid: alice.uuid,
      target_node_uuid: bob.uuid,
      name: 'KNOWS',
      fact: 'Alice knows Bob',
      fact_embedding: [0.3, 0.4],
    });

    const context = createExecuteContext({
      tempDir,
      operation: 'embeddingCoverage',
      parameters: {
        resource: 'monitoring',
        groupIdFilter: 'coverage-group',
      },
    });

    const result = await admin.execute.call(context);

    expect(result[0][0].json).toEqual(
      expect.objectContaining({
        operation: 'embeddingCoverage',
        group_id: 'coverage-group',
        entity_count: 2,
        edge_count: 1,
        entities_with_name_embeddings: 1,
        edges_with_fact_embeddings: 1,
        entity_embedding_coverage: 50,
        edge_embedding_coverage: 100,
      }),
    );
  });

  it('rebuilds the embedded search index on demand', async () => {
    const admin = new EngramAdmin();
    const storage = createStorage({
      backend: 'embedded',
      persistPath,
    });
    await storage.initialize();
    await storage.addEntity({
      name: 'Alice',
      group_id: 'index-group',
      entity_type: 'person',
    });

    const context = createExecuteContext({
      tempDir,
      operation: 'rebuildSearchIndex',
      parameters: {
        resource: 'hygiene',
      },
    });

    const result = await admin.execute.call(context);

    expect(result[0][0].json).toEqual(
      expect.objectContaining({
        operation: 'rebuildSearchIndex',
        status: 'ok',
        indexed_entities: 1,
        indexed_edges: 0,
      }),
    );
  });

  it('plans embedding backfill in dry-run mode without writing', async () => {
    const admin = new EngramAdmin();
    const storage = createStorage({
      backend: 'embedded',
      persistPath,
    });
    await storage.initialize();
    const alice = await storage.addEntity({
      name: 'Alice',
      group_id: 'backfill-group',
      entity_type: 'person',
    });
    const bob = await storage.addEntity({
      name: 'Bob',
      group_id: 'backfill-group',
      entity_type: 'person',
    });
    await storage.addEdge({
      group_id: 'backfill-group',
      source_node_uuid: alice.uuid,
      target_node_uuid: bob.uuid,
      name: 'KNOWS',
      fact: 'Alice knows Bob',
    });

    const context = createExecuteContext({
      tempDir,
      operation: 'backfillEmbeddings',
      parameters: {
        resource: 'hygiene',
        groupIdFilter: 'backfill-group',
        dryRun: true,
        backfillTarget: 'both',
        backfillLimit: 10,
      },
    });

    const result = await admin.execute.call(context);

    expect(result[0][0].json).toEqual(
      expect.objectContaining({
        operation: 'backfillEmbeddings',
        mode: 'dryRun',
        group_id: 'backfill-group',
        missing_entity_embeddings: 2,
        missing_edge_embeddings: 1,
        planned_updates: 3,
        written: false,
      }),
    );
  });

  it('rejects import payloads that do not match the graph schema', async () => {
    const admin = new EngramAdmin();
    const context = createExecuteContext({
      tempDir,
      operation: 'import',
      parameters: {
        resource: 'portability',
        importData: {
          version: '2.0',
          exported_at: 'not-a-date',
          entities: [],
          edges: [],
          episodes: [],
        },
      },
    });

    await expect(admin.execute.call(context)).rejects.toThrow('Invalid import data format');
  });

  it('imports valid graph schema payloads', async () => {
    const admin = new EngramAdmin();
    const context = createExecuteContext({
      tempDir,
      operation: 'import',
      parameters: {
        resource: 'portability',
        importData: {
          version: '2.0',
          exported_at: new Date().toISOString(),
          entities: [],
          edges: [],
          episodes: [],
        },
      },
    });

    const result = await admin.execute.call(context);

    expect(result[0][0].json).toEqual(
      expect.objectContaining({
        success: true,
        operation: 'import',
        mode: 'import',
        checksum_verified: false,
        migration: expect.objectContaining({
          source_version: '2.0',
          target_version: '2.0',
          migration_required: false,
        }),
        warnings: [],
        imported: {
          entities: 0,
          edges: 0,
          episodes: 0,
        },
        written: true,
      }),
    );
  });

  it('verifies checksummed legacy exports before applying provenance defaults', async () => {
    const exportedAt = '2026-06-21T12:00:00.000Z';
    const episodeUuid = '00000000-0000-4000-8000-000000000099';
    const legacyGraph = {
      version: '1.0' as const,
      exported_at: exportedAt,
      entities: [],
      edges: [],
      episodes: [
        {
          uuid: episodeUuid,
          group_id: 'legacy-group',
          content: 'A message created before structured provenance.',
          role: 'human' as const,
          source_type: 'message' as const,
          reference_time: exportedAt,
          previous_episode_uuid: null,
          created_at: exportedAt,
        },
      ],
    };
    const checksum = createHash('sha256')
      .update(JSON.stringify({ ...legacyGraph, group_id: undefined }))
      .digest('hex');
    const admin = new EngramAdmin();
    const context = createExecuteContext({
      tempDir,
      operation: 'import',
      parameters: {
        resource: 'portability',
        importData: {
          ...legacyGraph,
          metadata: {
            checksum_sha256: checksum,
            checksum_algorithm: 'sha256',
          },
        },
      },
    });

    const result = await admin.execute.call(context);
    expect(result[0][0].json).toEqual(
      expect.objectContaining({
        success: true,
        checksum_verified: true,
        written: true,
        migration: expect.objectContaining({
          source_version: '1.0',
          target_version: '2.0',
          migration_required: true,
          episode_defaults_applied: expect.objectContaining({
            episode_kind: 1,
            trust_level: 1,
            review_status: 1,
          }),
        }),
      }),
    );

    const storage = createStorage({ backend: 'embedded', persistPath });
    await storage.initialize();
    const episode = await storage.getEpisode(episodeUuid);
    await storage.close();

    expect(episode).toEqual(
      expect.objectContaining({
        episode_kind: 'legacy',
        trust_level: 'unverified',
        review_status: 'proposed',
        confidence: null,
      }),
    );
  });

  it('validates import payloads in dry-run mode without writing', async () => {
    const episodeUuid = '00000000-0000-4000-8000-000000000097';
    const timestamp = '2026-06-21T12:00:00.000Z';
    const admin = new EngramAdmin();
    const context = createExecuteContext({
      tempDir,
      operation: 'import',
      parameters: {
        resource: 'portability',
        importMode: 'dryRun',
        importData: {
          version: '1.0',
          exported_at: timestamp,
          entities: [],
          edges: [],
          episodes: [
            {
              uuid: episodeUuid,
              group_id: 'dry-run-group',
              content: 'Legacy dry-run episode',
              role: 'human',
              reference_time: timestamp,
              created_at: timestamp,
            },
          ],
        },
      },
    });

    const result = await admin.execute.call(context);

    expect(result[0][0].json).toEqual(
      expect.objectContaining({
        success: true,
        operation: 'import',
        mode: 'dryRun',
        written: false,
        migration: expect.objectContaining({
          source_version: '1.0',
          target_version: '2.0',
          migration_required: true,
          records: { entities: 0, facts: 0, episodes: 1 },
        }),
      }),
    );

    const storage = createStorage({ backend: 'embedded', persistPath });
    await storage.initialize();
    await expect(storage.getEpisode(episodeUuid)).resolves.toBeNull();
    await storage.close();
  });

  it('adds checksum metadata to exports and enforces export size limits', async () => {
    const admin = new EngramAdmin();
    const storage = createStorage({
      backend: 'embedded',
      persistPath,
    });
    await storage.initialize();
    await storage.addEntity({
      name: 'Alice',
      group_id: 'export-group',
      entity_type: 'person',
    });
    await storage.addEntity({
      name: 'Bob',
      group_id: 'export-group',
      entity_type: 'person',
    });

    const exportContext = createExecuteContext({
      tempDir,
      operation: 'export',
      parameters: {
        resource: 'portability',
        groupIdFilter: 'export-group',
      },
    });

    const result = await admin.execute.call(exportContext);

    expect(result[0][0].json.metadata).toEqual(
      expect.objectContaining({
        checksum_algorithm: 'sha256',
        generated_by: 'n8n-nodes-engram',
        entity_count: 2,
        edge_count: 0,
        episode_count: 0,
      }),
    );
    expect(result[0][0].json.version).toBe('2.0');

    const limitedContext = createExecuteContext({
      tempDir,
      operation: 'export',
      parameters: {
        resource: 'portability',
        groupIdFilter: 'export-group',
        maxExportItems: 0,
      },
    });

    await expect(admin.execute.call(limitedContext)).resolves.toBeDefined();

    const failingContext = createExecuteContext({
      tempDir,
      operation: 'export',
      parameters: {
        resource: 'portability',
        groupIdFilter: 'export-group',
        maxExportItems: 1,
      },
    });

    await expect(admin.execute.call(failingContext)).rejects.toThrow(
      'Export exceeds configured safety limit',
    );
  });
});
