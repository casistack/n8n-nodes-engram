import {
  ExtractionError,
  reportExtractionError,
  type ExtractionDiagnostics,
} from './ExtractionDiagnostics';
import type { LlmClient } from './LlmClient';
import { DEDUPLICATION_SYSTEM, deduplicationUser } from './prompts';

interface DeduplicationResult {
  is_duplicate: boolean;
  merged_summary: string;
}

export class EntityDeduplicator {
  private llm: LlmClient;

  constructor(
    llm: LlmClient,
    private diagnostics?: ExtractionDiagnostics,
  ) {
    this.llm = llm;
  }

  /**
   * Check if a new entity is a duplicate of an existing entity.
   * Uses exact name match first (fast), then LLM fallback for fuzzy cases.
   */
  async isDuplicate(
    newEntity: { name: string; summary: string; entity_type: string },
    existingEntity: { name: string; summary: string; entity_type: string },
  ): Promise<{ isDuplicate: boolean; mergedSummary?: string }> {
    // Fast path: exact name match (case-insensitive)
    if (newEntity.name.toLowerCase().trim() === existingEntity.name.toLowerCase().trim()) {
      this.diagnostics?.success('entity_dedup');
      // Same name = same entity. Merge summaries by keeping the longer/newer one.
      const mergedSummary =
        newEntity.summary.length > existingEntity.summary.length
          ? newEntity.summary
          : existingEntity.summary;
      return { isDuplicate: true, mergedSummary };
    }

    // Different entity types are unlikely to be duplicates
    if (newEntity.entity_type !== existingEntity.entity_type) {
      this.diagnostics?.success('entity_dedup');
      return { isDuplicate: false };
    }

    // LLM fallback for fuzzy deduplication (e.g., "Bob" vs "Robert")
    try {
      const result = await this.llm.chatJson<DeduplicationResult>([
        { role: 'system', content: DEDUPLICATION_SYSTEM },
        {
          role: 'user',
          content: deduplicationUser(newEntity, existingEntity),
        },
      ]);
      if (
        !result ||
        typeof result.is_duplicate !== 'boolean' ||
        (result.is_duplicate && typeof result.merged_summary !== 'string')
      )
        throw new ExtractionError('invalid_response');
      this.diagnostics?.success('entity_dedup');

      return {
        isDuplicate: result.is_duplicate === true,
        mergedSummary: result.is_duplicate ? result.merged_summary : undefined,
      };
    } catch (error) {
      // If LLM fails, assume not duplicate (safer)
      reportExtractionError('entity_dedup', error, this.diagnostics);
      return { isDuplicate: false };
    }
  }
}
