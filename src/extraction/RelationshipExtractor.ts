import type { LlmClient } from './LlmClient';
import { RELATIONSHIP_EXTRACTION_SYSTEM, relationshipExtractionUser } from './prompts';

export interface ExtractedRelationship {
  source_entity: string;
  target_entity: string;
  name: string;
  fact: string;
}

interface RelationshipExtractionResult {
  relationships: ExtractedRelationship[];
}

export class RelationshipExtractor {
  private llm: LlmClient;

  constructor(llm: LlmClient) {
    this.llm = llm;
  }

  async extract(
    humanMessage: string,
    aiMessage: string,
    entityNames: string[],
  ): Promise<ExtractedRelationship[]> {
    if (entityNames.length < 2) return [];

    try {
      const result = await this.llm.chatJson<RelationshipExtractionResult>([
        { role: 'system', content: RELATIONSHIP_EXTRACTION_SYSTEM },
        {
          role: 'user',
          content: relationshipExtractionUser(humanMessage, aiMessage, entityNames),
        },
      ]);

      if (!result.relationships || !Array.isArray(result.relationships)) {
        return [];
      }

      // Validate each relationship references known entities
      const entitySet = new Set(entityNames.map((n) => n.toLowerCase()));
      return result.relationships
        .filter(
          (r) =>
            typeof r.source_entity === 'string' &&
            typeof r.target_entity === 'string' &&
            typeof r.name === 'string' &&
            r.name.trim() !== '' &&
            typeof r.fact === 'string' &&
            r.fact.trim() !== '' &&
            r.source_entity.toLowerCase().trim() !== r.target_entity.toLowerCase().trim() &&
            entitySet.has(r.source_entity.toLowerCase().trim()) &&
            entitySet.has(r.target_entity.toLowerCase().trim()),
        )
        .map((r) => ({
          source_entity: r.source_entity.trim(),
          target_entity: r.target_entity.trim(),
          name: r.name.trim(),
          fact: r.fact.trim(),
        }));
    } catch (error) {
      console.warn('Engram: Relationship extraction failed:', (error as Error).message);
      return [];
    }
  }
}
