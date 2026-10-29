import { performance } from 'node:perf_hooks';
import { types as utilTypes } from 'node:util';
import { canonicalAutomaticCaptureV2 } from '../schemas/AutomaticCapture.schema';
import {
  AutomaticSubjectBindingsSchema,
  type AutomaticBindingRecord,
} from '../schemas/AutomaticOperations.schema';
import {
  AutonomousPersonalQualifiedClaimEdgeIdV4Schema,
  AutonomousPersonalQualifiedClaimRequestV4Schema,
  AutonomousPersonalQualifiedClaimResultV4OwnedDataSchema,
  type AutonomousPersonalQualifiedClaimProofV4,
  type AutonomousPersonalQualifiedClaimRequestV4,
  type AutonomousPersonalQualifiedClaimResultV4,
} from '../schemas/AutonomousPersonalQualifiedClaimV4.schema';
import {
  AutonomousPersonalClaimV3OwnedDataSchema,
  AutonomousPersonalValueMarkerV3OwnedDataSchema,
  hashAutonomousPersonalSourceUnitIdV1,
} from '../schemas/AutonomousPersonalClaimV3.schema';
import {
  AutonomousPersonalStoredSourceIdentityV4OwnedDataSchema,
  reconstructAutonomousPersonalStoredSourceIdentityV4,
  type AutonomousPersonalStoredSourceIdentityV4,
} from '../schemas/AutonomousPersonalSourceV4.schema';
import {
  compileAutonomousPersonalSourceScanV1,
  type AutonomousPersonalSourceScanV1,
} from '../schemas/AutonomousPersonalSourceScanV1.schema';
import {
  compileAutonomousSourceGeometryV3,
  type AutonomousSourceGeometryCompilationV3,
  type AutonomousSourceGeometryInputV3,
} from '../schemas/AutonomousSourceGeometryV3.schema';
import {
  type AutonomousPersonalTypedSyntaxV1,
  type AutonomousPersonalTypedSyntaxWorkV1,
} from '../schemas/AutonomousPersonalTypedSyntaxV1.schema';
import {
  AutonomousPersonalOperationV4OwnedDataSchema,
  type AutonomousPersonalOperationV4,
} from '../schemas/AutonomousPersonalOperationV4.schema';
import { hashAutonomousPersonalDescriptorV4 } from '../schemas/AutonomousPersonalDescriptorV4.schema';
import {
  ExtractionMetadataV2Schema,
  extractionMetadataFromAttributes,
} from '../schemas/ExtractionMetadata.schema';
import type { EntityEdge, EntityNode, EpisodicNode } from '../schemas';
import type { GraphData } from '../schemas/GraphData.schema';
import type { StoredAutomaticOperation } from '../schemas/AutomaticLedger.schema';
import type { AutonomousPersonalClaimIndexCandidateRowsV4 } from '../schemas/AutonomousPersonalClaimIndexCandidateRowsV4.schema';
import { deriveAutonomousPersonalRecordIdsV1 } from '../storage/AutonomousPersonalRecordIdsV1';
import { buildAutonomousPersonalClaimCandidateV1 } from './AutonomousPersonalClaimCandidateV1';
import { compileAutonomousPersonalTypedSyntaxV1 } from './AutonomousPersonalTypedSyntaxV1';
import { parseLosslessAutomaticCaptureGraph } from '../storage/LosslessAutomaticCaptureGraph';
import {
  BoundedAutomaticCaptureJsonError,
  isNativePlainAutomaticCaptureObject,
} from '../storage/BoundedAutomaticCaptureJson';
import { assertAutomaticBindingRegistryIntegrity } from '../storage/AutomaticIdentity';
import { AutonomousPersonalTypedSyntaxFailureV1 } from './AutonomousPersonalTypedSyntaxV1';

const EDGE_CLAIM_ATTRIBUTE = 'engram_claim_v1';
const VALUE_LITERAL_ATTRIBUTE = 'engram_literal_v1';
const EXTRACTION_ATTRIBUTE = 'engram_extraction';
declare const indexBrand: unique symbol;

/** Opaque owned full-root index. It proves no backend origin, read, or write authority. */
export type AutonomousPersonalClaimIndexV4 = Readonly<{ [indexBrand]: true }>;

export type AutonomousPersonalClaimIndexV4FailureReason = 'invalid_snapshot' | 'snapshot_capacity';

export class AutonomousPersonalClaimIndexV4Error extends Error {
  constructor(readonly reason: AutonomousPersonalClaimIndexV4FailureReason) {
    super(`Engram autonomous personal claim index: ${reason}`);
    this.name = 'AutonomousPersonalClaimIndexV4Error';
    Object.freeze(this);
  }
}

type BindingEntry = Readonly<{ record: AutomaticBindingRecord; subjectId: string }>;
type CompleteSourceScan = AutonomousPersonalSourceScanV1 & { readonly status: 'complete' };
type CommittedPersonalOperationV4 = Extract<AutonomousPersonalOperationV4, { state: 'committed' }>;

type ReadySourceEvidence = Readonly<{
  geometry: AutonomousSourceGeometryCompilationV3;
  unitsById: ReadonlyMap<
    string,
    {
      unit: AutonomousPersonalSourceScanV1['units'][number];
      syntaxUnit: Extract<AutonomousPersonalTypedSyntaxV1, { status: 'complete' }>['units'][number];
    }
  >;
}>;

type SourceEvidenceCacheEntry =
  | Readonly<{ kind: 'ready'; value: ReadySourceEvidence }>
  | { kind: 'invalid' };

