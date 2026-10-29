import { AutomaticClaimMetadataSchema } from '../schemas/AutomaticClaim.schema';
import {
  AutomaticClaimCommitProofSchema,
  AutomaticClaimReadContextSchema,
  type AutomaticClaimCommitProof,
  type AutomaticClaimReadContext,
  type AutomaticClaimReadResult,
} from '../schemas/AutomaticClaimRead.schema';
import { AutomaticCaptureOperationV2Schema } from '../schemas/AutomaticCaptureOperation.schema';
import {
  AutomaticCaptureSourceOwnerV2Schema,
  canonicalAutomaticCaptureV2,
} from '../schemas/AutomaticCapture.schema';
import type { GraphData } from '../schemas/GraphData.schema';
import type { EntityEdge, EntityNode, EpisodicNode } from '../schemas';
import {
  automaticCaptureOperationIdentityForOwnedSource,
  reconcileAutomaticCaptureOperationIdentity,
  WRITE_OWNER_V2_ATTRIBUTE,
} from '../storage/AutomaticIdentity';

interface ReadIndices {
  readonly graph: GraphData;
  readonly edges: Map<string, EntityEdge[]>;
  readonly episodes: Map<string, EpisodicNode[]>;
  readonly entities: Map<string, EntityNode[]>;
  readonly operations: Map<string, unknown[]>;
}

declare const indexBrand: unique symbol;
/** Opaque index token; it is usable only with the exact graph root it indexed. */
export type AutomaticClaimReadIndices = Readonly<{ [indexBrand]: true }>;

const indicesByToken = new WeakMap<object, ReadIndices>();
const graphKey = (group: string, id: string) => JSON.stringify([group, id]);
const MAX_CONTEXT_BYTES = 512 * 1024;
const MAX_JSON_NODES_PER_RECORD = 10_000;
const MAX_JSON_DEPTH = 64;

function append<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const values = map.get(key);
  if (values) values.push(value);
  else map.set(key, [value]);
}

/** Indexes the validated immutable snapshot once; subsequent lookups are O(1). */
export function buildAutomaticClaimReadIndices(graph: GraphData): AutomaticClaimReadIndices {
  const state: ReadIndices = {
    graph,
    edges: new Map(),
    episodes: new Map(),
    entities: new Map(),
    operations: new Map(),
  };
  for (const edge of graph.edges) append(state.edges, graphKey(edge.group_id, edge.uuid), edge);
  for (const episode of graph.episodes)
    append(state.episodes, graphKey(episode.group_id, episode.uuid), episode);
  for (const entity of graph.entities)
    append(state.entities, graphKey(entity.group_id, entity.uuid), entity);
  for (const operation of graph.automatic_operations_v1?.operations ?? []) {
    if (operation.version === 2) {
      append(
        state.operations,
        graphKey(operation.identity.namespace, operation.identity.sourceId),
        operation,
      );
    } else {
      append(
        state.operations,
        graphKey(operation.identity.namespace, operation.identity.sourceId),
        operation,
      );
    }
  }
  const token = Object.freeze(Object.create(null)) as AutomaticClaimReadIndices;
  indicesByToken.set(token as object, state);
  return token;
}

function result(
  status: Exclude<AutomaticClaimReadResult['status'], 'committed'>,
  reason: Exclude<AutomaticClaimReadResult, { status: 'committed' }>['reason'],
): AutomaticClaimReadResult {
  return { status, reason };
}

function serializedBytes(value: unknown): number | null {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? null : Buffer.byteLength(serialized, 'utf8');
  } catch {
    return null;
  }
}

function quotedJsonBytes(value: string, remaining: number): number | null {
  if (value.length + 2 > remaining) return null;
  let bytes = 2;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit === 0x22 || unit === 0x5c) bytes += 2;
    else if (unit === 0x08 || unit === 0x09 || unit === 0x0a || unit === 0x0c || unit === 0x0d)
      bytes += 2;
    else if (unit <= 0x1f) bytes += 6;
    else if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else bytes += 6;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) bytes += 6;
    else if (unit <= 0x7f) bytes += 1;
    else if (unit <= 0x7ff) bytes += 2;
    else bytes += 3;
    if (bytes > remaining) return null;
  }
  return bytes;
}

