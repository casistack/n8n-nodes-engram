import { hashAutomaticCaptureV2 } from '../schemas/AutomaticCapture.schema';
import { assertCompositionalRecordIdentityV3 } from '../storage/CompositionalRecordIdentityV3';
import {
  CompositionalOperationSnapshotIndexRequestV3Schema,
  type CompositionalSnapshotIndexFailureReasonV3,
} from '../schemas/CompositionalOperationSnapshotIndexV3.schema';
import {
  canUseAutomaticClaimReadScope,
  getAutomaticClaimReadScopeRemaining,
  type AutomaticClaimReadScope,
} from '../storage/AutomaticClaimReadScope';
import { AutomaticBindingReferenceSchema } from '../schemas/AutomaticMemory.schema';
import type { EntityNode, EntityEdge, EpisodicNode, GraphData } from '../schemas';
import type { StoredAutomaticOperation } from '../schemas/AutomaticLedger.schema';
import { CompositionalCaptureNamespaceV3Schema } from '../schemas/CompositionalCaptureNamespaceV3.schema';
import { z } from 'zod';
import { parseLosslessAutomaticCaptureGraph } from '../storage/LosslessAutomaticCaptureGraph';
import { cloneBoundedAutomaticCaptureJson } from '../storage/BoundedAutomaticCaptureJson';
import {
  assertAutomaticBindingIdentity,
  assertAutomaticBindingRegistryIntegrity,
  BINDINGS_ATTRIBUTE,
} from '../storage/AutomaticIdentity';
import {
  AutomaticSubjectBindingsSchema,
  type AutomaticBindingRecord,
} from '../schemas/AutomaticOperations.schema';
import type { AutomaticClaimReadResult } from '../schemas/AutomaticClaimRead.schema';
import {
  buildAutomaticClaimReadIndices,
  projectAutomaticClaimReadContextWithUsage,
} from './AutomaticClaimCommitProof';

const domainSchema = z
  .object({ namespace: CompositionalCaptureNamespaceV3Schema, subjectId: z.string().uuid() })
  .strict();
const retrievalDomainSchema = z
  .object({ namespace: CompositionalCaptureNamespaceV3Schema })
  .strict();
