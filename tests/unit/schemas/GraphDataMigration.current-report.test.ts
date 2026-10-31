import { isDeepStrictEqual } from 'node:util';
import { parseLosslessAutomaticCaptureGraph } from '../../../src/storage/LosslessAutomaticCaptureGraph';
import { GraphDataSchema, migrateGraphData } from '../../../src/schemas';
import { currentGraphMigrationReport } from '../../../src/schemas/GraphDataMigration';

const timestamp = '2026-06-21T12:00:00.000Z';

const legacySource = {
  version: '1.0',
  exported_at: timestamp,
  group_id: 'report-group',
  metadata: {
    checksum_sha256: 'current-checksum',
    checksum_algorithm: 'sha256',
    generated_by: 'n8n-nodes-engram',
  },
  entities: [],
  edges: [
    {
      uuid: '00000000-0000-4000-8000-0000000000e1',
      group_id: 'report-group',
      source_node_uuid: '00000000-0000-4000-8000-0000000000a1',
      target_node_uuid: '00000000-0000-4000-8000-0000000000a2',
      name: 'KNOWS',
      fact: 'A knows B',
      created_at: timestamp,
      updated_at: timestamp,
    },
  ],
  episodes: [
    {
      uuid: '00000000-0000-4000-8000-000000000001',
      group_id: 'report-group',
      content: 'First',
      role: 'human',
      reference_time: timestamp,
      created_at: timestamp,
    },
    {
      uuid: '00000000-0000-4000-8000-000000000002',
      group_id: 'report-group',
      content: 'Second',
      role: 'ai',
      reference_time: timestamp,
      previous_episode_uuid: '00000000-0000-4000-8000-0000000000ff',
      created_at: timestamp,
    },
  ],
};

/** A current 2.0 file with every episode default written out and the checksum kept. */
function currentFile(): Record<string, unknown> {
  const migrated = JSON.parse(JSON.stringify(migrateGraphData(legacySource).data)) as Record<
    string,
    unknown
  >;
  return { ...migrated, metadata: legacySource.metadata };
}

describe('currentGraphMigrationReport', () => {
  it('matches the migrateGraphData report for a complete current graph, warnings included', () => {
    const raw = currentFile();
    const expected = migrateGraphData(structuredClone(raw));
    expect(expected.report.migration_required).toBe(false);
    expect(expected.report.warnings).toHaveLength(2);

    const report = currentGraphMigrationReport(GraphDataSchema.parse(structuredClone(raw)));

    expect(report).toEqual(expected.report);
    expect(report?.source_checksum_removed).toBe(false);
  });

  it('keeps current-reader value, prototype and mutability shape when reusing validated JSON', () => {
    const raw = currentFile();
    const episodes = raw.episodes as Array<Record<string, unknown>>;
    episodes[0]!.attributes = { nested: { values: [{ preserved: 'synthetic' }] } };
    const oldRead = migrateGraphData(raw);
    const checked = parseLosslessAutomaticCaptureGraph(raw);
    const currentRead = raw as unknown as typeof checked;
    expect(isDeepStrictEqual(currentRead, oldRead.data)).toBe(true);
    expect(currentGraphMigrationReport(checked)).toEqual(oldRead.report);
    const nested = currentRead.episodes[0]!.attributes.nested as {
      values: Array<{ preserved: string }>;
    };
    nested.values[0]!.preserved = 'mutable copy';
    expect((checked.episodes[0]!.attributes.nested as typeof nested).values[0]!.preserved).toBe(
      'synthetic',
    );
  });

  it('does not mutate its input or return data', () => {
    const graph = GraphDataSchema.parse(currentFile());
    const original = structuredClone(graph);

    const report = currentGraphMigrationReport(graph);

    expect(graph).toEqual(original);
    expect(graph.metadata?.checksum_sha256).toBe('current-checksum');
    expect(report).not.toHaveProperty('data');
    expect(currentGraphMigrationReport(graph)).toEqual(report);
  });

  it('returns undefined when any episode lacks a default field', () => {
    const graph = GraphDataSchema.parse(currentFile());
    delete (graph.episodes[1] as Record<string, unknown>).review_status;
    const original = structuredClone(graph);

    expect(currentGraphMigrationReport(graph)).toBeUndefined();
    expect(graph).toEqual(original);
  });

  it('returns undefined for a non-current version', () => {
    const graph = GraphDataSchema.parse(currentFile());
    const legacy = { ...graph, version: '1.0' } as unknown as typeof graph;

    expect(currentGraphMigrationReport(legacy)).toBeUndefined();
  });

  it('leaves generic migrateGraphData migrating legacy input', () => {
    const migration = migrateGraphData(structuredClone(legacySource));

    expect(migration.report.migration_required).toBe(true);
    expect(migration.report.source_checksum_removed).toBe(true);
  });
});