interface OwnedIndexRoot {
  readonly graph: GraphData;
  readonly entities: ReadonlyMap<string, readonly EntityNode[]>;
  readonly edges: ReadonlyMap<string, readonly EntityEdge[]>;
  readonly episodes: ReadonlyMap<string, readonly EpisodicNode[]>;
  readonly operationsById: ReadonlyMap<string, readonly StoredAutomaticOperation[]>;
  readonly operationsBySource: ReadonlyMap<string, readonly StoredAutomaticOperation[]>;
  readonly bindingsByIdentity: ReadonlyMap<string, readonly BindingEntry[]>;
  readonly bindingRegistryValid: boolean;
  readonly sourceEvidence: Map<string, SourceEvidenceCacheEntry>;
  readonly typedSyntaxWork: AutonomousPersonalTypedSyntaxWorkV1;
  readonly check: () => void;
}

const indices = new WeakMap<object, OwnedIndexRoot>();

function invalidRequest(): Error {
  const error = new Error('invalid_autonomous_claim_request_data');
  error.name = 'AutonomousPersonalClaimV4Error';
  return Object.freeze(error);
}

function snapshotFailure(reason: AutonomousPersonalClaimIndexV4FailureReason): never {
  throw new AutonomousPersonalClaimIndexV4Error(reason);
}

const nativeAbortSignalAbortedGetter = Object.getOwnPropertyDescriptor(
  AbortSignal.prototype,
  'aborted',
)?.get;

function readWorkContext(value: unknown): {
  readonly deadline: number;
  readonly signal: AbortSignal;
} {
  if (
    value === null ||
    typeof value !== 'object' ||
    utilTypes.isProxy(value) ||
    !isNativePlainAutomaticCaptureObject(value)
  ) {
    throw new AutonomousPersonalTypedSyntaxFailureV1('internal');
  }
  try {
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== 2 ||
      keys.some((key) => key !== 'absoluteMonotonicDeadlineMs' && key !== 'signal')
    ) {
      throw new AutonomousPersonalTypedSyntaxFailureV1('internal');
    }
    const deadlineProperty = Object.getOwnPropertyDescriptor(value, 'absoluteMonotonicDeadlineMs');
    const signalProperty = Object.getOwnPropertyDescriptor(value, 'signal');
    if (
      !deadlineProperty ||
      !deadlineProperty.enumerable ||
      !('value' in deadlineProperty) ||
      !signalProperty ||
      !signalProperty.enumerable ||
      !('value' in signalProperty) ||
      typeof deadlineProperty.value !== 'number' ||
      !Number.isFinite(deadlineProperty.value) ||
      signalProperty.value === null ||
      typeof signalProperty.value !== 'object' ||
      utilTypes.isProxy(signalProperty.value) ||
      nativeAbortSignalAbortedGetter === undefined
    ) {
      throw new AutonomousPersonalTypedSyntaxFailureV1('internal');
    }
    nativeAbortSignalAbortedGetter.call(signalProperty.value);
    return { deadline: deadlineProperty.value, signal: signalProperty.value as AbortSignal };
  } catch (error) {
    if (error instanceof AutonomousPersonalTypedSyntaxFailureV1) throw error;
    throw new AutonomousPersonalTypedSyntaxFailureV1('internal');
  }
}

function stickyCheck(
  callback: () => void,
  work: unknown,
): {
  readonly check: () => void;
  readonly rethrowFailure: () => void;
  readonly typedSyntaxWork: AutonomousPersonalTypedSyntaxWorkV1;
} {
  const supplied = readWorkContext(work);
  if (typeof callback !== 'function') {
    throw new AutonomousPersonalTypedSyntaxFailureV1('internal');
  }
  const typedSyntaxWork = Object.freeze({
    absoluteMonotonicDeadlineMs: supplied.deadline,
    signal: supplied.signal,
  });
  const abortedGetter = nativeAbortSignalAbortedGetter;
  if (abortedGetter === undefined) {
    throw new AutonomousPersonalTypedSyntaxFailureV1('internal');
  }
  let failed = false;
  let failure: unknown;
  const checkWork = () => {
    try {
      if (abortedGetter.call(supplied.signal)) {
        throw new AutonomousPersonalTypedSyntaxFailureV1('cancelled');
      }
      const now = performance.now();
      if (!Number.isFinite(now)) throw new AutonomousPersonalTypedSyntaxFailureV1('internal');
      if (now >= supplied.deadline) throw new AutonomousPersonalTypedSyntaxFailureV1('deadline');
    } catch (error) {
      if (error instanceof AutonomousPersonalTypedSyntaxFailureV1) throw error;
      throw new AutonomousPersonalTypedSyntaxFailureV1('internal');
    }
  };
  const check = () => {
    if (failed) throw failure;
    try {
      checkWork();
      callback();
      checkWork();
    } catch (error) {
      failed = true;
      failure = error;
      throw error;
    }
  };
  return {
    check,
    typedSyntaxWork,
    rethrowFailure: () => {
      if (failed) throw failure;
    },
  };
}

function append<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const prior = map.get(key);
  if (prior) prior.push(value);
  else map.set(key, [value]);
}

function freeze<T>(value: T, check: () => void): T {
  check();
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child, check);
    Object.freeze(value);
  }
  return value;
}

function indexRows<T extends { uuid: string }>(
  rows: readonly T[],
  check: () => void,
): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const row of rows) {
    check();
    append(result, row.uuid, row);
  }
  return result;
}

function bindingKey(namespace: string, issuer: string, actorReference: string): string {
  return JSON.stringify([namespace, issuer, actorReference]);
}