declare const indexBrand: unique symbol;
export type CompositionalSnapshotIndexV3 = Readonly<{ [indexBrand]: true }>;
declare const retrievalIndexBrand: unique symbol;
/** Opaque full-root resource index; it grants no trusted-read or write authority. */
export type CompositionalRetrievalSnapshotIndexV3 = Readonly<{
  [retrievalIndexBrand]: true;
}>;
/** An immutable resource view; never a backend-origin, admission or write permit. */
export interface OwnedCompositionalSnapshotV3 {
  readonly graph: GraphData;
  readonly snapshotHash: string;
  readonly namespace: string;
  readonly subjectId: string;
  readonly subject: EntityNode;
  readonly candidates: readonly EntityEdge[];
  entity(id: string): EntityNode | undefined;
  episode(id: string): EpisodicNode | undefined;
  edge(id: string): EntityEdge | undefined;
  operationsForSource(id: string): readonly StoredAutomaticOperation[];
  operation(id: string): StoredAutomaticOperation | undefined;
  assertBinding(
    namespace: string,
    issuer: string,
    actor: string,
    ref: unknown,
    check?: () => void,
  ): EntityNode;
  projectLiteralCommitContext(
    edgeId: string,
    maxBytes: number,
  ): ReturnType<typeof projectAutomaticClaimReadContextWithUsage>;
}
/** Frozen data-only access to a retrieval root. No raw Maps or subject authority. */
export interface OwnedCompositionalRetrievalSnapshotV3 {
  readonly graph: GraphData;
  readonly snapshotHash: string;
  readonly namespace: string;
  entity(id: string): EntityNode | undefined;
  episode(id: string): EpisodicNode | undefined;
  edge(id: string): EntityEdge | undefined;
  edgesBetween(sourceId: string, targetId: string, limit: number): readonly EntityEdge[];
  operation(id: string): StoredAutomaticOperation | undefined;
  operationsForSource(id: string): readonly StoredAutomaticOperation[];
  currentBinding(namespace: string, issuer: string, actor: string): AutomaticBindingRecord | null;
  assertBinding(
    namespace: string,
    issuer: string,
    actor: string,
    ref: unknown,
    check?: () => void,
  ): EntityNode;
  projectLiteralCommitContext(
    edgeId: string,
    maxBytes: number,
  ): ReturnType<typeof projectAutomaticClaimReadContextWithUsage>;
}
type OwnedIndexRootV3 = {
  readonly graph: GraphData;
  readonly namespace: string;
  readonly snapshotHash: string;
  readonly entities: Map<string, EntityNode>;
  readonly episodes: Map<string, EpisodicNode>;
  readonly edges: Map<string, EntityEdge>;
  readonly edgesByPair: Map<string, readonly EntityEdge[]>;
  readonly candidatesBySubject: Map<string, readonly EntityEdge[]>;
  readonly operations: Map<string, readonly StoredAutomaticOperation[]>;
  readonly operationsById: Map<string, StoredAutomaticOperation>;
  readonly bindingsByIdentity: Map<string, AutomaticBindingRecord>;
  readonly readIndices: ReturnType<typeof buildAutomaticClaimReadIndices>;
  readonly literalProofCache: Map<
    string,
    { readonly result: AutomaticClaimReadResult; readonly inspectedBytes: number }
  >;
  readonly check: () => void;
};
const owned = new WeakMap<object, OwnedCompositionalSnapshotV3>();
const scopes = new WeakMap<object, AutomaticClaimReadScope>();
const retrievalOwned = new WeakMap<object, OwnedCompositionalRetrievalSnapshotV3>();
const retrievalRoots = new WeakMap<object, OwnedIndexRootV3>();
const retrievalScopes = new WeakMap<object, AutomaticClaimReadScope>();
const retrievalSubjectScopes = new WeakMap<object, AutomaticClaimReadScope>();
const MAX_CACHED_LITERAL_PROOFS = 128;
const MAX_LITERAL_PROOF_INSPECTION_BYTES = 512 * 1024;
const EMPTY_OPERATIONS: readonly StoredAutomaticOperation[] = Object.freeze([]);
function pairKey(a: string, b: string): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}
export class CompositionalSnapshotIndexErrorV3 extends Error {
  constructor(readonly reason: CompositionalSnapshotIndexFailureReasonV3) {
    super(`Engram compositional batch: ${reason}`);
  }
}
function scopedCheck(scope: AutomaticClaimReadScope, externalCheck: () => void): () => void {
  if (!getAutomaticClaimReadScopeRemaining(scope))
    throw new CompositionalSnapshotIndexErrorV3('invalid_scope');
  let failed = false;
  let failure: unknown;
  return () => {
    if (failed) throw failure;
    try {
      externalCheck();
      if (!canUseAutomaticClaimReadScope(scope))
        throw new CompositionalSnapshotIndexErrorV3('budget_exhausted');
    } catch (error) {
      failed = true;
      failure = error;
      throw error;
    }
  };
}
export function isCompositionalSnapshotReadScopeV3(
  token: unknown,
  scope: AutomaticClaimReadScope,
): boolean {
  return (
    token !== null &&
    typeof token === 'object' &&
    scopes.get(token) === scope &&
    getAutomaticClaimReadScopeRemaining(scope) !== null
  );
}

function freeze<T>(value: T, check: () => void): T {
  check();
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child, check);
    Object.freeze(value);
  }
  return value;
}
const fail = (): never => {
  throw new CompositionalSnapshotIndexErrorV3('invalid_snapshot');
};

function checkedLookup<T>(check: () => void, lookup: () => T): T {
  check();
  const value = lookup();
  check();
  return value;
}

function namespaceRow<T extends { group_id: string }>(
  row: T | undefined,
  namespace: string,
): T | undefined {
  return row?.group_id === namespace ? row : undefined;
}

