import { AsyncLocalStorage } from 'async_hooks';
import { types as utilTypes } from 'node:util';
import { compositionalCaptureCompletionDecisionKindV3 } from './CompositionalCaptureCompletionDiagnosticsV3';
import { createCompositionalAutomaticCaptureHandleRegistryV3 } from './CompositionalAutomaticCaptureHandlesV3';
import { startCompositionalBackendBeginV3 } from './CompositionalCaptureBackendBeginV3';
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
import type { AutonomousPersonalTypedSyntaxWorkV1 } from '../schemas/AutonomousPersonalTypedSyntaxV1.schema';
import {
  AutonomousPersonalCaptureProviderPreflightV4Schema,
  AutonomousPersonalCaptureProviderObservationV4Schema,
  type AutonomousPersonalCaptureProviderPreflightV4,
} from '../schemas/AutonomousPersonalCaptureProviderV4.schema';
import type { CompositionalCaptureBeginMethodRequestV3 } from '../schemas/CompositionalAutomaticCaptureLifecycleV3.schema';
import type { CompositionalCaptureBeginInternalResultV3 } from '../schemas/CompositionalAutomaticCaptureRegistryV3.schema';
import type {
  CompositionalCaptureCompletionInternalResultV3,
  PrivateOneUseCompositionalCaptureLeaseHandleV3,
} from '../schemas/CompositionalAutomaticCaptureRegistryV3.schema';
import type { CompositionalAutomaticCaptureOperationV3 } from '../schemas/CompositionalAutomaticCaptureV3.schema';
import type { CompositionalCaptureNonPermitDecisionV3 } from '../schemas/CompositionalAutomaticCaptureLifecycleV3.schema';
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
import { MultiDirectedGraph } from 'graphology';
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { generateUuid } from '../utils/uuid';
import { nowIso, isOlderThanDays, isWithinDateRange } from '../utils/temporal';
import { MinisearchProvider } from '../search/MinisearchProvider';
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
  StorageMutationDiagnostics,
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
import { matchesEpisodeHygieneFilters } from './EpisodeHygiene';
import {
  assertAutomaticLedgerSourceIntegrity,
  assertAutomaticBindingIdentity,
  findAutomaticBinding,
  assertNoAutomaticOperationChainImpact,
  hasAutonomousSourceOwnership,
  automaticOperationIdentityForOwnedSource,
  reconcileAutomaticOperationIdentity,
  immutableAutomaticLedgerSnapshot,
  assertAutomaticEpisodeTrustedPath,
  assertAutomaticEntityDeleteAllowed,
  assertAutomaticEpisodeBinding,
  assertNoAutomaticBindingAttribute,
  applyAutomaticBindingCommand,
  prepareAutomaticEntityUpdate,
  prepareAutomaticEpisodeInput,
  prepareAutomaticEpisodeUpdate,
  prepareAutomaticImport,
  protectAutomaticEntity,
  protectAutomaticEpisode,
  assertOwnedEpisodeReplay,
  SOURCE_ENVELOPE_ATTRIBUTE,
  WRITE_OWNER_ATTRIBUTE,
  WRITE_OWNER_V2_ATTRIBUTE,
  WRITE_OWNER_V3_ATTRIBUTE,
  SOURCE_ENVELOPE_V2_ATTRIBUTE,
  WRITE_OWNER_V4_ATTRIBUTE,
  SOURCE_ENVELOPE_V3_ATTRIBUTE,
} from './AutomaticIdentity';
import { AutomaticWriteOwnerSchema } from '../schemas/AutomaticClaim.schema';
import { AutomaticBindingCommandSchema } from '../schemas/AutomaticOperations.schema';
import type {
  AutomaticBindingCommand,
  AutomaticBindingRecord,
} from '../schemas/AutomaticOperations.schema';
import {
  CURRENT_GRAPH_DATA_VERSION,
  GraphDataSchema,
  QueueClearOptionsSchema,
  CreateEpisodicNodeSchema,
  EpisodicNodeSchema,
  migrateGraphData,
  AutomaticLedgerSchema,
  AutomaticLegacyObservationRequestSchema,
  AutomaticLegacyObservationResultSchema,
  assertNoImportedAutomaticOperations,
} from '../schemas';
import type {
  AutomaticLedger,
  AutomaticLegacyObservationRequest,
  AutomaticLegacyObservationResult,
} from '../schemas/AutomaticLedger.schema';
import { createAutomaticLedger, observeLegacyUnconfirmed } from './AutomaticLedger';
import {
  buildAutomaticClaimReadIndices,
  projectAutomaticClaimReadContextWithUsage,
} from '../extraction/AutomaticClaimCommitProof';
import {
  beginAutomaticClaimReadAttempt,
  canUseAutomaticClaimReadScope,
  chargeAutomaticClaimContextBytes,
  getAutomaticClaimReadScope,
  getAutomaticClaimReadScopeRemaining,
  reserveAutomaticClaimSnapshotBytes,
  type AutomaticClaimReadScope,
} from './AutomaticClaimReadScope';
import type { AutomaticClaimReadResult } from '../schemas/AutomaticClaimRead.schema';
import type { AutomaticCaptureTerminalReceiptV2 } from '../schemas/AutomaticCaptureReceipt.schema';
import { CompositionalRetrievalSnapshotV3Schema } from '../schemas/CompositionalRetrievalSnapshotV3.schema';
import type { CompositionalRetrievalSnapshotResultV3 } from '../schemas/CompositionalRetrievalSnapshotV3.schema';
import {
  AutomaticCaptureBeginRequestV2Schema,
  hashAutomaticCaptureV2,
  type AutomaticCaptureBeginRequestV2,
} from '../schemas/AutomaticCapture.schema';
import {
  createAutomaticCaptureInternalResultSchemas,
  type AutomaticCaptureBeginInternalResultV2,
  type AutomaticHumanCompletionInternalResultV2,
  AutomaticCaptureAdminFenceRequestV2Schema,
  AutomaticCaptureReadRequestV2Schema,
  AutomaticCaptureReadResultV2Schema,
  AutomaticCaptureCancelInternalResultV2Schema,
  type AutomaticCaptureAdminFenceRequestV2,
  type AutomaticCaptureReadRequestV2,
  type AutomaticCaptureReadResultV2,
  type AutomaticCaptureResumeInternalResultV2,
  type AutomaticCaptureCancelInternalResultV2,
} from '../schemas/AutomaticCaptureApi.schema';
import {
  createAutomaticCaptureHandleRegistry,
  type PrivateOneUseAutomaticLeaseHandle,
  type PrivateConsumedAutomaticCaptureInvocation,
} from './AutomaticCaptureHandles';
import { ExtractionBudgetError } from '../extraction/ExtractionDiagnostics';
import { prepareHumanCaptureBeginV2 } from './AutomaticCaptureBegin';
import { embeddedAutomaticCaptureStoreHash } from './AutomaticCaptureStore';
import {
  cloneBoundedAutomaticCaptureJson,
  isNativePlainAutomaticCaptureObject,
} from './BoundedAutomaticCaptureJson';
import {
  AutomaticAssistantCaptureIntentV2Schema,
  AutomaticAssistantFinalWriterResultV2Schema,
  type AutomaticAssistantCaptureIntentV2,
  type AutomaticAssistantFinalWriterResultV2,
  type AutomaticAssistantCaptureCompletionPreparationV2,
} from '../schemas/AutomaticAssistantCapture.schema';
import {
  AutomaticAssistantWorkBudgetV2Schema,
  type AutomaticAssistantWorkBudgetV2,
} from '../schemas/AutomaticAssistantWorkBudget.schema';
import {
  createAutomaticAssistantCaptureAuthorizationRegistry,
  prepareAssistantCaptureBeginV2,
  prepareAssistantFinalCompletionV2,
  readAutomaticAssistantCaptureReplayV2,
  type PrivateConsumedAutomaticAssistantWriteAuthorizationV2,
} from './AutomaticAssistantCapture';
import {
  canStageAutonomousPersonalAssistantFinalV4,
  claimAutonomousPersonalAssistantFinalReconciliationV4,
  closeAutonomousPersonalAssistantFinalInvocationV4,
  consumeAutonomousPersonalAssistantFinalInvocationV4,
  markAutonomousPersonalAssistantFinalCandidateReturnedV4,
  readAutonomousPersonalAssistantFinalInvocationV4,
  type PrivateAutonomousPersonalAssistantFinalInvocationV4,
  type PrivateConsumedAutonomousPersonalAssistantFinalInvocationV4,
} from './AutonomousPersonalAssistantFinalInvocationV4';
import {
  prepareAutonomousPersonalAssistantFinalV4,
  reconcileAutonomousPersonalAssistantFinalV4,
} from './AutonomousPersonalAssistantFinalPlanV4';
import { parseLosslessAutomaticCaptureGraph } from './LosslessAutomaticCaptureGraph';
import {
  buildCommittedCompositionalCaptureOperationV3,
  CompositionalCaptureTerminalOperationFailureV3,
} from './CompositionalCaptureTerminalOperationV3';
import type { CompositionalCaptureTerminalOperationV3 } from '../schemas/CompositionalCaptureTerminalOperationV3.schema';
import {
  prepareHumanCapturePlanV2,
  prepareHumanCaptureCompletionV2,
} from './AutomaticCaptureComplete';
import type { AutomaticHumanCaptureCompletionPreparationV2 } from '../schemas/AutomaticCaptureComplete.schema';
import {
  prepareHumanCaptureResumeSourceV2,
  prepareHumanCaptureResumeV2,
  prepareHumanCaptureCancelV2,
  projectHumanCaptureOutcomeV2,
} from './AutomaticCaptureControl';
import type { AutomaticHumanCaptureResumePreparationV2 } from '../schemas/AutomaticCaptureControl.schema';

type AutomaticClaimSnapshot = {
  signature: string;
  graph: GraphData;
  indices: ReturnType<typeof buildAutomaticClaimReadIndices>;
};

function automaticClaimFileSignature(stat: fs.BigIntStats): string {
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(':');
}

type NodeType = 'entity' | 'episode';

interface GraphNodeAttributes {
  type: NodeType;
  data: EntityNode | EpisodicNode;
}

interface GraphEdgeAttributes {
  type: 'entity_edge' | 'next_episode';
  data: EntityEdge | null;
}

const PERSIST_LOCK_TIMEOUT_MS = 60000;
const PERSIST_LOCK_STALE_MS = 30000;
const PERSIST_LOCK_HEARTBEAT_MS = 5000;
const EMBEDDED_BACKUP_SUFFIX = '.pre-schema-2.0.backup.json';

interface MutationOptions<T> {
  operation?: string;
  durable?: boolean;
  itemCount?: number;
  shouldWriteSnapshot?: (result: T) => boolean;
  captureRecords?: 'lossless';
  requireExistingSnapshot?: boolean;
  captureRead?: {
    scope: AutomaticClaimReadScope;
    check: () => void;
    attemptReserved?: boolean;
    verifyStableSnapshot?: boolean;
  };
  autonomousPersonalCompletionV4?: {
    typedSyntaxWork: AutonomousPersonalTypedSyntaxWorkV1;
    check: () => void;
    onSnapshotReplacementAttempted: () => void;
    onSnapshotReplaced: () => void;
    onSnapshotDurableAcknowledged?: () => void;
  };
}

declare const trustedCompletedAutonomousPersonalWriteV4Brand: unique symbol;

type TrustedCompletedAutonomousPersonalWriteV4 = object & {
  readonly [trustedCompletedAutonomousPersonalWriteV4Brand]: 'completed_write';
};

type BackendCompletionCoreOutcomeV4 = Readonly<{
  observation: AutonomousPersonalCompletionStorageV4Result;
  witness: TrustedCompletedAutonomousPersonalWriteV4 | null;
}>;

interface AutonomousPersonalStructuralGuardContextV4 {
  readonly typedSyntaxWork: AutonomousPersonalTypedSyntaxWorkV1;
  readonly check: () => void;
}

const NEVER_ABORTED_AUTONOMOUS_PERSONAL_SIGNAL_V4 = new AbortController().signal;

function ordinaryAutonomousPersonalStructuralGuardContextV4(): AutonomousPersonalStructuralGuardContextV4 {
  return {
    typedSyntaxWork: Object.freeze({
      absoluteMonotonicDeadlineMs: performance.now() + 5_000,
      signal: NEVER_ABORTED_AUTONOMOUS_PERSONAL_SIGNAL_V4,
    }),
    check: () => {},
  };
}

function hasAutonomousPersonalV4Enrollment(graph: GraphData): boolean {
  return (
    graph.episodes.some(hasAutonomousSourceOwnership) ||
    (graph.automatic_operations_v1?.operations.some((operation) => operation.version === 4) ??
      false)
  );
}

function isAutonomousPersonalFamilyFourTag(value: unknown): boolean {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    utilTypes.isProxy(value) ||
    !isNativePlainAutomaticCaptureObject(value)
  ) {
    return false;
  }
  const version = Object.getOwnPropertyDescriptor(value, 'version');
  const family = Object.getOwnPropertyDescriptor(value, 'family');
  return (
    (version !== undefined &&
      'value' in version &&
      typeof version.value === 'number' &&
      version.value >= 3) ||
    (family !== undefined && 'value' in family && family.value === 'autonomous-personal-v1')
  );
}

function sameAutonomousPersonalFamilyFourTag(left: unknown, right: unknown): boolean {
  try {
    // Claim3 tags can exceed the smaller 16 KiB policy-data bound while staying
    // within their schema limits. Use the existing bounded request-data clone
    // size for exact equality checks on already parsed graph records.
    return (
      JSON.stringify(cloneBoundedAutomaticCaptureJson<unknown>(left, 'beginRequest')) ===
      JSON.stringify(cloneBoundedAutomaticCaptureJson<unknown>(right, 'beginRequest'))
    );
  } catch {
    return false;
  }
}

function hasNewAutonomousPersonalFamilyFourFootprint(before: GraphData, after: GraphData): boolean {
  const oldEntities = new Map(before.entities.map((entity) => [entity.uuid, entity]));
  const oldEdges = new Map(before.edges.map((edge) => [edge.uuid, edge]));
  for (const entity of after.entities) {
    const previous = oldEntities.get(entity.uuid);
    if (
      entity.entity_type === 'autonomous_personal_value' &&
      previous?.entity_type !== 'autonomous_personal_value'
    ) {
      return true;
    }
    const marker = entity.attributes.engram_literal_v1;
    if (
      isAutonomousPersonalFamilyFourTag(marker) &&
      !sameAutonomousPersonalFamilyFourTag(previous?.attributes.engram_literal_v1, marker)
    ) {
      return true;
    }
  }
  for (const edge of after.edges) {
    const claim = edge.attributes.engram_claim_v1;
    if (
      isAutonomousPersonalFamilyFourTag(claim) &&
      !sameAutonomousPersonalFamilyFourTag(
        oldEdges.get(edge.uuid)?.attributes.engram_claim_v1,
        claim,
      )
    ) {
      return true;
    }
  }
  return false;
}

const UNREADABLE_RAW_IMPORT_V4 = Symbol('unreadable_raw_import_v4');

function rawOwnDataProperty(
  value: unknown,
  key: string,
): unknown | typeof UNREADABLE_RAW_IMPORT_V4 {
  if (
    value === null ||
    typeof value !== 'object' ||
    utilTypes.isProxy(value) ||
    !isNativePlainAutomaticCaptureObject(value)
  ) {
    return UNREADABLE_RAW_IMPORT_V4;
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) return undefined;
    return descriptor.enumerable && 'value' in descriptor
      ? descriptor.value
      : UNREADABLE_RAW_IMPORT_V4;
  } catch {
    return UNREADABLE_RAW_IMPORT_V4;
  }
}

function rawArrayValues(value: unknown): unknown[] | typeof UNREADABLE_RAW_IMPORT_V4 {
  if (!Array.isArray(value) || utilTypes.isProxy(value)) return UNREADABLE_RAW_IMPORT_V4;
  const values: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    } catch {
      return UNREADABLE_RAW_IMPORT_V4;
    }
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor))
      return UNREADABLE_RAW_IMPORT_V4;
    values.push(descriptor.value);
  }
  return values;
}

function assertNoRawAutonomousPersonalFamilyFourImport(value: unknown): void {
  const rawRoot = rawOwnDataProperty(value, 'graph');
  const graph = rawRoot === undefined ? value : rawRoot;
  if (graph === UNREADABLE_RAW_IMPORT_V4) {
    throw new Error('Engram automatic memory: invalid_import_data');
  }
  for (const [rowsKey, attributeKey, footprintKey] of [
    ['entities', 'attributes', 'engram_literal_v1'],
    ['edges', 'attributes', 'engram_claim_v1'],
  ] as const) {
    const rowsValue = rawOwnDataProperty(graph, rowsKey);
    if (rowsValue === undefined) continue;
    const rows = rawArrayValues(rowsValue);
    if (rows === UNREADABLE_RAW_IMPORT_V4) {
      throw new Error('Engram automatic memory: invalid_import_data');
    }
    for (const row of rows) {
      const rowValue = rawOwnDataProperty(row, rowsKey === 'entities' ? 'entity_type' : 'uuid');
      const attributesValue = rawOwnDataProperty(row, attributeKey);
      if (rowValue === UNREADABLE_RAW_IMPORT_V4 || attributesValue === UNREADABLE_RAW_IMPORT_V4) {
        throw new Error('Engram automatic memory: invalid_import_data');
      }
      const attributes =
        attributesValue === undefined
          ? undefined
          : rawOwnDataProperty(attributesValue, footprintKey);
      if (attributes === UNREADABLE_RAW_IMPORT_V4) {
        throw new Error('Engram automatic memory: invalid_import_data');
      }
      if (
        attributes !== null &&
        typeof attributes === 'object' &&
        (utilTypes.isProxy(attributes) || !isNativePlainAutomaticCaptureObject(attributes))
      ) {
        throw new Error('Engram automatic memory: invalid_import_data');
      }
      for (const tagKey of ['version', 'family']) {
        if (attributes === null || typeof attributes !== 'object') continue;
        const tagField = Object.getOwnPropertyDescriptor(attributes, tagKey);
        if (tagField && (!tagField.enumerable || !('value' in tagField))) {
          throw new Error('Engram automatic memory: invalid_import_data');
        }
      }
      if (
        (rowsKey === 'entities' && rowValue === 'autonomous_personal_value') ||
        isAutonomousPersonalFamilyFourTag(attributes)
      ) {
        throw new Error('Engram automatic memory: native_family_import_forbidden');
      }
    }
  }
}

function rawGraphHasAutonomousPersonalV4Enrollment(value: unknown): boolean {
  const episodesValue = rawOwnDataProperty(value, 'episodes');
  if (episodesValue === UNREADABLE_RAW_IMPORT_V4) return true;
  if (episodesValue !== undefined) {
    const episodes = rawArrayValues(episodesValue);
    if (episodes === UNREADABLE_RAW_IMPORT_V4) return true;
    for (const episode of episodes) {
      const attributes = rawOwnDataProperty(episode, 'attributes');
      if (attributes === UNREADABLE_RAW_IMPORT_V4) return true;
      if (attributes === undefined) continue;
      const owner = rawOwnDataProperty(attributes, WRITE_OWNER_V4_ATTRIBUTE);
      const envelope = rawOwnDataProperty(attributes, SOURCE_ENVELOPE_V3_ATTRIBUTE);
      if (
        owner === UNREADABLE_RAW_IMPORT_V4 ||
        envelope === UNREADABLE_RAW_IMPORT_V4 ||
        owner !== undefined ||
        envelope !== undefined
      )
        return true;
    }
  }
  const ledger = rawOwnDataProperty(value, 'automatic_operations_v1');
  if (ledger === UNREADABLE_RAW_IMPORT_V4) return true;
  if (ledger === undefined) return false;
  const operationsValue = rawOwnDataProperty(ledger, 'operations');
  if (operationsValue === UNREADABLE_RAW_IMPORT_V4 || operationsValue === undefined) return true;
  const operations = rawArrayValues(operationsValue);
  if (operations === UNREADABLE_RAW_IMPORT_V4) return true;
  return operations.some((operation) => {
    const version = rawOwnDataProperty(operation, 'version');
    return version === UNREADABLE_RAW_IMPORT_V4 || version === 4;
  });
}

function autonomousPersonalCompletionNoWriteV4(
  reason: AutonomousPersonalCompletionPlanV4NoWriteReason,
): AutonomousPersonalCompletionStorageV4Result {
  return AutonomousPersonalCompletionStorageV4ResultOwnedDataSchema.parse({
    kind: 'no_write',
    reason,
  });
}

function autonomousPersonalCompletionStorageFailureReasonV4(
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
  if (error instanceof ExtractionBudgetError) {
    return error.budgetReason === 'snapshot_limit' ? 'capacity' : 'budget_exhausted';
  }
  if (error instanceof CompositionalRetrievalSnapshotReadError) {
    return error.reason === 'resource_exhausted' ? 'capacity' : 'inspection_incomplete';
  }
  const storageFailure = autonomousPersonalCaptureStorageFailureV4(error);
  if (storageFailure === 'resource_exhausted') return 'capacity';
  if (storageFailure === 'conflict') return 'conflict';
  if (error instanceof Error && error.message === 'Engram automatic capture: snapshot_limit')
    return 'capacity';
  return 'inspection_incomplete';
}

function assertAutonomousPersonalGraphIntegrityV4(
  graph: GraphData,
  guard: AutonomousPersonalStructuralGuardContextV4,
): void {
  guard.check();
  assertAutomaticLedgerSourceIntegrity(graph);
  guard.check();
  assertAutonomousPersonalRecordIntegrityV4(graph, guard.typedSyntaxWork, guard.check);
  guard.check();
}

