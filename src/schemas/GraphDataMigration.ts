import {
  CURRENT_GRAPH_DATA_VERSION,
  GraphDataSchema,
  ImportGraphDataSchema,
  type GraphData,
} from './GraphData.schema';

export interface GraphMigrationDefaults {
  source_type: number;
  previous_episode_uuid: number;
  updated_at: number;
  source_message_id: number;
  idempotency_key: number;
  conversation_id: number;
  sender_id: number;
  sender_name: number;
  episode_kind: number;
  quoted_message_id: number;
  trust_level: number;
  confidence: number;
  review_status: number;
  source_workflow_id: number;
  source_execution_id: number;
  attributes: number;
}

export interface GraphMigrationReport {
  source_version: '1.0' | '2.0';
  target_version: typeof CURRENT_GRAPH_DATA_VERSION;
  migration_required: boolean;
  source_checksum_removed: boolean;
  records: {
    entities: number;
    facts: number;
    episodes: number;
  };
  episode_defaults_applied: GraphMigrationDefaults;
  warnings: string[];
}

export interface GraphMigrationResult {
  data: GraphData;
  report: GraphMigrationReport;
}

const EPISODE_DEFAULT_FIELDS = [
  'source_type',
  'previous_episode_uuid',
  'updated_at',
  'source_message_id',
  'idempotency_key',
  'conversation_id',
  'sender_id',
  'sender_name',
  'episode_kind',
  'quoted_message_id',
  'trust_level',
  'confidence',
  'review_status',
  'source_workflow_id',
  'source_execution_id',
  'attributes',
] as const satisfies ReadonlyArray<keyof GraphMigrationDefaults>;

export function migrateGraphData(input: unknown): GraphMigrationResult {
  const source = ImportGraphDataSchema.parse(input);
  const rawEpisodes = rawEpisodeRecords(input);
  const defaults = emptyDefaults();

  for (const episode of rawEpisodes) {
    for (const field of EPISODE_DEFAULT_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(episode, field)) defaults[field]++;
    }
  }

  const defaultsApplied = Object.values(defaults).some((count) => count > 0);
  const migrationRequired = source.version !== CURRENT_GRAPH_DATA_VERSION || defaultsApplied;
  const metadata = source.metadata ? { ...source.metadata } : undefined;
  const sourceChecksumRemoved = Boolean(migrationRequired && metadata?.checksum_sha256);
  if (metadata && migrationRequired) {
    delete metadata.checksum_sha256;
    delete metadata.checksum_algorithm;
  }
  const data = GraphDataSchema.parse({
    ...source,
    version: CURRENT_GRAPH_DATA_VERSION,
    metadata,
  });
  const warnings = integrityWarnings(data);

  return {
    data,
    report: {
      source_version: source.version,
      target_version: CURRENT_GRAPH_DATA_VERSION,
      migration_required: migrationRequired,
      source_checksum_removed: sourceChecksumRemoved,
      records: {
        entities: data.entities.length,
        facts: data.edges.length,
        episodes: data.episodes.length,
      },
      episode_defaults_applied: defaults,
      warnings,
    },
  };
}

function rawEpisodeRecords(input: unknown): Array<Record<string, unknown>> {
  if (typeof input !== 'object' || input === null) return [];
  const episodes = (input as { episodes?: unknown }).episodes;
  if (!Array.isArray(episodes)) return [];
  return episodes.filter(
    (episode): episode is Record<string, unknown> =>
      typeof episode === 'object' && episode !== null,
  );
}

function emptyDefaults(): GraphMigrationDefaults {
  return {
    source_type: 0,
    previous_episode_uuid: 0,
    updated_at: 0,
    source_message_id: 0,
    idempotency_key: 0,
    conversation_id: 0,
    sender_id: 0,
    sender_name: 0,
    episode_kind: 0,
    quoted_message_id: 0,
    trust_level: 0,
    confidence: 0,
    review_status: 0,
    source_workflow_id: 0,
    source_execution_id: 0,
    attributes: 0,
  };
}

function integrityWarnings(data: GraphData): string[] {
  const warnings: string[] = [];
  const entityUuids = new Set(data.entities.map((entity) => entity.uuid));
  const episodeUuids = new Set(data.episodes.map((episode) => episode.uuid));
  const danglingEdges = data.edges.filter(
    (edge) => !entityUuids.has(edge.source_node_uuid) || !entityUuids.has(edge.target_node_uuid),
  ).length;
  const brokenEpisodeLinks = data.episodes.filter(
    (episode) =>
      episode.previous_episode_uuid !== null && !episodeUuids.has(episode.previous_episode_uuid),
  ).length;

  if (danglingEdges > 0) {
    warnings.push(`${danglingEdges} edge(s) reference entities missing from the import data.`);
  }
  if (brokenEpisodeLinks > 0) {
    warnings.push(
      `${brokenEpisodeLinks} episode(s) reference previous episodes missing from the import data.`,
    );
  }
  return warnings;
}