function indexBindings(
  graph: GraphData,
  check: () => void,
): { readonly valid: boolean; readonly byIdentity: Map<string, BindingEntry[]> } {
  let valid = true;
  try {
    assertAutomaticBindingRegistryIntegrity(graph, check);
  } catch {
    check();
    valid = false;
  }
  const byIdentity = new Map<string, BindingEntry[]>();
  for (const entity of graph.entities) {
    check();
    if (!Object.prototype.hasOwnProperty.call(entity.attributes, 'engram_actor_bindings_v1'))
      continue;
    const parsed = AutomaticSubjectBindingsSchema.safeParse(
      entity.attributes.engram_actor_bindings_v1,
    );
    if (!parsed.success) {
      valid = false;
      continue;
    }
    for (const record of parsed.data) {
      check();
      append(byIdentity, bindingKey(record.namespace, record.issuer, record.actorReference), {
        record,
        subjectId: entity.uuid,
      });
    }
  }
  for (const rows of byIdentity.values()) Object.freeze(rows);
  return { valid, byIdentity };
}

function ensureGlobalIdsUnique(graph: GraphData, check: () => void): void {
  const identifiers = new Set<string>();
  const add = (id: string) => {
    check();
    if (identifiers.has(id)) snapshotFailure('invalid_snapshot');
    identifiers.add(id);
  };
  for (const entity of graph.entities) add(entity.uuid);
  for (const edge of graph.edges) add(edge.uuid);
  for (const episode of graph.episodes) add(episode.uuid);
  for (const operation of graph.automatic_operations_v1?.operations ?? [])
    add(operation.operationId);
}

function operationSourceId(operation: StoredAutomaticOperation): string {
  return operation.identity.sourceId;
}

/** Own and index one complete lossless DATA graph snapshot. */
export function createAutonomousPersonalClaimIndexV4(
  graphValue: unknown,
  typedSyntaxWork: AutonomousPersonalTypedSyntaxWorkV1,
  codeOwnedCheck: () => void,
): AutonomousPersonalClaimIndexV4 {
  const sticky = stickyCheck(codeOwnedCheck, typedSyntaxWork);
  const { check } = sticky;
  try {
    check();
    const graph = parseLosslessAutomaticCaptureGraph(graphValue);
    check();
    ensureGlobalIdsUnique(graph, check);
    const entities = indexRows(graph.entities, check);
    const edges = indexRows(graph.edges, check);
    const episodes = indexRows(graph.episodes, check);
    const operationsById = new Map<string, StoredAutomaticOperation[]>();
    const operationsBySource = new Map<string, StoredAutomaticOperation[]>();
    for (const operation of graph.automatic_operations_v1?.operations ?? []) {
      check();
      append(operationsById, operation.operationId, operation);
      append(operationsBySource, operationSourceId(operation), operation);
    }
    for (const rows of operationsById.values()) Object.freeze(rows);
    for (const rows of operationsBySource.values()) Object.freeze(rows);
    const bindingIndex = indexBindings(graph, check);
    freeze(graph, check);
    const root: OwnedIndexRoot = {
      graph,
      entities,
      edges,
      episodes,
      operationsById,
      operationsBySource,
      bindingsByIdentity: bindingIndex.byIdentity,
      bindingRegistryValid: bindingIndex.valid,
      sourceEvidence: new Map(),
      typedSyntaxWork: sticky.typedSyntaxWork,
      check,
    };
    check();
    const token = Object.freeze(Object.create(null)) as AutonomousPersonalClaimIndexV4;
    indices.set(token as object, root);
    return token;
  } catch (error) {
    sticky.rethrowFailure();
    if (error instanceof AutonomousPersonalTypedSyntaxFailureV1) throw error;
    if (error instanceof BoundedAutomaticCaptureJsonError && error.reason !== 'invalid_json') {
      snapshotFailure('snapshot_capacity');
    }
    snapshotFailure('invalid_snapshot');
  }
}

function rootFor(index: unknown): OwnedIndexRoot {
  if (index === null || typeof index !== 'object') throw invalidRequest();
  const root = indices.get(index);
  if (!root) throw invalidRequest();
  return root;
}

/** Returns the exact frozen graph owned by a checked index. This is internal DATA access only. */
export function getAutonomousPersonalClaimIndexGraphV4(
  index: AutonomousPersonalClaimIndexV4,
): GraphData {
  const root = rootFor(index);
  root.check();
  const graph = root.graph;
  if (!Object.isFrozen(graph)) throw invalidRequest();
  root.check();
  return graph;
}

/**
 * Returns candidate rows from the exact maps owned by one claim index.
 * This lookup is DATA only; callers must qualify the claim separately.
 */
