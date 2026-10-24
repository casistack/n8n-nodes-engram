import {
  ExtractionError,
  reportExtractionError,
  type ExtractionDiagnostics,
} from './ExtractionDiagnostics';
import type { LlmClient } from './LlmClient';
import {
  RELATIONSHIP_EXTRACTION_SYSTEM,
  relationshipExtractionSourcesUser,
  relationshipExtractionUser,
} from './prompts';
import { formatExtractionSources, type ExtractionSource } from './ExtractionSource';

export interface ExtractedRelationship {
  source_entity: string;
  target_entity: string;
  name: string;
  fact: string;
  confidence: number | null;
}

interface RelationshipExtractionResult {
  relationships: ExtractedRelationship[];
}

export class RelationshipExtractor {
  private llm: LlmClient;

  constructor(
    llm: LlmClient,
    private diagnostics?: ExtractionDiagnostics,
  ) {
    this.llm = llm;
  }

  async extract(
    humanMessage: string,
    aiMessage: string,
    entityNames: string[],
  ): Promise<ExtractedRelationship[]> {
    return this.extractWithPrompt(
      relationshipExtractionUser(humanMessage, aiMessage, entityNames),
      entityNames,
      false,
    );
  }

  async extractSources(
    sources: ExtractionSource[],
    entityNames: string[],
    requireConfidence = false,
  ): Promise<ExtractedRelationship[]> {
    return this.extractWithPrompt(
      relationshipExtractionSourcesUser(formatExtractionSources(sources), entityNames),
      entityNames,
      requireConfidence,
    );
  }

  private async extractWithPrompt(
    prompt: string,
    entityNames: string[],
    requireConfidence: boolean,
  ): Promise<ExtractedRelationship[]> {
    let operationFailed = false;
    const end = this.diagnostics?.begin('relationships');
    try {
      if (entityNames.length < 2) {
        this.diagnostics?.skip('relationships');
        return [];
      }

      try {
        const result = await this.llm.chatJson<RelationshipExtractionResult>([
          { role: 'system', content: RELATIONSHIP_EXTRACTION_SYSTEM },
          { role: 'user', content: prompt },
        ]);

        if (!result || !Array.isArray(result.relationships))
          throw new ExtractionError('invalid_response');
        this.diagnostics?.success('relationships');

        // Validate each relationship references known entities
        const entitySet = new Set(entityNames.map((n) => n.toLowerCase()));
        return result.relationships
          .filter((r) => {
            if (
              !r ||
              typeof r !== 'object' ||
              typeof r.source_entity !== 'string' ||
              typeof r.target_entity !== 'string' ||
              typeof r.name !== 'string' ||
              !r.name.trim() ||
              typeof r.fact !== 'string' ||
              !r.fact.trim()
            ) {
              operationFailed = true;
              this.diagnostics?.malformed('relationships');
              return false;
            }
            const eligible =
              (!requireConfidence ||
                (typeof r.confidence === 'number' &&
                  Number.isFinite(r.confidence) &&
                  r.confidence >= 0 &&
                  r.confidence <= 1)) &&
              r.source_entity.toLowerCase().trim() !== r.target_entity.toLowerCase().trim() &&
              entitySet.has(r.source_entity.toLowerCase().trim()) &&
              entitySet.has(r.target_entity.toLowerCase().trim());
            if (!eligible) this.diagnostics?.increment('filtered');
            return eligible;
          })
          .map((r) => ({
            source_entity: r.source_entity.trim(),
            target_entity: r.target_entity.trim(),
            name: r.name.trim(),
            fact: r.fact.trim(),
            confidence:
              typeof r.confidence === 'number' &&
              Number.isFinite(r.confidence) &&
              r.confidence >= 0 &&
              r.confidence <= 1
                ? r.confidence
                : null,
          }));
      } catch (error) {
        operationFailed = true;
        reportExtractionError('relationships', error, this.diagnostics);
        return [];
      }
    } finally {
      end?.(operationFailed);
    }
  }
}
