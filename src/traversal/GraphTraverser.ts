import type { IGraphStorage } from '../storage/IGraphStorage';
import type { EntityNode, EntityEdge } from '../schemas';

export interface TraversalPath {
  entity: EntityNode;
  hop: number;
  via_edge: EntityEdge | null;
}

export interface TraversalOptions {
  /** Maximum BFS depth (default: 2) */
  maxHops?: number;
  /** Cap on total entities returned (default: 50) */
  maxEntities?: number;
  /** Include expired edges in traversal (default: false) */
  includeExpiredEdges?: boolean;
  entityFilter?: (entity: EntityNode) => boolean;
  edgeFilter?: (edge: EntityEdge) => boolean;
}

export interface TraversalResult {
  entities: EntityNode[];
  edges: EntityEdge[];
  paths: TraversalPath[];
  seed_entities: string[];
  total_hops: number;
  context: string;
}

/**
 * Breadth-first graph traversal.
 * Walks N hops from seed entities, collecting all reachable
 * entities and edges within the hop limit.
 */
export class GraphTraverser {
  async traverse(
    storage: IGraphStorage,
    seedEntityUuids: string[],
    options?: TraversalOptions,
  ): Promise<TraversalResult> {
    const maxHops = options?.maxHops ?? 2;
    const maxEntities = options?.maxEntities ?? 50;
    const includeExpired = options?.includeExpiredEdges ?? false;
    const entityFilter = options?.entityFilter;
    const edgeFilter = options?.edgeFilter;

    const visited = new Set<string>();
    const visitedEdges = new Set<string>();
    const queue: Array<{ uuid: string; hop: number; viaEdge: EntityEdge | null }> = [];
    const paths: TraversalPath[] = [];
    const collectedEntities: EntityNode[] = [];
    const collectedEdges: EntityEdge[] = [];

    // Initialize queue with seed entities
    for (const uuid of seedEntityUuids) {
      const entity = await storage.getEntity(uuid);
      if (entity && (!entityFilter || entityFilter(entity))) {
        queue.push({ uuid, hop: 0, viaEdge: null });
      }
    }

    while (queue.length > 0 && collectedEntities.length < maxEntities) {
      const item = queue.shift()!;

      if (visited.has(item.uuid)) continue;
      visited.add(item.uuid);

      const entity = await storage.getEntity(item.uuid);
      if (!entity) continue;
      if (entityFilter && !entityFilter(entity)) continue;

      collectedEntities.push(entity);
      paths.push({ entity, hop: item.hop, via_edge: item.viaEdge });

      if (item.viaEdge && !visitedEdges.has(item.viaEdge.uuid)) {
        visitedEdges.add(item.viaEdge.uuid);
        collectedEdges.push(item.viaEdge);
      }

      // Expand neighbors if within hop limit
      if (item.hop < maxHops) {
        const edges = await storage.getEdgesForEntity(item.uuid);

        for (const edge of edges) {
          if (!includeExpired && edge.expired_at) continue;
          if (edgeFilter && !edgeFilter(edge)) continue;

          const neighborUuid =
            edge.source_node_uuid === item.uuid ? edge.target_node_uuid : edge.source_node_uuid;

          if (!visited.has(neighborUuid)) {
            queue.push({ uuid: neighborUuid, hop: item.hop + 1, viaEdge: edge });
          }

          // Collect edges even for already-visited neighbors
          if (!visitedEdges.has(edge.uuid)) {
            visitedEdges.add(edge.uuid);
            collectedEdges.push(edge);
          }
        }
      }
    }

    return {
      entities: collectedEntities,
      edges: collectedEdges,
      paths,
      seed_entities: seedEntityUuids.filter((u) => visited.has(u)),
      total_hops: maxHops,
      context: this.formatContext(paths, collectedEdges),
    };
  }

  private formatContext(paths: TraversalPath[], edges: EntityEdge[]): string {
    if (paths.length === 0) return '';

    const parts: string[] = ['Graph context (BFS traversal):'];

    // Group by hop level
    const byHop = new Map<number, TraversalPath[]>();
    for (const p of paths) {
      if (!byHop.has(p.hop)) byHop.set(p.hop, []);
      byHop.get(p.hop)!.push(p);
    }

    for (const [hop, entities] of byHop) {
      const label = hop === 0 ? 'Starting entities' : `${hop} hop${hop > 1 ? 's' : ''} away`;
      parts.push(`\n${label}:`);
      for (const p of entities) {
        const summary = p.entity.summary ? `: ${p.entity.summary}` : '';
        parts.push(`- ${p.entity.name} (${p.entity.entity_type})${summary}`);
      }
    }

    if (edges.length > 0) {
      parts.push('\nRelationships:');
      for (const edge of edges) {
        parts.push(`- ${edge.fact}`);
      }
    }

    return parts.join('\n');
  }
}
