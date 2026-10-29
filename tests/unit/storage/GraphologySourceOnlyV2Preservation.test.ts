import { createHash, randomUUID } from 'crypto';
import * as fs from 'fs';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { captureEnvelope, compileAutomaticPolicy } from '../../../src/extraction/AutomaticEvidence';
import { buildAutomaticOperationDescriptorV2 } from '../../../src/extraction/AutomaticCaptureDescriptor';
import {
  AutomaticCaptureSourceOwnerV2Schema,
  hashAutomaticCaptureV2,
} from '../../../src/schemas/AutomaticCapture.schema';
import {
  EntityNodeSchema,
  EpisodicNodeSchema,
  GraphDataSchema,
  type GraphData,
} from '../../../src/schemas';
import type { AutomaticWriteOwner } from '../../../src/schemas/AutomaticClaim.schema';
import {
  applyAutomaticBindingCommand,
  assertAutomaticLedgerSourceIntegrity,
  automaticWriteOwnerIdempotencyKey,
  SOURCE_ENVELOPE_ATTRIBUTE,
  WRITE_OWNER_ATTRIBUTE,
  WRITE_OWNER_V2_ATTRIBUTE,
} from '../../../src/storage/AutomaticIdentity';
import { GraphologyStorage } from '../../../src/storage/GraphologyStorage';

const now = '2026-10-25T12:00:00.000Z';
const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

type SnapshotFault = 'file_fsync' | 'directory_fsync';
type OpenFunction = (
  filePath: string,
  flags: string | number,
  mode?: number,
) => Promise<Awaited<ReturnType<typeof fs.promises.open>>>;

function injectSnapshotFault(
  fault: SnapshotFault,
  persistPath: string,
  directory: string,
  persistent = false,
): { wasTriggered: () => boolean; syncCalls: () => number; restore: () => void } {
  const failure = Object.assign(new Error(`injected_source_only_${fault}`), {
    code: 'EIO',
  });
  let triggered = false;
  let syncCalls = 0;
  const promises = fs.promises as unknown as { open: OpenFunction };
  const originalOpen = promises.open.bind(fs.promises);
  const spy = jest.spyOn(promises, 'open').mockImplementation(async (filePath, flags, mode) => {
    const handle = await originalOpen(filePath, flags, mode);
    const isTarget =
      fault === 'file_fsync'
        ? filePath.startsWith(`${persistPath}.`) && filePath.endsWith('.tmp')
        : filePath === directory;
    if (isTarget) {
      const originalSync = handle.sync.bind(handle);
      Object.defineProperty(handle, 'sync', {
        configurable: true,
        value: async () => {
          syncCalls += 1;
          if (persistent || syncCalls === 1) {
            triggered = true;
            throw failure;
          }
          await originalSync();
        },
      });
    }
    return handle;
  });
  return {
    wasTriggered: () => triggered,
    syncCalls: () => syncCalls,
    restore: () => spy.mockRestore(),
  };
}

