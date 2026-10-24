import {
  ExtractionError,
  reportExtractionError,
  type ExtractionDiagnostics,
} from './ExtractionDiagnostics';
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

  constructor(
    llm: LlmClient,
    private diagnostics?: ExtractionDiagnostics,
  ) {
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
    let operationFailed = false;
    const end = this.diagnostics?.begin('edge_dedup');
    try {
      // Fast path: exact fact match (case-insensitive, trimmed)
      if (existingFact.toLowerCase().trim() === newFact.toLowerCase().trim()) {
        this.diagnostics?.success('edge_dedup');
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
        if (
          !result ||
          typeof result.is_duplicate !== 'boolean' ||
          (result.is_duplicate && typeof result.merged_fact !== 'string')
        )
          throw new ExtractionError('invalid_response');
        this.diagnostics?.success('edge_dedup');

        return {
          isDuplicate: result.is_duplicate === true,
          mergedFact: result.is_duplicate ? result.merged_fact : undefined,
        };
      } catch (error) {
        operationFailed = true;
        // If LLM fails, assume not duplicate (safer — will create new edge)
        reportExtractionError('edge_dedup', error, this.diagnostics);
        return { isDuplicate: false };
      }
    } finally {
      end?.(operationFailed);
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
    let operationFailed = false;
    const end = this.diagnostics?.begin('cross_edge_dedup');
    try {
      try {
        const result = await this.llm.chatJson<EdgeDedupResult>(
          [
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
          ],
          { stage: 'cross_edge_dedup' },
        );
        if (
          !result ||
          typeof result.is_duplicate !== 'boolean' ||
          (result.is_duplicate && typeof result.merged_fact !== 'string')
        )
          throw new ExtractionError('invalid_response');
        this.diagnostics?.success('cross_edge_dedup');

        return {
          isDuplicate: result.is_duplicate === true,
          mergedFact: result.is_duplicate ? result.merged_fact : undefined,
        };
      } catch (error) {
        operationFailed = true;
        // If LLM fails, assume not duplicate (safer — will create new edge)
        reportExtractionError('cross_edge_dedup', error, this.diagnostics);
        return { isDuplicate: false };
      }
    } finally {
      end?.(operationFailed);
    }
  }
}
