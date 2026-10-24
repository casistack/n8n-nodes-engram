import { ExtractionDiagnostics } from '../../../src/extraction/ExtractionDiagnostics';
import { ExtractionOutcomeSchema } from '../../../src/schemas';
import { EngramChatMemory } from '../../../src/memory/EngramChatMemory';
import { GraphologyStorage } from '../../../src/storage/GraphologyStorage';
import { EntityExtractor } from '../../../src/extraction/EntityExtractor';
import { EntityDeduplicator } from '../../../src/extraction/EntityDeduplicator';
import { EmbeddingService } from '../../../src/embeddings/EmbeddingService';
import { LlmClient } from '../../../src/extraction/LlmClient';

const config = {
  apiKey: 'PRIVATE_KEY',
  baseUrl: 'https://private.test',
  model: 'PRIVATE_MODEL',
  temperature: { mode: 'providerDefault' as const },
};
const reply = (value: unknown, usage?: unknown) => ({
  ok: true,
  json: async () => ({
    choices: [{ message: { content: JSON.stringify(value) } }],
    usage,
  }),
});

describe('invocation-local extraction metrics', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('reports the actual stage for every model call, exact hits, tokens and confirmed storage', async () => {
    const storage = new GraphologyStorage();
    await storage.initialize();
    await storage.addEntity({
      group_id: 'PRIVATE_GROUP',
      name: 'PRIVATE_PERSON',
      entity_type: 'person',
    });
    const responses = [
      {
        entities: [
          { name: 'PRIVATE_PERSON', entity_type: 'person', summary: '', confidence: 1 },
          { name: 'PRIVATE_ORG', entity_type: 'organization', summary: '', confidence: 1 },
        ],
      },
      {
        relationships: [
          {
            source_entity: 'PRIVATE_PERSON',
            target_entity: 'PRIVATE_ORG',
            name: 'LIKES',
            fact: 'PRIVATE_FACT',
            confidence: 1,
          },
        ],
      },
    ];
    global.fetch = jest.fn().mockImplementation(async () =>
      reply(responses.shift(), {
        prompt_tokens: 4,
        completion_tokens: 2,
        total_tokens: 6,
      }),
    );
    const memory = new EngramChatMemory({
      storage,
      groupId: 'PRIVATE_GROUP',
      enableExtraction: true,
      llmConfig: config,
    });
    const outcome = await memory.saveContextWithOutcome(
      { input: 'PRIVATE_INPUT' },
      { output: 'PRIVATE_OUTPUT' },
    );
    const stage = (name: string) => outcome.metrics!.stages.find((item) => item.stage === name)!;
    expect(outcome.status).toBe('succeeded');
    expect(stage('entities').requests).toMatchObject({
      attempted: 1,
      completed: 1,
      failed: 0,
      in_flight: 0,
      usage_valid: 1,
      input_tokens: 4,
      output_tokens: 2,
      total_tokens: 6,
    });
    expect(stage('relationships').requests.completed).toBe(1);
    expect(stage('entity_dedup')).toMatchObject({ candidates: 1, exact_hits: 1 });
    expect(stage('persistence').operations).toBeGreaterThan(0);
    expect(stage('entity_dedup').requests.attempted).toBe(0);
    expect(outcome.metrics!.storage_breakdown).toMatchObject({
      operations: 2,
      unconfirmed: 0,
      snapshot_write_ms: null,
      transaction_ms: null,
    });
    expect(ExtractionOutcomeSchema.parse(outcome).metrics).toEqual(outcome.metrics);
    expect(JSON.stringify(outcome.metrics)).not.toContain('PRIVATE');
    await storage.close();
  });

  it.each([
    undefined,
    { prompt_tokens: -1, completion_tokens: 2, total_tokens: 1 },
    { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
  ])('validates usage sample %j', async (usage) => {
    const d = new ExtractionDiagnostics();
    global.fetch = jest.fn().mockResolvedValue(reply({}, usage));
    await new LlmClient(config, d, 'contradictions').chatJson([
      { role: 'user', content: 'PRIVATE' },
    ]);
    const requests = d
      .finish()
      .metrics!.stages.find((item) => item.stage === 'contradictions')!.requests;
    expect(requests.usage_missing).toBe(usage === undefined ? 1 : 0);
    expect(requests.usage_invalid).toBe(usage && usage.prompt_tokens < 0 ? 1 : 0);
    expect(requests.usage_valid).toBe(usage && usage.prompt_tokens > 0 ? 1 : 0);
  });

  it('isolates overlapping calls and reports in-flight snapshots without closing collectors', async () => {
    const first = new ExtractionDiagnostics(),
      second = new ExtractionDiagnostics();
    const a = first.beginRequest('entities');
    const before = first.finish();
    expect(before.metrics!.stages[0].requests.in_flight).toBe(1);
    const b = second.beginRequest('entities');
    b.headers();
    b.end('completed');
    a.end('failed');
    a.end('completed');
    expect(first.finish().metrics!.stages[0].requests).toMatchObject({
      attempted: 1,
      failed: 1,
      completed: 0,
      in_flight: 0,
    });
    expect(second.finish().metrics!.stages[0].requests).toMatchObject({
      attempted: 1,
      completed: 1,
    });
    expect(first.finish().metrics!.operation_id).not.toBe(second.finish().metrics!.operation_id);
    expect(before.metrics!.stages[0].requests.in_flight).toBe(1);
  });

  it('distinguishes body-read timeout from successful transport without retaining errors', async () => {
    const d = new ExtractionDiagnostics();
    global.fetch = jest.fn().mockImplementation(async (_url, request) => ({
      ok: true,
      json: () =>
        new Promise((_resolve, reject) =>
          request.signal.addEventListener('abort', () => reject(new Error('PRIVATE'))),
        ),
    }));
    await expect(
      new LlmClient({ ...config, timeoutMs: 10 }, d, 'relationships').chatJson([]),
    ).rejects.toMatchObject({ kind: 'timeout' });
    const metrics = d.finish().metrics!;
    expect(metrics.stages.find((item) => item.stage === 'relationships')!.requests).toMatchObject({
      attempted: 1,
      cancelled: 1,
      completed: 0,
      in_flight: 0,
    });
    expect(JSON.stringify(metrics)).not.toContain('PRIVATE');
  });
  it('measures the exact path without a request', async () => {
    const d = new ExtractionDiagnostics();
    global.fetch = jest.fn();
    const entity = { name: 'Exact', summary: '', entity_type: 'person' };
    await new EntityDeduplicator(new LlmClient(config, d, 'entity_dedup'), d).isDuplicate(
      entity,
      entity,
    );
    expect(d.finish().metrics!.stages.find((s) => s.stage === 'entity_dedup')).toMatchObject({
      operations: 1,
      operation_failures: 0,
      exact_hits: 1,
      requests: { attempted: 0 },
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it.each(['PRIVATE_INVALID_JSON', JSON.stringify({ entities: null })])(
    'tracks stage failure after a completed HTTP request',
    async (content) => {
      const d = new ExtractionDiagnostics();
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ choices: [{ message: { content } }] }),
      });
      jest.spyOn(console, 'warn').mockImplementation();
      await new EntityExtractor(new LlmClient(config, d, 'entities'), d).extract(
        'source',
        '',
        [],
        [],
      );
      expect(d.finish().metrics!.stages[0]).toMatchObject({
        operations: 1,
        operation_failures: 1,
        requests: { completed: 1, failed: 0 },
      });
    },
  );

  it('counts a single overlapping operation failure on the same collector', () => {
    const d = new ExtractionDiagnostics();
    const a = d.begin('entities'),
      b = d.begin('entities');
    b(true);
    a(false);
    expect(d.finish().metrics!.stages[0]).toMatchObject({ operations: 2, operation_failures: 1 });
  });

  it('records malformed embedding items as operation failures after transport completed', async () => {
    const d = new ExtractionDiagnostics();
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [null] }) });
    await expect(new EmbeddingService(config, d).embed('PRIVATE')).rejects.toThrow();
    expect(d.finish().metrics!.stages.find((s) => s.stage === 'embeddings')).toMatchObject({
      operations: 1,
      operation_failures: 1,
      requests: { completed: 1 },
    });
  });

  it('keeps embedding body reads within the timeout and ends the operation', async () => {
    const d = new ExtractionDiagnostics();
    global.fetch = jest.fn().mockImplementation(async (_url, req) => ({
      ok: true,
      json: () =>
        new Promise((_resolve, reject) =>
          req.signal.addEventListener('abort', () => reject(new Error('PRIVATE'))),
        ),
    }));
    await expect(
      new EmbeddingService({ ...config, timeoutMs: 10 }, d).embed('PRIVATE'),
    ).rejects.toThrow();
    expect(d.finish().metrics!.stages.find((s) => s.stage === 'embeddings')).toMatchObject({
      operations: 1,
      operation_failures: 1,
      requests: { cancelled: 1, in_flight: 0 },
    });
  });
});
