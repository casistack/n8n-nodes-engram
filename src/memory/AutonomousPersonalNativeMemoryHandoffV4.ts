// Preserve the existing internal import path while sharing one lineage registry with storage.
export {
  publishAutonomousPersonalMemoryHandoffV4,
  consumeAutonomousPersonalMemoryHandoffV4,
  getAutonomousPersonalMemoryLineageOriginV4,
  type PrivateAutonomousPersonalMemoryLineageV4,
  type NativeAutonomousPersonalMemoryContextV4,
} from '../storage/AutonomousPersonalNativeMemoryHandoffV4';
