import { ExtractionBudgetError } from '../extraction/ExtractionDiagnostics';
import { AsyncLocalStorage } from 'async_hooks';
import { types as utilTypes } from 'util';
import { compositionalCaptureCompletionDecisionKindV3 } from './CompositionalCaptureCompletionDiagnosticsV3';
import {
  CompositionalRetrievalSnapshotV3Schema,
  type CompositionalRetrievalSnapshotResultV3,
} from '../schemas/CompositionalRetrievalSnapshotV3.schema';
import { createNeo4jCompositionalReadChargeV3 } from './Neo4jCompositionalReadBudgetV3';
import {
  buildCommittedCompositionalCaptureOperationV3,
  CompositionalCaptureTerminalOperationFailureV3,
} from './CompositionalCaptureTerminalOperationV3';
import { assertCompositionalRecordIdentityV3 } from './CompositionalRecordIdentityV3';
import { createCompositionalAutomaticCaptureHandleRegistryV3 } from './CompositionalAutomaticCaptureHandlesV3';
import {
  startCompositionalBackendBeginV3,
  selectCompositionalCaptureNewSourceV3,
} from './CompositionalCaptureBackendBeginV3';
import { prepareCompositionalHumanCaptureBeginV3 } from './CompositionalAutomaticCaptureBeginV3';
import { prepareAutonomousPersonalCaptureSnapshotV4 } from './AutonomousPersonalCaptureBeginV4';
import { autonomousPersonalCaptureStorageFailureV4 } from './AutonomousPersonalCaptureStorageDiagnosticsV4';
import {
  consumeAutonomousPersonalCaptureAttemptV4,
  bindAutonomousPersonalCapturePreflightV4,
  stageFreshAutonomousPersonalCaptureV4,
  beginAutonomousPersonalCaptureReadbackV4,
  issueInitialAutonomousPersonalCaptureHandleV4,
  closeAutonomousPersonalCaptureAttemptV4,
  getAutonomousPersonalCaptureBeginV4InternalResultSchema,
  getAutonomousPersonalCaptureFailureKindV4,
  isAutonomousPersonalCaptureProvenCommitBudgetFailureV4,
  consumeAutonomousPersonalCaptureProviderPreflightV4,
  getAutonomousPersonalCaptureProviderPreflightAccessV4,
  bindAutonomousPersonalCaptureProviderPreflightV4,
  closeAutonomousPersonalCaptureProviderPreflightV4,
  getAutonomousPersonalCaptureProviderFailureKindV4,
  consumeAutonomousPersonalCompletionHandleV4,
  getAutonomousPersonalCompletionAccessV4,
  assertAutonomousPersonalCompletionPlanAggregateBytesV4,
  assertAutonomousPersonalCompletionNativeAggregateBytesV4,
  type PrivateAutonomousPersonalCompletionAccessV4,
  type PrivateAutonomousPersonalCompletionHandleV4,
  type AutonomousPersonalCaptureBeginV4InternalResult,
} from './AutonomousPersonalCaptureHandlesV4';
import {
  AutonomousPersonalCompletionBackendRegistryV4,
  registerAutonomousPersonalCompletionBackendVerifierV4,
  type PrivateAutonomousPersonalCompletionBackendOutcomeV4,
  type TrustedAutonomousPersonalCompletionWitnessLinkV4,
} from './AutonomousPersonalCompletionBackendRegistryV4';
import {
  AutonomousPersonalCompletionPlanV4InputOwnedDataSchema,
  type AutonomousPersonalCompletionPlanV4,
  type AutonomousPersonalCompletionPlanV4Input,
  type AutonomousPersonalCompletionPlanV4NoWriteReason,
} from '../schemas/AutonomousPersonalCompletionPlanV4.schema';
import {
  AutonomousPersonalCompletionStorageV4ResultOwnedDataSchema,
  type AutonomousPersonalCompletionStorageV4Result,
} from '../schemas/AutonomousPersonalCompletionStorageV4.schema';
import type { AutonomousPersonalNativeOriginV4 } from '../schemas/AutonomousPersonalNativeOriginV4.schema';
import {
  prepareAutonomousPersonalCompletionGraphCandidateV4,
  validateAutonomousPersonalCompletionReadbackV4,
} from './AutonomousPersonalCompletionGraphV4';
import { planAutonomousPersonalCaptureCompletionV4 } from './AutonomousPersonalCompletionPlanV4';
import {
  AutonomousPersonalNativeOriginV4Error,
  projectAutonomousPersonalNativeOriginV4,
} from './AutonomousPersonalNativeOriginV4';
import {
  assertAutonomousPersonalRecordIntegrityV4,
  AutonomousPersonalRecordIntegrityV4Error,
} from './AutonomousPersonalRecordIntegrityV4';
import {
  consumeAutonomousPersonalAssistantFinalInvocationV4,
  readAutonomousPersonalAssistantFinalInvocationV4,
  canStageAutonomousPersonalAssistantFinalV4,
  markAutonomousPersonalAssistantFinalCandidateReturnedV4,
  claimAutonomousPersonalAssistantFinalReconciliationV4,
  closeAutonomousPersonalAssistantFinalInvocationV4,
  type PrivateAutonomousPersonalAssistantFinalInvocationV4,
  type PrivateConsumedAutonomousPersonalAssistantFinalInvocationV4,
} from './AutonomousPersonalAssistantFinalInvocationV4';
import {
  prepareAutonomousPersonalAssistantFinalV4,
  reconcileAutonomousPersonalAssistantFinalV4,
} from './AutonomousPersonalAssistantFinalPlanV4';
import type { AutonomousPersonalTypedSyntaxWorkV1 } from '../schemas/AutonomousPersonalTypedSyntaxV1.schema';
import type { CompositionalAutomaticCaptureBeginPreparationV3 } from '../schemas/CompositionalAutomaticCaptureBeginV3.schema';
import {
  AutonomousPersonalCaptureProviderPreflightV4Schema,
  AutonomousPersonalCaptureProviderObservationV4Schema,
  type AutonomousPersonalCaptureProviderPreflightV4,
} from '../schemas/AutonomousPersonalCaptureProviderV4.schema';
import type { CompositionalCaptureBeginMethodRequestV3 } from '../schemas/CompositionalAutomaticCaptureLifecycleV3.schema';
import type {
  CompositionalCaptureBeginInternalResultV3,
  CompositionalCaptureCompletionInternalResultV3,
  PrivateOneUseCompositionalCaptureLeaseHandleV3,
} from '../schemas/CompositionalAutomaticCaptureRegistryV3.schema';
import { CompositionalCaptureNonPermitDecisionV3Schema } from '../schemas/CompositionalAutomaticCaptureLifecycleV3.schema';
import {
  CompositionalClaimReviewRequestV3Schema,
  type CompositionalClaimReviewRequestV3,
  type CompositionalClaimReviewResultV3,
} from '../schemas/CompositionalClaimReviewV3.schema';
import { prepareCompositionalClaimReviewV3 } from './CompositionalClaimReviewV3';
import { validateAutomaticCaptureCandidate } from './AutomaticCaptureCapacity';
import type { StorageObservation } from '../schemas/StorageObservation.schema';
import {
  enqueue,
  queueClearImpact,
  assertQueueClear,
  queueStats,
  queueCommand,
  applyPlan,
  assertNoQueueMutation,
  QUEUE_ATTRIBUTE,
  canonical,
  prepareQueueImport,
} from '../extraction/QueueState';
import type {
  QueueBinding,
  QueueStats,
  QueueClearOptions,
  QueueClearImpact,
  QueueLimits,
  QueueCommand,
  QueueResult,
  StagedExtraction,
  ExtractionJob,
} from '../schemas';
import neo4j, {
  type Driver,
  type ManagedTransaction,
  type Session,
  type QueryResult,
} from 'neo4j-driver';
import { generateUuid } from '../utils/uuid';
import { nowIso } from '../utils/temporal';
import { cosineSimilarity } from '../embeddings/cosine';
import type {
  IGraphStorage,
  EntitySearchResult,
  EdgeSearchResult,
  ChangelogEntry,
  ListOptions,
  EntitySearchOptions,
  EdgeSearchOptions,
  VectorSearchOptions,
  RetentionPolicy,
  AppendEpisodeResult,
  EpisodeFilterOptions,
  UpdateEpisodeInput,
  DeleteEpisodeOptions,
  DeleteEpisodeResult,
  PurgeEpisodesOptions,
  PurgeEpisodesResult,
  StorageMigrationStatus,
  StorageSchemaMigrationOptions,
  StorageSchemaMigrationResult,
} from './IGraphStorage';
import type {
  EntityNode,
  CreateEntityNode,
  EntityEdge,
  CreateEntityEdge,
  EpisodicNode,
  CreateEpisodicNode,
  GraphData,
  ImportGraphData,
  GraphStats,
} from '../schemas';
import {
  CURRENT_GRAPH_DATA_VERSION,
  EntityEdgeSchema,
  EntityNodeSchema,
  AutomaticLedgerSchema,
  StoredAutomaticOperationSchema,
  AutomaticLegacyObservationRequestSchema,
  AutomaticLegacyObservationResultSchema,
  GraphDataSchema,
  assertNoImportedAutomaticOperations,
  QueueClearOptionsSchema,
  CreateEpisodicNodeSchema,
  EpisodicNodeSchema,
  migrateGraphData,
} from '../schemas';
import type {
  AutomaticLegacyObservationRequest,
  AutomaticLegacyObservationResult,
  StoredAutomaticOperation,
} from '../schemas/AutomaticLedger.schema';
import { AutomaticBindingCommandSchema } from '../schemas/AutomaticOperations.schema';
import {
  AutomaticClaimMetadataSchema,
  AutomaticWriteOwnerSchema,
} from '../schemas/AutomaticClaim.schema';
import {
  AutomaticClaimReadResultSchema,
  type AutomaticClaimReadResult,
} from '../schemas/AutomaticClaimRead.schema';
import { createHash } from 'crypto';
import {
  AutomaticCaptureBeginRequestV2Schema,
  hashAutomaticCaptureV2,
  type AutomaticCaptureBeginRequestV2,
} from '../schemas/AutomaticCapture.schema';
import {
  AutomaticAssistantCaptureIntentV2Schema,
  AutomaticAssistantFinalWriterResultV2Schema,
  type AutomaticAssistantCaptureIntentV2,
  type AutomaticAssistantFinalWriterResultV2,
} from '../schemas/AutomaticAssistantCapture.schema';
import {
  AutomaticAssistantWorkBudgetV2Schema,
  type AutomaticAssistantWorkBudgetV2,
} from '../schemas/AutomaticAssistantWorkBudget.schema';
import {
  createAutomaticCaptureInternalResultSchemas,
  type AutomaticCaptureBeginDecisionV2,
  AutomaticCaptureAdminFenceRequestV2Schema,
  AutomaticCaptureCancelInternalResultV2Schema,
  AutomaticCaptureReadRequestV2Schema,
  AutomaticCaptureReadResultV2Schema,
  type AutomaticCaptureAdminFenceRequestV2,
  type AutomaticCaptureBeginInternalResultV2,
  type AutomaticHumanCompletionInternalResultV2,
  type AutomaticCaptureResumeInternalResultV2,
  type AutomaticCaptureCancelInternalResultV2,
  type AutomaticCaptureReadRequestV2,
  type AutomaticCaptureReadResultV2,
} from '../schemas/AutomaticCaptureApi.schema';
import type { AutomaticHumanCaptureBeginPreparationV2 } from '../schemas/AutomaticCaptureBegin.schema';
import type { AutomaticHumanCaptureCompletionPreparationV2 } from '../schemas/AutomaticCaptureComplete.schema';
import type {
  AutomaticAssistantCaptureBeginInputV2,
  AutomaticAssistantCaptureBeginPreparationV2,
  AutomaticAssistantCaptureCompletionPreparationV2,
} from '../schemas/AutomaticAssistantCapture.schema';
import type {
  AutomaticHumanCaptureResumePreparationV2,
  AutomaticHumanCaptureCancelPreparationV2,
} from '../schemas/AutomaticCaptureControl.schema';
import type {
  AutomaticBindingCommand,
  AutomaticBindingRecord,
} from '../schemas/AutomaticOperations.schema';
import {
  applyAutomaticBindingCommand,
  assertNoAutomaticOperationChainImpact,
  reconcileAutomaticOperationIdentity,
  immutableAutomaticLedgerSnapshot,
  assertAutomaticEntityDeleteAllowed,
  assertAutomaticEpisodeBinding,
  assertAutomaticEpisodeTrustedPath,
  assertAutomaticLedgerSourceIntegrity,
  assertAutomaticBindingIdentity,
  findAutomaticBinding,
  hasAutonomousSourceOwnership,
  automaticOperationIdentityForOwnedSource,
  assertNoAutomaticBindingAttribute,
  prepareAutomaticEntityUpdate,
  prepareAutomaticEpisodeInput,
  prepareAutomaticEpisodeUpdate,
  prepareAutomaticImport,
  protectAutomaticEpisode,
  assertOwnedEpisodeReplay,
  SOURCE_ENVELOPE_ATTRIBUTE,
  WRITE_OWNER_ATTRIBUTE,
  WRITE_OWNER_V2_ATTRIBUTE,
  WRITE_OWNER_V3_ATTRIBUTE,
  SOURCE_ENVELOPE_V2_ATTRIBUTE,
} from './AutomaticIdentity';
import { observeLegacyUnconfirmed } from './AutomaticLedger';
import {
  createAutomaticCaptureHandleRegistry,
  type PrivateOneUseAutomaticLeaseHandle,
  type PrivateConsumedAutomaticCaptureInvocation,
} from './AutomaticCaptureHandles';
import { prepareHumanCaptureBeginV2 } from './AutomaticCaptureBegin';
import {
  prepareHumanCaptureCompletionV2,
  prepareHumanCapturePlanV2,
} from './AutomaticCaptureComplete';
import {
  prepareHumanCaptureCancelV2,
  prepareHumanCaptureResumeSourceV2,
  prepareHumanCaptureResumeV2,
  projectHumanCaptureOutcomeV2,
} from './AutomaticCaptureControl';
import { neo4jAutomaticCaptureStoreHash } from './AutomaticCaptureStore';
import { cloneBoundedAutomaticCaptureJson } from './BoundedAutomaticCaptureJson';
import {
  inspectNativeCaptureAttributeValue,
  assertNativeCaptureAttributeJsonSize,
} from './NativeCaptureAttributeKeys';
import {
  AUTONOMOUS_CAPTURE_V3_ENVELOPE_ATTRIBUTE,
  AUTONOMOUS_CAPTURE_V4_OWNER_ATTRIBUTE,
} from '../schemas/AutonomousPersonalSourceV4.schema';
import { parseLosslessAutomaticCaptureGraph } from './LosslessAutomaticCaptureGraph';
import {
  createAutomaticAssistantCaptureAuthorizationRegistry,
  prepareAssistantCaptureBeginV2,
  prepareAssistantFinalCompletionV2,
  readAutomaticAssistantCaptureReplayV2,
  type PrivateConsumedAutomaticAssistantWriteAuthorizationV2,
} from './AutomaticAssistantCapture';
import { projectAutomaticClaimReadContextWithUsage } from '../extraction/AutomaticClaimCommitProof';
import {
  beginAutomaticClaimReadAttempt,
  canUseAutomaticClaimReadScope,
  chargeAutomaticClaimContextBytes,
  getAutomaticClaimReadScopeRemaining,
  getAutomaticClaimReadScope,
  type AutomaticClaimReadScope,
} from './AutomaticClaimReadScope';

const AUTOMATIC_CLAIM_CONTEXT_BYTE_LIMIT = 512 * 1024;
// Cypher's character count is converted to a safe JSON byte upper bound (6 bytes per
// character, plus fixed map overhead) before any string payload crosses the driver boundary.
const AUTOMATIC_CLAIM_ROW_CHAR_LIMIT = AUTOMATIC_CLAIM_CONTEXT_BYTE_LIMIT;
const AUTOMATIC_CLAIM_SOURCE_CHAR_LIMIT = AUTOMATIC_CLAIM_CONTEXT_BYTE_LIMIT;
const AUTOMATIC_CLAIM_OPERATION_CHAR_LIMIT = 32 * 1024;
const AUTOMATIC_CLAIM_READ_MAX_RETRIES = 3;
const AUTOMATIC_CAPTURE_READ_MAX_RETRIES = 3;
const AUTOMATIC_CLAIM_JSON_MAX_BYTES_PER_CHARACTER = 6;
const AUTOMATIC_CLAIM_QUERY_OVERHEAD_BYTES = 4096;
const AUTONOMOUS_V4_INSPECTION_BYTES = 100 * 1024 * 1024;
// Cypher counts characters. This cap preserves the existing 100MiB ASCII capacity;
// the existing six-bytes-per-character upper bound limits response text to 600MiB.
const AUTONOMOUS_V4_INSPECTION_CHAR_LIMIT = AUTONOMOUS_V4_INSPECTION_BYTES;
const AUTONOMOUS_V4_OPERATION_ROW_BYTES = 32 * 1024;
const AUTONOMOUS_PERSONAL_VALUE_ENTITY_TYPE = 'autonomous_personal_value';
const AUTONOMOUS_PERSONAL_FAMILY4_ATTRIBUTE_KEYS = [
  'engram_claim_v1',
  'engram_literal_v1',
] as const;
const AUTONOMOUS_PERSONAL_SOURCE4_ATTRIBUTE_KEYS = [
  AUTONOMOUS_CAPTURE_V4_OWNER_ATTRIBUTE,
  AUTONOMOUS_CAPTURE_V3_ENVELOPE_ATTRIBUTE,
] as const;
const AUTONOMOUS_PERSONAL_NEVER_ABORTED_SIGNAL = new AbortController().signal;

function ownPlainRecord(value: unknown): Record<string, unknown> | null {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    utilTypes.isProxy(value)
  )
    return null;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null
    ? (value as Record<string, unknown>)
    : null;
}

function ownSafeDataRecord(value: unknown): Record<string, unknown> | null {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    utilTypes.isProxy(value)
  )
    return null;
  return value as Record<string, unknown>;
}

function ownDataValue(
  record: Record<string, unknown>,
  key: string,
): { readonly present: false } | { readonly present: true; readonly value: unknown } {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor) return { present: false };
  if (!('value' in descriptor)) throw new Error('Engram automatic ledger: reserved_native_record');
  return { present: true, value: descriptor.value };
}

function isFamily4TaggedAttribute(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const record = ownSafeDataRecord(value);
  if (!record) return true;
  const version = ownDataValue(record, 'version');
  const family = ownDataValue(record, 'family');
  return (
    (version.present && typeof version.value === 'number' && version.value >= 3) ||
    (family.present && family.value === 'autonomous-personal-v1')
  );
}

function attributesHaveReservedNativeContent(attributes: unknown): boolean {
  const record = ownSafeDataRecord(attributes);
  if (!record) {
    if (attributes === undefined || attributes === null) return false;
    if (utilTypes.isProxy(attributes))
      throw new Error('Engram automatic ledger: reserved_native_record');
    return false;
  }
  for (const key of AUTONOMOUS_PERSONAL_SOURCE4_ATTRIBUTE_KEYS) {
    if (ownDataValue(record, key).present) return true;
  }
  for (const key of AUTONOMOUS_PERSONAL_FAMILY4_ATTRIBUTE_KEYS) {
    const marker = ownDataValue(record, key);
    if (marker.present && isFamily4TaggedAttribute(marker.value)) return true;
  }
  return false;
}

function assertReservedAttributeReplacementAllowed(
  existingValue: unknown,
  incomingValue: unknown,
): void {
  const asAttributes = (value: unknown): Record<string, unknown> => {
    if (value === undefined || value === null) return {};
    if (utilTypes.isProxy(value))
      throw new Error('Engram automatic ledger: reserved_native_record');
    const record = ownSafeDataRecord(value);
    if (!record) throw new Error('Engram automatic ledger: reserved_native_record');
    return record;
  };
  const existing = asAttributes(existingValue);
  const incoming = asAttributes(incomingValue);
  for (const key of AUTONOMOUS_PERSONAL_SOURCE4_ATTRIBUTE_KEYS) {
    const previous = ownDataValue(existing, key);
    const next = ownDataValue(incoming, key);
    if (
      previous.present !== next.present ||
      (previous.present && next.present && canonical(previous.value) !== canonical(next.value))
    ) {
      throw new Error('Engram automatic ledger: reserved_native_record');
    }
  }
  for (const key of AUTONOMOUS_PERSONAL_FAMILY4_ATTRIBUTE_KEYS) {
    const previous = ownDataValue(existing, key);
    const next = ownDataValue(incoming, key);
    const previousReserved = previous.present && isFamily4TaggedAttribute(previous.value);
    const nextReserved = next.present && isFamily4TaggedAttribute(next.value);
    if (
      (nextReserved &&
        (!previousReserved || canonical(previous.value) !== canonical(next.value))) ||
      (previousReserved && !nextReserved)
    ) {
      throw new Error('Engram automatic ledger: reserved_native_record');
    }
  }
}

function assertNoReservedAutonomousPersonalRow(rowValue: unknown): void {
  if (rowValue !== null && typeof rowValue === 'object' && utilTypes.isProxy(rowValue))
    throw new Error('Engram automatic ledger: reserved_native_record');
  const row = ownSafeDataRecord(rowValue);
  if (!row) throw new Error('Engram automatic ledger: reserved_native_record');
  const entityType = ownDataValue(row, 'entity_type');
  if (entityType.present && entityType.value === AUTONOMOUS_PERSONAL_VALUE_ENTITY_TYPE)
    throw new Error('Engram automatic ledger: reserved_native_record');
  const attributes = ownDataValue(row, 'attributes');
  if (attributes.present && attributesHaveReservedNativeContent(attributes.value))
    throw new Error('Engram automatic ledger: reserved_native_record');
}

function assertNoReservedAutonomousPersonalGraph(graphValue: unknown): void {
  if (graphValue !== null && typeof graphValue === 'object' && utilTypes.isProxy(graphValue))
    throw new Error('Engram automatic ledger: reserved_native_record');
  const graph = ownSafeDataRecord(graphValue);
  if (!graph) throw new Error('Engram automatic ledger: reserved_native_record');
  for (const collection of ['entities', 'edges', 'episodes'] as const) {
    const rows = ownDataValue(graph, collection);
    if (!rows.present || !Array.isArray(rows.value))
      throw new Error('Engram automatic ledger: reserved_native_record');
    for (const row of rows.value) assertNoReservedAutonomousPersonalRow(row);
  }
}

function assertNoNewReservedAutonomousPersonalGraphRecords(
  beforeValue: unknown,
  afterValue: unknown,
): void {
  const before = ownSafeDataRecord(beforeValue);
  const after = ownSafeDataRecord(afterValue);
  if (!before || !after) throw new Error('Engram automatic ledger: reserved_native_record');
  for (const collection of ['entities', 'edges', 'episodes'] as const) {
    const previousRows = ownDataValue(before, collection);
    const nextRows = ownDataValue(after, collection);
    if (!previousRows.present || !Array.isArray(previousRows.value))
      throw new Error('Engram automatic ledger: reserved_native_record');
    if (!nextRows.present || !Array.isArray(nextRows.value))
      throw new Error('Engram automatic ledger: reserved_native_record');
    const previousByUuid = new Map<string, Record<string, unknown>>();
    for (const value of previousRows.value) {
      const row = ownSafeDataRecord(value);
      if (!row) continue;
      const uuid = ownDataValue(row, 'uuid');
      if (uuid.present && typeof uuid.value === 'string') previousByUuid.set(uuid.value, row);
    }
    for (const value of nextRows.value) {
      const next = ownSafeDataRecord(value);
      if (!next) throw new Error('Engram automatic ledger: reserved_native_record');
      const uuid = ownDataValue(next, 'uuid');
      const previous =
        uuid.present && typeof uuid.value === 'string' ? previousByUuid.get(uuid.value) : undefined;
      if (collection === 'entities') {
        const nextType = ownDataValue(next, 'entity_type');
        const previousType: ReturnType<typeof ownDataValue> = previous
          ? ownDataValue(previous, 'entity_type')
          : { present: false };
        if (
          nextType.present &&
          nextType.value === AUTONOMOUS_PERSONAL_VALUE_ENTITY_TYPE &&
          (!previousType.present || previousType.value !== AUTONOMOUS_PERSONAL_VALUE_ENTITY_TYPE)
        ) {
          throw new Error('Engram automatic ledger: reserved_native_record');
        }
      }
      const previousAttributes: ReturnType<typeof ownDataValue> = previous
        ? ownDataValue(previous, 'attributes')
        : { present: false };
      const nextAttributes = ownDataValue(next, 'attributes');
      if (previousAttributes.present || nextAttributes.present) {
        assertReservedAttributeReplacementAllowed(
          previousAttributes.present ? previousAttributes.value : {},
          nextAttributes.present ? nextAttributes.value : {},
        );
      }
    }
  }
}

function createAutonomousPersonalRecordWorkV4(
  deadlineAtMonotonicMs: number,
): AutonomousPersonalTypedSyntaxWorkV1 {
  return Object.freeze({
    absoluteMonotonicDeadlineMs: deadlineAtMonotonicMs,
    signal: AUTONOMOUS_PERSONAL_NEVER_ABORTED_SIGNAL,
  });
}

function createOrdinaryAutonomousPersonalRecordGuardV4(): {
  readonly work: AutonomousPersonalTypedSyntaxWorkV1;
  readonly read: CompositionalNativeReadV3;
  readonly scope: AutomaticClaimReadScope;
} {
  const deadlineAtMonotonicMs = performance.now() + 5_000;
  const work = createAutonomousPersonalRecordWorkV4(deadlineAtMonotonicMs);
  const budget = { remaining: 512, deferred: 0 };
  const scope = getAutomaticClaimReadScope(budget);
  const check = () => {
    if (
      !Number.isFinite(work.absoluteMonotonicDeadlineMs) ||
      performance.now() >= work.absoluteMonotonicDeadlineMs ||
      work.signal.aborted
    ) {
      throw new Error('Engram compositional capture: budget_exhausted');
    }
  };
  const charge = createNeo4jCompositionalReadChargeV3(scope, check);
  return {
    work,
    scope,
    read: {
      check,
      charge,
      begin: () => {
        check();
        if (!beginAutomaticClaimReadAttempt(scope))
          throw new Error('Engram compositional capture: budget_exhausted');
        check();
      },
    },
  };
}

function chargeOrdinaryAutonomousPersonalContextV4(
  scope: AutomaticClaimReadScope,
  check: () => void,
  value: unknown,
): void {
  check();
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error('Engram automatic ledger: invalid_native_record');
  }
  if (typeof serialized !== 'string')
    throw new Error('Engram automatic ledger: invalid_native_record');
  if (!chargeAutomaticClaimContextBytes(scope, Buffer.byteLength(serialized, 'utf8')))
    throw new Error('Engram compositional capture: budget_exhausted');
  check();
}

function createAutonomousPersonalNativeSnapshotReadV4(
  check: () => void,
): CompositionalNativeReadV3 {
  let nativeBytes = 0;
  return {
    check,
    charge: (value: unknown) => {
      check();
      const serialized = JSON.stringify(value);
      if (typeof serialized !== 'string')
        throw new Error('Engram automatic ledger: invalid_native_record');
      nativeBytes += Buffer.byteLength(serialized, 'utf8');
      if (nativeBytes > AUTONOMOUS_V4_INSPECTION_BYTES)
        throw new Error('Engram queue: snapshot_limit');
      check();
    },
  };
}

function cypherTextCharCount(expressions: string[]): string {
  return expressions.map((expression) => `size(toString(coalesce(${expression}, '')))`).join(' + ');
}

function cypherListCharCount(expression: string): string {
  return `CASE WHEN size(coalesce(${expression}, [])) <= $maxChars
    THEN reduce(total = 0, item IN coalesce(${expression}, []) | total + size(toString(item)) + 1)
    ELSE $maxChars + 1 END`;
}

function cypherEntityCharCount(alias: string): string {
  return `(${cypherTextCharCount([
    `${alias}.uuid`,
    `${alias}.name`,
    `${alias}.group_id`,
    `${alias}.summary`,
    `${alias}.entity_type`,
    `${alias}.attributes`,
    `${alias}.created_at`,
    `${alias}.updated_at`,
  ])} + ${cypherListCharCount(`${alias}.name_embedding`)})`;
}

function cypherEdgeCharCount(alias: string): string {
  return `(${cypherTextCharCount([
    `${alias}.uuid`,
    `${alias}.group_id`,
    `${alias}.source_node_uuid`,
    `${alias}.target_node_uuid`,
    `${alias}.name`,
    `${alias}.fact`,
    `${alias}.valid_at`,
    `${alias}.invalid_at`,
    `${alias}.expired_at`,
    `${alias}.attributes`,
    `${alias}.created_at`,
    `${alias}.updated_at`,
  ])} + ${cypherListCharCount(`${alias}.episodes`)} + ${cypherListCharCount(`${alias}.fact_embedding`)})`;
}

function cypherEpisodeCharCount(alias: string): string {
  return `(${cypherTextCharCount([
    `${alias}.uuid`,
    `${alias}.group_id`,
    `${alias}.content`,
    `${alias}.role`,
    `${alias}.source_type`,
    `${alias}.reference_time`,
    `${alias}.previous_episode_uuid`,
    `${alias}.created_at`,
    `${alias}.updated_at`,
    `${alias}.source_message_id`,
    `${alias}.idempotency_key`,
    `${alias}.conversation_id`,
    `${alias}.sender_id`,
    `${alias}.sender_name`,
    `${alias}.episode_kind`,
    `${alias}.quoted_message_id`,
    `${alias}.trust_level`,
    `${alias}.confidence`,
    `${alias}.review_status`,
    `${alias}.source_workflow_id`,
    `${alias}.source_execution_id`,
    `${alias}.attributes`,
  ])})`;
}

function automaticClaimResult(
  status: Exclude<AutomaticClaimReadResult['status'], 'committed'>,
  reason: Exclude<AutomaticClaimReadResult, { status: 'committed' }>['reason'],
): AutomaticClaimReadResult {
  return AutomaticClaimReadResultSchema.parse({ status, reason });
}

function cypherIntegerNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (value !== null && typeof value === 'object' && 'toNumber' in value) {
    const toNumber = (value as { toNumber?: () => number }).toNumber;
    if (typeof toNumber === 'function') return toNumber.call(value);
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : 0;
}

class RollbackAutomaticCaptureBegin extends Error {
  constructor(readonly candidate: AutomaticHumanCaptureBeginPreparationV2) {
    super('Engram automatic capture: rollback_without_mutation');
  }
}

class RollbackCompositionalClaimReview extends Error {
  constructor(readonly result: CompositionalClaimReviewResultV3) {
    super('Engram compositional review: rollback_without_mutation');
  }
}

class RollbackCompositionalCaptureBeginV3 extends Error {
  constructor(readonly preparation: CompositionalAutomaticCaptureBeginPreparationV3) {
    super('Engram compositional capture: rollback_without_mutation');
  }
}

class RollbackAutonomousPersonalCaptureBeginV4 extends Error {
  constructor(readonly candidate: ReturnType<typeof prepareAutonomousPersonalCaptureSnapshotV4>) {
    super('Engram autonomous capture: rollback_without_mutation');
  }
}

type CompositionalNativeReadV3 = Readonly<{
  check: () => void;
  charge: ReturnType<typeof createNeo4jCompositionalReadChargeV3>;
  begin?: () => void;
  episodeOrder?: 'recent';
}>;

type PositiveAutonomousSource4FormatV4 = Readonly<{
  rowCount: number;
  format: unknown;
}>;

class RollbackCompositionalCaptureCompleteV3 extends Error {
  constructor(readonly outcome: CompositionalCaptureCompletionInternalResultV3 | 'ack_only') {
    super('Engram compositional capture: rollback_without_mutation');
  }
}

class RollbackAutomaticCaptureCompletion extends Error {
  constructor(readonly preparation: AutomaticHumanCaptureCompletionPreparationV2 | null) {
    super('Engram automatic capture: rollback_without_mutation');
  }
}

class RollbackAutomaticCaptureCancel extends Error {
  constructor(readonly preparation: AutomaticHumanCaptureCancelPreparationV2) {
    super('Engram automatic capture: rollback_without_mutation');
  }
}

class RollbackAutomaticCaptureResume extends Error {
  constructor(readonly preparation: AutomaticHumanCaptureResumePreparationV2 | null) {
    super('Engram automatic capture: rollback_without_mutation');
  }
}

class RollbackAutonomousPersonalCompletionV4 extends Error {
  constructor(readonly reason: AutonomousPersonalCompletionPlanV4NoWriteReason) {
    super('Engram autonomous personal completion: rollback_without_mutation');
  }
}

declare const trustedCompletedAutonomousPersonalWriteV4Brand: unique symbol;
type TrustedCompletedAutonomousPersonalWriteV4 = object & {
  readonly [trustedCompletedAutonomousPersonalWriteV4Brand]: 'completed_write';
};

type BackendCompletionCoreOutcomeV4 = Readonly<{
  observation: AutonomousPersonalCompletionStorageV4Result;
  witness: TrustedCompletedAutonomousPersonalWriteV4 | null;
}>;

const autonomousPersonalCompletionCallbackAlreadyReturnedError = new Error(
  'Engram autonomous personal completion: callback_already_returned',
);
const autonomousPersonalCompletionCallbackResult = Object.freeze({ callback: 'returned' });

function autonomousPersonalCompletionStorageFailureReasonNeo4jV4(
  error: unknown,
): AutonomousPersonalCompletionPlanV4NoWriteReason {
  const providerFailure = getAutonomousPersonalCaptureProviderFailureKindV4(error);
  if (providerFailure) {
    switch (providerFailure) {
      case 'resource_exhausted':
      case 'capacity':
        return 'capacity';
      case 'budget_exhausted':
      case 'cancelled':
        return 'budget_exhausted';
      case 'authority_changed':
        return 'authority_changed';
      case 'clock_regression':
        return 'clock_regression';
      case 'conflict':
        return 'conflict';
      case 'invalid_input':
      case 'invalid_handle':
      case 'unsupported_mode':
        return 'invalid_input';
      default:
        return 'inspection_incomplete';
    }
  }
  if (error instanceof AutonomousPersonalRecordIntegrityV4Error) {
    if (error.reason === 'snapshot_capacity') return 'capacity';
    if (
      error.reason === 'invalid_pair' ||
      error.reason === 'invalid_creator' ||
      error.reason === 'orphan_record'
    )
      return 'conflict';
    return 'inspection_incomplete';
  }
  const storageFailure = autonomousPersonalCaptureStorageFailureV4(error);
  if (storageFailure === 'resource_exhausted') return 'capacity';
  if (storageFailure === 'conflict') return 'conflict';
  if (!(error instanceof Error)) return 'inspection_incomplete';
  if (error.message.includes('budget_exhausted')) return 'budget_exhausted';
  if (error.message.includes('snapshot_limit')) return 'capacity';
  if (
    error.message.includes('native_format') ||
    error.message.includes('native_record') ||
    error.message.includes('native_root_missing')
  )
    return 'conflict';
  return 'inspection_incomplete';
}

function autonomousPersonalCompletionNoWriteNeo4jV4(
  reason: AutonomousPersonalCompletionPlanV4NoWriteReason,
): AutonomousPersonalCompletionStorageV4Result {
  return AutonomousPersonalCompletionStorageV4ResultOwnedDataSchema.parse({
    kind: 'no_write',
    reason,
  });
}