export function getAutonomousPersonalClaimIndexCandidateRowsV4(
  indexValue: unknown,
  edgeIdValue: unknown,
): AutonomousPersonalClaimIndexCandidateRowsV4 | null {
  const root = rootFor(indexValue);
  root.check();
  const edgeId = AutonomousPersonalQualifiedClaimEdgeIdV4Schema.parse(edgeIdValue);
  root.check();

  const edgeRows = root.edges.get(edgeId) ?? [];
  root.check();
  if (edgeRows.length !== 1) return null;
  const edge = edgeRows[0]!;
  root.check();

  const rawClaim = edge.attributes[EDGE_CLAIM_ATTRIBUTE];
  let claim: ReturnType<typeof AutonomousPersonalClaimV3OwnedDataSchema.parse>;
  try {
    const parsed = AutonomousPersonalClaimV3OwnedDataSchema.safeParse(rawClaim);
    root.check();
    if (!parsed.success) return null;
    const claimIsExact = exactArray(rawClaim, parsed.data);
    root.check();
    if (!claimIsExact) return null;
    claim = parsed.data;
  } catch (error) {
    root.check();
    if (error instanceof AutonomousPersonalTypedSyntaxFailureV1) throw error;
    return null;
  }

  const subjectRows = root.entities.get(edge.source_node_uuid) ?? [];
  root.check();
  const valueRows = root.entities.get(edge.target_node_uuid) ?? [];
  root.check();
  const sourceRows = root.episodes.get(claim.sourceId) ?? [];
  root.check();
  if (subjectRows.length !== 1 || valueRows.length !== 1 || sourceRows.length !== 1) return null;
  const subject = subjectRows[0]!;
  const value = valueRows[0]!;
  const source = sourceRows[0]!;
  root.check();

  const sourceOperations = root.operationsBySource.get(source.uuid) ?? [];
  root.check();
  let operation: StoredAutomaticOperation | undefined;
  let version4OperationCount = 0;
  for (const candidate of sourceOperations) {
    root.check();
    if (candidate.version === 4) {
      version4OperationCount += 1;
      operation = candidate;
    }
  }
  root.check();
  if (version4OperationCount !== 1 || operation === undefined || operation.version !== 4)
    return null;
  const operationParsed = AutonomousPersonalOperationV4OwnedDataSchema.safeParse(operation);
  root.check();
  if (!operationParsed.success) return null;
  const operationIsExact = exactArray(operation, operationParsed.data);
  root.check();
  if (!operationIsExact) return null;

  const rows: AutonomousPersonalClaimIndexCandidateRowsV4 = {
    edge,
    subject,
    value,
    source,
    operation,
  };
  root.check();
  const frozenRows = Object.freeze(rows);
  root.check();
  return frozenRows;
}

function resultData(
  root: OwnedIndexRoot,
  value: AutonomousPersonalQualifiedClaimResultV4,
): AutonomousPersonalQualifiedClaimResultV4 {
  root.check();
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, 'utf8') > 16 * 1024) {
    const capacityResult = AutonomousPersonalQualifiedClaimResultV4OwnedDataSchema.parse({
      status: 'capacity',
      reason: 'proof_capacity',
    });
    root.check();
    return freeze(capacityResult, root.check);
  }
  const parsed = AutonomousPersonalQualifiedClaimResultV4OwnedDataSchema.safeParse(value);
  if (!parsed.success) {
    root.check();
    return freeze(
      AutonomousPersonalQualifiedClaimResultV4OwnedDataSchema.parse({
        status: 'invalid',
        reason: 'invalid_record',
      }),
      root.check,
    );
  }
  root.check();
  return freeze(parsed.data, root.check);
}

function invalid(
  root: OwnedIndexRoot,
  reason: Extract<AutonomousPersonalQualifiedClaimResultV4, { status: 'invalid' }>['reason'],
): AutonomousPersonalQualifiedClaimResultV4 {
  return resultData(root, { status: 'invalid', reason });
}

function uncommitted(root: OwnedIndexRoot): AutonomousPersonalQualifiedClaimResultV4 {
  return resultData(root, { status: 'uncommitted', reason: 'capture_not_committed' });
}

function capacity(root: OwnedIndexRoot): AutonomousPersonalQualifiedClaimResultV4 {
  return resultData(root, { status: 'capacity', reason: 'proof_capacity' });
}

function exactArray(a: unknown, b: unknown): boolean {
  return canonicalAutomaticCaptureV2(a) === canonicalAutomaticCaptureV2(b);
}

function geometryInputFromStored(
  stored: AutonomousPersonalStoredSourceIdentityV4,
): AutonomousSourceGeometryInputV3 {
  const geometry = stored.tuple.envelope.geometry;
  if (geometry.mode === 'full_body') {
    return {
      rawContent: stored.source.content,
      mapping: { mode: 'full_body' },
      quoteRegions: geometry.quoteRegions,
    };
  }
  if (geometry.humanRegion === null || geometry.applicationWrapper === null)
    throw new Error('invalid_source_geometry');
  return {
    rawContent: stored.source.content,
    mapping: {
      mode: 'application_region',
      humanRegion: geometry.humanRegion,
      applicationWrapper: geometry.applicationWrapper,
    },
    quoteRegions: geometry.quoteRegions,
  };
}