/** Bounded JSON sizing for untrusted capability results and located graph rows. */
export function boundedAutomaticClaimReadJsonBytes(
  value: unknown,
  limit = MAX_CONTEXT_BYTES,
): number {
  if (!Number.isSafeInteger(limit) || limit < 0) return 1;
  let bytes = 0;
  let visited = 0;
  const ancestors = new Set<object>();
  const add = (count: number): boolean => {
    bytes += count;
    return bytes <= limit;
  };
  const visit = (current: unknown, depth: number, arrayEntry = false): boolean => {
    if (++visited > MAX_JSON_NODES_PER_RECORD || depth > MAX_JSON_DEPTH) return false;
    if (current === null) return add(4);
    if (typeof current === 'string') {
      const size = quotedJsonBytes(current, limit - bytes);
      return size !== null && add(size);
    }
    if (typeof current === 'number')
      return add(Number.isFinite(current) ? String(current).length : 4);
    if (typeof current === 'boolean') return add(current ? 4 : 5);
    if (current === undefined && arrayEntry) return add(4);
    if (typeof current !== 'object' || current === undefined || ancestors.has(current))
      return false;
    ancestors.add(current);
    let success = true;
    try {
      if (Array.isArray(current)) {
        if (current.length > MAX_JSON_NODES_PER_RECORD) return false;
        success = add(1);
        for (let index = 0; success && index < current.length; index += 1) {
          if (++visited > MAX_JSON_NODES_PER_RECORD) return false;
          if (index > 0) success = add(1);
          if (success) {
            const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
            if (!descriptor) success = visit(undefined, depth + 1, true);
            else if (!('value' in descriptor)) success = false;
            else success = visit(descriptor.value, depth + 1, true);
          }
        }
        if (success) success = add(1);
      } else {
        const prototype = Object.getPrototypeOf(current);
        const plainPrototype =
          prototype === null ||
          (Object.getPrototypeOf(prototype) === null &&
            Object.getOwnPropertyDescriptor(prototype, 'constructor')?.value?.name === 'Object');
        if (!plainPrototype) success = false;
        const keys = success ? Object.keys(current) : [];
        if (keys.length > MAX_JSON_NODES_PER_RECORD) success = false;
        let first = true;
        if (success) success = add(1);
        for (const key of keys) {
          if (!success) break;
          if (++visited > MAX_JSON_NODES_PER_RECORD) {
            success = false;
            break;
          }
          const descriptor = Object.getOwnPropertyDescriptor(current, key);
          if (!descriptor || !('value' in descriptor)) {
            success = false;
            break;
          }
          const nested = descriptor.value;
          if (key === 'toJSON') {
            success = false;
            break;
          }
          if (nested === undefined || typeof nested === 'function' || typeof nested === 'symbol')
            continue;
          if (!first) success = add(1);
          first = false;
          const keyBytes = quotedJsonBytes(key, limit - bytes);
          if (keyBytes === null || !add(keyBytes) || !add(1)) {
            success = false;
            break;
          }
          success = visit(nested, depth + 1);
        }
        if (success) success = add(1);
      }
    } catch {
      success = false;
    }
    ancestors.delete(current);
    return success;
  };
  return visit(value, 0) ? bytes : limit + 1;
}

function one<T>(values: T[] | undefined): T | null | 'multiple' {
  if (!values || values.length === 0) return null;
  return values.length === 1 ? values[0] : 'multiple';
}

function isMultiple<T>(value: T | null | 'multiple'): value is 'multiple' {
  return value === 'multiple';
}

function inspectLocatedRows(
  index: ReadIndices,
  groupId: string,
  edgeId: string,
  limit: number,
): { inspectedBytes: number; exceeded: boolean } {
  let inspectedBytes = 0;
  const charge = (record: unknown): boolean => {
    const remaining = limit - inspectedBytes;
    const size = boundedAutomaticClaimReadJsonBytes(record, remaining);
    if (size > remaining) {
      inspectedBytes = limit + 1;
      return false;
    }
    inspectedBytes += size;
    return true;
  };

  const edges = index.edges.get(graphKey(groupId, edgeId)) ?? [];
  for (const edge of edges) if (!charge(edge)) return { inspectedBytes, exceeded: true };
  if (edges.length !== 1) return { inspectedBytes, exceeded: false };
  const rawClaim = edges[0].attributes.engram_claim_v1;
  const sourceIdDescriptor =
    rawClaim !== null && typeof rawClaim === 'object' && !Array.isArray(rawClaim)
      ? Object.getOwnPropertyDescriptor(rawClaim, 'sourceId')
      : undefined;
  if (
    !sourceIdDescriptor ||
    !('value' in sourceIdDescriptor) ||
    typeof sourceIdDescriptor.value !== 'string'
  ) {
    return { inspectedBytes, exceeded: false };
  }
  const sourceId = sourceIdDescriptor.value;
  const sources = index.episodes.get(graphKey(groupId, sourceId)) ?? [];
  for (const source of sources) if (!charge(source)) return { inspectedBytes, exceeded: true };
  const subjects = index.entities.get(graphKey(groupId, edges[0].source_node_uuid)) ?? [];
  for (const subject of subjects) if (!charge(subject)) return { inspectedBytes, exceeded: true };
  const values = index.entities.get(graphKey(groupId, edges[0].target_node_uuid)) ?? [];
  for (const value of values) if (!charge(value)) return { inspectedBytes, exceeded: true };
  const operations = index.operations.get(graphKey(groupId, sourceId)) ?? [];
  for (const operation of operations)
    if (!charge(operation)) return { inspectedBytes, exceeded: true };
  return { inspectedBytes, exceeded: false };
}

