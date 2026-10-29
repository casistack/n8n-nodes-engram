import { randomUUID } from 'crypto';
import { makeCompositionalCaptureFixture } from '../../helpers/compositionalCaptureFixture';
import { applyPlan, graphFingerprint, sourceFingerprint } from '../../../src/extraction/QueueState';
import {
  EntityEdgeSchema,
  EntityNodeSchema,
  EpisodicNodeSchema,
  StagedExtractionSchema,
} from '../../../src/schemas';
import { ExtractionDiagnostics } from '../../../src/extraction/ExtractionDiagnostics';

describe('legacy queue boundaries for V3 claim markers', () => {
  it.each([
    ['entity', 'engram_claim_v1'],
    ['entity', 'engram_literal_v1'],
    ['edge', 'engram_claim_v1'],
    ['edge', 'engram_literal_v1'],
  ] as const)(
    'does not overwrite a V3 %s marker %s when its source row is missing',
    (kind, key) => {
      const { graph, source } = makeCompositionalCaptureFixture();
      const orphanedV3SourceId = source.uuid;
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
        attributes:
          kind === 'entity' ? { [key]: { version: 3, sourceId: orphanedV3SourceId } } : {},
      });
      graph.entities.push(value);

      const edge = EntityEdgeSchema.parse({
        uuid: randomUUID(),
        group_id: source.group_id,
        source_node_uuid: graph.entities[0].uuid,
        target_node_uuid: value.uuid,
        name: 'PREFERS',
        fact: 'Protected assertion',
        episodes: [orphanedV3SourceId],
        created_at: graph.exported_at,
        updated_at: graph.exported_at,
        attributes: kind === 'edge' ? { [key]: { version: 3, sourceId: orphanedV3SourceId } } : {},
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
});