function autonomousPersonalCompletionTargetRowsMatchV4(
  actual: GraphData,
  candidate: GraphData,
  input: AutonomousPersonalCompletionPlanV4Input,
  plan: Extract<AutonomousPersonalCompletionPlanV4, { kind: 'planned' }>,
  check: () => void,
): boolean {
  const unique = <T>(rows: readonly T[], predicate: (row: T) => boolean): T | null => {
    let found: T | undefined;
    for (const row of rows) {
      check();
      if (!predicate(row)) continue;
      if (found !== undefined) return null;
      found = row;
    }
    return found ?? null;
  };
  const equalBy = <T>(
    actualRows: readonly T[],
    candidateRows: readonly T[],
    id: string,
    getId: (row: T) => string,
  ): boolean => {
    const actualRow = unique(actualRows, (row) => getId(row) === id);
    const candidateRow = unique(candidateRows, (row) => getId(row) === id);
    return (
      actualRow !== null &&
      candidateRow !== null &&
      canonical(actualRow) === canonical(candidateRow)
    );
  };

  check();
  if (
    (actual.metadata?.extraction_epoch ?? null) !==
      (candidate.metadata?.extraction_epoch ?? null) ||
    !actual.automatic_operations_v1 ||
    !candidate.automatic_operations_v1 ||
    actual.automatic_operations_v1.version !== candidate.automatic_operations_v1.version
  )
    return false;

  if (
    !equalBy(
      actual.automatic_operations_v1.operations,
      candidate.automatic_operations_v1.operations,
      plan.operation.operationId,
      (row) => row.operationId,
    ) ||
    !equalBy(actual.episodes, candidate.episodes, input.stagedFresh.episode.uuid, (row) => row.uuid)
  )
    return false;

  for (const entity of plan.createEntities) {
    check();
    if (!equalBy(actual.entities, candidate.entities, entity.uuid, (row) => row.uuid)) return false;
  }
  for (const edge of plan.createEdges) {
    check();
    if (!equalBy(actual.edges, candidate.edges, edge.uuid, (row) => row.uuid)) return false;
  }
  for (const guard of plan.referenceGuards) {
    check();
    if (
      !equalBy(actual.edges, candidate.edges, guard.claimId, (row) => row.uuid) ||
      !equalBy(actual.entities, candidate.entities, guard.valueId, (row) => row.uuid) ||
      !equalBy(actual.episodes, candidate.episodes, guard.sourceId, (row) => row.uuid) ||
      !equalBy(
        actual.automatic_operations_v1.operations,
        candidate.automatic_operations_v1.operations,
        guard.operationId,
        (row) => row.operationId,
      )
    )
      return false;
  }
  check();
  return true;
}

type AutomaticAssistantCaptureRollbackPayload =
  | { stage: 'begin'; preparation: AutomaticAssistantCaptureBeginPreparationV2 }
  | { stage: 'begin_result'; result: AutomaticAssistantFinalWriterResultV2 }
  | { stage: 'complete'; preparation: AutomaticAssistantCaptureCompletionPreparationV2 };

class RollbackAutomaticAssistantCapture extends Error {
  constructor(readonly payload: AutomaticAssistantCaptureRollbackPayload) {
    super('Engram automatic capture: rollback_without_mutation');
  }
}

function isAutomaticCaptureBudgetError(error: unknown): boolean {
  return error instanceof Error && error.message === 'Engram automatic capture: budget_exhausted';
}

function assistantBeginDecisionResult(
  value: AutomaticCaptureBeginDecisionV2,
): AutomaticAssistantFinalWriterResultV2 {
  const reason = value.kind === 'resume_available' ? 'unsupported_mode' : value.kind;
  return AutomaticAssistantFinalWriterResultV2Schema.parse({
    kind: 'decision',
    reason,
    eligibleFirstCommit: false,
  });
}

type AssistantFinalDecisionReasonV4 = Extract<
  AutomaticAssistantFinalWriterResultV2,
  { kind: 'decision' }
>['reason'];

/** Fixed, non-transient rollback carrier: the lock increment must not become durable. */
class RollbackAutonomousPersonalAssistantFinalV4 extends Error {
  constructor(readonly result: AutomaticAssistantFinalWriterResultV2) {
    super('Engram autonomous assistant final: rollback_without_mutation');
  }
}

const autonomousPersonalAssistantFinalCallbackAlreadyReturnedErrorV4 = new Error(
  'Engram autonomous assistant final: callback_already_returned',
);
const autonomousPersonalAssistantFinalCallbackResultV4 = Object.freeze({ callback: 'returned' });

/** Only fixed, redacted classes are recognized; no error text is ever surfaced. */
function autonomousPersonalAssistantFinalKnownFailureReasonV4(
  error: unknown,
): AssistantFinalDecisionReasonV4 | null {
  if (error instanceof AutonomousPersonalRecordIntegrityV4Error)
    return error.reason === 'snapshot_capacity' ? 'capacity' : 'conflict';
  if (error instanceof ExtractionBudgetError) {
    if (error.budgetReason === 'snapshot_limit') return 'capacity';
    return error.budgetReason === 'cancelled' ? 'interrupted' : 'budget_exhausted';
  }
  if (!(error instanceof Error)) return null;
  const storageFailure = autonomousPersonalCaptureStorageFailureV4(error);
  if (storageFailure === 'resource_exhausted') return 'capacity';
  if (storageFailure === 'conflict') return 'conflict';
  const message = error.message;
  if (message.includes('budget_exhausted')) return 'budget_exhausted';
  if (message.includes('snapshot_limit') || message.includes('native_attributes_too_large'))
    return 'capacity';
  if (
    message.includes('native_format') ||
    message.includes('native_record') ||
    message.includes('native_root_missing') ||
    message.includes('candidate_source_invalid') ||
    message.includes('append_sequence_invalid')
  )
    return 'conflict';
  if (message.includes('backend_clock_invalid') || message.includes('concurrent_snapshot'))
    return 'storage_error';
  return null;
}

export class Neo4jStorage implements IGraphStorage {
  private driver: Driver;
  private database: string;
  private originalConfiguredUri: string;
  private readonly automaticCaptureHandles = createAutomaticCaptureHandleRegistry();
  private readonly compositionalCaptureHandlesV3 =
    createCompositionalAutomaticCaptureHandleRegistryV3();
  private readonly autonomousPersonalCompletionWitnessesV4 = new WeakMap<
    object,
    TrustedAutonomousPersonalCompletionWitnessLinkV4
  >();
  private readonly autonomousPersonalCompletionRegistryV4: AutonomousPersonalCompletionBackendRegistryV4;
  private readonly automaticCaptureResultSchemas = createAutomaticCaptureInternalResultSchemas(
    this.automaticCaptureHandles,
  );
  private extractionObservers = new AsyncLocalStorage<(value: StorageObservation) => void>();
  async withExtractionDiagnostics<T>(
    observer: (value: StorageObservation) => void,
    operation: () => Promise<T>,
  ): Promise<T> {
    const parent = this.extractionObservers.getStore();
    const deliver = (value: StorageObservation) => {
      try {
        parent?.(value);
      } catch {
        /* Observers cannot affect storage mutations. */
      }
      try {
        observer(value);
      } catch {
        /* Observers cannot affect storage mutations. */
      }
    };
    return this.extractionObservers.run(deliver, operation);
  }
  private initialized = false;
  private vectorIndexCreated = false;

  constructor(uri: string, username: string, password: string, database?: string) {
    this.originalConfiguredUri = uri;
    // Force IPv4 — Neo4j listens on 127.0.0.1 but Node.js 17+ resolves localhost to IPv6 ::1
    const resolvedUri = uri.replace('://localhost:', '://127.0.0.1:');
    this.driver = neo4j.driver(resolvedUri, neo4j.auth.basic(username, password));
    this.database = database ?? 'neo4j';
    this.autonomousPersonalCompletionRegistryV4 = new AutonomousPersonalCompletionBackendRegistryV4(
      this,
      (witness) => {
        if (witness === null || (typeof witness !== 'object' && typeof witness !== 'function')) {
          return null;
        }
        const link = this.autonomousPersonalCompletionWitnessesV4.get(witness);
        if (!link) return null;
        this.autonomousPersonalCompletionWitnessesV4.delete(witness);
        return link;
      },
    );
    registerAutonomousPersonalCompletionBackendVerifierV4(this, (handle, token) =>
      this.autonomousPersonalCompletionRegistryV4.consume(handle, token),
    );
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Verify connectivity
    await this.driver.verifyConnectivity();

    // Create indexes and constraints
    const session = this.getSession();
    try {
      await this.executeWrite(session, async (tx) => {
        await tx.run(
          'CREATE CONSTRAINT engram_store_lock IF NOT EXISTS FOR (lock:EngramStoreLock) REQUIRE lock.id IS UNIQUE',
        );
        await tx.run(
          'CREATE CONSTRAINT automatic_operation_id IF NOT EXISTS FOR (op:AutomaticOperation) REQUIRE op.operation_id IS UNIQUE',
        );
        await tx.run(
          'CREATE INDEX automatic_operation_namespace IF NOT EXISTS FOR (op:AutomaticOperation) ON (op.namespace)',
        );
        await tx.run(
          'CREATE INDEX automatic_operation_source IF NOT EXISTS FOR (op:AutomaticOperation) ON (op.source_id)',
        );
        // Entity indexes
        await tx.run('CREATE INDEX IF NOT EXISTS FOR (e:Entity) ON (e.uuid)');
        await tx.run('CREATE INDEX IF NOT EXISTS FOR (e:Entity) ON (e.group_id)');
        await tx.run('CREATE INDEX IF NOT EXISTS FOR (e:Entity) ON (e.name)');

        // Episode indexes
        await tx.run('CREATE INDEX IF NOT EXISTS FOR (ep:Episode) ON (ep.uuid)');
        await tx.run('CREATE INDEX IF NOT EXISTS FOR (ep:Episode) ON (ep.group_id)');
        await tx.run(
          'CREATE CONSTRAINT episode_source_dedup IF NOT EXISTS FOR (ep:Episode) REQUIRE ep.source_dedup_key IS UNIQUE',
        );
        await tx.run(
          'CREATE CONSTRAINT episode_idempotency_dedup IF NOT EXISTS FOR (ep:Episode) REQUIRE ep.idempotency_dedup_key IS UNIQUE',
        );
        await tx.run(
          'CREATE CONSTRAINT episode_group_lock IF NOT EXISTS FOR (lock:EpisodeGroupLock) REQUIRE lock.group_id IS UNIQUE',
        );

        // Full-text search indexes
        await tx.run(
          'CREATE FULLTEXT INDEX entitySearch IF NOT EXISTS FOR (e:Entity) ON EACH [e.name, e.summary, e.entity_type]',
        );
        await tx.run(
          'CREATE FULLTEXT INDEX edgeSearch IF NOT EXISTS FOR ()-[r:RELATES_TO]-() ON EACH [r.name, r.fact]',
        );
      });
    } finally {
      await session.close();
    }

    const validationSession = this.getSession();
    let validationGuard:
      | ReturnType<typeof createOrdinaryAutonomousPersonalRecordGuardV4>
      | undefined;
    const readRegisteredFormat = (tx: Pick<ManagedTransaction, 'run'>) =>
      this.readAutonomousSource4FormatInTransaction(
        tx,
        validationGuard?.read,
        validationGuard
          ? undefined
          : (positive) => {
              validationGuard ??= createOrdinaryAutonomousPersonalRecordGuardV4();
              validationGuard.read.charge({ row_count: positive.rowCount });
              validationGuard.read.charge({ format: positive.format });
            },
      );
    try {
      await validationSession.executeRead(async (tx) => {
        const registered = await readRegisteredFormat(tx);
        if (registered) {
          validationGuard ??= createOrdinaryAutonomousPersonalRecordGuardV4();
          await this.assertEnrolledAutonomousPersonalRecordsInTransaction(tx, validationGuard);
        } else {
          await this.assertNoUnregisteredAutonomousPersonalSourceRowsInTransaction(tx, () => {
            validationGuard ??= createOrdinaryAutonomousPersonalRecordGuardV4();
            return validationGuard;
          });
        }
      });
    } finally {
      await validationSession.close();
    }

    this.initialized = true;
  }

  async close(): Promise<void> {
    await this.driver.close();
  }

  getNativeAutomaticCaptureStoreIdentityV4(): string | null {
    if (!this.initialized) return null;
    return neo4jAutomaticCaptureStoreHash(this.originalConfiguredUri, this.database);
  }

  private getSession(): Session {
    return this.driver.session({ database: this.database });
  }

  /** All supported graph writers share this lock before any reads or namespace locks. */
  private async executeWrite<T>(
    session: Session,
    work: (tx: ManagedTransaction) => Promise<T>,
  ): Promise<T> {
    const started = performance.now();
    let acknowledged = false;
    let guardLifetime: ReturnType<typeof createOrdinaryAutonomousPersonalRecordGuardV4> | undefined;
    const readRegisteredFormat = (tx: Pick<ManagedTransaction, 'run'>) =>
      this.readAutonomousSource4FormatInTransaction(
        tx,
        guardLifetime?.read,
        guardLifetime
          ? undefined
          : (positive) => {
              guardLifetime ??= createOrdinaryAutonomousPersonalRecordGuardV4();
              guardLifetime.read.charge({ row_count: positive.rowCount });
              guardLifetime.read.charge({ format: positive.format });
            },
      );
    try {
      const result = await session.executeWrite(async (tx) => {
        if (this.initialized)
          await tx.run(`MERGE (lock:EngramStoreLock {id: 'extraction-v1'})
        SET lock.revision = coalesce(lock.revision, 0) + 1`);
        const registeredBefore = this.initialized ? await readRegisteredFormat(tx) : false;
        if (registeredBefore) {
          guardLifetime ??= createOrdinaryAutonomousPersonalRecordGuardV4();
          await this.assertEnrolledAutonomousPersonalRecordsInTransaction(tx, guardLifetime);
        }
        const value = await work(tx);
        if (this.initialized) {
          const registeredAfter = await readRegisteredFormat(tx);
          // Ordinary writers cannot enroll a store or remove its native format.
          // First enrollment requires the separately gated native V4 writer.
          if (registeredAfter !== registeredBefore)
            throw new Error('Engram automatic ledger: invalid_native_format');
          if (registeredAfter) {
            guardLifetime ??= createOrdinaryAutonomousPersonalRecordGuardV4();
            await this.assertEnrolledAutonomousPersonalRecordsInTransaction(tx, guardLifetime);
          }
        }
        return value;
      });
      acknowledged = true;
      return result;
    } finally {
      try {
        this.extractionObservers.getStore()?.({
          backend: 'neo4j',
          acknowledged,
          total_ms: performance.now() - started,
          queue_wait_ms: null,
          lock_wait_ms: null,
          disk_refresh_ms: null,
          snapshot_write_ms: null,
          snapshot_bytes: null,
          transaction_ms: performance.now() - started,
          serialization_ms: null,
        });
      } catch {
        /* Diagnostics are observational. */
      }
    }
  }

  private async readAutonomousSource4FormatInTransaction(
    tx: Pick<ManagedTransaction, 'run'>,
    read?: CompositionalNativeReadV3,
    onPositiveFormatWithoutRead?: (positive: PositiveAutonomousSource4FormatV4) => void,
  ): Promise<boolean> {
    read?.check();
    const result = await tx.run(
      `MATCH (lock:EngramStoreLock {id:'extraction-v1'})
       RETURN lock.autonomous_source_format_v4 AS format`,
    );
    read?.check();
    read?.charge({ row_count: result.records.length });
    for (const record of result.records) {
      read?.check();
      read?.charge({ format: record.get('format') ?? null });
    }
    if (result.records.length > 1)
      throw new Error('Engram automatic ledger: invalid_native_format');
    const format = result.records[0]?.get('format');
    if (format === undefined || format === null) return false;
    // This driver uses lossless native integers. Float/string/bool witnesses
    // cannot silently opt a store into, or out of, the protected format.
    if (neo4j.isInt(format) && format.equals(neo4j.int(1))) {
      // Ordinary callers retain the markerless legacy path without creating a
      // read scope. Once the exact positive marker is known, charge its raw
      // native payload before the caller proceeds to decode protected rows.
      if (!read) onPositiveFormatWithoutRead?.({ rowCount: result.records.length, format });
      return true;
    }
    throw new Error('Engram automatic ledger: invalid_native_format');
  }

  /** Scalar-only caps are checked before the one complete native graph payload read. */
  private async preflightAutonomousPersonalGlobalGraphInTransaction(
    tx: Pick<ManagedTransaction, 'run'>,
    read?: CompositionalNativeReadV3,
  ): Promise<void> {
    read?.check();
    const result = await tx.run(
      `CALL {
         MATCH (e:Entity)
         WITH e LIMIT 100001
         WITH e, ${cypherEntityCharCount('e')} AS row_chars
         RETURN count(e) AS entity_count,
                coalesce(sum(row_chars),0) AS entity_chars,
                coalesce(max(row_chars),0) AS entity_char_max
       }
       CALL {
         MATCH ()-[r:RELATES_TO]->()
         WITH r LIMIT 100001
         WITH r, ${cypherEdgeCharCount('r')} AS row_chars
         RETURN count(r) AS edge_count,
                coalesce(sum(row_chars),0) AS edge_chars,
                coalesce(max(row_chars),0) AS edge_char_max
       }
       CALL {
         MATCH (ep:Episode)
         WITH ep LIMIT 100001
         WITH ep,
              ${cypherEpisodeCharCount('ep')} AS row_chars,
              size(toString(coalesce(ep.attributes,''))) AS attribute_chars
         RETURN count(ep) AS episode_count,
                coalesce(sum(row_chars),0) AS episode_chars,
                coalesce(max(attribute_chars),0) AS episode_attribute_char_max
       }
       CALL {
         MATCH (op:AutomaticOperation)
         WITH op LIMIT 100001
         WITH op,
              size(toString(coalesce(op.record_json,''))) AS row_chars
         RETURN count(op) AS operation_count,
                coalesce(sum(row_chars),0) AS operation_chars,
                coalesce(max(row_chars),0) AS operation_char_max
       }
       RETURN entity_count, entity_chars, entity_char_max,
              edge_count, edge_chars, edge_char_max,
              episode_count, episode_chars, episode_attribute_char_max,
              operation_count, operation_chars, operation_char_max`,
      { maxChars: AUTONOMOUS_V4_INSPECTION_CHAR_LIMIT },
    );
    read?.check();
    read?.charge({ row_count: result.records.length });
    if (result.records.length !== 1) throw new Error('Engram queue: snapshot_limit');
    const row = result.records[0];
    if (!row) throw new Error('Engram queue: snapshot_limit');
    const fields = [
      'entity_count',
      'entity_chars',
      'entity_char_max',
      'edge_count',
      'edge_chars',
      'edge_char_max',
      'episode_count',
      'episode_chars',
      'episode_attribute_char_max',
      'operation_count',
      'operation_chars',
      'operation_char_max',
    ] as const;
    const raw = Object.fromEntries(fields.map((field) => [field, row.get(field)]));
    read?.charge(raw);
    read?.check();
    const number = (field: (typeof fields)[number]): number => {
      const value = raw[field];
      const parsed = neo4j.isInt(value)
        ? value.toNumber()
        : typeof value === 'number'
          ? value
          : NaN;
      if (!Number.isSafeInteger(parsed) || parsed < 0)
        throw new Error('Engram queue: snapshot_limit');
      return parsed;
    };
    const entityCount = number('entity_count');
    const edgeCount = number('edge_count');
    const episodeCount = number('episode_count');
    const operationCount = number('operation_count');
    const totalChars =
      number('entity_chars') +
      number('edge_chars') +
      number('episode_chars') +
      number('operation_chars');
    if (number('episode_attribute_char_max') > AUTOMATIC_CLAIM_ROW_CHAR_LIMIT)
      throw new Error('Engram automatic capture: native_attributes_too_large');
    if (number('operation_char_max') > AUTONOMOUS_V4_OPERATION_ROW_BYTES)
      throw new Error('Engram automatic ledger: invalid_native_record');
    if (
      entityCount + edgeCount + episodeCount > 100_000 ||
      operationCount > 100_000 ||
      !Number.isSafeInteger(totalChars) ||
      totalChars > AUTONOMOUS_V4_INSPECTION_CHAR_LIMIT
    ) {
      throw new Error('Engram queue: snapshot_limit');
    }
  }

  private async assertEnrolledAutonomousPersonalRecordsInTransaction(
    tx: Pick<ManagedTransaction, 'run'>,
    guard: ReturnType<typeof createOrdinaryAutonomousPersonalRecordGuardV4>,
  ): Promise<GraphData> {
    guard.read.check?.();
    guard.read.begin?.();
    await this.preflightAutonomousPersonalGlobalGraphInTransaction(tx, guard.read);
    const snapshotRead: CompositionalNativeReadV3 = {
      check: guard.read.check,
      charge: guard.read.charge,
    };
    const graph = await this.graphInTransaction(
      tx,
      undefined,
      'automatic_capture',
      snapshotRead,
      true,
    );
    guard.read.check?.();
    assertAutomaticLedgerSourceIntegrity(graph);
    guard.read.check?.();
    assertAutonomousPersonalRecordIntegrityV4(graph, guard.work, guard.read.check ?? (() => {}));
    guard.read.check?.();
    return graph;
  }

  /**
   * Markerless startup keeps the scalar Source4/Operation4 presence probe.
   * Only a candidate Source4 substring opens a bounded, candidate-only read;
   * shared legacy Claim1/2 keys are never scanned or hydrated here.
   */
  private async assertNoUnregisteredAutonomousPersonalSourceRowsInTransaction(
    tx: Pick<ManagedTransaction, 'run'>,
    getGuard: () => ReturnType<typeof createOrdinaryAutonomousPersonalRecordGuardV4>,
  ): Promise<void> {
    const result = await tx.run(
      `CALL {
         MATCH (ep:Episode)
         WHERE toString(coalesce(ep.attributes,'')) CONTAINS $owner_key
            OR toString(coalesce(ep.attributes,'')) CONTAINS $envelope_key
         RETURN count(ep) AS source_count
       }
       CALL {
         MATCH (op:AutomaticOperation)
         WHERE op.record_json STARTS WITH '{"version":4'
         RETURN count(op) AS operation_count
       }
       RETURN source_count, operation_count`,
      {
        owner_key: AUTONOMOUS_CAPTURE_V4_OWNER_ATTRIBUTE,
        envelope_key: AUTONOMOUS_CAPTURE_V3_ENVELOPE_ATTRIBUTE,
      },
    );
    const row = result.records[0];
    if (!row || result.records.length !== 1)
      throw new Error('Engram automatic ledger: invalid_native_format');
    const count = (key: 'source_count' | 'operation_count'): number => {
      const raw: unknown = row.get(key);
      const parsed = neo4j.isInt(raw) ? raw.toNumber() : typeof raw === 'number' ? raw : NaN;
      if (!Number.isSafeInteger(parsed) || parsed < 0)
        throw new Error('Engram automatic ledger: invalid_native_format');
      return parsed;
    };
    const sourceCount = count('source_count');
    const operationCount = count('operation_count');
    if (operationCount > 0) throw new Error('Engram automatic ledger: unregistered_native_format');
    if (sourceCount === 0) return;

    // The callback can be replayed by the managed read executor. The guard is
    // allocated through an outer closure and the same deadline/scope survives.
    const guard = getGuard();
    const read = guard.read;
    const scope = guard.scope;
    read.check();
    read.begin?.();

    const preflight = await tx.run(
      `MATCH (ep:Episode)
       WHERE toString(coalesce(ep.attributes,'')) CONTAINS $owner_key
          OR toString(coalesce(ep.attributes,'')) CONTAINS $envelope_key
       WITH ep LIMIT 100001
       WITH ep, size(toString(coalesce(ep.attributes,''))) AS attribute_chars
       RETURN count(ep) AS candidate_count,
              coalesce(sum(attribute_chars),0) AS total_attribute_chars,
              coalesce(max(attribute_chars),0) AS max_attribute_chars`,
      {
        owner_key: AUTONOMOUS_CAPTURE_V4_OWNER_ATTRIBUTE,
        envelope_key: AUTONOMOUS_CAPTURE_V3_ENVELOPE_ATTRIBUTE,
      },
    );
    read.check();
    read.charge({ row_count: preflight.records.length });
    if (preflight.records.length !== 1) throw new Error('Engram queue: snapshot_limit');
    const preflightRow = preflight.records[0];
    if (!preflightRow) throw new Error('Engram queue: snapshot_limit');
    const preflightFields = {
      candidate_count: preflightRow.get('candidate_count'),
      total_attribute_chars: preflightRow.get('total_attribute_chars'),
      max_attribute_chars: preflightRow.get('max_attribute_chars'),
    };
    read.charge(preflightFields);
    const preflightCount = (value: unknown): number => {
      const parsed = neo4j.isInt(value)
        ? value.toNumber()
        : typeof value === 'number'
          ? value
          : NaN;
      if (!Number.isSafeInteger(parsed) || parsed < 0)
        throw new Error('Engram queue: snapshot_limit');
      return parsed;
    };
    const candidateCount = preflightCount(preflightFields.candidate_count);
    const totalAttributeChars = preflightCount(preflightFields.total_attribute_chars);
    const maxAttributeChars = preflightCount(preflightFields.max_attribute_chars);
    chargeOrdinaryAutonomousPersonalContextV4(scope, read.check, {
      candidate_count: candidateCount,
      total_attribute_chars: totalAttributeChars,
      max_attribute_chars: maxAttributeChars,
    });
    if (
      sourceCount > 100_000 ||
      candidateCount > 100_000 ||
      candidateCount !== sourceCount ||
      totalAttributeChars > AUTONOMOUS_V4_INSPECTION_CHAR_LIMIT
    ) {
      throw new Error('Engram queue: snapshot_limit');
    }
    if (maxAttributeChars > AUTOMATIC_CLAIM_ROW_CHAR_LIMIT)
      throw new Error('Engram automatic capture: native_attributes_too_large');

    const candidates = await tx.run(
      `MATCH (ep:Episode)
       WHERE toString(coalesce(ep.attributes,'')) CONTAINS $owner_key
          OR toString(coalesce(ep.attributes,'')) CONTAINS $envelope_key
       WITH ep ORDER BY ep.uuid LIMIT 100001
       RETURN ep.uuid AS uuid, ep.attributes AS attributes`,
      {
        owner_key: AUTONOMOUS_CAPTURE_V4_OWNER_ATTRIBUTE,
        envelope_key: AUTONOMOUS_CAPTURE_V3_ENVELOPE_ATTRIBUTE,
      },
    );
    read.check();
    read.charge({ row_count: candidates.records.length });
    if (candidates.records.length !== candidateCount)
      throw new Error('Engram automatic ledger: invalid_native_format');
    for (const candidate of candidates.records) {
      read.check();
      const uuid: unknown = candidate.get('uuid');
      const attributes: unknown = candidate.get('attributes');
      // Charge the exact raw candidate row before JSON parsing or key checks.
      read.charge({ uuid: uuid ?? null, attributes: attributes ?? null });
      if (typeof uuid !== 'string' || typeof attributes !== 'string')
        throw new Error('Engram automatic ledger: invalid_native_record');
      chargeOrdinaryAutonomousPersonalContextV4(scope, read.check, { uuid, attributes });

      let parsedAttributes: unknown;
      try {
        parsedAttributes = JSON.parse(attributes) as unknown;
      } catch {
        // Legacy episode reads map malformed plain text to empty attributes.
        // The marker substring alone cannot promote such text to Source4.
        parsedAttributes = null;
      }
      if (
        parsedAttributes !== null &&
        typeof parsedAttributes === 'object' &&
        !Array.isArray(parsedAttributes) &&
        AUTONOMOUS_PERSONAL_SOURCE4_ATTRIBUTE_KEYS.some((key) =>
          Object.prototype.hasOwnProperty.call(parsedAttributes, key),
        )
      ) {
        throw new Error('Engram automatic ledger: unregistered_native_format');
      }
      read.check();
    }
  }

  private async automaticCaptureRevision(
    tx: Pick<ManagedTransaction, 'run'>,
    read?: CompositionalNativeReadV3,
  ): Promise<string> {
    read?.check();
    const result = await tx.run(
      `OPTIONAL MATCH (lock:EngramStoreLock {id:'extraction-v1'})
       RETURN coalesce(lock.revision, 0) AS revision, lock.epoch AS epoch,
              coalesce(lock.automatic_operations_v1_present, false) AS ledger_present`,
    );
    read?.check();
    const record = result.records[0];
    read?.charge({
      revision: record?.get('revision') ?? 0,
      epoch: record?.get('epoch') ?? null,
      ledger_present: record?.get('ledger_present') === true,
    });
    return [
      record?.get('revision')?.toString() ?? '0',
      (record?.get('epoch') as string | undefined) ?? 'initial',
      record?.get('ledger_present') === true ? 'ledger' : 'no-ledger',
    ].join(':');
  }

  /** Bounded coherent read snapshot; it never updates the shared writer revision. */
  private async readAutomaticCaptureSnapshot(
    session: Session,
    check: () => void = () => {},
    read?: CompositionalNativeReadV3,
    beforeAttempt?: () => void,
  ): Promise<{ graph: GraphData; backendNow: string }> {
    for (let attempt = 0; attempt < AUTOMATIC_CAPTURE_READ_MAX_RETRIES; attempt += 1) {
      check();
      beforeAttempt?.();
      check();
      let firstCallback = true;
      const snapshot = await session.executeRead(async (tx) => {
        if (!firstCallback) beforeAttempt?.();
        firstCallback = false;
        check();
        const before = await this.automaticCaptureRevision(tx, read);
        check();
        const graph = await this.graphInTransaction(tx, undefined, 'automatic_capture', read);
        check();
        if (graph.group_id === undefined) delete graph.group_id;
        const clock = await tx.run('RETURN datetime.realtime().epochMillis AS now');
        check();
        const clockValue: unknown = clock.records[0]?.get('now');
        const epochMillis = neo4j.isInt(clockValue)
          ? clockValue.toNumber()
          : typeof clockValue === 'number'
            ? clockValue
            : NaN;
        if (
          !Number.isSafeInteger(epochMillis) ||
          !Number.isFinite(new Date(epochMillis).getTime())
        ) {
          throw new Error('Engram automatic capture: backend_clock_invalid');
        }
        const backendNow = new Date(epochMillis).toISOString();
        const after = await this.automaticCaptureRevision(tx, read);
        check();
        return before === after ? { graph, backendNow } : null;
      });
      if (snapshot) return snapshot;
    }
    throw new Error('Engram automatic capture: concurrent_snapshot');
  }

  extractionBackend(): 'neo4j' {
    return 'neo4j';
  }

  async automaticBindingCommand(command: AutomaticBindingCommand): Promise<AutomaticBindingRecord> {
    const parsed = AutomaticBindingCommandSchema.parse(command);
    // Neo4j may retry the transaction callback, so mutation identity is fixed before it starts.
    const bindingId = parsed.action === 'create' ? generateUuid() : parsed.bindingId;
    const at = nowIso();
    const session = this.getSession();
    try {
      return await this.executeWrite(session, async (tx) => {
        const before = await this.graphInTransaction(tx);
        const after = JSON.parse(JSON.stringify(before)) as GraphData;
        const record = applyAutomaticBindingCommand(after, parsed, bindingId, at);
        await this.writeExtractionDiff(tx, before, after);
        return record;
      });
    } finally {
      await session.close();
    }
  }

  async observeLegacyAutomaticSource(
    request: AutomaticLegacyObservationRequest,
  ): Promise<AutomaticLegacyObservationResult> {
    const parsed = AutomaticLegacyObservationRequestSchema.safeParse(request);
    const response = (
      status: AutomaticLegacyObservationResult['status'],
      state: AutomaticLegacyObservationResult['state'] = null,
      attemptAudit: AutomaticLegacyObservationResult['attemptAudit'] = 'not_recorded',
    ): AutomaticLegacyObservationResult =>
      AutomaticLegacyObservationResultSchema.parse({
        status,
        state,
        shouldProcess: false,
        attemptAudit,
      });
    if (!parsed.success) return response('invalid_input');

    // Neo4j may retry executeWrite callbacks, so these identities are fixed in advance.
    const operationId = generateUuid();
    const attemptHash =
      parsed.data.attemptIdHash ?? createHash('sha256').update(generateUuid()).digest('hex');
    const session = this.getSession();
    try {
      return await this.executeWrite(session, async (tx) => {
        const before = await this.graphInTransaction(tx);
        const source = before.episodes.find((episode) => episode.uuid === parsed.data.sourceId);
        if (!source) return response('unavailable');

        const storedOwner = AutomaticWriteOwnerSchema.safeParse(
          source.attributes[WRITE_OWNER_ATTRIBUTE],
        );
        if (!storedOwner.success) return response('unavailable');
        if (canonical(storedOwner.data) !== canonical(parsed.data.expectedOwner))
          return response('conflict');

        let identity;
        try {
          identity = automaticOperationIdentityForOwnedSource(source, storedOwner.data);
        } catch {
          return response('unavailable');
        }

        const ledger = before.automatic_operations_v1 ?? { version: 1 as const, operations: [] };
        const existing = ledger.operations.find(
          (operation) => operation.identity.sourceId === parsed.data.sourceId,
        );
        if (existing?.version === 4) return response('conflict');
        if (existing) {
          const reconciled = reconcileAutomaticOperationIdentity(identity, existing.identity);
          if (!reconciled) return response('conflict');
          identity = reconciled;
          if (existing.state !== 'legacy_unconfirmed') return response('already_recorded');
        }

        const clock = await tx.run('RETURN toString(datetime.transaction()) AS now');
        const backendNow = new Date(clock.records[0].get('now')).toISOString();
        const observed = observeLegacyUnconfirmed(
          ledger,
          { operationId, identity, attempt: { attemptHash } },
          backendNow,
        );
        if (observed.kind === 'conflict') return response('conflict');
        if (observed.kind === 'capacity')
          return response('capacity', null, observed.attemptAudit ?? 'capacity_reached');
        if (observed.kind !== 'original_receipt_unavailable' || !observed.ledger) {
          return response(observed.kind === 'clock_regression' ? 'unavailable' : 'invalid_ledger');
        }

        const after: GraphData = {
          ...before,
          automatic_operations_v1: AutomaticLedgerSchema.parse(observed.ledger),
        };
        await this.writeExtractionDiff(tx, before, after);
        return response(
          existing ? 'already_unconfirmed' : 'observed',
          'legacy_unconfirmed',
          observed.attemptAudit ?? 'not_recorded',
        );
      });
    } finally {
      await session.close();
    }
  }

