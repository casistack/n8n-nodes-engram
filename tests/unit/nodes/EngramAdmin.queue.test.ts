import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import type { IExecuteFunctions } from 'n8n-workflow';
import { EngramAdmin } from '../../../src/nodes/EngramAdmin/EngramAdmin.node';
import * as factory from '../../../src/storage/StorageFactory';
import { GraphologyStorage } from '../../../src/storage/GraphologyStorage';
import type { IGraphStorage } from '../../../src/storage/IGraphStorage';
import {
  EpisodicNodeSchema,
  ExtractionJobSchema,
  type GraphData,
  QueueLimitsSchema,
} from '../../../src/schemas';
import {
  QUEUE_ATTRIBUTE,
  sourceFingerprint,
  exportQueueBackup,
} from '../../../src/extraction/QueueState';
import { queueBinding } from '../../../src/extraction/DurableExtraction';
const rawGroup = ' existing namespace  ';
const settings = {
  llm: {
    apiKey: 'synthetic',
    baseUrl: 'https://provider.test',
    model: 'fixed',
    temperature: { mode: 'providerDefault' as const },
  },
  policy: { mode: 'bounded' as const, quality: 'durableTemporal' as const },
  types: ['person', 'concept'],
  threshold: { autoAcceptThreshold: 0.85, rejectBelowThreshold: 0.3 },
};
const binding = queueBinding('local', settings);
function snapshot(count = 0): GraphData {
  const data: GraphData = {
    version: '2.0',
    exported_at: '2026-10-24T12:00:00Z',
    group_id: rawGroup,
    entities: [],
    edges: [],
    episodes: [],
  };
  for (let i = 0; i < count; i++) {
    const ep = EpisodicNodeSchema.parse({
      uuid: randomUUID(),
      group_id: rawGroup,
      role: 'human',
      episode_kind: 'active_human',
      content: 'Alder likes cobalt.',
      trust_level: 'standard',
      review_status: 'accepted',
      reference_time: data.exported_at,
      created_at: data.exported_at,
    });
    const job = ExtractionJobSchema.parse({
      version: 1,
      uuid: randomUUID(),
      group_id: rawGroup,
      binding,
      sources: [{ uuid: ep.uuid, hash: sourceFingerprint(ep) }],
      state: i === count - 1 ? 'failed' : 'completed',
      created_at: data.exported_at,
      updated_at: data.exported_at,
      available_at: data.exported_at,
    });
    ep.attributes[QUEUE_ATTRIBUTE] = {
      version: 1,
      owner_job_uuid: job.uuid,
      source_hash: sourceFingerprint(ep),
      job,
    };
    data.episodes.push(ep);
  }
  return data;
}
describe('Admin durable queue operations', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'engram-admin-queue-'));
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });
  function context(params: Record<string, unknown> = {}) {
    const values: Record<string, unknown> = {
      backend: 'embedded',
      resource: 'extractionQueue',
      operation: 'queueStatus',
      customStoragePath: dir,
      queueStorageWorkflowId: 'producer',
      queueGroupId: rawGroup,
      queueModel: 'fixed',
      extractionRouteId: 'local',
      queueTemperatureMode: 'providerDefault',
      queueEntityTypes: 'person, concept',
      advancedExtractionPolicy: 'bounded',
      knowledgeSelection: 'durableTemporal',
      ...params,
    };
    return {
      getInputData: () => [{ json: {} }],
      getNodeParameter: (name: string, _index: number, fallback: unknown) =>
        name in values ? values[name] : fallback,
      getWorkflow: () => ({ id: 'separate-worker' }),
      getNode: () => ({ name: 'Queue Admin', typeVersion: 2 }),
      getCredentials: async () => ({
        apiKey: 'synthetic',
        baseUrl: 'https://provider.test',
        uri: 'bolt://127.0.0.1:17687',
        username: 'neo4j',
        password: 'synthetic',
      }),
      logger: { warn: jest.fn(), info: jest.fn() },
      getWorkflowStaticData: () => ({}),
    } as unknown as IExecuteFunctions;
  }
  it('preserves exact whitespace namespaces and selects the producer file for a separate worker', async () => {
    await writeFile(join(dir, 'producer-engram.json'), '{}');
    const read = jest.fn().mockResolvedValue(snapshot());
    const store = {
      initialize: async () => {},
      close: async () => {},
      readExtractionSnapshot: read,
      extractionQueueCommand: jest.fn(),
    } as unknown as IGraphStorage;
    const create = jest.spyOn(factory, 'createStorage').mockReturnValue(store);
    await new EngramAdmin().execute.call(context());
    expect(read).toHaveBeenCalledWith(rawGroup);
    expect(create).toHaveBeenCalledWith({
      backend: 'embedded',
      persistPath: join(dir, 'producer-engram.json'),
    });
  });
  it('claims the exact namespace on the real worker entry point', async () => {
    await writeFile(join(dir, 'producer-engram.json'), '{}');
    const command = jest
      .fn()
      .mockResolvedValue({ job: null, pending: 0, failed: 0, oldest_pending_at: null });
    jest.spyOn(factory, 'createStorage').mockReturnValue({
      initialize: async () => {},
      close: async () => {},
      supportsDurableExtraction: () => true,
      readExtractionSnapshot: async () => snapshot(),
      extractionQueueCommand: command,
    } as unknown as IGraphStorage);
    await new EngramAdmin().execute.call(context({ operation: 'queueProcess' }));
    expect(command.mock.calls[0][0]).toMatchObject({ action: 'claim', group_id: rawGroup });
  });
  it('puts a failed job before more than 100 completed jobs in bounded status output', async () => {
    await writeFile(join(dir, 'producer-engram.json'), '{}');
    const data = snapshot(106);
    const expected = (data.episodes[105].attributes[QUEUE_ATTRIBUTE] as any).job.uuid;
    jest.spyOn(factory, 'createStorage').mockReturnValue({
      initialize: async () => {},
      readExtractionSnapshot: async () => data,
      extractionQueueCommand: jest.fn(),
    } as unknown as IGraphStorage);
    const result = await new EngramAdmin().execute.call(context());
    expect(result[0][0].json).toMatchObject({ failed: 1, truncated: true });
    expect((result[0][0].json.jobs as Array<{ uuid: string; state: string }>)[0]).toMatchObject({
      uuid: expected,
      state: 'failed',
    });
    expect(result[0][0].json.jobs).toHaveLength(100);
  });
  it('refuses a missing producer store rather than initializing a different worker store', async () => {
    const create = jest.spyOn(factory, 'createStorage');
    await expect(new EngramAdmin().execute.call(context())).rejects.toThrow(
      'Producer memory store not found',
    );
    expect(create).not.toHaveBeenCalled();
  });
  it('only creates an explicitly reviewed import destination and imports jobs paused', async () => {
    const sourcePath = join(dir, 'original.json');
    const source = new GraphologyStorage(sourcePath);
    await source.initialize();
    const inputs = [
      {
        group_id: rawGroup,
        role: 'human' as const,
        episode_kind: 'active_human' as const,
        content: 'Alder likes cobalt.',
        reference_time: '2026-10-24T12:00:00Z',
        trust_level: 'standard' as const,
        review_status: 'accepted' as const,
      },
    ];
    await source.appendEpisodesWithExtraction(inputs, [0], binding, QueueLimitsSchema.parse({}));
    const backup = exportQueueBackup(await source.readExtractionSnapshot(rawGroup));
    await source.close();
    const destination = join(dir, 'fresh');
    const params = {
      operation: 'queueImport',
      customStoragePath: destination,
      queueBackup: backup,
    };
    await expect(new EngramAdmin().execute.call(context(params))).rejects.toThrow(
      'Producer memory store not found',
    );
    const result = await new EngramAdmin().execute.call(
      context({ ...params, queueImportCreate: 'enabled' }),
    );
    expect(result[0][0].json).toMatchObject({ imported: true, paused: true });
    const restored = new GraphologyStorage(join(destination, 'producer-engram.json'));
    await restored.initialize();
    try {
      const data = await restored.readExtractionSnapshot(rawGroup);
      expect(data.episodes[0].group_id).toBe(rawGroup);
      expect((data.episodes[0].attributes[QUEUE_ATTRIBUTE] as any).job.state).toBe('paused');
    } finally {
      await restored.close();
    }
  });
});