class CompositionalRetrievalSnapshotReadError extends Error {
  constructor(readonly reason: 'invalid_snapshot' | 'resource_exhausted' | 'concurrent_snapshot') {
    super(`Engram compositional retrieval: ${reason}`);
    this.name = 'CompositionalRetrievalSnapshotReadError';
  }
}

function isCompositionalSnapshotResourceFailure(error: unknown): boolean {
  if (
    error !== null &&
    typeof error === 'object' &&
    'reason' in error &&
    ['bytes', 'nodes', 'depth'].includes(String(error.reason))
  )
    return true;
  if (
    error !== null &&
    typeof error === 'object' &&
    'issues' in error &&
    Array.isArray(error.issues)
  ) {
    return error.issues.some(
      (issue: unknown) =>
        issue !== null &&
        typeof issue === 'object' &&
        'message' in issue &&
        (issue.message === 'Ledger-bearing graph snapshot exceeds 100,000 graph records' ||
          issue.message === 'Ledger-bearing graph snapshot must not exceed 100 MiB serialized'),
    );
  }
  return false;
}

function hasCaptureSourceAttributes(attributes: unknown): boolean {
  return (
    attributes !== null &&
    typeof attributes === 'object' &&
    [
      WRITE_OWNER_V2_ATTRIBUTE,
      WRITE_OWNER_V3_ATTRIBUTE,
      SOURCE_ENVELOPE_V2_ATTRIBUTE,
      WRITE_OWNER_V4_ATTRIBUTE,
      SOURCE_ENVELOPE_V3_ATTRIBUTE,
    ].some((key) => Object.prototype.hasOwnProperty.call(attributes, key))
  );
}

function hasReplaySafeCaptureSource(episodes: readonly EpisodicNode[]): boolean {
  return episodes.some((episode) => hasCaptureSourceAttributes(episode.attributes));
}

function hasRawReplaySafeCaptureState(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const graph = value as Record<string, unknown>;
  if (
    Array.isArray(graph.episodes) &&
    graph.episodes.some((episode: unknown) => {
      if (episode === null || typeof episode !== 'object') return false;
      const attrs = (episode as Record<string, unknown>).attributes;
      return attrs !== null && typeof attrs === 'object' && hasCaptureSourceAttributes(attrs);
    })
  )
    return true;
  const ledger = graph.automatic_operations_v1;
  if (ledger === null || typeof ledger !== 'object') return false;
  const operations = (ledger as Record<string, unknown>).operations;
  return (
    Array.isArray(operations) &&
    operations.some(
      (operation: unknown) =>
        operation !== null &&
        typeof operation === 'object' &&
        [2, 3, 4].includes((operation as Record<string, unknown>).version as number),
    )
  );
}

function compactCaptureSnapshotData(value: GraphData): GraphData {
  const graph = { ...value };
  if (graph.group_id === undefined) delete graph.group_id;
  return parseLosslessAutomaticCaptureGraph(graph);
}

function prepareCompositionalCompletionGraphCandidateV3(
  graph: GraphData,
  leasedOperation: Extract<CompositionalAutomaticCaptureOperationV3, { state: 'leased' }>,
  committedOperation: CompositionalCaptureTerminalOperationV3,
  entities: readonly EntityNode[],
  edges: readonly EntityEdge[],
  extractionEpoch: string,
  check: () => void,
): GraphData | null {
  const ledger = graph.automatic_operations_v1;
  if (!ledger) return null;
  let matches = 0;
  const operations = ledger.operations.map((operation) => {
    check();
    if (operation.operationId !== leasedOperation.operationId) return operation;
    matches += 1;
    if (
      operation.version !== 3 ||
      operation.state !== 'leased' ||
      hashAutomaticCaptureV2(operation) !== hashAutomaticCaptureV2(leasedOperation)
    )
      return null;
    return committedOperation;
  });
  if (matches !== 1 || operations.some((operation) => operation === null)) return null;
  check();
  const hasFactChanges = entities.length > 0 || edges.length > 0;
  const candidate = {
    ...graph,
    entities: [...graph.entities, ...entities],
    edges: [...graph.edges, ...edges],
    ...(hasFactChanges
      ? { metadata: { ...graph.metadata, extraction_epoch: extractionEpoch } }
      : {}),
    automatic_operations_v1: { ...ledger, operations },
  };
  return validateAutomaticCaptureCandidate(candidate as GraphData, check);
}

export class GraphologyStorage implements IGraphStorage {
  private graph: MultiDirectedGraph<GraphNodeAttributes, GraphEdgeAttributes>;
  private automaticOperations: AutomaticLedger | undefined;
  private searchProvider: MinisearchProvider;
  private persistPath: string | undefined;
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
  private extractionEpoch?: string;
  private episodeOrder = new Map<string, number>();
  private nextOrder = 0;
  private mutationTail: Promise<void> = Promise.resolve();
  private lastMutationDiagnostics: StorageMutationDiagnostics | null = null;
  private recoveryRequired = false;
  private automaticClaimSnapshots = new WeakMap<AutomaticClaimReadScope, AutomaticClaimSnapshot>();
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
  private migrationStatus: StorageMigrationStatus = {
    backend: 'embedded',
    target_version: CURRENT_GRAPH_DATA_VERSION,
    source_version: 'new',
    migration_required: false,
    legacy_episode_count: 0,
    automatic_migration_completed: false,
    backup: { created: false, verified: false, path: null },
  };

  constructor(persistPath?: string) {
    this.graph = new MultiDirectedGraph<GraphNodeAttributes, GraphEdgeAttributes>();
    this.searchProvider = new MinisearchProvider();
    if (persistPath) {
      // Validate path to prevent traversal attacks
      const resolved = path.resolve(persistPath);
      if (resolved.includes('..') || resolved.startsWith('/etc') || resolved.startsWith('/dev')) {
        throw new Error(`Invalid persist path: ${persistPath}`);
      }
      this.persistPath = resolved;
    }
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

    if (this.persistPath) {
      await this.loadFromDisk();
    }

    this.initialized = true;
  }

  async close(): Promise<void> {
    await this.mutationTail;
  }

  getLastMutationDiagnostics(): StorageMutationDiagnostics | null {
    return this.lastMutationDiagnostics ? { ...this.lastMutationDiagnostics } : null;
  }

  extractionBackend(): 'embedded' {
    return 'embedded';
  }

  getNativeAutomaticCaptureStoreIdentityV4(): string | null {
    if (!this.initialized || !this.persistPath) return null;
    return embeddedAutomaticCaptureStoreHash(this.persistPath);
  }

  async automaticBindingCommand(command: AutomaticBindingCommand): Promise<AutomaticBindingRecord> {
    const parsed = AutomaticBindingCommandSchema.parse(command);
    const bindingId = parsed.action === 'create' ? generateUuid() : parsed.bindingId;
    const at = nowIso();
    return this.runMutation(
      async () => {
        const graph = JSON.parse(JSON.stringify(await this.exportGraph())) as GraphData;
        const record = applyAutomaticBindingCommand(graph, parsed, bindingId, at);
        this.replaceGraphData(graph);
        return record;
      },
      { operation: 'automatic_binding_command', durable: true },
    );
  }

  async observeLegacyAutomaticSource(
    request: AutomaticLegacyObservationRequest,
  ): Promise<AutomaticLegacyObservationResult> {
    const parsed = AutomaticLegacyObservationRequestSchema.safeParse(request);
    if (!parsed.success) {
      return AutomaticLegacyObservationResultSchema.parse({
        status: 'invalid_input',
        state: null,
        shouldProcess: false,
        attemptAudit: 'not_recorded',
      });
    }

    // Both IDs are allocated once, outside the locked mutation callback.
    const operationId = generateUuid();
    const attemptHash =
      parsed.data.attemptIdHash ?? createHash('sha256').update(generateUuid()).digest('hex');
    const mutation = await this.runMutation(
      async (): Promise<{ result: AutomaticLegacyObservationResult; changed: boolean }> => {
        const source = this.getEpisodeOrEntity(
          parsed.data.sourceId,
          'episode',
        ) as EpisodicNode | null;
        if (!source) {
          return {
            result: AutomaticLegacyObservationResultSchema.parse({
              status: 'unavailable',
              state: null,
              shouldProcess: false,
              attemptAudit: 'not_recorded',
            }),
            changed: false,
          };
        }

        const storedOwner = AutomaticWriteOwnerSchema.safeParse(
          source.attributes[WRITE_OWNER_ATTRIBUTE],
        );
        if (!storedOwner.success) {
          return {
            result: AutomaticLegacyObservationResultSchema.parse({
              status: 'unavailable',
              state: null,
              shouldProcess: false,
              attemptAudit: 'not_recorded',
            }),
            changed: false,
          };
        }
        if (canonical(storedOwner.data) !== canonical(parsed.data.expectedOwner)) {
          return {
            result: AutomaticLegacyObservationResultSchema.parse({
              status: 'conflict',
              state: null,
              shouldProcess: false,
              attemptAudit: 'not_recorded',
            }),
            changed: false,
          };
        }

        let identity;
        try {
          identity = automaticOperationIdentityForOwnedSource(source, storedOwner.data);
        } catch {
          return {
            result: AutomaticLegacyObservationResultSchema.parse({
              status: 'unavailable',
              state: null,
              shouldProcess: false,
              attemptAudit: 'not_recorded',
            }),
            changed: false,
          };
        }

        const ledger = this.automaticOperations ?? createAutomaticLedger();
        const existing = ledger.operations.find(
          (operation) => operation.identity.sourceId === parsed.data.sourceId,
        );
        if (existing?.version === 4) {
          return {
            result: AutomaticLegacyObservationResultSchema.parse({
              status: 'conflict',
              state: null,
              shouldProcess: false,
              attemptAudit: 'not_recorded',
            }),
            changed: false,
          };
        }
        if (existing) {
          const reconciled = reconcileAutomaticOperationIdentity(identity, existing.identity);
          if (!reconciled) {
            return {
              result: AutomaticLegacyObservationResultSchema.parse({
                status: 'conflict',
                state: null,
                shouldProcess: false,
                attemptAudit: 'not_recorded',
              }),
              changed: false,
            };
          }
          identity = reconciled;
          if (existing.state !== 'legacy_unconfirmed') {
            return {
              result: AutomaticLegacyObservationResultSchema.parse({
                status: 'already_recorded',
                state: null,
                shouldProcess: false,
                attemptAudit: 'not_recorded',
              }),
              changed: false,
            };
          }
        }

        const observed = observeLegacyUnconfirmed(
          ledger,
          {
            operationId,
            identity,
            attempt: { attemptHash },
          },
          nowIso(),
        );
        if (observed.kind === 'conflict') {
          return {
            result: AutomaticLegacyObservationResultSchema.parse({
              status: 'conflict',
              state: null,
              shouldProcess: false,
              attemptAudit: 'not_recorded',
            }),
            changed: false,
          };
        }
        if (observed.kind === 'capacity') {
          return {
            result: AutomaticLegacyObservationResultSchema.parse({
              status: 'capacity',
              state: null,
              shouldProcess: false,
              attemptAudit: observed.attemptAudit ?? 'capacity_reached',
            }),
            changed: false,
          };
        }
        if (!observed.ledger || observed.kind !== 'original_receipt_unavailable') {
          return {
            result: AutomaticLegacyObservationResultSchema.parse({
              status: 'invalid_ledger',
              state: null,
              shouldProcess: false,
              attemptAudit: 'not_recorded',
            }),
            changed: false,
          };
        }

        const changed = canonical(ledger) !== canonical(observed.ledger);
        if (changed)
          this.automaticOperations = immutableAutomaticLedgerSnapshot(
            AutomaticLedgerSchema.parse(observed.ledger),
          );
        return {
          result: AutomaticLegacyObservationResultSchema.parse({
            status: existing ? 'already_unconfirmed' : 'observed',
            state: 'legacy_unconfirmed',
            shouldProcess: false,
            attemptAudit: observed.attemptAudit ?? 'not_recorded',
          }),
          changed,
        };
      },
      {
        operation: 'automatic_legacy_observation',
        durable: true,
        shouldWriteSnapshot: (result) => result.changed,
      },
    );
    return mutation.result;
  }

  supportsDurableExtraction(): boolean {
    return Boolean(this.persistPath);
  }

