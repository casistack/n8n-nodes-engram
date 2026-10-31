// Implementation is co-located with the claim index so the integrity path can
// index its own single parse privately. This module keeps the existing surface.
export {
  AutonomousPersonalRecordIntegrityV4Error,
  assertAutonomousPersonalRecordIntegrityV4,
  createIntegrityCheckedAutonomousPersonalClaimIndexV4,
  getRegisteredAutonomousPersonalClaimIndexGraphV4,
  parseIntegrityCheckedAutonomousPersonalGraphV4,
  validateOwnedAutonomousPersonalRecordGraphV4,
} from '../extraction/AutonomousPersonalQualifiedClaimV4';