  /**
   * Atomically persist a replay-safe human source and its first lease. This
   * backend method does not expose a processing permit; the private handle is
   * issued only after the managed write has acknowledged the complete commit.
   */
  async beginAndClaimAutomaticCaptureV2(
    input: AutomaticCaptureBeginRequestV2,
  ): Promise<AutomaticCaptureBeginInternalResultV2> {
    let request: AutomaticCaptureBeginRequestV2;
    try {
      request = AutomaticCaptureBeginRequestV2Schema.parse(
        cloneBoundedAutomaticCaptureJson(input, 'beginRequest'),
      );
    } catch {
      return { kind: 'invalid_input' };
    }
    const storeHash = neo4jAutomaticCaptureStoreHash(this.originalConfiguredUri, this.database);
    if (!storeHash || !this.initialized || request.purpose !== 'human_turn_memory')
      return { kind: 'unsupported_mode' };

    // All identities remain stable when Neo4j retries the managed callback.
    const begin = this.automaticCaptureHandles.startBegin('human_turn_memory');
    const sourceId = generateUuid();
    const operationId = generateUuid();
    const deadline = performance.now() + request.settings.invocationDeadlineMs;
    const check = () => {
      if (performance.now() >= deadline)
        throw new Error('Engram automatic capture: budget_exhausted');
    };

    const session = this.getSession();
    let prepared: AutomaticHumanCaptureBeginPreparationV2;
    try {
      try {
        prepared = await this.executeWrite(session, async (tx) => {
          check();
          const before = await this.graphInTransaction(tx, undefined, 'automatic_capture');
          // An unscoped native snapshot represents the full store. The optional
          // GraphData root is omitted instead of passing an own undefined field
          // to the bounded JSON clone.
          if (before.group_id === undefined) delete before.group_id;
          check();

          const tailResult = await tx.run(
            `MATCH (ep:Episode {group_id: $group_id})
             RETURN ep.uuid AS uuid
             ORDER BY coalesce(ep.append_sequence, 0) DESC, ep.created_at DESC, ep.uuid DESC
             LIMIT 1`,
            { group_id: request.namespace },
          );
          const previousEpisodeId =
            (tailResult.records[0]?.get('uuid') as string | undefined) ?? null;
          check();

          // transaction() is fixed at tx start and can predate a writer-lock
          // wait. Realtime is queried after executeWrite acquired the shared
          // lock, then normalized to the store's ISO millisecond precision.
          const clockResult = await tx.run('RETURN datetime.realtime().epochMillis AS now');
          const epochMillis = cypherIntegerNumber(clockResult.records[0]?.get('now'));
          if (
            !Number.isSafeInteger(epochMillis) ||
            !Number.isFinite(new Date(epochMillis).getTime())
          )
            throw new Error('Engram automatic capture: backend_clock_invalid');
          const backendNow = new Date(epochMillis).toISOString();
          check();

          const candidate = prepareHumanCaptureBeginV2(
            before,
            {
              request,
              storeHash,
              sourceId,
              operationId,
              previousEpisodeId,
              backendNow,
              beginCallHash: begin.beginCallHash,
              leaseToken: begin.leaseToken,
            },
            check,
          );
          check();
          if (candidate.kind === 'decision') throw new RollbackAutomaticCaptureBegin(candidate);

          // Same-call callback replay can observe a lease committed by an
          // earlier callback attempt. It needs no source/ledger rewrite; the
          // common lock transaction still acknowledges before handle issuance.
          if (candidate.kind === 'prepared_claim' && !candidate.writeRequired) return candidate;

          if (candidate.kind === 'prepared_claim' || candidate.kind === 'prepared_source_only') {
            const addedEpisodes = candidate.graph.episodes.filter(
              (episode) => !before.episodes.some((prior) => prior.uuid === episode.uuid),
            );
            if (addedEpisodes.length !== 1 || addedEpisodes[0].uuid !== sourceId) {
              throw new Error('Engram automatic capture: candidate_source_invalid');
            }
            await this.persistAutomaticCaptureBeginCandidate(
              tx,
              before,
              candidate.graph,
              addedEpisodes[0],
              backendNow,
              check,
            );
          } else {
            await this.writeExtractionDiff(tx, before, candidate.graph);
          }
          check();
          return candidate;
        });
      } catch (error) {
        if (error instanceof RollbackAutomaticCaptureBegin) {
          prepared = error.candidate;
        } else {
          throw error;
        }
      }
    } finally {
      await session.close();
    }

    if (prepared.kind === 'prepared_source_only')
      return { kind: 'capacity', sourcePersistence: 'persisted' };
    if (prepared.kind === 'decision' || prepared.kind === 'prepared_decision')
      return prepared.decision;

    const leaseHandle = this.automaticCaptureHandles.recoverOrIssueInitial(
      begin.scope,
      prepared.leaseFence,
    );
    if (!leaseHandle) throw new Error('Engram automatic memory: invalid_handle');
    return this.automaticCaptureResultSchemas.AutomaticCaptureBeginInternalResultV2Schema.parse({
      kind: 'claimed',
      purpose: 'human_turn_memory',
      sourceId: prepared.operation.identity.sourceId,
      operationId: prepared.operation.operationId,
      descriptorHash: hashAutomaticCaptureV2(prepared.operation.descriptor),
      sourcePersistence: 'persisted',
      leaseHandle,
    });
  }

  /**
   * Atomically finalize one detached literal-v1 human plan and its terminal
   * receipt. The handle is consumed before plan inspection or any async I/O;
   * only a committed transaction can produce initial-owner eligibility.
   */
  async completeHumanCaptureV2(
    handle: PrivateOneUseAutomaticLeaseHandle<'human_turn_memory'>,
    plan: StagedExtraction,
  ): Promise<AutomaticHumanCompletionInternalResultV2> {
    const resultSchema =
      this.automaticCaptureResultSchemas.AutomaticHumanCompletionInternalResultV2Schema;
    const stopped = (kind: string): AutomaticHumanCompletionInternalResultV2 =>
      resultSchema.parse({
        kind: kind === 'clock_regression' ? 'fenced' : kind,
        eligibleFirstCommit: false,
      });

    let capability;
    try {
      capability = this.automaticCaptureHandles.consumeForCompletion(handle, 'human_turn_memory');
    } catch {
      return stopped('invalid_handle');
    }
    const invocation = this.automaticCaptureHandles.readConsumedInvocation(
      capability,
      'human_turn_memory',
    );
    const preparedPlan = prepareHumanCapturePlanV2(plan, this.automaticCaptureHandles, capability);
    const storeHash = neo4jAutomaticCaptureStoreHash(this.originalConfiguredUri, this.database);
    if (!storeHash || !this.initialized) return stopped('invalid_input');

    const epochId = generateUuid();
    const started = performance.now();
    let deadline = started + 120_000;
    const check = () => {
      if (performance.now() >= deadline)
        throw new Error('Engram automatic capture: budget_exhausted');
    };
    const session = this.getSession();
    const transact = (acknowledgementOnly: boolean) =>
      this.executeWrite(session, async (tx) => {
        check();
        const graph = await this.graphInTransaction(tx, undefined, 'automatic_capture');
        if (graph.group_id === undefined) delete graph.group_id;
        const operation = graph.automatic_operations_v1?.operations.find(
          (item) => item.operationId === invocation.boundFence.operationId,
        );
        if (
          acknowledgementOnly &&
          !(
            operation?.version === 2 &&
            operation.state === 'committed' &&
            operation.completionCallHash === invocation.completionCallHash
          )
        ) {
          throw new RollbackAutomaticCaptureCompletion(null);
        }
        if (operation?.version === 2)
          deadline = Math.min(deadline, started + operation.descriptor.invocationDeadlineMs);

        // Query the authoritative clock after executeWrite has acquired the
        // shared writer lock and after its fresh complete graph read.
        const clock = await tx.run('RETURN datetime.realtime().epochMillis AS now');
        const epochMillis = cypherIntegerNumber(clock.records[0]?.get('now'));
        if (!Number.isSafeInteger(epochMillis) || !Number.isFinite(new Date(epochMillis).getTime()))
          throw new Error('Engram automatic capture: backend_clock_invalid');
        const backendNow = new Date(epochMillis).toISOString();
        check();

        const candidate = prepareHumanCaptureCompletionV2(
          graph,
          preparedPlan,
          this.automaticCaptureHandles,
          capability,
          { backendNow, storeHash },
          check,
        );
        if (acknowledgementOnly) {
          if (candidate.kind !== 'ack_recovered' && candidate.kind !== 'decision')
            throw new Error('Engram automatic capture: invalid_acknowledgement');
          throw new RollbackAutomaticCaptureCompletion(candidate);
        }
        if (
          candidate.kind === 'decision' ||
          candidate.kind === 'ack_recovered' ||
          (candidate.kind === 'prepared_retry' && !candidate.writeRequired)
        ) {
          // The shared transaction wrapper increments a revision before work;
          // roll that update back for decisions and callback-only recovery.
          throw new RollbackAutomaticCaptureCompletion(candidate);
        }
        if ('graph' in candidate) {
          const factsAdded =
            candidate.kind === 'prepared_commit' &&
            (candidate.graph.entities.length > graph.entities.length ||
              candidate.graph.edges.length > graph.edges.length);
          if (factsAdded) {
            candidate.graph.metadata = {
              ...candidate.graph.metadata,
              extraction_epoch: epochId,
            };
          }
          await this.writeExtractionDiff(tx, graph, candidate.graph);
          if (factsAdded) {
            await tx.run(
              `MATCH (lock:EngramStoreLock {id:'extraction-v1'}) SET lock.epoch=$epoch`,
              { epoch: epochId },
            );
          }
        }
        check();
        return candidate;
      });

    let prepared: AutomaticHumanCaptureCompletionPreparationV2 | null = null;
    try {
      try {
        prepared = await transact(false);
      } catch (error) {
        if (error instanceof RollbackAutomaticCaptureCompletion) {
          prepared = error.preparation;
        } else {
          // A lost acknowledgement is resolved only by reading the exact
          // committed completion hash. The original plan is never reapplied.
          try {
            prepared = await transact(true);
          } catch (acknowledgementError) {
            if (acknowledgementError instanceof RollbackAutomaticCaptureCompletion)
              prepared = acknowledgementError.preparation;
          }
        }
      }
    } finally {
      await session.close();
    }

    if (!prepared) return stopped('storage_error');
    if (prepared.kind === 'prepared_retry') {
      const retryHandle = this.automaticCaptureHandles.recoverOrIssueSuccessor(
        invocation.retryScope,
        prepared.leaseFence,
      );
      return retryHandle
        ? resultSchema.parse({
            kind: 'graph_conflict_retry',
            retryHandle,
            eligibleFirstCommit: false,
          })
        : stopped('fenced');
    }
    if (prepared.kind === 'decision' || prepared.kind === 'prepared_failure')
      return stopped(prepared.reason);
    const currentAuthority =
      prepared.kind === 'ack_recovered' ? prepared.currentAuthority : 'active';
    const initial =
      invocation.boundFence.claimKind === 'initial' && invocation.boundFence.generation === 1;
    return resultSchema.parse({
      kind: 'committed',
      invocation: initial
        ? prepared.kind === 'ack_recovered'
          ? 'same_call_ack_recovered'
          : 'initial_owner'
        : 'explicit_resume',
      terminalReceipt: prepared.terminalReceipt,
      currentAuthority,
      eligibleFirstCommit: initial && currentAuthority === 'active',
    });
  }

  /**
   * Persist one exact assistant final source and its write-only receipt. This
   * method never exposes a lease handle or a processing permit. Both database
   * transactions re-read the complete graph and the current human authority
   * under the common writer lock.
   */
  async saveAssistantFinalV2(
    input: AutomaticAssistantCaptureIntentV2,
    workBudget?: AutomaticAssistantWorkBudgetV2,
  ): Promise<AutomaticAssistantFinalWriterResultV2> {
    const started = performance.now();
    const stopped = (
      reason: Extract<AutomaticAssistantFinalWriterResultV2, { kind: 'decision' }>['reason'],
    ): AutomaticAssistantFinalWriterResultV2 =>
      AutomaticAssistantFinalWriterResultV2Schema.parse({
        kind: 'decision',
        reason,
        eligibleFirstCommit: false,
      });
    let intent: AutomaticAssistantCaptureIntentV2;
    let budget: AutomaticAssistantWorkBudgetV2 | undefined;
    try {
      intent = AutomaticAssistantCaptureIntentV2Schema.parse(
        cloneBoundedAutomaticCaptureJson(input, 'assistantIntent'),
      );
      budget =
        workBudget === undefined
          ? undefined
          : AutomaticAssistantWorkBudgetV2Schema.parse(
              cloneBoundedAutomaticCaptureJson(workBudget, 'beginRequest'),
            );
    } catch {
      return stopped('invalid_input');
    }

    const storeHash = neo4jAutomaticCaptureStoreHash(this.originalConfiguredUri, this.database);
    if (!this.initialized || !storeHash) return stopped('unsupported_mode');
    const authorizationRegistry = createAutomaticAssistantCaptureAuthorizationRegistry(
      this.automaticCaptureHandles,
    );

    // Stable identities and nonce scope are allocated once outside any
    // managed-transaction callback. Neo4j may invoke each callback repeatedly.
    const begin = this.automaticCaptureHandles.startBegin('assistant_final_save');
    const sourceId = generateUuid();
    const operationId = generateUuid();
    const deadline =
      started +
      Math.min(intent.invocationDeadlineMs, budget?.remainingMs ?? intent.invocationDeadlineMs);
    const check = () => {
      if (performance.now() >= deadline)
        throw new Error('Engram automatic capture: budget_exhausted');
    };
    try {
      check();
    } catch {
      return stopped('budget_exhausted');
    }

    const session = this.getSession();
    let authorization: PrivateConsumedAutomaticAssistantWriteAuthorizationV2 | null = null;
    let beginStaged = false;
    let beginAcknowledged = false;
    let beginPreparation: AutomaticAssistantCaptureBeginPreparationV2 | null = null;
    let earlyResult: AutomaticAssistantFinalWriterResultV2 | null = null;
    try {
      try {
        beginPreparation = await this.executeWrite(session, async (tx) => {
          check();
          const before = await this.graphInTransaction(tx, undefined, 'automatic_capture');
          if (before.group_id === undefined) delete before.group_id;
          check();

          if (!authorization) {
            const issued = authorizationRegistry.authorize(intent, before, { storeHash }, check);
            if (!issued) {
              // A revoked historical exact receipt remains inspectable as
              // evidence, but this capability-free result cannot authorize
              // an agent or a write.
              const historical = readAutomaticAssistantCaptureReplayV2(
                before,
                intent,
                { storeHash },
                check,
              );
              if (
                historical.kind === 'committed_replay' &&
                historical.currentAuthority !== 'active'
              )
                throw new RollbackAutomaticAssistantCapture({
                  stage: 'begin_result',
                  result: historical,
                });
              throw new RollbackAutomaticAssistantCapture({
                stage: 'begin_result',
                result: stopped('authority_changed'),
              });
            }
            authorization = authorizationRegistry.consumeForBegin(issued, intent);
          }

          check();
          const tailResult = await tx.run(
            `MATCH (ep:Episode {group_id: $group_id})
             RETURN ep.uuid AS uuid
             ORDER BY coalesce(ep.append_sequence, 0) DESC, ep.created_at DESC, ep.uuid DESC
             LIMIT 1`,
            { group_id: intent.humanTurn.namespace },
          );
          const previousEpisodeId =
            (tailResult.records[0]?.get('uuid') as string | undefined) ?? null;
          check();

          // Query wall-clock time after executeWrite has acquired the common
          // store lock. transaction() time may predate a lock wait.
          const clock = await tx.run('RETURN datetime.realtime().epochMillis AS now');
          const epochMillis = cypherIntegerNumber(clock.records[0]?.get('now'));
          if (
            !Number.isSafeInteger(epochMillis) ||
            !Number.isFinite(new Date(epochMillis).getTime())
          )
            throw new Error('Engram automatic capture: backend_clock_invalid');
          const backendNow = new Date(epochMillis).toISOString();
          check();

          const beginInput: AutomaticAssistantCaptureBeginInputV2 = {
            intent,
            storeHash,
            backendNow,
            sourceId,
            operationId,
            previousEpisodeId,
            beginCallHash: begin.beginCallHash,
            leaseToken: begin.leaseToken,
          };
          const candidate = prepareAssistantCaptureBeginV2(
            before,
            beginInput,
            authorizationRegistry,
            authorization,
            check,
          );
          check();

          // executeWrite increments the shared revision before user work.
          // A decision, exact same-call lease recovery, or non-audited receipt
          // read must roll that increment back without replacing state.
          if (candidate.kind === 'decision')
            throw new RollbackAutomaticAssistantCapture({ stage: 'begin', preparation: candidate });
          if (candidate.kind === 'prepared_claim' && !candidate.writeRequired)
            throw new RollbackAutomaticAssistantCapture({ stage: 'begin', preparation: candidate });
          if (candidate.kind === 'prepared_replay' && !candidate.auditWriteRequired)
            throw new RollbackAutomaticAssistantCapture({ stage: 'begin', preparation: candidate });

          if (candidate.kind === 'prepared_claim') {
            const addedEpisodes = candidate.graph.episodes.filter(
              (episode) => !before.episodes.some((prior) => prior.uuid === episode.uuid),
            );
            if (addedEpisodes.length !== 1 || addedEpisodes[0].uuid !== sourceId)
              throw new Error('Engram automatic capture: candidate_source_invalid');
            beginStaged = true;
            await this.persistAutomaticCaptureBeginCandidate(
              tx,
              before,
              candidate.graph,
              addedEpisodes[0],
              backendNow,
              check,
            );
          } else {
            // prepared_decision and prepared_replay carry a candidate only
            // when their bounded audit update is required. They never change
            // a source, fact, receipt, or extraction epoch.
            beginStaged = true;
            await this.writeExtractionDiff(tx, before, candidate.graph);
          }
          check();
          return candidate;
        });
        beginAcknowledged = true;
        // A confirmed begin may have persisted its lease after the caller's
        // budget expired. Do not issue the private handle or enter completion.
        if (beginPreparation.kind === 'prepared_claim') check();
      } catch (error) {
        if (error instanceof RollbackAutomaticAssistantCapture) {
          if (error.payload.stage === 'begin') beginPreparation = error.payload.preparation;
          else if (error.payload.stage === 'begin_result') earlyResult = error.payload.result;
        } else if (isAutomaticCaptureBudgetError(error) && (!beginStaged || beginAcknowledged)) {
          return stopped('budget_exhausted');
        } else if (beginStaged) {
          // A post-stage begin error is deliberately not resolved into a
          // handle. The caller may inspect/retry explicitly; this method never
          // reappends, resumes, or automatically applies after an unknown ack.
          earlyResult = stopped('acknowledgement_unknown');
        } else {
          return stopped('storage_error');
        }
      }
    } finally {
      await session.close();
    }

    if (earlyResult) return earlyResult;
    if (!beginPreparation) return stopped('acknowledgement_unknown');
    if (beginPreparation.kind === 'decision')
      return assistantBeginDecisionResult(beginPreparation.decision);
    if (beginPreparation.kind === 'prepared_decision')
      return assistantBeginDecisionResult(beginPreparation.decision);
    if (beginPreparation.kind === 'prepared_replay') {
      return AutomaticAssistantFinalWriterResultV2Schema.parse({
        kind: 'committed_replay',
        terminalReceipt: beginPreparation.terminalReceipt,
        currentAuthority: beginPreparation.currentAuthority,
        eligibleFirstCommit: false,
      });
    }

    if (!authorization) return stopped('invalid_handle');
    const leaseHandle = this.automaticCaptureHandles.recoverOrIssueInitial(
      begin.scope,
      beginPreparation.leaseFence,
    );
    if (!leaseHandle) return stopped('invalid_handle');
    try {
      authorizationRegistry.bindAssistantLease(
        authorization,
        leaseHandle,
        beginPreparation.leaseFence,
      );
    } catch {
      return stopped('invalid_handle');
    }
    const assistantAuthorization =
      authorizationRegistry.authorizationForAssistantLease(leaseHandle);
    if (!assistantAuthorization) return stopped('invalid_handle');

    // Completion has its own synchronous one-use fence. No asynchronous I/O
    // occurs before the handle is consumed, and the consumed call scope is
    // reused for every managed-callback replay below.
    let completionCapability: PrivateConsumedAutomaticCaptureInvocation<'assistant_final_save'>;
    try {
      completionCapability = this.automaticCaptureHandles.consumeForCompletion(
        leaseHandle,
        'assistant_final_save',
      );
    } catch {
      return stopped('invalid_handle');
    }
    try {
      this.automaticCaptureHandles.readConsumedInvocation(
        completionCapability,
        'assistant_final_save',
      );
    } catch {
      return stopped('invalid_handle');
    }

    try {
      check();
    } catch {
      return stopped('budget_exhausted');
    }

    const completionSession = this.getSession();
    let completionStaged = false;
    let completion: AutomaticAssistantCaptureCompletionPreparationV2 | null = null;
    try {
      try {
        completion = await this.executeWrite(completionSession, async (tx) => {
          check();
          const graph = await this.graphInTransaction(tx, undefined, 'automatic_capture');
          if (graph.group_id === undefined) delete graph.group_id;
          check();

          const clock = await tx.run('RETURN datetime.realtime().epochMillis AS now');
          const epochMillis = cypherIntegerNumber(clock.records[0]?.get('now'));
          if (
            !Number.isSafeInteger(epochMillis) ||
            !Number.isFinite(new Date(epochMillis).getTime())
          )
            throw new Error('Engram automatic capture: backend_clock_invalid');
          const backendNow = new Date(epochMillis).toISOString();
          check();

          const candidate = prepareAssistantFinalCompletionV2(
            graph,
            authorizationRegistry,
            leaseHandle,
            completionCapability,
            { storeHash, backendNow },
            check,
          );
          check();
          if (candidate.kind === 'decision' || candidate.kind === 'ack_recovered')
            throw new RollbackAutomaticAssistantCapture({
              stage: 'complete',
              preparation: candidate,
            });

          completionStaged = true;
          await this.writeExtractionDiff(tx, graph, candidate.graph);
          check();
          return candidate;
        });
        // If the transaction committed but its acknowledgement arrived after
        // the deadline, the catch path performs only bounded exact-receipt
        // readback. It never reapplies the assistant source or receipt.
        check();
      } catch (error) {
        if (
          error instanceof RollbackAutomaticAssistantCapture &&
          error.payload.stage === 'complete'
        ) {
          completion = error.payload.preparation;
        } else if (isAutomaticCaptureBudgetError(error) && !completionStaged) {
          return stopped('budget_exhausted');
        } else if (completionStaged) {
          // A receipt is recoverable only when the exact private completion
          // hash is already committed. Never re-apply the final write.
          try {
            const snapshot = await this.readAutomaticCaptureSnapshot(completionSession);
            const recovered = prepareAssistantFinalCompletionV2(
              snapshot.graph,
              authorizationRegistry,
              leaseHandle,
              completionCapability,
              { storeHash, backendNow: snapshot.backendNow },
              () => {},
            );
            completion = recovered.kind === 'ack_recovered' ? recovered : null;
          } catch {
            completion = null;
          }
        } else {
          return stopped('storage_error');
        }
      }
    } finally {
      await completionSession.close();
    }

    if (!completion) return stopped('acknowledgement_unknown');
    if (completion.kind === 'decision') return stopped(completion.reason);
    if (completion.kind === 'ack_recovered') {
      return AutomaticAssistantFinalWriterResultV2Schema.parse({
        kind: 'committed',
        invocation: 'same_call_ack_recovered',
        terminalReceipt: completion.terminalReceipt,
        currentAuthority: completion.currentAuthority,
        eligibleFirstCommit: false,
      });
    }
    return AutomaticAssistantFinalWriterResultV2Schema.parse({
      kind: 'committed',
      invocation: 'initial_owner',
      terminalReceipt: completion.terminalReceipt,
      currentAuthority: 'active',
      eligibleFirstCommit: false,
    });
  }

  /**
   * Native V4 assistant final writer. The private invocation supplies the only
   * plan DATA, IDs and call hashes; the one atomic writer transaction re-reads
   * the complete enrolled graph under the shared lock. An unknown acknowledgement
   * gets exactly one same-budget coherent readback and never resubmits the write.
   */
  async saveAssistantFinalV4(
    input: PrivateAutonomousPersonalAssistantFinalInvocationV4,
  ): Promise<AutomaticAssistantFinalWriterResultV2> {
    const stopped = (
      reason: AssistantFinalDecisionReasonV4,
    ): AutomaticAssistantFinalWriterResultV2 =>
      AutomaticAssistantFinalWriterResultV2Schema.parse({
        kind: 'decision',
        reason,
        eligibleFirstCommit: false,
      });
    // Synchronous one-use consumption precedes the first await.
    let key: PrivateConsumedAutonomousPersonalAssistantFinalInvocationV4 | null;
    try {
      key = consumeAutonomousPersonalAssistantFinalInvocationV4(this, input);
    } catch (error) {
      return stopped(
        autonomousPersonalAssistantFinalKnownFailureReasonV4(error) ?? 'invalid_handle',
      );
    }
    if (!key) return stopped('invalid_handle');
    const ownedKey = key;

    try {
      let view: ReturnType<typeof readAutonomousPersonalAssistantFinalInvocationV4>;
      try {
        view = readAutonomousPersonalAssistantFinalInvocationV4(this, ownedKey);
        view.check();
      } catch (error) {
        return stopped(
          autonomousPersonalAssistantFinalKnownFailureReasonV4(error) ?? 'invalid_handle',
        );
      }
      const { data: plan, work, check } = view;

      const storeHash = neo4jAutomaticCaptureStoreHash(this.originalConfiguredUri, this.database);
      if (!this.initialized || !storeHash) return stopped('unsupported_mode');
      if (
        plan.origin.identity.storeHash !== storeHash ||
        plan.nativeSnapshot.config.storeHash !== storeHash
      )
        return stopped('conflict');

      // One fixed budget and scope shared by every callback retry and the single readback.
      const budget = { remaining: 512, deferred: 0 };
      const scope = getAutomaticClaimReadScope(budget);
      if (!getAutomaticClaimReadScopeRemaining(scope)) return stopped('invalid_input');
      let chargeFailure: { value: unknown } | undefined;
      const scopeCheck = () => {
        if (chargeFailure) throw chargeFailure.value;
        check();
        if (!canUseAutomaticClaimReadScope(scope))
          throw new Error('Engram compositional capture: budget_exhausted');
      };
      const baseCharge = createNeo4jCompositionalReadChargeV3(scope, scopeCheck);
      const read: CompositionalNativeReadV3 = {
        check: scopeCheck,
        charge(value) {
          try {
            baseCharge(value);
          } catch (error) {
            chargeFailure ??= { value: error };
            throw error;
          }
        },
      };
      const reserveSnapshot = () => {
        scopeCheck();
        if (!beginAutomaticClaimReadAttempt(scope))
          throw new Error('Engram compositional capture: budget_exhausted');
        scopeCheck();
      };
      const transactionTimeout = () => {
        scopeCheck();
        const remaining = getAutomaticClaimReadScopeRemaining(scope);
        const timeout = Math.floor(
          Math.min(
            work.absoluteMonotonicDeadlineMs - performance.now(),
            remaining?.deadlineRemainingMs ?? 0,
          ),
        );
        if (!Number.isFinite(timeout) || timeout <= 0) throw new ExtractionBudgetError('deadline');
        return timeout;
      };
      const readBackendNow = async (tx: Pick<ManagedTransaction, 'run'>): Promise<string> => {
        scopeCheck();
        const clock = await tx.run('RETURN datetime.realtime().epochMillis AS now');
        scopeCheck();
        read.charge({ row_count: clock.records.length });
        for (const record of clock.records) {
          scopeCheck();
          read.charge({ now: record.get('now') ?? null });
        }
        if (clock.records.length !== 1)
          throw new Error('Engram automatic capture: backend_clock_invalid');
        const rawClock: unknown = clock.records[0]?.get('now');
        const milliseconds = neo4j.isInt(rawClock)
          ? rawClock.toNumber()
          : typeof rawClock === 'number'
            ? rawClock
            : NaN;
        if (
          !Number.isSafeInteger(milliseconds) ||
          !Number.isFinite(new Date(milliseconds).getTime())
        )
          throw new Error('Engram automatic capture: backend_clock_invalid');
        const backendNow = new Date(milliseconds).toISOString();
        scopeCheck();
        return backendNow;
      };
      const readActualGraph = async (tx: Pick<ManagedTransaction, 'run'>): Promise<GraphData> => {
        await this.preflightAutonomousPersonalGlobalGraphInTransaction(tx, read);
        scopeCheck();
        const actual = await this.graphInTransaction(
          tx,
          undefined,
          'automatic_capture',
          read,
          true,
        );
        if (actual.group_id === undefined) delete actual.group_id;
        scopeCheck();
        assertAutomaticLedgerSourceIntegrity(actual);
        scopeCheck();
        assertAutonomousPersonalRecordIntegrityV4(actual, work, scopeCheck);
        scopeCheck();
        return actual;
      };

      type CommittedReceipt = Extract<
        AutomaticAssistantFinalWriterResultV2,
        { kind: 'committed' }
      >['terminalReceipt'];
      let expectedReceipt: CommittedReceipt | undefined;
      let callbackReturned = false;
      let writeAttempted = false;
      let knownDurableAck = false;

      const readback = async (): Promise<AutomaticAssistantFinalWriterResultV2> => {
        let session: Session | undefined;
        let transaction: ReturnType<Session['beginTransaction']> | undefined;
        let result: AutomaticAssistantFinalWriterResultV2 = stopped('acknowledgement_unknown');
        try {
          scopeCheck();
          if (!claimAutonomousPersonalAssistantFinalReconciliationV4(this, ownedKey))
            return stopped('acknowledgement_unknown');
          const expected = expectedReceipt;
          if (!expected) return stopped('acknowledgement_unknown');
          reserveSnapshot();
          // A WRITE-routed explicit transaction gives one writer-routed read without managed retry.
          const timeout = transactionTimeout();
          session = this.driver.session({
            database: this.database,
            defaultAccessMode: neo4j.session.WRITE,
          });
          transaction = session.beginTransaction({ timeout });
          scopeCheck();
          const before = await this.automaticCaptureRevision(transaction, read);
          scopeCheck();
          const actual = await readActualGraph(transaction);
          const backendNow = await readBackendNow(transaction);
          const after = await this.automaticCaptureRevision(transaction, read);
          scopeCheck();
          await transaction.commit();
          scopeCheck();
          if (before === after) {
            const reconciled = reconcileAutonomousPersonalAssistantFinalV4(
              actual,
              plan,
              backendNow,
              work,
              scopeCheck,
            );
            scopeCheck();
            if (
              reconciled.kind === 'matched' &&
              canonical(reconciled.terminalReceipt) === canonical(expected)
            ) {
              result = AutomaticAssistantFinalWriterResultV2Schema.parse({
                kind: 'committed',
                invocation: 'same_call_ack_recovered',
                terminalReceipt: reconciled.terminalReceipt,
                currentAuthority: 'active',
                eligibleFirstCommit: false,
              });
              scopeCheck();
            }
          }
        } catch {
          try {
            await transaction?.rollback();
          } catch {
            // The single observation is already inconclusive.
          }
          return stopped('acknowledgement_unknown');
        } finally {
          try {
            await session?.close();
          } catch {
            // Closing the one observation cannot authorize another attempt.
          }
        }
        return result;
      };

      let writerSession: Session | undefined;
      let writerTransaction: ReturnType<Session['beginTransaction']> | undefined;
      let executionError: unknown;
      let commitAttempted = false;
      try {
        scopeCheck();
        // Compute the one transaction's timeout immediately before opening it.
        // A managed executeWrite retry would reuse a stale timeout computed
        // before its first attempt and could outlive this original read scope.
        const timeout = transactionTimeout();
        writerSession = this.driver.session({
          database: this.database,
          defaultAccessMode: neo4j.session.WRITE,
        });
        writerTransaction = writerSession.beginTransaction({ timeout });
        scopeCheck();
        await (async (tx: Pick<ManagedTransaction, 'run'>) => {
          // This explicit transaction runs once; validate its private stage before any I/O.
          if (callbackReturned || !canStageAutonomousPersonalAssistantFinalV4(this, ownedKey))
            throw autonomousPersonalAssistantFinalCallbackAlreadyReturnedErrorV4;
          scopeCheck();
          reserveSnapshot();
          const lockUpdate = await tx.run(
            `MATCH (lock:EngramStoreLock {id:'extraction-v1'})
               SET lock.revision=coalesce(lock.revision,0)+1
               RETURN lock.revision AS revision`,
          );
          scopeCheck();
          read.charge({ row_count: lockUpdate.records.length });
          for (const record of lockUpdate.records) {
            scopeCheck();
            read.charge({ revision: record.get('revision') ?? null });
          }
          if (lockUpdate.records.length !== 1)
            throw new Error('Engram automatic ledger: native_root_missing');

          const initialLockState = await this.automaticCaptureRevision(tx, read);
          if (!initialLockState.endsWith(':ledger'))
            throw new Error('Engram automatic ledger: native_root_missing');
          scopeCheck();
          const graph = await readActualGraph(tx);
          const backendNow = await readBackendNow(tx);

          const prepared = prepareAutonomousPersonalAssistantFinalV4(
            graph,
            plan,
            backendNow,
            work,
            scopeCheck,
          );
          scopeCheck();
          if (prepared.kind === 'decision')
            throw new RollbackAutonomousPersonalAssistantFinalV4(stopped(prepared.reason));
          if (prepared.kind === 'replay')
            throw new RollbackAutonomousPersonalAssistantFinalV4(
              AutomaticAssistantFinalWriterResultV2Schema.parse({
                kind: 'committed_replay',
                terminalReceipt: prepared.terminalReceipt,
                currentAuthority: 'active',
                eligibleFirstCommit: false,
              }),
            );

          // Match the candidate to the exact supplied identities; nothing else may change.
          const priorEpisodeIds = new Set<string>();
          for (const episode of graph.episodes) {
            scopeCheck();
            priorEpisodeIds.add(episode.uuid);
          }
          const addedEpisodes: EpisodicNode[] = [];
          for (const episode of prepared.graph.episodes) {
            scopeCheck();
            if (!priorEpisodeIds.has(episode.uuid)) addedEpisodes.push(episode);
          }
          const priorOperations = graph.automatic_operations_v1?.operations ?? [];
          const nextOperations = prepared.graph.automatic_operations_v1?.operations ?? [];
          const addedSource = addedEpisodes[0];
          const addedOperation = nextOperations.find((operation) => {
            scopeCheck();
            return operation.operationId === plan.operationId;
          });
          if (
            addedEpisodes.length !== 1 ||
            !addedSource ||
            addedSource.uuid !== plan.sourceId ||
            addedSource.role !== 'ai' ||
            prepared.graph.episodes.length !== graph.episodes.length + 1 ||
            prepared.graph.entities.length !== graph.entities.length ||
            prepared.graph.edges.length !== graph.edges.length ||
            nextOperations.length !== priorOperations.length + 1 ||
            !addedOperation ||
            addedOperation.version !== 2 ||
            addedOperation.state !== 'committed' ||
            addedOperation.identity.sourceId !== plan.sourceId ||
            addedOperation.beginCallHash !== plan.beginCallHash ||
            addedOperation.completionCallHash !== plan.completionCallHash ||
            canonical(addedOperation.terminalReceipt) !== canonical(prepared.terminalReceipt) ||
            (prepared.graph.metadata?.extraction_epoch ?? null) !==
              (graph.metadata?.extraction_epoch ?? null)
          )
            throw new Error('Engram automatic capture: candidate_source_invalid');
          scopeCheck();

          // The shared pure planner owns the deterministic unreferenced-tail
          // policy. Native append_sequence is transport ordering, not a second
          // predecessor rule; the persistence helper preserves this exact link.
          writeAttempted = true;
          // Writes the operation row and creates the source with its append sequence and
          // NEXT_EPISODE link exactly like the other native assistant/human source path.
          await this.persistAutomaticCaptureBeginCandidate(
            tx,
            graph,
            prepared.graph,
            addedSource,
            backendNow,
            scopeCheck,
          );
          scopeCheck();

          // Inspect the actual transaction rows before the callback may return.
          reserveSnapshot();
          const postWriteLockState = await this.automaticCaptureRevision(tx, read);
          if (!postWriteLockState.endsWith(':ledger'))
            throw new RollbackAutonomousPersonalAssistantFinalV4(stopped('conflict'));
          scopeCheck();
          const actual = await readActualGraph(tx);
          const reconciled = reconcileAutonomousPersonalAssistantFinalV4(
            actual,
            plan,
            backendNow,
            work,
            scopeCheck,
          );
          scopeCheck();
          const actualSource = actual.episodes.find((episode) => {
            scopeCheck();
            return episode.uuid === plan.sourceId;
          });
          const actualOperation = actual.automatic_operations_v1?.operations.find((operation) => {
            scopeCheck();
            return operation.operationId === plan.operationId;
          });
          if (
            reconciled.kind !== 'matched' ||
            canonical(reconciled.terminalReceipt) !== canonical(prepared.terminalReceipt) ||
            !actualSource ||
            canonical(actualSource) !== canonical(addedSource) ||
            !actualOperation ||
            canonical(actualOperation) !== canonical(addedOperation) ||
            actual.episodes.length !== graph.episodes.length + 1 ||
            actual.entities.length !== graph.entities.length ||
            actual.edges.length !== graph.edges.length ||
            (actual.automatic_operations_v1?.operations.length ?? 0) !== nextOperations.length ||
            (actual.metadata?.extraction_epoch ?? null) !==
              (graph.metadata?.extraction_epoch ?? null)
          )
            throw new RollbackAutonomousPersonalAssistantFinalV4(stopped('conflict'));
          scopeCheck();

          const chain = await tx.run(
            `MATCH (curr:Episode {uuid:$uuid})
               OPTIONAL MATCH (prev:Episode)-[:NEXT_EPISODE]->(curr)
               RETURN curr.append_sequence AS sequence, collect(prev.uuid) AS predecessors`,
            { uuid: plan.sourceId },
          );
          scopeCheck();
          read.charge({ row_count: chain.records.length });
          for (const record of chain.records) {
            scopeCheck();
            read.charge({
              sequence: record.get('sequence') ?? null,
              predecessors: record.get('predecessors') ?? null,
            });
          }
          const rawSequence: unknown = chain.records[0]?.get('sequence');
          const sequence = neo4j.isInt(rawSequence)
            ? rawSequence.toNumber()
            : typeof rawSequence === 'number'
              ? rawSequence
              : NaN;
          const predecessors: unknown = chain.records[0]?.get('predecessors');
          const expectedPredecessors =
            addedSource.previous_episode_uuid === null ||
            addedSource.previous_episode_uuid === undefined
              ? []
              : [addedSource.previous_episode_uuid];
          if (
            chain.records.length !== 1 ||
            !Number.isSafeInteger(sequence) ||
            sequence < 1 ||
            !Array.isArray(predecessors) ||
            canonical(predecessors) !== canonical(expectedPredecessors)
          )
            throw new RollbackAutonomousPersonalAssistantFinalV4(stopped('conflict'));
          scopeCheck();

          expectedReceipt = prepared.terminalReceipt;
          // The candidate is complete. Only one explicit commit may follow.
          markAutonomousPersonalAssistantFinalCandidateReturnedV4(this, ownedKey);
          callbackReturned = true;
          return autonomousPersonalAssistantFinalCallbackResultV4;
        })(writerTransaction);
        scopeCheck();
        // Only resolution of this single explicit commit establishes durable acknowledgement.
        commitAttempted = true;
        await writerTransaction.commit();
        knownDurableAck = true;
      } catch (error) {
        executionError = error;
        // A rejected commit has an unknown acknowledgement; do not send a
        // rollback that could obscure the result. Before commit is requested,
        // the one explicit transaction is still safe to roll back.
        if (writerTransaction && !commitAttempted) {
          try {
            await writerTransaction.rollback();
          } catch {
            // The original failure determines the bounded result.
          }
        }
      } finally {
        try {
          await writerSession?.close();
        } catch (error) {
          if (executionError === undefined) executionError = error;
        }
      }

      if (knownDurableAck && expectedReceipt) {
        // The commit is real even if the original work has since expired.
        return AutomaticAssistantFinalWriterResultV2Schema.parse({
          kind: 'committed',
          invocation: 'initial_owner',
          terminalReceipt: expectedReceipt,
          currentAuthority: 'active',
          eligibleFirstCommit: false,
        });
      }
      if (!commitAttempted) {
        if (executionError instanceof RollbackAutonomousPersonalAssistantFinalV4)
          return executionError.result;
        try {
          scopeCheck();
        } catch (error) {
          executionError = error;
        }
        return stopped(
          autonomousPersonalAssistantFinalKnownFailureReasonV4(executionError) ?? 'storage_error',
        );
      }
      if (!callbackReturned)
        return stopped(
          autonomousPersonalAssistantFinalKnownFailureReasonV4(executionError) ??
            (writeAttempted ? 'acknowledgement_unknown' : 'storage_error'),
        );
      // Candidate was returned but the driver did not acknowledge: one read-only recovery.
      return await readback();
    } finally {
      closeAutonomousPersonalAssistantFinalInvocationV4(this, ownedKey);
      closeAutonomousPersonalAssistantFinalInvocationV4(this, input);
    }
  }

