import type { EpisodeKind, EpisodeReviewStatus, EpisodeRole, EpisodeTrustLevel } from '../schemas';

export interface ExtractionSource {
  content: string;
  role: EpisodeRole;
  episode_kind: EpisodeKind;
  episode_uuid?: string | null;
  source_message_id?: string | null;
  sender_id?: string | null;
  sender_name?: string | null;
  trust_level?: EpisodeTrustLevel;
  review_status?: EpisodeReviewStatus;
  reference_time?: string;
}

export function formatExtractionSources(sources: ExtractionSource[]): string {
  return sources
    .map((source, index) => {
      const metadata = [
        `role=${source.role}`,
        `kind=${source.episode_kind}`,
        source.episode_uuid ? `episode_uuid=${source.episode_uuid}` : null,
        source.source_message_id ? `source_message_id=${source.source_message_id}` : null,
        source.sender_id ? `sender_id=${source.sender_id}` : null,
        source.sender_name ? `sender_name=${source.sender_name}` : null,
        source.trust_level ? `trust=${source.trust_level}` : null,
        source.review_status ? `review=${source.review_status}` : null,
        source.reference_time ? `reference_time=${source.reference_time}` : null,
      ]
        .filter(Boolean)
        .join(', ');
      return [`Source ${index + 1} [${metadata}]`, '<content>', source.content, '</content>'].join(
        '\n',
      );
    })
    .join('\n\n');
}

export function extractionEpisodeUuids(sources: ExtractionSource[]): string[] {
  return [
    ...new Set(
      sources
        .map((source) => source.episode_uuid)
        .filter((uuid): uuid is string => typeof uuid === 'string' && uuid.length > 0),
    ),
  ];
}
