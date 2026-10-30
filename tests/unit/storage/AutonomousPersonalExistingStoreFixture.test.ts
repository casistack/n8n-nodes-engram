import * as fs from 'node:fs';
import { GraphDataSchema } from '../../../src/schemas/GraphData.schema';
import { GraphologyStorage } from '../../../src/storage/GraphologyStorage';
import {
  buildAutonomousPersonalExistingStoreFixture,
  createAutonomousPersonalPersistedExistingStoreFixture,
} from '../../helpers/autonomousPersonalExistingStoreFixture';

function sortedRows<T extends { uuid: string }>(rows: readonly T[]): T[] {
  return [...rows].sort((left, right) => left.uuid.localeCompare(right.uuid));
}

describe('synthetic ordinary existing-store fixture', () => {
  it('builds repeatable 1x graph data with coherent row IDs, source fields, chains, and edges', () => {
    const first = buildAutonomousPersonalExistingStoreFixture();
    const second = buildAutonomousPersonalExistingStoreFixture();
    const graph = GraphDataSchema.parse(first.graph);
    const episodeById = new Map(graph.episodes.map((episode) => [episode.uuid, episode]));
    const entityById = new Map(graph.entities.map((entity) => [entity.uuid, entity]));

    expect(first.stats).toMatchObject({
      episodeCount: 592,
      entityCount: 155,
      edgeCount: 113,
      autonomousPersonalMarkerCount: 0,
      automaticOperationCount: 0,
    });
    expect(first.stats.serializedGraphBytes).toBeGreaterThan(0);
    expect(first.graph.automatic_operations_v1).toBeUndefined();
    expect(sortedRows(first.graph.entities)).toEqual(sortedRows(second.graph.entities));
    expect(sortedRows(first.graph.edges)).toEqual(sortedRows(second.graph.edges));
    expect(sortedRows(first.graph.episodes)).toEqual(sortedRows(second.graph.episodes));
    expect(new Set(graph.entities.map((row) => row.uuid)).size).toBe(155);
    expect(new Set(graph.edges.map((row) => row.uuid)).size).toBe(113);
    expect(new Set(graph.episodes.map((row) => row.uuid)).size).toBe(592);

    for (let index = 0; index < graph.episodes.length; index += 1) {
      const episode = graph.episodes[index]!;
      const offsetInConversation = index % 32;
      expect(episode.conversation_id).toBe(`conversation:${Math.floor(index / 32)}`);
      expect(episode.source_workflow_id).toBe('workflow:synthetic-existing-store');
      expect(episode.source_execution_id).toBe(`execution:${Math.floor(index / 32)}`);
      expect(episode.previous_episode_uuid).toBe(
        offsetInConversation === 0 ? null : graph.episodes[index - 1]!.uuid,
      );
      expect(episode.group_id).toBe(graph.group_id);
      expect(episode.attributes).toHaveProperty('synthetic_fixture');
      expect(episode.attributes).not.toHaveProperty('engram_source_owner_v4');
      expect(episode.attributes).not.toHaveProperty('engram_source_envelope_v3');
    }

    for (const edge of graph.edges) {
      expect(entityById.get(edge.source_node_uuid)?.group_id).toBe(edge.group_id);
      expect(entityById.get(edge.target_node_uuid)?.group_id).toBe(edge.group_id);
      expect(edge.episodes).toHaveLength(1);
      expect(episodeById.get(edge.episodes[0]!)?.group_id).toBe(edge.group_id);
      expect(edge.name).not.toBe('PREFERS');
      expect(edge.attributes).not.toHaveProperty('engram_claim_v1');
    }
  });

  it('scales to 5x and controls text, attribute payload, and embedding sizes', () => {
    const fixture = buildAutonomousPersonalExistingStoreFixture({
      scale: 5,
      bytes: {
        episodeContent: 320,
        entitySummary: 96,
        edgeFact: 128,
        episodeAttributePayload: 24,
        entityAttributePayload: 16,
        edgeAttributePayload: 12,
      },
      embeddings: { entityDimensions: 3, edgeDimensions: 5 },
    });

    expect(fixture.stats).toMatchObject({
      episodeCount: 2960,
      entityCount: 775,
      edgeCount: 565,
      episodeContentBytes: 2960 * 320,
      entitySummaryBytes: 775 * 96,
      edgeFactBytes: 565 * 128,
      entityEmbeddingCount: 775,
      edgeEmbeddingCount: 565,
      autonomousPersonalMarkerCount: 0,
      automaticOperationCount: 0,
    });
    expect(fixture.graph.entities[0]?.name_embedding).toHaveLength(3);
    expect(fixture.graph.edges[0]?.fact_embedding).toHaveLength(5);
    expect(
      (fixture.graph.episodes[0]?.attributes.synthetic_fixture as { payload: string }).payload,
    ).toHaveLength(24);
    expect(
      (fixture.graph.entities[0]?.attributes.synthetic_fixture as { payload: string }).payload,
    ).toHaveLength(16);
    expect(
      (fixture.graph.edges[0]?.attributes.synthetic_fixture as { payload: string }).payload,
    ).toHaveLength(12);
    expect(fixture.stats.serializedGraphBytes).toBeGreaterThan(2960 * 320);
  });

  it('persists and reopens a tiny fixture only through Graphology public APIs', async () => {
    const fixture = await createAutonomousPersonalPersistedExistingStoreFixture({
      groupId: 'synthetic-persisted-fixture',
      counts: { episodes: 6, entities: 4, edges: 3 },
      bytes: {
        episodeContent: 40,
        entitySummary: 20,
        edgeFact: 24,
        episodeAttributePayload: 3,
        entityAttributePayload: 2,
        edgeAttributePayload: 1,
      },
    });
    let reopened: GraphologyStorage | undefined;

    try {
      expect(fs.existsSync(fixture.file)).toBe(true);
      const firstExport = GraphDataSchema.parse(await fixture.storage.exportGraph());
      expect(firstExport).toMatchObject({
        entities: expect.arrayContaining([
          expect.objectContaining({ group_id: fixture.graph.group_id }),
        ]),
        edges: expect.any(Array),
        episodes: expect.any(Array),
      });
      expect(firstExport.entities).toHaveLength(4);
      expect(firstExport.edges).toHaveLength(3);
      expect(firstExport.episodes).toHaveLength(6);
      expect(firstExport.automatic_operations_v1).toBeUndefined();

      await fixture.storage.close();
      reopened = new GraphologyStorage(fixture.file);
      await reopened.initialize();
      const reopenedGraph = GraphDataSchema.parse(await reopened.exportGraph());
      expect(sortedRows(reopenedGraph.entities)).toEqual(sortedRows(fixture.graph.entities));
      expect(sortedRows(reopenedGraph.edges)).toEqual(sortedRows(fixture.graph.edges));
      expect(sortedRows(reopenedGraph.episodes)).toEqual(sortedRows(fixture.graph.episodes));
      expect(reopenedGraph.automatic_operations_v1).toBeUndefined();
    } finally {
      await reopened?.close();
      await fixture.close();
    }
  });
});