function getSourceEvidence(
  root: OwnedIndexRoot,
  source: EpisodicNode,
  descriptor: unknown,
): ReadySourceEvidence | null {
  root.check();
  const cached = root.sourceEvidence.get(source.uuid);
  if (cached) {
    root.check();
    return cached.kind === 'ready' ? cached.value : null;
  }
  root.check();
  try {
    const stored = reconstructAutonomousPersonalStoredSourceIdentityV4({ source, descriptor });
    if (!AutonomousPersonalStoredSourceIdentityV4OwnedDataSchema.safeParse(stored).success) {
      root.check();
      root.sourceEvidence.set(source.uuid, { kind: 'invalid' });
      return null;
    }
    root.check();
    const input = geometryInputFromStored(stored);
    const geometry = compileAutonomousSourceGeometryV3(input);
    root.check();
    if (
      geometry.geometryHash !== stored.tuple.owner.geometryHash ||
      geometry.geometryHash !== stored.tuple.identity.geometryHash ||
      !exactArray(geometry.geometry, stored.tuple.envelope.geometry) ||
      geometry.geometry.rawContentHash !== stored.tuple.owner.contentHash ||
      geometry.geometry.rawContentHash !== stored.tuple.identity.contentHash ||
      geometry.geometry.rawUtf16Length !== stored.source.content.length
    ) {
      root.check();
      root.sourceEvidence.set(source.uuid, { kind: 'invalid' });
      return null;
    }
    const scan = compileAutonomousPersonalSourceScanV1(input);
    root.check();
    if (scan.status !== 'complete') {
      root.sourceEvidence.set(source.uuid, { kind: 'invalid' });
      return null;
    }
    const owner = stored.tuple.owner;
    const syntax = compileAutonomousPersonalTypedSyntaxV1(
      {
        ...input,
        syntaxScope: {
          namespace: owner.namespace,
          issuer: owner.issuer,
          actorReference: owner.actorReference,
          binding: owner.binding,
        },
      },
      root.typedSyntaxWork,
    );
    root.check();
    if (syntax.status !== 'complete') {
      root.sourceEvidence.set(source.uuid, { kind: 'invalid' });
      return null;
    }
    const completeScan = scan as CompleteSourceScan;
    const unitsById = new Map<
      string,
      {
        unit: (typeof completeScan.units)[number];
        syntaxUnit: (typeof syntax.units)[number];
      }
    >();
    for (const unit of completeScan.units) {
      root.check();
      const syntaxUnit = syntax.units[unit.index];
      if (!syntaxUnit || syntaxUnit.unitIndex !== unit.index) {
        root.check();
        root.sourceEvidence.set(source.uuid, { kind: 'invalid' });
        return null;
      }
      const unitId = hashAutonomousPersonalSourceUnitIdV1({
        rawContentHash: scan.rawContentHash,
        unitIndex: unit.index,
        parentRawSpan: unit.rawSpan,
        parentMappedSpan: unit.mappedSpan,
      });
      if (unitsById.has(unitId)) {
        root.check();
        root.sourceEvidence.set(source.uuid, { kind: 'invalid' });
        return null;
      }
      unitsById.set(unitId, { unit, syntaxUnit });
    }
    const ready: ReadySourceEvidence = { geometry, unitsById };
    root.check();
    root.sourceEvidence.set(source.uuid, { kind: 'ready', value: ready });
    return ready;
  } catch (error) {
    root.check();
    if (error instanceof AutonomousPersonalTypedSyntaxFailureV1) throw error;
    root.sourceEvidence.set(source.uuid, { kind: 'invalid' });
    return null;
  }
}

function expectedInitialCreatorState(
  operation: CommittedPersonalOperationV4,
): 'accepted' | 'proposed' {
  return operation.descriptor.policy.autoAccept ? 'accepted' : 'proposed';
}

function reviewPairIsStructural(
  edge: EntityEdge,
  value: EntityNode,
  source: EpisodicNode,
  operation: CommittedPersonalOperationV4,
  creatorState: 'accepted' | 'proposed',
): {
  readonly valid: boolean;
  readonly reviewState: 'accepted' | 'proposed' | 'rejected' | null;
} {
  const edgeMeta = ExtractionMetadataV2Schema.safeParse(edge.attributes[EXTRACTION_ATTRIBUTE]);
  const valueMeta = ExtractionMetadataV2Schema.safeParse(value.attributes[EXTRACTION_ATTRIBUTE]);
  if (
    !edgeMeta.success ||
    !valueMeta.success ||
    !exactArray(edgeMeta.data, edge.attributes[EXTRACTION_ATTRIBUTE]) ||
    !exactArray(valueMeta.data, value.attributes[EXTRACTION_ATTRIBUTE])
  ) {
    return { valid: false, reviewState: null };
  }
  const edgeData = edgeMeta.data;
  const valueData = valueMeta.data;
  if (
    edgeData.review_status !== valueData.review_status ||
    edgeData.threshold_decision !== valueData.threshold_decision ||
    edgeData.reviewed_at !== valueData.reviewed_at ||
    edgeData.reviewed_by !== valueData.reviewed_by ||
    edgeData.source !== 'policy' ||
    valueData.source !== 'policy' ||
    edgeData.confidence !== null ||
    valueData.confidence !== null ||
    !exactArray(edgeData.episode_uuids, [source.uuid]) ||
    !exactArray(valueData.episode_uuids, [source.uuid]) ||
    edgeData.extracted_at !== operation.createdAt ||
    valueData.extracted_at !== operation.createdAt
  ) {
    return { valid: false, reviewState: null };
  }
  const initial =
    edgeData.review_status === creatorState &&
    edgeData.threshold_decision ===
      (creatorState === 'accepted' ? 'auto_accepted' : 'pending_review') &&
    edgeData.reviewed_at === null &&
    edgeData.reviewed_by === null &&
    creatorState === expectedInitialCreatorState(operation);
  const manual =
    edgeData.threshold_decision === 'manually_reviewed' &&
    edgeData.reviewed_at !== null &&
    edgeData.reviewed_by !== null &&
    Date.parse(edgeData.reviewed_at) >= Date.parse(operation.terminalReceipt.terminalAt);
  return {
    valid: initial || manual,
    reviewState: edgeData.review_status,
  };
}

function bindingIsCurrentlyActive(
  root: OwnedIndexRoot,
  owner: Pick<
    AutonomousPersonalStoredSourceIdentityV4['tuple']['owner'],
    'namespace' | 'issuer' | 'actorReference' | 'binding'
  >,
): boolean {
  root.check();
  if (!root.bindingRegistryValid) return false;
  const rows = root.bindingsByIdentity.get(
    bindingKey(owner.namespace, owner.issuer, owner.actorReference),
  );
  if (!rows || rows.length !== 1) return false;
  const { record, subjectId } = rows[0]!;
  const subjectRows = root.entities.get(subjectId);
  if (!subjectRows || subjectRows.length !== 1) return false;
  const subject = subjectRows[0]!;
  return (
    record.state === 'active' &&
    record.bindingId === owner.binding.bindingId &&
    record.revision === owner.binding.revision &&
    record.subjectId === owner.binding.subjectId &&
    record.fingerprint === owner.binding.fingerprint &&
    subject.uuid === owner.binding.subjectId &&
    subject.group_id === owner.namespace &&
    extractionMetadataFromAttributes(subject.attributes)?.review_status === 'accepted'
  );
}

