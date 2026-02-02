import type { LlmClient } from './LlmClient';
import { CONTRADICTION_SYSTEM, contradictionUser } from './prompts';
import { nowIso } from '../utils/temporal';

interface ContradictionResult {
  is_contradiction: boolean;
  explanation: string;
}

export interface ContradictionResolution {
  isContradiction: boolean;
  explanation?: string;
  /** If contradicted, the old edge should be expired at this timestamp */
  expiredAt?: string;
}

export class ContradictionDetector {
  private llm: LlmClient;

  constructor(llm: LlmClient) {
    this.llm = llm;
  }

  /**
   * Check if a new fact contradicts an existing fact between the same entities.
   * If contradicted, the old edge should be marked as expired (temporal invalidation).
   */
  async detect(
    existingFact: string,
    newFact: string,
    sourceEntity: string,
    targetEntity: string,
    existingEdgeName?: string,
    newEdgeName?: string,
  ): Promise<ContradictionResolution> {
    try {
      const result = await this.llm.chatJson<ContradictionResult>([
        { role: 'system', content: CONTRADICTION_SYSTEM },
        {
          role: 'user',
          content: contradictionUser(
            existingFact,
            newFact,
            sourceEntity,
            targetEntity,
            existingEdgeName,
            newEdgeName,
          ),
        },
      ]);

      if (result.is_contradiction) {
        return {
          isContradiction: true,
          explanation: result.explanation,
          expiredAt: nowIso(),
        };
      }

      return { isContradiction: false };
    } catch (error) {
      // If LLM fails, assume no contradiction (safer to keep existing data)
      console.warn('Engram: Contradiction detection failed:', (error as Error).message);
      return { isContradiction: false };
    }
  }
}
