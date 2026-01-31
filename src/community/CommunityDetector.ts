import type { IGraphStorage } from '../storage/IGraphStorage';
import type { EntityNode, EntityEdge } from '../schemas';
import type {
  Community,
  CommunityMember,
  CommunityDetectionResult,
} from '../schemas/Community.schema';

export interface CommunityDetectionOptions {
  /** Minimum entities to form a community (default: 2) */
  minCommunitySize?: number;
  /** Label propagation iterations (default: 10) */
  maxIterations?: number;
}

/**
 * Detects communities in the entity graph using label propagation.
 *
 * Algorithm:
 * 1. Each entity starts with its own label (uuid)
 * 2. Each iteration: every entity adopts the most frequent label among its neighbors
 * 3. Repeat until convergence or max iterations
 * 4. Group entities by final label → communities
 */
export class CommunityDetector {
  private storage: IGraphStorage;

  constructor(storage: IGraphStorage) {
    this.storage = storage;
  }

  async detect(
    groupId: string,
    options?: CommunityDetectionOptions,
  ): Promise<CommunityDetectionResult> {
    const minSize = options?.minCommunitySize ?? 2;
    const maxIter = options?.maxIterations ?? 10;

    // Fetch all entities and build adjacency
    const entities = await this.storage.listEntities(groupId);
    if (entities.length === 0) {
      return {
        communities: [],
        total_entities: 0,
        unclustered_entities: 0,
        detection_method: 'label_propagation',
      };
    }

    // Build adjacency list: entityUuid → [neighborUuids]
    const adjacency = new Map<string, Set<string>>();
    const edgeMap = new Map<string, EntityEdge[]>(); // entityUuid → edges

    for (const entity of entities) {
      adjacency.set(entity.uuid, new Set());
      edgeMap.set(entity.uuid, []);
    }

    for (const entity of entities) {
      const edges = await this.storage.getEdgesForEntity(entity.uuid);
      edgeMap.set(entity.uuid, edges);

      for (const edge of edges) {
        if (edge.expired_at) continue;
        const neighbor =
          edge.source_node_uuid === entity.uuid ? edge.target_node_uuid : edge.source_node_uuid;

        // Only include neighbors that are in this group
        if (adjacency.has(neighbor)) {
          adjacency.get(entity.uuid)!.add(neighbor);
          adjacency.get(neighbor)!.add(entity.uuid);
        }
      }
    }

    // Initialize labels: each entity gets its own uuid as label
    const labels = new Map<string, string>();
    for (const entity of entities) {
      labels.set(entity.uuid, entity.uuid);
    }

    // Label propagation
    const entityUuids = entities.map((e) => e.uuid);

    for (let iter = 0; iter < maxIter; iter++) {
      let changed = false;

      // Process in deterministic order (sorted UUIDs)
      const sorted = [...entityUuids].sort();

      for (const uuid of sorted) {
        const neighbors = adjacency.get(uuid);
        if (!neighbors || neighbors.size === 0) continue;

        // Count neighbor labels
        const labelCounts = new Map<string, number>();
        for (const neighbor of neighbors) {
          const nLabel = labels.get(neighbor)!;
          labelCounts.set(nLabel, (labelCounts.get(nLabel) ?? 0) + 1);
        }

        // Find most frequent label (tie-break: lowest label string)
        let bestLabel = labels.get(uuid)!;
        let bestCount = 0;

        for (const [label, count] of labelCounts) {
          if (count > bestCount || (count === bestCount && label < bestLabel)) {
            bestLabel = label;
            bestCount = count;
          }
        }

        if (bestLabel !== labels.get(uuid)) {
          labels.set(uuid, bestLabel);
          changed = true;
        }
      }

      if (!changed) break; // Converged
    }

    // Group entities by label
    const groups = new Map<string, EntityNode[]>();
    const entityMap = new Map<string, EntityNode>();
    for (const entity of entities) {
      entityMap.set(entity.uuid, entity);
      const label = labels.get(entity.uuid)!;
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label)!.push(entity);
    }

    // Build communities from groups meeting min size
    const communities: Community[] = [];
    let unclustered = 0;

    for (const [, groupEntities] of groups) {
      if (groupEntities.length < minSize) {
        unclustered += groupEntities.length;
        continue;
      }

      const memberUuids = new Set(groupEntities.map((e) => e.uuid));
      const members: CommunityMember[] = [];
      const internalEdges = new Set<string>();

      for (const entity of groupEntities) {
        const entityEdges = edgeMap.get(entity.uuid) ?? [];
        // Filter to edges connecting community members
        const communityEdges = entityEdges.filter(
          (e) =>
            !e.expired_at &&
            memberUuids.has(e.source_node_uuid) &&
            memberUuids.has(e.target_node_uuid),
        );
        for (const e of communityEdges) {
          internalEdges.add(e.uuid);
        }
        members.push({ entity, edges: communityEdges });
      }

      // Key entities: top 3 by connectivity (edge count)
      const byConnectivity = [...members].sort((a, b) => b.edges.length - a.edges.length);
      const keyEntities = byConnectivity.slice(0, 3).map((m) => m.entity.name);

      // Generate deterministic ID from sorted member UUIDs
      const sortedUuids = groupEntities.map((e) => e.uuid).sort();
      const id = sortedUuids.join(':').slice(0, 64);

      communities.push({
        id,
        label: keyEntities.join(', '),
        members,
        summary: null,
        entity_count: groupEntities.length,
        edge_count: internalEdges.size,
        key_entities: keyEntities,
      });
    }

    // Sort communities by size (largest first)
    communities.sort((a, b) => b.entity_count - a.entity_count);

    return {
      communities,
      total_entities: entities.length,
      unclustered_entities: unclustered,
      detection_method: 'label_propagation',
    };
  }
}
