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
					content: entityExtractionUser(
						humanMessage,
						aiMessage,
						entityTypes,
						existingEntities,
					),
				},
			]);

			if (!result.entities || !Array.isArray(result.entities)) {
				return [];
			}

			return result.entities.filter(
				(e) =>
					typeof e.name === 'string' &&
					e.name.trim() !== '' &&
					typeof e.entity_type === 'string' &&
					typeof e.summary === 'string',
			);
		} catch (error) {
			// Extraction is best-effort; don't break the conversation
			console.warn('Engram: Entity extraction failed:', (error as Error).message);
			return [];
		}
	}
}
