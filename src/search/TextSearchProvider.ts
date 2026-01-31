/**
 * Abstract interface for full-text search across graph data.
 * Implemented by MinisearchProvider (embedded) and Neo4jSearchProvider (remote).
 */

export interface TextSearchResult {
	id: string;
	score: number;
}

export interface TextSearchProvider {
	/**
	 * Index an entity for full-text search.
	 */
	indexEntity(id: string, fields: { name: string; summary: string; entity_type: string }): void;

	/**
	 * Index an edge/relationship for full-text search.
	 */
	indexEdge(id: string, fields: { name: string; fact: string }): void;

	/**
	 * Remove an entity from the search index.
	 */
	removeEntity(id: string): void;

	/**
	 * Remove an edge from the search index.
	 */
	removeEdge(id: string): void;

	/**
	 * Search entities by query text.
	 */
	searchEntities(query: string, limit: number): TextSearchResult[];

	/**
	 * Search edges by query text.
	 */
	searchEdges(query: string, limit: number): TextSearchResult[];

	/**
	 * Clear all indexed data.
	 */
	clear(): void;
}
