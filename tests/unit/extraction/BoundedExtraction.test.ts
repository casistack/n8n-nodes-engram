import { randomUUID } from 'crypto';
import { boundedExtract } from '../../../src/extraction/BoundedExtraction';
import { StagedGraph } from '../../../src/extraction/StagedGraph';
import { ExtractionDiagnostics } from '../../../src/extraction/ExtractionDiagnostics';
import { EntityNodeSchema, type GraphData } from '../../../src/schemas';

const group = 'bounded';
const source = {
  content: 'Alder likes cobalt. What games are on today?',
  role: 'human' as const,
  episode_kind: 'active_human' as const,
  episode_uuid: randomUUID(),
  trust_level: 'standard' as const,
  review_status: 'accepted' as const,
  reference_time: '2026-10-24T12:00:00Z',
};
const evidence = [{ source_id: source.episode_uuid, start: 0, end: 19 }];
const config = {
  llm: {
    apiKey: 'PRIVATE',
    baseUrl: 'https://provider.test',
    model: 'fixed',
    temperature: { mode: 'providerDefault' as const },
  },
  policy: { mode: 'bounded' as const, quality: 'durableTemporal' as const },
  types: ['person', 'concept'],
  threshold: { autoAcceptThreshold: 0.85, rejectBelowThreshold: 0.3 },
};
const graph = (): GraphData => ({
  version: '2.0',
  exported_at: '2026-10-24T12:00:00Z',
  entities: [],
  edges: [],
  episodes: [],
});
const candidates = () => ({
  entities: [
    {
      id: 'a',
      name: 'Alder',
      entity_type: 'person',
      summary: 'UNSUPPORTED FULL TURN',
      confidence: 0.99,
      category: 'durable_fact',
      evidence,
    },
    {
      id: 'c',
      name: 'Cobalt',
      entity_type: 'concept',
      summary: '',
      confidence: 0.99,
      category: 'preference',
      evidence,
    },
  ],
  relationships: [
    {
      source_id: 'a',
      target_id: 'c',
      name: 'LIKES',
      fact: 'Alder likes cobalt',
      confidence: 0.99,
      category: 'preference',
      evidence,
    },
  ],
});
const response = (data: unknown) =>
  new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(data) } }] }), {
    headers: { 'content-type': 'application/json' },
  });

