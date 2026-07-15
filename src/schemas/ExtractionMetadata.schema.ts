import { z } from 'zod';
import { EpisodeReviewStatusSchema } from './EpisodicNode.schema';

export const ExtractionSourceSchema = z.enum(['llm', 'manual', 'import']);
export const ExtractionThresholdDecisionSchema = z.enum([
  'pending_review',
  'auto_accepted',
  'below_threshold',
  'manually_reviewed',
]);

const nullableReviewer = z.string().trim().min(1).max(512).nullable().default(null);

export const LegacyExtractionMetadataSchema = z.object({
  version: z.literal(1),
  source: ExtractionSourceSchema,
  confidence: z.number().min(0).max(1).nullable().default(null),
  reviewed: z.boolean().default(false),
  extracted_at: z.string().datetime(),
  episode_uuids: z.array(z.string().uuid()).default([]),
});

export const ExtractionMetadataV2Schema = z.object({
  version: z.literal(2),
  source: ExtractionSourceSchema,
  confidence: z.number().min(0).max(1).nullable().default(null),
  review_status: EpisodeReviewStatusSchema.default('proposed'),
  threshold_decision: ExtractionThresholdDecisionSchema.default('pending_review'),
  extracted_at: z.string().datetime(),
  episode_uuids: z.array(z.string().uuid()).default([]),
  reviewed_at: z.string().datetime().nullable().default(null),
  reviewed_by: nullableReviewer,
});

export const ExtractionMetadataSchema = z.discriminatedUnion('version', [
  LegacyExtractionMetadataSchema,
  ExtractionMetadataV2Schema,
]);

export type LegacyExtractionMetadata = z.infer<typeof LegacyExtractionMetadataSchema>;
export type ExtractionMetadataV2 = z.infer<typeof ExtractionMetadataV2Schema>;
export type ExtractionMetadata = z.infer<typeof ExtractionMetadataSchema>;

export interface ExtractionThresholdPolicy {
  autoAcceptThreshold: number;
  rejectBelowThreshold: number;
}

export interface ExtractionReviewDecision {
  review_status: 'proposed' | 'accepted' | 'rejected';
  threshold_decision: 'pending_review' | 'auto_accepted' | 'below_threshold';
}

export function decideExtractionReview(
  confidence: number | null,
  policy?: ExtractionThresholdPolicy,
): ExtractionReviewDecision {
  if (confidence === null || !policy) {
    return { review_status: 'proposed', threshold_decision: 'pending_review' };
  }
  if (
    !Number.isFinite(policy.autoAcceptThreshold) ||
    !Number.isFinite(policy.rejectBelowThreshold) ||
    policy.autoAcceptThreshold < 0 ||
    policy.autoAcceptThreshold > 1 ||
    policy.rejectBelowThreshold < 0 ||
    policy.rejectBelowThreshold > 1 ||
    policy.rejectBelowThreshold > policy.autoAcceptThreshold
  ) {
    throw new Error(
      'Extraction thresholds must be between 0 and 1, with reject threshold not above auto-accept threshold',
    );
  }
  if (confidence >= policy.autoAcceptThreshold) {
    return { review_status: 'accepted', threshold_decision: 'auto_accepted' };
  }
  if (confidence < policy.rejectBelowThreshold) {
    return { review_status: 'rejected', threshold_decision: 'below_threshold' };
  }
  return { review_status: 'proposed', threshold_decision: 'pending_review' };
}

export function extractionMetadataFromAttributes(
  attributes: Record<string, unknown>,
): ExtractionMetadataV2 | null {
  return normalizeExtractionMetadata(attributes.engram_extraction);
}

export function reviewExtractionMetadata(
  current: unknown,
  reviewStatus: 'proposed' | 'accepted' | 'rejected',
  reviewer: string,
  reviewedAt: string,
  confidence?: number | null,
): ExtractionMetadataV2 {
  const normalized = normalizeExtractionMetadata(current);
  return ExtractionMetadataV2Schema.parse({
    version: 2,
    source: normalized?.source ?? 'manual',
    confidence: confidence === undefined ? (normalized?.confidence ?? null) : confidence,
    review_status: reviewStatus,
    threshold_decision: 'manually_reviewed',
    extracted_at: normalized?.extracted_at ?? reviewedAt,
    episode_uuids: normalized?.episode_uuids ?? [],
    reviewed_at: reviewedAt,
    reviewed_by: reviewer,
  });
}

export function normalizeExtractionMetadata(value: unknown): ExtractionMetadataV2 | null {
  const parsed = ExtractionMetadataSchema.safeParse(value);
  if (!parsed.success) return null;
  if (parsed.data.version === 2) return parsed.data;

  return ExtractionMetadataV2Schema.parse({
    version: 2,
    source: parsed.data.source,
    confidence: parsed.data.confidence,
    review_status: parsed.data.reviewed ? 'accepted' : 'proposed',
    threshold_decision: parsed.data.reviewed ? 'manually_reviewed' : 'pending_review',
    extracted_at: parsed.data.extracted_at,
    episode_uuids: parsed.data.episode_uuids,
  });
}