function inspectOwnedEdge(
  root: OwnedIndexRoot,
  edgeId: string,
): AutonomousPersonalQualifiedClaimResultV4 {
  root.check();
  const edgeRows = root.edges.get(edgeId) ?? [];
  if (edgeRows.length === 0) return invalid(root, 'missing_record');
  if (edgeRows.length !== 1) return invalid(root, 'ambiguous_record');
  const edge = edgeRows[0]!;
  const rawClaim = edge.attributes[EDGE_CLAIM_ATTRIBUTE];
  const claimParsed = AutonomousPersonalClaimV3OwnedDataSchema.safeParse(rawClaim);
  if (!claimParsed.success || !exactArray(rawClaim, claimParsed.data))
    return invalid(root, 'invalid_claim');
  const claim = claimParsed.data;
  const valueRows = root.entities.get(edge.target_node_uuid) ?? [];
  const subjectRows = root.entities.get(edge.source_node_uuid) ?? [];
  const sourceRows = root.episodes.get(claim.sourceId) ?? [];
  if (valueRows.length === 0 || subjectRows.length === 0 || sourceRows.length === 0)
    return invalid(root, 'missing_record');
  if (valueRows.length !== 1 || subjectRows.length !== 1 || sourceRows.length !== 1)
    return invalid(root, 'ambiguous_record');
  const value = valueRows[0]!;
  const subject = subjectRows[0]!;
  const source = sourceRows[0]!;
  const rawMarker = value.attributes[VALUE_LITERAL_ATTRIBUTE];
  const markerParsed = AutonomousPersonalValueMarkerV3OwnedDataSchema.safeParse(rawMarker);
  if (!markerParsed.success || !exactArray(rawMarker, markerParsed.data))
    return invalid(root, 'invalid_claim');
  const marker = markerParsed.data;
  const operationRows = root.operationsBySource.get(source.uuid) ?? [];
  if (operationRows.length === 0) return uncommitted(root);
  if (operationRows.length !== 1) return invalid(root, 'ambiguous_record');
  const operationValue = operationRows[0]!;
  if (operationValue.version !== 4) return invalid(root, 'invalid_operation');
  const operationParsed = AutonomousPersonalOperationV4OwnedDataSchema.safeParse(operationValue);
  if (!operationParsed.success || !exactArray(operationValue, operationParsed.data))
    return invalid(root, 'invalid_operation');
  const operation = operationParsed.data;
  if (operation.state !== 'committed') return uncommitted(root);
  if (operation.generation !== 1) return invalid(root, 'unsupported_generation');
  if (
    operation.lastResumeCause !== undefined ||
    operation.attempts[0]?.disposition !== 'claim_won' ||
    operation.attempts[0]?.at !== operation.createdAt ||
    operation.attempts.slice(1).some((attempt) => attempt.disposition === 'claim_won')
  ) {
    return invalid(root, 'invalid_operation');
  }
  const receipt = operation.terminalReceipt;
  if (
    receipt.kind !== 'human_autonomous_capture_committed' ||
    receipt.selection.kind !== 'occurrences'
  )
    return invalid(root, 'invalid_creator');
  if (
    source.created_at !== operation.createdAt ||
    edge.created_at !== operation.createdAt ||
    value.created_at !== operation.createdAt
  ) {
    return invalid(root, 'invalid_creator');
  }
  if (
    subject.group_id !== value.group_id ||
    edge.group_id !== subject.group_id ||
    claim.namespace !== subject.group_id ||
    marker.namespace !== subject.group_id ||
    source.group_id !== subject.group_id ||
    operation.identity.namespace !== subject.group_id ||
    claim.subjectId !== subject.uuid ||
    marker.subjectId !== subject.uuid ||
    edge.source_node_uuid !== subject.uuid ||
    edge.target_node_uuid !== value.uuid ||
    claim.namespace !== marker.namespace ||
    claim.subjectId !== marker.subjectId
  ) {
    return invalid(root, 'invalid_claim');
  }
  let stored: AutonomousPersonalStoredSourceIdentityV4;
  try {
    stored = reconstructAutonomousPersonalStoredSourceIdentityV4({
      source,
      descriptor: operation.descriptor,
    });
  } catch {
    root.check();
    return invalid(root, 'invalid_source');
  }
  root.check();
  if (
    !exactArray(stored.source, source) ||
    !exactArray(stored.tuple.identity, operation.identity) ||
    stored.tuple.owner.namespace !== subject.group_id ||
    stored.tuple.identity.namespace !== operation.identity.namespace ||
    stored.tuple.owner.sourceId !== source.uuid ||
    stored.tuple.owner.sourceId !== operation.identity.sourceId ||
    stored.tuple.identity.sourceHash !== operation.identity.sourceHash ||
    stored.tuple.owner.descriptorHash !== operation.identity.descriptorHash ||
    stored.tuple.owner.descriptorHash !== hashAutonomousPersonalDescriptorV4(operation.descriptor)
  ) {
    return invalid(root, 'invalid_source');
  }
  const descriptorHash = stored.tuple.owner.descriptorHash;
  if (
    claim.sourceId !== source.uuid ||
    claim.sourceHash !== stored.tuple.identity.sourceHash ||
    claim.descriptorHash !== descriptorHash ||
    !exactArray(claim.policy, operation.descriptor.policy) ||
    claim.evidence.rawContentHash !== stored.tuple.owner.contentHash
  ) {
    return invalid(root, 'invalid_claim');
  }
  let recordIds: { claimId: string; valueId: string };
  try {
    recordIds = deriveAutonomousPersonalRecordIdsV1({
      namespace: claim.namespace,
      subjectId: claim.subjectId,
      key: claim.key,
    });
  } catch {
    root.check();
    return invalid(root, 'invalid_claim');
  }
  if (
    edge.uuid !== recordIds.claimId ||
    value.uuid !== recordIds.valueId ||
    marker.key !== claim.key ||
    marker.kind !== claim.kind
  )
    return invalid(root, 'invalid_claim');
  const expectedEdgeName = claim.kind === 'typed_preference' ? 'PREFERS' : 'STATED';
  if (
    value.entity_type !== 'autonomous_personal_value' ||
    value.name !== claim.evidence.literal ||
    value.summary !== '' ||
    edge.name !== expectedEdgeName ||
    edge.fact !== claim.evidence.literal ||
    !exactArray(edge.episodes, [source.uuid]) ||
    Object.keys(value.attributes).sort().join(',') !== 'engram_extraction,engram_literal_v1' ||
    Object.keys(edge.attributes).sort().join(',') !== 'engram_claim_v1,engram_extraction'
  ) {
    return invalid(root, 'invalid_record');
  }
  if (operation.descriptor.policy.requiresProtectedIntent && !operation.descriptor.intentSetting) {
    return invalid(root, 'invalid_creator');
  }
  const creators = receipt.selection.items.filter(
    (item) => item.claimId === edge.uuid && item.effect === 'created',
  );
  if (creators.length > 1) return invalid(root, 'ambiguous_record');
  if (creators.length !== 1) return invalid(root, 'invalid_creator');
  const creator = creators[0]!;
  if (
    creator.kind !== claim.kind ||
    creator.evidenceHash !== claim.evidence.evidenceHash ||
    (creator.state !== 'accepted' && creator.state !== 'proposed') ||
    creator.state !== expectedInitialCreatorState(operation) ||
    creator.reason !==
      (creator.state === 'accepted' ? 'eligible_create' : 'profile_review_required')
  ) {
    return invalid(root, 'invalid_creator');
  }
  const review = reviewPairIsStructural(edge, value, source, operation, creator.state);
  if (!review.valid || review.reviewState === null) return invalid(root, 'invalid_review_pair');
  const evidence = getSourceEvidence(root, source, operation.descriptor);
  if (!evidence) return invalid(root, 'invalid_source');
  const sourceTime = new Date(Date.parse(source.reference_time)).toISOString();
  if (claim.kind === 'source_statement_record' && claim.sourceEventTime !== sourceTime)
    return invalid(root, 'invalid_claim');
  const occurrence = evidence.unitsById.get(claim.evidence.unitId);
  if (!occurrence) return invalid(root, 'invalid_claim');
  const { unit, syntaxUnit } = occurrence;
  let bundle: unknown = null;
  const literal = claim.evidence.literal;
  if (claim.kind === 'typed_preference') {
    if (syntaxUnit.kind !== 'typed') return invalid(root, 'invalid_claim');
    const bundles = syntaxUnit.preference.bundles.filter((candidateBundle) => {
      const span = candidateBundle.evidence.spans[0];
      return (
        candidateBundle.coverage === 'complete' &&
        candidateBundle.evidence.spans.length === 1 &&
        candidateBundle.evidence.lexicalForm === literal &&
        span?.raw.start === claim.evidence.rawSpan.start &&
        span?.raw.end === claim.evidence.rawSpan.end &&
        span?.content.start === claim.evidence.mappedSpan.start &&
        span?.content.end === claim.evidence.mappedSpan.end
      );
    });
    if (bundles.length !== 1)
      return invalid(root, bundles.length > 1 ? 'ambiguous_record' : 'invalid_claim');
    bundle = bundles[0];
  } else {
    if (
      syntaxUnit.kind === 'typed' ||
      !exactArray(unit.rawSpan, claim.evidence.rawSpan) ||
      !exactArray(unit.mappedSpan, claim.evidence.mappedSpan) ||
      source.content.slice(unit.rawSpan.start, unit.rawSpan.end) !== literal ||
      evidence.geometry.mappedHumanBody.slice(unit.mappedSpan.start, unit.mappedSpan.end) !==
        literal
    ) {
      return invalid(root, 'invalid_claim');
    }
  }
  if (
    source.content.slice(claim.evidence.rawSpan.start, claim.evidence.rawSpan.end) !== literal ||
    evidence.geometry.mappedHumanBody.slice(
      claim.evidence.mappedSpan.start,
      claim.evidence.mappedSpan.end,
    ) !== literal
  ) {
    return invalid(root, 'invalid_claim');
  }
  const candidateResult = buildAutonomousPersonalClaimCandidateV1({
    sourceId: stored.tuple.owner.sourceId,
    contentHash: stored.tuple.owner.contentHash,
    descriptorHash: stored.tuple.owner.descriptorHash,
    namespace: stored.tuple.owner.namespace,
    subjectId: stored.tuple.owner.binding.subjectId,
    sourceHash: stored.tuple.identity.sourceHash,
    policy: operation.descriptor.policy,
    sourceEventTime: sourceTime,
    unitId: claim.evidence.unitId,
    unitIndex: unit.index,
    kind: claim.kind,
    category: claim.interpretation.category,
    literal,
    rawSpan: claim.evidence.rawSpan,
    mappedSpan: claim.evidence.mappedSpan,
    bundle,
  });
  root.check();
  if (candidateResult.kind !== 'candidate') return capacity(root);
  if (
    !exactArray(candidateResult.claim, claim) ||
    candidateResult.reference.unitIndex !== unit.index ||
    candidateResult.reference.kind !== creator.kind ||
    candidateResult.reference.evidenceHash !== creator.evidenceHash ||
    candidateResult.reference.meaningHash !== creator.meaningHash ||
    !exactArray(candidateResult.reference.dependencies, creator.dependencies)
  ) {
    return invalid(root, 'invalid_claim');
  }
  const proof: AutonomousPersonalQualifiedClaimProofV4 = {
    storeHash: stored.tuple.owner.storeHash,
    namespace: stored.tuple.owner.namespace,
    subjectId: stored.tuple.owner.binding.subjectId,
    claimId: edge.uuid,
    valueId: value.uuid,
    sourceId: source.uuid,
    operationId: operation.operationId,
    key: claim.key,
    kind: claim.kind,
    unitIndex: unit.index,
    unitId: claim.evidence.unitId,
    rawSpan: claim.evidence.rawSpan,
    mappedSpan: claim.evidence.mappedSpan,
    sourceHash: stored.tuple.identity.sourceHash,
    descriptorHash,
    evidenceHash: claim.evidence.evidenceHash,
    meaningHash: creator.meaningHash,
    dependencies: creator.dependencies,
    createdAt: operation.createdAt,
    sourceEventTime: sourceTime,
    reviewState: review.reviewState,
  };
  return resultData(root, { status: 'structural', proof });
}

