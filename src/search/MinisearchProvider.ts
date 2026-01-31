import MiniSearch from 'minisearch';
import type { TextSearchProvider, TextSearchResult } from './TextSearchProvider';

interface EntityDocument {
  id: string;
  name: string;
  summary: string;
  entity_type: string;
}

interface EdgeDocument {
  id: string;
  name: string;
  fact: string;
}

export class MinisearchProvider implements TextSearchProvider {
  private entityIndex: MiniSearch<EntityDocument>;
  private edgeIndex: MiniSearch<EdgeDocument>;

  constructor() {
    this.entityIndex = new MiniSearch<EntityDocument>({
      fields: ['name', 'summary', 'entity_type'],
      storeFields: ['name', 'summary', 'entity_type'],
      searchOptions: {
        boost: { name: 3, summary: 1, entity_type: 0.5 },
        fuzzy: 0.2,
        prefix: true,
      },
    });

    this.edgeIndex = new MiniSearch<EdgeDocument>({
      fields: ['name', 'fact'],
      storeFields: ['name', 'fact'],
      searchOptions: {
        boost: { fact: 2, name: 1 },
        fuzzy: 0.2,
        prefix: true,
      },
    });
  }

  indexEntity(id: string, fields: { name: string; summary: string; entity_type: string }): void {
    // Remove existing entry if present to allow re-indexing
    if (this.entityIndex.has(id)) {
      this.entityIndex.discard(id);
    }
    this.entityIndex.add({ id, ...fields });
  }

  indexEdge(id: string, fields: { name: string; fact: string }): void {
    if (this.edgeIndex.has(id)) {
      this.edgeIndex.discard(id);
    }
    this.edgeIndex.add({ id, ...fields });
  }

  removeEntity(id: string): void {
    if (this.entityIndex.has(id)) {
      this.entityIndex.discard(id);
    }
  }

  removeEdge(id: string): void {
    if (this.edgeIndex.has(id)) {
      this.edgeIndex.discard(id);
    }
  }

  searchEntities(query: string, limit: number): TextSearchResult[] {
    if (!query.trim()) return [];

    const results = this.entityIndex.search(query);
    const maxScore = results.length > 0 ? results[0].score : 1;

    return results.slice(0, limit).map((r) => ({
      id: r.id as string,
      score: maxScore > 0 ? r.score / maxScore : 0,
    }));
  }

  searchEdges(query: string, limit: number): TextSearchResult[] {
    if (!query.trim()) return [];

    const results = this.edgeIndex.search(query);
    const maxScore = results.length > 0 ? results[0].score : 1;

    return results.slice(0, limit).map((r) => ({
      id: r.id as string,
      score: maxScore > 0 ? r.score / maxScore : 0,
    }));
  }

  clear(): void {
    this.entityIndex.removeAll();
    this.edgeIndex.removeAll();
  }
}
