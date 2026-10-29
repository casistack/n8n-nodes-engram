import { createHash, randomUUID } from 'crypto';
import * as fs from 'fs';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import neo4j from 'neo4j-driver';
import type { CreateEpisodicNode, GraphData } from '../../src/schemas';
import { compileAutomaticPolicy } from '../../src/extraction/AutomaticEvidence';
import {
  exportQueueBackup,
  graphFingerprint,
  sourceFingerprint,
  fingerprint,
} from '../../src/extraction/QueueState';
import { GraphologyStorage } from '../../src/storage/GraphologyStorage';
import {
  assertAutomaticLedgerSourceIntegrity,
  automaticWriteOwnerIdempotencyKey,
  WRITE_OWNER_ATTRIBUTE,
} from '../../src/storage/AutomaticIdentity';
import { Neo4jStorage } from '../../src/storage/Neo4jStorage';
import type { IGraphStorage } from '../../src/storage/IGraphStorage';
import type { AutomaticWriteOwner } from '../../src/schemas/AutomaticClaim.schema';

jest.setTimeout(30000);

const timestamp = '2026-10-25T12:00:00.000Z';
const policy = compileAutomaticPolicy({ profileId: 'conservative' });
const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

type SnapshotFault = 'enospc' | 'rename' | 'file_fsync' | 'directory_fsync';
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
): { wasTriggered: () => boolean; restore: () => void } {
  const failure = Object.assign(new Error(`injected_${fault}`), {
    code: fault === 'enospc' ? 'ENOSPC' : 'EIO',
  });
  let triggered = false;
  let restore = () => {};

  if (fault === 'rename') {
    const spy = jest.spyOn(fs.promises, 'rename').mockImplementationOnce(async () => {
      triggered = true;
      throw failure;
    });
    restore = () => spy.mockRestore();
  } else if (fault === 'enospc') {
    const promises = fs.promises as unknown as { open: OpenFunction };
    const originalOpen = promises.open.bind(fs.promises);
    const spy = jest.spyOn(promises, 'open').mockImplementation(async (filePath, flags, mode) => {
      if (!triggered && filePath.startsWith(`${persistPath}.`) && filePath.endsWith('.tmp')) {
        triggered = true;
        throw failure;
      }
      return originalOpen(filePath, flags, mode);
    });
    restore = () => spy.mockRestore();
  } else {
    const promises = fs.promises as unknown as { open: OpenFunction };
    const originalOpen = promises.open.bind(fs.promises);
    const spy = jest.spyOn(promises, 'open').mockImplementation(async (filePath, flags, mode) => {
      const handle = await originalOpen(filePath, flags, mode);
      const isTarget =
        fault === 'file_fsync'
          ? filePath.startsWith(`${persistPath}.`) && filePath.endsWith('.tmp')
          : filePath === directory;
      if (isTarget && (persistent || !triggered)) {
        Object.defineProperty(handle, 'sync', {
          configurable: true,
          value: async () => {
            triggered = true;
            throw failure;
          },
        });
      }
      return handle;
    });
    restore = () => spy.mockRestore();
  }

  return { wasTriggered: () => triggered, restore };
}

function ownedEpisode(group: string, turn: string, previous: string | null = null) {
  const content = `Owned source for ${turn}`;
  const owner: AutomaticWriteOwner = {
    version: 1,
    store: 'a'.repeat(64),
    namespace: group,
    turn,
    role: 'human',
    actor: 'synthetic-actor',
    issuer: 'synthetic-issuer',
    binding: null,
    policy,
    contentHash: digest(content),
  };
  const input: CreateEpisodicNode = {
    group_id: group,
    content,
    role: 'human',
    source_type: 'message',
    reference_time: timestamp,
    previous_episode_uuid: previous,
    source_message_id: `message-${turn}`,
    source_execution_id: 'original-execution-reference',
    idempotency_key: automaticWriteOwnerIdempotencyKey(owner),
    conversation_id: 'synthetic-conversation',
    sender_id: 'synthetic-sender',
    episode_kind: 'active_human',
    trust_level: 'trusted',
    review_status: 'accepted',
    attributes: { [WRITE_OWNER_ATTRIBUTE]: owner },
  };
  return { owner, input };
}