  /** Capture and refresh without a write; serialize state/index swap with local mutations. */
  async readExtractionSnapshot(groupId?: string): Promise<GraphData> {
    this.assertRecoveryReady();
    const previous = this.mutationTail;
    let release!: () => void;
    this.mutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      this.assertQueueFilePresent();
      if (this.persistPath && fs.existsSync(this.persistPath)) {
        const stat = await fs.promises.stat(this.persistPath);
        if (stat.size > 100 * 1024 * 1024) throw new Error('Engram queue: snapshot_limit');
        const parsed = migrateGraphData(
          JSON.parse(await fs.promises.readFile(this.persistPath, 'utf8')),
        ).data;
        if (parsed.entities.length + parsed.edges.length + parsed.episodes.length > 100000)
          throw new Error('Engram queue: snapshot_limit');
        this.replaceGraphData(parsed);
      }
      const snapshot = JSON.parse(JSON.stringify(await this.exportGraph(groupId))) as GraphData;
      if (snapshot.automatic_operations_v1) {
        snapshot.automatic_operations_v1 = immutableAutomaticLedgerSnapshot(
          snapshot.automatic_operations_v1,
        );
      }
      return snapshot;
    } finally {
      release();
    }
  }

  async beginAndClaimAutomaticCaptureV2(
    input: AutomaticCaptureBeginRequestV2,
    mode?: 'existingStore',
  ): Promise<AutomaticCaptureBeginInternalResultV2> {
    if (mode !== undefined && mode !== 'existingStore') return { kind: 'invalid_input' };
    let request: AutomaticCaptureBeginRequestV2;
    try {
      request = AutomaticCaptureBeginRequestV2Schema.parse(
        cloneBoundedAutomaticCaptureJson(input, 'beginRequest'),
      );
    } catch {
      return { kind: 'invalid_input' };
    }
    if (!this.initialized) return { kind: 'unsupported_mode' };
    const storeHash = embeddedAutomaticCaptureStoreHash(this.persistPath);
    if (!storeHash || request.purpose !== 'human_turn_memory') return { kind: 'unsupported_mode' };
    const begin = this.automaticCaptureHandles.startBegin('human_turn_memory');
    const sourceId = generateUuid();
    const operationId = generateUuid();
    const newEpoch = generateUuid();
    const deadline = performance.now() + request.settings.invocationDeadlineMs;
    const check = () => {
      if (performance.now() >= deadline) throw new ExtractionBudgetError('deadline');
    };
    const prepared = await this.runMutation(
      async () => {
        check();
        const graph = await this.exportGraph();
        if (graph.group_id === undefined) delete graph.group_id;
        const candidate = prepareHumanCaptureBeginV2(
          graph,
          {
            request,
            storeHash,
            sourceId,
            operationId,
            previousEpisodeId: this.findLatestEpisode(request.namespace)?.uuid ?? null,
            backendNow: nowIso(),
            beginCallHash: begin.beginCallHash,
            leaseToken: begin.leaseToken,
          },
          check,
        );
        if (
          'graph' in candidate &&
          (candidate.kind !== 'prepared_claim' || candidate.writeRequired)
        ) {
          if (
            candidate.kind === 'prepared_source_only' ||
            (candidate.kind === 'prepared_claim' && candidate.writeRequired)
          ) {
            candidate.graph.metadata = { ...candidate.graph.metadata, extraction_epoch: newEpoch };
          }
          this.replaceGraphData(candidate.graph);
        }
        return candidate;
      },
      {
        durable: true,
        captureRecords: 'lossless',
        requireExistingSnapshot: mode === 'existingStore',
        shouldWriteSnapshot: (candidate) =>
          'graph' in candidate && (candidate.kind !== 'prepared_claim' || candidate.writeRequired),
      },
    );
    if (prepared.kind === 'prepared_source_only')
      return { kind: 'capacity', sourcePersistence: 'persisted' };
    if (prepared.kind === 'decision' || prepared.kind === 'prepared_decision')
      return prepared.decision;
    // Mint only after the durable source+lease write has acknowledged. A failed
    // snapshot never leaks an internal lease handle to the caller.
    const leaseHandle = this.automaticCaptureHandles.recoverOrIssueInitial(
      begin.scope,
      prepared.leaseFence,
    );
    if (!leaseHandle) throw new Error('Engram automatic capture: invalid_handle');
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
    // Authentication and consumption precede both plan access and the first
    // await. A copied, cross-instance, or reused handle causes no storage I/O.
    let capability: PrivateConsumedAutomaticCaptureInvocation<'human_turn_memory'>;
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
    const storeHash = embeddedAutomaticCaptureStoreHash(this.persistPath);
    if (!storeHash || !this.initialized) return stopped('invalid_input');
    const newEpoch = generateUuid();
    const started = performance.now();
    let deadline = started + 120_000;
    const check = () => {
      if (performance.now() >= deadline) throw new ExtractionBudgetError('deadline');
    };
    const transact = (acknowledgementOnly: boolean) =>
      this.runMutation(
        async (): Promise<AutomaticHumanCaptureCompletionPreparationV2 | null> => {
          check();
          const graph = await this.exportGraph();
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
          )
            return null;
          if (operation?.version === 2)
            deadline = Math.min(deadline, started + operation.descriptor.invocationDeadlineMs);
          const candidate = prepareHumanCaptureCompletionV2(
            graph,
            preparedPlan,
            this.automaticCaptureHandles,
            capability,
            { backendNow: nowIso(), storeHash },
            check,
          );
          if (
            acknowledgementOnly &&
            candidate.kind !== 'ack_recovered' &&
            candidate.kind !== 'decision'
          )
            throw new Error('Engram automatic capture: invalid_acknowledgement');
          if (
            !acknowledgementOnly &&
            'graph' in candidate &&
            (candidate.kind !== 'prepared_retry' || candidate.writeRequired)
          ) {
            if (
              candidate.kind === 'prepared_commit' &&
              (candidate.graph.entities.length > graph.entities.length ||
                candidate.graph.edges.length > graph.edges.length)
            ) {
              candidate.graph.metadata = {
                ...candidate.graph.metadata,
                extraction_epoch: newEpoch,
              };
            }
            this.replaceGraphData(candidate.graph);
          }
          return candidate;
        },
        {
          durable: true,
          captureRecords: 'lossless',
          shouldWriteSnapshot: (candidate) =>
            !acknowledgementOnly &&
            candidate !== null &&
            'graph' in candidate &&
            (candidate.kind !== 'prepared_retry' || candidate.writeRequired),
        },
      );
    let prepared: AutomaticHumanCaptureCompletionPreparationV2 | null;
    try {
      prepared = await transact(false);
    } catch (error) {
      // A lost acknowledgement is recoverable only for this exact private
      // completion call. Never rerun a plan after an uncertain write failure.
      if (error instanceof ExtractionBudgetError) return stopped('budget_exhausted');
      if (this.recoveryRequired) return stopped('storage_error');
      try {
        prepared = await transact(true);
      } catch {
        return stopped('storage_error');
      }
      if (prepared === null) return stopped('storage_error');
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

  async saveAssistantFinalV2(
    input: AutomaticAssistantCaptureIntentV2,
    workBudget?: AutomaticAssistantWorkBudgetV2,
  ): Promise<AutomaticAssistantFinalWriterResultV2> {
    const started = performance.now();
    const resultSchema = AutomaticAssistantFinalWriterResultV2Schema;
    const stopped = (
      reason: Extract<AutomaticAssistantFinalWriterResultV2, { kind: 'decision' }>['reason'],
    ) => resultSchema.parse({ kind: 'decision', reason, eligibleFirstCommit: false });
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
    const storeHash = embeddedAutomaticCaptureStoreHash(this.persistPath);
    if (!this.initialized || !storeHash) return stopped('unsupported_mode');
    const authorizationRegistry = createAutomaticAssistantCaptureAuthorizationRegistry(
      this.automaticCaptureHandles,
    );
    const begin = this.automaticCaptureHandles.startBegin('assistant_final_save');
    const sourceId = generateUuid();
    const operationId = generateUuid();
    let authorization: PrivateConsumedAutomaticAssistantWriteAuthorizationV2 | null = null;
    const deadline =
      started +
      Math.min(intent.invocationDeadlineMs, budget?.remainingMs ?? intent.invocationDeadlineMs);
    const check = () => {
      if (performance.now() >= deadline) throw new ExtractionBudgetError('deadline');
    };
    let begun;
    let beginStaged = false;
    if (performance.now() >= deadline) return stopped('budget_exhausted');
    try {
      begun = await this.runMutation(
        async () => {
          check();
          const graph = await this.exportGraph();
          if (graph.group_id === undefined) delete graph.group_id;
          const issued = authorizationRegistry.authorize(intent, graph, { storeHash }, check);
          if (!issued) {
            const historical = readAutomaticAssistantCaptureReplayV2(
              graph,
              intent,
              { storeHash },
              check,
            );
            return {
              kind: 'historical_replay' as const,
              result:
                historical.kind === 'committed_replay' && historical.currentAuthority === 'active'
                  ? stopped('authority_changed')
                  : historical,
            };
          }
          authorization = authorizationRegistry.consumeForBegin(issued, intent);
          const candidate = prepareAssistantCaptureBeginV2(
            graph,
            {
              intent,
              storeHash,
              sourceId,
              operationId,
              backendNow: nowIso(),
              previousEpisodeId: this.findLatestEpisode(intent.humanTurn.namespace)?.uuid ?? null,
              beginCallHash: begin.beginCallHash,
              leaseToken: begin.leaseToken,
            },
            authorizationRegistry,
            authorization,
            check,
          );
          if (
            (candidate.kind === 'prepared_claim' && candidate.writeRequired) ||
            (candidate.kind === 'prepared_replay' && candidate.auditWriteRequired) ||
            candidate.kind === 'prepared_decision'
          ) {
            beginStaged = true;
            this.replaceGraphData(candidate.graph);
          }
          return candidate;
        },
        {
          durable: true,
          captureRecords: 'lossless',
          requireExistingSnapshot: true,
          shouldWriteSnapshot: (candidate) =>
            (candidate.kind === 'prepared_claim' && candidate.writeRequired) ||
            (candidate.kind === 'prepared_replay' && candidate.auditWriteRequired) ||
            candidate.kind === 'prepared_decision',
        },
      );
    } catch (error) {
      // Never reapply or resume an assistant begin after an uncertain acknowledgement.
      return stopped(
        error instanceof ExtractionBudgetError && !beginStaged
          ? 'budget_exhausted'
          : 'acknowledgement_unknown',
      );
    }
    if (begun.kind === 'historical_replay') return resultSchema.parse(begun.result);
    if (begun.kind === 'prepared_replay')
      return resultSchema.parse({
        kind: 'committed_replay',
        terminalReceipt: begun.terminalReceipt,
        currentAuthority: begun.currentAuthority,
        eligibleFirstCommit: false,
      });
    if (begun.kind === 'decision' || begun.kind === 'prepared_decision') {
      const decision = resultSchema.safeParse({
        kind: 'decision',
        reason: begun.decision.kind,
        eligibleFirstCommit: false,
      });
      return decision.success ? decision.data : stopped('unsupported_mode');
    }
    if (performance.now() >= deadline) return stopped('budget_exhausted');
    if (!authorization) return stopped('invalid_handle');
    let handle: PrivateOneUseAutomaticLeaseHandle<'assistant_final_save'>;
    let capability: PrivateConsumedAutomaticCaptureInvocation<'assistant_final_save'>;
    try {
      const issued = this.automaticCaptureHandles.recoverOrIssueInitial(
        begin.scope,
        begun.leaseFence,
      );
      if (!issued) return stopped('invalid_handle');
      handle = issued;
      authorizationRegistry.bindAssistantLease(authorization, handle, begun.leaseFence);
      capability = this.automaticCaptureHandles.consumeForCompletion(
        handle,
        'assistant_final_save',
      );
    } catch {
      return stopped('invalid_handle');
    }
    let completionStaged = false;
    const transact = (acknowledgementOnly: boolean) =>
      this.runMutation(
        async (): Promise<AutomaticAssistantCaptureCompletionPreparationV2 | null> => {
          if (!acknowledgementOnly) check();
          const graph = await this.exportGraph();
          if (graph.group_id === undefined) delete graph.group_id;
          const candidate = prepareAssistantFinalCompletionV2(
            graph,
            authorizationRegistry,
            handle,
            capability,
            { storeHash, backendNow: nowIso() },
            acknowledgementOnly ? undefined : check,
          );
          if (acknowledgementOnly && candidate.kind !== 'ack_recovered') return null;
          if (!acknowledgementOnly && candidate.kind === 'prepared_commit') {
            completionStaged = true;
            this.replaceGraphData(candidate.graph);
          }
          return candidate;
        },
        {
          durable: true,
          captureRecords: 'lossless',
          requireExistingSnapshot: true,
          shouldWriteSnapshot: (candidate) =>
            !acknowledgementOnly && candidate?.kind === 'prepared_commit',
        },
      );
    let completed: AutomaticAssistantCaptureCompletionPreparationV2 | null;
    try {
      completed = await transact(false);
      check();
    } catch (error) {
      if (error instanceof ExtractionBudgetError && !completionStaged)
        return stopped('budget_exhausted');
      if (this.recoveryRequired) return stopped('acknowledgement_unknown');
      try {
        completed = await transact(true);
      } catch {
        return stopped('acknowledgement_unknown');
      }
    }
    if (!completed) return stopped('acknowledgement_unknown');
    if (completed.kind === 'decision') return stopped(completed.reason);
    return resultSchema.parse({
      kind: 'committed',
      invocation: completed.kind === 'ack_recovered' ? 'same_call_ack_recovered' : 'initial_owner',
      terminalReceipt: completed.terminalReceipt,
      currentAuthority: completed.kind === 'ack_recovered' ? completed.currentAuthority : 'active',
      eligibleFirstCommit: false,
    });
  }

  async saveAssistantFinalV4(
    invocationToken: PrivateAutonomousPersonalAssistantFinalInvocationV4,
  ): Promise<AutomaticAssistantFinalWriterResultV2> {
    const resultSchema = AutomaticAssistantFinalWriterResultV2Schema;
    const stopped = (
      reason: Extract<AutomaticAssistantFinalWriterResultV2, { kind: 'decision' }>['reason'],
    ): AutomaticAssistantFinalWriterResultV2 =>
      resultSchema.parse({ kind: 'decision', reason, eligibleFirstCommit: false });
    type MutationResult =
      | { kind: 'candidate'; terminalReceipt: AutomaticCaptureTerminalReceiptV2 }
      | { kind: 'replay'; terminalReceipt: AutomaticCaptureTerminalReceiptV2 }
      | {
          kind: 'decision';
          reason: Extract<AutomaticAssistantFinalWriterResultV2, { kind: 'decision' }>['reason'];
        };
    const failureReason = (
      error: unknown,
    ): Extract<AutomaticAssistantFinalWriterResultV2, { kind: 'decision' }>['reason'] => {
      if (
        error instanceof Error &&
        error.message === 'Engram automatic memory: invalid_assistant_final_invocation'
      )
        return 'invalid_handle';
      if (error instanceof ExtractionBudgetError) {
        if (error.budgetReason === 'snapshot_limit') return 'capacity';
        return error.budgetReason === 'cancelled' ? 'interrupted' : 'budget_exhausted';
      }
      if (error instanceof AutonomousPersonalRecordIntegrityV4Error) {
        return error.reason === 'snapshot_capacity' ? 'capacity' : 'conflict';
      }
      if (error instanceof CompositionalRetrievalSnapshotReadError) {
        return error.reason === 'resource_exhausted' ? 'capacity' : 'conflict';
      }
      const classified = autonomousPersonalCaptureStorageFailureV4(error);
      if (classified === 'conflict') return 'conflict';
      if (classified === 'resource_exhausted') return 'capacity';
      return 'storage_error';
    };

    // This single read scope covers the lock-held write and its only possible readback.
    const legacyReadBudget = { remaining: 512, deferred: 0 };
    const scope = getAutomaticClaimReadScope(legacyReadBudget);
    let consumed: PrivateConsumedAutonomousPersonalAssistantFinalInvocationV4 | undefined;
    let access: ReturnType<typeof readAutonomousPersonalAssistantFinalInvocationV4> | undefined;
    let check = () => undefined as void;
    let candidateReturned = false;
    let snapshotReplacementAttempted = false;
    let snapshotDurableAcknowledged = false;
    let stagedReceipt: AutomaticCaptureTerminalReceiptV2 | undefined;

    const committedInitialOwner = (
      terminalReceipt: AutomaticCaptureTerminalReceiptV2,
    ): AutomaticAssistantFinalWriterResultV2 =>
      resultSchema.parse({
        kind: 'committed',
        invocation: 'initial_owner',
        terminalReceipt,
        currentAuthority: 'active',
        eligibleFirstCommit: false,
      });

    const unknownAcknowledgement = async (): Promise<AutomaticAssistantFinalWriterResultV2> => {
      if (!consumed || !access || !candidateReturned) return stopped('acknowledgement_unknown');
      try {
        if (!claimAutonomousPersonalAssistantFinalReconciliationV4(this, consumed))
          return stopped('acknowledgement_unknown');
        await this.runMutation(
          async () => {
            check();
            const graph = await this.exportGraph();
            if (graph.group_id === undefined) delete graph.group_id;
            check();
            return reconcileAutonomousPersonalAssistantFinalV4(
              graph,
              access!.data,
              nowIso(),
              access!.work,
              check,
            );
          },
          {
            operation: 'autonomous_personal_assistant_final_v4_readback',
            captureRecords: 'lossless',
            requireExistingSnapshot: true,
            captureRead: {
              scope,
              check,
              verifyStableSnapshot: true,
            },
            shouldWriteSnapshot: () => false,
            autonomousPersonalCompletionV4: {
              typedSyntaxWork: access.work,
              check,
              onSnapshotReplacementAttempted: () => {},
              onSnapshotReplaced: () => {},
            },
          },
        );
      } catch {
        // The only readback is diagnostic. A visible match cannot prove directory durability.
      }
      return stopped('acknowledgement_unknown');
    };

    try {
      // Consume synchronously before any storage I/O or await.
      consumed =
        consumeAutonomousPersonalAssistantFinalInvocationV4(this, invocationToken) ?? undefined;
      if (!consumed) return stopped('invalid_handle');
      access = readAutonomousPersonalAssistantFinalInvocationV4(this, consumed);
      check = () => {
        access!.check();
        if (!canUseAutomaticClaimReadScope(scope)) throw new ExtractionBudgetError('deadline');
      };
      check();

      const storeHash = embeddedAutomaticCaptureStoreHash(this.persistPath);
      if (!this.initialized || !this.persistPath || !storeHash || !fs.existsSync(this.persistPath))
        return stopped('unsupported_mode');
      if (
        storeHash !== access.data.nativeSnapshot.config.storeHash ||
        storeHash !== access.data.origin.identity.storeHash
      )
        return stopped('conflict');

      const captureRead = {
        scope,
        check,
        verifyStableSnapshot: true,
      };
      const mutationResult = await this.runMutation<MutationResult>(
        async () => {
          check();
          if (!canStageAutonomousPersonalAssistantFinalV4(this, consumed!))
            throw new Error('Engram automatic memory: invalid_assistant_final_invocation');
          const graph = await this.exportGraph();
          if (graph.group_id === undefined) delete graph.group_id;
          check();
          const prepared = prepareAutonomousPersonalAssistantFinalV4(
            graph,
            access!.data,
            nowIso(),
            access!.work,
            check,
          );
          check();
          if (prepared.kind === 'decision') return prepared;
          if (prepared.kind === 'replay') return prepared;
          stagedReceipt = prepared.terminalReceipt;
          this.replaceGraphData(prepared.graph);
          markAutonomousPersonalAssistantFinalCandidateReturnedV4(this, consumed!);
          candidateReturned = true;
          return { kind: 'candidate', terminalReceipt: prepared.terminalReceipt };
        },
        {
          operation: 'autonomous_personal_assistant_final_v4',
          durable: true,
          captureRecords: 'lossless',
          requireExistingSnapshot: true,
          captureRead,
          shouldWriteSnapshot: (result) => result.kind === 'candidate',
          autonomousPersonalCompletionV4: {
            typedSyntaxWork: access.work,
            check,
            onSnapshotReplacementAttempted: () => {
              snapshotReplacementAttempted = true;
            },
            onSnapshotReplaced: () => {
              snapshotReplacementAttempted = true;
            },
            onSnapshotDurableAcknowledged: () => {
              snapshotDurableAcknowledged = true;
            },
          },
        },
      );

      if (mutationResult.kind === 'candidate') {
        return committedInitialOwner(mutationResult.terminalReceipt);
      }
      if (mutationResult.kind === 'replay') {
        return resultSchema.parse({
          kind: 'committed_replay',
          terminalReceipt: mutationResult.terminalReceipt,
          currentAuthority: 'active',
          eligibleFirstCommit: false,
        });
      }
      return stopped(mutationResult.reason);
    } catch (error) {
      if (candidateReturned && snapshotDurableAcknowledged && stagedReceipt)
        return committedInitialOwner(stagedReceipt);
      if (candidateReturned && snapshotReplacementAttempted) return await unknownAcknowledgement();
      return stopped(failureReason(error));
    } finally {
      if (consumed) closeAutonomousPersonalAssistantFinalInvocationV4(this, consumed);
    }
  }

  /** Caller authorization for these administrative controls belongs to the native Admin adapter. */
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
    const storeHash = embeddedAutomaticCaptureStoreHash(this.persistPath);
    if (!this.initialized || !storeHash || request.role !== 'human')
      return failed('unsupported_mode');
    try {
      return await this.runMutation(
        async () => {
          const graph = await this.exportGraph();
          if (graph.group_id === undefined) delete graph.group_id;
          return projectHumanCaptureOutcomeV2(graph, request, { storeHash, backendNow: nowIso() });
        },
        { captureRecords: 'lossless', shouldWriteSnapshot: () => false },
      );
    } catch {
      return failed('failed');
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
    const storeHash = embeddedAutomaticCaptureStoreHash(this.persistPath);
    if (!this.initialized || !storeHash || request.role !== 'human')
      return resultSchema.parse({ kind: 'unsupported_mode', eligibleFirstCommit: false });
    const prepared = await this.runMutation(
      async () => {
        const graph = await this.exportGraph();
        if (graph.group_id === undefined) delete graph.group_id;
        const candidate = prepareHumanCaptureCancelV2(graph, request, {
          storeHash,
          backendNow: nowIso(),
        });
        if (candidate.kind === 'prepared_cancel') this.replaceGraphData(candidate.graph);
        return candidate;
      },
      {
        durable: true,
        captureRecords: 'lossless',
        shouldWriteSnapshot: (candidate) => candidate.kind === 'prepared_cancel',
      },
    );
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
    let request: AutomaticCaptureAdminFenceRequestV2;
    try {
      request = AutomaticCaptureAdminFenceRequestV2Schema.parse(
        cloneBoundedAutomaticCaptureJson(input, 'beginRequest'),
      );
    } catch {
      return { kind: 'invalid_input' };
    }
    const storeHash = embeddedAutomaticCaptureStoreHash(this.persistPath);
    if (!this.initialized || !storeHash || request.role !== 'human')
      return { kind: 'unsupported_mode' };
    // A coherent private pre-read supplies metadata, not authority. The fresh
    // write transaction must match this complete old operation again.
    const source = await this.runMutation(
      async () => {
        const graph = await this.exportGraph();
        if (graph.group_id === undefined) delete graph.group_id;
        return prepareHumanCaptureResumeSourceV2(graph, request, { storeHash });
      },
      { captureRecords: 'lossless', shouldWriteSnapshot: () => false },
    );
    if (source.kind === 'decision') return source.decision;
    const resume = this.automaticCaptureHandles.startResume(
      'human_turn_memory',
      source.resumeSource,
    );
    const transact = (acknowledgementOnly: boolean) =>
      this.runMutation(
        async (): Promise<AutomaticHumanCaptureResumePreparationV2 | null> => {
          const graph = await this.exportGraph();
          if (graph.group_id === undefined) delete graph.group_id;
          if (acknowledgementOnly) {
            const operation = graph.automatic_operations_v1?.operations.find(
              (item) => item.operationId === source.operation.operationId,
            );
            if (
              !(
                operation?.version === 2 &&
                operation.state === 'leased' &&
                operation.generation === source.operation.generation + 1 &&
                operation.lease.token === resume.leaseToken
              )
            )
              return null;
          }
          const candidate = prepareHumanCaptureResumeV2(graph, request, {
            storeHash,
            backendNow: nowIso(),
            leaseToken: resume.leaseToken,
            previousOperation: source.operation,
          });
          if (
            acknowledgementOnly &&
            candidate.kind === 'prepared_resume' &&
            candidate.writeRequired
          )
            throw new Error('Engram automatic capture: invalid_acknowledgement');
          if (
            !acknowledgementOnly &&
            candidate.kind === 'prepared_resume' &&
            candidate.writeRequired
          )
            this.replaceGraphData(candidate.graph);
          return candidate;
        },
        {
          durable: true,
          captureRecords: 'lossless',
          shouldWriteSnapshot: (candidate) =>
            !acknowledgementOnly &&
            candidate?.kind === 'prepared_resume' &&
            candidate.writeRequired,
        },
      );
    let prepared: AutomaticHumanCaptureResumePreparationV2 | null;
    try {
      prepared = await transact(false);
    } catch {
      if (this.recoveryRequired) throw new Error('Engram automatic capture: storage_error');
      try {
        prepared = await transact(true);
      } catch {
        throw new Error('Engram automatic capture: storage_error');
      }
      if (!prepared) throw new Error('Engram automatic capture: storage_error');
    }
    if (!prepared) throw new Error('Engram automatic capture: storage_error');
    if (prepared.kind === 'decision') return prepared.decision;
    const leaseHandle = this.automaticCaptureHandles.recoverOrIssueResume(
      resume.scope,
      prepared.leaseFence,
    );
    if (!leaseHandle) return { kind: 'fenced' };
    return this.automaticCaptureResultSchemas.AutomaticCaptureResumeInternalResultV2Schema.parse({
      kind: 'resumed',
      purpose: 'human_turn_memory',
      sourceId: prepared.leaseFence.sourceId,
      operationId: prepared.leaseFence.operationId,
      leaseHandle,
    });
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
    )
      return { status: 'invalid', reason: 'invalid_context' };
    if (!canUseAutomaticClaimReadScope(scope))
      return { status: 'deferred', reason: 'budget_exhausted' };
    const previous = this.mutationTail;
    let release!: () => void;
    this.mutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      this.assertRecoveryReady();
      this.assertQueueFilePresent();
      if (!this.persistPath) return { status: 'unavailable', reason: 'missing_store' };
      for (let attempt = 0; attempt < 3; attempt++) {
        if (!beginAutomaticClaimReadAttempt(scope))
          return { status: 'deferred', reason: 'budget_exhausted' };
        this.assertRecoveryReady();
        this.assertQueueFilePresent();
        const current = await fs.promises.stat(this.persistPath, { bigint: true });
        const signature = automaticClaimFileSignature(current);
        let snapshot = this.automaticClaimSnapshots.get(scope);
        if (!snapshot || snapshot.signature !== signature) {
          const file = await fs.promises.open(this.persistPath, 'r');
          let raw: string;
          let opened: fs.BigIntStats;
          try {
            opened = await file.stat({ bigint: true });
            const bytes = Number(opened.size);
            if (!reserveAutomaticClaimSnapshotBytes(scope, bytes))
              return { status: 'deferred', reason: 'budget_exhausted' };
            raw = await file.readFile('utf8');
          } finally {
            await file.close();
          }
          if (!canUseAutomaticClaimReadScope(scope))
            return { status: 'deferred', reason: 'budget_exhausted' };
          const after = await fs.promises.stat(this.persistPath, { bigint: true });
          if (automaticClaimFileSignature(opened) !== automaticClaimFileSignature(after)) continue;
          const parsed = migrateGraphData(JSON.parse(raw)).data;
          if (parsed.entities.length + parsed.edges.length + parsed.episodes.length > 100_000)
            return { status: 'invalid', reason: 'context_too_large' };
          assertAutomaticLedgerSourceIntegrity(parsed);
          // Keep scoped proof rows independent of later supported in-memory writes.
          const scoped = JSON.parse(JSON.stringify(parsed)) as GraphData;
          if (!canUseAutomaticClaimReadScope(scope))
            return { status: 'deferred', reason: 'budget_exhausted' };
          // Validation may yield to instrumented filesystem operations. Never
          // install a snapshot whose backing path has already been replaced.
          const validated = await fs.promises.stat(this.persistPath, { bigint: true });
          if (automaticClaimFileSignature(opened) !== automaticClaimFileSignature(validated))
            continue;
          this.replaceGraphData(parsed);
          snapshot = {
            signature: automaticClaimFileSignature(opened),
            graph: scoped,
            indices: buildAutomaticClaimReadIndices(scoped),
          };
          this.automaticClaimSnapshots.set(scope, snapshot);
        }
        const remaining = getAutomaticClaimReadScopeRemaining(scope);
        if (
          !remaining ||
          remaining.contextBytesRemaining === 0 ||
          !canUseAutomaticClaimReadScope(scope)
        )
          return { status: 'deferred', reason: 'budget_exhausted' };
        const projected = projectAutomaticClaimReadContextWithUsage(
          snapshot.graph,
          groupId,
          edgeId,
          snapshot.indices,
          Math.min(512 * 1024, remaining.contextBytesRemaining),
        );
        const charged = Math.min(projected.inspectedBytes, remaining.contextBytesRemaining);
        if (
          !chargeAutomaticClaimContextBytes(scope, charged) ||
          projected.inspectedBytes > remaining.contextBytesRemaining
        )
          return { status: 'deferred', reason: 'budget_exhausted' };
        // Zod's unknown attribute values may retain nested references. A caller
        // must not be able to mutate the private per-scope snapshot through a
        // returned context; the successfully bounded result is safe to detach.
        return projected.result.status === 'committed'
          ? (JSON.parse(JSON.stringify(projected.result)) as AutomaticClaimReadResult)
          : projected.result;
      }
      return { status: 'deferred', reason: 'snapshot_changed' };
    } catch (error) {
      if (this.recoveryRequired) return { status: 'unavailable', reason: 'recovery_required' };
      if (
        error instanceof Error &&
        (('code' in error && error.code === 'ENOENT') || error.message.includes('store_missing'))
      )
        return { status: 'unavailable', reason: 'missing_store' };
      return { status: 'invalid', reason: 'invalid_context' };
    } finally {
      release();
    }
  }

  async readCompositionalRetrievalSnapshotV3(
    scope: AutomaticClaimReadScope,
  ): Promise<CompositionalRetrievalSnapshotResultV3> {
    const resultSchema = CompositionalRetrievalSnapshotV3Schema;
    const failure = (
      status: 'deferred' | 'unavailable' | 'invalid',
      reason: string,
    ): CompositionalRetrievalSnapshotResultV3 => resultSchema.parse({ status, reason });

    if (!getAutomaticClaimReadScopeRemaining(scope)) return failure('invalid', 'invalid_scope');
    if (!canUseAutomaticClaimReadScope(scope)) return failure('deferred', 'budget_exhausted');
    if (this.recoveryRequired) return failure('unavailable', 'recovery_required');
    if (!this.initialized || !this.persistPath) return failure('unavailable', 'missing_store');
    if (!beginAutomaticClaimReadAttempt(scope)) return failure('deferred', 'budget_exhausted');

    let checkFailed = false;
    let checkFailure: unknown;
    const check = () => {
      if (checkFailed) throw checkFailure;
      try {
        if (!canUseAutomaticClaimReadScope(scope)) throw new ExtractionBudgetError('deadline');
        if (this.recoveryRequired) throw new Error('Engram automatic capture: recovery_required');
      } catch (error) {
        checkFailed = true;
        checkFailure = error;
        throw error;
      }
    };

    const readError = (error: unknown): CompositionalRetrievalSnapshotResultV3 => {
      if (this.recoveryRequired) return failure('unavailable', 'recovery_required');
      if (error instanceof CompositionalRetrievalSnapshotReadError) {
        return error.reason === 'concurrent_snapshot'
          ? failure('deferred', error.reason)
          : error.reason === 'resource_exhausted'
            ? failure('deferred', error.reason)
            : failure('invalid', error.reason);
      }
      if (error instanceof ExtractionBudgetError && error.budgetReason === 'snapshot_limit')
        return failure('deferred', 'resource_exhausted');
      if (error instanceof ExtractionBudgetError || checkFailure instanceof ExtractionBudgetError)
        return failure('deferred', 'budget_exhausted');
      if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
        return failure('unavailable', 'missing_store');
      if (
        error instanceof Error &&
        (error.message.includes('store_missing') || error.message.includes('missing snapshot'))
      )
        return failure('unavailable', 'missing_store');
      if (
        error instanceof SyntaxError ||
        (error instanceof Error &&
          (error.name === 'ZodError' ||
            error.message.includes('record_normalization') ||
            error.message.includes('snapshot_limit') ||
            error.message.includes('native_root_missing') ||
            error.message.includes('invalid snapshot') ||
            error.message.includes('unsupported_mode')))
      )
        return error instanceof Error && error.message.includes('snapshot_limit')
          ? failure('deferred', 'resource_exhausted')
          : failure('invalid', 'invalid_snapshot');
      return failure('unavailable', 'storage_error');
    };

    try {
      check();
      const result = await this.runMutation(
        async () => {
          check();
          const graph = await this.exportGraph();
          if (graph.group_id === undefined) delete graph.group_id;
          // Preserve this backend's recent-message order in the returned copy:
          // creation time, then persisted insertion order for equal times.
          graph.episodes = graph.episodes
            .map((episode, index) => {
              check();
              return { episode, index, time: Date.parse(episode.created_at) };
            })
            .sort((a, b) => {
              check();
              return a.time - b.time || a.index - b.index;
            })
            .map(({ episode }) => {
              check();
              return episode;
            });
          check();
          const parsed = resultSchema.safeParse({
            status: 'snapshot',
            graph,
            backendNow: nowIso(),
          });
          check();
          if (parsed.success) return parsed.data;
          const resource = parsed.error.issues.some(
            (issue) => issue.message === 'resource_exhausted',
          );
          return resource
            ? failure('deferred', 'resource_exhausted')
            : failure('invalid', 'invalid_snapshot');
        },
        {
          operation: 'compositional_retrieval_snapshot_v3',
          captureRecords: 'lossless',
          requireExistingSnapshot: true,
          captureRead: {
            scope,
            check,
            attemptReserved: true,
            verifyStableSnapshot: true,
          },
          shouldWriteSnapshot: () => false,
        },
      );
      check();
      return result;
    } catch (error) {
      try {
        check();
      } catch {
        /* Preserve the fixed budget or recovery classification below. */
      }
      return readError(error);
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
    if (!this.persistPath) throw new Error('Engram queue: persistence_required');
    await fs.promises.mkdir(path.dirname(this.persistPath), { recursive: true });
    if (
      !inputs.length ||
      inputs.length > 1000 ||
      inputs.some((ep) => ep.group_id !== inputs[0].group_id)
    )
      throw new Error('Engram queue: invalid_batch');
    const prepared = inputs.map((input) => {
      assertAutomaticEpisodeTrustedPath(input, allowTrustedAutomatic);
      if (input.attributes?.[QUEUE_ATTRIBUTE] !== undefined)
        throw new Error('Engram queue: reserved_attribute');
      return {
        parsed: CreateEpisodicNodeSchema.parse(
          allowTrustedAutomatic ? prepareAutomaticEpisodeInput(input) : input,
        ),
        auto: !Object.prototype.hasOwnProperty.call(input, 'previous_episode_uuid'),
      };
    });
    return this.runMutation(
      async () => {
        if (
          allowTrustedAutomatic &&
          prepared.some(
            ({ parsed }) =>
              Object.prototype.hasOwnProperty.call(parsed.attributes, SOURCE_ENVELOPE_ATTRIBUTE) ||
              Object.prototype.hasOwnProperty.call(parsed.attributes, WRITE_OWNER_ATTRIBUTE),
          )
        ) {
          const current = JSON.parse(JSON.stringify(await this.exportGraph())) as GraphData;
          for (const item of prepared) assertAutomaticEpisodeBinding(current, item.parsed);
        }
        const results = prepared.map((item) => this.appendEpisodeInternal(item.parsed, item.auto));
        const graph = JSON.parse(JSON.stringify(await this.exportGraph())) as GraphData;
        const refs = enqueue(graph, results, eligible, binding, limits, nowIso());
        this.replaceGraphData(graph);
        return {
          results: results.map((item) => ({
            ...item,
            episode: protectAutomaticEpisode(
              graph.episodes.find((ep) => ep.uuid === item.episode.uuid)!,
            ),
          })),
          jobs: refs,
          queue: queueStats(graph, inputs[0].group_id),
        };
      },
      { operation: 'append_enqueue', itemCount: inputs.length, durable: true },
    );
  }

  async extractionQueueCommand(command: QueueCommand): Promise<QueueResult> {
    if (!this.persistPath) throw new Error('Engram queue: persistence_required');
    return this.runMutation(
      async () => {
        const graph = JSON.parse(JSON.stringify(await this.exportGraph())) as GraphData;
        const result = queueCommand(graph, command, nowIso());
        this.replaceGraphData(graph);
        return result;
      },
      {
        operation: 'extraction_queue',
        durable: true,
        shouldWriteSnapshot: () => command.action !== 'status',
      },
    );
  }

  async importExtractionBackup(input: unknown): Promise<void> {
    assertNoRawAutonomousPersonalFamilyFourImport(input);
    const backupGraph = rawOwnDataProperty(input, 'graph');
    if (backupGraph === UNREADABLE_RAW_IMPORT_V4) {
      throw new Error('Engram automatic memory: invalid_import_data');
    }
    assertNoImportedAutomaticOperations(backupGraph);
    await this.runMutation(
      async () => {
        const existing = await this.exportGraph();
        const incoming = prepareQueueImport(input, existing, nowIso());
        this.mergeGraphData(prepareAutomaticImport(incoming, existing));
        this.extractionEpoch = generateUuid();
      },
      { operation: 'import_extraction_backup', durable: true },
    );
  }

  async applyStagedExtraction(plan: StagedExtraction): Promise<void> {
    await this.runMutation(
      async () => {
        const graph = JSON.parse(JSON.stringify(await this.exportGraph())) as GraphData;
        applyPlan(graph, plan);
        this.replaceGraphData(graph);
      },
      { operation: 'apply_extraction', durable: true },
    );
  }

  // ===== Entity Operations =====

  async addEntity(input: CreateEntityNode): Promise<EntityNode> {
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

    return this.runMutation(() => {
      this.graph.addNode(entity.uuid, { type: 'entity', data: entity });
      this.searchProvider.indexEntity(entity.uuid, {
        name: entity.name,
        summary: entity.summary,
        entity_type: entity.entity_type,
      });

      return entity;
    });
  }

  async getEntity(uuid: string): Promise<EntityNode | null> {
    this.assertRecoveryReady();
    if (!this.graph.hasNode(uuid)) return null;
    const attrs = this.graph.getNodeAttributes(uuid);
    if (attrs.type !== 'entity') return null;
    return attrs.data as EntityNode;
  }

  async getEntityByName(name: string, groupId: string): Promise<EntityNode | null> {
    this.assertRecoveryReady();
    const normalized = name.toLowerCase().trim();
    let found: EntityNode | null = null;

    this.graph.forEachNode((key, attrs) => {
      if (found) return;
      if (attrs.type !== 'entity') return;
      const entity = attrs.data as EntityNode;
      if (entity.group_id === groupId && entity.name.toLowerCase().trim() === normalized) {
        found = entity;
      }
    });

    return found;
  }

  async updateEntity(uuid: string, updates: Partial<EntityNode>): Promise<EntityNode> {
    return this.runMutation(() => {
      const existing = this.getEpisodeOrEntity(uuid, 'entity') as EntityNode | null;
      if (!existing) throw new Error(`Entity not found: ${uuid}`);
      const safeUpdates = prepareAutomaticEntityUpdate(existing, updates);

      const updated = protectAutomaticEntity({
        ...existing,
        ...safeUpdates,
        uuid: existing.uuid,
        created_at: existing.created_at,
        updated_at: nowIso(),
      });

      this.graph.setNodeAttribute(uuid, 'data', updated);
      this.searchProvider.indexEntity(updated.uuid, {
        name: updated.name,
        summary: updated.summary,
        entity_type: updated.entity_type,
      });

      return updated;
    });
  }

  async deleteEntity(uuid: string): Promise<void> {
    await this.runMutation(() => {
      if (!this.graph.hasNode(uuid)) return;
      const existing = this.getEpisodeOrEntity(uuid, 'entity') as EntityNode | null;
      if (existing) assertAutomaticEntityDeleteAllowed(existing);

      // Remove connected edges from search index before Graphology drops them
      this.graph.forEachEdge(uuid, (edgeKey, attrs) => {
        if (attrs.type === 'entity_edge') {
          this.searchProvider.removeEdge(edgeKey);
        }
      });

      this.searchProvider.removeEntity(uuid);
      this.graph.dropNode(uuid);
    });
  }

  async listEntities(groupId: string, options?: ListOptions): Promise<EntityNode[]> {
    this.assertRecoveryReady();
    const entities: EntityNode[] = [];

    this.graph.forEachNode((_key, attrs) => {
      if (attrs.type !== 'entity') return;
      const entity = attrs.data as EntityNode;
      if (entity.group_id !== groupId) return;
      if (options?.entity_type && entity.entity_type !== options.entity_type) return;
      if (
        (options?.created_after || options?.created_before) &&
        !isWithinDateRange(entity.created_at, options?.created_after, options?.created_before)
      )
        return;
      entities.push(entity);
    });

    entities.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    const offset = options?.offset ?? 0;
    const limit = options?.limit ?? entities.length;
    return entities.slice(offset, offset + limit);
  }

  // ===== Edge Operations =====

  async addEdge(input: CreateEntityEdge): Promise<EntityEdge> {
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

    return this.runMutation(() => {
      // Ensure source and target nodes exist
      if (
        !this.graph.hasNode(edge.source_node_uuid) ||
        !this.graph.hasNode(edge.target_node_uuid)
      ) {
        throw new Error(
          `Cannot create edge: source (${edge.source_node_uuid}) or target (${edge.target_node_uuid}) node not found`,
        );
      }

      this.graph.addEdgeWithKey(edge.uuid, edge.source_node_uuid, edge.target_node_uuid, {
        type: 'entity_edge',
        data: edge,
      });

      this.searchProvider.indexEdge(edge.uuid, {
        name: edge.name,
        fact: edge.fact,
      });

      return edge;
    });
  }

  async getEdge(uuid: string): Promise<EntityEdge | null> {
    this.assertRecoveryReady();
    if (!this.graph.hasEdge(uuid)) return null;
    const attrs = this.graph.getEdgeAttributes(uuid);
    if (attrs.type !== 'entity_edge') return null;
    return attrs.data as EntityEdge;
  }

  async getEdgesBetween(
    sourceUuid: string,
    targetUuid: string,
    limit?: number,
  ): Promise<EntityEdge[]> {
    this.assertRecoveryReady();
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 129)) {
      throw new Error('Edge limit must be an integer between 1 and 129');
    }
    const edges: EntityEdge[] = [];

    if (!this.graph.hasNode(sourceUuid) || !this.graph.hasNode(targetUuid)) return edges;

    if (limit === undefined) {
      this.graph.forEachEdge(sourceUuid, (_edgeKey, attributes, source, target) => {
        if (attributes.type !== 'entity_edge' || !attributes.data) return;
        if (
          (source === sourceUuid && target === targetUuid) ||
          (source === targetUuid && target === sourceUuid)
        ) {
          edges.push(attributes.data as EntityEdge);
        }
      });
      return edges;
    }

    for (const entry of this.graph.edgeEntries(sourceUuid)) {
      const { attributes, source, target } = entry;
      if (attributes.type !== 'entity_edge' || !attributes.data) continue;
      if (
        (source === sourceUuid && target === targetUuid) ||
        (source === targetUuid && target === sourceUuid)
      ) {
        edges.push(attributes.data as EntityEdge);
        if (edges.length >= limit) break;
      }
    }

    return edges;
  }

  async getEdgesForEntity(entityUuid: string): Promise<EntityEdge[]> {
    this.assertRecoveryReady();
    const edges: EntityEdge[] = [];

    if (!this.graph.hasNode(entityUuid)) return edges;

    this.graph.forEachEdge(entityUuid, (_edgeKey, attrs) => {
      if (attrs.type !== 'entity_edge' || !attrs.data) return;
      edges.push(attrs.data as EntityEdge);
    });

    return edges;
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
      const view = getAutonomousPersonalCaptureProviderPreflightAccessV4(this, access);
      check = view.check;
      check();
      const { scope } = view;
      const storeHash = embeddedAutomaticCaptureStoreHash(this.persistPath);
      if (!this.initialized || !this.persistPath || !storeHash) return stopped('unsupported_mode');
      if (storeHash !== scope.context.storeHash) return stopped('conflict');
      const readStartedAtMonotonicMs = performance.now();
      const snapshot = await this.runMutation(
        async () => {
          check();
          const graph = await this.exportGraph();
          if (graph.group_id === undefined) delete graph.group_id;
          const backendNow = nowIso();
          const prepared = prepareAutonomousPersonalCaptureSnapshotV4(
            {
              request: scope.request,
              context: scope.context,
              sourceId: scope.sourceId,
              operationId: scope.operationId,
              leaseToken: scope.leaseToken,
              stableBeginHash: scope.stableBeginHash,
              attemptHash: scope.attemptHash,
              backendNow,
              previousEpisodeId: this.findLatestEpisode(scope.request.namespace)?.uuid ?? null,
            },
            graph,
            check,
          );
          check();
          if (prepared.kind === 'no_write')
            return { kind: 'decision' as const, result: prepared.resultProjection };
          if (prepared.kind !== 'same_initial_scope_candidate')
            return { kind: 'decision' as const, result: stopped('conflict') };
          const binding = findAutomaticBinding(
            graph,
            scope.request.namespace,
            scope.request.issuer,
            scope.request.actorReference,
            check,
          );
          if (!binding || binding.state !== 'active')
            return { kind: 'decision' as const, result: stopped('authority_changed') };
          const bindingRef = {
            bindingId: binding.bindingId,
            revision: binding.revision,
            subjectId: binding.subjectId,
            fingerprint: binding.fingerprint,
          };
          assertAutomaticBindingIdentity(
            graph,
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
            backendNow,
            readStartedAtMonotonicMs,
          });
          check();
          return { kind: 'observation' as const, observation };
        },
        {
          operation: 'autonomous_personal_provider_preflight_v4',
          captureRecords: 'lossless',
          requireExistingSnapshot: true,
          shouldWriteSnapshot: () => false,
        },
      );
      check();
      if (snapshot.kind === 'decision') return snapshot.result;
      const result = bindAutonomousPersonalCaptureProviderPreflightV4(
        this,
        access,
        snapshot.observation,
      );
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
    let check = () => undefined as void;
    let snapshotReplacementAttempted = false;
    let expectedInput: AutonomousPersonalCompletionPlanV4Input | undefined;
    let expectedPlan: Extract<AutonomousPersonalCompletionPlanV4, { kind: 'planned' }> | undefined;
    let expectedNativeOrigin: AutonomousPersonalNativeOriginV4 | undefined;
    let nativeOrigin: AutonomousPersonalNativeOriginV4 | undefined;
    let knownDurableAck = false;

    const coreOutcome = (
      observation: AutonomousPersonalCompletionStorageV4Result,
      witness: TrustedCompletedAutonomousPersonalWriteV4 | null = null,
    ): BackendCompletionCoreOutcomeV4 => Object.freeze({ observation, witness });

    const unconfirmed = () =>
      AutonomousPersonalCompletionStorageV4ResultOwnedDataSchema.parse({ kind: 'unconfirmed' });
    const readback = async (): Promise<AutonomousPersonalCompletionStorageV4Result> => {
      if (!access || !expectedInput || !expectedPlan) return unconfirmed();
      try {
        const result = await this.runMutation(
          async () => {
            check();
            const graph = await this.exportGraph();
            if (graph.group_id === undefined) delete graph.group_id;
            check();
            return validateAutonomousPersonalCompletionReadbackV4(
              graph,
              expectedInput,
              expectedPlan,
              runtime.typedSyntaxWork,
              check,
            );
          },
          {
            operation: 'autonomous_personal_completion_v4_readback',
            captureRecords: 'lossless',
            requireExistingSnapshot: true,
            captureRead,
            shouldWriteSnapshot: () => false,
            autonomousPersonalCompletionV4: {
              typedSyntaxWork: runtime.typedSyntaxWork,
              check,
              onSnapshotReplacementAttempted: () => {},
              onSnapshotReplaced: () => {},
            },
          },
        );
        return AutonomousPersonalCompletionStorageV4ResultOwnedDataSchema.parse(result);
      } catch {
        if (snapshotReplacementAttempted) this.recoveryRequired = true;
        return unconfirmed();
      }
    };

    let runtime: ReturnType<typeof getAutonomousPersonalCompletionAccessV4>;
    let captureRead: NonNullable<MutationOptions<unknown>['captureRead']>;
    try {
      // Consume the opaque handle synchronously, before any disk or queue I/O.
      access = consumeAutonomousPersonalCompletionHandleV4(this, handle);
      runtime = getAutonomousPersonalCompletionAccessV4(this, access);
      check = runtime.check;
      check();
      originalHandle = handle as PrivateAutonomousPersonalCompletionHandleV4;
      const { scope } = runtime.view;
      const storeHash = embeddedAutomaticCaptureStoreHash(this.persistPath);
      if (
        !this.initialized ||
        !this.persistPath ||
        !storeHash ||
        !fs.existsSync(this.persistPath)
      ) {
        return coreOutcome(autonomousPersonalCompletionNoWriteV4('invalid_input'));
      }
      if (storeHash !== scope.context.storeHash) {
        return coreOutcome(autonomousPersonalCompletionNoWriteV4('conflict'));
      }
      captureRead = {
        scope: getAutomaticClaimReadScope(runtime.legacyReadBudget),
        check,
        verifyStableSnapshot: true,
      };
    } catch (error) {
      return coreOutcome(
        autonomousPersonalCompletionNoWriteV4(
          autonomousPersonalCompletionStorageFailureReasonV4(error),
        ),
      );
    }
    const preparedExtractionEpoch = generateUuid();

    const mutationResult: {
      kind: 'write_candidate' | 'no_write';
      reason?: AutonomousPersonalCompletionPlanV4NoWriteReason;
    } = await (async () => {
      try {
        const result = await this.runMutation(
          async () => {
            check();
            const graph = await this.exportGraph();
            if (graph.group_id === undefined) delete graph.group_id;
            check();
            const backendNow = nowIso();
            const { scope, stagedFresh, outcome, selection, completionCallHash, audit } =
              runtime.view;
            const input = AutonomousPersonalCompletionPlanV4InputOwnedDataSchema.parse({
              scope,
              stagedFresh,
              outcome: outcome.kind === 'response' ? { kind: 'response' as const } : outcome,
              backendNow,
              completionCallHash,
              audit,
            });
            check();
            const plan = planAutonomousPersonalCaptureCompletionV4(
              input,
              graph,
              outcome.kind === 'response' ? outcome.response : null,
              selection,
              runtime.typedSyntaxWork,
              check,
              runtime.legacyReadBudget,
            );
            check();
            if (plan.kind === 'no_write') {
              return { kind: 'no_write' as const, reason: plan.reason };
            }

            if (mode === 'data') {
              assertAutonomousPersonalCompletionPlanAggregateBytesV4(this, access, plan);
              check();
            }
            const extractionEpoch =
              plan.createEntities.length > 0 || plan.createEdges.length > 0
                ? preparedExtractionEpoch
                : null;
            const candidate = prepareAutonomousPersonalCompletionGraphCandidateV4(
              graph,
              input,
              plan,
              extractionEpoch,
              runtime.typedSyntaxWork,
              check,
            );
            check();
            if (candidate.kind === 'no_write') {
              return { kind: 'no_write' as const, reason: candidate.reason };
            }

            if (mode === 'native_proof') {
              nativeOrigin = projectAutonomousPersonalNativeOriginV4(input, plan, check);
              assertAutonomousPersonalCompletionNativeAggregateBytesV4(
                this,
                access,
                plan,
                nativeOrigin,
              );
              check();
            }
            expectedInput = input;
            expectedPlan = plan;
            expectedNativeOrigin = nativeOrigin;
            this.replaceGraphData(candidate.graph);
            check();
            return { kind: 'write_candidate' as const };
          },
          {
            operation: 'autonomous_personal_completion_v4',
            durable: true,
            captureRecords: 'lossless',
            requireExistingSnapshot: true,
            captureRead,
            shouldWriteSnapshot: (result) => result.kind === 'write_candidate',
            autonomousPersonalCompletionV4: {
              typedSyntaxWork: runtime.typedSyntaxWork,
              check,
              onSnapshotReplacementAttempted: () => {
                snapshotReplacementAttempted = true;
              },
              onSnapshotReplaced: () => {
                snapshotReplacementAttempted = true;
              },
            },
          },
        );
        if (result.kind === 'write_candidate') knownDurableAck = true;
        return result;
      } catch (error) {
        if (snapshotReplacementAttempted) return { kind: 'write_candidate' as const };
        const reason =
          error instanceof AutonomousPersonalNativeOriginV4Error
            ? error.reason
            : autonomousPersonalCompletionStorageFailureReasonV4(error);
        return {
          kind: 'no_write' as const,
          reason,
        };
      }
    })();

    if (mutationResult.kind === 'no_write') {
      return coreOutcome(
        autonomousPersonalCompletionNoWriteV4(mutationResult.reason ?? 'inspection_incomplete'),
      );
    }
    // A successful durable rename or a post-rename error both require one
    // coherent readback. Neither path can resubmit this consumed handle.
    const observation = await readback();
    let witness: TrustedCompletedAutonomousPersonalWriteV4 | null = null;
    if (
      mode === 'native_proof' &&
      knownDurableAck &&
      observation.kind === 'matched' &&
      access &&
      originalHandle &&
      expectedInput &&
      expectedPlan &&
      nativeOrigin &&
      expectedNativeOrigin === nativeOrigin
    ) {
      try {
        check();
        const opaqueWitness = Object.freeze(
          Object.create(null),
        ) as TrustedCompletedAutonomousPersonalWriteV4;
        const link: TrustedAutonomousPersonalCompletionWitnessLinkV4 = Object.freeze({
          originalHandle,
          completionAccess: access as PrivateAutonomousPersonalCompletionAccessV4,
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

  async beginAndClaimAutonomousPersonalCaptureV4(
    input: unknown,
    attempt: unknown,
  ): Promise<AutonomousPersonalCaptureBeginV4InternalResult> {
    const resultSchema = getAutonomousPersonalCaptureBeginV4InternalResultSchema();
    const stopped = (kind: string) => resultSchema.parse({ kind, eligibleFirstCommit: false });
    const storeHash = embeddedAutomaticCaptureStoreHash(this.persistPath);
    if (!this.initialized || !this.persistPath || !storeHash || !fs.existsSync(this.persistPath))
      return stopped('unsupported_mode');
    const admitted = consumeAutonomousPersonalCaptureAttemptV4(this, input, attempt);
    if (admitted.kind === 'decision') return admitted.result;
    const { check } = admitted;
    let acknowledged = false;
    let freshStaged = false;
    let mutationPrepared = false;
    try {
      const preflight = await this.runMutation(
        async () => {
          check();
          const graph = await this.exportGraph();
          if (graph.group_id === undefined) delete graph.group_id;
          check();
          return parseLosslessAutomaticCaptureGraph(graph);
        },
        {
          operation: 'autonomous_personal_preflight_v4',
          captureRecords: 'lossless',
          requireExistingSnapshot: true,
          shouldWriteSnapshot: () => false,
        },
      );
      check();
      const request = admitted.scope.request;
      const binding = findAutomaticBinding(
        preflight,
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
          preflight,
          request.namespace,
          request.issuer,
          request.actorReference,
          bindingRef,
          check,
        );
      } catch (error) {
        check();
        const kind = getAutonomousPersonalCaptureFailureKindV4(error);
        return stopped(kind ?? 'authority_changed');
      }
      const scope = bindAutonomousPersonalCapturePreflightV4(this, attempt, {
        storeHash,
        binding: bindingRef,
      });
      const prepare = (graph: GraphData) =>
        prepareAutonomousPersonalCaptureSnapshotV4(
          {
            request: scope.request,
            context: scope.context,
            sourceId: scope.sourceId,
            operationId: scope.operationId,
            leaseToken: scope.leaseToken,
            stableBeginHash: scope.stableBeginHash,
            attemptHash: scope.attemptHash,
            backendNow: nowIso(),
            previousEpisodeId: this.findLatestEpisode(request.namespace)?.uuid ?? null,
          },
          graph,
          check,
        );
      const epoch = generateUuid();
      try {
        const prepared = await this.runMutation(
          async () => {
            check();
            const graph = await this.exportGraph();
            if (graph.group_id === undefined) delete graph.group_id;
            const candidate = prepare(graph);
            check();
            if (candidate.kind === 'initial_candidate') {
              const next: GraphData = {
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
              const validated = validateAutomaticCaptureCandidate(next, check);
              if (!validated)
                return { kind: 'no_write' as const, resultProjection: stopped('capacity') };
              stageFreshAutonomousPersonalCaptureV4(this, attempt, candidate);
              freshStaged = true;
              this.replaceGraphData(validated);
            } else if (candidate.kind === 'audit_candidate') {
              const next: GraphData = {
                ...graph,
                automatic_operations_v1: {
                  version: 1,
                  operations: (graph.automatic_operations_v1?.operations ?? []).map((operation) =>
                    operation.operationId === candidate.operation.operationId
                      ? candidate.operation
                      : operation,
                  ),
                },
              };
              const validated = validateAutomaticCaptureCandidate(next, check);
              if (!validated)
                return { kind: 'no_write' as const, resultProjection: stopped('capacity') };
              this.replaceGraphData(validated);
            }
            check();
            mutationPrepared =
              candidate.kind === 'initial_candidate' || candidate.kind === 'audit_candidate';
            return candidate;
          },
          {
            operation: 'autonomous_personal_begin_v4',
            durable: true,
            captureRecords: 'lossless',
            requireExistingSnapshot: true,
            shouldWriteSnapshot: (candidate) =>
              candidate.kind === 'initial_candidate' || candidate.kind === 'audit_candidate',
          },
        );
        acknowledged = true;
        if (prepared.kind === 'no_write' || prepared.kind === 'audit_candidate')
          return resultSchema.parse(prepared.resultProjection);
        if (!freshStaged) return stopped('in_progress');
      } catch (error) {
        const kind = getAutonomousPersonalCaptureFailureKindV4(error);
        if (kind && (!mutationPrepared || acknowledged)) return stopped(kind);
        const validation = autonomousPersonalCaptureStorageFailureV4(error);
        if (validation) return stopped(validation);
        if (!freshStaged)
          return stopped(mutationPrepared ? 'acknowledgement_unknown' : 'storage_error');
        // The original mutation has terminated. One locked read may observe its
        // exact commit or authoritative absence; it never retries that write.
      }

      beginAutonomousPersonalCaptureReadbackV4(
        this,
        attempt,
        acknowledged ? 'acknowledged' : 'unknown',
      );
      try {
        return await this.runMutation(
          async () => {
            check();
            const graph = await this.exportGraph();
            if (graph.group_id === undefined) delete graph.group_id;
            const source = graph.episodes.find((episode) => episode.uuid === scope.sourceId);
            const operation = graph.automatic_operations_v1?.operations.find(
              (row) => row.operationId === scope.operationId,
            );
            if (!source && !operation) return stopped('storage_error');
            if (!source || !operation) return stopped('conflict');
            const observed = prepare(graph);
            check();
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
          },
          {
            operation: 'autonomous_personal_readback_v4',
            captureRecords: 'lossless',
            requireExistingSnapshot: true,
            shouldWriteSnapshot: () => false,
          },
        );
      } catch (error) {
        if (isAutonomousPersonalCaptureProvenCommitBudgetFailureV4(error))
          return stopped('budget_exhausted');
        const kind = getAutonomousPersonalCaptureFailureKindV4(error);
        const validation = autonomousPersonalCaptureStorageFailureV4(error);
        return stopped(
          acknowledged
            ? (kind ?? validation ?? 'storage_error')
            : kind === 'conflict'
              ? 'conflict'
              : (validation ?? 'acknowledgement_unknown'),
        );
      }
    } catch (error) {
      if (isAutonomousPersonalCaptureProvenCommitBudgetFailureV4(error))
        return stopped('budget_exhausted');
      const kind = getAutonomousPersonalCaptureFailureKindV4(error);
      const validation = autonomousPersonalCaptureStorageFailureV4(error);
      if (mutationPrepared && !acknowledged)
        return stopped(
          kind === 'conflict' ? 'conflict' : (validation ?? 'acknowledgement_unknown'),
        );
      return stopped(
        kind ??
          validation ??
          (isCompositionalSnapshotResourceFailure(error) ? 'resource_exhausted' : 'storage_error'),
      );
    } finally {
      closeAutonomousPersonalCaptureAttemptV4(this, attempt);
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
    const storeHash = embeddedAutomaticCaptureStoreHash(this.persistPath);
    if (!this.initialized || !storeHash)
      return { kind: 'unsupported_mode', eligibleFirstCommit: false };
    const { request, begin, check } = setup;
    const epoch = generateUuid();
    let acknowledged = false;
    try {
      try {
        const prepared = await this.runMutation(
          async () => {
            check();
            const graph = await this.exportGraph();
            if (graph.group_id === undefined) delete graph.group_id;
            const candidate = prepareCompositionalHumanCaptureBeginV3(
              graph,
              request,
              {
                storeHash,
                backendNow: nowIso(),
                previousEpisodeId: this.findLatestEpisode(request.namespace)?.uuid ?? null,
              },
              begin.scope,
              this.compositionalCaptureHandlesV3,
              check,
            );
            check();
            if (
              'graph' in candidate &&
              (candidate.kind !== 'prepared_claim' || candidate.writeRequired)
            ) {
              const next =
                candidate.kind === 'prepared_claim' && candidate.writeRequired
                  ? {
                      ...candidate.graph,
                      metadata: { ...candidate.graph.metadata, extraction_epoch: epoch },
                    }
                  : candidate.graph;
              const validated = validateAutomaticCaptureCandidate(next, check);
              if (!validated)
                return {
                  kind: 'decision' as const,
                  decision: { kind: 'capacity' as const, eligibleFirstCommit: false as const },
                };
              this.replaceGraphData(validated);
            }
            return candidate;
          },
          {
            durable: true,
            captureRecords: 'lossless',
            requireExistingSnapshot: true,
            shouldWriteSnapshot: (candidate) =>
              'graph' in candidate &&
              (candidate.kind !== 'prepared_claim' || candidate.writeRequired),
          },
        );
        acknowledged = true;
        check();
        if (prepared.kind !== 'prepared_claim') return prepared.decision;
      } catch (error) {
        check();
        if (acknowledged) throw error;
        // A possibly committed write gets one bounded read, never a write retry.
      }
      const handle = await this.runMutation(
        async () => {
          check();
          const graph = await this.exportGraph();
          if (graph.group_id === undefined) delete graph.group_id;
          const operation = graph.automatic_operations_v1?.operations.find(
            (op) => op.version === 3 && op.operationId === begin.operationId,
          );
          if (!operation) return null;
          const actual = {
            storeHash,
            namespace: request.namespace,
            backendNow: nowIso(),
            graph,
            operation,
          };
          check();
          return acknowledged
            ? this.compositionalCaptureHandlesV3.issueInitialAfterAcknowledgedBegin(
                begin.scope,
                actual,
              )
            : this.compositionalCaptureHandlesV3.recoverInitialAfterUnknownAcknowledgement(
                begin.scope,
                actual,
              );
        },
        {
          captureRecords: 'lossless',
          requireExistingSnapshot: true,
          shouldWriteSnapshot: () => false,
        },
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

  async completeCompositionalHumanCaptureV3(
    handle: PrivateOneUseCompositionalCaptureLeaseHandleV3,
  ): Promise<CompositionalCaptureCompletionInternalResultV3> {
    const resultSchema = this.compositionalCaptureHandlesV3.resultSchemas().completion;
    const stopped = (kind: CompositionalCaptureNonPermitDecisionV3['kind']) =>
      resultSchema.parse({ kind, eligibleFirstCommit: false });
    const started = performance.now();
    const budget = { remaining: 512, deferred: 0 };
    const scope = getAutomaticClaimReadScope(budget);
    const completionAttemptHash = createHash('sha256')
      .update(`engram-compositional-completion-v3:${generateUuid()}`)
      .digest('hex');
    let capability;
    let invocation;
    try {
      capability = this.compositionalCaptureHandlesV3.consumeForCompletion(
        handle,
        completionAttemptHash,
      );
      invocation = this.compositionalCaptureHandlesV3.readConsumedInvocation(capability);
    } catch {
      return stopped('invalid_handle');
    }

    const storeHash = embeddedAutomaticCaptureStoreHash(this.persistPath);
    if (!this.initialized || !this.persistPath || !storeHash) return stopped('unsupported_mode');
    const deadline = Math.min(invocation.invocationDeadlineAtMonotonicMs, started + 5_000);
    let checkFailed = false;
    let checkFailure: unknown;
    const check = () => {
      if (checkFailed) throw checkFailure;
      try {
        if (performance.now() >= deadline || !canUseAutomaticClaimReadScope(scope))
          throw new ExtractionBudgetError('deadline');
        this.compositionalCaptureHandlesV3.readActiveConsumedInvocation(capability);
      } catch (error) {
        checkFailed = true;
        checkFailure = error;
        throw error;
      }
    };
    const captureRead = { scope, check };
    const audit = this.compositionalCaptureHandlesV3.readAttemptAudit(invocation.audit);
    const extractionEpoch = generateUuid();
    type PreparedResult =
      | {
          kind: 'prepared_commit';
          operation: CompositionalCaptureTerminalOperationV3;
        }
      | { kind: 'same_call_ack' }
      | { kind: 'decision'; reason: CompositionalCaptureNonPermitDecisionV3['kind'] };
    const stageDecision = compositionalCaptureCompletionDecisionKindV3;
    const terminalFailureDecision = (error: CompositionalCaptureTerminalOperationFailureV3) =>
      stageDecision(error.reason);
    const candidateGraph = (
      graph: GraphData,
      leasedOperation: Extract<CompositionalAutomaticCaptureOperationV3, { state: 'leased' }>,
      committedOperation: CompositionalCaptureTerminalOperationV3,
      entities: readonly EntityNode[] = [],
      edges: readonly EntityEdge[] = [],
    ) =>
      prepareCompositionalCompletionGraphCandidateV3(
        graph,
        leasedOperation,
        committedOperation,
        entities,
        edges,
        extractionEpoch,
        check,
      );

    let completionStaged = false;
    const transact = (acknowledgementOnly: boolean) =>
      this.runMutation(
        async (): Promise<PreparedResult | null> => {
          check();
          const graph = await this.exportGraph();
          if (graph.group_id === undefined) delete graph.group_id;
          check();
          const matching = (graph.automatic_operations_v1?.operations ?? []).filter((operation) => {
            check();
            return operation.operationId === invocation.boundFence.operationId;
          });
          if (matching.length !== 1) {
            if (acknowledgementOnly) return null;
            return { kind: 'decision', reason: matching.length === 0 ? 'not_found' : 'conflict' };
          }
          const operation = matching[0];
          if (
            operation.version !== 3 ||
            operation.identity.sourceId !== invocation.boundFence.sourceId
          ) {
            if (acknowledgementOnly) return null;
            return { kind: 'decision', reason: 'conflict' };
          }
          if (operation.state === 'committed') {
            if (operation.completionCallHash === invocation.completionCallHash)
              return { kind: 'same_call_ack' };
            if (acknowledgementOnly) return null;
            return { kind: 'decision', reason: 'conflict' };
          }
          if (acknowledgementOnly) return null;
          if (operation.state !== 'leased')
            return {
              kind: 'decision',
              reason: operation.state === 'cancelled' ? 'fenced' : 'in_progress',
            };

          const actual = {
            storeHash,
            namespace: invocation.namespace,
            backendNow: nowIso(),
            graph,
            operation,
          };
          check();
          const stage = this.compositionalCaptureHandlesV3.prepareBundleStage(
            capability,
            actual,
            budget,
          );
          check();
          if (stage.status === 'deferred') {
            if (stage.reason !== 'source_verdict_required')
              return { kind: 'decision', reason: stageDecision(stage.reason) };
            const witness = this.compositionalCaptureHandlesV3.prepareSourceVerdictWitness(
              capability,
              actual,
            );
            check();
            if (!witness) return { kind: 'decision', reason: 'invalid_plan' };
            const receiptActual = { ...actual, backendNow: nowIso() };
            check();
            const receipt = this.compositionalCaptureHandlesV3.prepareSourceVerdictReceipt(
              capability,
              witness,
              receiptActual,
            );
            check();
            if (!receipt) return { kind: 'decision', reason: 'authority_changed' };
            const committed = buildCommittedCompositionalCaptureOperationV3(
              {
                leasedOperation: operation,
                terminalReceipt: receipt,
                completionCallHash: invocation.completionCallHash,
                audit,
              },
              check,
            );
            const next = candidateGraph(graph, operation, committed);
            check();
            if (!next) return { kind: 'decision', reason: 'capacity' };
            this.replaceGraphData(next);
            completionStaged = true;
            return { kind: 'prepared_commit', operation: committed };
          }

          const applyActual = { ...actual, backendNow: nowIso() };
          check();
          const applied = this.compositionalCaptureHandlesV3.prepareBundleApply(
            capability,
            stage.stage,
            applyActual,
          );
          check();
          if (applied.status === 'deferred')
            return { kind: 'decision', reason: stageDecision(applied.reason) };
          const planned = applied.candidate;
          const committed = buildCommittedCompositionalCaptureOperationV3(
            {
              leasedOperation: operation,
              terminalReceipt: planned.receipt,
              completionCallHash: invocation.completionCallHash,
              audit,
            },
            check,
          );
          if (hashAutomaticCaptureV2(committed) !== hashAutomaticCaptureV2(planned.operation))
            return { kind: 'decision', reason: 'invalid_plan' };
          const next = candidateGraph(
            graph,
            operation,
            committed,
            planned.plan.createEntities,
            planned.plan.createEdges,
          );
          check();
          if (!next) return { kind: 'decision', reason: 'capacity' };
          this.replaceGraphData(next);
          completionStaged = true;
          return { kind: 'prepared_commit', operation: committed };
        },
        {
          operation: 'compositional_capture_completion_v3',
          durable: true,
          captureRecords: 'lossless',
          requireExistingSnapshot: true,
          captureRead,
          shouldWriteSnapshot: (candidate) => candidate?.kind === 'prepared_commit',
        },
      );

    const confirm = (acknowledgementOnly: boolean) =>
      this.runMutation(
        async () => {
          check();
          const graph = await this.exportGraph();
          if (graph.group_id === undefined) delete graph.group_id;
          check();
          const operation = graph.automatic_operations_v1?.operations.find(
            (item) => item.operationId === invocation.boundFence.operationId,
          );
          if (
            !operation ||
            operation.version !== 3 ||
            operation.identity.sourceId !== invocation.boundFence.sourceId ||
            operation.state !== 'committed' ||
            operation.completionCallHash !== invocation.completionCallHash
          )
            return null;
          const actual = {
            storeHash,
            namespace: invocation.namespace,
            backendNow: nowIso(),
            graph,
            operation,
          };
          check();
          const proof = acknowledgementOnly
            ? this.compositionalCaptureHandlesV3.recoverInitialCommitAfterUnknownAcknowledgement(
                capability,
                actual,
              )
            : this.compositionalCaptureHandlesV3.confirmInitialCommitAfterAcknowledgement(
                capability,
                actual,
              );
          check();
          if (!proof) return { reason: 'authority_changed' as const };
          const result = this.compositionalCaptureHandlesV3.createInitialFirstCommitResult(proof);
          check();
          return result;
        },
        {
          operation: 'compositional_capture_completion_v3_readback',
          captureRecords: 'lossless',
          requireExistingSnapshot: true,
          captureRead,
          shouldWriteSnapshot: () => false,
        },
      );

    let prepared: PreparedResult | null;
    try {
      prepared = await transact(false);
      check();
    } catch (error) {
      if (this.recoveryRequired) {
        this.compositionalCaptureHandlesV3.markInvocationCancelled(capability);
        return stopped('storage_error');
      }
      if (error instanceof CompositionalCaptureTerminalOperationFailureV3) {
        this.compositionalCaptureHandlesV3.markInvocationCancelled(capability);
        return stopped(terminalFailureDecision(error));
      }
      if (error instanceof ExtractionBudgetError && !completionStaged) {
        this.compositionalCaptureHandlesV3.markInvocationCancelled(capability);
        return stopped('budget_exhausted');
      }
      if (!completionStaged) {
        this.compositionalCaptureHandlesV3.markInvocationCancelled(capability);
        return stopped(
          error instanceof ExtractionBudgetError ? 'budget_exhausted' : 'storage_error',
        );
      }
      try {
        const recovered = await confirm(true);
        check();
        if (recovered && 'kind' in recovered) return recovered;
        if (recovered && 'reason' in recovered) return stopped(recovered.reason);
        return stopped('acknowledgement_unknown');
      } catch (recoveryError) {
        this.compositionalCaptureHandlesV3.markInvocationCancelled(capability);
        return stopped(
          recoveryError instanceof ExtractionBudgetError
            ? 'budget_exhausted'
            : 'acknowledgement_unknown',
        );
      }
    }

    if (!prepared) return stopped('acknowledgement_unknown');
    if (prepared.kind === 'decision') return stopped(prepared.reason);
    const acknowledgmentOnly = prepared.kind === 'same_call_ack';
    try {
      const confirmed = await confirm(acknowledgmentOnly);
      check();
      if (confirmed && 'kind' in confirmed) return confirmed;
      if (confirmed && 'reason' in confirmed) return stopped(confirmed.reason);
      return stopped('acknowledgement_unknown');
    } catch (error) {
      this.compositionalCaptureHandlesV3.markInvocationCancelled(capability);
      return stopped(
        error instanceof ExtractionBudgetError ? 'budget_exhausted' : 'acknowledgement_unknown',
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
    const storeHash = embeddedAutomaticCaptureStoreHash(this.persistPath);
    if (!this.initialized || !storeHash) return { kind: 'decision', reason: 'unsupported_mode' };
    try {
      return await this.runMutation<CompositionalClaimReviewResultV3>(
        async () => {
          const graph = await this.exportGraph();
          if (graph.group_id === undefined) delete graph.group_id;
          const prepared = prepareCompositionalClaimReviewV3(graph, request, {
            storeHash,
            backendNow: nowIso(),
          });
          if (prepared.kind === 'decision') return prepared;
          if (prepared.kind === 'prepared_review') {
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
            if (!candidate) return { kind: 'decision', reason: 'capacity' };
            this.replaceGraphData(candidate);
          }
          return {
            kind: prepared.kind === 'prepared_review' ? 'reviewed' : 'unchanged',
            edge: prepared.pair.edge,
            valueId: prepared.pair.value.uuid,
          };
        },
        {
          durable: true,
          captureRecords: 'lossless',
          requireExistingSnapshot: true,
          shouldWriteSnapshot: (result) => result.kind === 'reviewed',
        },
      );
    } catch {
      return { kind: 'acknowledgement_unknown' };
    }
  }

  async updateEdge(uuid: string, updates: Partial<EntityEdge>): Promise<EntityEdge> {
    return this.runMutation(() => {
      const existing = this.getEdgeInternal(uuid);
      if (!existing) throw new Error(`Edge not found: ${uuid}`);

      const updated: EntityEdge = {
        ...existing,
        ...updates,
        uuid: existing.uuid,
        source_node_uuid: existing.source_node_uuid,
        target_node_uuid: existing.target_node_uuid,
        created_at: existing.created_at,
        updated_at: nowIso(),
      };

      this.graph.setEdgeAttribute(uuid, 'data', updated);
      this.searchProvider.indexEdge(updated.uuid, {
        name: updated.name,
        fact: updated.fact,
      });

      return updated;
    });
  }

  async deleteEdge(uuid: string): Promise<void> {
    await this.runMutation(() => {
      if (!this.graph.hasEdge(uuid)) return;
      this.searchProvider.removeEdge(uuid);
      this.graph.dropEdge(uuid);
    });
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

    for (const input of inputs) assertAutomaticEpisodeTrustedPath(input, allowTrustedAutomatic);
    if (inputs.some((ep) => ep.attributes?.[QUEUE_ATTRIBUTE] !== undefined))
      throw new Error('Engram queue: reserved_attribute');
    const groupId = inputs[0].group_id;
    if (inputs.some((input) => input.group_id !== groupId)) {
      throw new Error('Episode append batch must contain exactly one group ID');
    }

    const prepared = inputs.map((input) => ({
      shouldAutoChain:
        autoChain && !Object.prototype.hasOwnProperty.call(input, 'previous_episode_uuid'),
      parsed: CreateEpisodicNodeSchema.parse(
        allowTrustedAutomatic ? prepareAutomaticEpisodeInput(input) : input,
      ),
    }));
    const hasAutomaticOwnership =
      allowTrustedAutomatic &&
      prepared.some(
        ({ parsed }) =>
          Object.prototype.hasOwnProperty.call(parsed.attributes, SOURCE_ENVELOPE_ATTRIBUTE) ||
          Object.prototype.hasOwnProperty.call(parsed.attributes, WRITE_OWNER_ATTRIBUTE),
      );

    return this.runMutation(
      async () => {
        if (hasAutomaticOwnership) {
          const graph = JSON.parse(JSON.stringify(await this.exportGraph())) as GraphData;
          for (const { parsed } of prepared) assertAutomaticEpisodeBinding(graph, parsed);
        }
        return prepared.map(({ parsed, shouldAutoChain }) =>
          this.appendEpisodeInternal(parsed, shouldAutoChain),
        );
      },
      {
        operation: inputs.length === 1 ? 'append_episode' : 'append_episodes',
        itemCount: inputs.length,
        shouldWriteSnapshot: (results) => results.some((result) => result.created),
      },
    );
  }

  private appendEpisodeInternal(
    parsed: ReturnType<typeof CreateEpisodicNodeSchema.parse>,
    shouldAutoChain: boolean,
  ): AppendEpisodeResult {
    if (parsed.attributes[QUEUE_ATTRIBUTE] !== undefined)
      throw new Error('Engram queue: reserved_attribute');
    const existing = this.findEpisodeByIdempotency(parsed);
    if (existing) {
      assertOwnedEpisodeReplay(existing, parsed);
      return { episode: existing, created: false };
    }

    const createdAt = nowIso();
    const previousEpisodeUuid = shouldAutoChain
      ? (this.findLatestEpisode(parsed.group_id)?.uuid ?? null)
      : parsed.previous_episode_uuid;
    const episode: EpisodicNode = {
      uuid: generateUuid(),
      ...parsed,
      previous_episode_uuid: previousEpisodeUuid,
      created_at: createdAt,
      updated_at: createdAt,
    };

    const storedEpisode = protectAutomaticEpisode(episode);
    this.graph.addNode(episode.uuid, { type: 'episode', data: storedEpisode });
    this.episodeOrder.set(episode.uuid, this.nextOrder++);

    const previous = previousEpisodeUuid
      ? this.getEpisodeOrEntity(previousEpisodeUuid, 'episode')
      : null;
    if (previous && previous.group_id === episode.group_id) {
      const chainKey = `next_${previousEpisodeUuid}_${episode.uuid}`;
      this.graph.addEdgeWithKey(chainKey, previousEpisodeUuid!, episode.uuid, {
        type: 'next_episode',
        data: null,
      });
    }

    return { episode: storedEpisode, created: true };
  }

  private findEpisodeByIdempotency(input: CreateEpisodicNode): EpisodicNode | null {
    const matches: { source?: EpisodicNode; key?: EpisodicNode } = {};

    this.graph.forEachNode((_key, attrs) => {
      if (attrs.type !== 'episode') return;
      const episode = attrs.data as EpisodicNode;
      if (episode.group_id !== input.group_id) return;

      if (
        input.source_message_id &&
        episode.source_message_id === input.source_message_id &&
        episode.episode_kind === input.episode_kind
      ) {
        matches.source = episode;
      }
      if (input.idempotency_key && episode.idempotency_key === input.idempotency_key) {
        matches.key = episode;
      }
    });

    if (matches.source && matches.key && matches.source.uuid !== matches.key.uuid) {
      throw new Error('Episode idempotency identifiers resolve to different existing episodes');
    }

    return matches.source ?? matches.key ?? null;
  }

  private findLatestEpisode(groupId: string): EpisodicNode | null {
    const episodes: EpisodicNode[] = [];
    const referencedPredecessors = new Set<string>();

    this.graph.forEachNode((_key, attrs) => {
      if (attrs.type !== 'episode') return;
      const episode = attrs.data as EpisodicNode;
      if (episode.group_id !== groupId) return;
      episodes.push(episode);
      if (episode.previous_episode_uuid) {
        referencedPredecessors.add(episode.previous_episode_uuid);
      }
    });

    const tails = episodes.filter((episode) => !referencedPredecessors.has(episode.uuid));
    const candidates = tails.length > 0 ? tails : episodes;
    candidates.sort((a, b) => {
      const timeDiff = new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      if (timeDiff !== 0) return timeDiff;
      return (this.episodeOrder.get(b.uuid) ?? 0) - (this.episodeOrder.get(a.uuid) ?? 0);
    });
    return candidates[0] ?? null;
  }

  async getEpisode(uuid: string): Promise<EpisodicNode | null> {
    this.assertRecoveryReady();
    if (!this.graph.hasNode(uuid)) return null;
    const attrs = this.graph.getNodeAttributes(uuid);
    if (attrs.type !== 'episode') return null;
    return attrs.data as EpisodicNode;
  }

  async getEpisodes(uuids: string[]): Promise<EpisodicNode[]> {
    this.assertRecoveryReady();
    const episodes: EpisodicNode[] = [];
    for (const uuid of [...new Set(uuids)]) {
      const episode = await this.getEpisode(uuid);
      if (episode) episodes.push(episode);
    }
    return episodes;
  }

  async listEpisodes(groupId: string, options: EpisodeFilterOptions = {}): Promise<EpisodicNode[]> {
    return this.collectEpisodes(groupId, options);
  }

  async updateEpisode(uuid: string, updates: UpdateEpisodeInput): Promise<EpisodicNode> {
    return this.runMutation(() => {
      const existing = this.getEpisodeOrEntity(uuid, 'episode') as EpisodicNode | null;
      if (!existing) throw new Error(`Episode not found: ${uuid}`);
      assertNoQueueMutation([existing]);
      if (updates.attributes?.[QUEUE_ATTRIBUTE] !== undefined)
        throw new Error('Engram queue: reserved_attribute');
      const safeUpdates = prepareAutomaticEpisodeUpdate(existing, updates);

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
      const protectedEpisode = protectAutomaticEpisode(updated);
      this.graph.setNodeAttribute(uuid, 'data', protectedEpisode);
      return protectedEpisode;
    });
  }

  async deleteEpisode(
    uuid: string,
    options: DeleteEpisodeOptions = {},
  ): Promise<DeleteEpisodeResult> {
    return this.runMutation(() => this.deleteEpisodeInternal(uuid, options));
  }

  async purgeEpisodes(
    groupId: string,
    filters: EpisodeFilterOptions,
    options: PurgeEpisodesOptions,
  ): Promise<PurgeEpisodesResult> {
    if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 10000) {
      throw new Error('Episode purge limit must be an integer between 1 and 10000');
    }

    const execute = (): PurgeEpisodesResult => {
      const matches = this.collectEpisodes(groupId, {
        ...filters,
        offset: 0,
        limit: options.limit + 1,
      });
      const truncated = matches.length > options.limit;
      const selected = matches.slice(0, options.limit);
      const linkedEdges = new Set<string>();
      for (const episode of selected) {
        this.graph.forEachEdge((_edgeKey, attrs) => {
          if (attrs.type === 'entity_edge' && attrs.data?.episodes.includes(episode.uuid)) {
            linkedEdges.add(attrs.data.uuid);
          }
        });
      }

      if (options.dry_run) {
        return {
          matched_count: selected.length,
          deleted_count: 0,
          truncated,
          dry_run: true,
          linked_edge_count: linkedEdges.size,
          updated_edge_count: 0,
          deleted_edge_count: 0,
          episode_uuids: selected.map((episode) => episode.uuid),
        };
      }

      const results = selected.map((episode) => this.deleteEpisodeInternal(episode.uuid, options));
      return {
        matched_count: selected.length,
        deleted_count: results.filter((result) => result.deleted).length,
        truncated,
        dry_run: false,
        linked_edge_count: linkedEdges.size,
        updated_edge_count: results.reduce((total, result) => total + result.updated_edge_count, 0),
        deleted_edge_count: results.reduce((total, result) => total + result.deleted_edge_count, 0),
        episode_uuids: selected.map((episode) => episode.uuid),
      };
    };

    return options.dry_run ? execute() : this.runMutation(execute);
  }

  async getRecentEpisodes(groupId: string, limit: number): Promise<EpisodicNode[]> {
    this.assertRecoveryReady();
    const episodes: EpisodicNode[] = [];

    this.graph.forEachNode((_key, attrs) => {
      if (attrs.type !== 'episode') return;
      const episode = attrs.data as EpisodicNode;
      if (episode.group_id !== groupId) return;
      episodes.push(episode);
    });

    episodes.sort((a, b) => {
      const timeDiff = new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      if (timeDiff !== 0) return timeDiff;
      // Tiebreak by insertion order (descending) when timestamps are equal
      return (this.episodeOrder.get(b.uuid) ?? 0) - (this.episodeOrder.get(a.uuid) ?? 0);
    });

    return episodes.slice(0, limit).reverse();
  }

  async getEpisodeCount(groupId: string, filters: EpisodeFilterOptions = {}): Promise<number> {
    const countFilters = { ...filters };
    delete countFilters.limit;
    delete countFilters.offset;
    return this.collectEpisodes(groupId, countFilters).length;
  }

  async getEpisodesByDateRange(
    groupId: string,
    from: string,
    to: string,
    limit?: number,
  ): Promise<EpisodicNode[]> {
    this.assertRecoveryReady();
    const episodes: EpisodicNode[] = [];

    this.graph.forEachNode((_key, attrs) => {
      if (attrs.type !== 'episode') return;
      const episode = attrs.data as EpisodicNode;
      if (episode.group_id !== groupId) return;
      if (!isWithinDateRange(episode.reference_time, from, to)) return;
      episodes.push(episode);
    });

    episodes.sort(
      (a, b) => new Date(a.reference_time).getTime() - new Date(b.reference_time).getTime(),
    );
    return limit ? episodes.slice(0, limit) : episodes;
  }

  private collectEpisodes(groupId: string, options: EpisodeFilterOptions): EpisodicNode[] {
    this.assertRecoveryReady();
    const episodes: EpisodicNode[] = [];
    this.graph.forEachNode((_key, attrs) => {
      if (attrs.type !== 'episode') return;
      const episode = attrs.data as EpisodicNode;
      if (episode.group_id !== groupId || !this.matchesEpisodeFilters(episode, options)) return;
      episodes.push(episode);
    });

    const sortBy = options.sort_by ?? 'created_at';
    const direction = options.sort_order === 'asc' ? 1 : -1;
    episodes.sort((a, b) => {
      const timeDiff = new Date(a[sortBy]).getTime() - new Date(b[sortBy]).getTime();
      if (timeDiff !== 0) return timeDiff * direction;
      return (
        ((this.episodeOrder.get(a.uuid) ?? 0) - (this.episodeOrder.get(b.uuid) ?? 0)) * direction
      );
    });

    const offset = Math.max(0, options.offset ?? 0);
    const limit = options.limit === undefined ? episodes.length : Math.max(0, options.limit);
    return episodes.slice(offset, offset + limit);
  }

  private matchesEpisodeFilters(episode: EpisodicNode, options: EpisodeFilterOptions): boolean {
    if (options.role && episode.role !== options.role) return false;
    if (options.source_type && episode.source_type !== options.source_type) return false;
    if (options.episode_kind && episode.episode_kind !== options.episode_kind) return false;
    if (options.trust_level && episode.trust_level !== options.trust_level) return false;
    if (options.review_status && episode.review_status !== options.review_status) return false;
    if (options.sender_id && episode.sender_id !== options.sender_id) return false;
    if (
      options.sender_name &&
      episode.sender_name?.toLocaleLowerCase() !== options.sender_name.toLocaleLowerCase()
    )
      return false;
    if (options.conversation_id && episode.conversation_id !== options.conversation_id)
      return false;
    if (options.source_message_id && episode.source_message_id !== options.source_message_id)
      return false;
    if (options.source_workflow_id && episode.source_workflow_id !== options.source_workflow_id)
      return false;
    if (options.source_execution_id && episode.source_execution_id !== options.source_execution_id)
      return false;
    if (
      (options.reference_after || options.reference_before) &&
      !isWithinDateRange(episode.reference_time, options.reference_after, options.reference_before)
    )
      return false;
    if (
      (options.created_after || options.created_before) &&
      !isWithinDateRange(episode.created_at, options.created_after, options.created_before)
    )
      return false;
    if (!matchesEpisodeHygieneFilters(episode, options)) return false;
    return true;
  }

  private deleteEpisodeInternal(uuid: string, options: DeleteEpisodeOptions): DeleteEpisodeResult {
    const episode = this.getEpisodeOrEntity(uuid, 'episode') as EpisodicNode | null;
    if (!episode) {
      return {
        episode_uuid: uuid,
        deleted: false,
        repaired_successor_count: 0,
        linked_edge_count: 0,
        updated_edge_count: 0,
        deleted_edge_count: 0,
      };
    }

    assertNoQueueMutation([episode]);
    const repairChain = options.repair_chain ?? true;
    const cleanup = options.fact_cleanup ?? 'unlink';
    const successors: EpisodicNode[] = [];
    this.graph.forEachNode((_key, attrs) => {
      if (attrs.type !== 'episode') return;
      const candidate = attrs.data as EpisodicNode;
      if (candidate.group_id === episode.group_id && candidate.previous_episode_uuid === uuid) {
        successors.push(candidate);
      }
    });
    assertNoAutomaticOperationChainImpact(
      this.automaticOperations,
      this.collectEpisodes(episode.group_id, {}),
      [uuid],
      episode.group_id,
    );

    const linkedEdgeKeys: string[] = [];
    this.graph.forEachEdge((edgeKey, attrs) => {
      if (attrs.type === 'entity_edge' && attrs.data?.episodes.includes(uuid)) {
        linkedEdgeKeys.push(edgeKey);
      }
    });

    let updatedEdgeCount = 0;
    let deletedEdgeCount = 0;
    if (cleanup !== 'preserve') {
      for (const edgeKey of linkedEdgeKeys) {
        const edge = this.getEdgeInternal(edgeKey);
        if (!edge) continue;
        const remainingEpisodes = edge.episodes.filter((episodeUuid) => episodeUuid !== uuid);
        if (cleanup === 'delete_orphaned' && remainingEpisodes.length === 0) {
          this.searchProvider.removeEdge(edgeKey);
          this.graph.dropEdge(edgeKey);
          deletedEdgeCount++;
          continue;
        }
        const updatedEdge = {
          ...edge,
          episodes: remainingEpisodes,
          updated_at: nowIso(),
        };
        this.graph.setEdgeAttribute(edgeKey, 'data', updatedEdge);
        updatedEdgeCount++;
      }
    }

    if (repairChain) {
      for (const successor of successors) {
        this.graph.setNodeAttribute(successor.uuid, 'data', {
          ...successor,
          previous_episode_uuid: episode.previous_episode_uuid,
          updated_at: nowIso(),
        });
      }
    }

    this.graph.dropNode(uuid);
    this.episodeOrder.delete(uuid);

    if (repairChain && episode.previous_episode_uuid) {
      const previous = this.getEpisodeOrEntity(episode.previous_episode_uuid, 'episode');
      if (previous?.group_id === episode.group_id) {
        for (const successor of successors) {
          const chainKey = `next_${episode.previous_episode_uuid}_${successor.uuid}`;
          if (!this.graph.hasEdge(chainKey)) {
            this.graph.addEdgeWithKey(chainKey, episode.previous_episode_uuid, successor.uuid, {
              type: 'next_episode',
              data: null,
            });
          }
        }
      }
    }

    return {
      episode_uuid: uuid,
      deleted: true,
      repaired_successor_count: repairChain ? successors.length : 0,
      linked_edge_count: linkedEdgeKeys.length,
      updated_edge_count: updatedEdgeCount,
      deleted_edge_count: deletedEdgeCount,
    };
  }

  // ===== Changelog =====

  async getEdgeChangelog(
    groupId: string,
    since: string,
    options?: { limit?: number },
  ): Promise<ChangelogEntry[]> {
    this.assertRecoveryReady();
    const entries: ChangelogEntry[] = [];
    const sinceTs = new Date(since).getTime();

    this.graph.forEachEdge((_edgeKey, attrs) => {
      if (attrs.type !== 'entity_edge' || !attrs.data) return;
      const edge = attrs.data as EntityEdge;
      if (edge.group_id !== groupId) return;

      const createdTs = new Date(edge.created_at).getTime();
      const expiredTs = edge.expired_at ? new Date(edge.expired_at).getTime() : null;
      const invalidTs = edge.invalid_at ? new Date(edge.invalid_at).getTime() : null;

      const sourceNode = this.graph.hasNode(edge.source_node_uuid)
        ? this.graph.getNodeAttributes(edge.source_node_uuid)
        : null;
      const targetNode = this.graph.hasNode(edge.target_node_uuid)
        ? this.graph.getNodeAttributes(edge.target_node_uuid)
        : null;
      if (!sourceNode || !targetNode) return;
      if (sourceNode.type !== 'entity' || targetNode.type !== 'entity') return;

      const sourceEntity = sourceNode.data as EntityNode;
      const targetEntity = targetNode.data as EntityNode;

      if (createdTs >= sinceTs) {
        entries.push({
          edge,
          sourceEntity,
          targetEntity,
          change_type: 'created',
          changed_at: edge.created_at,
        });
      }

      if (expiredTs && expiredTs >= sinceTs) {
        entries.push({
          edge,
          sourceEntity,
          targetEntity,
          change_type: 'expired',
          changed_at: edge.expired_at!,
        });
      } else if (invalidTs && invalidTs >= sinceTs && !expiredTs) {
        entries.push({
          edge,
          sourceEntity,
          targetEntity,
          change_type: 'invalidated',
          changed_at: edge.invalid_at!,
        });
      }
    });

    entries.sort((a, b) => new Date(b.changed_at).getTime() - new Date(a.changed_at).getTime());
    const limit = options?.limit ?? entries.length;
    return entries.slice(0, limit);
  }

  // ===== Search =====

  async searchEntities(
    query: string,
    groupId: string,
    options?: EntitySearchOptions,
  ): Promise<EntitySearchResult[]> {
    this.assertRecoveryReady();
    const limit = options?.limit ?? 10;
    const minScore = options?.min_score ?? 0;

    const textResults = this.searchProvider.searchEntities(query, limit * 3);

    const results: EntitySearchResult[] = [];
    for (const tr of textResults) {
      if (tr.score < minScore) continue;

      const entity = await this.getEntity(tr.id);
      if (!entity || entity.group_id !== groupId) continue;
      if (options?.entity_type && entity.entity_type !== options.entity_type) continue;
      if (
        (options?.created_after || options?.created_before) &&
        !isWithinDateRange(entity.created_at, options?.created_after, options?.created_before)
      )
        continue;

      results.push({ entity, score: tr.score });
    }

    return results.slice(0, limit);
  }

  async searchEdges(
    query: string,
    groupId: string,
    options?: EdgeSearchOptions,
  ): Promise<EdgeSearchResult[]> {
    this.assertRecoveryReady();
    const limit = options?.limit ?? 10;
    const minScore = options?.min_score ?? 0;
    const includeExpired = options?.include_expired ?? false;

    const textResults = this.searchProvider.searchEdges(query, limit * 3);

    const results: EdgeSearchResult[] = [];
    for (const tr of textResults) {
      if (tr.score < minScore) continue;

      const edge = await this.getEdge(tr.id);
      if (!edge || edge.group_id !== groupId) continue;
      if (!includeExpired && edge.expired_at !== null) continue;
      if (
        (options?.valid_after || options?.valid_before) &&
        !isWithinDateRange(edge.valid_at, options?.valid_after, options?.valid_before)
      )
        continue;
      if (
        (options?.created_after || options?.created_before) &&
        !isWithinDateRange(edge.created_at, options?.created_after, options?.created_before)
      )
        continue;

      const sourceEntity = await this.getEntity(edge.source_node_uuid);
      const targetEntity = await this.getEntity(edge.target_node_uuid);
      if (!sourceEntity || !targetEntity) continue;

      results.push({ edge, sourceEntity, targetEntity, score: tr.score });
    }

    return results.slice(0, limit);
  }

  // ===== Vector Search =====

  async searchEntitiesByVector(
    vector: number[],
    groupId: string,
    options?: VectorSearchOptions,
  ): Promise<EntitySearchResult[]> {
    this.assertRecoveryReady();
    const limit = options?.limit ?? 10;
    const minScore = options?.min_score ?? 0;
    const results: EntitySearchResult[] = [];

    this.graph.forEachNode((_key, attrs) => {
      if (attrs.type !== 'entity') return;
      const entity = attrs.data as EntityNode;
      if (entity.group_id !== groupId) return;
      if (!entity.name_embedding || entity.name_embedding.length !== vector.length) return;

      try {
        const score = cosineSimilarity(vector, entity.name_embedding);
        if (score >= minScore) {
          results.push({ entity, score });
        }
      } catch {
        // Skip entities with incompatible embedding dimensions
      }
    });

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  async searchEdgesByVector(
    vector: number[],
    groupId: string,
    options?: VectorSearchOptions,
  ): Promise<EdgeSearchResult[]> {
    this.assertRecoveryReady();
    const limit = options?.limit ?? 10;
    const minScore = options?.min_score ?? 0;
    const results: EdgeSearchResult[] = [];

    this.graph.forEachEdge((_edgeKey, attrs) => {
      if (attrs.type !== 'entity_edge' || !attrs.data) return;
      const edge = attrs.data as EntityEdge;
      if (edge.group_id !== groupId) return;
      if (!edge.fact_embedding || edge.fact_embedding.length !== vector.length) return;

      try {
        const score = cosineSimilarity(vector, edge.fact_embedding);
        if (score < minScore) return;

        // Need source and target entities
        const sourceNode = this.graph.hasNode(edge.source_node_uuid)
          ? this.graph.getNodeAttributes(edge.source_node_uuid)
          : null;
        const targetNode = this.graph.hasNode(edge.target_node_uuid)
          ? this.graph.getNodeAttributes(edge.target_node_uuid)
          : null;

        if (!sourceNode || !targetNode) return;
        if (sourceNode.type !== 'entity' || targetNode.type !== 'entity') return;

        results.push({
          edge,
          sourceEntity: sourceNode.data as EntityNode,
          targetEntity: targetNode.data as EntityNode,
          score,
        });
      } catch {
        // Skip edges with incompatible embedding dimensions
      }
    });

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  // ===== Graph Management =====

  async previewQueueClear(groupId?: string): Promise<QueueClearImpact> {
    return this.runMutation(
      async () => queueClearImpact((await this.exportGraph(groupId)).episodes),
      { operation: 'queue_clear_preview', shouldWriteSnapshot: () => false },
    );
  }
  async clearGroup(groupId: string, options: QueueClearOptions = {}): Promise<void> {
    const reviewed = QueueClearOptionsSchema.parse(options).allowQueued;
    await this.runMutation(() => {
      const episodes = this.collectEpisodes(groupId, {});
      assertQueueClear(episodes, reviewed);
      const nodesToRemove: string[] = [];
      const episodesToRemove: string[] = [];

      this.graph.forEachNode((key, attrs) => {
        const data = attrs.data;
        if ('group_id' in data && data.group_id === groupId) {
          nodesToRemove.push(key);
          if (attrs.type === 'episode') episodesToRemove.push(key);
        }
      });
      this.assertNoAutomaticOperationSourceDeletion(episodesToRemove);
      this.extractionEpoch = generateUuid();

      // Also find edges belonging to this group
      const edgesToRemove: string[] = [];
      this.graph.forEachEdge((edgeKey, attrs) => {
        if (attrs.type === 'entity_edge' && attrs.data) {
          const edge = attrs.data as EntityEdge;
          if (edge.group_id === groupId) {
            edgesToRemove.push(edgeKey);
          }
        }
      });

      for (const edgeKey of edgesToRemove) {
        this.searchProvider.removeEdge(edgeKey);
        if (this.graph.hasEdge(edgeKey)) {
          this.graph.dropEdge(edgeKey);
        }
      }

      for (const key of nodesToRemove) {
        this.searchProvider.removeEntity(key);
        if (this.graph.hasNode(key)) {
          this.graph.dropNode(key);
        }
      }
    });
  }

  async clearAll(options: QueueClearOptions = {}): Promise<void> {
    const reviewed = QueueClearOptionsSchema.parse(options).allowQueued;
    await this.runMutation(async () => {
      const graph = await this.exportGraph();
      assertQueueClear(graph.episodes, reviewed);
      this.assertNoAutomaticOperationSourceDeletion(graph.episodes.map((episode) => episode.uuid));
      this.extractionEpoch = generateUuid();
      this.resetGraph();
    });
  }

  async exportGraph(groupId?: string): Promise<GraphData> {
    this.assertRecoveryReady();
    const entities: EntityNode[] = [];
    const edges: EntityEdge[] = [];
    const episodes: EpisodicNode[] = [];
    const namespaceOperations = this.automaticOperations?.operations.filter(
      (operation) => groupId === undefined || operation.identity.namespace === groupId,
    );

    this.graph.forEachNode((_key, attrs) => {
      if (attrs.type === 'entity') {
        const entity = attrs.data as EntityNode;
        if (!groupId || entity.group_id === groupId) entities.push(entity);
      } else if (attrs.type === 'episode') {
        const episode = attrs.data as EpisodicNode;
        if (!groupId || episode.group_id === groupId) episodes.push(episode);
      }
    });

    this.graph.forEachEdge((_edgeKey, attrs) => {
      if (attrs.type === 'entity_edge' && attrs.data) {
        const edge = attrs.data as EntityEdge;
        if (!groupId || edge.group_id === groupId) edges.push(edge);
      }
    });

    return {
      version: CURRENT_GRAPH_DATA_VERSION,
      ...(this.extractionEpoch ? { metadata: { extraction_epoch: this.extractionEpoch } } : {}),
      ...(this.automaticOperations && (groupId === undefined || namespaceOperations!.length > 0)
        ? {
            automatic_operations_v1: immutableAutomaticLedgerSnapshot({
              version: 1,
              operations: namespaceOperations!,
            }),
          }
        : {}),
      exported_at: nowIso(),
      group_id: groupId,
      entities,
      edges,
      episodes,
    };
  }

  async importGraph(data: ImportGraphData): Promise<void> {
    assertNoRawAutonomousPersonalFamilyFourImport(data);
    assertNoImportedAutomaticOperations(data);
    const migrated = migrateGraphData(data).data;
    assertNoQueueMutation(migrated.episodes);
    await this.runMutation(async () => {
      const existing = await this.exportGraph();
      const safeImport = prepareAutomaticImport(migrated, existing);
      this.extractionEpoch = generateUuid();
      this.mergeGraphData(safeImport);
    });
  }

  async getMigrationStatus(): Promise<StorageMigrationStatus> {
    return {
      ...this.migrationStatus,
      backup: { ...this.migrationStatus.backup },
    };
  }

  async migrateStorageSchema(
    options: StorageSchemaMigrationOptions,
  ): Promise<StorageSchemaMigrationResult> {
    return {
      backend: 'embedded',
      dry_run: options.dry_run,
      matched_count: 0,
      migrated_count: 0,
      remaining_count: 0,
      backup_required: false,
      additive_only: false,
    };
  }

  async getStats(groupId?: string): Promise<GraphStats> {
    this.assertRecoveryReady();
    let entityCount = 0;
    let edgeCount = 0;
    let episodeCount = 0;
    const groupIds = new Set<string>();
    const entityTypes: Record<string, number> = {};
    let oldestEpisode: string | null = null;
    let newestEpisode: string | null = null;

    this.graph.forEachNode((_key, attrs) => {
      if (attrs.type === 'entity') {
        const entity = attrs.data as EntityNode;
        if (groupId && entity.group_id !== groupId) return;

        entityCount++;
        groupIds.add(entity.group_id);
        entityTypes[entity.entity_type] = (entityTypes[entity.entity_type] ?? 0) + 1;
      } else if (attrs.type === 'episode') {
        const episode = attrs.data as EpisodicNode;
        if (groupId && episode.group_id !== groupId) return;

        episodeCount++;
        groupIds.add(episode.group_id);

        if (!oldestEpisode || episode.created_at < oldestEpisode) {
          oldestEpisode = episode.created_at;
        }
        if (!newestEpisode || episode.created_at > newestEpisode) {
          newestEpisode = episode.created_at;
        }
      }
    });

    this.graph.forEachEdge((_edgeKey, attrs) => {
      if (attrs.type === 'entity_edge' && attrs.data) {
        const edge = attrs.data as EntityEdge;
        if (groupId && edge.group_id !== groupId) return;
        edgeCount++;
      }
    });

    return {
      entity_count: entityCount,
      edge_count: edgeCount,
      episode_count: episodeCount,
      group_ids: [...groupIds],
      entity_types: entityTypes,
      oldest_episode: oldestEpisode,
      newest_episode: newestEpisode,
    };
  }

  async rebuildSearchIndex(): Promise<{ indexed_entities: number; indexed_edges: number }> {
    this.assertRecoveryReady();
    let indexedEntities = 0;
    let indexedEdges = 0;

    this.searchProvider.clear();

    this.graph.forEachNode((_key, attrs) => {
      if (attrs.type !== 'entity') return;
      const entity = attrs.data as EntityNode;
      this.searchProvider.indexEntity(entity.uuid, {
        name: entity.name,
        summary: entity.summary,
        entity_type: entity.entity_type,
      });
      indexedEntities++;
    });

    this.graph.forEachEdge((_edgeKey, attrs) => {
      if (attrs.type !== 'entity_edge' || !attrs.data) return;
      const edge = attrs.data as EntityEdge;
      this.searchProvider.indexEdge(edge.uuid, {
        name: edge.name,
        fact: edge.fact,
      });
      indexedEdges++;
    });

    return {
      indexed_entities: indexedEntities,
      indexed_edges: indexedEdges,
    };
  }

  // ===== Retention =====

  async applyRetention(groupId: string, policy: RetentionPolicy): Promise<number> {
    if (policy.type === 'forever') return 0;

    return this.runMutation(() => {
      assertNoQueueMutation(this.collectEpisodes(groupId, {}));
      let removed = 0;

      if (policy.type === 'days' && policy.value) {
        const days = policy.value;
        const episodesToRemove: string[] = [];

        this.graph.forEachNode((key, attrs) => {
          if (attrs.type !== 'episode') return;
          const episode = attrs.data as EpisodicNode;
          if (episode.group_id !== groupId) return;
          if (isOlderThanDays(episode.created_at, days)) {
            episodesToRemove.push(key);
          }
        });

        assertNoAutomaticOperationChainImpact(
          this.automaticOperations,
          this.collectEpisodes(groupId, {}),
          episodesToRemove,
          groupId,
        );

        for (const key of episodesToRemove) {
          if (this.graph.hasNode(key)) {
            this.graph.dropNode(key);
            removed++;
          }
        }
      }

      if (policy.type === 'max_episodes' && policy.value) {
        const maxEpisodes = policy.value;
        const episodes: { uuid: string; created_at: string }[] = [];

        this.graph.forEachNode((_key, attrs) => {
          if (attrs.type !== 'episode') return;
          const episode = attrs.data as EpisodicNode;
          if (episode.group_id !== groupId) return;
          episodes.push({ uuid: episode.uuid, created_at: episode.created_at });
        });

        episodes.sort(
          (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
        );

        const toRemove = episodes.slice(maxEpisodes);
        assertNoAutomaticOperationChainImpact(
          this.automaticOperations,
          this.collectEpisodes(groupId, {}),
          toRemove.map((episode) => episode.uuid),
          groupId,
        );
        for (const ep of toRemove) {
          if (this.graph.hasNode(ep.uuid)) {
            this.graph.dropNode(ep.uuid);
            removed++;
          }
        }
      }

      return removed;
    });
  }

  // ===== Persistence =====

  private async runMutation<T>(
    mutation: () => T | Promise<T>,
    options: MutationOptions<T> = {},
  ): Promise<T> {
    this.assertRecoveryReady();
    const structuralGuardContext = options.autonomousPersonalCompletionV4
      ? {
          typedSyntaxWork: options.autonomousPersonalCompletionV4.typedSyntaxWork,
          check: options.autonomousPersonalCompletionV4.check,
        }
      : ordinaryAutonomousPersonalStructuralGuardContextV4();
    // Check before publishing a new queue tail. A rejected entry must not release
    // a queue slot that a later mutation could use while the prior one is active.
    options.captureRead?.check();
    options.autonomousPersonalCompletionV4?.check();
    const startedAt = nowIso();
    const totalStarted = performance.now();
    const queueStarted = performance.now();
    const previousMutation = this.mutationTail;
    let releaseQueue!: () => void;
    this.mutationTail = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });

    await previousMutation;
    const queueWaitMs = performance.now() - queueStarted;

    let releaseFileLock: () => Promise<void> = async () => {};
    let rollbackData: GraphData | null = null;
    let lockWaitMs = 0;
    let diskRefreshMs = 0;
    let rollbackExportMs = 0;
    let mutationMs = 0;
    let snapshotWriteMs = 0;
    let rollbackRestoreMs = 0;
    let snapshotBytes: number | null = null;
    let snapshotWritten = false;
    let snapshotAttempted = false;
    let snapshotReplacementAttempted = false;
    let snapshotReplaced = false;
    let snapshotDurable = false;
    let snapshotCompact = false;
    let rollbackPersistenceFailed = false;
    let refreshAttempted = false;
    let serializationMs: number | null = null;
    let success = false;
    try {
      options.captureRead?.check();
      options.autonomousPersonalCompletionV4?.check();
      if (this.persistPath) {
        const lockStarted = performance.now();
        try {
          releaseFileLock = await this.acquirePersistLock(options.captureRead?.check);
        } finally {
          lockWaitMs = performance.now() - lockStarted;
        }
        options.captureRead?.check();
        const refreshStarted = performance.now();
        refreshAttempted = true;
        try {
          await this.refreshFromDiskUnderLock(
            options.captureRecords,
            options.requireExistingSnapshot,
            options.captureRead,
            structuralGuardContext,
          );
        } finally {
          diskRefreshMs = performance.now() - refreshStarted;
        }
      }

      const rollbackExportStarted = performance.now();
      try {
        rollbackData = await this.exportGraph();
        if (rollbackData.group_id === undefined) delete rollbackData.group_id;
      } finally {
        rollbackExportMs = performance.now() - rollbackExportStarted;
      }

      const protectsAutonomousSources =
        rollbackData.episodes.some(hasAutonomousSourceOwnership) ||
        (rollbackData.automatic_operations_v1?.operations.some(
          (operation) => operation.version === 4,
        ) ??
          false);
      if (protectsAutonomousSources) assertAutomaticLedgerSourceIntegrity(rollbackData);
      if (hasAutonomousPersonalV4Enrollment(rollbackData)) {
        assertAutonomousPersonalRecordIntegrityV4(
          rollbackData,
          structuralGuardContext.typedSyntaxWork,
          structuralGuardContext.check,
        );
      }
      options.autonomousPersonalCompletionV4?.check();

      const mutationStarted = performance.now();
      const result = await (async () => {
        try {
          return await mutation();
        } finally {
          mutationMs = performance.now() - mutationStarted;
        }
      })();

      // Orphan sources need the same integrity protection without a ledger or
      // a persistent file. Validate before acknowledging an in-memory mutation.
      const postMutationGraph = await this.exportGraph();
      if (postMutationGraph.group_id === undefined) delete postMutationGraph.group_id;
      if (
        !options.autonomousPersonalCompletionV4 &&
        hasNewAutonomousPersonalFamilyFourFootprint(rollbackData, postMutationGraph)
      ) {
        throw new Error('Engram autonomous personal capture: native_write_required');
      }
      if (hasAutonomousPersonalV4Enrollment(postMutationGraph)) {
        assertAutonomousPersonalGraphIntegrityV4(postMutationGraph, structuralGuardContext);
      } else if (
        protectsAutonomousSources ||
        this.hasAutonomousSourceInMemory() ||
        this.automaticOperations?.operations.some((operation) => operation.version === 4)
      ) {
        assertAutomaticLedgerSourceIntegrity(postMutationGraph);
      }

      const shouldWriteSnapshot = options.shouldWriteSnapshot?.(result) ?? true;
      if (this.persistPath && shouldWriteSnapshot) {
        options.autonomousPersonalCompletionV4?.check();
        const snapshotWriteStarted = performance.now();
        snapshotAttempted = true;
        try {
          const preservesQueue = rollbackData.episodes.some(
            (episode) => episode.attributes[QUEUE_ATTRIBUTE] !== undefined,
          );
          snapshotDurable = Boolean(
            options.durable ||
            preservesQueue ||
            rollbackData.automatic_operations_v1 !== undefined ||
            this.automaticOperations !== undefined ||
            hasReplaySafeCaptureSource(rollbackData.episodes) ||
            this.hasReplaySafeCaptureSourceInMemory(),
          );
          snapshotCompact =
            options.captureRecords === 'lossless' ||
            hasRawReplaySafeCaptureState(rollbackData) ||
            this.hasReplaySafeCaptureSourceInMemory() ||
            Boolean(
              this.automaticOperations?.operations.some(
                (operation) =>
                  operation.version === 2 || operation.version === 3 || operation.version === 4,
              ),
            );
          snapshotBytes = await this.writeSnapshotUnderLock(
            snapshotDurable,
            (value) => {
              serializationMs = value;
            },
            () => {
              snapshotReplaced = true;
              options.autonomousPersonalCompletionV4?.onSnapshotReplaced();
            },
            snapshotCompact,
            () => {
              options.autonomousPersonalCompletionV4?.check();
              snapshotReplacementAttempted = true;
              options.autonomousPersonalCompletionV4?.onSnapshotReplacementAttempted();
            },
          );
        } finally {
          snapshotWriteMs = performance.now() - snapshotWriteStarted;
        }
        snapshotWritten = true;
        options.autonomousPersonalCompletionV4?.onSnapshotDurableAcknowledged?.();
      }

      options.autonomousPersonalCompletionV4?.check();
      success = true;
      return result;
    } catch (error) {
      const unknownV4Replacement =
        options.autonomousPersonalCompletionV4 !== undefined && snapshotReplacementAttempted;
      if (rollbackData && !unknownV4Replacement) {
        const rollbackRestoreStarted = performance.now();
        this.replaceGraphData(rollbackData, { trustedRollback: true });
        rollbackRestoreMs = performance.now() - rollbackRestoreStarted;
        if (this.persistPath && snapshotAttempted && snapshotReplaced) {
          // A directory fsync can fail after rename made the new snapshot visible.
          // Restore the exact pre-mutation graph while still holding the file lock.
          // Preserve the original write error if the recovery write also fails.
          try {
            const rollbackDurable =
              snapshotDurable ||
              rollbackData.automatic_operations_v1 !== undefined ||
              hasReplaySafeCaptureSource(rollbackData.episodes) ||
              rollbackData.episodes.some(
                (episode) => episode.attributes[QUEUE_ATTRIBUTE] !== undefined,
              );
            await this.writeTextAtomic(
              snapshotCompact || hasRawReplaySafeCaptureState(rollbackData)
                ? JSON.stringify(compactCaptureSnapshotData(rollbackData))
                : JSON.stringify(rollbackData, null, 2),
              this.persistPath,
              rollbackDurable,
            );
          } catch {
            // The original persistence error remains authoritative.
            rollbackPersistenceFailed = true;
            this.recoveryRequired = true;
          }
        }
      }
      throw error;
    } finally {
      try {
        await releaseFileLock();
      } finally {
        const round = (value: number): number => Math.round(value * 1000) / 1000;
        this.lastMutationDiagnostics = {
          operation: options.operation ?? 'mutation',
          started_at: startedAt,
          success,
          persistence_enabled: Boolean(this.persistPath),
          snapshot_written: snapshotWritten,
          item_count: options.itemCount ?? 1,
          queue_wait_ms: round(queueWaitMs),
          lock_wait_ms: round(lockWaitMs),
          disk_refresh_ms: round(diskRefreshMs),
          rollback_export_ms: round(rollbackExportMs),
          mutation_ms: round(mutationMs),
          snapshot_write_ms: round(snapshotWriteMs),
          rollback_restore_ms: round(rollbackRestoreMs),
          total_ms: round(performance.now() - totalStarted),
          snapshot_bytes: snapshotBytes,
          ...(rollbackPersistenceFailed
            ? { rollback_diagnostic: 'rollback_persistence_failed' as const }
            : {}),
        };
        try {
          this.extractionObservers.getStore()?.({
            backend: 'embedded',
            acknowledged: success,
            total_ms: this.lastMutationDiagnostics.total_ms,
            queue_wait_ms: this.lastMutationDiagnostics.queue_wait_ms,
            lock_wait_ms: this.persistPath ? this.lastMutationDiagnostics.lock_wait_ms : null,
            disk_refresh_ms: refreshAttempted ? this.lastMutationDiagnostics.disk_refresh_ms : null,
            snapshot_write_ms: snapshotAttempted
              ? this.lastMutationDiagnostics.snapshot_write_ms
              : null,
            snapshot_bytes: snapshotBytes,
            transaction_ms: null,
            serialization_ms: serializationMs,
          });
        } catch {
          /* Diagnostic delivery cannot change a committed operation. */
        }
        releaseQueue();
      }
    }
  }

  private async loadFromDisk(): Promise<void> {
    if (!this.persistPath || !fs.existsSync(this.persistPath)) return;

    const structuralGuardContext = ordinaryAutonomousPersonalStructuralGuardContextV4();
    const releaseFileLock = await this.acquirePersistLock();
    try {
      const data = await this.readAndMigratePersistedDataUnderLock(
        undefined,
        undefined,
        structuralGuardContext,
      );
      if (hasAutonomousPersonalV4Enrollment(data)) {
        assertAutonomousPersonalGraphIntegrityV4(data, structuralGuardContext);
      }
      this.replaceGraphData(data);
    } catch (error) {
      throw new Error(
        `Engram: Failed to load or migrate embedded storage at ${this.persistPath}: ${(error as Error).message}`,
      );
    } finally {
      await releaseFileLock();
    }
  }

  private async refreshFromDiskUnderLock(
    captureRecords?: 'lossless',
    requireExisting = false,
    captureRead?: {
      scope: AutomaticClaimReadScope;
      check: () => void;
      attemptReserved?: boolean;
      verifyStableSnapshot?: boolean;
    },
    structuralGuardContext: AutonomousPersonalStructuralGuardContextV4 = ordinaryAutonomousPersonalStructuralGuardContextV4(),
  ): Promise<void> {
    this.assertQueueFilePresent();
    if (!this.persistPath || (!requireExisting && !fs.existsSync(this.persistPath))) return;

    const data = await this.readAndMigratePersistedDataUnderLock(
      captureRecords,
      captureRead,
      structuralGuardContext,
    );
    captureRead?.check();
    this.replaceGraphData(data);
    captureRead?.check();
  }

  private assertQueueFilePresent(): void {
    if (!this.persistPath || fs.existsSync(this.persistPath)) return;
    if (this.automaticOperations !== undefined) {
      throw new Error('Engram automatic ledger: store_missing');
    }
    if (this.hasReplaySafeCaptureSourceInMemory()) {
      throw new Error('Engram automatic ledger: store_missing');
    }
    let queued = false;
    this.graph.forEachNode((_key, attrs) => {
      if (attrs.type === 'episode' && attrs.data.attributes[QUEUE_ATTRIBUTE] !== undefined)
        queued = true;
    });
    if (queued) throw new Error('Engram queue: store_missing');
  }

  private hasReplaySafeCaptureSourceInMemory(): boolean {
    let found = false;
    this.graph.forEachNode((_key, attrs) => {
      if (attrs.type === 'episode' && hasCaptureSourceAttributes(attrs.data.attributes)) {
        found = true;
      }
    });
    return found;
  }

  private assertRecoveryReady(): void {
    if (this.recoveryRequired) {
      throw new Error('Engram automatic ledger: recovery_required');
    }
  }

  private async writeSnapshotUnderLock(
    durable = false,
    onSerialized?: (value: number) => void,
    onReplaced?: () => void,
    compactCapture = false,
    onReplacementAttempted?: () => void,
  ): Promise<number> {
    if (!this.persistPath) return 0;

    const exported = await this.exportGraph();
    compactCapture ||= hasRawReplaySafeCaptureState(exported);
    const data = compactCapture
      ? compactCaptureSnapshotData(exported)
      : exported.automatic_operations_v1
        ? GraphDataSchema.parse(exported)
        : exported;
    if (this.automaticOperations && !data.automatic_operations_v1) {
      throw new Error('Engram automatic ledger: native_root_missing');
    }
    if (data.automatic_operations_v1) assertAutomaticLedgerSourceIntegrity(data);
    // Every replacement containing acknowledged queue or automatic-ledger state
    // must retain file and directory durability, including ordinary graph writes.
    durable ||= data.episodes.some((episode) => episode.attributes[QUEUE_ATTRIBUTE] !== undefined);
    durable ||=
      this.automaticOperations !== undefined || data.automatic_operations_v1 !== undefined;
    durable ||= hasReplaySafeCaptureSource(data.episodes);
    const serializeStarted = performance.now();
    const payload = compactCapture ? JSON.stringify(data) : JSON.stringify(data, null, 2);
    onSerialized?.(performance.now() - serializeStarted);
    await this.writeTextAtomic(
      payload,
      this.persistPath,
      durable,
      onReplaced,
      onReplacementAttempted,
    );
    return Buffer.byteLength(payload, 'utf-8');
  }

  private async readAndMigratePersistedDataUnderLock(
    captureRecords?: 'lossless',
    captureRead?: {
      scope: AutomaticClaimReadScope;
      check: () => void;
      attemptReserved?: boolean;
      verifyStableSnapshot?: boolean;
    },
    structuralGuardContext: AutonomousPersonalStructuralGuardContextV4 = ordinaryAutonomousPersonalStructuralGuardContextV4(),
  ): Promise<GraphData> {
    if (!this.persistPath) throw new Error('Embedded persistence path is not configured');
    const boundedRead =
      captureRead !== undefined ||
      captureRecords === 'lossless' ||
      this.hasReplaySafeCaptureSourceInMemory() ||
      Boolean(
        this.automaticOperations?.operations.some(
          (operation) =>
            operation.version === 2 || operation.version === 3 || operation.version === 4,
        ),
      );
    let raw: string;
    let opened: fs.BigIntStats | undefined;
    if (boundedRead) {
      if (
        captureRead &&
        !captureRead.attemptReserved &&
        !beginAutomaticClaimReadAttempt(captureRead.scope)
      ) {
        captureRead.check();
        throw new ExtractionBudgetError('snapshot_limit');
      }
      captureRead?.check();
      const file = await fs.promises.open(this.persistPath, 'r');
      try {
        const stat = captureRead?.verifyStableSnapshot
          ? await file.stat({ bigint: true })
          : await file.stat();
        if (captureRead?.verifyStableSnapshot) opened = stat as fs.BigIntStats;
        const bytes = Number(stat.size);
        if (!stat.isFile() || !Number.isSafeInteger(bytes) || bytes > 100 * 1024 * 1024)
          throw new Error('Engram automatic capture: snapshot_limit');
        captureRead?.check();
        if (captureRead && !reserveAutomaticClaimSnapshotBytes(captureRead.scope, bytes)) {
          captureRead.check();
          throw new ExtractionBudgetError('snapshot_limit');
        }
        raw = await file.readFile('utf8');
        captureRead?.check();
      } finally {
        await file.close();
      }
      captureRead?.check();
    } else raw = await fs.promises.readFile(this.persistPath, 'utf-8');
    captureRead?.check();
    const decoded: unknown = JSON.parse(raw);
    if (captureRead?.verifyStableSnapshot) {
      if (
        !opened ||
        decoded === null ||
        typeof decoded !== 'object' ||
        Array.isArray(decoded) ||
        Object.prototype.hasOwnProperty.call(decoded, 'group_id')
      )
        throw new CompositionalRetrievalSnapshotReadError('invalid_snapshot');
      const afterRead = await fs.promises.stat(this.persistPath, { bigint: true });
      captureRead.check();
      if (automaticClaimFileSignature(opened) !== automaticClaimFileSignature(afterRead))
        throw new CompositionalRetrievalSnapshotReadError('concurrent_snapshot');
      let snapshot: GraphData;
      try {
        snapshot = parseLosslessAutomaticCaptureGraph(decoded);
      } catch (error) {
        throw new CompositionalRetrievalSnapshotReadError(
          isCompositionalSnapshotResourceFailure(error) ? 'resource_exhausted' : 'invalid_snapshot',
        );
      }
      captureRead.check();
      if (hasAutonomousPersonalV4Enrollment(snapshot)) {
        assertAutonomousPersonalGraphIntegrityV4(snapshot, structuralGuardContext);
      }
      const afterValidation = await fs.promises.stat(this.persistPath, { bigint: true });
      captureRead.check();
      if (automaticClaimFileSignature(opened) !== automaticClaimFileSignature(afterValidation))
        throw new CompositionalRetrievalSnapshotReadError('concurrent_snapshot');
      return snapshot;
    }
    let losslessRawGraph: GraphData | undefined;
    const rawV4Enrollment = rawGraphHasAutonomousPersonalV4Enrollment(decoded);
    if (boundedRead || hasRawReplaySafeCaptureState(decoded) || rawV4Enrollment) {
      losslessRawGraph = parseLosslessAutomaticCaptureGraph(decoded);
    }
    if (rawV4Enrollment) {
      assertAutonomousPersonalGraphIntegrityV4(losslessRawGraph!, structuralGuardContext);
    }
    captureRead?.check();
    const migration = migrateGraphData(decoded);
    captureRead?.check();
    if (captureRead && migration.report.migration_required)
      throw new Error('Engram compositional capture: unsupported_mode');
    if (rawV4Enrollment || hasAutonomousPersonalV4Enrollment(migration.data)) {
      assertAutonomousPersonalGraphIntegrityV4(migration.data, structuralGuardContext);
    }
    const backupPath = `${this.persistPath}${EMBEDDED_BACKUP_SUFFIX}`;
    const legacyEpisodeCount = Math.max(
      migration.report.episode_defaults_applied.episode_kind,
      migration.report.episode_defaults_applied.trust_level,
      migration.report.episode_defaults_applied.review_status,
    );

    if (migration.report.migration_required) {
      const backupCreated = await this.ensureVerifiedMigrationBackup(raw, backupPath);
      await this.writeGraphDataAtomic(migration.data, this.persistPath);
      this.migrationStatus = {
        backend: 'embedded',
        target_version: CURRENT_GRAPH_DATA_VERSION,
        source_version: migration.report.source_version,
        migration_required: false,
        legacy_episode_count: legacyEpisodeCount,
        automatic_migration_completed: true,
        backup: {
          created: backupCreated,
          verified: true,
          path: backupPath,
        },
      };
      return migration.data;
    }

    const existingBackup = await this.inspectExistingBackup(backupPath, migration.data);
    this.migrationStatus = {
      backend: 'embedded',
      target_version: CURRENT_GRAPH_DATA_VERSION,
      source_version:
        existingBackup?.verified && existingBackup.sourceVersion
          ? existingBackup.sourceVersion
          : migration.report.source_version,
      migration_required: false,
      legacy_episode_count: existingBackup?.verified ? existingBackup.legacyEpisodeCount : 0,
      automatic_migration_completed: existingBackup?.verified ?? false,
      backup: {
        created: false,
        verified: existingBackup?.verified ?? false,
        path: existingBackup ? backupPath : null,
      },
    };
    return migration.data;
  }

  private async ensureVerifiedMigrationBackup(raw: string, backupPath: string): Promise<boolean> {
    let created = false;
    if (fs.existsSync(backupPath)) {
      const existing = await fs.promises.readFile(backupPath, 'utf-8');
      if (this.contentChecksum(existing) !== this.contentChecksum(raw)) {
        throw new Error(`Existing migration backup does not match source storage: ${backupPath}`);
      }
    } else {
      await this.writeTextAtomic(raw, backupPath);
      created = true;
    }

    const verified = await fs.promises.readFile(backupPath, 'utf-8');
    migrateGraphData(JSON.parse(verified));
    if (this.contentChecksum(verified) !== this.contentChecksum(raw)) {
      throw new Error(`Migration backup verification failed: ${backupPath}`);
    }
    await fs.promises.chmod(backupPath, 0o600);
    return created;
  }

  private async inspectExistingBackup(
    backupPath: string,
    currentData: GraphData,
  ): Promise<{
    sourceVersion: '1.0' | '2.0' | null;
    legacyEpisodeCount: number;
    verified: boolean;
  } | null> {
    if (!fs.existsSync(backupPath)) return null;
    try {
      const raw = await fs.promises.readFile(backupPath, 'utf-8');
      const migration = migrateGraphData(JSON.parse(raw));
      return {
        sourceVersion: migration.report.source_version,
        legacyEpisodeCount: Math.max(
          migration.report.episode_defaults_applied.episode_kind,
          migration.report.episode_defaults_applied.trust_level,
          migration.report.episode_defaults_applied.review_status,
        ),
        verified:
          this.contentChecksum(JSON.stringify(migration.data)) ===
          this.contentChecksum(JSON.stringify(currentData)),
      };
    } catch {
      return { sourceVersion: null, legacyEpisodeCount: 0, verified: false };
    }
  }

  private async writeGraphDataAtomic(data: GraphData, targetPath: string): Promise<void> {
    await this.writeTextAtomic(JSON.stringify(data, null, 2), targetPath);
  }

  private async writeTextAtomic(
    payload: string,
    targetPath: string,
    durable = false,
    onReplaced?: () => void,
    onReplacementAttempted?: () => void,
  ): Promise<void> {
    const dir = path.dirname(targetPath);
    await fs.promises.mkdir(dir, { recursive: true });
    const tmpPath = `${targetPath}.${process.pid}.${generateUuid()}.tmp`;

    try {
      if (durable) {
        const file = await fs.promises.open(tmpPath, 'w', 0o600);
        try {
          await file.writeFile(payload, 'utf8');
          await file.sync();
        } finally {
          await file.close();
        }
      } else await fs.promises.writeFile(tmpPath, payload, { encoding: 'utf-8', mode: 0o600 });
      onReplacementAttempted?.();
      await fs.promises.rename(tmpPath, targetPath);
      onReplaced?.();
      await fs.promises.chmod(targetPath, 0o600);
      if (durable) {
        // Include ancestor entries: a freshly created storage directory must survive too.
        let current = dir;
        for (;;) {
          const directory = await fs.promises.open(current, 'r');
          try {
            await directory.sync();
          } finally {
            await directory.close();
          }
          const parent = path.dirname(current);
          if (parent === current) break;
          current = parent;
        }
      }
    } catch (error) {
      await fs.promises.rm(tmpPath, { force: true }).catch(() => {});
      throw error;
    }
  }

  private contentChecksum(content: string): string {
    return createHash('sha256').update(content).digest('hex');
  }

  private replaceGraphData(data: GraphData, options: { trustedRollback?: boolean } = {}): void {
    assertAutomaticLedgerSourceIntegrity(data);
    if (!options.trustedRollback && !data.automatic_operations_v1 && this.automaticOperations) {
      throw new Error('Engram automatic ledger: native_root_missing');
    }
    this.extractionEpoch = data.metadata?.extraction_epoch;
    this.automaticOperations = data.automatic_operations_v1
      ? immutableAutomaticLedgerSnapshot(AutomaticLedgerSchema.parse(data.automatic_operations_v1))
      : undefined;
    this.resetGraph();
    this.mergeGraphData(data);
  }

  private resetGraph(): void {
    this.graph.clear();
    this.searchProvider.clear();
    this.episodeOrder.clear();
    this.nextOrder = 0;
  }

  private assertNoAutomaticOperationSourceDeletion(sourceIds: string[]): void {
    if (sourceIds.length === 0) return;
    const episodes: EpisodicNode[] = [];
    this.graph.forEachNode((_key, attributes) => {
      if (attributes.type === 'episode') episodes.push(attributes.data as EpisodicNode);
    });
    if (episodes.some(hasAutonomousSourceOwnership)) {
      // The source alone is protected even if the ledger/receipt was lost.
      // Keep legacy clear behavior separate from this V4 adjacency rule.
      assertNoAutomaticOperationChainImpact(undefined, episodes, sourceIds);
    }
    if (!this.automaticOperations) return;
    const sources = new Set(sourceIds);
    if (
      this.automaticOperations.operations.some((operation) =>
        sources.has(operation.identity.sourceId),
      )
    ) {
      throw new Error('Engram automatic ledger: source_delete_forbidden');
    }
  }

  private hasAutonomousSourceInMemory(): boolean {
    let found = false;
    this.graph.forEachNode((_key, attributes) => {
      if (attributes.type === 'episode' && hasAutonomousSourceOwnership(attributes.data))
        found = true;
    });
    return found;
  }

  private mergeGraphData(data: GraphData): void {
    // Import entities first because relationship edges require both endpoints.
    for (const entity of data.entities) {
      if (this.graph.hasNode(entity.uuid)) continue;
      const storedEntity = protectAutomaticEntity(entity);
      this.graph.addNode(entity.uuid, { type: 'entity', data: storedEntity });
      this.searchProvider.indexEntity(entity.uuid, {
        name: entity.name,
        summary: entity.summary,
        entity_type: entity.entity_type,
      });
    }

    const sortedEpisodes = [...data.episodes].sort((a, b) => {
      const timeDiff = new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
      return timeDiff;
    });
    for (const episode of sortedEpisodes) {
      if (this.graph.hasNode(episode.uuid)) continue;
      const storedEpisode = protectAutomaticEpisode(episode);
      this.graph.addNode(episode.uuid, { type: 'episode', data: storedEpisode });
      this.episodeOrder.set(episode.uuid, this.nextOrder++);
    }

    for (const edge of data.edges) {
      if (
        this.graph.hasEdge(edge.uuid) ||
        !this.graph.hasNode(edge.source_node_uuid) ||
        !this.graph.hasNode(edge.target_node_uuid)
      ) {
        continue;
      }
      this.graph.addEdgeWithKey(edge.uuid, edge.source_node_uuid, edge.target_node_uuid, {
        type: 'entity_edge',
        data: edge,
      });
      this.searchProvider.indexEdge(edge.uuid, {
        name: edge.name,
        fact: edge.fact,
      });
    }

    for (const episode of data.episodes) {
      const previousUuid = episode.previous_episode_uuid;
      if (!previousUuid || !this.graph.hasNode(previousUuid) || !this.graph.hasNode(episode.uuid)) {
        continue;
      }
      const previous = this.getEpisodeOrEntity(previousUuid, 'episode');
      if (!previous || previous.group_id !== episode.group_id) continue;

      const chainKey = `next_${previousUuid}_${episode.uuid}`;
      if (!this.graph.hasEdge(chainKey)) {
        this.graph.addEdgeWithKey(chainKey, previousUuid, episode.uuid, {
          type: 'next_episode',
          data: null,
        });
      }
    }
  }

  private getEpisodeOrEntity(
    uuid: string,
    expectedType: NodeType,
  ): EntityNode | EpisodicNode | null {
    if (!this.graph.hasNode(uuid)) return null;
    const attrs = this.graph.getNodeAttributes(uuid);
    return attrs.type === expectedType ? attrs.data : null;
  }

  private getEdgeInternal(uuid: string): EntityEdge | null {
    if (!this.graph.hasEdge(uuid)) return null;
    const attrs = this.graph.getEdgeAttributes(uuid);
    return attrs.type === 'entity_edge' ? (attrs.data as EntityEdge) : null;
  }

  private async acquirePersistLock(check?: () => void): Promise<() => Promise<void>> {
    if (!this.persistPath) return async () => {};

    const lockPath = `${this.persistPath}.lock`;
    const startedAt = Date.now();

    for (;;) {
      check?.();
      try {
        const lockToken = generateUuid();
        const handle = await fs.promises.open(lockPath, 'wx');
        try {
          check?.();
          await handle.writeFile(
            `${lockToken}\n${process.pid}\n${new Date().toISOString()}\n`,
            'utf-8',
          );
        } catch (error) {
          await handle.close().catch(() => {});
          await fs.promises.rm(lockPath, { force: true }).catch(() => {});
          throw error;
        }
        const heartbeat = setInterval(() => {
          void handle.utimes(new Date(), new Date()).catch(() => {});
        }, PERSIST_LOCK_HEARTBEAT_MS);
        heartbeat.unref();
        return async () => {
          clearInterval(heartbeat);
          await handle.close().catch(() => {});
          try {
            const activeToken = (await fs.promises.readFile(lockPath, 'utf-8')).split('\n')[0];
            if (activeToken === lockToken) {
              await fs.promises.rm(lockPath, { force: true });
            }
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
        };
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'EEXIST') throw error;

        check?.();
        const lockIsStale = await this.isPersistLockStale(lockPath);
        check?.();
        if (lockIsStale) {
          check?.();
          await fs.promises.rm(lockPath, { force: true }).catch(() => {});
          continue;
        }

        if (Date.now() - startedAt > PERSIST_LOCK_TIMEOUT_MS) {
          throw new Error(`Timed out waiting for Engram storage lock: ${lockPath}`);
        }

        await new Promise((resolve) => setTimeout(resolve, 25));
        check?.();
      }
    }
  }

  private async isPersistLockStale(lockPath: string): Promise<boolean> {
    try {
      const stats = await fs.promises.stat(lockPath);
      return Date.now() - stats.mtimeMs > PERSIST_LOCK_STALE_MS;
    } catch {
      return false;
    }
  }
}
