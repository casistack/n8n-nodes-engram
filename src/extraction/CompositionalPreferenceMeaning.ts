import { createHash } from 'crypto';
import {
  CompositionalPreferenceSchema,
  type CompositionalPreference,
  type CompositionalPreferenceBundle,
  CompositionalPreferenceReasonSchema,
  snapshotBoundedCompositionalJson,
} from '../schemas/CompositionalPreference.schema';
import {
  type CompositionalPreferenceMeaningEdge,
  type CompositionalPreferenceMeaningNode,
  CompositionalPreferenceMeaningProjectionInputSchema,
  CompositionalPreferenceMeaningProjectionResultSchema,
  CompositionalPreferenceMeaningSchema,
  type CompositionalPreferenceMeaningProjectionInput,
  type CompositionalPreferenceMeaningProjectionResult,
  type CompositionalPreferenceMeaningBundle,
} from '../schemas/CompositionalPreferenceMeaning.schema';

type GraphPath = string;

interface PendingNode {
  nodeId: string;
  path: GraphPath;
}

const EDGE_PATH_SEGMENT: Record<
  Exclude<CompositionalPreferenceMeaningEdge['relation'], 'all_of' | 'orders'>,
  string
> = {
  targets: 'target',
  language_of: 'language',
  presents: 'presentation',
  has_ordering: 'ordering',
  modifies: 'modifier',
  qualifies: 'qualifier',
  counts: 'count',
  quantifies: 'quantifier',
  frequency: 'frequency',
  conditions: 'condition',
  scopes: 'scope',
};

function checkNow(check: (() => void) | undefined): void {
  check?.();
}

function failed(reason: string): CompositionalPreferenceMeaningProjectionResult {
  const parsedReason = CompositionalPreferenceReasonSchema.safeParse(reason);
  const result = {
    ok: false as const,
    reason: parsedReason.success ? parsedReason.data : 'invalid_ast_integrity',
  };
  return CompositionalPreferenceMeaningProjectionResultSchema.parse(result);
}

function preflightAst(value: unknown, check?: () => void): string | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return 'invalid_ast_integrity';
  }
  const candidate = value as { bundles?: unknown };
  if (!Array.isArray(candidate.bundles) || candidate.bundles.length > 32) {
    return candidate.bundles && Array.isArray(candidate.bundles)
      ? 'too_many_bundles'
      : 'invalid_ast_integrity';
  }

  let nodeCount = 0;
  let preferenceCount = 0;
  let edgeCount = 0;
  for (const bundle of candidate.bundles) {
    checkNow(check);
    if (bundle === null || typeof bundle !== 'object' || Array.isArray(bundle)) {
      return 'invalid_ast_integrity';
    }
    const members = (bundle as { members?: unknown }).members;
    const attachments = (bundle as { attachments?: unknown }).attachments;
    if (!Array.isArray(members) || members.length > 128) return 'too_many_nodes';
    if (!Array.isArray(attachments) || attachments.length > 128) return 'too_many_nodes';
    nodeCount += members.length;
    edgeCount += attachments.length;
    if (nodeCount > 128 || edgeCount > 128) return 'too_many_nodes';
    for (const member of members) {
      checkNow(check);
      if (
        member !== null &&
        typeof member === 'object' &&
        !Array.isArray(member) &&
        (member as { kind?: unknown }).kind === 'preference'
      ) {
        preferenceCount += 1;
      }
    }
    if (preferenceCount > 32) return 'too_many_nodes';
    for (let edgeIndex = 0; edgeIndex < attachments.length; edgeIndex += 1) checkNow(check);
  }
  // The caller supplies a bounded, plain-JSON snapshot. Serializing this
  // validated clone cannot invoke untrusted accessors or `toJSON` hooks.
  const serialized = JSON.stringify(value);
  if (typeof serialized !== 'string') return 'invalid_ast_integrity';
  if (Buffer.byteLength(serialized, 'utf8') > 32 * 1024) return 'metadata_too_large';
  return null;
}

function childSegment(
  edge: CompositionalPreferenceBundle['attachments'][number],
  ownerKind: string,
): string {
  if (edge.relation === 'all_of') return '';
  if (edge.relation === 'orders') return edge.position === 'first' ? 'first' : 'second';
  if (edge.relation === 'qualifies') {
    return ownerKind === 'language' ? 'language_use' : 'qualifier';
  }
  return EDGE_PATH_SEGMENT[edge.relation];
}

