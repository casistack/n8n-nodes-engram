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
			return result.relationships.filter(
				(r) =>
					typeof r.source_entity === 'string' &&
					typeof r.target_entity === 'string' &&
					typeof r.name === 'string' &&
					typeof r.fact === 'string' &&
					entitySet.has(r.source_entity.toLowerCase()) &&
					entitySet.has(r.target_entity.toLowerCase()),
			);
		} catch (error) {
			console.warn('Engram: Relationship extraction failed:', (error as Error).message);
			return [];
		}
	}
}
