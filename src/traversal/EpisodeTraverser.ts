import type { IGraphStorage } from '../storage/IGraphStorage';
import { GraphTraverser, type TraversalOptions, type TraversalResult } from './GraphTraverser';

export interface EpisodeTraversalOptions extends TraversalOptions {
	/** Number of recent episodes to start from (default: 5) */
	episodeCount?: number;
}

/**
 * Specialized traversal that starts from recent episodes.
 * Finds entities mentioned in those episodes (via edge.episodes),
 * then BFS outward from those entities.
 */
export class EpisodeTraverser {
	private traverser: GraphTraverser;

	constructor() {
		this.traverser = new GraphTraverser();
	}

	async traverseFromRecentEpisodes(
		storage: IGraphStorage,
		groupId: string,
		options?: EpisodeTraversalOptions,
	): Promise<TraversalResult> {
		const episodeCount = options?.episodeCount ?? 5;
		const episodes = await storage.getRecentEpisodes(groupId, episodeCount);

		if (episodes.length === 0) {
			return {
				entities: [],
				edges: [],
				paths: [],
				seed_entities: [],
				total_hops: options?.maxHops ?? 2,
				context: '',
			};
		}

		// Find entities referenced by edges that mention these episodes
		const episodeUuids = new Set(episodes.map((e) => e.uuid));
		const seedEntityUuids = new Set<string>();

		const graphData = await storage.exportGraph(groupId);

		for (const edge of graphData.edges) {
			if (edge.episodes.some((epId) => episodeUuids.has(epId))) {
				seedEntityUuids.add(edge.source_node_uuid);
				seedEntityUuids.add(edge.target_node_uuid);
			}
		}

		// Fallback: if no episode-linked entities, use most recently created entities
		if (seedEntityUuids.size === 0) {
			const recentEntities = await storage.listEntities(groupId, { limit: 5 });
			for (const e of recentEntities) {
				seedEntityUuids.add(e.uuid);
			}
		}

		return this.traverser.traverse(storage, [...seedEntityUuids], {
			maxHops: options?.maxHops ?? 2,
			maxEntities: options?.maxEntities ?? 50,
			includeExpiredEdges: options?.includeExpiredEdges,
		});
	}
}
