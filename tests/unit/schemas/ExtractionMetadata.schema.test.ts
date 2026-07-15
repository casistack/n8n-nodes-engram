import {
  ExtractionMetadataSchema,
  ExtractionMetadataV2Schema,
  decideExtractionReview,
  normalizeExtractionMetadata,
  reviewExtractionMetadata,
} from '../../../src/schemas';

const extractedAt = '2026-07-13T20:00:00.000Z';
const episodeUuid = '00000000-0000-4000-8000-000000000001';

describe('ExtractionMetadataSchema', () => {
  it('creates proposed v2 metadata by default', () => {
    const metadata = ExtractionMetadataV2Schema.parse({
      version: 2,
      source: 'llm',
      extracted_at: extractedAt,
      episode_uuids: [episodeUuid],
    });

    expect(metadata).toEqual(
      expect.objectContaining({
        confidence: null,
        review_status: 'proposed',
        threshold_decision: 'pending_review',
        reviewed_at: null,
        reviewed_by: null,
      }),
    );
  });

  it('normalizes reviewed v1 metadata to accepted v2 metadata', () => {
    const metadata = normalizeExtractionMetadata({
      version: 1,
      source: 'llm',
      confidence: 0.8,
      reviewed: true,
      extracted_at: extractedAt,
      episode_uuids: [episodeUuid],
    });

    expect(metadata).toEqual(
      expect.objectContaining({
        version: 2,
        confidence: 0.8,
        review_status: 'accepted',
        threshold_decision: 'manually_reviewed',
      }),
    );
  });

  it('keeps unreviewed v1 metadata proposed', () => {
    const metadata = normalizeExtractionMetadata({
      version: 1,
      source: 'llm',
      confidence: null,
      reviewed: false,
      extracted_at: extractedAt,
    });

    expect(metadata?.review_status).toBe('proposed');
    expect(metadata?.threshold_decision).toBe('pending_review');
  });

  it('rejects malformed or unsupported metadata', () => {
    expect(normalizeExtractionMetadata({ version: 99 })).toBeNull();
    expect(
      ExtractionMetadataSchema.safeParse({
        version: 2,
        source: 'llm',
        confidence: 2,
        extracted_at: extractedAt,
      }).success,
    ).toBe(false);
  });

  it('applies confidence thresholds at deterministic boundaries', () => {
    const policy = { autoAcceptThreshold: 0.8, rejectBelowThreshold: 0.3 };
    expect(decideExtractionReview(0.8, policy)).toEqual({
      review_status: 'accepted',
      threshold_decision: 'auto_accepted',
    });
    expect(decideExtractionReview(0.3, policy)).toEqual({
      review_status: 'proposed',
      threshold_decision: 'pending_review',
    });
    expect(decideExtractionReview(0.29, policy)).toEqual({
      review_status: 'rejected',
      threshold_decision: 'below_threshold',
    });
  });

  it('validates threshold ordering and records manual review audit data', () => {
    expect(() =>
      decideExtractionReview(0.5, {
        autoAcceptThreshold: 0.4,
        rejectBelowThreshold: 0.6,
      }),
    ).toThrow('reject threshold not above auto-accept threshold');

    const reviewed = reviewExtractionMetadata(
      {
        version: 2,
        source: 'llm',
        confidence: 0.5,
        review_status: 'proposed',
        threshold_decision: 'pending_review',
        extracted_at: extractedAt,
      },
      'accepted',
      'operator-1',
      '2026-07-15T16:00:00.000Z',
      0.9,
    );
    expect(reviewed).toEqual(
      expect.objectContaining({
        review_status: 'accepted',
        threshold_decision: 'manually_reviewed',
        confidence: 0.9,
        reviewed_by: 'operator-1',
        reviewed_at: '2026-07-15T16:00:00.000Z',
      }),
    );
  });
});