/**
 * Bounded full-root proof projection plus accounting for each located row and
 * matching operation. Input `graph` must be a coherent, validated immutable root.
 */
export function projectAutomaticClaimReadContextWithUsage(
  graph: GraphData,
  groupId: string,
  edgeId: string,
  suppliedIndices?: AutomaticClaimReadIndices,
  maxInspectionBytes = MAX_CONTEXT_BYTES,
): { result: AutomaticClaimReadResult; inspectedBytes: number } {
  if (!Number.isSafeInteger(maxInspectionBytes) || maxInspectionBytes < 0) {
    return { result: result('invalid', 'invalid_context'), inspectedBytes: 0 };
  }
  const indices = suppliedIndices ? indicesByToken.get(suppliedIndices as object) : undefined;
  if (suppliedIndices && (!indices || indices.graph !== graph)) {
    return { result: result('invalid', 'invalid_context'), inspectedBytes: 0 };
  }
  const index = indices ?? indicesByToken.get(buildAutomaticClaimReadIndices(graph) as object)!;
  const limit = Math.min(maxInspectionBytes, MAX_CONTEXT_BYTES);
  const inspected = inspectLocatedRows(index, groupId, edgeId, limit);
  if (inspected.exceeded) {
    return {
      result: result('invalid', 'context_too_large'),
      inspectedBytes: inspected.inspectedBytes,
    };
  }
  return {
    result: projectAutomaticClaimReadContextFromIndex(graph, groupId, edgeId, index),
    inspectedBytes: inspected.inspectedBytes,
  };
}

/** Compatibility result-only wrapper. */
export function projectAutomaticClaimReadContext(
  graph: GraphData,
  groupId: string,
  edgeId: string,
  suppliedIndices?: AutomaticClaimReadIndices,
): AutomaticClaimReadResult {
  return projectAutomaticClaimReadContextWithUsage(graph, groupId, edgeId, suppliedIndices).result;
}

/**
 * Projects exact committed V2 human evidence from a complete native graph root.
 * The optional private index must have been built for this same root object.
 */
