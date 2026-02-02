import type { LlmClient } from './LlmClient';
import {
  EDGE_DEDUP_SYSTEM,
  edgeDedupUser,
  CROSS_NAME_EDGE_DEDUP_SYSTEM,
  crossNameEdgeDedupUser,
} from './prompts';

interface EdgeDedupResult {
  is_duplicate: boolean;
  merged_fact: string;
}

export class EdgeDeduplicator {
  private llm: LlmClient;

  constructor(llm: LlmClient) {
    this.llm = llm;
  }

  /**
   * Check if a new fact is a duplicate of an existing fact for the same edge.
   * Uses exact fact match first (fast), then LLM fallback for semantic comparison.
   */
  async isDuplicate(
    existingFact: string,
    newFact: string,
    edgeName: string,
    sourceEntity: string,
    targetEntity: string,
  ): Promise<{ isDuplicate: boolean; mergedFact?: string }> {
    // Fast path: exact fact match (case-insensitive, trimmed)
    if (existingFact.toLowerCase().trim() === newFact.toLowerCase().trim()) {
      return { isDuplicate: true };
    }

    // LLM fallback for semantic deduplication
    try {
      const result = await this.llm.chatJson<EdgeDedupResult>([
        { role: 'system', content: EDGE_DEDUP_SYSTEM },
        {
          role: 'user',
          content: edgeDedupUser(existingFact, newFact, edgeName, sourceEntity, targetEntity),
        },
      ]);

      return {
        isDuplicate: result.is_duplicate === true,
        mergedFact: result.is_duplicate ? result.merged_fact : undefined,
      };
    } catch (error) {
      // If LLM fails, assume not duplicate (safer — will create new edge)
      console.warn('Engram: Edge deduplication failed:', (error as Error).message);
      return { isDuplicate: false };
    }
  }

  /**
   * Check if a new edge is a semantic duplicate of an existing edge between
   * the same entity pair, even though their relationship names differ.
   * Example: WORKS_AT and EMPLOYED_BY for the same Person→Company.
   *
   * Unlike isDuplicate(), there is no fast-path exact-match shortcut here.
   * Different names warrant an LLM evaluation even when facts are similar,
   * because the name difference may signal genuinely different relationships
   * (e.g., WORKS_AT vs MANAGES).
   */
  async isDuplicateCrossName(
    existingFact: string,
    newFact: string,
    existingEdgeName: string,
    newEdgeName: string,
    sourceEntity: string,
    targetEntity: string,
  ): Promise<{ isDuplicate: boolean; mergedFact?: string }> {
    try {
      const result = await this.llm.chatJson<EdgeDedupResult>([
        { role: 'system', content: CROSS_NAME_EDGE_DEDUP_SYSTEM },
        {
          role: 'user',
          content: crossNameEdgeDedupUser(
            existingFact,
            newFact,
            existingEdgeName,
            newEdgeName,
            sourceEntity,
            targetEntity,
          ),
        },
      ]);

      return {
        isDuplicate: result.is_duplicate === true,
        mergedFact: result.is_duplicate ? result.merged_fact : undefined,
      };
    } catch (error) {
      // If LLM fails, assume not duplicate (safer — will create new edge)
      console.warn('Engram: Cross-name edge deduplication failed:', (error as Error).message);
      return { isDuplicate: false };
    }
  }
}
