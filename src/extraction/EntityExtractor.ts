import type { LlmClient } from './LlmClient';
import { ENTITY_EXTRACTION_SYSTEM, entityExtractionUser } from './prompts';

export interface ExtractedEntity {
  name: string;
  entity_type: string;
  summary: string;
}

interface EntityExtractionResult {
  entities: ExtractedEntity[];
}

export class EntityExtractor {
  private llm: LlmClient;

  constructor(llm: LlmClient) {
    this.llm = llm;
  }

  async extract(
    humanMessage: string,
    aiMessage: string,
    entityTypes: string[],
    existingEntities: string[],
  ): Promise<ExtractedEntity[]> {
    try {
      const result = await this.llm.chatJson<EntityExtractionResult>([
        { role: 'system', content: ENTITY_EXTRACTION_SYSTEM },
        {
          role: 'user',
          content: entityExtractionUser(humanMessage, aiMessage, entityTypes, existingEntities),
        },
      ]);

      if (!result.entities || !Array.isArray(result.entities)) {
        return [];
      }

      const allowedTypes = new Set(entityTypes.map((type) => type.toLowerCase().trim()));

      return result.entities
        .filter(
          (e) =>
            typeof e.name === 'string' &&
            e.name.trim() !== '' &&
            typeof e.entity_type === 'string' &&
            e.entity_type.trim() !== '' &&
            typeof e.summary === 'string' &&
            (allowedTypes.size === 0 || allowedTypes.has(e.entity_type.toLowerCase().trim())),
        )
        .map((e) => ({
          name: e.name.trim(),
          entity_type: e.entity_type.trim(),
          summary: e.summary.trim(),
        }));
    } catch (error) {
      // Extraction is best-effort; don't break the conversation
      console.warn('Engram: Entity extraction failed:', (error as Error).message);
      return [];
    }
  }
}
