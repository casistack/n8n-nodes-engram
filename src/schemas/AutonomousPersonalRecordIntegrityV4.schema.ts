import { z } from 'zod';

export const AutonomousPersonalRecordIntegrityV4FailureReasonSchema = z.enum([
  'invalid_snapshot',
  'snapshot_capacity',
  'invalid_creator',
  'invalid_pair',
  'orphan_record',
  'inspection_incomplete',
]);

export type AutonomousPersonalRecordIntegrityV4FailureReason = z.infer<
  typeof AutonomousPersonalRecordIntegrityV4FailureReasonSchema
>;