function namespaceOperation(
  operation: StoredAutomaticOperation | undefined,
  namespace: string,
): StoredAutomaticOperation | undefined {
  return operation?.identity.namespace === namespace ? operation : undefined;
}

function bindingIdentityKey(namespace: string, issuer: string, actor: string): string {
  return JSON.stringify([namespace, issuer, actor]);
}

function fixedReadFailure(
  reason: 'invalid_context' | 'context_too_large',
): AutomaticClaimReadResult {
  return { status: 'invalid', reason };
}

function projectLiteralCommitContextFromRoot(
  root: OwnedIndexRootV3,
  namespace: string,
  edgeId: string,
  maxBytes: number,
  check: () => void,
): ReturnType<typeof projectAutomaticClaimReadContextWithUsage> {
  check();
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    const invalid = freeze(
      { result: fixedReadFailure('invalid_context'), inspectedBytes: 0 },
      check,
    );
    check();
    return invalid;
  }
  const limit = Math.min(maxBytes, MAX_LITERAL_PROOF_INSPECTION_BYTES);
  const existing = root.literalProofCache.get(edgeId);
  if (existing) {
    if (existing.inspectedBytes > limit) {
      const bounded = freeze(
        {
          result: fixedReadFailure('context_too_large'),
          inspectedBytes: limit + 1,
        },
        check,
      );
      check();
      return bounded;
    }
    check();
    return existing;
  }

  const actualEdge = root.edges.get(edgeId);
  if (!actualEdge || actualEdge.group_id !== namespace) {
    const missing = projectAutomaticClaimReadContextWithUsage(
      root.graph,
      namespace,
      edgeId,
      root.readIndices,
      maxBytes,
    );
    const immutable = freeze(missing.result, check);
    const result = Object.freeze({ result: immutable, inspectedBytes: missing.inspectedBytes });
    check();
    return result;
  }

  const projected = projectAutomaticClaimReadContextWithUsage(
    root.graph,
    namespace,
    edgeId,
    root.readIndices,
    maxBytes,
  );
  const immutable = freeze(projected.result, check);
  const entry = Object.freeze({ result: immutable, inspectedBytes: projected.inspectedBytes });
  const capacityOnlyFailure =
    projected.result.status === 'invalid' &&
    projected.result.reason === 'context_too_large' &&
    projected.inspectedBytes > limit &&
    limit < MAX_LITERAL_PROOF_INSPECTION_BYTES;
  if (!capacityOnlyFailure && root.literalProofCache.size < MAX_CACHED_LITERAL_PROOFS) {
    root.literalProofCache.set(edgeId, entry);
  }
  check();
  return entry;
}

