import { randomUUID } from 'crypto';
import type { ManagedTransaction } from 'neo4j-driver';
import { Neo4jStorage } from '../../../src/storage/Neo4jStorage';
import { GraphDataSchema, type GraphData } from '../../../src/schemas/GraphData.schema';
import { EntityNodeSchema } from '../../../src/schemas/EntityNode.schema';
import { EntityEdgeSchema } from '../../../src/schemas/EntityEdge.schema';
import { EpisodicNodeSchema } from '../../../src/schemas/EpisodicNode.schema';
import { selectCompositionalCaptureNewSourceV3 } from '../../../src/storage/CompositionalCaptureBackendBeginV3';

function fixture(count: number): GraphData {
  const at = '2026-10-26T09:00:00.000Z';
  const entities = Array.from({ length: count }, (_, index) =>
    EntityNodeSchema.parse({
      uuid: randomUUID(),
      group_id: 'synthetic-linear-diff',
      name: `Synthetic ${index}`,
      created_at: at,
      updated_at: at,
    }),
  );
  return GraphDataSchema.parse({
    version: '2.0',
    exported_at: at,
    entities,
    edges: Array.from({ length: count }, (_, index) =>
      EntityEdgeSchema.parse({
        uuid: randomUUID(),
        group_id: 'synthetic-linear-diff',
        source_node_uuid: entities[0].uuid,
        target_node_uuid: entities[1].uuid,
        name: 'SYNTHETIC',
        fact: `Synthetic edge ${index}`,
        created_at: at,
        updated_at: at,
      }),
    ),
    episodes: Array.from({ length: count }, (_, index) =>
      EpisodicNodeSchema.parse({
        uuid: randomUUID(),
        group_id: 'synthetic-linear-diff',
        role: 'human',
        content: `Synthetic ${index}`,
        reference_time: at,
        created_at: at,
      }),
    ),
  });
}

describe('native capture graph diff bounded local work', () => {
  let store: Neo4jStorage;
  beforeEach(() => {
    store = new Neo4jStorage('bolt://127.0.0.1:19787', 'neo4j', 'synthetic-unused');
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await store.close();
  });
  const diff = (
    before: GraphData,
    after: GraphData,
    check: () => void,
    run = jest.fn(async () => ({ records: [] })),
  ) => {
    const internal = store as unknown as {
      writeExtractionDiff: (
        tx: ManagedTransaction,
        before: GraphData,
        after: GraphData,
        check: () => void,
      ) => Promise<void>;
    };
    return {
      result: internal.writeExtractionDiff(
        { run } as unknown as ManagedTransaction,
        before,
        after,
        check,
      ),
      run,
    };
  };

  it('uses linear indexed comparisons rather than rescanning each before array', async () => {
    const counts: number[] = [];
    for (const size of [500, 1000]) {
      const before = fixture(size);
      const after = structuredClone(before);
      const scans = [
        jest.spyOn(before.entities, 'find'),
        jest.spyOn(before.edges, 'find'),
        jest.spyOn(before.episodes, 'find'),
      ];
      let checks = 0;
      const result = diff(before, after, () => {
        checks++;
      });
      await result.result;
      expect(result.run).not.toHaveBeenCalled();
      for (const scan of scans) {
        expect(scan).not.toHaveBeenCalled();
        scan.mockRestore();
      }
      counts.push(checks);
    }
    expect(counts[1]).toBeLessThanOrEqual(counts[0] * 2 + 2);
    expect(counts[0]).toBeGreaterThanOrEqual(1500);
  });

  it('can abort while indexing an unrelated root before any query is made', async () => {
    const before = fixture(1000);
    const after = structuredClone(before);
    after.entities[after.entities.length - 1].name = 'Synthetic changed tail';
    const error = new Error('synthetic-deadline');
    let checks = 0;
    const result = diff(before, after, () => {
      if (++checks === 600) throw error;
    });
    await expect(result.result).rejects.toBe(error);
    expect(result.run).not.toHaveBeenCalled();
    expect(checks).toBe(600);
  });

  it('writes only the exact changed row and checks immediately after awaited writes', async () => {
    const before = fixture(200);
    const after = structuredClone(before);
    after.entities[199].name = 'Synthetic changed tail';
    let completedQuery = false;
    const run = jest.fn(async () => {
      completedQuery = true;
      return { records: [] };
    });
    const error = new Error('synthetic-after-await');
    const result = diff(
      before,
      after,
      () => {
        if (completedQuery) throw error;
      },
      run,
    );
    await expect(result.result).rejects.toBe(error);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ uuid: after.entities[199].uuid }),
    );
  });

  it('selects one new source in linear checked work across a large history', () => {
    const sources = fixture(10_000).episodes;
    const addition = { ...sources[0], uuid: randomUUID() };
    let checks = 0;
    const result = selectCompositionalCaptureNewSourceV3(
      sources,
      [...sources, addition],
      addition.uuid,
      () => {
        checks++;
      },
    );
    expect(result).toBe(addition);
    expect(checks).toBe(20_002);
    const error = new Error('synthetic-source-scan-deadline');
    expect(() =>
      selectCompositionalCaptureNewSourceV3(sources, [...sources, addition], addition.uuid, () => {
        throw error;
      }),
    ).toThrow(error);
    expect(() =>
      selectCompositionalCaptureNewSourceV3(
        [],
        [addition, { ...addition, uuid: randomUUID() }],
        addition.uuid,
        () => {},
      ),
    ).toThrow('invalid_candidate');
  });
});