function projectAutomaticClaimReadContextFromIndex(
  graph: GraphData,
  groupId: string,
  edgeId: string,
  index: ReadIndices,
): AutomaticClaimReadResult {
  const edge = one(index.edges.get(graphKey(groupId, edgeId)));
  if (!edge) return result('invalid', 'missing_edge');
  if (isMultiple(edge)) return result('invalid', 'invalid_context');

  const parsedClaim = AutomaticClaimMetadataSchema.safeParse(edge.attributes.engram_claim_v1);
  if (!parsedClaim.success) return result('invalid', 'invalid_claim');
  const claim = parsedClaim.data;
  const source = one(index.episodes.get(graphKey(groupId, claim.sourceId)));
  if (!source) return result('invalid', 'missing_source');
  if (isMultiple(source)) return result('invalid', 'invalid_context');
  const subject = one(index.entities.get(graphKey(groupId, edge.source_node_uuid)));
  if (!subject) return result('invalid', 'missing_subject');
  if (isMultiple(subject)) return result('invalid', 'invalid_context');
  const value = one(index.entities.get(graphKey(groupId, edge.target_node_uuid)));
  if (!value) return result('invalid', 'missing_value');
  if (isMultiple(value)) return result('invalid', 'invalid_context');

  if (source.role !== 'human' || source.group_id !== groupId) {
    return result('invalid', 'not_capture_source');
  }
  const parsedOwner = AutomaticCaptureSourceOwnerV2Schema.safeParse(
    source.attributes[WRITE_OWNER_V2_ATTRIBUTE],
  );
  if (!parsedOwner.success || parsedOwner.data.purpose !== 'human_turn_memory') {
    return result('invalid', 'not_capture_source');
  }

  const operations = index.operations.get(graphKey(groupId, source.uuid));
  const operation = one(operations);
  if (!operation) return result('uncommitted', 'missing_operation');
  if (isMultiple(operation)) return result('ambiguous', 'ambiguous_operation');
  const parsedOperation = AutomaticCaptureOperationV2Schema.safeParse(operation);
  if (!parsedOperation.success) return result('invalid', 'invalid_operation');
  const capture = parsedOperation.data;
  if (
    capture.identity.purpose !== 'human_turn_memory' ||
    capture.identity.role !== 'human' ||
    capture.descriptor.purpose !== 'human_turn_memory'
  ) {
    return result('invalid', 'invalid_operation');
  }
  if (capture.state !== 'committed') return result('uncommitted', 'capture_not_committed');
  if (capture.terminalReceipt.kind !== 'human_capture_committed') {
    return result('invalid', 'invalid_operation');
  }

  try {
    const sourceIdentity = automaticCaptureOperationIdentityForOwnedSource(
      source,
      capture.descriptor,
    );
    if (!reconcileAutomaticCaptureOperationIdentity(sourceIdentity, capture.identity)) {
      return result('invalid', 'invalid_operation');
    }
    const owner = parsedOwner.data;
    if (
      owner.namespace !== groupId ||
      owner.storeHash !== capture.identity.storeHash ||
      owner.issuer !== capture.identity.issuer ||
      owner.actorReference !== capture.identity.actorReference ||
      owner.turn !== capture.identity.turn ||
      owner.binding?.bindingId !== capture.identity.binding.bindingId ||
      owner.binding?.revision !== capture.identity.binding.revision ||
      owner.binding?.subjectId !== capture.identity.binding.subjectId ||
      owner.binding?.fingerprint !== capture.identity.binding.fingerprint ||
      claim.sourceId !== source.uuid ||
      claim.subjectId !== capture.identity.binding.subjectId ||
      claim.binding.bindingId !== capture.identity.binding.bindingId ||
      claim.binding.revision !== capture.identity.binding.revision ||
      claim.binding.subjectId !== capture.identity.binding.subjectId ||
      claim.binding.fingerprint !== capture.identity.binding.fingerprint ||
      claim.issuer !== capture.identity.issuer ||
      claim.actorReference !== capture.identity.actorReference ||
      canonicalAutomaticCaptureV2(claim.policy) !==
        canonicalAutomaticCaptureV2(capture.descriptor.policy)
    ) {
      return result('invalid', 'invalid_claim');
    }
  } catch {
    return result('invalid', 'invalid_operation');
  }

  const terminal = capture.terminalReceipt;
  const matching = terminal.dependencies.filter(
    (dependency) => dependency.sourceId === source.uuid && dependency.claimId === edge.uuid,
  );
  if (matching.length !== 1) return result('invalid', 'invalid_claim');
  const dependency = matching[0];
  const item = terminal.receipt.items[dependency.itemIndex];
  if (
    !item ||
    item.claimId !== edge.uuid ||
    item.state !== dependency.state ||
    item.persisted !== dependency.persisted ||
    JSON.stringify(item.reasons) !== JSON.stringify(dependency.reasons) ||
    !item.persisted ||
    !['accepted', 'proposed', 'rejected', 'unchanged'].includes(item.state)
  ) {
    return result('invalid', 'invalid_claim');
  }

  const proofInput: AutomaticClaimCommitProof = {
    version: 1,
    kind: 'committed_human_capture',
    operationId: capture.operationId,
    identity: capture.identity,
    descriptor: capture.descriptor,
    terminalReceipt: terminal,
  };
  const proofBytes = serializedBytes(proofInput);
  if (proofBytes === null) return result('invalid', 'invalid_operation');
  if (proofBytes > 24 * 1024) return result('invalid', 'proof_too_large');
  const parsedProof = AutomaticClaimCommitProofSchema.safeParse(proofInput);
  if (!parsedProof.success) return result('invalid', 'invalid_operation');

  const contextInput: AutomaticClaimReadContext = {
    edge,
    source,
    subject,
    value,
    proof: parsedProof.data,
  };
  const contextBytes = serializedBytes(contextInput);
  if (contextBytes === null) return result('invalid', 'invalid_context');
  if (contextBytes > 512 * 1024) return result('invalid', 'context_too_large');
  const parsedContext = AutomaticClaimReadContextSchema.safeParse(contextInput);
  if (!parsedContext.success) return result('invalid', 'invalid_context');
  return { status: 'committed', context: parsedContext.data };
}
