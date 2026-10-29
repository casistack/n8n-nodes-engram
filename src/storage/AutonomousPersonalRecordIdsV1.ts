import { v5 as uuidV5 } from 'uuid';
import { canonicalAutomaticCaptureV2 } from '../schemas/AutomaticCapture.schema';
import {
  AutonomousPersonalRecordIdsV1InputOwnedDataSchema,
  AutonomousPersonalRecordIdsV1OwnedDataSchema,
  type AutonomousPersonalRecordIdsV1,
} from '../schemas/AutonomousPersonalRecordIdsV1.schema';
import { cloneBoundedAutomaticCaptureJson } from './BoundedAutomaticCaptureJson';

/** Deterministic family-specific DATA IDs; this does not authorize any graph mutation. */
export function deriveAutonomousPersonalRecordIdsV1(input: unknown): AutonomousPersonalRecordIdsV1 {
  try {
    const owned = AutonomousPersonalRecordIdsV1InputOwnedDataSchema.parse(
      cloneBoundedAutomaticCaptureJson<unknown>(input, 'policyData'),
    );
    const id = (domain: string) =>
      uuidV5(canonicalAutomaticCaptureV2({ domain, ...owned }), uuidV5.URL);
    return Object.freeze(
      AutonomousPersonalRecordIdsV1OwnedDataSchema.parse({
        claimId: id('engram-autonomous-personal-claim-row-v1'),
        valueId: id('engram-autonomous-personal-value-row-v1'),
      }),
    );
  } catch {
    const error = new Error('invalid_autonomous_personal_record_ids_data');
    error.name = 'AutonomousPersonalRecordIdsV1Error';
    throw Object.freeze(error);
  }
}
