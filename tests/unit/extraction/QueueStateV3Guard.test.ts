import { randomUUID } from 'crypto';
import { makeCompositionalCaptureFixture } from '../../helpers/compositionalCaptureFixture';
import {
  applyPlan,
  enqueue,
  graphFingerprint,
  sourceFingerprint,
} from '../../../src/extraction/QueueState';
import {
  EntityNodeSchema,
  EntityEdgeSchema,
  EpisodicNodeSchema,
  StagedExtractionSchema,
} from '../../../src/schemas';
import { ExtractionDiagnostics } from '../../../src/extraction/ExtractionDiagnostics';

describe('legacy queue boundaries for compositional protected sources', () => {
  it.each([
    ['entity', 'engram_claim_v1'],
    ['entity', 'engram_literal_v1'],
    ['edge', 'engram_claim_v1'],
  ])(
    'does not overwrite incomplete %s marker %s when its original source is missing',
    (kind, key) => {
      const { graph, source } = makeCompositionalCaptureFixture();
      const legacy = EpisodicNodeSchema.parse({
        ...source,
        uuid: randomUUID(),
        idempotency_key: null,
        attributes: {},
      });
      graph.episodes = [legacy];
      const value = EntityNodeSchema.parse({
        uuid: randomUUID(),
        group_id: source.group_id,
        name: 'Protected value',
        entity_type: 'preference_value',
        created_at: graph.exported_at,
        updated_at: graph.exported_at,
        attributes: kind === 'entity' ? { [key]: { version: 2 } } : {},
      });
      graph.entities.push(value);
      const edge = EntityEdgeSchema.parse({
        uuid: randomUUID(),
        group_id: source.group_id,
        source_node_uuid: graph.entities[0].uuid,
        target_node_uuid: value.uuid,
        name: 'PREFERS',
        fact: 'Protected assertion',
        episodes: [source.uuid],
        created_at: graph.exported_at,
        updated_at: graph.exported_at,
        attributes: kind === 'edge' ? { [key]: { version: 2 } } : {},
      });
      graph.edges.push(edge);
      const plan = StagedExtractionSchema.parse({
        version: 1,
        group_id: source.group_id,
        graph_hash: graphFingerprint(graph, source.group_id),
        source_guards: [{ uuid: legacy.uuid, hash: sourceFingerprint(legacy) }],
        entities:
          kind === 'entity' ? [{ ...value, name: 'Attempted overwrite', attributes: {} }] : [],
        edges:
          kind === 'edge'
            ? [{ ...edge, fact: 'Attempted overwrite', attributes: {}, episodes: [legacy.uuid] }]
            : [],
        outcome: new ExtractionDiagnostics().finish('disabled'),
      });
      const before = structuredClone(graph);
      expect(() => applyPlan(graph, plan)).toThrow('capture_operation_required');
      expect(graph).toEqual(before);
    },
  );

  it.each([true, false])('cannot enqueue a V3 source, created=%s', (created) => {
    const { graph, source } = makeCompositionalCaptureFixture();
    const before = structuredClone(graph);
    expect(() =>
      enqueue(
        graph,
        [{ episode: source, created }],
        [0],
        { route_id: 'synthetic-route', config_hash: 'a'.repeat(64) },
        { max_jobs: 10, max_namespace_bytes: 1048576, max_store_bytes: 10485760 },
        graph.exported_at,
        randomUUID(),
      ),
    ).toThrow('capture_operation_required');
    expect(graph).toEqual(before);
  });

  it.each([false, true])(
    'rejects legacy extraction from the actual V3 source, queued=%s',
    (queued) => {
      const { graph, source } = makeCompositionalCaptureFixture();
      const plan = StagedExtractionSchema.parse({
        version: 1,
        group_id: source.group_id,
        graph_hash: graphFingerprint(graph, source.group_id),
        source_guards: [{ uuid: source.uuid, hash: sourceFingerprint(source) }],
        entities: [],
        edges: [],
        outcome: new ExtractionDiagnostics().finish('disabled'),
      });
      const before = structuredClone(graph);
      expect(() => applyPlan(graph, plan, queued)).toThrow('capture_operation_required');
      expect(graph).toEqual(before);
    },
  );

  it.each(['entity', 'edge'])(
    'uses stored V3 provenance when a replacement strips %s evidence',
    (kind) => {
      const { graph, source } = makeCompositionalCaptureFixture();
      const legacy = EpisodicNodeSchema.parse({
        ...source,
        uuid: randomUUID(),
        idempotency_key: null,
        attributes: {},
      });
      graph.episodes.push(legacy);
      const value = EntityNodeSchema.parse({
        uuid: randomUUID(),
        group_id: source.group_id,
        name: 'Synthetic preference',
        entity_type: 'preference_value',
        created_at: graph.exported_at,
        updated_at: graph.exported_at,
        attributes: { engram_claim_v1: { version: 2, sourceId: source.uuid } },
      });
      graph.entities.push(value);
      const edge = EntityEdgeSchema.parse({
        uuid: randomUUID(),
        group_id: source.group_id,
        source_node_uuid: graph.entities[0].uuid,
        target_node_uuid: value.uuid,
        name: 'PREFERS',
        fact: 'Synthetic supported claim',
        episodes: [source.uuid],
        created_at: graph.exported_at,
        updated_at: graph.exported_at,
      });
      graph.edges.push(edge);
      const plan = StagedExtractionSchema.parse({
        version: 1,
        group_id: source.group_id,
        graph_hash: graphFingerprint(graph, source.group_id),
        source_guards: [{ uuid: legacy.uuid, hash: sourceFingerprint(legacy) }],
        entities:
          kind === 'entity' ? [{ ...value, name: 'Stripped replacement', attributes: {} }] : [],
        edges:
          kind === 'edge'
            ? [{ ...edge, fact: 'Stripped replacement', episodes: [legacy.uuid], attributes: {} }]
            : [],
        outcome: new ExtractionDiagnostics().finish('disabled'),
      });
      const before = structuredClone(graph);
      expect(() => applyPlan(graph, plan)).toThrow('capture_operation_required');
      expect(graph).toEqual(before);
    },
  );
});