function emptyGraph(group: string): GraphData {
  return {
    version: '2.0',
    exported_at: timestamp,
    group_id: group,
    entities: [],
    edges: [],
    episodes: [],
  };
}

for (const backend of ['embedded', 'neo4j'] as const) {
  const suite = backend === 'neo4j' && !process.env.NEO4J_TEST_URI ? describe.skip : describe;
  suite(`${backend} native automatic-ledger preservation`, () => {
    const group = `ledger-preservation-${randomUUID()}`;
    const groupsToCleanup = new Set<string>();
    const storePath = () => join(directory, 'store.json');
    let directory: string;
    let storage: IGraphStorage;
    let secondary: GraphologyStorage | undefined;

    const create = (): IGraphStorage =>
      backend === 'embedded'
        ? new GraphologyStorage(storePath())
        : new Neo4jStorage(
            process.env.NEO4J_TEST_URI!,
            'neo4j',
            process.env.NEO4J_TEST_PASSWORD ?? 'password',
          );

    beforeEach(async () => {
      directory = mkdtempSync(join(tmpdir(), 'engram-ledger-preservation-'));
      groupsToCleanup.clear();
      groupsToCleanup.add(group);
      storage = create();
      await storage.initialize();
    });

    afterEach(async () => {
      await secondary?.close();
      await storage.close();
      if (backend === 'embedded') {
        rmSync(directory, { recursive: true, force: true });
        return;
      }
      const driver = neo4j.driver(
        process.env.NEO4J_TEST_URI!.replace('://localhost:', '://127.0.0.1:'),
        neo4j.auth.basic('neo4j', process.env.NEO4J_TEST_PASSWORD ?? 'password'),
      );
      const session = driver.session();
      try {
        await session.executeWrite(async (tx) => {
          for (const namespace of groupsToCleanup) {
            await tx.run('MATCH (op:AutomaticOperation {namespace:$group}) DETACH DELETE op', {
              group: namespace,
            });
            await tx.run(
              'MATCH (n) WHERE n.group_id=$group AND (n:Entity OR n:Episode) DETACH DELETE n',
              { group: namespace },
            );
          }
        });
      } finally {
        await session.close();
        await driver.close();
      }
    });

    if (backend === 'embedded') {
      it('fails closed when the file disappears after caching an empty ledger marker', async () => {
        const { owner, input } = ownedEpisode(group, 'turn-missing-ledger-file');
        const [{ episode: source }] = await storage.appendAutomaticEpisodes!([input]);
        await storage.close();

        const persisted = JSON.parse(fs.readFileSync(storePath(), 'utf8')) as GraphData;
        persisted.automatic_operations_v1 = { version: 1, operations: [] };
        fs.writeFileSync(storePath(), JSON.stringify(persisted, null, 2), 'utf8');
        storage = new GraphologyStorage(storePath());
        await storage.initialize();
        expect((await storage.exportGraph()).automatic_operations_v1).toEqual({
          version: 1,
          operations: [],
        });

        fs.unlinkSync(storePath());
        await expect(storage.readExtractionSnapshot!(group)).rejects.toThrow(
          'Engram automatic ledger: store_missing',
        );
        await expect(
          storage.observeLegacyAutomaticSource!({ sourceId: source.uuid, expectedOwner: owner }),
        ).rejects.toThrow('Engram automatic ledger: store_missing');
        await expect(
          storage.addEntity({ group_id: group, name: 'Must not recreate missing ledger store' }),
        ).rejects.toThrow('Engram automatic ledger: store_missing');
        expect(fs.existsSync(storePath())).toBe(false);
      });

      it.each(['enospc', 'rename', 'file_fsync', 'directory_fsync'] as const)(
        'rolls back a failed first observation after %s and allows a clean retry',
        async (faultName) => {
          const { owner, input } = ownedEpisode(group, `turn-first-observation-${faultName}`);
          const [{ episode: source }] = await storage.appendAutomaticEpisodes!([input]);
          const before = await storage.exportGraph();
          const fault = injectSnapshotFault(faultName, storePath(), directory);
          try {
            await expect(
              storage.observeLegacyAutomaticSource!({
                sourceId: source.uuid,
                expectedOwner: owner,
              }),
            ).rejects.toThrow(`injected_${faultName}`);
            expect(fault.wasTriggered()).toBe(true);
          } finally {
            fault.restore();
          }

          const diskStorage = new GraphologyStorage(storePath());
          await diskStorage.initialize();
          const diskAfterFailure = await diskStorage.readExtractionSnapshot!(group);
          expect(diskAfterFailure.automatic_operations_v1).toBeUndefined();
          expect(diskAfterFailure.episodes).toEqual(before.episodes);
          await diskStorage.close();

          const retry = await storage.observeLegacyAutomaticSource!({
            sourceId: source.uuid,
            expectedOwner: owner,
          });
          expect(retry.status).toBe('observed');
          const afterRetry = await storage.readExtractionSnapshot!(group);
          expect(afterRetry.automatic_operations_v1?.operations).toHaveLength(1);
          expect(afterRetry.automatic_operations_v1?.operations[0].state).toBe(
            'legacy_unconfirmed',
          );
        },
      );

      it('keeps an acknowledged ledger intact after an ordinary writer fsync failure', async () => {
        const { owner, input } = ownedEpisode(group, 'turn-ordinary-writer-failure');
        const [{ episode: source }] = await storage.appendAutomaticEpisodes!([input]);
        await storage.observeLegacyAutomaticSource!({
          sourceId: source.uuid,
          expectedOwner: owner,
        });
        const before = await storage.exportGraph();
        const fault = injectSnapshotFault('directory_fsync', storePath(), directory);
        try {
          await expect(
            storage.addEntity({ group_id: group, name: 'Writer failure test entity' }),
          ).rejects.toThrow('injected_directory_fsync');
          expect(fault.wasTriggered()).toBe(true);
        } finally {
          fault.restore();
        }

        const diskStorage = new GraphologyStorage(storePath());
        await diskStorage.initialize();
        const diskAfterFailure = await diskStorage.readExtractionSnapshot!(group);
        expect(diskAfterFailure.automatic_operations_v1).toEqual(before.automatic_operations_v1);
        expect(diskAfterFailure.entities).toEqual(before.entities);
        await diskStorage.close();

        await storage.addEntity({ group_id: group, name: 'Writer retry entity' });
        expect((await storage.readExtractionSnapshot!(group)).automatic_operations_v1).toEqual(
          before.automatic_operations_v1,
        );
      });

      it.each([false, true])(
        'marks recovery-required after rollback fsync failure (first observation: %s)',
        async (firstObservation) => {
          const { owner, input } = ownedEpisode(group, 'turn-rollback-failure');
          const [{ episode: source }] = await storage.appendAutomaticEpisodes!([input]);
          if (!firstObservation) {
            await storage.observeLegacyAutomaticSource!({
              sourceId: source.uuid,
              expectedOwner: owner,
            });
          }

          const fault = injectSnapshotFault('directory_fsync', storePath(), directory, true);
          try {
            await expect(
              firstObservation
                ? storage.observeLegacyAutomaticSource!({
                    sourceId: source.uuid,
                    expectedOwner: owner,
                  })
                : storage.addEntity({ group_id: group, name: 'Recovery-required failed writer' }),
            ).rejects.toThrow('injected_directory_fsync');
            expect(fault.wasTriggered()).toBe(true);
          } finally {
            fault.restore();
          }

          expect(storage.getLastMutationDiagnostics!()).toMatchObject({
            success: false,
            rollback_diagnostic: 'rollback_persistence_failed',
          });
          expect(JSON.stringify(storage.getLastMutationDiagnostics!())).not.toContain(
            'injected_directory_fsync',
          );
          await expect(storage.readExtractionSnapshot!(group)).rejects.toThrow(
            'Engram automatic ledger: recovery_required',
          );
          await expect(storage.exportGraph()).rejects.toThrow(
            'Engram automatic ledger: recovery_required',
          );
          await expect(
            storage.addEntity({ group_id: group, name: 'Must remain blocked' }),
          ).rejects.toThrow('Engram automatic ledger: recovery_required');
        },
      );
    }

    it('persists observation across instances and keeps source and extraction fingerprints unchanged', async () => {
      const { owner, input } = ownedEpisode(group, 'turn-observe');
      const [{ episode: source }] = await storage.appendAutomaticEpisodes!([input]);
      const before = await storage.exportGraph(group);
      const beforeSourceHash = sourceFingerprint(source);
      const beforeGraphHash = graphFingerprint(before, group);
      const attemptIdHash = digest('opaque synthetic delivery reference');

      if (backend === 'embedded') {
        secondary = new GraphologyStorage(storePath());
        await secondary.initialize();
      }

      const result = await storage.observeLegacyAutomaticSource!({
        sourceId: source.uuid,
        expectedOwner: owner,
        attemptIdHash,
      });
      expect(result).toEqual({
        status: 'observed',
        state: 'legacy_unconfirmed',
        shouldProcess: false,
        attemptAudit: 'recorded',
      });
      expect(Object.keys(result).sort()).toEqual(
        ['attemptAudit', 'shouldProcess', 'state', 'status'].sort(),
      );

      const recovered = await (secondary ?? storage).readExtractionSnapshot!(group);
      expect(recovered.automatic_operations_v1?.operations).toHaveLength(1);
      expect(recovered.automatic_operations_v1?.operations[0]).toMatchObject({
        state: 'legacy_unconfirmed',
        identity: { sourceId: source.uuid, sourceHash: beforeSourceHash },
        attempts: [{ attemptHash: attemptIdHash }],
      });
      expect(JSON.stringify(recovered.automatic_operations_v1)).not.toContain(
        'opaque synthetic delivery reference',
      );
      const inspectionBackup = exportQueueBackup(recovered);
      expect(inspectionBackup.graph.automatic_operations_v1).toEqual(
        recovered.automatic_operations_v1,
      );
      expect(inspectionBackup.sha256).toBe(fingerprint(inspectionBackup.graph));
      expect(inspectionBackup.warnings).toEqual({
        missing_fact_source_references: 0,
        missing_chain_predecessors: 0,
      });
      expect(sourceFingerprint(recovered.episodes[0])).toBe(beforeSourceHash);
      expect(graphFingerprint(recovered, group)).toBe(beforeGraphHash);

      const capturedSourceHash =
        recovered.automatic_operations_v1!.operations[0].identity.sourceHash;
      await storage.updateEpisode(source.uuid, {
        trust_level: 'untrusted',
        review_status: 'proposed',
        sender_name: 'Updated display label',
      });
      const repeated = await storage.observeLegacyAutomaticSource!({
        sourceId: source.uuid,
        expectedOwner: owner,
        attemptIdHash: digest('second opaque synthetic delivery reference'),
      });
      expect(repeated.status).toBe('already_unconfirmed');
      const reviewed = await storage.exportGraph(group);
      expect(reviewed.automatic_operations_v1?.operations[0].identity.sourceHash).toBe(
        capturedSourceHash,
      );
      expect(reviewed.automatic_operations_v1?.operations[0].attempts).toHaveLength(2);
      const unrelatedGroup = `unrelated-ledger-group-${randomUUID()}`;
      groupsToCleanup.add(unrelatedGroup);
      const unrelatedEpisode = await storage.appendEpisode({
        group_id: unrelatedGroup,
        content: 'Unrelated namespace source',
        role: 'human',
        reference_time: timestamp,
      });
      await expect(storage.deleteEpisode(unrelatedEpisode.episode.uuid)).resolves.toMatchObject({
        deleted: true,
      });
      const tamperedImmutableSource = structuredClone(reviewed);
      tamperedImmutableSource.episodes[0].source_execution_id = 'replacement-execution-reference';
      expect(() => assertAutomaticLedgerSourceIntegrity(tamperedImmutableSource)).toThrow(
        'invalid_source_owner',
      );

      // Ordinary graph writes and imports must round-trip the native operation root.
      const left = await storage.addEntity({ group_id: group, name: 'Ledger test left' });
      const right = await storage.addEntity({ group_id: group, name: 'Ledger test right' });
      const edge = await storage.addEdge({
        group_id: group,
        source_node_uuid: left.uuid,
        target_node_uuid: right.uuid,
        name: 'related',
        fact: 'synthetic test relation',
      });
      await storage.updateEntity(left.uuid, { name: 'Ledger test left updated' });
      await storage.updateEdge(edge.uuid, { fact: 'updated synthetic test relation' });
      const ordinary = await storage.appendEpisode({
        group_id: group,
        content: 'Ordinary test episode',
        role: 'human',
        reference_time: timestamp,
      });
      await storage.updateEpisode(ordinary.episode.uuid, { content: 'Updated ordinary episode' });
      await storage.importGraph(emptyGraph(`import-${randomUUID()}`));
      await storage.importExtractionBackup!(
        exportQueueBackup(emptyGraph(`backup-${randomUUID()}`)),
      );

      const full = await storage.readExtractionSnapshot!();
      expect(full.automatic_operations_v1?.operations).toHaveLength(1);
      expect(full.automatic_operations_v1?.operations[0].state).toBe('legacy_unconfirmed');
      expect(full.automatic_operations_v1?.operations[0].attempts).toHaveLength(2);
      expect(await storage.exportGraph(`unrelated-${randomUUID()}`)).not.toHaveProperty(
        'automatic_operations_v1',
      );
      expect((await storage.exportGraph(group)).automatic_operations_v1?.operations).toHaveLength(
        1,
      );

      await secondary?.close();
      secondary = undefined;
      await storage.close();
      storage = create();
      await storage.initialize();
      const reopened = await storage.exportGraph();
      expect(reopened.automatic_operations_v1?.operations).toHaveLength(1);
      const exportedOperation = reopened.automatic_operations_v1!.operations[0];
      try {
        Reflect.set(exportedOperation, 'state', 'committed');
        exportedOperation.attempts.push({
          attemptHash: digest('external mutation'),
          at: timestamp,
          disposition: 'captured',
        });
      } catch {
        // A frozen detached result may reject the attempted mutation immediately.
      }
      await storage.addEntity({ group_id: group, name: 'Post-reopen ledger alias check' });
      const afterExternalMutation = await storage.readExtractionSnapshot!(group);
      expect(afterExternalMutation.automatic_operations_v1?.operations[0].state).toBe(
        'legacy_unconfirmed',
      );
      expect(afterExternalMutation.automatic_operations_v1?.operations[0].attempts).toHaveLength(2);
    });

    it('returns only a conflict on owner mismatch and refuses generic import of operational roots', async () => {
      const { owner, input } = ownedEpisode(group, 'turn-privacy');
      const [{ episode: source }] = await storage.appendAutomaticEpisodes!([input]);
      const initial = await storage.observeLegacyAutomaticSource!({
        sourceId: source.uuid,
        expectedOwner: owner,
      });
      expect(initial.status).toBe('observed');
      const before = await storage.exportGraph();
      const mismatchedOwner = { ...owner, actor: 'other-actor' };
      const conflict = await storage.observeLegacyAutomaticSource!({
        sourceId: source.uuid,
        expectedOwner: mismatchedOwner,
      });
      expect(conflict).toEqual({
        status: 'conflict',
        state: null,
        shouldProcess: false,
        attemptAudit: 'not_recorded',
      });
      const afterConflict = await storage.exportGraph();
      expect(afterConflict.automatic_operations_v1).toEqual(before.automatic_operations_v1);
      expect(afterConflict.episodes).toEqual(before.episodes);

      const inspectionBackup = exportQueueBackup(before);
      expect(inspectionBackup.graph.automatic_operations_v1).toEqual(
        before.automatic_operations_v1,
      );
      await expect(storage.importGraph(before)).rejects.toThrow('native_restore_required');
      await expect(
        storage.importExtractionBackup!({
          ...inspectionBackup,
        }),
      ).rejects.toThrow('native_restore_required');
      const afterRejectedImports = await storage.exportGraph();
      expect(afterRejectedImports.automatic_operations_v1).toEqual(before.automatic_operations_v1);
      expect(afterRejectedImports.episodes).toEqual(before.episodes);
    });

    it.each([
      'review_status',
      'previous_episode_uuid',
      'created_at',
      'updated_at',
      'attributes',
    ] as const)(
      'rejects rootless imports changing owned %s without altering current review or ledger',
      async (field) => {
        const { owner, input } = ownedEpisode(group, `turn-import-${field}`);
        const [{ episode: source }] = await storage.appendAutomaticEpisodes!([input]);
        await storage.observeLegacyAutomaticSource!({
          sourceId: source.uuid,
          expectedOwner: owner,
        });
        await storage.updateEpisode(source.uuid, {
          review_status: 'rejected',
          attributes: {
            ...source.attributes,
            review_audit: { operator: 'synthetic-reviewer', decision: 'rejected' },
          },
        });
        const before = await storage.readExtractionSnapshot!(group);
        const changed = structuredClone(
          before.episodes.find((episode) => episode.uuid === source.uuid)!,
        );
        if (field === 'review_status') changed.review_status = 'accepted';
        else if (field === 'previous_episode_uuid') changed.previous_episode_uuid = randomUUID();
        else if (field === 'created_at') changed.created_at = '2001-01-01T00:00:00.000Z';
        else if (field === 'updated_at') changed.updated_at = null;
        else changed.attributes.review_audit = { operator: 'unreviewed-import' };

        await expect(
          storage.importGraph({ ...emptyGraph(group), episodes: [changed] }),
        ).rejects.toThrow('owned_source_import_forbidden');
        const after = await storage.readExtractionSnapshot!(group);
        for (const key of [
          'entities',
          'edges',
          'episodes',
          'metadata',
          'automatic_operations_v1',
        ] as const) {
          expect(after[key]).toEqual(before[key]);
        }
      },
    );

    it('allows an exact owned rootless re-import and new unowned records without stripping the ledger', async () => {
      const { owner, input } = ownedEpisode(group, 'turn-exact-import');
      const [{ episode: source }] = await storage.appendAutomaticEpisodes!([input]);
      await storage.observeLegacyAutomaticSource!({ sourceId: source.uuid, expectedOwner: owner });
      const before = await storage.readExtractionSnapshot!(group);
      await storage.importGraph({ ...emptyGraph(group), episodes: [structuredClone(source)] });
      const exact = await storage.readExtractionSnapshot!(group);
      expect(exact.episodes).toEqual(before.episodes);
      expect(exact.automatic_operations_v1).toEqual(before.automatic_operations_v1);

      const unowned = {
        ...structuredClone(source),
        uuid: randomUUID(),
        content: 'Synthetic ordinary imported conversation',
        source_message_id: randomUUID(),
        idempotency_key: null,
        attributes: {},
      };
      await storage.importGraph({ ...emptyGraph(group), episodes: [unowned] });
      expect(await storage.getEpisode(unowned.uuid)).toMatchObject(unowned);
      const after = await storage.readExtractionSnapshot!(group);
      expect(after.automatic_operations_v1).toEqual(before.automatic_operations_v1);
      expect(after.episodes.find((episode) => episode.uuid === source.uuid)).toEqual(source);
    });

    it('blocks source, predecessor, successor, purge, and clear deletion paths', async () => {
      const predecessor = await storage.appendEpisode({
        group_id: group,
        content: 'Unowned predecessor',
        role: 'human',
        reference_time: timestamp,
      });
      const { owner, input } = ownedEpisode(group, 'turn-chain', predecessor.episode.uuid);
      const [{ episode: source }] = await storage.appendAutomaticEpisodes!([input]);
      const child = await storage.appendEpisode({
        group_id: group,
        content: 'Unowned child',
        role: 'ai',
        reference_time: timestamp,
        previous_episode_uuid: source.uuid,
      });
      await storage.observeLegacyAutomaticSource!({ sourceId: source.uuid, expectedOwner: owner });

      await expect(
        storage.deleteEpisode(predecessor.episode.uuid, { repair_chain: true }),
      ).rejects.toThrow('source_delete_forbidden');
      await expect(
        storage.deleteEpisode(predecessor.episode.uuid, { repair_chain: false }),
      ).rejects.toThrow('source_delete_forbidden');
      await expect(storage.deleteEpisode(child.episode.uuid)).rejects.toThrow(
        'source_delete_forbidden',
      );
      await expect(storage.deleteEpisode(source.uuid)).rejects.toThrow('source_delete_forbidden');
      await expect(
        storage.applyRetention(group, { type: 'max_episodes', value: 2 }),
      ).rejects.toThrow('source_delete_forbidden');
      await expect(
        storage.purgeEpisodes(group, { source_message_id: `message-turn-chain` }, { limit: 1 }),
      ).rejects.toThrow('source_delete_forbidden');
      await expect(storage.clearGroup(group, { allowQueued: true })).rejects.toThrow(
        'source_delete_forbidden',
      );
      await expect(storage.clearAll({ allowQueued: true })).rejects.toThrow(
        'source_delete_forbidden',
      );
      expect((await storage.exportGraph(group)).episodes.map((episode) => episode.uuid)).toEqual(
        expect.arrayContaining([predecessor.episode.uuid, source.uuid, child.episode.uuid]),
      );
    });
  });
}