function sourceOnlyV2Graph(group: string): GraphData {
  const subjectId = randomUUID();
  const graph = GraphDataSchema.parse({
    version: '2.0',
    exported_at: now,
    group_id: group,
    entities: [
      EntityNodeSchema.parse({
        uuid: subjectId,
        group_id: group,
        name: 'Synthetic bound subject',
        entity_type: 'person',
        summary: '',
        created_at: now,
        updated_at: now,
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
            reviewed_by: 'synthetic-reviewer',
          },
        },
      }),
    ],
    edges: [],
    episodes: [],
  });
  const bindingRecord = applyAutomaticBindingCommand(
    graph,
    {
      action: 'create',
      namespace: group,
      issuer: 'source-only-workflow',
      actorReference: 'source-only-actor',
      subjectId,
      authorizedBy: 'synthetic-reviewer',
      reason: 'Source-only persistence fixture',
    },
    randomUUID(),
    now,
  );
  const binding = {
    bindingId: bindingRecord.bindingId,
    revision: bindingRecord.revision,
    subjectId: bindingRecord.subjectId,
    fingerprint: bindingRecord.fingerprint,
  };
  const policy = compileAutomaticPolicy({ profileId: 'conservative' });
  const content = 'I prefer concise explanations.';
  const captured = captureEnvelope(
    content,
    content,
    { namespace: group, issuer: 'source-only-workflow', actorReference: 'source-only-actor' },
    binding,
    false,
    policy,
  );
  if (!captured.ok) throw new Error('Synthetic source-only envelope fixture failed');

  const legacyOwner: AutomaticWriteOwner = {
    version: 1,
    store: digest('synthetic source-only logical store'),
    namespace: group,
    turn: 'source-only-human-turn',
    role: 'human',
    actor: 'source-only-actor',
    issuer: 'source-only-workflow',
    binding,
    policy,
    contentHash: digest(content),
  };
  const descriptor = buildAutomaticOperationDescriptorV2({
    purpose: 'human_turn_memory',
    profileId: 'conservative',
    requestedTrustLevel: 'standard',
    intentSetting: false,
    invocationDeadlineMs: 30_000,
  }).descriptor;
  const episode = EpisodicNodeSchema.parse({
    uuid: randomUUID(),
    group_id: group,
    content,
    role: 'human',
    source_type: 'message',
    reference_time: now,
    previous_episode_uuid: null,
    created_at: now,
    updated_at: now,
    source_message_id: 'source-only-message',
    source_workflow_id: 'source-only-producer',
    source_execution_id: 'source-only-original-execution',
    conversation_id: 'source-only-conversation',
    sender_id: 'source-only-actor',
    sender_name: 'Synthetic display',
    idempotency_key: automaticWriteOwnerIdempotencyKey(legacyOwner),
    episode_kind: 'active_human',
    quoted_message_id: null,
    trust_level: 'standard',
    review_status: 'accepted',
    attributes: {
      [SOURCE_ENVELOPE_ATTRIBUTE]: captured.envelope,
      [WRITE_OWNER_ATTRIBUTE]: legacyOwner,
    },
  });
  episode.attributes[WRITE_OWNER_V2_ATTRIBUTE] = AutomaticCaptureSourceOwnerV2Schema.parse({
    version: 2,
    lifecycle: 'replaySafeV2',
    storeHash: legacyOwner.store,
    namespace: group,
    turn: legacyOwner.turn,
    role: 'human',
    issuer: legacyOwner.issuer,
    actorReference: legacyOwner.actor,
    binding,
    assistantWriteAuthority: null,
    purpose: 'human_turn_memory',
    requestedTrustLevel: 'standard',
    intentSetting: false,
    intentEvidence: captured.envelope.explicitIntent,
    eventTimeMode: 'first_capture',
    eventTimeHash: hashAutomaticCaptureV2({
      mode: 'first_capture',
      normalizedReferenceTime: new Date(now).toISOString(),
    }),
    stableProducerHash: hashAutomaticCaptureV2({
      source_workflow_id: episode.source_workflow_id,
      source_message_id: episode.source_message_id,
      conversation_id: episode.conversation_id,
      sender_id: episode.sender_id,
      source_type: episode.source_type,
      episode_kind: episode.episode_kind,
      quoted_message_id: episode.quoted_message_id,
    }),
    sourceContentHash: digest(content),
    settingsHash: descriptor.settingsHash,
    policy,
  });
  graph.episodes.push(episode);
  const sourceOnly = GraphDataSchema.parse(graph);
  assertAutomaticLedgerSourceIntegrity(sourceOnly);
  return sourceOnly;
}