function assertBindingFromRoot(
  root: OwnedIndexRootV3,
  namespace: string,
  issuer: string,
  actor: string,
  ref: unknown,
  additionalCheck?: () => void,
): EntityNode {
  const check = () => {
    root.check();
    additionalCheck?.();
    root.check();
  };
  check();
  if (namespace !== root.namespace) throw new Error('Engram automatic memory: missing_binding');
  const parsedRef = AutomaticBindingReferenceSchema.safeParse(
    cloneBoundedAutomaticCaptureJson(ref, 'beginRequest'),
  );
  if (!parsedRef.success) throw new Error('Engram automatic memory: binding_changed');
  const record = root.bindingsByIdentity.get(bindingIdentityKey(namespace, issuer, actor));
  if (!record) throw new Error('Engram automatic memory: missing_binding');
  const subject = root.entities.get(record.subjectId);
  if (!subject) throw new Error('Engram automatic memory: invalid_binding_metadata');
  // The whole registry and this subject's row were validated before indexing.
  // Reuse the existing active-binding and accepted-subject semantics on this
  // private, bounded projection rather than rescanning the root per lookup.
  const subjectRoot: GraphData = {
    version: root.graph.version,
    exported_at: root.graph.exported_at,
    entities: [subject],
    episodes: [],
    edges: [],
  };
  const accepted = assertAutomaticBindingIdentity(
    subjectRoot,
    namespace,
    issuer,
    actor,
    parsedRef.data,
    check,
  );
  check();
  return accepted;
}
/** Existing data-only selector; an optional registered scope binds new intake use. */
export function createCompositionalSnapshotIndexV3(
  graphValue: unknown,
  domainValue: unknown,
  externalCheck: () => void = () => {},
  scope?: AutomaticClaimReadScope,
): CompositionalSnapshotIndexV3 {
  const check = scope ? scopedCheck(scope, externalCheck) : externalCheck;
  check();
  const domain = domainSchema.parse(cloneBoundedAutomaticCaptureJson(domainValue, 'beginRequest'));
  const graph = parseLosslessAutomaticCaptureGraph(graphValue);
  check();
  return indexParsedGraph(graph, domain, check, scope);
}
/** Derive the subject only from one actual selected V3 operation in the full root. */
export function createCompositionalOperationSnapshotIndexV3(
  graphValue: unknown,
  selectorValue: unknown,
  scope: AutomaticClaimReadScope,
  externalCheck: () => void = () => {},
): CompositionalSnapshotIndexV3 {
  const check = scopedCheck(scope, externalCheck);
  check();
  const selector = CompositionalOperationSnapshotIndexRequestV3Schema.parse(
    cloneBoundedAutomaticCaptureJson(selectorValue, 'beginRequest'),
  );
  const graph = parseLosslessAutomaticCaptureGraph(graphValue);
  check();
  const matches = (graph.automatic_operations_v1?.operations ?? []).filter((op) => {
    check();
    return op.operationId === selector.operationId;
  });
  if (!matches.length || matches[0].identity.namespace !== selector.namespace)
    throw new CompositionalSnapshotIndexErrorV3('missing_operation');
  if (matches.length !== 1) throw new CompositionalSnapshotIndexErrorV3('ambiguous_operation');
  const operation = matches[0];
  if (operation.version !== 3) throw new CompositionalSnapshotIndexErrorV3('unsupported_mode');
  return indexParsedGraph(
    graph,
    { namespace: selector.namespace, subjectId: operation.identity.binding.subjectId },
    check,
    scope,
  );
}

/**
 * Owns one full unfiltered root and its maps so multiple actual subjects can be
 * selected without repeating the lossless clone or global integrity passes.
 */
export function createCompositionalRetrievalSnapshotIndexV3(
  graphValue: unknown,
  namespaceValue: unknown,
  scope: AutomaticClaimReadScope,
  externalCheck: () => void = () => {},
): CompositionalRetrievalSnapshotIndexV3 {
  const check = scopedCheck(scope, externalCheck);
  check();
  const domain = retrievalDomainSchema.parse(
    cloneBoundedAutomaticCaptureJson(namespaceValue, 'beginRequest'),
  );
  const graph = parseLosslessAutomaticCaptureGraph(graphValue);
  check();
  const root = createOwnedIndexRoot(graph, domain.namespace, check, undefined, true);
  check();

  const token = Object.freeze(Object.create(null)) as CompositionalRetrievalSnapshotIndexV3;
  const view: OwnedCompositionalRetrievalSnapshotV3 = Object.freeze({
    graph: root.graph,
    namespace: root.namespace,
    snapshotHash: root.snapshotHash,
    entity: (id: string) =>
      checkedLookup(root.check, () => namespaceRow(root.entities.get(id), root.namespace)),
    episode: (id: string) =>
      checkedLookup(root.check, () => namespaceRow(root.episodes.get(id), root.namespace)),
    edge: (id: string) =>
      checkedLookup(root.check, () => namespaceRow(root.edges.get(id), root.namespace)),
    edgesBetween: (sourceId: string, targetId: string, limit: number) =>
      checkedLookup(root.check, () =>
        Object.freeze(
          (root.edgesByPair.get(pairKey(sourceId, targetId)) ?? []).slice(
            0,
            Math.max(0, Math.min(129, limit)),
          ),
        ),
      ),
    operation: (id: string) =>
      checkedLookup(root.check, () =>
        namespaceOperation(root.operationsById.get(id), root.namespace),
      ),
    operationsForSource: (id: string) =>
      checkedLookup(root.check, () =>
        Object.freeze(
          (root.operations.get(id) ?? EMPTY_OPERATIONS).filter(
            (operation) => operation.identity.namespace === root.namespace,
          ),
        ),
      ),
    currentBinding: (namespace: string, issuer: string, actor: string) =>
      checkedLookup(root.check, () =>
        namespace === root.namespace
          ? (root.bindingsByIdentity.get(bindingIdentityKey(namespace, issuer, actor)) ?? null)
          : null,
      ),
    assertBinding: (
      namespace: string,
      issuer: string,
      actor: string,
      ref: unknown,
      innerCheck?: () => void,
    ) => assertBindingFromRoot(root, namespace, issuer, actor, ref, innerCheck),
    projectLiteralCommitContext: (edgeId: string, maxBytes: number) =>
      projectLiteralCommitContextFromRoot(root, root.namespace, edgeId, maxBytes, root.check),
  });
  check();
  retrievalOwned.set(token as object, view);
  retrievalRoots.set(token as object, root);
  retrievalScopes.set(token as object, scope);
  return token;
}

