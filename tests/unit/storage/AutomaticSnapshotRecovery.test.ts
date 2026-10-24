import { copyFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { compileAutomaticPolicy } from '../../../src/extraction/AutomaticEvidence';
import { processExtractionJobs } from '../../../src/extraction/DurableExtraction';
import { AUTOMATIC_OWNER, AUTOMATIC_CLAIM } from '../../../src/extraction/AutomaticClaims';
import { jobs } from '../../../src/extraction/QueueState';
import { EngramChatMemory, type EngramChatMemoryInput } from '../../../src/memory/EngramChatMemory';
import { GraphologyStorage } from '../../../src/storage/GraphologyStorage';
import { BINDINGS_ATTRIBUTE, WRITE_OWNER_ATTRIBUTE } from '../../../src/storage/AutomaticIdentity';
import { extractionMetadataFromAttributes } from '../../../src/schemas/ExtractionMetadata.schema';

jest.setTimeout(30000);

describe('automatic identity and source recovery from a copied embedded snapshot', () => {
  const namespace = `snapshot-recovery-${randomUUID()}`;
  const routeId = 'snapshot-recovery-route';
  const storeIdentity = 'a'.repeat(64);
  const actor = {
    namespace,
    issuer: 'snapshot-test-app',
    actorReference: 'verified-snapshot-actor',
  };
  const llm = {
    apiKey: 'synthetic-only',
    baseUrl: 'https://provider.invalid/v1',
    model: 'unused',
  };
  const automaticPolicy = compileAutomaticPolicy({ profileId: 'conservative' });
  let directory: string;
  let sourcePath: string;
  let recoveryPath: string;
  let storage: GraphologyStorage;

  function makeFields(turnId: string, identity = storeIdentity): EngramChatMemoryInput {
    return {
      storage,
      groupId: namespace,
      enableExtraction: true,
      llmConfig: llm,
      extractAi: false,
      extractSystemTool: false,
      extractionPolicy: { mode: 'bounded', quality: 'durableTemporal' },
      extractionExecution: 'durable',
      extractionRouteId: routeId,
      policy: {
        finalTurnWrites: true,
        storeToolAudit: true,
        historyFilter: 'provenance',
      },
      automaticMemory: {
        profileId: 'conservative',
        actor,
        turnId,
        storeIdentity: identity,
      },
    };
  }

  const acceptedTurn = [
    new HumanMessage('I prefer bullet points.'),
    new AIMessage('I will use bullet points.'),
  ];
  const pendingTurn = [
    new HumanMessage('I like concise explanations.'),
    new AIMessage('I will keep explanations concise.'),
  ];

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'engram-automatic-recovery-'));
    sourcePath = join(directory, 'source.json');
    recoveryPath = join(directory, 'recovered-copy.json');
    storage = new GraphologyStorage(sourcePath);
    await storage.initialize();
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('No provider requests permitted'));
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await storage.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('restores bindings, accepted claims, source ownership, and a pending queue job, then replays both roles without new IDs', async () => {
    const subject = await storage.addEntity({
      group_id: namespace,
      name: 'Recovery subject',
      entity_type: 'person',
      attributes: {
        engram_extraction: {
          version: 2,
          source: 'manual',
          confidence: null,
          review_status: 'accepted',
          threshold_decision: 'manually_reviewed',
          extracted_at: new Date().toISOString(),
          episode_uuids: [],
          reviewed_at: new Date().toISOString(),
          reviewed_by: 'snapshot-recovery-test',
        },
      },
    });
    const originalBinding = await storage.automaticBindingCommand!({
      action: 'create',
      namespace,
      issuer: actor.issuer,
      actorReference: actor.actorReference,
      subjectId: subject.uuid,
      authorizedBy: 'snapshot-recovery-test',
      reason: 'Synthetic verified application identity',
    });

    const firstWrite = await new EngramChatMemory(
      makeFields('accepted-turn'),
    ).saveMessagesWithDelivery(acceptedTurn);
    expect('delivery' in firstWrite).toBe(true);
    const firstSnapshot = await storage.readExtractionSnapshot(namespace);
    const firstSources = firstSnapshot.episodes.filter((episode) => {
      const owner = episode.attributes[WRITE_OWNER_ATTRIBUTE] as { turn?: string } | undefined;
      return owner?.turn === 'accepted-turn';
    });
    expect(firstSources.map((episode) => episode.role).sort()).toEqual(['ai', 'human']);
    const originalSourceIds = firstSources.map((episode) => episode.uuid).sort();

    const config = {
      llm,
      policy: { mode: 'bounded' as const, quality: 'durableTemporal' as const },
      types: ['person', 'organization', 'location', 'concept', 'event'],
      automaticPolicy,
    };
    const firstProcessed = await processExtractionJobs(storage, namespace, routeId, config);
    expect(firstProcessed[0]?.state).toBe('completed');
    const beforeCopy = await storage.readExtractionSnapshot(namespace);
    const acceptedEdges = beforeCopy.edges.filter(
      (edge) => edge.attributes[AUTOMATIC_CLAIM] !== undefined,
    );
    expect(acceptedEdges).toHaveLength(1);
    expect(extractionMetadataFromAttributes(acceptedEdges[0].attributes)?.review_status).toBe(
      'accepted',
    );

    await new EngramChatMemory(makeFields('pending-turn')).saveMessagesWithDelivery(pendingTurn);
    const pendingSnapshot = await storage.readExtractionSnapshot(namespace);
    const pendingOwner = pendingSnapshot.episodes.find((episode) => {
      const owner = episode.attributes[WRITE_OWNER_ATTRIBUTE] as
        | { turn?: string; role?: string }
        | undefined;
      return owner?.turn === 'pending-turn' && owner.role === 'human';
    });
    expect(pendingOwner).toBeDefined();
    const pendingJobs = jobs(pendingSnapshot).filter((job) => job.state === 'pending');
    expect(pendingJobs).toHaveLength(1);
    const pendingJobId = pendingJobs[0].uuid;

    await storage.close();
    copyFileSync(sourcePath, recoveryPath);
    storage = new GraphologyStorage(recoveryPath);
    await storage.initialize();

    const recovered = await storage.readExtractionSnapshot(namespace);
    expect(
      recovered.entities.find((entity) => entity.uuid === subject.uuid)?.attributes[
        BINDINGS_ATTRIBUTE
      ],
    ).toEqual([originalBinding]);
    expect(recovered.edges.map((edge) => edge.uuid).sort()).toEqual(
      beforeCopy.edges.map((edge) => edge.uuid).sort(),
    );
    expect(
      recovered.episodes.filter((episode) => originalSourceIds.includes(episode.uuid)),
    ).toHaveLength(2);
    for (const episode of recovered.episodes.filter((item) =>
      originalSourceIds.includes(item.uuid),
    )) {
      expect(episode.attributes[WRITE_OWNER_ATTRIBUTE]).toBeDefined();
      expect(episode.attributes[AUTOMATIC_OWNER]).toEqual(
        episode.attributes[WRITE_OWNER_ATTRIBUTE],
      );
    }
    expect(jobs(recovered).find((job) => job.uuid === pendingJobId)?.state).toBe('pending');

    const recoveredProcess = await processExtractionJobs(storage, namespace, routeId, config);
    expect(recoveredProcess.map((job) => job.job_uuid)).toContain(pendingJobId);
    expect(recoveredProcess.find((job) => job.job_uuid === pendingJobId)?.state).toBe('completed');
    expect(await processExtractionJobs(storage, namespace, routeId, config)).toEqual([]);
    expect(
      (await storage.readExtractionSnapshot(namespace)).edges.filter(
        (edge) => edge.attributes[AUTOMATIC_CLAIM] !== undefined,
      ),
    ).toHaveLength(2);

    const recoveredIds = (await storage.readExtractionSnapshot(namespace)).episodes
      .map((episode) => episode.uuid)
      .sort();
    const replay = await new EngramChatMemory(makeFields('accepted-turn')).saveMessagesWithDelivery(
      acceptedTurn,
    );
    expect(replay).toMatchObject({ written: 0, duplicates: 2 });
    expect(
      (await storage.readExtractionSnapshot(namespace)).episodes
        .map((episode) => episode.uuid)
        .sort(),
    ).toEqual(recoveredIds);
    await expect(
      new EngramChatMemory(makeFields('accepted-turn', 'b'.repeat(64))).saveMessagesWithDelivery(
        acceptedTurn,
      ),
    ).rejects.toThrow('owned_source_mismatch');
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
