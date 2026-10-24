import {
  ExtractionError,
  reportExtractionError,
  type ExtractionDiagnostics,
} from './ExtractionDiagnostics';
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

  constructor(
    llm: LlmClient,
    private diagnostics?: ExtractionDiagnostics,
  ) {
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
    let operationFailed = false;
    const end = this.diagnostics?.begin('contradictions');
    try {
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
        if (
          !result ||
          typeof result.is_contradiction !== 'boolean' ||
          (result.is_contradiction && typeof result.explanation !== 'string')
        )
          throw new ExtractionError('invalid_response');
        this.diagnostics?.success('contradictions');

        if (result.is_contradiction) {
          return {
            isContradiction: true,
            explanation: result.explanation,
            expiredAt: nowIso(),
          };
        }

        return { isContradiction: false };
      } catch (error) {
        operationFailed = true;
        // If LLM fails, assume no contradiction (safer to keep existing data)
        reportExtractionError('contradictions', error, this.diagnostics);
        return { isContradiction: false };
      }
    } finally {
      end?.(operationFailed);
    }
  }
}