/** Identity-checked data-only view; copied JSON cannot recreate this root. */
export function getOwnedCompositionalRetrievalSnapshotV3(
  token: unknown,
): OwnedCompositionalRetrievalSnapshotV3 | null {
  if (token === null || typeof token !== 'object') return null;
  const key = token as object;
  const scope = retrievalScopes.get(token);
  const view = retrievalOwned.get(key);
  const root = retrievalRoots.get(key);
  if (!scope || !view || !root || !canUseAutomaticClaimReadScope(scope)) return null;
  root.check();
  if (!canUseAutomaticClaimReadScope(scope)) return null;
  return view;
}

/** Selects a subject only through an actual edge in the owned namespace root. */
export function selectCompositionalRetrievalSubjectIndexV3(
  retrievalToken: unknown,
  actualEdgeId: string,
  scope: AutomaticClaimReadScope,
  externalCheck: () => void = () => {},
): CompositionalSnapshotIndexV3 {
  const key =
    retrievalToken !== null && typeof retrievalToken === 'object'
      ? (retrievalToken as object)
      : null;
  const root = key ? retrievalRoots.get(key) : undefined;
  if (!root || !key || retrievalScopes.get(key) !== scope)
    throw new CompositionalSnapshotIndexErrorV3('invalid_scope');
  const check = scopedCheck(scope, externalCheck);
  check();
  const edge = root.edges.get(actualEdgeId);
  if (!edge || edge.group_id !== root.namespace) return fail();
  const subjectId = edge.source_node_uuid;
  const subject = root.entities.get(subjectId);
  if (!subject || subject.group_id !== root.namespace) fail();
  const token = createSubjectSnapshotIndexV3(
    root,
    { namespace: root.namespace, subjectId },
    check,
    scope,
    true,
  );
  check();
  return token;
}

