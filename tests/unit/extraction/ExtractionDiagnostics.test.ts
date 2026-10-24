import {
  ExtractionDiagnostics,
  ExtractionError,
  reportExtractionError,
} from '../../../src/extraction/ExtractionDiagnostics';
import { ExtractionOutcomeSchema } from '../../../src/schemas';
import { EngramChatMemory } from '../../../src/memory/EngramChatMemory';
import { GraphologyStorage } from '../../../src/storage/GraphologyStorage';

const response = (value: unknown) => ({
  ok: true,
  json: async () => ({ choices: [{ message: { content: JSON.stringify(value) } }] }),
});
const person = { name: 'Alice', entity_type: 'person', summary: 'A person' };
const company = { name: 'Acme', entity_type: 'organization', summary: 'A company' };
const relationship = {
  source_entity: 'Alice',
  target_entity: 'Acme',
  name: 'WORKS_AT',
  fact: 'Alice works at Acme',
};

describe('extraction outcomes', () => {
  let storage: GraphologyStorage;
  let fetchMock: jest.Mock;
  beforeEach(async () => {
    storage = new GraphologyStorage();
    await storage.initialize();
    fetchMock = jest.fn();
    global.fetch = fetchMock;
    jest.spyOn(console, 'warn').mockImplementation();
  });
  afterEach(async () => {
    await storage.close();
    jest.restoreAllMocks();
  });
  const memory = (storage: GraphologyStorage, overrides = {}) =>
    new EngramChatMemory({
      storage,
      groupId: 'test',
      enableExtraction: true,
      llmConfig: {
        apiKey: 'key',
        baseUrl: 'https://example.test',
        model: 'fixed',
        temperature: { mode: 'providerDefault' },
      },
      ...overrides,
    });
  const save = (m: EngramChatMemory) =>
    m.saveContextWithOutcome({ input: 'Hello' }, { output: 'Hi' });

  it('surfaces caught entity errors while preserving the human/assistant pair', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => 'temperature unsupported PRIVATE',
    });
    const outcome = await save(memory(storage));
    expect(outcome.status).toBe('failed');
    expect(outcome.errors[0]).toMatchObject({ stage: 'entities', kind: 'unsupported_parameter' });
    expect(await storage.listEpisodes('test')).toHaveLength(2);
    expect(await storage.listEntities('test')).toHaveLength(0);
    expect(JSON.stringify(outcome)).not.toContain('PRIVATE');
    expect(JSON.stringify((console.warn as jest.Mock).mock.calls)).not.toContain('PRIVATE');
  });

  it.each([null, {}, { entities: null }])(
    'distinguishes invalid top-level payload %j from empty success',
    async (data) => {
      fetchMock.mockResolvedValueOnce(response(data));
      expect((await save(memory(storage))).status).toBe('failed');
      fetchMock.mockResolvedValueOnce(response({ entities: [] }));
      const outcome = await save(memory(storage));
      expect(outcome.status).toBe('succeeded');
      expect(outcome.stages.find((s) => s.stage === 'relationships')).toMatchObject({
        status: 'skipped',
      });
    },
  );

  it('retains valid entries in mixed arrays and filters eligibility separately', async () => {
    fetchMock.mockResolvedValueOnce(
      response({
        entities: [null, 3, person, { ...person, name: 'Other', entity_type: 'unknown' }],
      }),
    );
    const outcome = await save(memory(storage));
    expect(outcome.status).toBe('partial');
    expect(outcome.counts).toMatchObject({ entities_created: 1, malformed: 2, filtered: 1 });
    expect(outcome.stages.find((s) => s.stage === 'relationships')).toMatchObject({
      status: 'skipped',
      reason: 'not_eligible',
    });
  });

  it('reports relationship errors after entity writes as partial', async () => {
    fetchMock
      .mockResolvedValueOnce(response({ entities: [person, company] }))
      .mockResolvedValueOnce(response({ bad: [] }));
    const outcome = await save(memory(storage));
    expect(outcome.status).toBe('partial');
    expect(outcome.counts.entities_created).toBe(2);
    expect(outcome.errors[0]).toMatchObject({ stage: 'relationships', kind: 'invalid_response' });
    for (const [, req] of fetchMock.mock.calls)
      expect(JSON.parse(req.body)).not.toHaveProperty('temperature');
  });

  it('counts confirmed writes only when a later entity write fails', async () => {
    fetchMock.mockResolvedValueOnce(response({ entities: [person, company] }));
    const original = storage.addEntity.bind(storage);
    jest
      .spyOn(storage, 'addEntity')
      .mockImplementationOnce(original)
      .mockRejectedValueOnce(new Error('PRIVATE'));
    const outcome = await save(memory(storage));
    expect(outcome.status).toBe('partial');
    expect(outcome.counts.entities_created).toBe(1);
    expect(outcome.errors[0]).toMatchObject({ kind: 'storage' });
  });

  it('counts expired edges before failed replacement creation', async () => {
    const a = await storage.addEntity({ ...person, group_id: 'test' });
    const b = await storage.addEntity({ ...company, group_id: 'test' });
    await storage.addEdge({
      group_id: 'test',
      source_node_uuid: a.uuid,
      target_node_uuid: b.uuid,
      name: 'WORKS_AT',
      fact: 'Old fact',
    });
    fetchMock
      .mockResolvedValueOnce(response({ entities: [person, company] }))
      .mockResolvedValueOnce(response({ relationships: [relationship] }))
      .mockResolvedValueOnce(response({ is_duplicate: false }))
      .mockResolvedValueOnce(response({ is_contradiction: true, explanation: 'Changed' }));
    jest.spyOn(storage, 'addEdge').mockRejectedValue(new Error('PRIVATE'));
    const outcome = await save(memory(storage));
    expect(outcome.status).toBe('partial');
    expect(outcome.counts).toMatchObject({ edges_expired: 1, edges_created: 0, unchanged: 2 });
  });

  it('does not swallow history persistence errors', async () => {
    jest.spyOn(storage, 'appendEpisodes').mockRejectedValue(new Error('save failed'));
    await expect(save(memory(storage))).rejects.toThrow('save failed');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps disabled, missing configuration, and no-source outcomes distinct', async () => {
    expect((await save(memory(storage, { enableExtraction: false }))).status).toBe('disabled');
    expect((await save(memory(storage, { llmConfig: undefined }))).reason).toBe(
      'missing_configuration',
    );
    expect((await save(memory(storage, { extractHuman: false, extractAi: false }))).reason).toBe(
      'no_sources',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('bounds repeated errors and warning volume, retaining only fixed identifiers', () => {
    const d = new ExtractionDiagnostics();
    for (let i = 0; i < 400; i++) reportExtractionError('embeddings', new Error('PRIVATE'), d);
    const result = d.finish();
    expect(result).toMatchObject({ status: 'partial', error_count: 400, errors_truncated: true });
    expect(result.errors).toHaveLength(20);
    expect(console.warn).toHaveBeenCalledTimes(20);
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    expect(ExtractionOutcomeSchema.safeParse(result).success).toBe(true);
  });

  it('isolates real overlapping extraction runs on the same memory instance', async () => {
    let rejectSlow!: () => void;
    let entered!: () => void;
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    fetchMock.mockImplementation(async (_url, request) => {
      if (request.body.includes('SLOW_SOURCE')) {
        entered();
        await new Promise<void>((resolve) => {
          rejectSlow = resolve;
        });
        return { ok: false, status: 401, text: async () => 'PRIVATE' };
      }
      return response({ entities: [] });
    });
    const m = memory(storage);
    const slow = m.saveContextWithOutcome({ input: 'SLOW_SOURCE' }, { output: 'First' });
    await reached;
    const fast = await m.saveContextWithOutcome({ input: 'FAST_SOURCE' }, { output: 'Second' });
    rejectSlow();
    const failed = await slow;
    expect(fast).toMatchObject({ status: 'succeeded', error_count: 0 });
    expect(failed).toMatchObject({
      status: 'failed',
      error_count: 1,
      errors: [{ stage: 'entities', kind: 'authentication', http_status: 401 }],
    });
    expect(failed.stages.find((s) => s.stage === 'relationships')).toMatchObject({
      reason: 'not_reached',
    });
    expect(await storage.listEpisodes('test')).toHaveLength(4);
  });

  it('required failure takes precedence over optional errors without writes', () => {
    const d = new ExtractionDiagnostics();
    d.error('embeddings', new ExtractionError('network'));
    d.error('entities', new ExtractionError('invalid_response'));
    expect(d.finish().status).toBe('failed');
  });
});

describe('optional stages and record policy', () => {
  let storage: GraphologyStorage;
  let mockFetch: jest.Mock;
  const config = {
    apiKey: 'key',
    baseUrl: 'https://example.test',
    model: 'fixed',
    temperature: { mode: 'providerDefault' as const },
  };
  const makeMemory = (extra = {}) =>
    new EngramChatMemory({
      storage,
      groupId: 'optional',
      enableExtraction: true,
      llmConfig: config,
      ...extra,
    });
  const save = (m: EngramChatMemory) =>
    m.saveContextWithOutcome({ input: 'Human' }, { output: 'Assistant' });
  beforeEach(async () => {
    storage = new GraphologyStorage();
    await storage.initialize();
    mockFetch = jest.fn();
    global.fetch = mockFetch;
    jest.spyOn(console, 'warn').mockImplementation();
  });
  afterEach(async () => {
    await storage.close();
    jest.restoreAllMocks();
  });

  it.each([false, true])(
    'preserves confidence filtering policy with required=%s',
    async (required) => {
      mockFetch.mockResolvedValue(response({ entities: [person] }));
      const result = await save(makeMemory({ requireExtractionConfidence: required }));
      expect(result.status).toBe('succeeded');
      expect(result.counts).toMatchObject({
        entities_created: required ? 0 : 1,
        filtered: required ? 1 : 0,
        malformed: 0,
      });
    },
  );

  it('retains valid relationships in mixed malformed and unknown-reference arrays', async () => {
    mockFetch
      .mockResolvedValueOnce(response({ entities: [person, company] }))
      .mockResolvedValueOnce(
        response({
          relationships: [null, 1, relationship, { ...relationship, target_entity: 'Unknown' }],
        }),
      );
    const result = await save(makeMemory());
    expect(result.status).toBe('partial');
    expect(result.counts).toMatchObject({ edges_created: 1, malformed: 2, filtered: 1 });
  });

  it('makes fuzzy dedup failure observable while retaining its creation fallback', async () => {
    await storage.addEntity({ ...person, name: 'Al', group_id: 'optional' });
    mockFetch
      .mockResolvedValueOnce(response({ entities: [person] }))
      .mockResolvedValueOnce(response({ is_duplicate: 'false', merged_summary: 'PRIVATE' }))
      .mockResolvedValueOnce(response({ relationships: [] }));
    const result = await save(makeMemory());
    expect(result.status).toBe('partial');
    expect(result.errors).toEqual([{ stage: 'entity_dedup', kind: 'invalid_response' }]);
    expect(result.counts.entities_created).toBe(1);
    expect(JSON.stringify((console.warn as jest.Mock).mock.calls)).not.toContain('PRIVATE');
  });

  it.each(['edge_dedup', 'cross_edge_dedup', 'contradictions'])(
    'reports optional %s failure without blind retry',
    async (stage) => {
      const a = await storage.addEntity({ ...person, group_id: 'optional' });
      const b = await storage.addEntity({ ...company, group_id: 'optional' });
      await storage.addEdge({
        group_id: 'optional',
        source_node_uuid: a.uuid,
        target_node_uuid: b.uuid,
        name: stage === 'cross_edge_dedup' ? 'EMPLOYED_BY' : 'WORKS_AT',
        fact: 'PRIVATE old fact',
      });
      mockFetch
        .mockResolvedValueOnce(response({ entities: [person, company] }))
        .mockResolvedValueOnce(response({ relationships: [relationship] }));
      if (stage === 'contradictions')
        mockFetch.mockResolvedValueOnce(response({ is_duplicate: false }));
      mockFetch.mockResolvedValueOnce({ ok: false, status: 503, text: async () => 'PRIVATE' });
      if (stage !== 'contradictions')
        mockFetch.mockResolvedValueOnce(response({ is_contradiction: false }));
      const result = await save(makeMemory());
      expect(result.status).toBe('partial');
      expect(result.errors).toEqual([{ stage, kind: 'provider_server', http_status: 503 }]);
      expect(result.counts.edges_created).toBe(1);
      expect(mockFetch).toHaveBeenCalledTimes(4);
      expect(JSON.stringify(result)).not.toContain('PRIVATE');
      expect(JSON.stringify((console.warn as jest.Mock).mock.calls)).not.toContain('PRIVATE');
      for (const [, request] of mockFetch.mock.calls)
        expect(JSON.parse(request.body)).not.toHaveProperty('temperature');
    },
  );

  it('marks persistence failure when dedup update fails, even if fallback creation succeeds', async () => {
    const a = await storage.addEntity({ ...person, group_id: 'optional' });
    const b = await storage.addEntity({ ...company, group_id: 'optional' });
    await storage.addEdge({
      group_id: 'optional',
      source_node_uuid: a.uuid,
      target_node_uuid: b.uuid,
      name: 'WORKS_AT',
      fact: 'Old fact',
    });
    mockFetch
      .mockResolvedValueOnce(response({ entities: [person, company] }))
      .mockResolvedValueOnce(response({ relationships: [relationship] }))
      .mockResolvedValueOnce(response({ is_duplicate: true, merged_fact: 'Merged fact' }))
      .mockResolvedValueOnce(response({ is_contradiction: false }));
    jest.spyOn(storage, 'updateEdge').mockRejectedValueOnce(new Error('PRIVATE'));
    const result = await save(makeMemory());
    expect(result.status).toBe('partial');
    expect(result.stages.find((s) => s.stage === 'persistence')?.status).toBe('failed');
    expect(result.counts).toMatchObject({ edges_updated: 0, edges_created: 1 });
    expect(result.errors).toEqual([{ stage: 'persistence', kind: 'storage' }]);
    expect(result.error_count).toBe(1);
  });

  it('reports embedding failure without leaking provider text or entity names', async () => {
    mockFetch
      .mockResolvedValueOnce(response({ entities: [{ ...person, name: 'PRIVATE' }] }))
      .mockResolvedValueOnce({ ok: false, status: 401, text: async () => 'PRIVATE' });
    const result = await save(
      makeMemory({
        embeddingConfig: { apiKey: 'key', baseUrl: 'https://example.test', model: 'embed' },
      }),
    );
    expect(result.status).toBe('partial');
    expect(result.errors).toEqual([{ stage: 'embeddings', kind: 'unknown' }]);
    expect(result.counts.entities_created).toBe(1);
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    expect(JSON.stringify((console.warn as jest.Mock).mock.calls)).not.toContain('PRIVATE');
  });

  it('counts metadata-only updates and unchanged dedup distinctly', async () => {
    await storage.addEntity({ ...person, group_id: 'optional' });
    mockFetch.mockResolvedValueOnce(response({ entities: [person] }));
    expect((await save(makeMemory())).counts.unchanged).toBe(1);
    // Newly extracted records have provenance metadata, so later writes update its episode links.
    await storage.clearGroup('optional');
    mockFetch.mockResolvedValueOnce(response({ entities: [person] }));
    await save(makeMemory());
    mockFetch.mockResolvedValueOnce(response({ entities: [person] }));
    const result = await save(makeMemory());
    expect(result.counts).toMatchObject({ entities_created: 0, entities_updated: 1, unchanged: 0 });
  });
});