/** Rebuilds structural Claim3 creator DATA from one owned snapshot. */
export function inspectAutonomousPersonalClaimCreatorV4(
  indexValue: unknown,
  edgeIdValue: unknown,
): AutonomousPersonalQualifiedClaimResultV4 {
  const root = rootFor(indexValue);
  root.check();
  const edgeId = AutonomousPersonalQualifiedClaimEdgeIdV4Schema.parse(edgeIdValue);
  root.check();
  return inspectOwnedEdge(root, edgeId);
}

/** Adds request-specific current authority and time checks to structural creator DATA. */
export function qualifyAutonomousPersonalClaimCreatorV4(
  indexValue: unknown,
  requestValue: unknown,
): AutonomousPersonalQualifiedClaimResultV4 {
  const root = rootFor(indexValue);
  root.check();
  const request: AutonomousPersonalQualifiedClaimRequestV4 =
    AutonomousPersonalQualifiedClaimRequestV4Schema.parse(requestValue);
  root.check();
  const structural = inspectOwnedEdge(root, request.edgeId);
  if (structural.status !== 'structural') return structural;
  const proof = structural.proof;
  if (request.storeHash !== proof.storeHash)
    return resultData(root, { status: 'inactive', reason: 'store_mismatch' });
  if (request.namespace !== proof.namespace)
    return resultData(root, { status: 'inactive', reason: 'namespace_mismatch' });
  const edgeRows = root.edges.get(proof.claimId) ?? [];
  const sourceRows = root.episodes.get(proof.sourceId) ?? [];
  const opRows = root.operationsById.get(proof.operationId) ?? [];
  if (edgeRows.length !== 1 || sourceRows.length !== 1 || opRows.length !== 1)
    return invalid(root, 'ambiguous_record');
  const edge = edgeRows[0]!;
  const source = sourceRows[0]!;
  const operationValue = opRows[0]!;
  if (operationValue.version !== 4) return invalid(root, 'invalid_operation');
  const operation = AutonomousPersonalOperationV4OwnedDataSchema.safeParse(operationValue);
  if (!operation.success || operation.data.state !== 'committed')
    return invalid(root, 'invalid_operation');
  if (
    !bindingIsCurrentlyActive(root, {
      namespace: proof.namespace,
      issuer: operation.data.identity.issuer,
      actorReference: operation.data.identity.actorReference,
      binding: operation.data.identity.binding,
    })
  ) {
    return resultData(root, { status: 'inactive', reason: 'authority_inactive' });
  }
  if (
    source.review_status !== 'accepted' ||
    source.trust_level !== operation.data.descriptor.requestedTrustLevel
  ) {
    return resultData(root, { status: 'inactive', reason: 'source_inactive' });
  }
  const now = Date.parse(request.backendNow);
  const validAt = edge.valid_at === null ? null : Date.parse(edge.valid_at);
  const invalidAt = edge.invalid_at === null ? null : Date.parse(edge.invalid_at);
  const currentReview = ExtractionMetadataV2Schema.safeParse(edge.attributes[EXTRACTION_ATTRIBUTE]);
  if (!currentReview.success) return invalid(root, 'invalid_review_pair');
  const reviewedAt =
    currentReview.data.reviewed_at === null ? null : Date.parse(currentReview.data.reviewed_at);
  if (
    !Number.isFinite(now) ||
    (validAt !== null && !Number.isFinite(validAt)) ||
    (invalidAt !== null && !Number.isFinite(invalidAt)) ||
    (reviewedAt !== null && !Number.isFinite(reviewedAt))
  ) {
    return invalid(root, 'invalid_record');
  }
  if (
    Date.parse(operation.data.terminalReceipt.terminalAt) > now ||
    (reviewedAt !== null && reviewedAt > now) ||
    (validAt !== null && validAt > now) ||
    (invalidAt !== null && invalidAt <= now) ||
    edge.expired_at !== null
  ) {
    return resultData(root, { status: 'inactive', reason: 'time_inactive' });
  }
  root.check();
  return resultData(root, { status: 'qualified', proof });
}