function createOwnedIndexRoot(
  graph: GraphData,
  namespace: string,
  check: () => void,
  onlySubjectId?: string,
  includeBindings = false,
): OwnedIndexRootV3 {
  assertAutomaticBindingRegistryIntegrity(graph, check);
  assertCompositionalRecordIdentityV3(graph, check);
  const entities = new Map<string, EntityNode>();
  const episodes = new Map<string, EpisodicNode>();
  const edges = new Map<string, EntityEdge>();
  const bindingsByIdentity = new Map<string, AutomaticBindingRecord>();
  for (const entity of graph.entities) {
    check();
    entities.set(entity.uuid, entity);
    if (
      includeBindings &&
      Object.prototype.hasOwnProperty.call(entity.attributes, BINDINGS_ATTRIBUTE)
    ) {
      const parsedBindings = AutomaticSubjectBindingsSchema.parse(
        entity.attributes[BINDINGS_ATTRIBUTE],
      );
      for (const record of parsedBindings) {
        check();
        freeze(record, check);
        bindingsByIdentity.set(
          bindingIdentityKey(record.namespace, record.issuer, record.actorReference),
          record,
        );
      }
    }
  }
  for (const episode of graph.episodes) {
    check();
    episodes.set(episode.uuid, episode);
  }
  for (const edge of graph.edges) {
    check();
    edges.set(edge.uuid, edge);
  }
  if (onlySubjectId !== undefined) {
    const subject = entities.get(onlySubjectId);
    if (!subject || subject.group_id !== namespace) fail();
  }
  const mutableCandidatesBySubject = new Map<string, EntityEdge[]>();
  const mutableEdgesByPair = new Map<string, EntityEdge[]>();
  for (const edge of graph.edges) {
    check();
    if (edge.group_id === namespace) {
      const key = pairKey(edge.source_node_uuid, edge.target_node_uuid);
      const pair = mutableEdgesByPair.get(key) ?? [];
      pair.push(edge);
      mutableEdgesByPair.set(key, pair);
    }
    if (
      edge.group_id !== namespace ||
      (onlySubjectId !== undefined && edge.source_node_uuid !== onlySubjectId) ||
      (edge.name !== 'PREFERS' &&
        !Object.prototype.hasOwnProperty.call(edge.attributes, 'engram_claim_v1'))
    )
      continue;
    const rows = mutableCandidatesBySubject.get(edge.source_node_uuid) ?? [];
    rows.push(edge);
    mutableCandidatesBySubject.set(edge.source_node_uuid, rows);
  }
  const operations = new Map<string, StoredAutomaticOperation[]>();
  const operationsById = new Map<string, StoredAutomaticOperation>();
  for (const op of graph.automatic_operations_v1?.operations ?? []) {
    check();
    operationsById.set(op.operationId, op);
    const list = operations.get(op.identity.sourceId) ?? [];
    list.push(op);
    operations.set(op.identity.sourceId, list);
  }
  freeze(graph, check);
  const candidatesBySubject = new Map<string, readonly EntityEdge[]>();
  const edgesByPair = new Map<string, readonly EntityEdge[]>();
  for (const [key, pair] of mutableEdgesByPair) {
    check();
    edgesByPair.set(key, Object.freeze(pair));
  }
  for (const [subjectId, candidates] of mutableCandidatesBySubject) {
    candidates.sort((a, b) => (a.uuid < b.uuid ? -1 : a.uuid > b.uuid ? 1 : 0));
    Object.freeze(candidates);
    candidatesBySubject.set(subjectId, candidates);
  }
  for (const list of operations.values()) Object.freeze(list);
  const readIndices = buildAutomaticClaimReadIndices(graph);
  check();
  const sortRows = <T extends { uuid: string; group_id: string }>(rows: readonly T[]) =>
    rows
      .filter((row) => {
        check();
        return row.group_id === namespace;
      })
      .sort((a, b) => (a.uuid < b.uuid ? -1 : a.uuid > b.uuid ? 1 : 0));
  const snapshotHash = hashAutomaticCaptureV2({
    domain: 'engram-compositional-materialization-snapshot-v3',
    namespace,
    entities: sortRows(graph.entities),
    edges: sortRows(graph.edges),
    episodes: sortRows(graph.episodes),
    operations: (graph.automatic_operations_v1?.operations ?? [])
      .filter((op) => {
        check();
        return op.identity.namespace === namespace;
      })
      .sort((a, b) => (a.operationId < b.operationId ? -1 : a.operationId > b.operationId ? 1 : 0))
      .map((op) =>
        Object.fromEntries(
          Object.entries(op).filter(
            ([key]) =>
              !['attempts', 'overflowCount', 'auditTruncated', 'lastObservedAt'].includes(key),
          ),
        ),
      ),
  });
  check();
  return Object.freeze({
    graph,
    namespace,
    snapshotHash,
    entities,
    episodes,
    edges,
    edgesByPair,
    candidatesBySubject,
    operations,
    operationsById,
    bindingsByIdentity,
    readIndices,
    literalProofCache: new Map(),
    check,
  });
}