function canonicalNode(
  node: CompositionalPreference['bundles'][number]['members'][number],
  path: GraphPath,
  paths: Map<string, GraphPath>,
): CompositionalPreferenceMeaningNode {
  switch (node.kind) {
    case 'preference':
      return {
        path,
        kind: 'preference',
        operator: node.operator,
        polarity: node.polarity,
        negation: node.negation === 'none' ? 'none' : 'negative',
        targetPath: paths.get(node.targetNodeId) ?? `${path}.target`,
      };
    case 'language':
      return {
        path,
        kind: 'language',
        base: node.base,
        ...(node.region === undefined ? {} : { region: node.region }),
        languageTag: node.languageTag,
      };
    case 'output':
      return { path, kind: 'output', value: node.value };
    case 'presentation':
      return { path, kind: 'presentation', value: node.value };
    case 'action':
      return { path, kind: 'action', value: node.value };
    case 'ordering':
      return { path, kind: 'ordering', relation: node.relation };
    case 'language_use':
      return { path, kind: 'language_use', value: node.value };
    case 'action_qualifier':
      return { path, kind: 'action_qualifier', value: node.value };
    case 'style':
      return { path, kind: 'style', value: node.value };
    case 'length':
      return { path, kind: 'length', value: node.value };
    case 'detail':
      return { path, kind: 'detail', value: node.value };
    case 'register':
      return { path, kind: 'register', value: node.value };
    case 'count':
      return { path, kind: 'count', value: node.value, mode: node.mode };
    case 'quantifier':
      return { path, kind: 'quantifier', value: node.value };
    case 'frequency':
      return { path, kind: 'frequency', value: node.value };
    case 'condition':
      return { path, kind: 'condition', value: node.value };
    case 'task_scope':
      return { path, kind: 'task_scope', value: node.value };
  }
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function rootPrefix(path: GraphPath): GraphPath {
  const separator = path.indexOf('.');
  return separator < 0 ? path : path.slice(0, separator);
}

function rebasePath(path: GraphPath, oldRoot: GraphPath, newRoot: GraphPath): GraphPath {
  return path === oldRoot ? newRoot : `${newRoot}${path.slice(oldRoot.length)}`;
}

function sortMeaningEdges(edges: CompositionalPreferenceMeaningEdge[]): void {
  edges.sort(
    (left, right) =>
      compareStrings(left.relation, right.relation) ||
      compareStrings(left.ownerPath, right.ownerPath) ||
      compareStrings(left.targetPath, right.targetPath) ||
      compareStrings(
        'position' in left ? left.position : '',
        'position' in right ? right.position : '',
      ),
  );
}

function canonicalizeConjunctionPaths(
  bundle: CompositionalPreferenceMeaningBundle,
  check?: () => void,
): CompositionalPreferenceMeaningBundle {
  if (bundle.relation !== 'allOf') return bundle;

  const children = new Map(bundle.rootPaths.map((path) => [path, [] as string[]]));
  const nodesByRoot = new Map(
    bundle.rootPaths.map((path) => [path, [] as CompositionalPreferenceMeaningNode[]]),
  );
  const edgesByRoot = new Map(
    bundle.rootPaths.map((path) => [path, [] as CompositionalPreferenceMeaningEdge[]]),
  );
  for (const node of bundle.nodes) {
    checkNow(check);
    nodesByRoot.get(rootPrefix(node.path))?.push(node);
  }
  for (const edge of bundle.edges) {
    checkNow(check);
    if (edge.relation === 'all_of') {
      children.get(edge.ownerPath)?.push(edge.targetPath);
    } else {
      edgesByRoot.get(rootPrefix(edge.ownerPath))?.push(edge);
    }
  }

  const signatureCache = new Map<string, string>();
  const signature = (rootPath: string): string => {
    checkNow(check);
    const cached = signatureCache.get(rootPath);
    if (cached !== undefined) return cached;
    const localNodes = (nodesByRoot.get(rootPath) ?? []).map((node) => {
      checkNow(check);
      if (node.kind === 'preference') {
        return {
          ...node,
          path: rebasePath(node.path, rootPath, '$'),
          targetPath: rebasePath(node.targetPath, rootPath, '$'),
        };
      }
      return { ...node, path: rebasePath(node.path, rootPath, '$') };
    });
    localNodes.sort((left, right) => compareStrings(left.path, right.path));
    const localEdges = (edgesByRoot.get(rootPath) ?? []).map((edge) => {
      checkNow(check);
      return {
        ...edge,
        ownerPath: rebasePath(edge.ownerPath, rootPath, '$'),
        targetPath: rebasePath(edge.targetPath, rootPath, '$'),
      } as CompositionalPreferenceMeaningEdge;
    });
    sortMeaningEdges(localEdges);
    const childSignatures = (children.get(rootPath) ?? [])
      .map((child) => signature(child))
      .sort(compareStrings);
    const hasher = createHash('sha256').update(
      JSON.stringify({ nodes: localNodes, edges: localEdges }),
    );
    for (const childSignature of childSignatures) {
      checkNow(check);
      hasher.update('\u0000').update(childSignature);
    }
    const value = hasher.digest('hex');
    signatureCache.set(rootPath, value);
    return value;
  };

  const canonicalRoots: string[] = [];
  const reached = new Set<string>();
  const append = (rootPath: string): void => {
    checkNow(check);
    if (reached.has(rootPath)) return;
    reached.add(rootPath);
    canonicalRoots.push(rootPath);
    const orderedChildren = [...(children.get(rootPath) ?? [])];
    orderedChildren.sort((left, right) => compareStrings(signature(left), signature(right)));
    for (const child of orderedChildren) append(child);
  };
  const firstRoot = bundle.rootPaths[0];
  if (firstRoot) append(firstRoot);
  if (canonicalRoots.length !== bundle.rootPaths.length) {
    throw new Error('Validated allOf graph has no canonical root traversal');
  }

  const nextPath = new Map<string, string>();
  canonicalRoots.forEach((oldRoot, index) => nextPath.set(oldRoot, `p${index}`));
  const nodes = bundle.nodes.map((node) => {
    checkNow(check);
    const oldRoot = rootPrefix(node.path);
    const newRoot = nextPath.get(oldRoot);
    if (!newRoot) throw new Error('Meaning root path could not be canonicalized');
    if (node.kind === 'preference') {
      return {
        ...node,
        path: rebasePath(node.path, oldRoot, newRoot),
        targetPath: rebasePath(node.targetPath, oldRoot, newRoot),
      };
    }
    return { ...node, path: rebasePath(node.path, oldRoot, newRoot) };
  });
  nodes.sort((left, right) => compareStrings(left.path, right.path));
  const edges = bundle.edges.map((edge) => {
    checkNow(check);
    const oldRoot = rootPrefix(edge.ownerPath);
    const newRoot = nextPath.get(oldRoot);
    if (!newRoot) throw new Error('Meaning edge root path could not be canonicalized');
    const targetRoot = rootPrefix(edge.targetPath);
    const newTargetRoot = nextPath.get(targetRoot);
    if (!newTargetRoot) throw new Error('Meaning edge target root could not be canonicalized');
    return {
      ...edge,
      ownerPath: rebasePath(edge.ownerPath, oldRoot, newRoot),
      targetPath: rebasePath(edge.targetPath, targetRoot, newTargetRoot),
    } as CompositionalPreferenceMeaningEdge;
  });
  sortMeaningEdges(edges);
  return { ...bundle, rootPaths: canonicalRoots.map((_, index) => `p${index}`), nodes, edges };
}

function projectBundle(
  bundle: CompositionalPreferenceBundle,
  check?: () => void,
): CompositionalPreferenceMeaningBundle {
  const nodesById = new Map(bundle.members.map((node) => [node.nodeId, node]));
  const outgoing = new Map<string, typeof bundle.attachments>();
  for (const node of bundle.members) {
    checkNow(check);
    outgoing.set(node.nodeId, []);
  }
  for (const edge of bundle.attachments) {
    checkNow(check);
    outgoing.get(edge.ownerNodeId)?.push(edge);
  }

  const paths = new Map<string, GraphPath>();
  const pending: PendingNode[] = [];
  const rootPaths = bundle.rootNodeIds.map((nodeId, index) => {
    checkNow(check);
    const path = `p${index}`;
    paths.set(nodeId, path);
    pending.push({ nodeId, path });
    return path;
  });

  let pendingIndex = 0;
  while (pendingIndex < pending.length) {
    checkNow(check);
    const current = pending[pendingIndex];
    pendingIndex += 1;
    if (!current) continue;
    const owner = nodesById.get(current.nodeId);
    if (!owner) throw new Error('Validated preference AST lost a referenced node');
    for (const edge of outgoing.get(current.nodeId) ?? []) {
      checkNow(check);
      if (edge.relation === 'all_of') continue;
      const segment = childSegment(edge, owner.kind);
      const childPath = `${current.path}.${segment}`;
      const knownPath = paths.get(edge.targetNodeId);
      if (knownPath !== undefined && knownPath !== childPath) {
        throw new Error('Validated preference AST has competing structural paths');
      }
      if (knownPath === undefined) {
        paths.set(edge.targetNodeId, childPath);
        pending.push({ nodeId: edge.targetNodeId, path: childPath });
      }
    }
  }

  if (paths.size !== bundle.members.length) {
    throw new Error('Validated preference AST contains unreachable nodes');
  }

  const projectedNodes = bundle.members.map((node) => {
    checkNow(check);
    const path = paths.get(node.nodeId);
    if (!path) throw new Error('Validated preference AST node has no structural path');
    return canonicalNode(node, path, paths);
  });
  projectedNodes.sort((left, right) => compareStrings(left.path, right.path));

  const projectedEdges: CompositionalPreferenceMeaningEdge[] = bundle.attachments.map((edge) => {
    checkNow(check);
    const ownerPath = paths.get(edge.ownerNodeId);
    const targetPath = paths.get(edge.targetNodeId);
    if (!ownerPath || !targetPath) throw new Error('Validated edge has no structural path');
    if (edge.relation === 'orders') {
      return { relation: edge.relation, ownerPath, targetPath, position: edge.position };
    }
    return { relation: edge.relation, ownerPath, targetPath } as CompositionalPreferenceMeaningEdge;
  });
  sortMeaningEdges(projectedEdges);

  return {
    relation: bundle.relation,
    coupling: bundle.coupling,
    rootPaths,
    nodes: projectedNodes,
    edges: projectedEdges,
  };
}

/**
 * Projects a validated source-bearing AST into an identity-bound, source-free
 * meaning graph. It establishes neither entailment nor acceptance authority.
 */
export function projectCompositionalPreferenceMeaning(
  input: CompositionalPreferenceMeaningProjectionInput,
): CompositionalPreferenceMeaningProjectionResult {
  const inputShape = CompositionalPreferenceMeaningProjectionInputSchema.safeParse(input);
  if (!inputShape.success) return failed('invalid_ast_integrity');
  const supplied = inputShape.data;
  checkNow(supplied.check);

  let preferenceSnapshot: unknown;
  try {
    preferenceSnapshot = snapshotBoundedCompositionalJson(supplied.preference, 32768);
  } catch {
    preferenceSnapshot = undefined;
  }
  if (preferenceSnapshot === undefined) return failed('metadata_too_large');
  checkNow(supplied.check);

  const preflightReason = preflightAst(preferenceSnapshot, supplied.check);
  if (preflightReason) return failed(preflightReason);
  checkNow(supplied.check);

  const parsed = CompositionalPreferenceSchema.safeParse(preferenceSnapshot);
  if (!parsed.success) {
    return failed(
      parsed.error.issues.some((issue) => issue.message.includes('32 KiB'))
        ? 'metadata_too_large'
        : 'invalid_ast_integrity',
    );
  }

  const bundles: CompositionalPreferenceMeaningBundle[] = [];
  for (const bundle of parsed.data.bundles) {
    checkNow(supplied.check);
    bundles.push(
      canonicalizeConjunctionPaths(projectBundle(bundle, supplied.check), supplied.check),
    );
  }

  // Independent bundles form an unordered set. Sorting their complete
  // canonical subtrees removes source order without flattening allOf topology.
  bundles.sort((left, right) => compareStrings(JSON.stringify(left), JSON.stringify(right)));

  const meaningCandidate = {
    version: 1 as const,
    descriptor: parsed.data.descriptor,
    namespace: supplied.namespace,
    subjectId: supplied.subjectId,
    bundles,
  };
  const meaning = CompositionalPreferenceMeaningSchema.parse(meaningCandidate);
  const canonicalJson = JSON.stringify(meaning);
  if (Buffer.byteLength(canonicalJson, 'utf8') > 32 * 1024) {
    return failed('metadata_too_large');
  }
  const fingerprint = createHash('sha256').update(canonicalJson, 'utf8').digest('hex');
  checkNow(supplied.check);
  return CompositionalPreferenceMeaningProjectionResultSchema.parse({
    ok: true,
    meaning,
    canonicalJson,
    fingerprint,
  });
}