describe('bounded source-grounded extraction', () => {
  const original = global.fetch;
  afterEach(() => {
    global.fetch = original;
    jest.restoreAllMocks();
  });
  it('finds an exact match at the end of 10000 entities with no fuzzy calls or graph-sized prompt', async () => {
    const snapshot = graph();
    for (let i = 0; i < 10000; i++)
      snapshot.entities.push(
        EntityNodeSchema.parse({
          uuid: randomUUID(),
          group_id: group,
          name: i === 9999 ? 'Alder' : `Other ${i}`,
          entity_type: 'person',
          created_at: snapshot.exported_at,
          updated_at: snapshot.exported_at,
        }),
      );
    const candidate = candidates();
    candidate.entities = candidate.entities.slice(0, 1);
    candidate.relationships = [];
    global.fetch = jest.fn().mockImplementation(async () => response(candidate));
    const stage = new StagedGraph(snapshot, group),
      diagnostics = new ExtractionDiagnostics();
    await boundedExtract(stage.storage, group, [source], config, diagnostics);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(body).not.toHaveProperty('temperature');
    expect(JSON.stringify(body).length).toBeLessThan(5000);
    expect(stage.plan(diagnostics.finish()).entities).toHaveLength(0);
    expect(
      diagnostics.finish().metrics!.stages.find((s) => s.stage === 'entity_dedup')!.exact_hits,
    ).toBe(1);
  });
  it('keeps a genuine preference while excluding unsupported/question text from accepted summaries', async () => {
    global.fetch = jest.fn().mockImplementation(async () => response(candidates()));
    const stage = new StagedGraph(graph(), group),
      d = new ExtractionDiagnostics();
    await boundedExtract(stage.storage, group, [source], config, d);
    const plan = stage.plan(d.finish());
    expect(plan.edges).toHaveLength(1);
    expect(plan.edges[0].attributes.engram_extraction).toMatchObject({
      review_status: 'accepted',
      episode_uuids: [source.episode_uuid],
    });
    expect(
      plan.entities.every(
        (e) => !e.summary.includes('games') && !e.summary.includes('UNSUPPORTED'),
      ),
    ).toBe(true);
    expect(plan.entities.every((entity) => entity.summary === '')).toBe(true);
  });
  it.each([
    'Can you tell me whether Alder likes cobalt?',
    'It is false that Alder likes cobalt.',
    'Someone said "Alder likes cobalt."',
    'Maybe Alder likes cobalt.',
  ])('does not accept an affirmative substring cut from %s', async (content) => {
    const data = candidates();
    const start = content.indexOf('Alder likes cobalt');
    for (const item of [...data.entities, ...data.relationships])
      item.evidence = [
        { source_id: source.episode_uuid, start, end: start + 'Alder likes cobalt'.length },
      ];
    global.fetch = jest.fn().mockImplementation(async () => response(data));
    const view = new StagedGraph(graph(), group),
      d = new ExtractionDiagnostics();
    await boundedExtract(view.storage, group, [{ ...source, content }], config, d);
    const plan = view.plan(d.finish());
    expect(plan.edges).toHaveLength(1);
    expect(plan.edges[0].attributes.engram_extraction).toMatchObject({ review_status: 'proposed' });
    expect(
      plan.entities.every(
        (entity) => (entity.attributes.engram_extraction as any).review_status === 'proposed',
      ),
    ).toBe(true);
  });
  it.each([
    'The claim that Alder likes cobalt is incorrect.',
    'If Alder likes cobalt, offer a cobalt gift.',
  ])('does not accept a fact nested inside a qualified complete sentence: %s', async (content) => {
    const data = candidates();
    for (const item of [...data.entities, ...data.relationships])
      item.evidence = [{ source_id: source.episode_uuid, start: 0, end: content.length }];
    global.fetch = jest.fn().mockImplementation(async () => response(data));
    const view = new StagedGraph(graph(), group),
      d = new ExtractionDiagnostics();
    await boundedExtract(view.storage, group, [{ ...source, content }], config, d);
    expect(view.plan(d.finish()).edges[0].attributes.engram_extraction).toMatchObject({
      review_status: 'proposed',
    });
  });
  it('does not promote temporary questions despite confidence 0.99', async () => {
    const data = candidates();
    for (const item of [...data.entities, ...data.relationships])
      item.category = 'conversational_request';
    global.fetch = jest.fn().mockImplementation(async () => response(data));
    const stage = new StagedGraph(graph(), group),
      d = new ExtractionDiagnostics();
    await boundedExtract(stage.storage, group, [source], config, d);
    expect(stage.plan(d.finish())).toMatchObject({ entities: [], edges: [] });
  });
  it('keeps a complete conditional proposed even when the proposed fact repeats it literally', async () => {
    const content = 'If Alder likes cobalt, I would buy a gift.';
    const data = candidates();
    data.relationships[0].fact = content;
    for (const item of [...data.entities, ...data.relationships])
      item.evidence = [{ source_id: source.episode_uuid, start: 0, end: content.length }];
    global.fetch = jest.fn().mockImplementation(async () => response(data));
    const view = new StagedGraph(graph(), group),
      d = new ExtractionDiagnostics();
    await boundedExtract(view.storage, group, [{ ...source, content }], config, d);
    expect(view.plan(d.finish()).edges[0].attributes.engram_extraction).toMatchObject({
      review_status: 'proposed',
    });
  });
  it('respects a zero fuzzy-call budget and leaves unresolved identities proposed', async () => {
    const snapshot = graph();
    for (let i = 0; i < 20; i++)
      snapshot.entities.push(
        EntityNodeSchema.parse({
          uuid: randomUUID(),
          group_id: group,
          name: `Other ${i}`,
          entity_type: 'person',
          created_at: snapshot.exported_at,
          updated_at: snapshot.exported_at,
        }),
      );
    const data = candidates();
    data.entities = data.entities.slice(0, 1);
    data.relationships = [];
    global.fetch = jest.fn().mockImplementation(async () => response(data));
    const stage = new StagedGraph(snapshot, group),
      d = new ExtractionDiagnostics();
    await boundedExtract(
      stage.storage,
      group,
      [source],
      { ...config, policy: { ...config.policy, fuzzy_calls: 0 } },
      d,
    );
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(stage.plan(d.finish()).entities[0].attributes.engram_extraction).toMatchObject({
      review_status: 'proposed',
    });
    expect(d.finish().metrics!.stages.find((s) => s.stage === 'entity_dedup')).toMatchObject({
      shortlisted: 8,
      pruned: 12,
      unresolved: 1,
    });
  });
  it('rejects malformed/oversized HTTP results before allocating or applying arbitrary candidates', async () => {
    global.fetch = jest.fn().mockResolvedValue(new Response('x'.repeat(270000)));
    jest.spyOn(console, 'warn').mockImplementation();
    const stage = new StagedGraph(graph(), group),
      d = new ExtractionDiagnostics();
    await boundedExtract(stage.storage, group, [source], config, d);
    expect(d.finish()).toMatchObject({
      status: 'failed',
      errors: [{ stage: 'entities', kind: 'budget_exhausted' }],
    });
    expect(stage.plan(d.finish()).entities).toEqual([]);
  });
  it('does not treat fabricated spans or assistant evidence as accepted human knowledge', async () => {
    const data = candidates();
    data.entities[0].evidence = [{ ...evidence[0], end: 9999 }];
    data.relationships[0].evidence = [{ ...evidence[0], end: 9999 }];
    global.fetch = jest.fn().mockImplementation(async () => response(data));
    const stage = new StagedGraph(graph(), group),
      d = new ExtractionDiagnostics();
    await boundedExtract(stage.storage, group, [source], config, d);
    expect(stage.plan(d.finish()).edges).toEqual([]);
    expect(stage.plan(d.finish()).entities).toHaveLength(1);
  });
  it('does not auto-accept a mixed full-turn span even when the model labels it durable', async () => {
    const data = candidates();
    for (const item of [...data.entities, ...data.relationships])
      item.evidence = [{ ...evidence[0], end: source.content.length }];
    global.fetch = jest.fn().mockImplementation(async () => response(data));
    const view = new StagedGraph(graph(), group),
      d = new ExtractionDiagnostics();
    await boundedExtract(view.storage, group, [source], config, d);
    const plan = view.plan(d.finish());
    expect(plan.entities.every((entity) => entity.summary === '')).toBe(true);
    expect(plan.edges[0].attributes.engram_extraction).toMatchObject({ review_status: 'proposed' });
  });
  it.each([
    { trust_level: 'unverified' as const },
    { review_status: 'proposed' as const },
    { trust_level: undefined, review_status: undefined },
  ])('does not elevate uncertain source authority %j', async (change) => {
    global.fetch = jest.fn().mockImplementation(async () => response(candidates()));
    const view = new StagedGraph(graph(), group),
      d = new ExtractionDiagnostics();
    await boundedExtract(view.storage, group, [{ ...source, ...change }], config, d);
    expect(view.plan(d.finish()).edges[0].attributes.engram_extraction).toMatchObject({
      review_status: 'proposed',
    });
  });
  it('preserves an unresolved endpoint on a later exact-name turn', async () => {
    const snapshot = graph();
    snapshot.entities.push(
      EntityNodeSchema.parse({
        uuid: randomUUID(),
        group_id: group,
        name: 'Alder',
        entity_type: 'person',
        created_at: snapshot.exported_at,
        updated_at: snapshot.exported_at,
        attributes: {
          engram_extraction: {
            version: 2,
            source: 'llm',
            confidence: 0.99,
            review_status: 'proposed',
            threshold_decision: 'pending_review',
            extracted_at: snapshot.exported_at,
            episode_uuids: [],
          },
          engram_resolution: { version: 1, status: 'unresolved' },
        },
      }),
    );
    global.fetch = jest.fn().mockImplementation(async () => response(candidates()));
    const view = new StagedGraph(snapshot, group),
      d = new ExtractionDiagnostics();
    await boundedExtract(view.storage, group, [source], config, d);
    expect(view.plan(d.finish()).edges[0].attributes.engram_extraction).toMatchObject({
      review_status: 'proposed',
    });
  });
});