function createSubjectSnapshotIndexV3(
  root: OwnedIndexRootV3,
  domain: z.infer<typeof domainSchema>,
  check: () => void,
  scope?: AutomaticClaimReadScope,
  retrievalScoped = false,
): CompositionalSnapshotIndexV3 {
  check();
  const subject = root.entities.get(domain.subjectId);
  if (!subject || subject.group_id !== domain.namespace) fail();
  const candidates = root.candidatesBySubject.get(domain.subjectId) ?? Object.freeze([]);
  const token = Object.freeze(Object.create(null)) as CompositionalSnapshotIndexV3;
  const viewCheck = retrievalScoped
    ? () => {
        root.check();
        check();
        root.check();
      }
    : check;
  const read = <T>(lookup: () => T): T =>
    retrievalScoped ? checkedLookup(viewCheck, lookup) : lookup();
  const view: OwnedCompositionalSnapshotV3 = Object.freeze({
    graph: root.graph,
    snapshotHash: root.snapshotHash,
    namespace: domain.namespace,
    subjectId: domain.subjectId,
    subject: subject!,
    candidates,
    entity: (id: string) => read(() => root.entities.get(id)),
    episode: (id: string) => read(() => root.episodes.get(id)),
    edge: (id: string) => read(() => root.edges.get(id)),
    operationsForSource: (id: string) => read(() => root.operations.get(id) ?? EMPTY_OPERATIONS),
    operation: (id: string) => read(() => root.operationsById.get(id)),
    assertBinding: (
      namespace: string,
      issuer: string,
      actor: string,
      ref: unknown,
      innerCheck: () => void = check,
    ) => {
      const bindingCheck = retrievalScoped
        ? () => {
            viewCheck();
            innerCheck();
            viewCheck();
          }
        : innerCheck;
      bindingCheck();
      // The unfiltered whole registry was already checked for this privately
      // owned immutable root. This internal bounded projection reuses existing
      // binding semantics, never a caller partial root/global-authority flag.
      const parsedRef = AutomaticBindingReferenceSchema.parse(
        cloneBoundedAutomaticCaptureJson(ref, 'beginRequest'),
      );
      const row = root.entities.get(parsedRef.subjectId);
      if (!row) fail();
      return assertAutomaticBindingIdentity(
        {
          version: root.graph.version,
          exported_at: root.graph.exported_at,
          entities: [row!],
          episodes: [],
          edges: [],
        },
        namespace,
        issuer,
        actor,
        parsedRef,
        bindingCheck,
      );
    },
    projectLiteralCommitContext: (edgeId: string, maxBytes: number) =>
      retrievalScoped
        ? projectLiteralCommitContextFromRoot(root, domain.namespace, edgeId, maxBytes, viewCheck)
        : projectAutomaticClaimReadContextWithUsage(
            root.graph,
            domain.namespace,
            edgeId,
            root.readIndices,
            maxBytes,
          ),
  });
  check();
  owned.set(token as object, view);
  if (scope) scopes.set(token as object, scope);
  if (retrievalScoped && scope) retrievalSubjectScopes.set(token as object, scope);
  return token;
}

function indexParsedGraph(
  graph: GraphData,
  domain: z.infer<typeof domainSchema>,
  check: () => void,
  scope?: AutomaticClaimReadScope,
): CompositionalSnapshotIndexV3 {
  const root = createOwnedIndexRoot(graph, domain.namespace, check, domain.subjectId);
  return createSubjectSnapshotIndexV3(root, domain, check, scope);
}
/** Identity-checked code-owned view; JSON/copies do not provide an index. */
export function getOwnedCompositionalSnapshotV3(
  token: unknown,
): OwnedCompositionalSnapshotV3 | null {
  if (token === null || typeof token !== 'object') return null;
  const scope = retrievalSubjectScopes.get(token);
  if (scope && !canUseAutomaticClaimReadScope(scope)) return null;
  return owned.get(token) ?? null;
}
