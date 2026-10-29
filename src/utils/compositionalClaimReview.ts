import { types as utilTypes } from 'util';
import { cloneBoundedAutomaticCaptureJson } from '../storage/BoundedAutomaticCaptureJson';
import { CompositionalAutomaticClaimMetadataV2Schema } from '../schemas/CompositionalAutomaticMemory.schema';

/** Dispatch only. Actual backend qualification is required before paired review. */
export function compositionalClaimReviewFamily(
  attributes: unknown,
): 'ordinary' | 'literal' | 'compositional' | 'invalid' {
  if (
    attributes === null ||
    typeof attributes !== 'object' ||
    Array.isArray(attributes) ||
    utilTypes.isProxy(attributes)
  )
    return 'invalid';
  try {
    const property = Object.getOwnPropertyDescriptor(attributes, 'engram_claim_v1');
    if (!property) return 'ordinary';
    if (!property.enumerable || !('value' in property)) return 'invalid';
    const marker = cloneBoundedAutomaticCaptureJson<Record<string, unknown>>(
      property.value,
      'beginRequest',
    );
    if (marker === null || typeof marker !== 'object' || Array.isArray(marker)) return 'invalid';
    if (
      marker.version === 1 &&
      !(typeof marker.generation === 'string' && marker.generation.startsWith('compositional'))
    )
      return 'literal';
    return CompositionalAutomaticClaimMetadataV2Schema.safeParse(marker).success
      ? 'compositional'
      : 'invalid';
  } catch {
    return 'invalid';
  }
}