describe('embedded source-only replay-safe v2 persistence', () => {
  let directory: string;
  let persistPath: string;
  let group: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'engram-source-only-v2-'));
    persistPath = join(directory, 'store.json');
    group = `source-only-${randomUUID()}`;
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('fails closed on a missing backing file when only a V2 source owner is cached', async () => {
    const graph = sourceOnlyV2Graph(group);
    expect(graph.automatic_operations_v1).toBeUndefined();
    expect(graph.episodes.some((episode) => episode.attributes.engram_extraction_queue_v1)).toBe(
      false,
    );
    fs.writeFileSync(persistPath, JSON.stringify(graph, null, 2), 'utf8');

    const storage = new GraphologyStorage(persistPath);
    await storage.initialize();
    const cached = await storage.exportGraph();
    expect(cached.automatic_operations_v1).toBeUndefined();
    expect(cached.episodes).toHaveLength(1);
    fs.unlinkSync(persistPath);

    await expect(storage.readExtractionSnapshot(group)).rejects.toThrow(
      'Engram automatic ledger: store_missing',
    );
    await expect(
      storage.appendEpisode({
        group_id: group,
        content: 'This append must not recreate a lost source-only store.',
        role: 'human',
        reference_time: now,
      }),
    ).rejects.toThrow('Engram automatic ledger: store_missing');

    expect(fs.existsSync(persistPath)).toBe(false);
    const stillCached = await storage.exportGraph();
    expect(stillCached.episodes.map((episode) => episode.uuid)).toEqual(
      cached.episodes.map((episode) => episode.uuid),
    );
    await storage.close();
  });

  it.each(['file_fsync', 'directory_fsync'] as const)(
    'uses durable rollback for an ordinary writer after source-only V2 state and %s failure',
    async (faultName) => {
      const graph = sourceOnlyV2Graph(group);
      fs.writeFileSync(persistPath, JSON.stringify(graph, null, 2), 'utf8');
      const storage = new GraphologyStorage(persistPath);
      await storage.initialize();
      const before = await storage.exportGraph();
      const fault = injectSnapshotFault(faultName, persistPath, directory);
      try {
        await expect(
          storage.addEntity({ group_id: group, name: `Failed writer ${faultName}` }),
        ).rejects.toThrow(`injected_source_only_${faultName}`);
        expect(fault.wasTriggered()).toBe(true);
      } finally {
        fault.restore();
      }
      expect(fault.syncCalls()).toBe(faultName === 'directory_fsync' ? 2 : 1);

      const recovered = new GraphologyStorage(persistPath);
      await recovered.initialize();
      const diskAfterFailure = await recovered.readExtractionSnapshot(group);
      expect(diskAfterFailure.automatic_operations_v1).toBeUndefined();
      expect(diskAfterFailure.entities).toEqual(before.entities);
      expect(diskAfterFailure.episodes).toEqual(before.episodes);
      await recovered.close();

      const diagnostics = storage.getLastMutationDiagnostics();
      expect(diagnostics).toMatchObject({ success: false });
      expect(diagnostics).not.toHaveProperty('rollback_diagnostic');
      await storage.close();
    },
  );

  it('keeps a newly introduced source-only V2 snapshot durable through rollback', async () => {
    const empty = GraphDataSchema.parse({
      version: '2.0',
      exported_at: now,
      group_id: group,
      entities: [],
      edges: [],
      episodes: [],
    });
    fs.writeFileSync(persistPath, JSON.stringify(empty, null, 2), 'utf8');
    const storage = new GraphologyStorage(persistPath);
    await storage.initialize();
    const sourceOnly = sourceOnlyV2Graph(group);
    const internal = storage as unknown as {
      runMutation<T>(mutation: () => T | Promise<T>): Promise<T>;
      replaceGraphData(data: GraphData): void;
    };
    const fault = injectSnapshotFault('directory_fsync', persistPath, directory);
    try {
      await expect(
        internal.runMutation(() => {
          internal.replaceGraphData(sourceOnly);
          return true;
        }),
      ).rejects.toThrow('injected_source_only_directory_fsync');
      expect(fault.wasTriggered()).toBe(true);
    } finally {
      fault.restore();
    }
    // The rollback also fsyncs the old rootless snapshot because the failed
    // forward mutation had introduced V2 source ownership.
    expect(fault.syncCalls()).toBe(2);

    const recovered = new GraphologyStorage(persistPath);
    await recovered.initialize();
    const after = await recovered.readExtractionSnapshot(group);
    expect(after.episodes).toEqual([]);
    expect(after.automatic_operations_v1).toBeUndefined();
    await recovered.close();
    await storage.close();
  });

  it('reports rollback persistence failure and blocks the instance after repeated directory fsync failure', async () => {
    const graph = sourceOnlyV2Graph(group);
    fs.writeFileSync(persistPath, JSON.stringify(graph, null, 2), 'utf8');
    const storage = new GraphologyStorage(persistPath);
    await storage.initialize();
    const before = await storage.exportGraph();
    const fault = injectSnapshotFault('directory_fsync', persistPath, directory, true);
    try {
      await expect(
        storage.addEntity({ group_id: group, name: 'Uncertain source-only writer' }),
      ).rejects.toThrow('injected_source_only_directory_fsync');
      expect(fault.wasTriggered()).toBe(true);
    } finally {
      fault.restore();
    }

    expect(storage.getLastMutationDiagnostics()).toMatchObject({
      success: false,
      rollback_diagnostic: 'rollback_persistence_failed',
    });
    expect(JSON.stringify(storage.getLastMutationDiagnostics())).not.toContain(
      'injected_source_only_directory_fsync',
    );
    await expect(storage.readExtractionSnapshot(group)).rejects.toThrow(
      'Engram automatic ledger: recovery_required',
    );
    await expect(storage.exportGraph()).rejects.toThrow(
      'Engram automatic ledger: recovery_required',
    );
    await expect(storage.addEntity({ group_id: group, name: 'Must stay blocked' })).rejects.toThrow(
      'Engram automatic ledger: recovery_required',
    );
    expect(before.automatic_operations_v1).toBeUndefined();
    await storage.close();
  });
});
