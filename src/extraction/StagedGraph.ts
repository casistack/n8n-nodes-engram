import { randomUUID } from 'crypto';
import type {
  IGraphStorage,
  EntitySearchOptions,
  EdgeSearchOptions,
  VectorSearchOptions,
} from '../storage/IGraphStorage';
import {
  CreateEntityNodeSchema,
  CreateEntityEdgeSchema,
  EntityNodeSchema,
  EntityEdgeSchema,
  type GraphData,
  type EntityEdge,
  type ExtractionOutcome,
  type StagedExtraction,
} from '../schemas';
import { canonical, graphFingerprint, sourceFingerprint, QUEUE_ATTRIBUTE } from './QueueState';
import { MinisearchProvider } from '../search/MinisearchProvider';
import { cosineSimilarity } from '../embeddings/cosine';

/** Detached, allowlisted view. No method can fall through to the live backend. */
export class StagedGraph {
  readonly storage: IGraphStorage;
  private graph: GraphData;
  private entities = new Set<string>();
  private edges = new Set<string>();
  private index = new MinisearchProvider();
  private initialHash: string;
  constructor(
    snapshot: GraphData,
    private group: string,
    writable = true,
    private sourceIds: string[] = [],
  ) {
    if (
      snapshot.entities.length + snapshot.edges.length + snapshot.episodes.length > 100000 ||
      Buffer.byteLength(canonical(snapshot)) > 100 * 1024 * 1024
    )
      throw new Error('Engram queue: snapshot_limit');
    this.graph = JSON.parse(JSON.stringify(snapshot)) as GraphData;
    if (
      [...this.graph.entities, ...this.graph.edges, ...this.graph.episodes].some(
        (item) => item.group_id !== group,
      )
    )
      throw new Error('Engram queue: mixed_snapshot');
    const allIds = [...this.graph.entities, ...this.graph.edges, ...this.graph.episodes].map(
      (item) => item.uuid,
    );
    if (new Set(allIds).size !== allIds.length)
      throw new Error('Engram queue: duplicate_snapshot_id');
    this.initialHash = graphFingerprint(this.graph, group);
    for (const e of this.graph.entities) this.index.indexEntity(e.uuid, e);
    for (const e of this.graph.edges) this.index.indexEdge(e.uuid, e);
    const episodesById = new Map(this.graph.episodes.map((episode) => [episode.uuid, episode]));
    const chainDepth = new Map<string, number>();
    for (const episode of this.graph.episodes) {
      const pending: string[] = [],
        seen = new Set<string>();
      let cursor: string | null = episode.uuid;
      while (cursor && episodesById.has(cursor) && !chainDepth.has(cursor) && !seen.has(cursor)) {
        pending.push(cursor);
        seen.add(cursor);
        cursor = episodesById.get(cursor)!.previous_episode_uuid;
      }
      if (cursor && seen.has(cursor)) {
        for (const id of pending) chainDepth.set(id, 0);
      } else {
        let depth = cursor ? (chainDepth.get(cursor) ?? 0) : 0;
        for (const id of pending.reverse()) chainDepth.set(id, ++depth);
      }
    }
    const methods: Partial<IGraphStorage> = {
      initialize: async () => {},
      close: async () => {},
      getEntity: async (uuid) =>
        this.clone(this.graph.entities.find((e) => e.uuid === uuid) ?? null),
      getEntityByName: async (name, namespace) =>
        this.clone(
          this.graph.entities.find(
            (e) => e.group_id === namespace && e.name.toLowerCase() === name.toLowerCase(),
          ) ?? null,
        ),
      listEntities: async (namespace, options) =>
        this.clone(
          this.graph.entities
            .filter(
              (e) =>
                e.group_id === namespace &&
                (!options?.entity_type || e.entity_type === options.entity_type),
            )
            .slice(options?.offset ?? 0, (options?.offset ?? 0) + (options?.limit ?? 100000)),
        ),
      getEdge: async (uuid) => this.clone(this.graph.edges.find((e) => e.uuid === uuid) ?? null),
      getEdgesBetween: async (source, target) =>
        this.clone(
          this.graph.edges.filter(
            (e) => e.source_node_uuid === source && e.target_node_uuid === target,
          ),
        ),
      getEdgesForEntity: async (uuid) =>
        this.clone(
          this.graph.edges.filter(
            (e) => e.source_node_uuid === uuid || e.target_node_uuid === uuid,
          ),
        ),
      getEpisode: async (uuid) =>
        this.clone(this.graph.episodes.find((e) => e.uuid === uuid) ?? null),
      getEpisodes: async (ids) => {
        const selected = new Set(ids);
        return this.clone(this.graph.episodes.filter((e) => selected.has(e.uuid)));
      },
      getRecentEpisodes: async (namespace, limit) =>
        this.clone(
          this.graph.episodes
            .filter((e) => e.group_id === namespace)
            .sort(
              (a, b) =>
                b.created_at.localeCompare(a.created_at) ||
                (chainDepth.get(b.uuid) ?? 0) - (chainDepth.get(a.uuid) ?? 0) ||
                b.uuid.localeCompare(a.uuid),
            )
            .slice(0, limit)
            .reverse(),
        ),
      searchEntities: async (query, namespace, options) =>
        this.searchEntities(query, namespace, options),
      searchEdges: async (query, namespace, options) => this.searchEdges(query, namespace, options),
      searchEntitiesByVector: async (vector, namespace, options) =>
        this.vectorEntities(vector, namespace, options),
      searchEdgesByVector: async (vector, namespace, options) =>
        this.vectorEdges(vector, namespace, options),
      exportGraph: async () => this.clone(this.graph),
      addEntity: async (input) => {
        this.guard(writable, input.group_id, input.attributes);
        const now = new Date().toISOString();
        const entity = EntityNodeSchema.parse({
          ...CreateEntityNodeSchema.parse(input),
          uuid: randomUUID(),
          created_at: now,
          updated_at: now,
        });
        this.graph.entities.push(entity);
        this.entities.add(entity.uuid);
        this.index.indexEntity(entity.uuid, entity);
        return this.clone(entity);
      },
      updateEntity: async (uuid, updates) => {
        const prior = this.graph.entities.find((e) => e.uuid === uuid);
        if (!prior) throw new Error('Engram queue: missing_entity');
        this.guard(writable, updates.group_id ?? group, updates.attributes);
        const entity = EntityNodeSchema.parse({
          ...prior,
          ...updates,
          uuid: prior.uuid,
          group_id: group,
          created_at: prior.created_at,
          updated_at: new Date().toISOString(),
        });
        this.graph.entities[this.graph.entities.indexOf(prior)] = entity;
        this.entities.add(uuid);
        this.index.indexEntity(uuid, entity);
        return this.clone(entity);
      },
      addEdge: async (input) => {
        this.guard(writable, input.group_id, input.attributes);
        const now = new Date().toISOString();
        const edge = EntityEdgeSchema.parse({
          ...CreateEntityEdgeSchema.parse(input),
          uuid: randomUUID(),
          created_at: now,
          updated_at: now,
        });
        this.graph.edges.push(edge);
        this.edges.add(edge.uuid);
        this.index.indexEdge(edge.uuid, edge);
        return this.clone(edge);
      },
      updateEdge: async (uuid, updates) => {
        const prior = this.graph.edges.find((e) => e.uuid === uuid);
        if (!prior) throw new Error('Engram queue: missing_edge');
        this.guard(writable, updates.group_id ?? group, updates.attributes);
        const edge = EntityEdgeSchema.parse({
          ...prior,
          ...updates,
          uuid: prior.uuid,
          group_id: group,
          created_at: prior.created_at,
          updated_at: new Date().toISOString(),
        });
        this.graph.edges[this.graph.edges.indexOf(prior)] = edge;
        this.edges.add(uuid);
        this.index.indexEdge(uuid, edge);
        return this.clone(edge);
      },
    };
    this.storage = new Proxy({} as IGraphStorage, {
      get: (_target, key) => {
        if (
          key === 'then' ||
          [
            'withExtractionDiagnostics',
            'supportsDurableExtraction',
            'readExtractionSnapshot',
            'extractionBackend',
            'appendEpisodesWithExtraction',
            'extractionQueueCommand',
            'applyStagedExtraction',
            'importExtractionBackup',
            'previewQueueClear',
          ].includes(String(key))
        )
          return undefined;
        const fn = methods[key as keyof IGraphStorage];
        if (!fn)
          return async () => {
            throw new Error('Engram queue: unsupported_snapshot_operation');
          };
        return fn;
      },
    });
  }
  private clone<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
  }
  private guard(writable: boolean, group: string, attrs?: Record<string, unknown>): void {
    if (!writable || group !== this.group || (attrs && QUEUE_ATTRIBUTE in attrs))
      throw new Error('Engram queue: invalid_staged_mutation');
  }
  plan(outcome: ExtractionOutcome): StagedExtraction {
    return this.clone({
      version: 1,
      group_id: this.group,
      graph_hash: this.initialHash,
      source_guards: this.sourceIds.map((uuid) => {
        const source = this.graph.episodes.find((ep) => ep.uuid === uuid);
        if (!source) throw new Error('Engram queue: missing_source');
        return { uuid, hash: sourceFingerprint(source) };
      }),
      entities: this.graph.entities
        .filter((e) => this.entities.has(e.uuid))
        .sort((a, b) => a.uuid.localeCompare(b.uuid)),
      edges: this.graph.edges
        .filter((e) => this.edges.has(e.uuid))
        .sort((a, b) => a.uuid.localeCompare(b.uuid)),
      outcome,
    });
  }
  private searchEntities(query: string, namespace: string, opts: EntitySearchOptions = {}) {
    return this.index
      .searchEntities(query, 100000)
      .map((hit) => ({
        entity: this.graph.entities.find((e) => e.uuid === hit.id)!,
        score: hit.score,
      }))
      .filter(
        ({ entity: e, score }) =>
          e.group_id === namespace &&
          score >= (opts.min_score ?? 0) &&
          (!opts.entity_type || e.entity_type === opts.entity_type) &&
          (!opts.created_after || e.created_at >= opts.created_after) &&
          (!opts.created_before || e.created_at <= opts.created_before),
      )
      .slice(0, opts.limit ?? 10);
  }
  private searchEdges(query: string, namespace: string, opts: EdgeSearchOptions = {}) {
    return this.index
      .searchEdges(query, 100000)
      .map((hit) => this.edgeResult(this.graph.edges.find((e) => e.uuid === hit.id)!, hit.score))
      .filter(
        ({ edge: e, score }) =>
          e.group_id === namespace &&
          score >= (opts.min_score ?? 0) &&
          (opts.include_expired || !e.expired_at) &&
          (!opts.valid_after || !e.invalid_at || e.invalid_at >= opts.valid_after) &&
          (!opts.valid_before || !e.valid_at || e.valid_at <= opts.valid_before) &&
          (!opts.created_after || e.created_at >= opts.created_after) &&
          (!opts.created_before || e.created_at <= opts.created_before),
      )
      .slice(0, opts.limit ?? 10);
  }
  private edgeResult(edge: EntityEdge, score: number) {
    return {
      edge: this.clone(edge),
      sourceEntity: this.clone(this.graph.entities.find((e) => e.uuid === edge.source_node_uuid)!),
      targetEntity: this.clone(this.graph.entities.find((e) => e.uuid === edge.target_node_uuid)!),
      score,
    };
  }
  private vectorEntities(vector: number[], namespace: string, opts: VectorSearchOptions = {}) {
    return this.graph.entities
      .filter((e) => e.group_id === namespace && e.name_embedding?.length === vector.length)
      .map((entity) => ({
        entity: this.clone(entity),
        score: cosineSimilarity(vector, entity.name_embedding!),
      }))
      .filter((hit) => hit.score >= (opts.min_score ?? 0))
      .sort((a, b) => b.score - a.score)
      .slice(0, opts.limit ?? 10);
  }
  private vectorEdges(vector: number[], namespace: string, opts: VectorSearchOptions = {}) {
    return this.graph.edges
      .filter((e) => e.group_id === namespace && e.fact_embedding?.length === vector.length)
      .map((edge) => this.edgeResult(edge, cosineSimilarity(vector, edge.fact_embedding!)))
      .filter((hit) => hit.score >= (opts.min_score ?? 0))
      .sort((a, b) => b.score - a.score)
      .slice(0, opts.limit ?? 10);
  }
}