  async getAutomaticCaptureOutcomeV2(
    input: AutomaticCaptureReadRequestV2,
  ): Promise<AutomaticCaptureReadResultV2> {
    const failed = (status: 'invalid_input' | 'unsupported_mode' | 'failed') =>
      AutomaticCaptureReadResultV2Schema.parse({
        version: 2,
        purpose: null,
        status,
        sourceId: null,
        sourcePersistence: status === 'invalid_input' ? 'not_persisted' : 'unknown',
        should_process: false,
        currentAuthority: 'not_evaluated',
        receiptSummary: null,
      });
    let request: AutomaticCaptureReadRequestV2;
    try {
      request = AutomaticCaptureReadRequestV2Schema.parse(
        cloneBoundedAutomaticCaptureJson(input, 'beginRequest'),
      );
    } catch {
      return failed('invalid_input');
    }
    const storeHash = neo4jAutomaticCaptureStoreHash(this.originalConfiguredUri, this.database);
    if (!this.initialized || !storeHash || request.role !== 'human')
      return failed('unsupported_mode');

    const session = this.getSession();
    try {
      const snapshot = await this.readAutomaticCaptureSnapshot(session);
      return projectHumanCaptureOutcomeV2(snapshot.graph, request, {
        storeHash,
        backendNow: snapshot.backendNow,
      });
    } catch {
      return failed('failed');
    } finally {
      await session.close();
    }
  }

  async cancelAutomaticCaptureV2(
    input: AutomaticCaptureAdminFenceRequestV2,
  ): Promise<AutomaticCaptureCancelInternalResultV2> {
    const resultSchema = AutomaticCaptureCancelInternalResultV2Schema;
    let request: AutomaticCaptureAdminFenceRequestV2;
    try {
      request = AutomaticCaptureAdminFenceRequestV2Schema.parse(
        cloneBoundedAutomaticCaptureJson(input, 'beginRequest'),
      );
    } catch {
      return resultSchema.parse({ kind: 'invalid_input', eligibleFirstCommit: false });
    }
    const storeHash = neo4jAutomaticCaptureStoreHash(this.originalConfiguredUri, this.database);
    if (!this.initialized || !storeHash || request.role !== 'human')
      return resultSchema.parse({ kind: 'unsupported_mode', eligibleFirstCommit: false });

    const session = this.getSession();
    let prepared: AutomaticHumanCaptureCancelPreparationV2;
    try {
      try {
        prepared = await this.executeWrite(session, async (tx) => {
          const graph = await this.graphInTransaction(tx, undefined, 'automatic_capture');
          if (graph.group_id === undefined) delete graph.group_id;
          // executeWrite acquires the shared writer lock before this callback;
          // query realtime only after the fresh graph read under that lock.
          const clock = await tx.run('RETURN datetime.realtime().epochMillis AS now');
          const epochMillis = cypherIntegerNumber(clock.records[0]?.get('now'));
          if (
            !Number.isSafeInteger(epochMillis) ||
            !Number.isFinite(new Date(epochMillis).getTime())
          ) {
            throw new Error('Engram automatic capture: backend_clock_invalid');
          }
          const candidate = prepareHumanCaptureCancelV2(graph, request, {
            storeHash,
            backendNow: new Date(epochMillis).toISOString(),
          });
          if (candidate.kind === 'decision') throw new RollbackAutomaticCaptureCancel(candidate);
          await this.writeExtractionDiff(tx, graph, candidate.graph);
          return candidate;
        });
      } catch (error) {
        if (error instanceof RollbackAutomaticCaptureCancel) {
          prepared = error.preparation;
        } else {
          throw error;
        }
      }
    } finally {
      await session.close();
    }

    return prepared.kind === 'prepared_cancel'
      ? resultSchema.parse({
          kind: 'cancelled',
          terminalReceipt: prepared.terminalReceipt,
          eligibleFirstCommit: false,
        })
      : resultSchema.parse({ ...prepared.decision, eligibleFirstCommit: false });
  }

  async resumeAutomaticCaptureV2(
    input: AutomaticCaptureAdminFenceRequestV2,
  ): Promise<AutomaticCaptureResumeInternalResultV2> {
    const resultSchema =
      this.automaticCaptureResultSchemas.AutomaticCaptureResumeInternalResultV2Schema;
    let request: AutomaticCaptureAdminFenceRequestV2;
    try {
      request = AutomaticCaptureAdminFenceRequestV2Schema.parse(
        cloneBoundedAutomaticCaptureJson(input, 'beginRequest'),
      );
    } catch {
      return resultSchema.parse({ kind: 'invalid_input' });
    }
    const storeHash = neo4jAutomaticCaptureStoreHash(this.originalConfiguredUri, this.database);
    if (!this.initialized || !storeHash || request.role !== 'human')
      return resultSchema.parse({ kind: 'unsupported_mode' });

    const session = this.getSession();
    try {
      // This coherent pre-read supplies a complete old operation for the private
      // resume scope. The authoritative transaction below rechecks it under lock.
      const snapshot = await this.readAutomaticCaptureSnapshot(session);
      const source = prepareHumanCaptureResumeSourceV2(snapshot.graph, request, { storeHash });
      if (source.kind === 'decision') return resultSchema.parse(source.decision);

      // The fresh token is allocated once outside every retriable transaction callback.
      const resume = this.automaticCaptureHandles.startResume(
        'human_turn_memory',
        source.resumeSource,
      );
      const transact = (acknowledgementOnly: boolean) =>
        this.executeWrite(session, async (tx) => {
          const graph = await this.graphInTransaction(tx, undefined, 'automatic_capture');
          if (graph.group_id === undefined) delete graph.group_id;
          const operation = graph.automatic_operations_v1?.operations.find(
            (item) => item.operationId === source.operation.operationId,
          );
          if (
            acknowledgementOnly &&
            !(
              operation?.version === 2 &&
              operation.state === 'leased' &&
              operation.generation === source.operation.generation + 1 &&
              operation.lease.token === resume.leaseToken &&
              operation.lease.claimKind === 'resume'
            )
          ) {
            throw new RollbackAutomaticCaptureResume(null);
          }

          // DB realtime is authoritative and sampled after the common writer
          // lock and current graph read, never from caller or transaction start.
          const clock = await tx.run('RETURN datetime.realtime().epochMillis AS now');
          const epochMillis = cypherIntegerNumber(clock.records[0]?.get('now'));
          if (
            !Number.isSafeInteger(epochMillis) ||
            !Number.isFinite(new Date(epochMillis).getTime())
          ) {
            throw new Error('Engram automatic capture: backend_clock_invalid');
          }
          const candidate = prepareHumanCaptureResumeV2(graph, request, {
            storeHash,
            backendNow: new Date(epochMillis).toISOString(),
            leaseToken: resume.leaseToken,
            previousOperation: source.operation,
          });

          if (acknowledgementOnly) {
            if (candidate.kind === 'prepared_resume' && candidate.writeRequired)
              throw new Error('Engram automatic capture: invalid_acknowledgement');
            throw new RollbackAutomaticCaptureResume(candidate);
          }
          if (candidate.kind === 'decision') throw new RollbackAutomaticCaptureResume(candidate);
          if (!candidate.writeRequired) throw new RollbackAutomaticCaptureResume(candidate);
          await this.writeExtractionDiff(tx, graph, candidate.graph);
          return candidate;
        });

      let prepared: AutomaticHumanCaptureResumePreparationV2 | null = null;
      try {
        try {
          prepared = await transact(false);
        } catch (error) {
          if (error instanceof RollbackAutomaticCaptureResume) {
            prepared = error.preparation;
          } else {
            // Recovery is read-only in effect and proves this exact private
            // resume token/generation. It never applies the transition twice.
            try {
              await transact(true);
            } catch (acknowledgementError) {
              if (acknowledgementError instanceof RollbackAutomaticCaptureResume)
                prepared = acknowledgementError.preparation;
            }
          }
        }
      } catch {
        throw new Error('Engram automatic capture: storage_error');
      }
      if (!prepared) throw new Error('Engram automatic capture: storage_error');
      if (prepared.kind === 'decision') return resultSchema.parse(prepared.decision);

      const leaseHandle = this.automaticCaptureHandles.recoverOrIssueResume(
        resume.scope,
        prepared.leaseFence,
      );
      if (!leaseHandle) return resultSchema.parse({ kind: 'fenced' });
      return resultSchema.parse({
        kind: 'resumed',
        purpose: 'human_turn_memory',
        sourceId: prepared.leaseFence.sourceId,
        operationId: prepared.leaseFence.operationId,
        leaseHandle,
      });
    } finally {
      await session.close();
    }
  }

  private async persistAutomaticCaptureBeginCandidate(
    tx: Pick<ManagedTransaction, 'run'>,
    before: GraphData,
    after: GraphData,
    source: EpisodicNode,
    backendNow: string,
    check: () => void,
  ): Promise<void> {
    check();
    await this.writeExtractionDiff(tx, before, after, check);
    check();

    const lockResult = await tx.run(
      `MERGE (lock:EpisodeGroupLock {group_id: $group_id})
       SET lock.sequence = coalesce(lock.sequence, 0) + 1,
           lock.updated_at = $updated_at
       RETURN lock.sequence AS sequence`,
      { group_id: source.group_id, updated_at: backendNow },
    );
    const sequenceValue = lockResult.records[0]?.get('sequence');
    const appendSequence = neo4j.isInt(sequenceValue)
      ? sequenceValue.toNumber()
      : Number(sequenceValue);
    if (!Number.isSafeInteger(appendSequence) || appendSequence < 1)
      throw new Error('Engram automatic capture: append_sequence_invalid');

    await tx.run('CREATE (ep:Episode) SET ep += $props', {
      props: {
        ...source,
        attributes: JSON.stringify(source.attributes),
        append_sequence: appendSequence,
        source_dedup_key: this.sourceDedupKey(source),
        idempotency_dedup_key: this.idempotencyDedupKey(source),
      },
    });
    if (source.previous_episode_uuid) {
      await tx.run(
        `MATCH (prev:Episode {uuid: $prevUuid})
         MATCH (curr:Episode {uuid: $currUuid})
         CREATE (prev)-[:NEXT_EPISODE]->(curr)`,
        { prevUuid: source.previous_episode_uuid, currUuid: source.uuid },
      );
    }
    check();
  }

  supportsDurableExtraction(): boolean {
    return true;
  }

  private async graphInTransaction(
    tx: Pick<ManagedTransaction, 'run'>,
    groupId?: string,
    mode: 'legacy' | 'automatic_capture' = 'legacy',
    read?: CompositionalNativeReadV3,
    requireSource4 = false,
  ): Promise<GraphData> {
    read?.check();
    const registered = await this.readAutonomousSource4FormatInTransaction(tx, read);
    read?.check();
    if (requireSource4 && !registered)
      throw new Error('Engram automatic ledger: unregistered_native_format');
    const graph = await this.readNativeGraphDataInTransaction(tx, groupId, mode, read);
    read?.check();
    if (
      !registered &&
      (graph.episodes.some(hasAutonomousSourceOwnership) ||
        graph.automatic_operations_v1?.operations.some((operation) => operation.version === 4))
    ) {
      throw new Error('Engram automatic ledger: unregistered_native_format');
    }
    return graph;
  }

  /** Structural DATA only; native format enrollment is checked by the caller. */
  private async readNativeGraphDataInTransaction(
    tx: Pick<ManagedTransaction, 'run'>,
    groupId?: string,
    mode: 'legacy' | 'automatic_capture' = 'legacy',
    read?: CompositionalNativeReadV3,
  ): Promise<GraphData> {
    const check = () => read?.check();
    const chargeRows = (rows: QueryResult['records'], key: string) => {
      if (!read) return;
      for (const row of rows) {
        check();
        read.charge(row.get(key).properties);
      }
      check();
    };
    check();
    read?.begin?.();
    check();
    let captureMode = mode === 'automatic_capture';
    const where = groupId ? ' WHERE e.group_id = $group' : '';
    const params = groupId ? { group: groupId } : {};
    const entities = await tx.run(`MATCH (e:Entity)${where} RETURN e LIMIT 100001`, params);
    check();
    chargeRows(entities.records, 'e');
    const edges = await tx.run(
      `MATCH ()-[r:RELATES_TO]->()${groupId ? ' WHERE r.group_id = $group' : ''} RETURN r LIMIT 100001`,
      params,
    );
    check();
    chargeRows(edges.records, 'r');
    const episodeOrder =
      read?.episodeOrder === 'recent'
        ? 'coalesce(e.append_sequence, 0) ASC, e.created_at ASC, e.uuid ASC'
        : 'e.created_at ASC, coalesce(e.append_sequence, 0) ASC, e.uuid ASC';
    const episodes = await tx.run(
      `MATCH (e:Episode)${where} RETURN e ORDER BY ${episodeOrder} LIMIT 100001`,
      params,
    );
    check();
    chargeRows(episodes.records, 'e');
    if (entities.records.length + edges.records.length + episodes.records.length > 100000)
      throw new Error('Engram queue: snapshot_limit');
    const epoch = await tx.run(
      `MATCH (lock:EngramStoreLock {id:'extraction-v1'})
       RETURN lock.epoch AS epoch, lock.automatic_operations_v1_present AS automatic_operations_present`,
    );
    check();
    const epochValue = epoch.records[0]?.get('epoch') as string | undefined;
    const rootPresent = epoch.records[0]?.get('automatic_operations_present') === true;
    read?.charge({ epoch: epochValue ?? null, automatic_operations_present: rootPresent });
    const operationRecords = await tx.run(
      `MATCH (op:AutomaticOperation)
       ${groupId ? 'WHERE op.namespace = $group OR EXISTS { MATCH (source:Episode) WHERE source.uuid=op.source_id AND source.group_id=$group }' : ''}
       RETURN op.operation_id AS operation_id, op.namespace AS namespace,
              op.source_id AS source_id, op.store_hash AS store_hash,
              op.role AS role, op.record_json AS record_json
       ORDER BY op.position, op.operation_id
       LIMIT 100001`,
      params,
    );
    check();
    if (operationRecords.records.length > 100000) throw new Error('Engram queue: snapshot_limit');
    const operations = operationRecords.records.map((record) => {
      check();
      if (read) {
        read.charge({
          operation_id: record.get('operation_id'),
          namespace: record.get('namespace'),
          source_id: record.get('source_id'),
          store_hash: record.get('store_hash'),
          role: record.get('role'),
          record_json: record.get('record_json'),
        });
      }
      let raw: unknown;
      const recordJson = record.get('record_json');
      if (typeof recordJson !== 'string' || Buffer.byteLength(recordJson, 'utf8') > 32 * 1024)
        throw new Error('Engram automatic ledger: invalid_native_record');
      try {
        raw = JSON.parse(recordJson);
      } catch {
        throw new Error('Engram automatic ledger: invalid_native_record');
      }
      const parsed = StoredAutomaticOperationSchema.safeParse(raw);
      if (
        !parsed.success ||
        parsed.data.operationId !== record.get('operation_id') ||
        parsed.data.identity.namespace !== record.get('namespace') ||
        parsed.data.identity.sourceId !== record.get('source_id') ||
        parsed.data.identity.storeHash !== record.get('store_hash') ||
        parsed.data.identity.role !== record.get('role')
      ) {
        throw new Error('Engram automatic ledger: invalid_native_record');
      }
      return parsed.data;
    });
    const ledger =
      operations.length > 0 || (rootPresent && groupId === undefined)
        ? AutomaticLedgerSchema.safeParse({ version: 1, operations })
        : null;
    if (ledger && !ledger.success)
      throw new Error('Engram automatic ledger: invalid_native_record');
    captureMode ||=
      operations.some(
        (operation) =>
          operation.version === 2 || operation.version === 3 || operation.version === 4,
      ) ||
      episodes.records.some(
        (record) =>
          inspectNativeCaptureAttributeValue(record.get('e').properties.attributes) === 'protected',
      );
    const base = {
      ...(epochValue ? { metadata: { extraction_epoch: epochValue } } : {}),
      version: CURRENT_GRAPH_DATA_VERSION,
      exported_at: nowIso(),
      group_id: groupId,
      entities: entities.records.map((record) => {
        check();
        return this.recordToEntity(record.get('e').properties, captureMode);
      }),
      edges: edges.records.map((record) => {
        check();
        return this.recordToEdge(record.get('r').properties, captureMode);
      }),
      episodes: episodes.records.map((record) => {
        check();
        return this.recordToEpisode(record.get('e').properties, captureMode);
      }),
    };
    if (captureMode && base.group_id === undefined) delete base.group_id;
    const data: GraphData = ledger?.success
      ? { ...base, automatic_operations_v1: ledger.data }
      : base;
    if (captureMode) {
      check();
      const bounded = parseLosslessAutomaticCaptureGraph(data);
      check();
      assertAutomaticLedgerSourceIntegrity(bounded);
      if (bounded.automatic_operations_v1) {
        bounded.automatic_operations_v1 = immutableAutomaticLedgerSnapshot(
          bounded.automatic_operations_v1,
        );
        if (Buffer.byteLength(canonical(bounded)) > 100 * 1024 * 1024)
          throw new Error('Engram queue: snapshot_limit');
      }
      return bounded;
    }
    if (data.automatic_operations_v1) {
      const bounded = GraphDataSchema.parse(data);
      bounded.automatic_operations_v1 = immutableAutomaticLedgerSnapshot(
        bounded.automatic_operations_v1!,
      );
      assertAutomaticLedgerSourceIntegrity(bounded);
      if (Buffer.byteLength(canonical(bounded)) > 100 * 1024 * 1024)
        throw new Error('Engram queue: snapshot_limit');
      return bounded;
    }
    if (Buffer.byteLength(canonical(data)) > 100 * 1024 * 1024)
      throw new Error('Engram queue: snapshot_limit');
    return data;
  }

  async readExtractionSnapshot(groupId?: string): Promise<GraphData> {
    const session = this.getSession();
    let guardLifetime: ReturnType<typeof createOrdinaryAutonomousPersonalRecordGuardV4> | undefined;
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const result = await session.executeRead(async (tx) => {
          const revision = async () => {
            const r = await tx.run(
              `MATCH (lock:EngramStoreLock {id: 'extraction-v1'}) RETURN coalesce(lock.revision,0) AS revision, lock.epoch AS epoch`,
            );
            return (
              (r.records[0]?.get('revision')?.toString() ?? '0') +
              ':' +
              (r.records[0]?.get('epoch') ?? 'initial')
            );
          };
          const before = await revision();
          try {
            const registered = await this.readAutonomousSource4FormatInTransaction(tx);
            let graph: GraphData;
            if (registered) {
              guardLifetime ??= createOrdinaryAutonomousPersonalRecordGuardV4();
              const complete = await this.assertEnrolledAutonomousPersonalRecordsInTransaction(
                tx,
                guardLifetime,
              );
              if (groupId === undefined) graph = complete;
              else {
                const projected: GraphData = {
                  ...complete,
                  group_id: groupId,
                  entities: complete.entities.filter((row) => row.group_id === groupId),
                  edges: complete.edges.filter((row) => row.group_id === groupId),
                  episodes: complete.episodes.filter((row) => row.group_id === groupId),
                };
                const operations = complete.automatic_operations_v1?.operations.filter(
                  (operation) => operation.identity.namespace === groupId,
                );
                if (operations && operations.length > 0) {
                  projected.automatic_operations_v1 = immutableAutomaticLedgerSnapshot({
                    version: 1,
                    operations,
                  });
                } else {
                  delete projected.automatic_operations_v1;
                }
                graph = projected;
              }
            } else {
              graph = await this.graphInTransaction(tx, groupId);
            }
            return before === (await revision()) ? graph : null;
          } catch (error) {
            // A concurrent first enrollment can change format and rows between
            // reads. Only a stable-revision validation error is authoritative.
            if (before !== (await revision())) return null;
            throw error;
          }
        });
        if (result) return result;
      }
      throw new Error('Engram queue: concurrent_snapshot');
    } finally {
      await session.close();
    }
  }

  async readAutomaticClaimContext(
    groupId: string,
    edgeId: string,
    scope: AutomaticClaimReadScope,
  ): Promise<AutomaticClaimReadResult> {
    if (
      typeof groupId !== 'string' ||
      groupId.length === 0 ||
      groupId.length > 128 ||
      typeof edgeId !== 'string' ||
      edgeId.length === 0 ||
      edgeId.length > 128
    ) {
      return automaticClaimResult('invalid', 'invalid_context');
    }
    if (!canUseAutomaticClaimReadScope(scope))
      return automaticClaimResult('deferred', 'budget_exhausted');

    const session = this.getSession();
    let callbackReservations = 0;
    try {
      for (let attempt = 0; attempt < AUTOMATIC_CLAIM_READ_MAX_RETRIES; attempt += 1) {
        type LocatedRows = {
          readonly coherent: boolean;
          readonly lockPresent: boolean;
          readonly budgetExhausted: boolean;
          readonly fixedResult: AutomaticClaimReadResult | null;
          readonly edgeRows: Array<{
            readonly edge: unknown;
            readonly subject: unknown;
            readonly value: unknown;
            readonly validEndpoints: boolean;
            readonly tooLarge: boolean;
            readonly rowChars: number;
          }>;
          readonly sourceRows: Array<{
            readonly source: unknown;
            readonly tooLarge: boolean;
            readonly rowChars: number;
          }>;
          readonly operationCount: number;
          readonly operation: unknown;
          readonly operationTooLarge: boolean;
          readonly operationBudgetLimited: boolean;
        };

        let located: LocatedRows;
        try {
          located = await session.executeRead(async (tx): Promise<LocatedRows> => {
            const emptyRows = (
              budgetExhausted: boolean,
              fixedResult: AutomaticClaimReadResult | null = null,
            ): LocatedRows => ({
              coherent: false,
              lockPresent: false,
              budgetExhausted,
              fixedResult,
              edgeRows: [],
              sourceRows: [],
              operationCount: 0,
              operation: null,
              operationTooLarge: false,
              operationBudgetLimited: false,
            });

            // Neo4j can replay this callback after a transient failure. Reserve the attempt and
            // four hydration units inside it, before the first query, so replay cannot reset scope.
            if (
              callbackReservations >= AUTOMATIC_CLAIM_READ_MAX_RETRIES ||
              !beginAutomaticClaimReadAttempt(scope) ||
              !canUseAutomaticClaimReadScope(scope)
            ) {
              return emptyRows(true);
            }
            callbackReservations += 1;
            let contextBytesUsed = 0;

            const maxQueryChars = (staticLimit: number): number | null => {
              const remaining = getAutomaticClaimReadScopeRemaining(scope);
              if (!remaining || remaining.deadlineRemainingMs <= 0) return null;
              const allowance = Math.min(
                remaining.contextBytesRemaining,
                AUTOMATIC_CLAIM_CONTEXT_BYTE_LIMIT - contextBytesUsed,
              );
              return Math.min(
                staticLimit,
                Math.max(
                  0,
                  Math.floor(
                    (allowance - AUTOMATIC_CLAIM_QUERY_OVERHEAD_BYTES) /
                      AUTOMATIC_CLAIM_JSON_MAX_BYTES_PER_CHARACTER,
                  ),
                ),
              );
            };
            const accountRows = (rows: unknown): 'ok' | 'budget' | 'too_large' => {
              let serialized: string | undefined;
              try {
                // These are plain maps made by the fixed Cypher projections below; no arbitrary
                // node/relationship property maps or caller objects enter this accounting path.
                serialized = JSON.stringify(rows);
              } catch {
                return 'too_large';
              }
              if (serialized === undefined) return 'too_large';
              const bytes = Buffer.byteLength(serialized, 'utf8');
              const remaining = getAutomaticClaimReadScopeRemaining(scope);
              if (!remaining || !canUseAutomaticClaimReadScope(scope)) return 'budget';
              const contextRemaining = Math.max(
                0,
                AUTOMATIC_CLAIM_CONTEXT_BYTE_LIMIT - contextBytesUsed,
              );
              const available = Math.min(remaining.contextBytesRemaining, contextRemaining);
              const charge = Math.min(bytes, available);
              if (!chargeAutomaticClaimContextBytes(scope, charge)) return 'budget';
              contextBytesUsed += charge;
              if (bytes > remaining.contextBytesRemaining) return 'budget';
              if (bytes > contextRemaining) return 'too_large';
              return canUseAutomaticClaimReadScope(scope) ? 'ok' : 'budget';
            };

            const accountingResult = (accounting: 'ok' | 'budget' | 'too_large') =>
              accounting === 'budget'
                ? emptyRows(true)
                : accounting === 'too_large'
                  ? emptyRows(false, automaticClaimResult('invalid', 'context_too_large'))
                  : null;

            const revision = async (): Promise<{ value: string; present: boolean }> => {
              const result = await tx.run(
                `OPTIONAL MATCH (lock:EngramStoreLock {id: 'extraction-v1'})
                 RETURN lock IS NOT NULL AS present,
                        coalesce(lock.revision, 0) AS revision,
                        coalesce(lock.epoch, 'initial') AS epoch`,
              );
              const row = result.records[0];
              const present = row?.get('present') === true;
              const revisionValue = row?.get('revision');
              const epochValue = row?.get('epoch');
              return {
                present,
                value: `${revisionValue?.toString?.() ?? '0'}:${epochValue?.toString?.() ?? 'initial'}`,
              };
            };

            const before = await revision();
            const edgeCharLimit = maxQueryChars(AUTOMATIC_CLAIM_ROW_CHAR_LIMIT);
            if (edgeCharLimit === null) return emptyRows(true);
            const edgeQuery = await tx.run(
              `MATCH (edgeStart)-[edge:RELATES_TO]->(edgeEnd)
               WHERE edge.uuid = $edgeId AND edge.group_id = $groupId
               WITH edgeStart, edge, edgeEnd,
                    ${cypherEdgeCharCount('edge')} +
                    ${cypherEntityCharCount('edgeStart')} +
                    ${cypherEntityCharCount('edgeEnd')} AS row_chars,
                    (edgeStart:Entity AND edgeEnd:Entity AND
                     edge.source_node_uuid = edgeStart.uuid AND
                     edge.target_node_uuid = edgeEnd.uuid AND
                     edgeStart.group_id = $groupId AND edgeEnd.group_id = $groupId) AS valid_endpoints
               RETURN row_chars AS row_chars,
                      row_chars > $maxChars AS too_large,
                      valid_endpoints AS valid_endpoints,
                      CASE WHEN valid_endpoints AND row_chars <= $maxChars THEN {
                        uuid: edge.uuid, group_id: edge.group_id,
                        source_node_uuid: edge.source_node_uuid, target_node_uuid: edge.target_node_uuid,
                        name: edge.name, fact: edge.fact, fact_embedding: edge.fact_embedding,
                        episodes: edge.episodes, valid_at: edge.valid_at, invalid_at: edge.invalid_at,
                        expired_at: edge.expired_at, attributes: edge.attributes,
                        created_at: edge.created_at, updated_at: edge.updated_at
                      } ELSE null END AS edge,
                      CASE WHEN NOT valid_endpoints OR row_chars > $maxChars THEN null ELSE {
                        uuid: edgeStart.uuid, name: edgeStart.name, group_id: edgeStart.group_id,
                        summary: edgeStart.summary, entity_type: edgeStart.entity_type,
                        name_embedding: edgeStart.name_embedding, attributes: edgeStart.attributes,
                        created_at: edgeStart.created_at, updated_at: edgeStart.updated_at
                      } END AS subject,
                      CASE WHEN NOT valid_endpoints OR row_chars > $maxChars THEN null ELSE {
                        uuid: edgeEnd.uuid, name: edgeEnd.name, group_id: edgeEnd.group_id,
                        summary: edgeEnd.summary, entity_type: edgeEnd.entity_type,
                        name_embedding: edgeEnd.name_embedding, attributes: edgeEnd.attributes,
                        created_at: edgeEnd.created_at, updated_at: edgeEnd.updated_at
                      } END AS value
               LIMIT 2`,
              { edgeId, groupId, maxChars: edgeCharLimit },
            );
            const edgeRows = edgeQuery.records.map((record) => ({
              edge: record.get('edge'),
              subject: record.get('subject'),
              value: record.get('value'),
              validEndpoints: record.get('valid_endpoints') === true,
              tooLarge: record.get('too_large') === true,
              rowChars: cypherIntegerNumber(record.get('row_chars')),
            }));
            const edgeAccount = accountRows(edgeRows);
            const edgeAccountingResult = accountingResult(edgeAccount);
            if (edgeAccountingResult) return edgeAccountingResult;

            if (edgeRows.length === 1 && edgeRows[0].tooLarge) {
              const only = edgeRows[0];
              const budgetLimited =
                only.rowChars <= AUTOMATIC_CLAIM_ROW_CHAR_LIMIT &&
                edgeCharLimit < AUTOMATIC_CLAIM_ROW_CHAR_LIMIT;
              return budgetLimited
                ? emptyRows(true)
                : emptyRows(false, automaticClaimResult('invalid', 'context_too_large'));
            }
            if (edgeRows.length === 1 && !edgeRows[0].validEndpoints)
              return emptyRows(false, automaticClaimResult('invalid', 'invalid_context'));

            let sourceRows: Array<{ source: unknown; tooLarge: boolean; rowChars: number }> = [];
            let operationCount = 0;
            let operation: unknown = null;
            let operationTooLarge = false;
            let operationBudgetLimited = false;
            let sourceId: string | null = null;
            if (
              edgeRows.length === 1 &&
              edgeRows[0].validEndpoints &&
              !edgeRows[0].tooLarge &&
              edgeRows[0].edge
            ) {
              try {
                const edge = this.recordToEdge(edgeRows[0].edge as Record<string, unknown>);
                const claim = AutomaticClaimMetadataSchema.safeParse(
                  edge.attributes.engram_claim_v1,
                );
                if (claim.success) sourceId = claim.data.sourceId;
              } catch {
                // The bounded edge will be reported as an invalid context after the revision check.
              }
            }

            if (sourceId) {
              const sourceCharLimit = maxQueryChars(AUTOMATIC_CLAIM_SOURCE_CHAR_LIMIT);
              if (sourceCharLimit === null) return emptyRows(true);
              const sourceQuery = await tx.run(
                `MATCH (source:Episode {uuid: $sourceId, group_id: $groupId})
                 WITH source, ${cypherEpisodeCharCount('source')} AS row_chars
                 RETURN row_chars AS row_chars,
                        row_chars > $maxChars AS too_large,
                        CASE WHEN row_chars <= $maxChars THEN {
                          uuid: source.uuid, group_id: source.group_id, content: source.content,
                          role: source.role, source_type: source.source_type,
                          reference_time: source.reference_time,
                          previous_episode_uuid: source.previous_episode_uuid,
                          created_at: source.created_at, updated_at: source.updated_at,
                          source_message_id: source.source_message_id,
                          idempotency_key: source.idempotency_key,
                          conversation_id: source.conversation_id, sender_id: source.sender_id,
                          sender_name: source.sender_name, episode_kind: source.episode_kind,
                          quoted_message_id: source.quoted_message_id,
                          trust_level: source.trust_level, confidence: source.confidence,
                          review_status: source.review_status,
                          source_workflow_id: source.source_workflow_id,
                          source_execution_id: source.source_execution_id,
                          attributes: source.attributes
                        } ELSE null END AS source
                 LIMIT 2`,
                { sourceId, groupId, maxChars: sourceCharLimit },
              );
              sourceRows = sourceQuery.records.map((record) => ({
                source: record.get('source'),
                tooLarge: record.get('too_large') === true,
                rowChars: cypherIntegerNumber(record.get('row_chars')),
              }));
              const sourceAccount = accountRows(sourceRows);
              const sourceAccountingResult = accountingResult(sourceAccount);
              if (sourceAccountingResult) return sourceAccountingResult;
              if (sourceRows.length === 1 && sourceRows[0].tooLarge) {
                const only = sourceRows[0];
                const budgetLimited =
                  only.rowChars <= AUTOMATIC_CLAIM_SOURCE_CHAR_LIMIT &&
                  sourceCharLimit < AUTOMATIC_CLAIM_SOURCE_CHAR_LIMIT;
                return budgetLimited
                  ? emptyRows(true)
                  : emptyRows(false, automaticClaimResult('invalid', 'context_too_large'));
              }

              const operationCharLimit = maxQueryChars(AUTOMATIC_CLAIM_OPERATION_CHAR_LIMIT);
              if (operationCharLimit === null) return emptyRows(true);
              const operationQuery = await tx.run(
                `MATCH (operation:AutomaticOperation)
                 WHERE operation.namespace = $groupId AND operation.source_id = $sourceId
                 WITH operation
                 LIMIT 2
                 WITH collect(operation) AS operations
                 RETURN size(operations) AS operation_count,
                        CASE WHEN size(operations) = 1 THEN {
                          operation_id: operations[0].operation_id,
                          namespace: operations[0].namespace,
                          source_id: operations[0].source_id,
                          store_hash: operations[0].store_hash,
                          role: operations[0].role,
                          record_json_chars: size(coalesce(operations[0].record_json, '')),
                          record_json: CASE
                            WHEN size(coalesce(operations[0].record_json, '')) <= $maxChars
                            THEN operations[0].record_json ELSE null END,
                          too_large: size(coalesce(operations[0].record_json, '')) > $maxChars
                        } ELSE null END AS operation`,
                { sourceId, groupId, maxChars: operationCharLimit },
              );
              const operationRecord = operationQuery.records[0];
              operationCount = cypherIntegerNumber(operationRecord?.get('operation_count'));
              operation = operationRecord?.get('operation') ?? null;
              const recordJsonChars =
                operation !== null && typeof operation === 'object'
                  ? cypherIntegerNumber((operation as Record<string, unknown>).record_json_chars)
                  : 0;
              operationTooLarge =
                operationCount === 1 && recordJsonChars > AUTOMATIC_CLAIM_OPERATION_CHAR_LIMIT;
              operationBudgetLimited =
                operationCount === 1 &&
                recordJsonChars <= AUTOMATIC_CLAIM_OPERATION_CHAR_LIMIT &&
                operationCharLimit < AUTOMATIC_CLAIM_OPERATION_CHAR_LIMIT &&
                recordJsonChars > operationCharLimit;
              const operationAccount = accountRows({ operationCount, operation });
              const operationAccountingResult = accountingResult(operationAccount);
              if (operationAccountingResult) return operationAccountingResult;
              if (operationBudgetLimited) return emptyRows(true);
            }

            const after = await revision();
            return {
              coherent: before.value === after.value,
              lockPresent: before.present && after.present,
              budgetExhausted: false,
              fixedResult: null,
              edgeRows,
              sourceRows,
              operationCount,
              operation,
              operationTooLarge,
              operationBudgetLimited,
            };
          });
        } catch {
          if (!canUseAutomaticClaimReadScope(scope))
            return automaticClaimResult('deferred', 'budget_exhausted');
          return automaticClaimResult('invalid', 'invalid_context');
        }

        if (located.budgetExhausted || !canUseAutomaticClaimReadScope(scope))
          return automaticClaimResult('deferred', 'budget_exhausted');
        if (located.fixedResult) return located.fixedResult;
        if (!located.coherent) continue;
        if (!located.lockPresent) return automaticClaimResult('invalid', 'invalid_context');
        if (located.edgeRows.length === 0) return automaticClaimResult('invalid', 'missing_edge');
        if (located.edgeRows.length !== 1)
          return automaticClaimResult('invalid', 'invalid_context');
        const selected = located.edgeRows[0];
        if (selected.tooLarge) return automaticClaimResult('invalid', 'context_too_large');
        if (!selected.validEndpoints) return automaticClaimResult('invalid', 'invalid_context');
        if (!selected.edge) return automaticClaimResult('invalid', 'invalid_context');
        if (located.sourceRows.some((row) => row.tooLarge))
          return automaticClaimResult('invalid', 'context_too_large');
        if (located.sourceRows.length > 1)
          return automaticClaimResult('invalid', 'invalid_context');
        if (located.operationCount > 1)
          return automaticClaimResult('ambiguous', 'ambiguous_operation');
        if (located.operationTooLarge) return automaticClaimResult('invalid', 'invalid_operation');
        if (located.operationBudgetLimited)
          return automaticClaimResult('deferred', 'budget_exhausted');

        try {
          const edge = EntityEdgeSchema.parse(
            this.recordToEdge(selected.edge as Record<string, unknown>),
          );
          const subject = selected.subject
            ? EntityNodeSchema.parse(
                this.recordToEntity(selected.subject as Record<string, unknown>),
              )
            : null;
          const value = selected.value
            ? EntityNodeSchema.parse(this.recordToEntity(selected.value as Record<string, unknown>))
            : null;
          const sourceRow = located.sourceRows[0]?.source;
          const source = sourceRow
            ? EpisodicNodeSchema.parse(this.recordToEpisode(sourceRow as Record<string, unknown>))
            : null;
          let operations: StoredAutomaticOperation[] = [];
          if (located.operationCount === 1) {
            if (!located.operation || typeof located.operation !== 'object')
              return automaticClaimResult('invalid', 'invalid_operation');
            const row = located.operation as Record<string, unknown>;
            if (typeof row.record_json !== 'string')
              return automaticClaimResult('invalid', 'invalid_operation');
            let decoded: unknown;
            try {
              decoded = JSON.parse(row.record_json);
            } catch {
              return automaticClaimResult('invalid', 'invalid_operation');
            }
            const parsed = StoredAutomaticOperationSchema.safeParse(decoded);
            if (
              !parsed.success ||
              parsed.data.operationId !== row.operation_id ||
              parsed.data.identity.namespace !== row.namespace ||
              parsed.data.identity.sourceId !== row.source_id ||
              parsed.data.identity.storeHash !== row.store_hash ||
              parsed.data.identity.role !== row.role
            ) {
              return automaticClaimResult('invalid', 'invalid_operation');
            }
            operations = [parsed.data];
          }

          const partialGraph = GraphDataSchema.parse({
            version: CURRENT_GRAPH_DATA_VERSION,
            exported_at: nowIso(),
            group_id: groupId,
            entities: [subject, value]
              .filter((item): item is EntityNode => item !== null)
              .filter(
                (item, index, records) =>
                  records.findIndex((candidate) => candidate.uuid === item.uuid) === index,
              ),
            edges: [edge],
            episodes: source ? [source] : [],
            automatic_operations_v1: { version: 1, operations },
          });
          const projected = projectAutomaticClaimReadContextWithUsage(
            partialGraph,
            groupId,
            edgeId,
          );
          if (!canUseAutomaticClaimReadScope(scope))
            return automaticClaimResult('deferred', 'budget_exhausted');
          return AutomaticClaimReadResultSchema.parse(projected.result);
        } catch {
          return automaticClaimResult('invalid', 'invalid_context');
        }
      }
      return automaticClaimResult('deferred', 'snapshot_changed');
    } finally {
      await session.close();
    }
  }

  /** Write only changed records; deterministic identities survive driver transaction retries. */
  private async writeExtractionDiff(
    tx: Pick<ManagedTransaction, 'run'>,
    before: GraphData,
    after: GraphData,
    check: () => void = () => {},
  ): Promise<void> {
    check();
    if (before.automatic_operations_v1 && !after.automatic_operations_v1) {
      throw new Error('Engram automatic ledger: native_root_missing');
    }
    const afterHasAutonomousSource4 =
      after.episodes.some(
        (episode) =>
          Object.prototype.hasOwnProperty.call(
            episode.attributes,
            AUTONOMOUS_CAPTURE_V4_OWNER_ATTRIBUTE,
          ) ||
          Object.prototype.hasOwnProperty.call(
            episode.attributes,
            AUTONOMOUS_CAPTURE_V3_ENVELOPE_ATTRIBUTE,
          ),
      ) ||
      (after.automatic_operations_v1?.operations.some((operation) => operation.version === 4) ??
        false);
    if (after.automatic_operations_v1 || afterHasAutonomousSource4) {
      const bounded = GraphDataSchema.parse(after);
      assertAutomaticLedgerSourceIntegrity(bounded);
      check();
    }

    const index = <T extends { uuid: string }>(rows: T[]): Map<string, T> => {
      const result = new Map<string, T>();
      for (const row of rows) {
        check();
        // Preserve the prior first-match behavior for legacy inputs.
        if (!result.has(row.uuid)) result.set(row.uuid, row);
      }
      return result;
    };
    const entities = index(before.entities);
    const edges = index(before.edges);
    const episodes = index(before.episodes);

    for (const entity of after.entities) {
      check();
      const prior = entities.get(entity.uuid);
      const unchanged = prior && canonical(prior) === canonical(entity);
      check();
      if (unchanged) continue;
      await tx.run(`MERGE (e:Entity {uuid:$uuid}) SET e += $props`, {
        uuid: entity.uuid,
        props: { ...entity, attributes: JSON.stringify(entity.attributes) },
      });
      check();
    }
    for (const edge of after.edges) {
      check();
      const prior = edges.get(edge.uuid);
      const unchanged = prior && canonical(prior) === canonical(edge);
      check();
      if (unchanged) continue;
      await tx.run(
        `MATCH (a:Entity {uuid:$source}) MATCH (b:Entity {uuid:$target})
        MERGE (a)-[r:RELATES_TO {uuid:$uuid}]->(b) SET r += $props`,
        {
          source: edge.source_node_uuid,
          target: edge.target_node_uuid,
          uuid: edge.uuid,
          props: { ...edge, attributes: JSON.stringify(edge.attributes) },
        },
      );
      check();
    }
    for (const ep of after.episodes) {
      check();
      const prior = episodes.get(ep.uuid);
      const changed = prior && canonical(prior.attributes) !== canonical(ep.attributes);
      check();
      if (changed) {
        await tx.run('MATCH (ep:Episode {uuid:$uuid}) SET ep.attributes=$attributes', {
          uuid: ep.uuid,
          attributes: JSON.stringify(ep.attributes),
        });
        check();
      }
    }

    const previousOperations = before.automatic_operations_v1?.operations ?? [];
    const nextOperations = after.automatic_operations_v1?.operations ?? [];
    const nextById = new Map<string, (typeof nextOperations)[number]>();
    for (const operation of nextOperations) {
      check();
      nextById.set(operation.operationId, operation);
    }
    for (const prior of previousOperations) {
      check();
      if (!nextById.has(prior.operationId)) {
        throw new Error('Engram automatic ledger: operation_delete_forbidden');
      }
    }
    const previousById = new Map<string, (typeof previousOperations)[number]>();
    for (const operation of previousOperations) {
      check();
      previousById.set(operation.operationId, operation);
    }
    for (const [position, operation] of nextOperations.entries()) {
      check();
      const prior = previousById.get(operation.operationId);
      const unchanged = prior && canonical(prior) === canonical(operation);
      check();
      if (unchanged) continue;
      await tx.run(
        `MERGE (op:AutomaticOperation {operation_id:$operation_id})
         SET op.store_hash=$store_hash, op.namespace=$namespace, op.source_id=$source_id,
             op.role=$role, op.position=$position, op.record_json=$record_json`,
        {
          position,
          operation_id: operation.operationId,
          store_hash: operation.identity.storeHash,
          namespace: operation.identity.namespace,
          source_id: operation.identity.sourceId,
          role: operation.identity.role,
          record_json: JSON.stringify(operation),
        },
      );
      check();
    }
    if (after.automatic_operations_v1) {
      check();
      await tx.run(
        `MATCH (lock:EngramStoreLock {id:'extraction-v1'})
         SET lock.automatic_operations_v1_present=true`,
      );
      check();
    }
  }

  async appendEpisodesWithExtraction(
    inputs: CreateEpisodicNode[],
    eligible: number[],
    binding: QueueBinding,
    limits: QueueLimits,
  ): Promise<{ results: AppendEpisodeResult[]; jobs: ExtractionJob[]; queue: QueueStats }> {
    return this.appendEpisodesWithExtractionInternal(inputs, eligible, binding, limits, false);
  }

  async appendAutomaticEpisodesWithExtraction(
    inputs: CreateEpisodicNode[],
    eligible: number[],
    binding: QueueBinding,
    limits: QueueLimits,
  ): Promise<{ results: AppendEpisodeResult[]; jobs: ExtractionJob[]; queue: QueueStats }> {
    return this.appendEpisodesWithExtractionInternal(inputs, eligible, binding, limits, true);
  }

  private async appendEpisodesWithExtractionInternal(
    inputs: CreateEpisodicNode[],
    eligible: number[],
    binding: QueueBinding,
    limits: QueueLimits,
    allowTrustedAutomatic: boolean,
  ): Promise<{ results: AppendEpisodeResult[]; jobs: ExtractionJob[]; queue: QueueStats }> {
    if (
      !inputs.length ||
      inputs.length > 1000 ||
      inputs.some(
        (ep) =>
          ep.group_id !== inputs[0].group_id || ep.attributes?.[QUEUE_ATTRIBUTE] !== undefined,
      )
    )
      throw new Error('Engram queue: invalid_batch');
    for (const input of inputs) {
      assertNoReservedAutonomousPersonalRow(input);
      assertAutomaticEpisodeTrustedPath(input, allowTrustedAutomatic);
    }
    const invocation = generateUuid();
    const prepared = inputs.map((input, index) => ({
      uuid: generateUuid(),
      parsed: CreateEpisodicNodeSchema.parse(
        allowTrustedAutomatic
          ? prepareAutomaticEpisodeInput({
              ...input,
              idempotency_key: input.idempotency_key ?? `queue-write:${invocation}:${index}`,
            })
          : {
              ...input,
              idempotency_key: input.idempotency_key ?? `queue-write:${invocation}:${index}`,
            },
      ),
      auto: !Object.prototype.hasOwnProperty.call(input, 'previous_episode_uuid'),
    }));
    const session = this.getSession();
    try {
      return await this.executeWrite(session, async (tx) => {
        if (
          allowTrustedAutomatic &&
          prepared.some(
            ({ parsed }) =>
              Object.prototype.hasOwnProperty.call(parsed.attributes, SOURCE_ENVELOPE_ATTRIBUTE) ||
              Object.prototype.hasOwnProperty.call(parsed.attributes, WRITE_OWNER_ATTRIBUTE),
          )
        ) {
          const graph = await this.graphInTransaction(tx);
          for (const item of prepared) assertAutomaticEpisodeBinding(graph, item.parsed);
        }
        await this.lockEpisodeGroup(tx, inputs[0].group_id);
        const sequenceResult = await tx.run(
          `MATCH (lock:EpisodeGroupLock {group_id:$group})
          SET lock.sequence=lock.sequence+$size RETURN lock.sequence AS sequence`,
          { group: inputs[0].group_id, size: neo4j.int(inputs.length) },
        );
        const finalSequence = sequenceResult.records[0].get('sequence').toNumber();
        const results: AppendEpisodeResult[] = [];
        for (const [index, item] of prepared.entries())
          results.push(
            await this.appendEpisodeInTransaction(
              tx,
              item.parsed,
              item.auto,
              finalSequence - inputs.length + index + 1,
              item.uuid,
            ),
          );
        const before = await this.graphInTransaction(tx);
        const after = JSON.parse(JSON.stringify(before)) as GraphData;
        const clock = await tx.run('RETURN toString(datetime.realtime()) AS now');
        const now = new Date(clock.records[0].get('now')).toISOString();
        const refs = enqueue(after, results, eligible, binding, limits, now, invocation);
        await this.writeExtractionDiff(tx, before, after);
        return {
          results: results.map((item) => ({
            ...item,
            episode: protectAutomaticEpisode(
              after.episodes.find((ep) => ep.uuid === item.episode.uuid)!,
            ),
          })),
          jobs: refs,
          queue: queueStats(after, inputs[0].group_id),
        };
      });
    } finally {
      await session.close();
    }
  }

  async extractionQueueCommand(command: QueueCommand): Promise<QueueResult> {
    const session = this.getSession();
    try {
      return await this.executeWrite(session, async (tx) => {
        const before = await this.graphInTransaction(tx);
        const after = JSON.parse(JSON.stringify(before)) as GraphData;
        const clock = await tx.run('RETURN toString(datetime.realtime()) AS now');
        const result = queueCommand(
          after,
          command,
          new Date(clock.records[0].get('now')).toISOString(),
        );
        await this.writeExtractionDiff(tx, before, after);
        return result;
      });
    } finally {
      await session.close();
    }
  }

  async importExtractionBackup(input: unknown): Promise<void> {
    const backup = ownPlainRecord(input);
    if (backup) {
      const graph = ownDataValue(backup, 'graph');
      if (graph.present) {
        assertNoReservedAutonomousPersonalGraph(graph.value);
        assertNoImportedAutomaticOperations(graph.value);
      }
    }
    const session = this.getSession();
    try {
      await this.executeWrite(session, async (tx) => {
        const existing = await this.graphInTransaction(tx);
        const incoming = prepareQueueImport(input, existing, nowIso());
        const safeIncoming = prepareAutomaticImport(incoming, existing);
        const after = {
          ...existing,
          entities: [...existing.entities, ...safeIncoming.entities],
          edges: [...existing.edges, ...safeIncoming.edges],
          episodes: [...existing.episodes, ...safeIncoming.episodes],
        };
        await this.writeExtractionDiff(tx, existing, after);
        for (const ep of incoming.episodes) {
          await tx.run('CREATE (ep:Episode) SET ep += $props', {
            props: {
              ...ep,
              attributes: JSON.stringify(ep.attributes),
              source_dedup_key: this.sourceDedupKey(ep),
              idempotency_dedup_key: this.idempotencyDedupKey(ep),
            },
          });
        }
        for (const ep of incoming.episodes)
          if (ep.previous_episode_uuid)
            await tx.run(
              'MATCH (a:Episode {uuid:$prev}) MATCH (b:Episode {uuid:$uuid}) MERGE (a)-[:NEXT_EPISODE]->(b)',
              { prev: ep.previous_episode_uuid, uuid: ep.uuid },
            );
        await tx.run(`MATCH (lock:EngramStoreLock {id:'extraction-v1'}) SET lock.epoch=$epoch`, {
          epoch: generateUuid(),
        });
      });
    } finally {
      await session.close();
    }
  }

  async applyStagedExtraction(plan: StagedExtraction): Promise<void> {
    const session = this.getSession();
    try {
      await this.executeWrite(session, async (tx) => {
        const before = await this.graphInTransaction(tx);
        const after = JSON.parse(JSON.stringify(before)) as GraphData;
        applyPlan(after, plan);
        assertNoNewReservedAutonomousPersonalGraphRecords(before, after);
        await this.writeExtractionDiff(tx, before, after);
      });
    } finally {
      await session.close();
    }
  }

  private sourceDedupKey(input: {
    group_id: string;
    source_message_id?: string | null;
    episode_kind?: string;
  }): string | null {
    if (!input.source_message_id || !input.episode_kind) return null;
    return JSON.stringify([input.group_id, input.source_message_id, input.episode_kind]);
  }

  private idempotencyDedupKey(input: {
    group_id: string;
    idempotency_key?: string | null;
  }): string | null {
    if (!input.idempotency_key) return null;
    return JSON.stringify([input.group_id, input.idempotency_key]);
  }

  private buildEpisodeFilter(
    alias: string,
    groupId: string,
    options: EpisodeFilterOptions,
  ): { where: string; params: Record<string, unknown> } {
    const clauses = [`${alias}.group_id = $filter_group_id`];
    const params: Record<string, unknown> = { filter_group_id: groupId };
    const equalityFilters: Array<[keyof EpisodeFilterOptions, string]> = [
      ['role', 'role'],
      ['source_type', 'source_type'],
      ['episode_kind', 'episode_kind'],
      ['trust_level', 'trust_level'],
      ['review_status', 'review_status'],
      ['sender_id', 'sender_id'],
      ['conversation_id', 'conversation_id'],
      ['source_message_id', 'source_message_id'],
      ['source_workflow_id', 'source_workflow_id'],
      ['source_execution_id', 'source_execution_id'],
    ];
    for (const [optionKey, property] of equalityFilters) {
      const value = options[optionKey];
      if (typeof value !== 'string' || value === '') continue;
      clauses.push(`${alias}.${property} = $filter_${property}`);
      params[`filter_${property}`] = value;
    }
    if (options.sender_name) {
      clauses.push(`toLower(${alias}.sender_name) = toLower($filter_sender_name)`);
      params.filter_sender_name = options.sender_name;
    }
    const dateFilters: Array<[keyof EpisodeFilterOptions, string, '>=' | '<=']> = [
      ['reference_after', 'reference_time', '>='],
      ['reference_before', 'reference_time', '<='],
      ['created_after', 'created_at', '>='],
      ['created_before', 'created_at', '<='],
    ];
    for (const [optionKey, property, operator] of dateFilters) {
      const value = options[optionKey];
      if (typeof value !== 'string' || value === '') continue;
      clauses.push(`${alias}.${property} ${operator} $filter_${optionKey}`);
      params[`filter_${optionKey}`] = value;
    }
    if (options.hygiene_rule === 'empty_assistant_output') {
      clauses.push(`${alias}.role = 'ai' AND ${alias}.content =~ '^\\s*(?:\\[\\s*\\])?\\s*$'`);
    }
    const contentContains = options.content_contains?.trim();
    if (contentContains) {
      clauses.push(`toLower(${alias}.content) CONTAINS toLower($filter_content_contains)`);
      params.filter_content_contains = contentContains;
    }
    return { where: clauses.join(' AND '), params };
  }

  private buildEpisodeListQuery(
    groupId: string,
    options: EpisodeFilterOptions,
  ): { query: string; params: Record<string, unknown> } {
    const { where, params } = this.buildEpisodeFilter('ep', groupId, options);
    const sortBy = options.sort_by === 'reference_time' ? 'reference_time' : 'created_at';
    const sortOrder = options.sort_order === 'asc' ? 'ASC' : 'DESC';
    let query = `MATCH (ep:Episode) WHERE ${where}
      RETURN ep
      ORDER BY ep.${sortBy} ${sortOrder}, coalesce(ep.append_sequence, 0) ${sortOrder}, ep.uuid ${sortOrder}`;
    if (options.offset !== undefined) {
      query += ' SKIP $offset';
      params.offset = neo4j.int(Math.max(0, options.offset));
    }
    if (options.limit !== undefined) {
      query += ' LIMIT $limit';
      params.limit = neo4j.int(Math.max(0, options.limit));
    }
    return { query, params };
  }

  private async lockEpisodeGroup(tx: ManagedTransaction, groupId: string): Promise<void> {
    await tx.run(
      `MERGE (lock:EpisodeGroupLock {group_id: $group_id})
       SET lock.sequence = coalesce(lock.sequence, 0) + 1,
           lock.updated_at = $updated_at`,
      { group_id: groupId, updated_at: nowIso() },
    );
  }

  private async countEdgesLinkedToEpisodes(episodeUuids: string[]): Promise<number> {
    if (episodeUuids.length === 0) return 0;
    const session = this.getSession();
    try {
      return await session.executeRead((tx) =>
        this.countEdgesLinkedToEpisodesInTransaction(tx, episodeUuids),
      );
    } finally {
      await session.close();
    }
  }

  private async countEdgesLinkedToEpisodesInTransaction(
    tx: ManagedTransaction,
    episodeUuids: string[],
  ): Promise<number> {
    if (episodeUuids.length === 0) return 0;
    const result = await tx.run(
      `MATCH ()-[r:RELATES_TO]->()
       WHERE any(episodeUuid IN $episode_uuids WHERE episodeUuid IN r.episodes)
       RETURN count(r) AS count`,
      { episode_uuids: episodeUuids },
    );
    return result.records[0]?.get('count').toNumber() ?? 0;
  }

  private async assertNoAutomaticOperationChainImpactInTransaction(
    tx: ManagedTransaction,
    sourceIds: string[],
  ): Promise<void> {
    if (sourceIds.length === 0) return;
    const result = await tx.run(
      `MATCH (op:AutomaticOperation)
       OPTIONAL MATCH (source:Episode {uuid:op.source_id})
       WITH op, source
       WHERE source IS NULL
          OR op.source_id IN $source_ids
          OR source.previous_episode_uuid IN $source_ids
          OR EXISTS {
            MATCH (child:Episode)
            WHERE child.uuid IN $source_ids AND child.previous_episode_uuid = source.uuid
          }
       RETURN count(op) AS count, sum(CASE WHEN source IS NULL THEN 1 ELSE 0 END) AS invalid_count`,
      { source_ids: sourceIds },
    );
    const invalid = result.records[0]?.get('invalid_count')?.toNumber() ?? 0;
    if (invalid > 0) throw new Error('Engram automatic ledger: invalid_native_record');
    const count = result.records[0]?.get('count')?.toNumber() ?? 0;
    if (count > 0) throw new Error('Engram automatic ledger: source_delete_forbidden');
  }

  private async assertNoAutonomousSource4ChainImpactInTransaction(
    tx: ManagedTransaction,
    deletingEpisodes: EpisodicNode[],
    allStoredEpisodesIncluded = false,
  ): Promise<void> {
    const hasSource4Attributes = (episode: EpisodicNode) =>
      Object.prototype.hasOwnProperty.call(
        episode.attributes,
        AUTONOMOUS_CAPTURE_V4_OWNER_ATTRIBUTE,
      ) ||
      Object.prototype.hasOwnProperty.call(
        episode.attributes,
        AUTONOMOUS_CAPTURE_V3_ENVELOPE_ATTRIBUTE,
      );
    if (deletingEpisodes.some(hasSource4Attributes))
      throw new Error('Engram automatic ledger: source_delete_forbidden');
    if (deletingEpisodes.length === 0 || allStoredEpisodesIncluded) return;

    const sourceIds = [...new Set(deletingEpisodes.map((episode) => episode.uuid))];
    const previousIds = [
      ...new Set(
        deletingEpisodes
          .map((episode) => episode.previous_episode_uuid)
          .filter((uuid): uuid is string => uuid !== null),
      ),
    ];
    const adjacent = await tx.run(
      `MATCH (candidate:Episode)
       WHERE candidate.uuid IN $source_ids
          OR candidate.previous_episode_uuid IN $source_ids
          OR candidate.uuid IN $previous_ids
       RETURN candidate LIMIT 100001`,
      { source_ids: sourceIds, previous_ids: previousIds },
    );
    if (adjacent.records.length > 100000)
      throw new Error('Engram automatic ledger: source_delete_forbidden');
    for (const record of adjacent.records) {
      const candidate = this.recordToEpisode(record.get('candidate').properties);
      if (hasSource4Attributes(candidate))
        throw new Error('Engram automatic ledger: source_delete_forbidden');
    }
  }

  private async deleteEpisodeInTransaction(
    tx: ManagedTransaction,
    uuid: string,
    options: DeleteEpisodeOptions,
    groupAlreadyLocked = false,
  ): Promise<DeleteEpisodeResult> {
    const existingResult = await tx.run('MATCH (ep:Episode {uuid: $uuid}) RETURN ep', { uuid });
    if (existingResult.records.length === 0) {
      return {
        episode_uuid: uuid,
        deleted: false,
        repaired_successor_count: 0,
        linked_edge_count: 0,
        updated_edge_count: 0,
        deleted_edge_count: 0,
      };
    }
    const episode = this.recordToEpisode(existingResult.records[0].get('ep').properties);
    assertNoQueueMutation([episode]);
    await this.assertNoAutonomousSource4ChainImpactInTransaction(tx, [episode]);
    await this.assertNoAutomaticOperationChainImpactInTransaction(tx, [uuid]);
    if (!groupAlreadyLocked) await this.lockEpisodeGroup(tx, episode.group_id);

    const linkedResult = await tx.run(
      'MATCH ()-[r:RELATES_TO]->() WHERE $uuid IN r.episodes RETURN r',
      { uuid },
    );
    const cleanup = options.fact_cleanup ?? 'unlink';
    let updatedEdgeCount = 0;
    let deletedEdgeCount = 0;
    if (cleanup !== 'preserve') {
      for (const record of linkedResult.records) {
        const edge = this.recordToEdge(record.get('r').properties);
        const remainingEpisodes = edge.episodes.filter((episodeUuid) => episodeUuid !== uuid);
        if (cleanup === 'delete_orphaned' && remainingEpisodes.length === 0) {
          await tx.run('MATCH ()-[r:RELATES_TO {uuid: $edge_uuid}]->() DELETE r', {
            edge_uuid: edge.uuid,
          });
          deletedEdgeCount++;
        } else {
          await tx.run(
            `MATCH ()-[r:RELATES_TO {uuid: $edge_uuid}]->()
             SET r.episodes = $episodes, r.updated_at = $updated_at`,
            { edge_uuid: edge.uuid, episodes: remainingEpisodes, updated_at: nowIso() },
          );
          updatedEdgeCount++;
        }
      }
    }

    const successorResult = await tx.run(
      `MATCH (successor:Episode {group_id: $group_id})
       WHERE successor.previous_episode_uuid = $uuid
       RETURN successor.uuid AS uuid`,
      { group_id: episode.group_id, uuid },
    );
    const successorUuids = successorResult.records.map((record) => record.get('uuid') as string);
    const repairChain = options.repair_chain ?? true;
    if (repairChain) {
      for (const successorUuid of successorUuids) {
        await tx.run(
          `MATCH (successor:Episode {uuid: $successor_uuid})
           SET successor.previous_episode_uuid = $previous_uuid,
               successor.updated_at = $updated_at`,
          {
            successor_uuid: successorUuid,
            previous_uuid: episode.previous_episode_uuid,
            updated_at: nowIso(),
          },
        );
      }
    }

    await tx.run('MATCH (ep:Episode {uuid: $uuid}) DETACH DELETE ep', { uuid });
    if (repairChain && episode.previous_episode_uuid) {
      for (const successorUuid of successorUuids) {
        await tx.run(
          `MATCH (previous:Episode {uuid: $previous_uuid})
           MATCH (successor:Episode {uuid: $successor_uuid})
           MERGE (previous)-[:NEXT_EPISODE]->(successor)`,
          { previous_uuid: episode.previous_episode_uuid, successor_uuid: successorUuid },
        );
      }
    }

    return {
      episode_uuid: uuid,
      deleted: true,
      repaired_successor_count: repairChain ? successorUuids.length : 0,
      linked_edge_count: linkedResult.records.length,
      updated_edge_count: updatedEdgeCount,
      deleted_edge_count: deletedEdgeCount,
    };
  }

  // ===== Entity Operations =====

  async addEntity(input: CreateEntityNode): Promise<EntityNode> {
    assertNoReservedAutonomousPersonalRow(input);
    assertNoAutomaticBindingAttribute(input.attributes);
    const now = nowIso();
    const entity: EntityNode = {
      uuid: generateUuid(),
      name: input.name,
      group_id: input.group_id,
      summary: input.summary ?? '',
      entity_type: input.entity_type ?? 'unknown',
      name_embedding: input.name_embedding ?? null,
      attributes: input.attributes ?? {},
      created_at: now,
      updated_at: now,
    };

    // Lazily create vector index when first embedding is stored
    if (entity.name_embedding && entity.name_embedding.length > 0) {
      await this.ensureVectorIndex(entity.name_embedding.length);
    }

    const session = this.getSession();
    try {
      await this.executeWrite(session, async (tx) => {
        await tx.run(
          `CREATE (e:Entity {
						uuid: $uuid,
						name: $name,
						group_id: $group_id,
						summary: $summary,
						entity_type: $entity_type,
						name_embedding: $name_embedding,
						attributes: $attributes,
						created_at: $created_at,
						updated_at: $updated_at
					})`,
          {
            ...entity,
            attributes: JSON.stringify(entity.attributes),
            name_embedding: entity.name_embedding,
          },
        );
      });
    } finally {
      await session.close();
    }

    return entity;
  }

  async getEntity(uuid: string): Promise<EntityNode | null> {
    const session = this.getSession();
    try {
      const result = await session.executeRead(async (tx) => {
        return tx.run('MATCH (e:Entity {uuid: $uuid}) RETURN e', { uuid });
      });

      if (result.records.length === 0) return null;
      return this.recordToEntity(result.records[0].get('e').properties);
    } finally {
      await session.close();
    }
  }

  async getEntityByName(name: string, groupId: string): Promise<EntityNode | null> {
    const session = this.getSession();
    try {
      const result = await session.executeRead(async (tx) => {
        return tx.run(
          'MATCH (e:Entity {group_id: $groupId}) WHERE toLower(e.name) = toLower($name) RETURN e LIMIT 1',
          { name, groupId },
        );
      });

      if (result.records.length === 0) return null;
      return this.recordToEntity(result.records[0].get('e').properties);
    } finally {
      await session.close();
    }
  }

  async updateEntity(uuid: string, updates: Partial<EntityNode>): Promise<EntityNode> {
    if (updates.name_embedding && updates.name_embedding.length > 0) {
      await this.ensureVectorIndex(updates.name_embedding.length);
    }
    const session = this.getSession();
    try {
      return await this.executeWrite(session, async (tx) => {
        const existingResult = await tx.run('MATCH (e:Entity {uuid:$uuid}) RETURN e', { uuid });
        if (existingResult.records.length === 0) throw new Error(`Entity not found: ${uuid}`);
        const existing = this.recordToEntity(existingResult.records[0].get('e').properties);
        if (
          updates.entity_type === AUTONOMOUS_PERSONAL_VALUE_ENTITY_TYPE &&
          existing.entity_type !== AUTONOMOUS_PERSONAL_VALUE_ENTITY_TYPE
        ) {
          throw new Error('Engram automatic ledger: reserved_native_record');
        }
        if (updates.attributes !== undefined)
          assertReservedAttributeReplacementAllowed(existing.attributes, updates.attributes);
        const safeUpdates = prepareAutomaticEntityUpdate(existing, updates);
        const setClauses: string[] = ['e.updated_at = $updated_at'];
        const params: Record<string, unknown> = {
          uuid,
          updated_at: nowIso(),
        };

        if (safeUpdates.name !== undefined) {
          setClauses.push('e.name = $name');
          params.name = safeUpdates.name;
        }
        if (safeUpdates.summary !== undefined) {
          setClauses.push('e.summary = $summary');
          params.summary = safeUpdates.summary;
        }
        if (safeUpdates.entity_type !== undefined) {
          setClauses.push('e.entity_type = $entity_type');
          params.entity_type = safeUpdates.entity_type;
        }
        if (safeUpdates.attributes !== undefined) {
          setClauses.push('e.attributes = $attributes');
          params.attributes = JSON.stringify(safeUpdates.attributes);
        }
        if (safeUpdates.name_embedding !== undefined) {
          setClauses.push('e.name_embedding = $name_embedding');
          params.name_embedding = safeUpdates.name_embedding;
        }

        const result = await tx.run(
          `MATCH (e:Entity {uuid: $uuid}) SET ${setClauses.join(', ')} RETURN e`,
          params,
        );
        if (result.records.length === 0) throw new Error(`Entity not found: ${uuid}`);
        return this.recordToEntity(result.records[0].get('e').properties);
      });
    } finally {
      await session.close();
    }
  }

  async deleteEntity(uuid: string): Promise<void> {
    const session = this.getSession();
    try {
      await this.executeWrite(session, async (tx) => {
        const existing = await tx.run('MATCH (e:Entity {uuid:$uuid}) RETURN e', { uuid });
        if (existing.records.length > 0) {
          assertAutomaticEntityDeleteAllowed(
            this.recordToEntity(existing.records[0].get('e').properties),
          );
        }
        await tx.run('MATCH (e:Entity {uuid: $uuid}) DETACH DELETE e', { uuid });
      });
    } finally {
      await session.close();
    }
  }

  async listEntities(groupId: string, options?: ListOptions): Promise<EntityNode[]> {
    const session = this.getSession();
    try {
      let query = 'MATCH (e:Entity {group_id: $groupId})';
      const params: Record<string, unknown> = { groupId };
      const whereClauses: string[] = [];

      if (options?.entity_type) {
        whereClauses.push('e.entity_type = $entity_type');
        params.entity_type = options.entity_type;
      }
      if (options?.created_after) {
        whereClauses.push('e.created_at >= $created_after');
        params.created_after = options.created_after;
      }
      if (options?.created_before) {
        whereClauses.push('e.created_at <= $created_before');
        params.created_before = options.created_before;
      }
      if (whereClauses.length > 0) {
        query += ' WHERE ' + whereClauses.join(' AND ');
      }

      query += ' RETURN e ORDER BY e.created_at DESC';

      if (options?.offset) {
        query += ' SKIP $offset';
        params.offset = neo4j.int(options.offset);
      }
      if (options?.limit) {
        query += ' LIMIT $limit';
        params.limit = neo4j.int(options.limit);
      }

      const result = await session.executeRead(async (tx) => {
        return tx.run(query, params);
      });

      return result.records.map((r) => this.recordToEntity(r.get('e').properties));
    } finally {
      await session.close();
    }
  }

  // ===== Edge Operations =====

  async addEdge(input: CreateEntityEdge): Promise<EntityEdge> {
    assertNoReservedAutonomousPersonalRow(input);
    const now = nowIso();
    const edge: EntityEdge = {
      uuid: generateUuid(),
      group_id: input.group_id,
      source_node_uuid: input.source_node_uuid,
      target_node_uuid: input.target_node_uuid,
      name: input.name,
      fact: input.fact,
      fact_embedding: input.fact_embedding ?? null,
      episodes: input.episodes ?? [],
      valid_at: input.valid_at ?? null,
      invalid_at: input.invalid_at ?? null,
      expired_at: input.expired_at ?? null,
      attributes: input.attributes ?? {},
      created_at: now,
      updated_at: now,
    };

    // Lazily create vector index when first embedding is stored
    if (edge.fact_embedding && edge.fact_embedding.length > 0) {
      await this.ensureVectorIndex(edge.fact_embedding.length);
    }

    const session = this.getSession();
    try {
      const result = await this.executeWrite(session, async (tx) => {
        return tx.run(
          `MATCH (source:Entity {uuid: $source_node_uuid})
					 MATCH (target:Entity {uuid: $target_node_uuid})
					 CREATE (source)-[r:RELATES_TO {
						uuid: $uuid,
						group_id: $group_id,
						source_node_uuid: $source_node_uuid,
						target_node_uuid: $target_node_uuid,
						name: $name,
						fact: $fact,
						fact_embedding: $fact_embedding,
						episodes: $episodes,
						valid_at: $valid_at,
						invalid_at: $invalid_at,
						expired_at: $expired_at,
						attributes: $attributes,
						created_at: $created_at,
						updated_at: $updated_at
					 }]->(target)
					 RETURN r`,
          {
            ...edge,
            attributes: JSON.stringify(edge.attributes),
          },
        );
      });

      if (result.records.length === 0) {
        throw new Error(
          `Cannot create edge: source entity (${input.source_node_uuid}) or target entity (${input.target_node_uuid}) not found`,
        );
      }
    } finally {
      await session.close();
    }

    return edge;
  }

  async getEdge(uuid: string): Promise<EntityEdge | null> {
    const session = this.getSession();
    try {
      const result = await session.executeRead(async (tx) => {
        return tx.run('MATCH ()-[r:RELATES_TO {uuid: $uuid}]->() RETURN r', { uuid });
      });

      if (result.records.length === 0) return null;
      return this.recordToEdge(result.records[0].get('r').properties);
    } finally {
      await session.close();
    }
  }

  async getEdgesBetween(
    sourceUuid: string,
    targetUuid: string,
    limit?: number,
  ): Promise<EntityEdge[]> {
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 129)) {
      throw new Error('Edge limit must be an integer between 1 and 129');
    }
    const session = this.getSession();
    try {
      const result = await session.executeRead(async (tx) => {
        if (limit === undefined) {
          return tx.run(
            `MATCH (s:Entity {uuid: $sourceUuid})-[r:RELATES_TO]->(t:Entity {uuid: $targetUuid})
             RETURN r
             UNION
             MATCH (s:Entity {uuid: $targetUuid})-[r:RELATES_TO]->(t:Entity {uuid: $sourceUuid})
             RETURN r`,
            { sourceUuid, targetUuid },
          );
        }
        return tx.run(
          `CALL {
             MATCH (s:Entity {uuid: $sourceUuid})-[r:RELATES_TO]->(t:Entity {uuid: $targetUuid})
             RETURN r
             UNION
             MATCH (s:Entity {uuid: $targetUuid})-[r:RELATES_TO]->(t:Entity {uuid: $sourceUuid})
             RETURN r
           }
           RETURN r
           LIMIT $limit`,
          { sourceUuid, targetUuid, limit: neo4j.int(limit) },
        );
      });

      return result.records.map((rec) => this.recordToEdge(rec.get('r').properties));
    } finally {
      await session.close();
    }
  }

  async getEdgesForEntity(entityUuid: string): Promise<EntityEdge[]> {
    const session = this.getSession();
    try {
      const result = await session.executeRead(async (tx) => {
        return tx.run(
          `MATCH (e:Entity {uuid: $entityUuid})-[r:RELATES_TO]->()
					 RETURN r
					 UNION
					 MATCH (e:Entity {uuid: $entityUuid})<-[r:RELATES_TO]-()
					 RETURN r`,
          { entityUuid },
        );
      });

      return result.records.map((rec) => this.recordToEdge(rec.get('r').properties));
    } finally {
      await session.close();
    }
  }

  async prepareAutonomousPersonalCaptureProviderV4(
    handle: unknown,
  ): Promise<AutonomousPersonalCaptureProviderPreflightV4> {
    const stopped = (kind: string) =>
      AutonomousPersonalCaptureProviderPreflightV4Schema.parse({
        kind,
        eligibleFirstCommit: false,
      });
    let access: ReturnType<typeof consumeAutonomousPersonalCaptureProviderPreflightV4> | undefined;
    let check = () => undefined as void;
    try {
      access = consumeAutonomousPersonalCaptureProviderPreflightV4(this, handle);
      const { scope, check: privateCheck } = getAutonomousPersonalCaptureProviderPreflightAccessV4(
        this,
        access,
      );
      check = privateCheck;
      check();
      const storeHash = neo4jAutomaticCaptureStoreHash(this.originalConfiguredUri, this.database);
      if (!this.initialized || !storeHash) return stopped('unsupported_mode');
      if (storeHash !== scope.context.storeHash) return stopped('conflict');
      const readStartedAtMonotonicMs = performance.now();
      const actual = await this.readAutonomousPersonalSnapshotV4(
        scope.request.namespace,
        scope.deadlineAtMonotonicMs,
        check,
        createAutonomousPersonalRecordWorkV4(scope.deadlineAtMonotonicMs),
      );
      check();
      const prepared = prepareAutonomousPersonalCaptureSnapshotV4(
        {
          request: scope.request,
          context: scope.context,
          sourceId: scope.sourceId,
          operationId: scope.operationId,
          leaseToken: scope.leaseToken,
          stableBeginHash: scope.stableBeginHash,
          attemptHash: scope.attemptHash,
          backendNow: actual.backendNow,
          previousEpisodeId: actual.previousEpisodeId,
        },
        actual.graph,
        check,
      );
      check();
      if (prepared.kind === 'no_write') return prepared.resultProjection;
      if (prepared.kind !== 'same_initial_scope_candidate') return stopped('conflict');
      const binding = findAutomaticBinding(
        actual.graph,
        scope.request.namespace,
        scope.request.issuer,
        scope.request.actorReference,
        check,
      );
      if (!binding || binding.state !== 'active') return stopped('authority_changed');
      const bindingRef = {
        bindingId: binding.bindingId,
        revision: binding.revision,
        subjectId: binding.subjectId,
        fingerprint: binding.fingerprint,
      };
      assertAutomaticBindingIdentity(
        actual.graph,
        scope.request.namespace,
        scope.request.issuer,
        scope.request.actorReference,
        bindingRef,
        check,
      );
      const observation = AutonomousPersonalCaptureProviderObservationV4Schema.parse({
        source: prepared.episode,
        descriptor: scope.descriptor,
        operation: prepared.operation,
        fence: prepared.fence,
        binding: bindingRef,
        backendNow: actual.backendNow,
        readStartedAtMonotonicMs,
      });
      check();
      const result = bindAutonomousPersonalCaptureProviderPreflightV4(this, access, observation);
      check();
      return AutonomousPersonalCaptureProviderPreflightV4Schema.parse(result);
    } catch (error) {
      const kind = getAutonomousPersonalCaptureProviderFailureKindV4(error);
      if (kind === 'cancelled') throw error;
      if (kind) return stopped(kind);
      try {
        check();
      } catch (lifetimeError) {
        const lifetimeKind = getAutonomousPersonalCaptureProviderFailureKindV4(lifetimeError);
        if (lifetimeKind === 'cancelled') throw lifetimeError;
        return stopped(lifetimeKind ?? 'budget_exhausted');
      }
      return stopped(autonomousPersonalCaptureStorageFailureV4(error) ?? 'storage_error');
    } finally {
      if (access) closeAutonomousPersonalCaptureProviderPreflightV4(this, access);
    }
  }

  async beginAndClaimAutonomousPersonalCaptureV4(
    input: unknown,
    attempt: unknown,
  ): Promise<AutonomousPersonalCaptureBeginV4InternalResult> {
    const resultSchema = getAutonomousPersonalCaptureBeginV4InternalResultSchema();
    const stopped = (kind: string) => resultSchema.parse({ kind, eligibleFirstCommit: false });
    const storeHash = neo4jAutomaticCaptureStoreHash(this.originalConfiguredUri, this.database);
    if (!this.initialized || !storeHash) return stopped('unsupported_mode');
    const admitted = consumeAutonomousPersonalCaptureAttemptV4(this, input, attempt);
    if (admitted.kind === 'decision') return admitted.result;
    const { check } = admitted;
    const request = admitted.scope.request;
    const recordWork = createAutonomousPersonalRecordWorkV4(admitted.scope.deadlineAtMonotonicMs);
    let freshStaged = false;
    let writeAttempted = false;
    let callbackCompleted = false;
    let acknowledged = false;
    try {
      const preflight = await this.readAutonomousPersonalSnapshotV4(
        request.namespace,
        admitted.scope.deadlineAtMonotonicMs,
        check,
        recordWork,
      );
      const binding = findAutomaticBinding(
        preflight.graph,
        request.namespace,
        request.issuer,
        request.actorReference,
        check,
      );
      if (!binding || binding.state !== 'active') return stopped('authority_changed');
      const bindingRef = {
        bindingId: binding.bindingId,
        revision: binding.revision,
        subjectId: binding.subjectId,
        fingerprint: binding.fingerprint,
      };
      try {
        assertAutomaticBindingIdentity(
          preflight.graph,
          request.namespace,
          request.issuer,
          request.actorReference,
          bindingRef,
          check,
        );
      } catch (error) {
        check();
        return stopped(getAutonomousPersonalCaptureFailureKindV4(error) ?? 'authority_changed');
      }
      const scope = bindAutonomousPersonalCapturePreflightV4(this, attempt, {
        storeHash,
        binding: bindingRef,
      });
      const prepare = (graph: GraphData, backendNow: string, previousEpisodeId: string | null) =>
        prepareAutonomousPersonalCaptureSnapshotV4(
          {
            request: scope.request,
            context: scope.context,
            sourceId: scope.sourceId,
            operationId: scope.operationId,
            leaseToken: scope.leaseToken,
            stableBeginHash: scope.stableBeginHash,
            attemptHash: scope.attemptHash,
            backendNow,
            previousEpisodeId,
          },
          graph,
          check,
        );
      const epoch = generateUuid();
      const session = this.getSession();
      let prepared: ReturnType<typeof prepareAutonomousPersonalCaptureSnapshotV4> | undefined;
      try {
        try {
          // This fixed writer is the only path allowed to enroll native V4.
          // The ordinary executeWrite wrapper remains closed to format changes.
          prepared = await session.executeWrite(
            async (tx) => {
              check();
              const locked = await tx.run(`MATCH (lock:EngramStoreLock {id:'extraction-v1'})
              SET lock.revision=coalesce(lock.revision,0)+1
              RETURN lock.revision AS revision`);
              if (locked.records.length !== 1)
                throw new Error('Engram automatic ledger: native_root_missing');
              check();
              const registeredBefore = await this.readAutonomousSource4FormatInTransaction(tx);
              const beforeRead = createAutonomousPersonalNativeSnapshotReadV4(check);
              await this.preflightAutonomousPersonalGlobalGraphInTransaction(tx, beforeRead);
              check();
              const graph = await this.graphInTransaction(
                tx,
                undefined,
                'automatic_capture',
                beforeRead,
              );
              if (graph.group_id === undefined) delete graph.group_id;
              assertAutomaticLedgerSourceIntegrity(graph);
              assertAutonomousPersonalRecordIntegrityV4(graph, recordWork, check);
              check();
              const tail = await tx.run(
                `MATCH (ep:Episode {group_id:$namespace}) RETURN ep.uuid AS uuid
               ORDER BY coalesce(ep.append_sequence,0) DESC, ep.created_at DESC, ep.uuid DESC LIMIT 1`,
                { namespace: request.namespace },
              );
              check();
              const clock = await tx.run('RETURN datetime.realtime().epochMillis AS now');
              check();
              const rawClock: unknown = clock.records[0]?.get('now');
              const milliseconds = neo4j.isInt(rawClock)
                ? rawClock.toNumber()
                : typeof rawClock === 'number'
                  ? rawClock
                  : NaN;
              if (
                !Number.isSafeInteger(milliseconds) ||
                !Number.isFinite(new Date(milliseconds).getTime())
              )
                throw new Error('Engram autonomous capture: backend_clock_invalid');
              const backendNow = new Date(milliseconds).toISOString();
              const candidate = prepare(
                graph,
                backendNow,
                (tail.records[0]?.get('uuid') as string | undefined) ?? null,
              );
              check();
              if (
                candidate.kind === 'no_write' ||
                candidate.kind === 'same_initial_scope_candidate'
              )
                throw new RollbackAutonomousPersonalCaptureBeginV4(candidate);

              let next: GraphData;
              if (candidate.kind === 'initial_candidate') {
                next = {
                  ...graph,
                  episodes: [...graph.episodes, candidate.episode],
                  automatic_operations_v1: {
                    version: 1,
                    operations: [
                      ...(graph.automatic_operations_v1?.operations ?? []),
                      candidate.operation,
                    ],
                  },
                  metadata: { ...graph.metadata, extraction_epoch: epoch },
                };
                assertAutomaticLedgerSourceIntegrity(next);
                assertAutonomousPersonalRecordIntegrityV4(next, recordWork, check);
                if (!validateAutomaticCaptureCandidate(next, check))
                  throw new RollbackAutonomousPersonalCaptureBeginV4({
                    kind: 'no_write',
                    resultProjection: { kind: 'capacity', eligibleFirstCommit: false },
                  });
                stageFreshAutonomousPersonalCaptureV4(this, attempt, candidate);
                freshStaged = true;
                writeAttempted = true;
                await this.persistAutomaticCaptureBeginCandidate(
                  tx,
                  graph,
                  next,
                  candidate.episode,
                  backendNow,
                  check,
                );
                await tx.run(
                  "MATCH (lock:EngramStoreLock {id:'extraction-v1'}) SET lock.epoch=$epoch",
                  {
                    epoch,
                  },
                );
              } else {
                if (!registeredBefore)
                  throw new Error('Engram automatic ledger: unregistered_native_format');
                next = {
                  ...graph,
                  automatic_operations_v1: {
                    version: 1,
                    operations: (graph.automatic_operations_v1?.operations ?? []).map(
                      (operation) =>
                        operation.operationId === candidate.operation.operationId
                          ? candidate.operation
                          : operation,
                    ),
                  },
                };
                assertAutomaticLedgerSourceIntegrity(next);
                assertAutonomousPersonalRecordIntegrityV4(next, recordWork, check);
                if (!validateAutomaticCaptureCandidate(next, check))
                  throw new RollbackAutonomousPersonalCaptureBeginV4({
                    kind: 'no_write',
                    resultProjection: { kind: 'capacity', eligibleFirstCommit: false },
                  });
                writeAttempted = true;
                await this.writeExtractionDiff(tx, graph, next, check);
              }
              check();
              // Inspect actual transaction rows before the witness makes them readable.
              const actualRead = createAutonomousPersonalNativeSnapshotReadV4(check);
              await this.preflightAutonomousPersonalGlobalGraphInTransaction(tx, actualRead);
              const actual = await this.readNativeGraphDataInTransaction(
                tx,
                undefined,
                'automatic_capture',
                actualRead,
              );
              if (actual.group_id === undefined) delete actual.group_id;
              assertAutomaticLedgerSourceIntegrity(actual);
              assertAutonomousPersonalRecordIntegrityV4(actual, recordWork, check);
              const actualOperation = actual.automatic_operations_v1?.operations.find(
                (operation) => operation.operationId === candidate.operation.operationId,
              );
              const actualSource =
                candidate.kind === 'initial_candidate'
                  ? actual.episodes.find((episode) => episode.uuid === candidate.episode.uuid)
                  : undefined;
              if (
                !actualOperation ||
                canonical(actualOperation) !== canonical(candidate.operation) ||
                (candidate.kind === 'initial_candidate' &&
                  (!actualSource || canonical(actualSource) !== canonical(candidate.episode)))
              )
                throw new RollbackAutonomousPersonalCaptureBeginV4({
                  kind: 'no_write',
                  resultProjection: { kind: 'conflict', eligibleFirstCommit: false },
                });
              if (!validateAutomaticCaptureCandidate(actual, check))
                throw new RollbackAutonomousPersonalCaptureBeginV4({
                  kind: 'no_write',
                  resultProjection: { kind: 'capacity', eligibleFirstCommit: false },
                });
              if (!registeredBefore) {
                await tx.run(`MATCH (lock:EngramStoreLock {id:'extraction-v1'})
                SET lock.autonomous_source_format_v4=1`);
              }
              if (!(await this.readAutonomousSource4FormatInTransaction(tx)))
                throw new Error('Engram automatic ledger: invalid_native_format');
              check();
              callbackCompleted = true;
              return candidate;
            },
            {
              timeout: Math.max(1, Math.floor(scope.deadlineAtMonotonicMs - performance.now())),
            },
          );
          acknowledged = true;
        } catch (error) {
          if (error instanceof RollbackAutonomousPersonalCaptureBeginV4) {
            prepared = error.candidate;
          } else {
            const kind = getAutonomousPersonalCaptureFailureKindV4(error);
            const validation = autonomousPersonalCaptureStorageFailureV4(error);
            if (kind && !callbackCompleted) return stopped(kind);
            if (validation) return stopped(validation);
            if (!freshStaged)
              return stopped(
                callbackCompleted && writeAttempted ? 'acknowledgement_unknown' : 'storage_error',
              );
            if (!callbackCompleted) return stopped('storage_error');
            // A completed callback may have committed. Recovery below is read-only.
          }
        }
      } finally {
        await session.close();
      }
      if (prepared?.kind === 'no_write' || prepared?.kind === 'audit_candidate')
        return resultSchema.parse(prepared.resultProjection);
      if (!freshStaged) return stopped('in_progress');

      beginAutonomousPersonalCaptureReadbackV4(
        this,
        attempt,
        acknowledged ? 'acknowledged' : 'unknown',
      );
      try {
        const actual = await this.readAutonomousPersonalSnapshotV4(
          request.namespace,
          scope.deadlineAtMonotonicMs,
          check,
          recordWork,
        );
        const source = actual.graph.episodes.find((episode) => episode.uuid === scope.sourceId);
        const operation = actual.graph.automatic_operations_v1?.operations.find(
          (row) => row.operationId === scope.operationId,
        );
        if (!source && !operation)
          return stopped(acknowledged ? 'storage_error' : 'acknowledgement_unknown');
        if (!source || !operation) return stopped('conflict');
        const observed = prepare(actual.graph, actual.backendNow, actual.previousEpisodeId);
        if (observed.kind === 'no_write') return resultSchema.parse(observed.resultProjection);
        if (observed.kind !== 'same_initial_scope_candidate') return stopped('conflict');
        const handle = issueInitialAutonomousPersonalCaptureHandleV4(this, attempt, observed);
        if (!handle) return stopped('conflict');
        return resultSchema.parse({
          kind: 'claimed',
          purpose: 'human_turn_memory',
          sourceId: scope.sourceId,
          operationId: scope.operationId,
          descriptorHash: observed.fence.descriptorHash,
          sourcePersistence: 'persisted',
          claimKind: 'initial',
          eligibleFirstCommit: false,
          handle,
        });
      } catch (error) {
        if (isAutonomousPersonalCaptureProvenCommitBudgetFailureV4(error))
          return stopped('budget_exhausted');
        const kind = getAutonomousPersonalCaptureFailureKindV4(error);
        const validation = autonomousPersonalCaptureStorageFailureV4(error);
        return stopped(
          acknowledged
            ? (kind ?? validation ?? 'storage_error')
            : (validation ?? (kind === 'conflict' ? 'conflict' : 'acknowledgement_unknown')),
        );
      }
    } catch (error) {
      if (isAutonomousPersonalCaptureProvenCommitBudgetFailureV4(error))
        return stopped('budget_exhausted');
      const kind = getAutonomousPersonalCaptureFailureKindV4(error);
      const validation = autonomousPersonalCaptureStorageFailureV4(error);
      return stopped(
        callbackCompleted && !acknowledged
          ? (validation ?? (kind === 'conflict' ? 'conflict' : 'acknowledgement_unknown'))
          : (kind ?? validation ?? 'storage_error'),
      );
    } finally {
      closeAutonomousPersonalCaptureAttemptV4(this, attempt);
    }
  }

  async completeAutonomousPersonalCaptureV4(
    handle: unknown,
  ): Promise<AutonomousPersonalCompletionStorageV4Result> {
    return (await this.completeAutonomousPersonalCaptureCoreV4(handle, 'data')).observation;
  }

  async completeAutonomousPersonalCaptureForNativeV4(
    handle: unknown,
  ): Promise<PrivateAutonomousPersonalCompletionBackendOutcomeV4> {
    const core = await this.completeAutonomousPersonalCaptureCoreV4(handle, 'native_proof');
    return this.autonomousPersonalCompletionRegistryV4.registerCoreOutcome(
      handle as PrivateAutonomousPersonalCompletionHandleV4,
      core.observation,
      core.witness,
    );
  }

  private async completeAutonomousPersonalCaptureCoreV4(
    handle: unknown,
    mode: 'data' | 'native_proof',
  ): Promise<BackendCompletionCoreOutcomeV4> {
    let access: ReturnType<typeof consumeAutonomousPersonalCompletionHandleV4> | undefined;
    let originalHandle: PrivateAutonomousPersonalCompletionHandleV4 | undefined;
    let runtime: ReturnType<typeof getAutonomousPersonalCompletionAccessV4> | undefined;
    let check = () => undefined as void;
    let scope: AutomaticClaimReadScope | undefined;
    let expectedInput: AutonomousPersonalCompletionPlanV4Input | undefined;
    let expectedPlan: Extract<AutonomousPersonalCompletionPlanV4, { kind: 'planned' }> | undefined;
    let expectedNativeOrigin: AutonomousPersonalNativeOriginV4 | undefined;
    let nativeOrigin: AutonomousPersonalNativeOriginV4 | undefined;
    let callbackReturned = false;
    let knownDurableAck = false;

    const coreOutcome = (
      observation: AutonomousPersonalCompletionStorageV4Result,
      witness: TrustedCompletedAutonomousPersonalWriteV4 | null = null,
    ): BackendCompletionCoreOutcomeV4 => Object.freeze({ observation, witness });

    const unconfirmed = () =>
      AutonomousPersonalCompletionStorageV4ResultOwnedDataSchema.parse({ kind: 'unconfirmed' });
    try {
      // Consume the opaque key synchronously before opening a session or issuing a query.
      access = consumeAutonomousPersonalCompletionHandleV4(this, handle);
      runtime = getAutonomousPersonalCompletionAccessV4(this, access);
      check = runtime.check;
      check();
      originalHandle = handle as PrivateAutonomousPersonalCompletionHandleV4;
      const storeHash = neo4jAutomaticCaptureStoreHash(this.originalConfiguredUri, this.database);
      if (!this.initialized || !storeHash)
        return coreOutcome(autonomousPersonalCompletionNoWriteNeo4jV4('invalid_input'));
      if (storeHash !== runtime.view.scope.context.storeHash)
        return coreOutcome(autonomousPersonalCompletionNoWriteNeo4jV4('conflict'));
      scope = getAutomaticClaimReadScope(runtime.legacyReadBudget);
      if (!getAutomaticClaimReadScopeRemaining(scope))
        return coreOutcome(autonomousPersonalCompletionNoWriteNeo4jV4('invalid_input'));
    } catch (error) {
      return coreOutcome(
        autonomousPersonalCompletionNoWriteNeo4jV4(
          autonomousPersonalCompletionStorageFailureReasonNeo4jV4(error),
        ),
      );
    }

    const ownedRuntime = runtime;
    const ownedAccess = access;
    const readScope = scope;
    if (!ownedRuntime || !ownedAccess || !readScope)
      return coreOutcome(autonomousPersonalCompletionNoWriteNeo4jV4('invalid_input'));

    const workDeadlineProperty = Object.getOwnPropertyDescriptor(
      ownedRuntime.typedSyntaxWork,
      'absoluteMonotonicDeadlineMs',
    );
    if (
      !workDeadlineProperty ||
      !('value' in workDeadlineProperty) ||
      typeof workDeadlineProperty.value !== 'number' ||
      !Number.isFinite(workDeadlineProperty.value)
    )
      return coreOutcome(autonomousPersonalCompletionNoWriteNeo4jV4('invalid_input'));
    const completionDeadlineAtMonotonicMs = Math.min(
      workDeadlineProperty.value,
      ownedRuntime.view.scope.deadlineAtMonotonicMs,
    );

    const scopeCheck = () => {
      check();
      if (!canUseAutomaticClaimReadScope(readScope))
        throw new Error('Engram compositional capture: budget_exhausted');
    };
    const charge = createNeo4jCompositionalReadChargeV3(readScope, scopeCheck);
    const read: CompositionalNativeReadV3 = { check: scopeCheck, charge };
    const reserveSnapshot = () => {
      scopeCheck();
      if (!beginAutomaticClaimReadAttempt(readScope))
        throw new Error('Engram compositional capture: budget_exhausted');
      scopeCheck();
    };
    const transactionTimeout = () =>
      Math.max(1, Math.floor(completionDeadlineAtMonotonicMs - performance.now()));
    const extractionEpoch = generateUuid();

    const readback = async (): Promise<AutonomousPersonalCompletionStorageV4Result> => {
      if (!expectedInput || !expectedPlan) return unconfirmed();
      let session: Session | undefined;
      let transaction: ReturnType<Session['beginTransaction']> | undefined;
      let observation: AutonomousPersonalCompletionStorageV4Result = unconfirmed();
      try {
        scopeCheck();
        reserveSnapshot();
        // Explicit transactions on a WRITE-routed session give one writer-routed
        // readback without the driver's managed retry behavior.
        session = this.driver.session({
          database: this.database,
          defaultAccessMode: neo4j.session.WRITE,
        });
        transaction = session.beginTransaction({ timeout: transactionTimeout() });
        scopeCheck();
        const before = await this.automaticCaptureRevision(transaction, read);
        scopeCheck();
        await this.preflightAutonomousPersonalGlobalGraphInTransaction(transaction, read);
        scopeCheck();
        const actual = await this.graphInTransaction(
          transaction,
          undefined,
          'automatic_capture',
          read,
          true,
        );
        if (actual.group_id === undefined) delete actual.group_id;
        scopeCheck();
        assertAutomaticLedgerSourceIntegrity(actual);
        scopeCheck();
        assertAutonomousPersonalRecordIntegrityV4(actual, ownedRuntime.typedSyntaxWork, scopeCheck);
        scopeCheck();
        const after = await this.automaticCaptureRevision(transaction, read);
        scopeCheck();
        await transaction.commit();
        scopeCheck();
        if (before === after) {
          const result = validateAutonomousPersonalCompletionReadbackV4(
            actual,
            expectedInput,
            expectedPlan,
            ownedRuntime.typedSyntaxWork,
            check,
          );
          scopeCheck();
          observation = AutonomousPersonalCompletionStorageV4ResultOwnedDataSchema.parse(result);
          scopeCheck();
        }
      } catch {
        try {
          await transaction?.rollback();
        } catch {
          // The single observation is already inconclusive.
        }
        return unconfirmed();
      } finally {
        try {
          await session?.close();
        } catch {
          // Closing the one observation cannot authorize another attempt.
        }
      }
      try {
        scopeCheck();
        return observation;
      } catch {
        return unconfirmed();
      }
    };

    let writerSession: Session | undefined;
    let executionError: unknown;
    try {
      scopeCheck();
      writerSession = this.getSession();
      await writerSession.executeWrite(
        async (tx) => {
          if (callbackReturned) throw autonomousPersonalCompletionCallbackAlreadyReturnedError;
          expectedInput = undefined;
          expectedPlan = undefined;
          expectedNativeOrigin = undefined;
          nativeOrigin = undefined;
          scopeCheck();
          reserveSnapshot();
          const lockUpdate = await tx.run(
            `MATCH (lock:EngramStoreLock {id:'extraction-v1'})
             SET lock.revision=coalesce(lock.revision,0)+1
             RETURN lock.revision AS revision`,
          );
          scopeCheck();
          charge({ row_count: lockUpdate.records.length });
          for (const record of lockUpdate.records) {
            scopeCheck();
            charge({ revision: record.get('revision') ?? null });
          }
          if (lockUpdate.records.length !== 1)
            throw new Error('Engram automatic ledger: native_root_missing');

          const initialLockState = await this.automaticCaptureRevision(tx, read);
          if (!initialLockState.endsWith(':ledger'))
            throw new Error('Engram automatic ledger: native_root_missing');
          scopeCheck();
          await this.preflightAutonomousPersonalGlobalGraphInTransaction(tx, read);
          scopeCheck();
          const graph = await this.graphInTransaction(
            tx,
            undefined,
            'automatic_capture',
            read,
            true,
          );
          if (graph.group_id === undefined) delete graph.group_id;
          scopeCheck();
          assertAutomaticLedgerSourceIntegrity(graph);
          scopeCheck();
          assertAutonomousPersonalRecordIntegrityV4(
            graph,
            ownedRuntime.typedSyntaxWork,
            scopeCheck,
          );
          scopeCheck();

          const clock = await tx.run('RETURN datetime.realtime().epochMillis AS now');
          scopeCheck();
          charge({ row_count: clock.records.length });
          for (const record of clock.records) {
            scopeCheck();
            charge({ now: record.get('now') ?? null });
          }
          if (clock.records.length !== 1)
            throw new Error('Engram automatic capture: backend_clock_invalid');
          const rawClock: unknown = clock.records[0]?.get('now');
          const milliseconds = neo4j.isInt(rawClock)
            ? rawClock.toNumber()
            : typeof rawClock === 'number'
              ? rawClock
              : NaN;
          if (
            !Number.isSafeInteger(milliseconds) ||
            !Number.isFinite(new Date(milliseconds).getTime())
          )
            throw new Error('Engram automatic capture: backend_clock_invalid');
          const backendNow = new Date(milliseconds).toISOString();
          scopeCheck();

          const {
            scope: completionScope,
            stagedFresh,
            outcome,
            selection,
            completionCallHash,
            audit,
          } = ownedRuntime.view;
          const input = AutonomousPersonalCompletionPlanV4InputOwnedDataSchema.parse({
            scope: completionScope,
            stagedFresh,
            outcome: outcome.kind === 'response' ? { kind: 'response' as const } : outcome,
            backendNow,
            completionCallHash,
            audit,
          });
          scopeCheck();
          const plan = planAutonomousPersonalCaptureCompletionV4(
            input,
            graph,
            outcome.kind === 'response' ? outcome.response : null,
            outcome.kind === 'response' ? selection : null,
            ownedRuntime.typedSyntaxWork,
            check,
            ownedRuntime.legacyReadBudget,
          );
          scopeCheck();
          if (plan.kind === 'no_write')
            throw new RollbackAutonomousPersonalCompletionV4(plan.reason);

          if (mode === 'data') {
            assertAutonomousPersonalCompletionPlanAggregateBytesV4(this, ownedAccess, plan);
            scopeCheck();
          }
          const createsPairs = plan.createEntities.length > 0 || plan.createEdges.length > 0;
          const candidate = prepareAutonomousPersonalCompletionGraphCandidateV4(
            graph,
            input,
            plan,
            createsPairs ? extractionEpoch : null,
            ownedRuntime.typedSyntaxWork,
            check,
          );
          scopeCheck();
          if (candidate.kind === 'no_write')
            throw new RollbackAutonomousPersonalCompletionV4(candidate.reason);

          let attemptNativeOrigin: AutonomousPersonalNativeOriginV4 | undefined;
          if (mode === 'native_proof') {
            attemptNativeOrigin = projectAutonomousPersonalNativeOriginV4(input, plan, scopeCheck);
            assertAutonomousPersonalCompletionNativeAggregateBytesV4(
              this,
              ownedAccess,
              plan,
              attemptNativeOrigin,
            );
            scopeCheck();
          }

          scopeCheck();
          await this.writeExtractionDiff(tx, graph, candidate.graph, scopeCheck);
          scopeCheck();
          if (createsPairs) {
            const epochResult = await tx.run(
              `MATCH (lock:EngramStoreLock {id:'extraction-v1'})
               SET lock.epoch=$epoch
               RETURN lock.epoch AS epoch`,
              { epoch: extractionEpoch },
            );
            scopeCheck();
            charge({ row_count: epochResult.records.length });
            for (const record of epochResult.records) {
              scopeCheck();
              charge({ epoch: record.get('epoch') ?? null });
            }
            const actualEpoch = epochResult.records[0]?.get('epoch') ?? null;
            if (epochResult.records.length !== 1 || actualEpoch !== extractionEpoch)
              throw new RollbackAutonomousPersonalCompletionV4('conflict');
          }

          reserveSnapshot();
          const postWriteLockState = await this.automaticCaptureRevision(tx, read);
          if (!postWriteLockState.endsWith(':ledger'))
            throw new RollbackAutonomousPersonalCompletionV4('conflict');
          scopeCheck();
          await this.preflightAutonomousPersonalGlobalGraphInTransaction(tx, read);
          scopeCheck();
          const actual = await this.graphInTransaction(
            tx,
            undefined,
            'automatic_capture',
            read,
            true,
          );
          if (actual.group_id === undefined) delete actual.group_id;
          scopeCheck();
          assertAutomaticLedgerSourceIntegrity(actual);
          scopeCheck();
          assertAutonomousPersonalRecordIntegrityV4(
            actual,
            ownedRuntime.typedSyntaxWork,
            scopeCheck,
          );
          scopeCheck();
          if (
            !autonomousPersonalCompletionTargetRowsMatchV4(
              actual,
              candidate.graph,
              input,
              plan,
              scopeCheck,
            )
          )
            throw new RollbackAutonomousPersonalCompletionV4('conflict');
          scopeCheck();

          expectedInput = input;
          expectedPlan = plan;
          expectedNativeOrigin = attemptNativeOrigin;
          nativeOrigin = attemptNativeOrigin;
          callbackReturned = true;
          return autonomousPersonalCompletionCallbackResult;
        },
        { timeout: transactionTimeout() },
      );
      // Only resolution of the actual managed transaction promise establishes
      // durable acknowledgement. The callback-return latch and readback do not.
      knownDurableAck = true;
    } catch (error) {
      executionError = error;
    } finally {
      try {
        await writerSession?.close();
      } catch (error) {
        if (executionError === undefined) executionError = error;
      }
    }

    if (!callbackReturned) {
      try {
        scopeCheck();
      } catch (error) {
        executionError = error;
      }
      return coreOutcome(
        autonomousPersonalCompletionNoWriteNeo4jV4(
          executionError instanceof RollbackAutonomousPersonalCompletionV4
            ? executionError.reason
            : executionError instanceof AutonomousPersonalNativeOriginV4Error
              ? executionError.reason
              : autonomousPersonalCompletionStorageFailureReasonNeo4jV4(executionError),
        ),
      );
    }
    const observation = await readback();
    let witness: TrustedCompletedAutonomousPersonalWriteV4 | null = null;
    if (
      mode === 'native_proof' &&
      knownDurableAck &&
      observation.kind === 'matched' &&
      originalHandle &&
      ownedAccess &&
      expectedInput &&
      expectedPlan &&
      expectedNativeOrigin &&
      nativeOrigin &&
      expectedNativeOrigin === nativeOrigin
    ) {
      try {
        scopeCheck();
        const opaqueWitness = Object.freeze(
          Object.create(null),
        ) as TrustedCompletedAutonomousPersonalWriteV4;
        const link: TrustedAutonomousPersonalCompletionWitnessLinkV4 = Object.freeze({
          originalHandle,
          completionAccess: ownedAccess as PrivateAutonomousPersonalCompletionAccessV4,
          nativeOrigin,
        });
        this.autonomousPersonalCompletionWitnessesV4.set(opaqueWitness, link);
        witness = opaqueWitness;
      } catch {
        // A known observation remains DATA when the original work has expired.
      }
    }
    return coreOutcome(observation, witness);
  }

  /** One writer-routed, read-only observation; absence does not prove a lost write rolled back. */
  private async readAutonomousPersonalSnapshotV4(
    namespace: string,
    deadlineAtMonotonicMs: number,
    check: () => void,
    recordWork: AutonomousPersonalTypedSyntaxWorkV1,
  ): Promise<{ graph: GraphData; backendNow: string; previousEpisodeId: string | null }> {
    check();
    const session = this.driver.session({
      database: this.database,
      defaultAccessMode: neo4j.session.WRITE,
    });
    const transaction = session.beginTransaction({
      timeout: Math.max(1, Math.floor(deadlineAtMonotonicMs - performance.now())),
    });
    try {
      const revision = async (): Promise<string> => {
        check();
        const result = await transaction.run(
          `MATCH (lock:EngramStoreLock {id:'extraction-v1'})
           RETURN coalesce(lock.revision,0) AS revision, lock.epoch AS epoch`,
        );
        check();
        if (result.records.length !== 1)
          throw new Error('Engram automatic ledger: native_root_missing');
        const row = result.records[0];
        return `${row.get('revision').toString()}:${row.get('epoch') ?? 'initial'}`;
      };
      const before = await revision();
      // The V4 path opts into these bounds even before first enrollment.
      // Ordinary legacy readers/writers continue to use their existing paths.
      const read = createAutonomousPersonalNativeSnapshotReadV4(check);
      await this.preflightAutonomousPersonalGlobalGraphInTransaction(transaction, read);
      check();
      const graph = await this.graphInTransaction(
        transaction,
        undefined,
        'automatic_capture',
        read,
      );
      if (graph.group_id === undefined) delete graph.group_id;
      check();
      assertAutomaticLedgerSourceIntegrity(graph);
      check();
      assertAutonomousPersonalRecordIntegrityV4(graph, recordWork, check);
      check();
      const tail = await transaction.run(
        `MATCH (ep:Episode {group_id:$namespace}) RETURN ep.uuid AS uuid
         ORDER BY coalesce(ep.append_sequence,0) DESC, ep.created_at DESC, ep.uuid DESC LIMIT 1`,
        { namespace },
      );
      check();
      const clock = await transaction.run('RETURN datetime.realtime().epochMillis AS now');
      check();
      const rawClock: unknown = clock.records[0]?.get('now');
      const milliseconds = neo4j.isInt(rawClock)
        ? rawClock.toNumber()
        : typeof rawClock === 'number'
          ? rawClock
          : NaN;
      if (!Number.isSafeInteger(milliseconds) || !Number.isFinite(new Date(milliseconds).getTime()))
        throw new Error('Engram autonomous capture: backend_clock_invalid');
      if (before !== (await revision())) throw new Error('Engram queue: concurrent_snapshot');
      check();
      return {
        graph,
        backendNow: new Date(milliseconds).toISOString(),
        previousEpisodeId: (tail.records[0]?.get('uuid') as string | undefined) ?? null,
      };
    } finally {
      // Rolling back this read-only transaction says nothing about the writer's outcome.
      try {
        await transaction.rollback();
      } finally {
        await session.close();
      }
    }
  }

  async beginAndClaimCompositionalCaptureV3(
    input: CompositionalCaptureBeginMethodRequestV3,
  ): Promise<CompositionalCaptureBeginInternalResultV3> {
    const started = performance.now();
    const setup = startCompositionalBackendBeginV3(
      input,
      this.compositionalCaptureHandlesV3,
      started,
    );
    if (setup.kind === 'decision') return setup.decision;
    const storeHash = neo4jAutomaticCaptureStoreHash(this.originalConfiguredUri, this.database);
    if (!this.initialized || !storeHash)
      return { kind: 'unsupported_mode', eligibleFirstCommit: false };
    const { request, begin, check } = setup;
    const epoch = generateUuid();
    let acknowledged = false;
    try {
      const session = this.getSession();
      try {
        let prepared: CompositionalAutomaticCaptureBeginPreparationV3 | undefined;
        try {
          try {
            prepared = await this.executeWrite(session, async (tx) => {
              check();
              const graph = await this.graphInTransaction(tx, undefined, 'automatic_capture');
              if (graph.group_id === undefined) delete graph.group_id;
              check();
              const tail = await tx.run(
                `MATCH (ep:Episode {group_id:$namespace}) RETURN ep.uuid AS uuid
                 ORDER BY coalesce(ep.append_sequence,0) DESC, ep.created_at DESC, ep.uuid DESC LIMIT 1`,
                { namespace: request.namespace },
              );
              check();
              const clock = await tx.run('RETURN datetime.realtime().epochMillis AS now');
              const clockValue: unknown = clock.records[0]?.get('now');
              const clockMs = neo4j.isInt(clockValue)
                ? clockValue.toNumber()
                : typeof clockValue === 'number'
                  ? clockValue
                  : NaN;
              if (!Number.isSafeInteger(clockMs) || !Number.isFinite(new Date(clockMs).getTime()))
                throw new Error('Engram compositional capture: backend_clock_invalid');
              const backendNow = new Date(clockMs).toISOString();
              check();
              const candidate = prepareCompositionalHumanCaptureBeginV3(
                graph,
                request,
                {
                  storeHash,
                  backendNow,
                  previousEpisodeId: (tail.records[0]?.get('uuid') as string | undefined) ?? null,
                },
                begin.scope,
                this.compositionalCaptureHandlesV3,
                check,
              );
              check();
              if (
                candidate.kind === 'decision' ||
                (candidate.kind === 'prepared_claim' && !candidate.writeRequired)
              )
                throw new RollbackCompositionalCaptureBeginV3(candidate);
              if (candidate.kind === 'prepared_claim') {
                const addition = selectCompositionalCaptureNewSourceV3(
                  graph.episodes,
                  candidate.graph.episodes,
                  begin.sourceId,
                  check,
                );
                await this.persistAutomaticCaptureBeginCandidate(
                  tx,
                  graph,
                  candidate.graph,
                  addition,
                  backendNow,
                  check,
                );
                await tx.run("MATCH (l:EngramStoreLock {id:'extraction-v1'}) SET l.epoch=$epoch", {
                  epoch,
                });
              } else {
                await this.writeExtractionDiff(tx, graph, candidate.graph, check);
              }
              check();
              return candidate;
            });
            acknowledged = true;
          } catch (error) {
            if (error instanceof RollbackCompositionalCaptureBeginV3) {
              prepared = error.preparation;
              acknowledged = true;
            } else throw error;
          }
          check();
          if (prepared.kind !== 'prepared_claim') return prepared.decision;
        } catch (error) {
          check();
          if (acknowledged) throw error;
          // Same-scope recovery performs a coherent read only; never retry writes.
        }
        const snapshot = await this.readAutomaticCaptureSnapshot(session, check);
        check();
        const operation = snapshot.graph.automatic_operations_v1?.operations.find(
          (op) => op.version === 3 && op.operationId === begin.operationId,
        );
        if (!operation) return { kind: 'acknowledgement_unknown', eligibleFirstCommit: false };
        const actual = { storeHash, namespace: request.namespace, ...snapshot, operation };
        const handle = acknowledged
          ? this.compositionalCaptureHandlesV3.issueInitialAfterAcknowledgedBegin(
              begin.scope,
              actual,
            )
          : this.compositionalCaptureHandlesV3.recoverInitialAfterUnknownAcknowledgement(
              begin.scope,
              actual,
            );
        check();
        if (!handle) return { kind: 'acknowledgement_unknown', eligibleFirstCommit: false };
        const result = this.compositionalCaptureHandlesV3.resultSchemas().begin.parse({
          kind: 'claimed',
          claimKind: 'initial',
          handle,
          eligibleFirstCommit: false,
        });
        check();
        return result;
      } finally {
        await session.close();
        check();
      }
    } catch (error) {
      this.compositionalCaptureHandlesV3.markInvocationCancelled(begin.scope);
      return {
        kind:
          error instanceof Error &&
          error.message === 'Engram compositional capture: budget_exhausted'
            ? 'budget_exhausted'
            : 'acknowledgement_unknown',
        eligibleFirstCommit: false,
      };
    }
  }

  async readCompositionalRetrievalSnapshotV3(
    scope: AutomaticClaimReadScope,
  ): Promise<CompositionalRetrievalSnapshotResultV3> {
    // This backend reserves independently. A read-session intake's earlier
    // reservation is not caller-supplied permission to skip backend limits.
    const remaining = getAutomaticClaimReadScopeRemaining(scope);
    if (!remaining) return { status: 'invalid', reason: 'invalid_scope' };
    if (remaining.snapshotBytesRemaining <= 0)
      return { status: 'deferred', reason: 'resource_exhausted' };
    if (!canUseAutomaticClaimReadScope(scope) || !beginAutomaticClaimReadAttempt(scope))
      return { status: 'deferred', reason: 'budget_exhausted' };
    if (!this.initialized) return { status: 'unavailable', reason: 'missing_store' };
    let failed = false;
    let failure: unknown;
    const check = () => {
      if (failed) throw failure;
      if (!canUseAutomaticClaimReadScope(scope)) {
        failed = true;
        failure = new Error('Engram compositional capture: budget_exhausted');
        throw failure;
      }
    };
    const charge = createNeo4jCompositionalReadChargeV3(scope, check);
    const read: CompositionalNativeReadV3 = {
      check,
      episodeOrder: 'recent',
      charge(value) {
        try {
          charge(value);
        } catch (error) {
          failed = true;
          failure = error;
          throw error;
        }
      },
    };
    let firstAttempt = true;
    const beforeAttempt = () => {
      check();
      if (firstAttempt) firstAttempt = false;
      else if (!beginAutomaticClaimReadAttempt(scope)) {
        failed = true;
        failure = new Error('Engram compositional capture: budget_exhausted');
        throw failure;
      }
      check();
    };
    try {
      check();
      const session = this.getSession();
      try {
        const snapshot = await this.readAutomaticCaptureSnapshot(
          session,
          check,
          read,
          beforeAttempt,
        );
        check();
        const result = CompositionalRetrievalSnapshotV3Schema.parse({
          status: 'snapshot',
          ...snapshot,
        });
        check();
        return result;
      } finally {
        await session.close();
        check();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (message.includes('budget_exhausted'))
        return { status: 'deferred', reason: 'budget_exhausted' };
      if (message.includes('snapshot_limit'))
        return { status: 'deferred', reason: 'resource_exhausted' };
      if (message.includes('concurrent_snapshot'))
        return { status: 'deferred', reason: 'concurrent_snapshot' };
      if (
        message.includes('invalid_') ||
        message.includes('record_normalization') ||
        (error instanceof Error && error.name === 'ZodError')
      )
        return { status: 'invalid', reason: 'invalid_snapshot' };
      return { status: 'unavailable', reason: 'storage_error' };
    }
  }

  async completeCompositionalHumanCaptureV3(
    handle: PrivateOneUseCompositionalCaptureLeaseHandleV3,
  ): Promise<CompositionalCaptureCompletionInternalResultV3> {
    const registry = this.compositionalCaptureHandlesV3;
    const stopped = (reason: string): CompositionalCaptureCompletionInternalResultV3 => {
      const kind = compositionalCaptureCompletionDecisionKindV3(reason);
      const parsed = CompositionalCaptureNonPermitDecisionV3Schema.safeParse({
        kind,
        eligibleFirstCommit: false,
      });
      return parsed.success ? parsed.data : { kind: 'invalid_plan', eligibleFirstCommit: false };
    };
    let capability: ReturnType<typeof registry.consumeForCompletion>;
    try {
      capability = registry.consumeForCompletion(
        handle,
        hashAutomaticCaptureV2({
          domain: 'engram-compositional-completion-audit-v3',
          nonce: generateUuid(),
        }),
      );
    } catch {
      return stopped('invalid_handle');
    }
    const budget = { remaining: 512, deferred: 0 };
    const scope = getAutomaticClaimReadScope(budget);
    let readFailed = false;
    let readFailure: unknown;
    const check = () => {
      if (readFailed) throw readFailure;
      registry.readActiveConsumedInvocation(capability);
      if (!canUseAutomaticClaimReadScope(scope))
        throw new Error('Engram compositional capture: budget_exhausted');
    };
    const charge = createNeo4jCompositionalReadChargeV3(scope, check);
    const read: CompositionalNativeReadV3 = {
      check,
      begin() {
        check();
        if (!beginAutomaticClaimReadAttempt(scope))
          throw new Error('Engram compositional capture: budget_exhausted');
      },
      charge(value) {
        try {
          charge(value);
        } catch (error) {
          readFailed = true;
          readFailure = error;
          throw error;
        }
      },
    };
    const invocation = registry.readConsumedInvocation(capability);
    const storeHash = neo4jAutomaticCaptureStoreHash(this.originalConfiguredUri, this.database);
    if (!this.initialized || !storeHash) return stopped('unsupported_mode');
    if (storeHash !== invocation.storeHash) return stopped('invalid_input');
    const epoch = generateUuid();
    const clock = async (tx: ManagedTransaction): Promise<string> => {
      check();
      const result = await tx.run('RETURN datetime.realtime().epochMillis AS now');
      check();
      const value: unknown = result.records[0]?.get('now');
      const ms = neo4j.isInt(value) ? value.toNumber() : value;
      if (
        typeof ms !== 'number' ||
        !Number.isSafeInteger(ms) ||
        !Number.isFinite(new Date(ms).getTime())
      )
        throw new Error('Engram compositional capture: backend_clock_invalid');
      return new Date(ms).toISOString();
    };
    let acknowledged = false;
    try {
      check();
      const session = this.getSession();
      try {
        try {
          await this.executeWrite(session, async (tx) => {
            check();
            const graph = await this.graphInTransaction(tx, undefined, 'automatic_capture', read);
            const operation = graph.automatic_operations_v1?.operations.find((op) => {
              check();
              return op.operationId === invocation.boundFence.operationId;
            });
            if (!operation || operation.version !== 3)
              throw new RollbackCompositionalCaptureCompleteV3(stopped('fenced'));
            if (
              operation.state === 'committed' &&
              operation.completionCallHash === invocation.completionCallHash
            )
              throw new RollbackCompositionalCaptureCompleteV3('ack_only');
            if (operation.state !== 'leased')
              throw new RollbackCompositionalCaptureCompleteV3(stopped('fenced'));
            const actual = {
              storeHash,
              namespace: invocation.namespace,
              graph,
              operation,
              backendNow: await clock(tx),
            };
            const prepared = registry.prepareBundleStage(capability, actual, budget);
            let terminal:
              | typeof operation
              | ReturnType<typeof buildCommittedCompositionalCaptureOperationV3>;
            let entities: GraphData['entities'] = [];
            let edges: GraphData['edges'] = [];
            if (prepared.status === 'prepared_stage') {
              const applied = registry.prepareBundleApply(capability, prepared.stage, {
                ...actual,
                backendNow: await clock(tx),
              });
              if (applied.status !== 'prepared_apply')
                throw new RollbackCompositionalCaptureCompleteV3(stopped(applied.reason));
              terminal = applied.candidate.operation as ReturnType<
                typeof buildCommittedCompositionalCaptureOperationV3
              >;
              entities = applied.candidate.plan.createEntities;
              edges = applied.candidate.plan.createEdges;
            } else if (prepared.reason === 'source_verdict_required') {
              // At most two bounded interpretations on this branch, same cap/scope.
              const witness = registry.prepareSourceVerdictWitness(capability, actual);
              if (!witness)
                throw new RollbackCompositionalCaptureCompleteV3(stopped('invalid_plan'));
              const receipt = registry.prepareSourceVerdictReceipt(capability, witness, {
                ...actual,
                backendNow: await clock(tx),
              });
              if (!receipt) throw new RollbackCompositionalCaptureCompleteV3(stopped('fenced'));
              terminal = buildCommittedCompositionalCaptureOperationV3(
                {
                  leasedOperation: operation,
                  terminalReceipt: receipt,
                  completionCallHash: invocation.completionCallHash,
                  audit: registry.readAttemptAudit(invocation.audit),
                },
                check,
              );
            } else {
              throw new RollbackCompositionalCaptureCompleteV3(stopped(prepared.reason));
            }
            check();
            const candidate: GraphData = {
              ...graph,
              ...(entities.length || edges.length
                ? { metadata: { ...graph.metadata, extraction_epoch: epoch } }
                : {}),
              entities: [...graph.entities, ...entities],
              edges: [...graph.edges, ...edges],
              automatic_operations_v1: {
                version: 1,
                operations: graph.automatic_operations_v1!.operations.map((op) => {
                  check();
                  return op.operationId === terminal.operationId ? terminal : op;
                }),
              },
            };
            assertCompositionalRecordIdentityV3(candidate, check);
            const validated = validateAutomaticCaptureCandidate(candidate, check);
            if (!validated) throw new RollbackCompositionalCaptureCompleteV3(stopped('capacity'));
            await this.writeExtractionDiff(tx, graph, validated, check);
            if (entities.length || edges.length) {
              await tx.run("MATCH (l:EngramStoreLock {id:'extraction-v1'}) SET l.epoch=$epoch", {
                epoch,
              });
              check();
            }
            check();
          });
          acknowledged = true;
        } catch (error) {
          check();
          if (error instanceof CompositionalCaptureTerminalOperationFailureV3) throw error;
          if (
            error instanceof RollbackCompositionalCaptureCompleteV3 &&
            error.outcome !== 'ack_only'
          )
            return error.outcome;
          // One same-call coherent read; never repeat a write after an unknown acknowledgement.
        }
        check();
        const snapshot = await this.readAutomaticCaptureSnapshot(session, check, read);
        const operation = snapshot.graph.automatic_operations_v1?.operations.find((op) => {
          check();
          return op.operationId === invocation.boundFence.operationId;
        });
        if (!operation || operation.version !== 3) return stopped('acknowledgement_unknown');
        const actual = { ...snapshot, operation, storeHash, namespace: invocation.namespace };
        const proof = acknowledged
          ? registry.confirmInitialCommitAfterAcknowledgement(capability, actual)
          : registry.recoverInitialCommitAfterUnknownAcknowledgement(capability, actual);
        check();
        return proof
          ? (registry.createInitialFirstCommitResult(proof) ?? stopped('acknowledgement_unknown'))
          : stopped('acknowledgement_unknown');
      } finally {
        await session.close();
        check();
      }
    } catch (error) {
      registry.markInvocationCancelled(capability);
      if (error instanceof CompositionalCaptureTerminalOperationFailureV3)
        return stopped(error.reason);
      return stopped(
        error instanceof Error && error.message.includes('budget_exhausted')
          ? 'budget_exhausted'
          : error instanceof Error && error.message.includes('snapshot_limit')
            ? 'resource_exhausted'
            : 'acknowledgement_unknown',
      );
    }
  }

  async reviewCompositionalClaimV3(
    input: CompositionalClaimReviewRequestV3,
  ): Promise<CompositionalClaimReviewResultV3> {
    let request: CompositionalClaimReviewRequestV3;
    try {
      request = CompositionalClaimReviewRequestV3Schema.parse(
        cloneBoundedAutomaticCaptureJson(input, 'beginRequest'),
      );
    } catch {
      return { kind: 'decision', reason: 'invalid_input' };
    }
    const storeHash = neo4jAutomaticCaptureStoreHash(this.originalConfiguredUri, this.database);
    if (!this.initialized || !storeHash) return { kind: 'decision', reason: 'unsupported_mode' };
    try {
      const session = this.getSession();
      try {
        return await this.executeWrite<CompositionalClaimReviewResultV3>(session, async (tx) => {
          const graph = await this.graphInTransaction(tx, undefined, 'automatic_capture');
          if (graph.group_id === undefined) delete graph.group_id;
          const clock = await tx.run('RETURN datetime.realtime().epochMillis AS now');
          const epoch = cypherIntegerNumber(clock.records[0]?.get('now'));
          if (!Number.isSafeInteger(epoch) || !Number.isFinite(new Date(epoch).getTime()))
            throw new RollbackCompositionalClaimReview({
              kind: 'decision',
              reason: 'backend_clock_invalid',
            });
          const prepared = prepareCompositionalClaimReviewV3(graph, request, {
            storeHash,
            backendNow: new Date(epoch).toISOString(),
          });
          if (prepared.kind === 'decision') throw new RollbackCompositionalClaimReview(prepared);
          if (prepared.kind === 'unchanged')
            throw new RollbackCompositionalClaimReview({
              kind: 'unchanged',
              edge: prepared.pair.edge,
              valueId: prepared.pair.value.uuid,
            });
          const candidate = validateAutomaticCaptureCandidate(
            {
              ...graph,
              edges: graph.edges.map((row) =>
                row.uuid === prepared.pair.edge.uuid ? prepared.pair.edge : row,
              ),
              entities: graph.entities.map((row) =>
                row.uuid === prepared.pair.value.uuid ? prepared.pair.value : row,
              ),
            },
            () => {},
          );
          if (!candidate)
            throw new RollbackCompositionalClaimReview({ kind: 'decision', reason: 'capacity' });
          await this.writeExtractionDiff(tx, graph, candidate);
          return {
            kind: 'reviewed',
            edge: prepared.pair.edge,
            valueId: prepared.pair.value.uuid,
          };
        });
      } finally {
        await session.close();
      }
    } catch (error) {
      if (error instanceof RollbackCompositionalClaimReview) return error.result;
      return { kind: 'acknowledgement_unknown' };
    }
  }

  async updateEdge(uuid: string, updates: Partial<EntityEdge>): Promise<EntityEdge> {
    const session = this.getSession();
    try {
      const setClauses: string[] = ['r.updated_at = $updated_at'];
      const params: Record<string, unknown> = {
        uuid,
        updated_at: nowIso(),
      };

      if (updates.name !== undefined) {
        setClauses.push('r.name = $name');
        params.name = updates.name;
      }
      if (updates.fact !== undefined) {
        setClauses.push('r.fact = $fact');
        params.fact = updates.fact;
      }
      if (updates.valid_at !== undefined) {
        setClauses.push('r.valid_at = $valid_at');
        params.valid_at = updates.valid_at;
      }
      if (updates.invalid_at !== undefined) {
        setClauses.push('r.invalid_at = $invalid_at');
        params.invalid_at = updates.invalid_at;
      }
      if (updates.expired_at !== undefined) {
        setClauses.push('r.expired_at = $expired_at');
        params.expired_at = updates.expired_at;
      }
      if (updates.episodes !== undefined) {
        setClauses.push('r.episodes = $episodes');
        params.episodes = updates.episodes;
      }
      if (updates.attributes !== undefined) {
        setClauses.push('r.attributes = $attributes');
        params.attributes = JSON.stringify(updates.attributes);
      }
      if (updates.fact_embedding !== undefined) {
        setClauses.push('r.fact_embedding = $fact_embedding');
        params.fact_embedding = updates.fact_embedding;
        if (updates.fact_embedding && updates.fact_embedding.length > 0) {
          await this.ensureVectorIndex(updates.fact_embedding.length);
        }
      }

      const result = await this.executeWrite(session, async (tx) => {
        if (updates.attributes !== undefined) {
          const existing = await tx.run('MATCH ()-[r:RELATES_TO {uuid: $uuid}]->() RETURN r', {
            uuid,
          });
          if (existing.records.length === 0) throw new Error(`Edge not found: ${uuid}`);
          const oldEdge = this.recordToEdge(existing.records[0].get('r').properties);
          assertReservedAttributeReplacementAllowed(oldEdge.attributes, updates.attributes);
        }
        return tx.run(
          `MATCH ()-[r:RELATES_TO {uuid: $uuid}]->()
					 SET ${setClauses.join(', ')}
					 RETURN r`,
          params,
        );
      });

      if (result.records.length === 0) {
        throw new Error(`Edge not found: ${uuid}`);
      }

      return this.recordToEdge(result.records[0].get('r').properties);
    } finally {
      await session.close();
    }
  }

  async deleteEdge(uuid: string): Promise<void> {
    const session = this.getSession();
    try {
      await this.executeWrite(session, async (tx) => {
        await tx.run('MATCH ()-[r:RELATES_TO {uuid: $uuid}]->() DELETE r', { uuid });
      });
    } finally {
      await session.close();
    }
  }

  // ===== Episode Operations =====

  async addEpisode(input: CreateEpisodicNode): Promise<EpisodicNode> {
    const result = await this.appendEpisodeWithOptions(input, false);
    return result.episode;
  }

  async appendEpisode(input: CreateEpisodicNode): Promise<AppendEpisodeResult> {
    return this.appendEpisodeWithOptions(input, true);
  }

  async appendEpisodes(inputs: CreateEpisodicNode[]): Promise<AppendEpisodeResult[]> {
    return this.appendEpisodesWithOptions(inputs, true);
  }

  async appendAutomaticEpisodes(inputs: CreateEpisodicNode[]): Promise<AppendEpisodeResult[]> {
    return this.appendEpisodesWithOptions(inputs, true, true);
  }

  private async appendEpisodeWithOptions(
    input: CreateEpisodicNode,
    autoChain: boolean,
  ): Promise<AppendEpisodeResult> {
    return (await this.appendEpisodesWithOptions([input], autoChain))[0];
  }

  private async appendEpisodesWithOptions(
    inputs: CreateEpisodicNode[],
    autoChain: boolean,
    allowTrustedAutomatic = false,
  ): Promise<AppendEpisodeResult[]> {
    if (inputs.length === 0) return [];
    if (inputs.length > 1000) throw new Error('Episode append batch cannot exceed 1000 episodes');

    for (const input of inputs) {
      assertNoReservedAutonomousPersonalRow(input);
      assertAutomaticEpisodeTrustedPath(input, allowTrustedAutomatic);
    }
    if (inputs.some((ep) => ep.attributes?.[QUEUE_ATTRIBUTE] !== undefined))
      throw new Error('Engram queue: reserved_attribute');
    const groupId = inputs[0].group_id;
    if (inputs.some((input) => input.group_id !== groupId)) {
      throw new Error('Episode append batch must contain exactly one group ID');
    }

    const prepared = inputs.map((input) => ({
      uuid: generateUuid(),
      shouldAutoChain:
        autoChain && !Object.prototype.hasOwnProperty.call(input, 'previous_episode_uuid'),
      parsed: CreateEpisodicNodeSchema.parse(
        allowTrustedAutomatic ? prepareAutomaticEpisodeInput(input) : input,
      ),
    }));

    const session = this.getSession();
    try {
      return await this.executeWrite(session, async (tx) => {
        if (
          allowTrustedAutomatic &&
          prepared.some(
            ({ parsed }) =>
              Object.prototype.hasOwnProperty.call(parsed.attributes, SOURCE_ENVELOPE_ATTRIBUTE) ||
              Object.prototype.hasOwnProperty.call(parsed.attributes, WRITE_OWNER_ATTRIBUTE),
          )
        ) {
          const graph = await this.graphInTransaction(tx);
          for (const item of prepared) assertAutomaticEpisodeBinding(graph, item.parsed);
        }
        const lockResult = await tx.run(
          `MERGE (lock:EpisodeGroupLock {group_id: $group_id})
           SET lock.sequence = coalesce(lock.sequence, 0) + $batch_size,
               lock.updated_at = $updated_at
           RETURN lock.sequence AS sequence`,
          {
            group_id: groupId,
            batch_size: neo4j.int(prepared.length),
            updated_at: nowIso(),
          },
        );
        const sequenceValue = lockResult.records[0]?.get('sequence');
        const finalSequence = neo4j.isInt(sequenceValue)
          ? sequenceValue.toNumber()
          : Number(sequenceValue ?? prepared.length);
        const firstSequence = finalSequence - prepared.length + 1;
        const results: AppendEpisodeResult[] = [];

        for (const [index, item] of prepared.entries()) {
          results.push(
            await this.appendEpisodeInTransaction(
              tx,
              item.parsed,
              item.shouldAutoChain,
              firstSequence + index,
              item.uuid,
            ),
          );
        }
        return results;
      });
    } finally {
      await session.close();
    }
  }

  private async appendEpisodeInTransaction(
    tx: ManagedTransaction,
    parsed: ReturnType<typeof CreateEpisodicNodeSchema.parse>,
    shouldAutoChain: boolean,
    appendSequence: number,
    preparedUuid?: string,
  ): Promise<AppendEpisodeResult> {
    if (parsed.attributes[QUEUE_ATTRIBUTE] !== undefined)
      throw new Error('Engram queue: reserved_attribute');
    const sourceDedupKey = this.sourceDedupKey(parsed);
    const idempotencyDedupKey = this.idempotencyDedupKey(parsed);

    if (sourceDedupKey || idempotencyDedupKey) {
      const existingResult = await tx.run(
        `MATCH (ep:Episode)
         WHERE ($source_dedup_key IS NOT NULL AND ep.source_dedup_key = $source_dedup_key)
            OR ($idempotency_dedup_key IS NOT NULL AND ep.idempotency_dedup_key = $idempotency_dedup_key)
         RETURN ep`,
        {
          source_dedup_key: sourceDedupKey,
          idempotency_dedup_key: idempotencyDedupKey,
        },
      );
      const existingEpisodes = new Map<string, EpisodicNode>();
      for (const record of existingResult.records) {
        const existing = this.recordToEpisode(record.get('ep').properties);
        existingEpisodes.set(existing.uuid, existing);
      }
      if (existingEpisodes.size > 1) {
        throw new Error('Episode idempotency identifiers resolve to different existing episodes');
      }
      const existing = existingEpisodes.values().next().value as EpisodicNode | undefined;
      if (existing) {
        assertOwnedEpisodeReplay(existing, parsed);
        return { episode: protectAutomaticEpisode(existing), created: false };
      }
    }

    let previousEpisodeUuid = parsed.previous_episode_uuid;
    if (shouldAutoChain) {
      const previousResult = await tx.run(
        `MATCH (ep:Episode {group_id: $group_id})
         RETURN ep.uuid AS uuid
         ORDER BY coalesce(ep.append_sequence, 0) DESC, ep.created_at DESC, ep.uuid DESC
         LIMIT 1`,
        { group_id: parsed.group_id },
      );
      previousEpisodeUuid = (previousResult.records[0]?.get('uuid') as string | undefined) ?? null;
    }

    const createdAt = nowIso();
    const episode = protectAutomaticEpisode({
      uuid: preparedUuid ?? generateUuid(),
      ...parsed,
      previous_episode_uuid: previousEpisodeUuid,
      created_at: createdAt,
      updated_at: createdAt,
    });

    await tx.run(
      `CREATE (ep:Episode {
							uuid: $uuid,
						group_id: $group_id,
						content: $content,
						role: $role,
						source_type: $source_type,
						reference_time: $reference_time,
						previous_episode_uuid: $previous_episode_uuid,
						created_at: $created_at,
						updated_at: $updated_at,
						source_message_id: $source_message_id,
						idempotency_key: $idempotency_key,
						conversation_id: $conversation_id,
						sender_id: $sender_id,
						sender_name: $sender_name,
						episode_kind: $episode_kind,
						quoted_message_id: $quoted_message_id,
						trust_level: $trust_level,
						confidence: $confidence,
						review_status: $review_status,
						source_workflow_id: $source_workflow_id,
						source_execution_id: $source_execution_id,
						attributes: $attributes,
						append_sequence: $append_sequence,
						source_dedup_key: $source_dedup_key,
						idempotency_dedup_key: $idempotency_dedup_key
						})`,
      {
        ...episode,
        attributes: JSON.stringify(episode.attributes),
        append_sequence: appendSequence,
        source_dedup_key: sourceDedupKey,
        idempotency_dedup_key: idempotencyDedupKey,
      },
    );

    if (episode.previous_episode_uuid) {
      await tx.run(
        `MATCH (prev:Episode {uuid: $prevUuid})
							 MATCH (curr:Episode {uuid: $currUuid})
							 CREATE (prev)-[:NEXT_EPISODE]->(curr)`,
        {
          prevUuid: episode.previous_episode_uuid,
          currUuid: episode.uuid,
        },
      );
    }

    return { episode, created: true };
  }

  async getEpisode(uuid: string): Promise<EpisodicNode | null> {
    const session = this.getSession();
    try {
      const result = await session.executeRead(async (tx) => {
        return tx.run('MATCH (ep:Episode {uuid: $uuid}) RETURN ep', { uuid });
      });

      if (result.records.length === 0) return null;
      return this.recordToEpisode(result.records[0].get('ep').properties);
    } finally {
      await session.close();
    }
  }

  async getEpisodes(uuids: string[]): Promise<EpisodicNode[]> {
    const uniqueUuids = [...new Set(uuids)];
    if (uniqueUuids.length === 0) return [];
    const session = this.getSession();
    try {
      const result = await session.executeRead((tx) =>
        tx.run('MATCH (ep:Episode) WHERE ep.uuid IN $uuids RETURN ep', { uuids: uniqueUuids }),
      );
      return result.records.map((record) => this.recordToEpisode(record.get('ep').properties));
    } finally {
      await session.close();
    }
  }

  async listEpisodes(groupId: string, options: EpisodeFilterOptions = {}): Promise<EpisodicNode[]> {
    const { query, params } = this.buildEpisodeListQuery(groupId, options);

    const session = this.getSession();
    try {
      const result = await session.executeRead((tx) => tx.run(query, params));
      return result.records.map((record) => this.recordToEpisode(record.get('ep').properties));
    } finally {
      await session.close();
    }
  }

  async updateEpisode(uuid: string, updates: UpdateEpisodeInput): Promise<EpisodicNode> {
    const session = this.getSession();
    try {
      return await this.executeWrite(session, async (tx) => {
        const existingResult = await tx.run('MATCH (ep:Episode {uuid: $uuid}) RETURN ep', { uuid });
        if (existingResult.records.length === 0) throw new Error(`Episode not found: ${uuid}`);
        const existing = this.recordToEpisode(existingResult.records[0].get('ep').properties);
        assertNoQueueMutation([existing]);
        if (updates.attributes !== undefined)
          assertReservedAttributeReplacementAllowed(existing.attributes, updates.attributes);
        if (updates.attributes?.[QUEUE_ATTRIBUTE] !== undefined)
          throw new Error('Engram queue: reserved_attribute');
        const safeUpdates = prepareAutomaticEpisodeUpdate(existing, updates);
        await this.lockEpisodeGroup(tx, existing.group_id);

        const updated = EpisodicNodeSchema.parse({
          ...existing,
          ...safeUpdates,
          uuid: existing.uuid,
          group_id: existing.group_id,
          source_message_id: existing.source_message_id,
          idempotency_key: existing.idempotency_key,
          episode_kind: existing.episode_kind,
          previous_episode_uuid: existing.previous_episode_uuid,
          created_at: existing.created_at,
          updated_at: nowIso(),
        });
        const result = await tx.run(
          `MATCH (ep:Episode {uuid: $uuid})
           SET ep.content = $content,
               ep.sender_name = $sender_name,
               ep.trust_level = $trust_level,
               ep.confidence = $confidence,
               ep.review_status = $review_status,
               ep.attributes = $attributes,
               ep.updated_at = $updated_at
           RETURN ep`,
          { ...updated, attributes: JSON.stringify(updated.attributes) },
        );
        return this.recordToEpisode(result.records[0].get('ep').properties);
      });
    } finally {
      await session.close();
    }
  }

  async deleteEpisode(
    uuid: string,
    options: DeleteEpisodeOptions = {},
  ): Promise<DeleteEpisodeResult> {
    const session = this.getSession();
    try {
      return await this.executeWrite(session, (tx) =>
        this.deleteEpisodeInTransaction(tx, uuid, options),
      );
    } finally {
      await session.close();
    }
  }

  async purgeEpisodes(
    groupId: string,
    filters: EpisodeFilterOptions,
    options: PurgeEpisodesOptions,
  ): Promise<PurgeEpisodesResult> {
    if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 10000) {
      throw new Error('Episode purge limit must be an integer between 1 and 10000');
    }

    const selectionOptions: EpisodeFilterOptions = {
      ...filters,
      offset: 0,
      limit: options.limit + 1,
    };
    if (options.dry_run) {
      const selected = await this.listEpisodes(groupId, selectionOptions);
      const truncated = selected.length > options.limit;
      const episodes = selected.slice(0, options.limit);
      const episodeUuids = episodes.map((episode) => episode.uuid);
      const linkedEdgeCount = await this.countEdgesLinkedToEpisodes(episodeUuids);
      return {
        matched_count: episodes.length,
        deleted_count: 0,
        truncated,
        dry_run: true,
        linked_edge_count: linkedEdgeCount,
        updated_edge_count: 0,
        deleted_edge_count: 0,
        episode_uuids: episodeUuids,
      };
    }

    const session = this.getSession();
    try {
      return await this.executeWrite(session, async (tx) => {
        await this.lockEpisodeGroup(tx, groupId);
        const { query, params } = this.buildEpisodeListQuery(groupId, selectionOptions);
        const selectedResult = await tx.run(query, params);
        const selected = selectedResult.records.map((record) =>
          this.recordToEpisode(record.get('ep').properties),
        );
        const truncated = selected.length > options.limit;
        const episodes = selected.slice(0, options.limit);
        const episodeUuids = episodes.map((episode) => episode.uuid);
        const linkedEdgeCount = await this.countEdgesLinkedToEpisodesInTransaction(
          tx,
          episodeUuids,
        );
        const results: DeleteEpisodeResult[] = [];
        for (const uuid of episodeUuids) {
          results.push(await this.deleteEpisodeInTransaction(tx, uuid, options, true));
        }
        return {
          matched_count: episodes.length,
          deleted_count: results.filter((result) => result.deleted).length,
          truncated,
          dry_run: false,
          linked_edge_count: linkedEdgeCount,
          updated_edge_count: results.reduce(
            (total, result) => total + result.updated_edge_count,
            0,
          ),
          deleted_edge_count: results.reduce(
            (total, result) => total + result.deleted_edge_count,
            0,
          ),
          episode_uuids: episodeUuids,
        };
      });
    } finally {
      await session.close();
    }
  }

  async getRecentEpisodes(groupId: string, limit: number): Promise<EpisodicNode[]> {
    const session = this.getSession();
    try {
      const result = await session.executeRead(async (tx) => {
        return tx.run(
          `MATCH (ep:Episode {group_id: $groupId})
					 RETURN ep
					 ORDER BY coalesce(ep.append_sequence, 0) DESC, ep.created_at DESC, ep.uuid DESC
					 LIMIT $limit`,
          { groupId, limit: neo4j.int(limit) },
        );
      });

      const episodes = result.records.map((r) => this.recordToEpisode(r.get('ep').properties));

      // Return in chronological order (oldest first)
      return episodes.reverse();
    } finally {
      await session.close();
    }
  }

  async getEpisodeCount(groupId: string, filters: EpisodeFilterOptions = {}): Promise<number> {
    const { where, params } = this.buildEpisodeFilter('ep', groupId, filters);
    const session = this.getSession();
    try {
      const result = await session.executeRead(async (tx) => {
        return tx.run(`MATCH (ep:Episode) WHERE ${where} RETURN count(ep) as cnt`, params);
      });

      return result.records[0]?.get('cnt').toNumber() ?? 0;
    } finally {
      await session.close();
    }
  }

  async getEpisodesByDateRange(
    groupId: string,
    from: string,
    to: string,
    limit?: number,
  ): Promise<EpisodicNode[]> {
    const session = this.getSession();
    try {
      let cypher = `MATCH (ep:Episode {group_id: $groupId})
				WHERE ep.reference_time >= $from AND ep.reference_time <= $to
				RETURN ep
				ORDER BY ep.reference_time ASC`;

      const params: Record<string, unknown> = { groupId, from, to };

      if (limit) {
        cypher += ' LIMIT $limit';
        params.limit = neo4j.int(limit);
      }

      const result = await session.executeRead(async (tx) => {
        return tx.run(cypher, params);
      });

      return result.records.map((r) => this.recordToEpisode(r.get('ep').properties));
    } finally {
      await session.close();
    }
  }

  // ===== Changelog =====

  async getEdgeChangelog(
    groupId: string,
    since: string,
    options?: { limit?: number },
  ): Promise<ChangelogEntry[]> {
    const session = this.getSession();
    try {
      const cypher = `MATCH (source:Entity)-[r:RELATES_TO]->(target:Entity)
				WHERE r.group_id = $groupId AND (
					r.created_at >= $since
					OR (r.expired_at IS NOT NULL AND r.expired_at >= $since)
					OR (r.invalid_at IS NOT NULL AND r.invalid_at >= $since)
				)
				RETURN r, source, target
				ORDER BY r.updated_at DESC`;

      const result = await session.executeRead(async (tx) => {
        return tx.run(cypher, { groupId, since });
      });

      const entries: ChangelogEntry[] = [];
      const sinceTs = new Date(since).getTime();

      for (const rec of result.records) {
        const edge = this.recordToEdge(rec.get('r').properties);
        const sourceEntity = this.recordToEntity(rec.get('source').properties);
        const targetEntity = this.recordToEntity(rec.get('target').properties);

        if (new Date(edge.created_at).getTime() >= sinceTs) {
          entries.push({
            edge,
            sourceEntity,
            targetEntity,
            change_type: 'created',
            changed_at: edge.created_at,
          });
        }

        if (edge.expired_at && new Date(edge.expired_at).getTime() >= sinceTs) {
          entries.push({
            edge,
            sourceEntity,
            targetEntity,
            change_type: 'expired',
            changed_at: edge.expired_at,
          });
        } else if (
          edge.invalid_at &&
          new Date(edge.invalid_at).getTime() >= sinceTs &&
          !edge.expired_at
        ) {
          entries.push({
            edge,
            sourceEntity,
            targetEntity,
            change_type: 'invalidated',
            changed_at: edge.invalid_at,
          });
        }
      }

      entries.sort((a, b) => new Date(b.changed_at).getTime() - new Date(a.changed_at).getTime());
      const limit = options?.limit ?? entries.length;
      return entries.slice(0, limit);
    } finally {
      await session.close();
    }
  }

  // ===== Search =====

  /** Escape Lucene special characters so user input doesn't cause parse errors */
  private sanitizeLuceneQuery(query: string): string {
    // Lucene special chars: + - && || ! ( ) { } [ ] ^ " ~ * ? : \ /
    const sanitized = query.replace(/[+\-&|!(){}[\]^"~*?:\\/]/g, (ch) => `\\${ch}`);
    return sanitized.trim();
  }

  async searchEntities(
    query: string,
    groupId: string,
    options?: EntitySearchOptions,
  ): Promise<EntitySearchResult[]> {
    const safeQuery = this.sanitizeLuceneQuery(query);
    if (!safeQuery) return [];

    const limit = options?.limit ?? 10;
    const session = this.getSession();
    try {
      let cypher = `CALL db.index.fulltext.queryNodes('entitySearch', $query)
				YIELD node, score
				WHERE node.group_id = $groupId`;

      const params: Record<string, unknown> = { query: safeQuery, groupId };

      if (options?.entity_type) {
        cypher += ' AND node.entity_type = $entityType';
        params.entityType = options.entity_type;
      }
      if (options?.created_after) {
        cypher += ' AND node.created_at >= $createdAfter';
        params.createdAfter = options.created_after;
      }
      if (options?.created_before) {
        cypher += ' AND node.created_at <= $createdBefore';
        params.createdBefore = options.created_before;
      }

      cypher += ' RETURN node, score ORDER BY score DESC LIMIT $limit';
      params.limit = neo4j.int(limit);

      const result = await session.executeRead(async (tx) => {
        return tx.run(cypher, params);
      });

      const maxScore = result.records.length > 0 ? (result.records[0].get('score') as number) : 1;

      return result.records
        .filter((r) => {
          const score = (r.get('score') as number) / (maxScore || 1);
          return score >= (options?.min_score ?? 0);
        })
        .map((r) => ({
          entity: this.recordToEntity(r.get('node').properties),
          score: (r.get('score') as number) / (maxScore || 1),
        }));
    } finally {
      await session.close();
    }
  }

  async searchEdges(
    query: string,
    groupId: string,
    options?: EdgeSearchOptions,
  ): Promise<EdgeSearchResult[]> {
    const safeQuery = this.sanitizeLuceneQuery(query);
    if (!safeQuery) return [];

    const limit = options?.limit ?? 10;
    const includeExpired = options?.include_expired ?? false;
    const session = this.getSession();
    try {
      let cypher = `CALL db.index.fulltext.queryRelationships('edgeSearch', $query)
				YIELD relationship, score
				WHERE relationship.group_id = $groupId`;

      const params: Record<string, unknown> = {
        query: safeQuery,
        groupId,
        limit: neo4j.int(limit),
      };

      if (!includeExpired) {
        cypher += ' AND relationship.expired_at IS NULL';
      }
      if (options?.valid_after) {
        cypher += ' AND relationship.valid_at >= $validAfter';
        params.validAfter = options.valid_after;
      }
      if (options?.valid_before) {
        cypher += ' AND relationship.valid_at <= $validBefore';
        params.validBefore = options.valid_before;
      }
      if (options?.created_after) {
        cypher += ' AND relationship.created_at >= $createdAfter';
        params.createdAfter = options.created_after;
      }
      if (options?.created_before) {
        cypher += ' AND relationship.created_at <= $createdBefore';
        params.createdBefore = options.created_before;
      }

      cypher += ` WITH relationship, score
				ORDER BY score DESC LIMIT $limit
				MATCH (source:Entity {uuid: relationship.source_node_uuid})
				MATCH (target:Entity {uuid: relationship.target_node_uuid})
				RETURN relationship, source, target, score`;

      const result = await session.executeRead(async (tx) => {
        return tx.run(cypher, params);
      });

      const maxScore = result.records.length > 0 ? (result.records[0].get('score') as number) : 1;

      return result.records
        .filter((r) => {
          const score = (r.get('score') as number) / (maxScore || 1);
          return score >= (options?.min_score ?? 0);
        })
        .map((r) => ({
          edge: this.recordToEdge(r.get('relationship').properties),
          sourceEntity: this.recordToEntity(r.get('source').properties),
          targetEntity: this.recordToEntity(r.get('target').properties),
          score: (r.get('score') as number) / (maxScore || 1),
        }));
    } finally {
      await session.close();
    }
  }

  // ===== Vector Search =====

  /**
   * Lazily create Neo4j vector indexes on first embedding insert.
   * Wrapped in try/catch — older Neo4j versions gracefully skip.
   */
  private async ensureVectorIndex(dimensions: number): Promise<void> {
    if (this.vectorIndexCreated) return;

    const session = this.getSession();
    try {
      await session.executeWrite(async (tx) => {
        // Entity name embedding vector index (Neo4j 5.11+)
        await tx.run(
          `CREATE VECTOR INDEX entityNameEmbedding IF NOT EXISTS
					 FOR (e:Entity)
					 ON (e.name_embedding)
					 OPTIONS {indexConfig: {
						\`vector.dimensions\`: $dimensions,
						\`vector.similarity_function\`: 'cosine'
					 }}`,
          { dimensions: neo4j.int(dimensions) },
        );
        // Note: Neo4j does not support vector indexes on relationships.
        // Edge fact_embedding uses brute-force cosine similarity in searchEdgesByVector().
      });
      this.vectorIndexCreated = true;
    } catch (error) {
      // Neo4j < 5.11 doesn't support vector indexes — log and continue
      console.warn(
        'Engram: Could not create vector indexes (Neo4j may not support them):',
        (error as Error).message,
      );
    } finally {
      await session.close();
    }
  }

  async searchEntitiesByVector(
    vector: number[],
    groupId: string,
    options?: VectorSearchOptions,
  ): Promise<EntitySearchResult[]> {
    const limit = options?.limit ?? 10;
    const minScore = options?.min_score ?? 0;

    // Try native vector index first
    const session = this.getSession();
    try {
      const result = await session.executeRead(async (tx) => {
        return tx.run(
          `CALL db.index.vector.queryNodes('entityNameEmbedding', $topK, $vector)
					 YIELD node, score
					 WHERE node.group_id = $groupId AND score >= $minScore
					 RETURN node, score
					 ORDER BY score DESC
					 LIMIT $limit`,
          {
            vector,
            groupId,
            topK: neo4j.int(limit * 2),
            minScore,
            limit: neo4j.int(limit),
          },
        );
      });

      return result.records.map((r) => ({
        entity: this.recordToEntity(r.get('node').properties),
        score: r.get('score') as number,
      }));
    } catch {
      // Vector index doesn't exist — fall back to brute-force
      return this.bruteForceEntityVectorSearch(vector, groupId, options);
    } finally {
      await session.close();
    }
  }

  async searchEdgesByVector(
    vector: number[],
    groupId: string,
    options?: VectorSearchOptions,
  ): Promise<EdgeSearchResult[]> {
    const limit = options?.limit ?? 10;
    const minScore = options?.min_score ?? 0;

    // Brute-force approach for edges — Neo4j vector indexes on relationships
    // are less reliably supported across versions
    const session = this.getSession();
    try {
      const result = await session.executeRead(async (tx) => {
        return tx.run(
          `MATCH (source:Entity)-[r:RELATES_TO]->(target:Entity)
					 WHERE r.group_id = $groupId
					   AND r.fact_embedding IS NOT NULL
					   AND r.expired_at IS NULL
					 RETURN r, source, target`,
          { groupId },
        );
      });

      const scored: EdgeSearchResult[] = [];
      for (const rec of result.records) {
        const edgeProps = rec.get('r').properties;
        const embedding = edgeProps.fact_embedding as number[] | null;
        if (!embedding || embedding.length !== vector.length) continue;

        try {
          const score = cosineSimilarity(vector, embedding);
          if (score < minScore) continue;

          scored.push({
            edge: this.recordToEdge(edgeProps),
            sourceEntity: this.recordToEntity(rec.get('source').properties),
            targetEntity: this.recordToEntity(rec.get('target').properties),
            score,
          });
        } catch {
          // Skip edges with incompatible embedding dimensions
        }
      }

      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, limit);
    } finally {
      await session.close();
    }
  }

  private async bruteForceEntityVectorSearch(
    vector: number[],
    groupId: string,
    options?: VectorSearchOptions,
  ): Promise<EntitySearchResult[]> {
    const limit = options?.limit ?? 10;
    const minScore = options?.min_score ?? 0;

    const session = this.getSession();
    try {
      const result = await session.executeRead(async (tx) => {
        return tx.run(
          `MATCH (e:Entity {group_id: $groupId})
					 WHERE e.name_embedding IS NOT NULL
					 RETURN e`,
          { groupId },
        );
      });

      const scored: EntitySearchResult[] = [];
      for (const rec of result.records) {
        const entity = this.recordToEntity(rec.get('e').properties);
        if (!entity.name_embedding || entity.name_embedding.length !== vector.length) continue;

        try {
          const score = cosineSimilarity(vector, entity.name_embedding);
          if (score >= minScore) {
            scored.push({ entity, score });
          }
        } catch {
          // Skip entities with incompatible embedding dimensions
        }
      }

      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, limit);
    } finally {
      await session.close();
    }
  }

  // ===== Graph Management =====

  private async queueClearSources(
    tx: ManagedTransaction,
    groupId?: string,
  ): Promise<Array<{ attributes: Record<string, unknown> }>> {
    const result = await tx.run(
      `MATCH (ep:Episode) WHERE ($group IS NULL OR ep.group_id=$group) AND ep.attributes CONTAINS $key RETURN ep.attributes AS attributes LIMIT 100001`,
      { group: groupId ?? null, key: QUEUE_ATTRIBUTE },
    );
    if (result.records.length > 100000) throw new Error('Engram queue: clear_preview_limit');
    return result.records.map((record) => ({
      attributes: JSON.parse(record.get('attributes') as string) as Record<string, unknown>,
    }));
  }
  async previewQueueClear(groupId?: string): Promise<QueueClearImpact> {
    const session = this.getSession();
    try {
      return await session.executeRead(async (tx) =>
        queueClearImpact(await this.queueClearSources(tx, groupId)),
      );
    } finally {
      await session.close();
    }
  }
  async clearGroup(groupId: string, options: QueueClearOptions = {}): Promise<void> {
    const reviewed = QueueClearOptionsSchema.parse(options).allowQueued;
    const session = this.getSession();
    try {
      await this.executeWrite(session, async (tx) => {
        if (!reviewed) assertQueueClear(await this.queueClearSources(tx, groupId));
        const snapshot = await this.graphInTransaction(tx, groupId);
        await this.assertNoAutonomousSource4ChainImpactInTransaction(tx, snapshot.episodes);
        assertNoAutomaticOperationChainImpact(
          snapshot.automatic_operations_v1,
          snapshot.episodes,
          snapshot.episodes.map((episode) => episode.uuid),
        );
        await tx.run(`MATCH (lock:EngramStoreLock {id:'extraction-v1'}) SET lock.epoch=$epoch`, {
          epoch: generateUuid(),
        });
        // Delete edges first
        await tx.run(
          `MATCH ()-[r:RELATES_TO {group_id: $groupId}]->()
					 DELETE r`,
          { groupId },
        );
        // Delete nodes (entities + episodes)
        await tx.run(
          `MATCH (n)
					 WHERE n.group_id = $groupId AND (n:Entity OR n:Episode)
					 DETACH DELETE n`,
          { groupId },
        );
      });
    } finally {
      await session.close();
    }
  }

  async clearAll(options: QueueClearOptions = {}): Promise<void> {
    const reviewed = QueueClearOptionsSchema.parse(options).allowQueued;
    const session = this.getSession();
    try {
      await this.executeWrite(session, async (tx) => {
        if (!reviewed) assertQueueClear(await this.queueClearSources(tx));
        const snapshot = await this.graphInTransaction(tx);
        await this.assertNoAutonomousSource4ChainImpactInTransaction(tx, snapshot.episodes, true);
        assertNoAutomaticOperationChainImpact(
          snapshot.automatic_operations_v1,
          snapshot.episodes,
          snapshot.episodes.map((episode) => episode.uuid),
        );
        await tx.run(`MATCH (lock:EngramStoreLock {id:'extraction-v1'}) SET lock.epoch=$epoch`, {
          epoch: generateUuid(),
        });
        await tx.run('MATCH (n) WHERE n:Entity OR n:Episode DETACH DELETE n');
      });
    } finally {
      await session.close();
    }
  }

  async exportGraph(groupId?: string): Promise<GraphData> {
    return this.readExtractionSnapshot(groupId);
  }

  async importGraph(sourceData: ImportGraphData): Promise<void> {
    assertNoReservedAutonomousPersonalGraph(sourceData);
    assertNoImportedAutomaticOperations(sourceData);
    const data = migrateGraphData(sourceData).data;
    assertNoQueueMutation(data.episodes);
    const session = this.getSession();
    try {
      await this.executeWrite(session, async (tx) => {
        const existing = await this.graphInTransaction(tx);
        const safeData = prepareAutomaticImport(data, existing);
        await tx.run(`MATCH (lock:EngramStoreLock {id:'extraction-v1'}) SET lock.epoch=$epoch`, {
          epoch: generateUuid(),
        });
        const existingQueueSources = await tx.run(
          'MATCH (ep:Episode) WHERE ep.uuid IN $ids RETURN ep',
          { ids: safeData.episodes.map((ep) => ep.uuid) },
        );
        assertNoQueueMutation(
          existingQueueSources.records.map((record) =>
            this.recordToEpisode(record.get('ep').properties),
          ),
        );
        // Import entities
        for (const entity of safeData.entities) {
          await tx.run(
            `MERGE (e:Entity {uuid: $uuid})
						 SET e += {
							name: $name,
							group_id: $group_id,
							summary: $summary,
							entity_type: $entity_type,
							name_embedding: $name_embedding,
							attributes: $attributes,
							created_at: $created_at,
							updated_at: $updated_at
						 }`,
            {
              ...entity,
              attributes: JSON.stringify(entity.attributes),
            },
          );
        }

        // Import episodes
        for (const episode of safeData.episodes) {
          await tx.run(
            `MERGE (ep:Episode {uuid: $uuid})
						 SET ep += {
							group_id: $group_id,
							content: $content,
							role: $role,
							source_type: $source_type,
							reference_time: $reference_time,
							previous_episode_uuid: $previous_episode_uuid,
							created_at: $created_at,
							updated_at: $updated_at,
							source_message_id: $source_message_id,
							idempotency_key: $idempotency_key,
							conversation_id: $conversation_id,
							sender_id: $sender_id,
							sender_name: $sender_name,
							episode_kind: $episode_kind,
							quoted_message_id: $quoted_message_id,
							trust_level: $trust_level,
							confidence: $confidence,
							review_status: $review_status,
							source_workflow_id: $source_workflow_id,
							source_execution_id: $source_execution_id,
							attributes: $attributes,
							source_dedup_key: $source_dedup_key,
							idempotency_dedup_key: $idempotency_dedup_key
						 }`,
            {
              ...episode,
              attributes: JSON.stringify(episode.attributes),
              source_dedup_key: this.sourceDedupKey(episode),
              idempotency_dedup_key: this.idempotencyDedupKey(episode),
            },
          );
        }

        // Import edges
        for (const edge of safeData.edges) {
          await tx.run(
            `MATCH (source:Entity {uuid: $source_node_uuid})
						 MATCH (target:Entity {uuid: $target_node_uuid})
						 MERGE (source)-[r:RELATES_TO {uuid: $uuid}]->(target)
						 SET r += {
							group_id: $group_id,
							source_node_uuid: $source_node_uuid,
							target_node_uuid: $target_node_uuid,
							name: $name,
							fact: $fact,
							fact_embedding: $fact_embedding,
							episodes: $episodes,
							valid_at: $valid_at,
							invalid_at: $invalid_at,
							expired_at: $expired_at,
							attributes: $attributes,
							created_at: $created_at,
							updated_at: $updated_at
						 }`,
            {
              ...edge,
              attributes: JSON.stringify(edge.attributes),
            },
          );
        }

        // Recreate episode chains
        for (const episode of safeData.episodes) {
          if (episode.previous_episode_uuid) {
            await tx.run(
              `MATCH (prev:Episode {uuid: $prevUuid})
							 MATCH (curr:Episode {uuid: $currUuid})
							 MERGE (prev)-[:NEXT_EPISODE]->(curr)`,
              {
                prevUuid: episode.previous_episode_uuid,
                currUuid: episode.uuid,
              },
            );
          }
        }
      });
    } finally {
      await session.close();
    }
  }

  async getMigrationStatus(): Promise<StorageMigrationStatus> {
    const legacyEpisodeCount = await this.countLegacyEpisodes();
    return {
      backend: 'neo4j',
      target_version: CURRENT_GRAPH_DATA_VERSION,
      source_version: 'database',
      migration_required: legacyEpisodeCount > 0,
      legacy_episode_count: legacyEpisodeCount,
      automatic_migration_completed: false,
      backup: { created: false, verified: false, path: null },
    };
  }

  async migrateStorageSchema(
    options: StorageSchemaMigrationOptions,
  ): Promise<StorageSchemaMigrationResult> {
    const limit = Math.min(10000, Math.max(1, Math.floor(options.limit)));
    const matchedCount = await this.countLegacyEpisodes();
    if (options.dry_run || matchedCount === 0) {
      return {
        backend: 'neo4j',
        dry_run: options.dry_run,
        matched_count: matchedCount,
        migrated_count: 0,
        remaining_count: matchedCount,
        backup_required: false,
        additive_only: true,
      };
    }

    const session = this.getSession();
    let migratedCount = 0;
    try {
      migratedCount = await this.executeWrite(session, async (tx) => {
        const result = await tx.run(
          `MATCH (ep:Episode)
           WHERE ep.episode_kind IS NULL
              OR ep.trust_level IS NULL
              OR ep.review_status IS NULL
              OR ep.source_type IS NULL
           WITH ep ORDER BY ep.uuid LIMIT $limit
           SET ep.episode_kind = coalesce(ep.episode_kind, 'legacy'),
               ep.trust_level = coalesce(ep.trust_level, 'unverified'),
               ep.review_status = coalesce(ep.review_status, 'proposed'),
               ep.source_type = coalesce(ep.source_type, 'message')
           RETURN count(ep) AS migrated`,
          { limit: neo4j.int(limit) },
        );
        return result.records[0]?.get('migrated').toNumber() ?? 0;
      });
    } finally {
      await session.close();
    }

    return {
      backend: 'neo4j',
      dry_run: false,
      matched_count: matchedCount,
      migrated_count: migratedCount,
      remaining_count: await this.countLegacyEpisodes(),
      backup_required: false,
      additive_only: true,
    };
  }

  private async countLegacyEpisodes(): Promise<number> {
    const session = this.getSession();
    try {
      const result = await session.executeRead(async (tx) =>
        tx.run(
          `MATCH (ep:Episode)
           WHERE ep.episode_kind IS NULL
              OR ep.trust_level IS NULL
              OR ep.review_status IS NULL
              OR ep.source_type IS NULL
           RETURN count(ep) AS count`,
        ),
      );
      return result.records[0]?.get('count').toNumber() ?? 0;
    } finally {
      await session.close();
    }
  }

  async getStats(groupId?: string): Promise<GraphStats> {
    const session = this.getSession();
    try {
      const where = groupId ? ' WHERE n.group_id = $groupId' : '';
      const params = groupId ? { groupId } : {};

      const result = await session.executeRead(async (tx) => {
        return tx.run(
          `MATCH (n)
					 ${where}
					 WITH n
					 WHERE n:Entity OR n:Episode
					 RETURN
						sum(CASE WHEN n:Entity THEN 1 ELSE 0 END) as entityCount,
						sum(CASE WHEN n:Episode THEN 1 ELSE 0 END) as episodeCount,
						collect(DISTINCT n.group_id) as groupIds,
						collect(CASE WHEN n:Entity THEN n.entity_type ELSE null END) as entityTypes,
						min(CASE WHEN n:Episode THEN n.created_at ELSE null END) as oldestEpisode,
						max(CASE WHEN n:Episode THEN n.created_at ELSE null END) as newestEpisode`,
          params,
        );
      });

      // Count edges separately
      const edgeResult = await session.executeRead(async (tx) => {
        const edgeWhere = groupId ? 'WHERE r.group_id = $groupId' : '';
        return tx.run(
          `MATCH ()-[r:RELATES_TO]->() ${edgeWhere} RETURN count(r) as edgeCount`,
          params,
        );
      });

      const record = result.records[0];
      const entityTypesList = (record.get('entityTypes') as string[]).filter(Boolean);
      const entityTypes: Record<string, number> = {};
      for (const t of entityTypesList) {
        entityTypes[t] = (entityTypes[t] ?? 0) + 1;
      }

      return {
        entity_count: record.get('entityCount').toNumber(),
        edge_count: edgeResult.records[0].get('edgeCount').toNumber(),
        episode_count: record.get('episodeCount').toNumber(),
        group_ids: record.get('groupIds') as string[],
        entity_types: entityTypes,
        oldest_episode: record.get('oldestEpisode') ?? null,
        newest_episode: record.get('newestEpisode') ?? null,
      };
    } finally {
      await session.close();
    }
  }

  // ===== Retention =====

  async applyRetention(groupId: string, policy: RetentionPolicy): Promise<number> {
    if (policy.type === 'forever') return 0;

    const session = this.getSession();
    try {
      if (policy.type === 'days' && policy.value) {
        const cutoffDate = new Date(Date.now() - policy.value * 24 * 60 * 60 * 1000).toISOString();

        const result = await this.executeWrite(session, async (tx) => {
          const existing = await tx.run('MATCH (ep:Episode {group_id:$group}) RETURN ep', {
            group: groupId,
          });
          const episodes = existing.records.map((record) =>
            this.recordToEpisode(record.get('ep').properties),
          );
          assertNoQueueMutation(episodes);
          await this.assertNoAutomaticOperationChainImpactInTransaction(
            tx,
            episodes
              .filter((episode) => episode.created_at < cutoffDate)
              .map((episode) => episode.uuid),
          );
          return tx.run(
            `MATCH (ep:Episode {group_id: $groupId})
						 WHERE ep.created_at < $cutoffDate
						 DETACH DELETE ep
						 RETURN count(*) as removed`,
            { groupId, cutoffDate },
          );
        });

        return result.records[0]?.get('removed')?.toNumber() ?? 0;
      }

      if (policy.type === 'max_episodes' && policy.value) {
        const result = await this.executeWrite(session, async (tx) => {
          const existing = await tx.run('MATCH (ep:Episode {group_id:$group}) RETURN ep', {
            group: groupId,
          });
          const episodes = existing.records.map((record) =>
            this.recordToEpisode(record.get('ep').properties),
          );
          assertNoQueueMutation(episodes);
          const selected = await tx.run(
            `MATCH (ep:Episode {group_id:$groupId})
             WITH ep ORDER BY ep.created_at DESC
             SKIP $maxEpisodes
             RETURN collect(ep.uuid) AS uuids`,
            { groupId, maxEpisodes: neo4j.int(policy.value!) },
          );
          await this.assertNoAutomaticOperationChainImpactInTransaction(
            tx,
            (selected.records[0]?.get('uuids') as string[] | undefined) ?? [],
          );
          return tx.run(
            `MATCH (ep:Episode {group_id: $groupId})
						 WITH ep ORDER BY ep.created_at DESC
						 SKIP $maxEpisodes
						 WITH collect(ep) as toDelete, count(ep) as cnt
						 UNWIND toDelete as ep
						 DETACH DELETE ep
						 RETURN cnt as removed`,
            { groupId, maxEpisodes: neo4j.int(policy.value!) },
          );
        });

        return result.records[0]?.get('removed')?.toNumber() ?? 0;
      }

      return 0;
    } finally {
      await session.close();
    }
  }

  // ===== Record Conversion Helpers =====

  private recordToEntity(
    props: Record<string, unknown>,
    preserveRawAttributes = false,
  ): EntityNode {
    return {
      uuid: props.uuid as string,
      name: props.name as string,
      group_id: props.group_id as string,
      summary: (props.summary as string) ?? '',
      entity_type: (props.entity_type as string) ?? 'unknown',
      name_embedding: (props.name_embedding as number[] | null) ?? null,
      attributes: preserveRawAttributes
        ? this.parseAutomaticCaptureAttributes(props.attributes)
        : this.parseJsonField(props.attributes, {}),
      created_at: props.created_at as string,
      updated_at: props.updated_at as string,
    };
  }

  private recordToEdge(props: Record<string, unknown>, preserveRawAttributes = false): EntityEdge {
    return {
      uuid: props.uuid as string,
      group_id: props.group_id as string,
      source_node_uuid: props.source_node_uuid as string,
      target_node_uuid: props.target_node_uuid as string,
      name: props.name as string,
      fact: props.fact as string,
      fact_embedding: (props.fact_embedding as number[] | null) ?? null,
      episodes: (props.episodes as string[]) ?? [],
      valid_at: (props.valid_at as string | null) ?? null,
      invalid_at: (props.invalid_at as string | null) ?? null,
      expired_at: (props.expired_at as string | null) ?? null,
      attributes: preserveRawAttributes
        ? this.parseAutomaticCaptureAttributes(props.attributes)
        : this.parseJsonField(props.attributes, {}),
      created_at: props.created_at as string,
      updated_at: props.updated_at as string,
    };
  }

  private recordToEpisode(
    props: Record<string, unknown>,
    preserveRawAttributes = false,
  ): EpisodicNode {
    const keyInspection = inspectNativeCaptureAttributeValue(props.attributes);
    if (preserveRawAttributes || keyInspection === 'protected' || keyInspection === 'uncertain')
      assertNativeCaptureAttributeJsonSize(props.attributes);
    const attributes =
      preserveRawAttributes || keyInspection === 'protected'
        ? this.parseAutomaticCaptureAttributes(props.attributes)
        : this.parseJsonField(props.attributes, {});
    const captureSource =
      keyInspection === 'protected' ||
      [
        WRITE_OWNER_V2_ATTRIBUTE,
        WRITE_OWNER_V3_ATTRIBUTE,
        SOURCE_ENVELOPE_V2_ATTRIBUTE,
        AUTONOMOUS_CAPTURE_V4_OWNER_ATTRIBUTE,
        AUTONOMOUS_CAPTURE_V3_ENVELOPE_ATTRIBUTE,
      ].some((key) => Object.prototype.hasOwnProperty.call(attributes, key));
    const episode = EpisodicNodeSchema.parse({
      uuid: props.uuid as string,
      group_id: props.group_id as string,
      content: props.content as string,
      role: props.role as 'human' | 'ai' | 'system',
      source_type: (props.source_type as 'message' | 'document' | 'api') ?? 'message',
      reference_time: props.reference_time as string,
      previous_episode_uuid: (props.previous_episode_uuid as string | null) ?? null,
      created_at: props.created_at as string,
      updated_at: (props.updated_at as string | null) ?? null,
      source_message_id: (props.source_message_id as string | null) ?? null,
      idempotency_key: (props.idempotency_key as string | null) ?? null,
      conversation_id: (props.conversation_id as string | null) ?? null,
      sender_id: (props.sender_id as string | null) ?? null,
      sender_name: (props.sender_name as string | null) ?? null,
      episode_kind: props.episode_kind,
      quoted_message_id: (props.quoted_message_id as string | null) ?? null,
      trust_level: props.trust_level,
      confidence: (props.confidence as number | null) ?? null,
      review_status: props.review_status,
      source_workflow_id: (props.source_workflow_id as string | null) ?? null,
      source_execution_id: (props.source_execution_id as string | null) ?? null,
      attributes: preserveRawAttributes || captureSource ? {} : attributes,
    });
    if (preserveRawAttributes || captureSource) episode.attributes = attributes;
    if (captureSource) {
      const bounded = cloneBoundedAutomaticCaptureJson<EpisodicNode>(episode, 'beginRequest');
      if (canonical(bounded) !== canonical(EpisodicNodeSchema.parse(bounded)))
        throw new Error('Engram automatic capture: record_normalization');
      return prepareAutomaticEpisodeInput(bounded);
    }
    return episode;
  }

  private parseAutomaticCaptureAttributes(value: unknown): Record<string, unknown> {
    assertNativeCaptureAttributeJsonSize(value);
    let parsed: unknown = value;
    if (value === undefined || value === null) return {};
    if (typeof value === 'string') {
      try {
        parsed = JSON.parse(value);
      } catch {
        throw new Error('Engram automatic capture: invalid_native_attributes');
      }
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Engram automatic capture: invalid_native_attributes');
    }
    return parsed as Record<string, unknown>;
  }

  private parseJsonField(
    value: unknown,
    fallback: Record<string, unknown>,
  ): Record<string, unknown> {
    if (typeof value === 'string') {
      try {
        return JSON.parse(value) as Record<string, unknown>;
      } catch {
        return fallback;
      }
    }
    if (typeof value === 'object' && value !== null) {
      return value as Record<string, unknown>;
    }
    return fallback;
  }
}
