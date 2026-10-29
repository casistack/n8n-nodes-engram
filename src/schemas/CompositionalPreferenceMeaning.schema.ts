import { createHash } from 'crypto';
import { z } from 'zod';
import {
  CompositionalPreferenceDescriptorSchema,
  CompositionalPreferenceReasonSchema,
  snapshotBoundedCompositionalJson,
} from './CompositionalPreference.schema';

const MeaningPathSchema = z
  .string()
  .max(128)
  .regex(
    /^p(?:0|[1-9][0-9]{0,1})(?:\.(?:target|modifier|language|presentation|ordering|first|second|language_use|qualifier|count|quantifier|frequency|condition|scope))*$/,
  );

const MeaningPreferenceNodeSchema = z
  .object({
    path: MeaningPathSchema,
    kind: z.literal('preference'),
    operator: z.enum(['prefer', 'like', 'dislike']),
    polarity: z.enum(['affirmed', 'negated']),
    negation: z.enum(['none', 'negative']),
    targetPath: MeaningPathSchema,
  })
  .strict()
  .superRefine((node, context) => {
    if (
      (node.polarity === 'affirmed' && node.negation !== 'none') ||
      (node.polarity === 'negated' && node.negation !== 'negative') ||
      (node.polarity === 'negated' && node.operator === 'dislike')
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['negation'],
        message: 'Meaning operator and negation must follow the reviewed matrix',
      });
    }
  });

const MEANING_LANGUAGE_TAG_BY_PAIR: Record<string, string> = {
  'English:': 'en',
  'English:British': 'en-GB',
  'English:American': 'en-US',
  'English:Australian': 'en-AU',
  'French:': 'fr',
  'French:Canadian': 'fr-CA',
  'Swahili:': 'sw',
  'Swahili:Kenyan': 'sw-KE',
  'Spanish:': 'es',
};

const MeaningLanguageNodeSchema = z
  .object({
    path: MeaningPathSchema,
    kind: z.literal('language'),
    base: z.enum(['English', 'French', 'Swahili', 'Spanish']),
    region: z.enum(['British', 'American', 'Australian', 'Canadian', 'Kenyan']).optional(),
    languageTag: z.enum(['en', 'en-GB', 'en-US', 'en-AU', 'fr', 'fr-CA', 'sw', 'sw-KE', 'es']),
  })
  .strict()
  .superRefine((node, context) => {
    if (MEANING_LANGUAGE_TAG_BY_PAIR[`${node.base}:${node.region ?? ''}`] !== node.languageTag) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['languageTag'],
        message: 'Language tag must match the explicit reviewed base and region pair',
      });
    }
  });

const MeaningOutputNodeSchema = z
  .object({
    path: MeaningPathSchema,
    kind: z.literal('output'),
    value: z.enum(['explanation', 'answer', 'response']),
  })
  .strict();

const MeaningPresentationNodeSchema = z
  .object({
    path: MeaningPathSchema,
    kind: z.literal('presentation'),
    value: z.enum(['bullets', 'numbered_steps', 'prose', 'table']),
  })
  .strict();

const MeaningActionNodeSchema = z
  .object({
    path: MeaningPathSchema,
    kind: z.literal('action'),
    value: z.enum(['examples', 'terminology', 'definitions', 'steps']),
  })
  .strict();

const MeaningOrderingNodeSchema = z
  .object({
    path: MeaningPathSchema,
    kind: z.literal('ordering'),
    relation: z.enum(['before', 'followed_by', 'first_then', 'start_with_then']),
  })
  .strict();

const MeaningLanguageUseNodeSchema = z
  .object({ path: MeaningPathSchema, kind: z.literal('language_use'), value: z.literal('plain') })
  .strict();

const MeaningActionQualifierNodeSchema = z
  .object({
    path: MeaningPathSchema,
    kind: z.literal('action_qualifier'),
    value: z.enum(['worked', 'practical', 'technical']),
  })
  .strict();

const MeaningStyleNodeSchema = z
  .object({
    path: MeaningPathSchema,
    kind: z.literal('style'),
    value: z.literal('plain_language'),
  })
  .strict();

const MeaningLengthNodeSchema = z
  .object({
    path: MeaningPathSchema,
    kind: z.literal('length'),
    value: z.enum(['concise', 'brief', 'short', 'long']),
  })
  .strict();

const MeaningDetailNodeSchema = z
  .object({
    path: MeaningPathSchema,
    kind: z.literal('detail'),
    value: z.enum(['detailed', 'high_level']),
  })
  .strict();

const MeaningRegisterNodeSchema = z
  .object({
    path: MeaningPathSchema,
    kind: z.literal('register'),
    value: z.enum(['formal', 'informal']),
  })
  .strict();

const MeaningCountNodeSchema = z
  .object({
    path: MeaningPathSchema,
    kind: z.literal('count'),
    value: z.literal(1),
    mode: z.enum(['as_stated', 'only', 'exactly']),
  })
  .strict();

const MeaningQuantifierNodeSchema = z
  .object({ path: MeaningPathSchema, kind: z.literal('quantifier'), value: z.literal('any') })
  .strict();

const MeaningFrequencyNodeSchema = z
  .object({ path: MeaningPathSchema, kind: z.literal('frequency'), value: z.literal('usually') })
  .strict();

const MeaningConditionNodeSchema = z
  .object({ path: MeaningPathSchema, kind: z.literal('condition'), value: z.literal('on_request') })
  .strict();

const MeaningTaskScopeNodeSchema = z
  .object({
    path: MeaningPathSchema,
    kind: z.literal('task_scope'),
    value: z.enum(['code_review', 'worked_calculation', 'summary', 'planning']),
  })
  .strict();

export const CompositionalPreferenceMeaningNodeSchema = z.union([
  MeaningPreferenceNodeSchema,
  MeaningLanguageNodeSchema,
  MeaningOutputNodeSchema,
  MeaningPresentationNodeSchema,
  MeaningActionNodeSchema,
  MeaningOrderingNodeSchema,
  MeaningLanguageUseNodeSchema,
  MeaningActionQualifierNodeSchema,
  MeaningStyleNodeSchema,
  MeaningLengthNodeSchema,
  MeaningDetailNodeSchema,
  MeaningRegisterNodeSchema,
  MeaningCountNodeSchema,
  MeaningQuantifierNodeSchema,
  MeaningFrequencyNodeSchema,
  MeaningConditionNodeSchema,
  MeaningTaskScopeNodeSchema,
]);
export type CompositionalPreferenceMeaningNode = z.infer<
  typeof CompositionalPreferenceMeaningNodeSchema
>;

const MeaningEdgeBase = {
  ownerPath: MeaningPathSchema,
  targetPath: MeaningPathSchema,
};

export const CompositionalPreferenceMeaningEdgeSchema = z.discriminatedUnion('relation', [
  z.object({ ...MeaningEdgeBase, relation: z.literal('targets') }).strict(),
  z.object({ ...MeaningEdgeBase, relation: z.literal('all_of') }).strict(),
  z.object({ ...MeaningEdgeBase, relation: z.literal('language_of') }).strict(),
  z.object({ ...MeaningEdgeBase, relation: z.literal('presents') }).strict(),
  z.object({ ...MeaningEdgeBase, relation: z.literal('has_ordering') }).strict(),
  z.object({ ...MeaningEdgeBase, relation: z.literal('modifies') }).strict(),
  z.object({ ...MeaningEdgeBase, relation: z.literal('qualifies') }).strict(),
  z.object({ ...MeaningEdgeBase, relation: z.literal('counts') }).strict(),
  z.object({ ...MeaningEdgeBase, relation: z.literal('quantifies') }).strict(),
  z.object({ ...MeaningEdgeBase, relation: z.literal('frequency') }).strict(),
  z.object({ ...MeaningEdgeBase, relation: z.literal('conditions') }).strict(),
  z.object({ ...MeaningEdgeBase, relation: z.literal('scopes') }).strict(),
  z
    .object({
      ...MeaningEdgeBase,
      relation: z.literal('orders'),
      position: z.enum(['first', 'second']),
    })
    .strict(),
]);
export type CompositionalPreferenceMeaningEdge = z.infer<
  typeof CompositionalPreferenceMeaningEdgeSchema
>;

function meaningEdgeAllowed(
  owner: CompositionalPreferenceMeaningNode,
  target: CompositionalPreferenceMeaningNode,
  edge: CompositionalPreferenceMeaningEdge,
): boolean {
  switch (edge.relation) {
    case 'targets':
      return (
        owner.kind === 'preference' &&
        ['language', 'output', 'presentation', 'action', 'ordering'].includes(target.kind)
      );
    case 'all_of':
      return owner.kind === 'preference' && target.kind === 'preference';
    case 'language_of':
      return owner.kind === 'output' && target.kind === 'language';
    case 'presents':
      return owner.kind === 'output' && target.kind === 'presentation';
    case 'has_ordering':
      return owner.kind === 'output' && target.kind === 'ordering';
    case 'modifies':
      return (
        owner.kind === 'output' && ['style', 'length', 'detail', 'register'].includes(target.kind)
      );
    case 'qualifies':
      return (
        (owner.kind === 'language' && target.kind === 'language_use') ||
        (owner.kind === 'action' && target.kind === 'action_qualifier')
      );
    case 'counts':
      return owner.kind === 'action' && owner.value === 'examples' && target.kind === 'count';
    case 'quantifies':
      return owner.kind === 'action' && target.kind === 'quantifier';
    case 'frequency':
      return owner.kind === 'preference' && target.kind === 'frequency';
    case 'conditions':
      return (
        (owner.kind === 'preference' || owner.kind === 'action') && target.kind === 'condition'
      );
    case 'scopes':
      return owner.kind === 'preference' && target.kind === 'task_scope';
    case 'orders':
      return owner.kind === 'ordering' && target.kind === 'action';
  }
}

function meaningChildSegment(
  edge: CompositionalPreferenceMeaningEdge,
  ownerKind: CompositionalPreferenceMeaningNode['kind'],
): string {
  if (edge.relation === 'all_of') return '';
  if (edge.relation === 'orders') return edge.position === 'first' ? 'first' : 'second';
  if (edge.relation === 'targets') return 'target';
  if (edge.relation === 'language_of') return 'language';
  if (edge.relation === 'presents') return 'presentation';
  if (edge.relation === 'has_ordering') return 'ordering';
  if (edge.relation === 'modifies') return 'modifier';
  if (edge.relation === 'qualifies') return ownerKind === 'language' ? 'language_use' : 'qualifier';
  if (edge.relation === 'counts') return 'count';
  if (edge.relation === 'quantifies') return 'quantifier';
  if (edge.relation === 'frequency') return 'frequency';
  if (edge.relation === 'conditions') return 'condition';
  return 'scope';
}

const CompositionalPreferenceMeaningBundleSchema = z
  .object({
    relation: z.enum(['single', 'allOf']),
    coupling: z.enum(['independent', 'coupled']),
    rootPaths: z.array(MeaningPathSchema).min(1).max(32),
    nodes: z.array(CompositionalPreferenceMeaningNodeSchema).min(1).max(128),
    edges: z.array(CompositionalPreferenceMeaningEdgeSchema).max(128),
  })
  .strict()
  .superRefine((bundle, context) => {
    const nodes = new Map(bundle.nodes.map((node) => [node.path, node]));
    const incoming = new Map(bundle.nodes.map((node) => [node.path, [] as string[]]));
    const edgesByOwner = new Map(
      bundle.nodes.map((node) => [node.path, [] as typeof bundle.edges]),
    );
    if (nodes.size !== bundle.nodes.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['nodes'],
        message: 'Duplicate meaning path',
      });
    }
    if (new Set(bundle.rootPaths).size !== bundle.rootPaths.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['rootPaths'],
        message: 'Duplicate meaning root',
      });
    }
    if (
      bundle.rootPaths.some((path) => nodes.get(path)?.kind !== 'preference') ||
      bundle.rootPaths.length !== bundle.nodes.filter((node) => node.kind === 'preference').length
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['rootPaths'],
        message: 'Every preference meaning node must be a declared root',
      });
    }
    for (const [index, rootPath] of bundle.rootPaths.entries()) {
      if (rootPath !== `p${index}`) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['rootPaths', index],
          message: 'Preference paths must use deterministic root positions',
        });
      }
    }
    if (bundle.relation === 'single' && bundle.rootPaths.length !== 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['rootPaths'],
        message: 'A single meaning bundle has one root',
      });
    }
    if (
      bundle.relation === 'allOf' &&
      (bundle.rootPaths.length < 2 || bundle.coupling !== 'coupled')
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['relation'],
        message: 'An allOf meaning bundle is coupled and has multiple roots',
      });
    }
    if (bundle.nodes.some((node) => node.kind === 'ordering') && bundle.coupling !== 'coupled') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['coupling'],
        message: 'Ordering meaning bundles are internally coupled',
      });
    }

    const adjacency = new Map(bundle.nodes.map((node) => [node.path, [] as string[]]));
    const edgeKeys = new Set<string>();
    for (const [index, edge] of bundle.edges.entries()) {
      const owner = nodes.get(edge.ownerPath);
      const target = nodes.get(edge.targetPath);
      if (!owner || !target) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['edges', index],
          message: 'Meaning edge paths must resolve inside their bundle',
        });
        continue;
      }
      const edgeKey = `${edge.relation}:${edge.ownerPath}:${edge.targetPath}:${
        edge.relation === 'orders' ? edge.position : ''
      }`;
      if (edgeKeys.has(edgeKey)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['edges', index],
          message: 'Duplicate meaning edge',
        });
      }
      edgeKeys.add(edgeKey);
      if (!meaningEdgeAllowed(owner, target, edge)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['edges', index],
          message: 'Meaning edge owner and target kinds are not approved',
        });
      }
      if (edge.relation === 'all_of') {
        if (
          !bundle.rootPaths.includes(edge.ownerPath) ||
          !bundle.rootPaths.includes(edge.targetPath)
        ) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['edges', index],
            message: 'Conjunction edges connect declared roots only',
          });
        }
      } else {
        const segment = meaningChildSegment(edge, owner.kind);
        if (edge.targetPath !== `${edge.ownerPath}.${segment}`) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['edges', index, 'targetPath'],
            message: 'Meaning target paths must reflect their typed owner edge',
          });
        }
      }
      adjacency.get(edge.ownerPath)?.push(edge.targetPath);
      incoming.get(edge.targetPath)?.push(edge.relation);
      edgesByOwner.get(edge.ownerPath)?.push(edge);
    }
    for (const node of bundle.nodes) {
      const nodeIncoming = incoming.get(node.path) ?? [];
      const ownerEdges = edgesByOwner.get(node.path) ?? [];
      if (node.kind === 'preference') {
        if (
          !nodes.has(node.targetPath) ||
          node.targetPath !== `${node.path}.target` ||
          !ownerEdges.some(
            (edge) => edge.relation === 'targets' && edge.targetPath === node.targetPath,
          )
        ) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['nodes'],
            message: 'Preference target path and targets edge must match',
          });
        }
        const allOfCount = nodeIncoming.filter((relation) => relation === 'all_of').length;
        const rootIndex = bundle.rootPaths.indexOf(node.path);
        if (
          (bundle.relation === 'single' && allOfCount !== 0) ||
          (bundle.relation === 'allOf' && allOfCount !== (rootIndex === 0 ? 0 : 1))
        ) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['nodes'],
            message: 'Preference roots must follow declared conjunction topology',
          });
        }
      }
      if (['language', 'output', 'presentation', 'action', 'ordering'].includes(node.kind)) {
        const owners = nodeIncoming.filter((relation) =>
          ['targets', 'language_of', 'presents', 'has_ordering', 'orders'].includes(relation),
        );
        if (owners.length !== 1) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['nodes'],
            message: 'Every target meaning node must have exactly one owner',
          });
        }
      }
      if (
        [
          'language_use',
          'action_qualifier',
          'style',
          'length',
          'detail',
          'register',
          'count',
          'quantifier',
          'frequency',
          'condition',
          'task_scope',
        ].includes(node.kind) &&
        nodeIncoming.length !== 1
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['nodes'],
          message: 'Every modifier meaning node must have exactly one owner',
        });
      }
      if (node.kind === 'ordering') {
        const orders = ownerEdges.filter((edge) => edge.relation === 'orders');
        if (
          orders.length !== 2 ||
          orders.filter((edge) => edge.relation === 'orders' && edge.position === 'first')
            .length !== 1 ||
          orders.filter((edge) => edge.relation === 'orders' && edge.position === 'second')
            .length !== 1
        ) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['nodes'],
            message: 'Ordering requires exactly two positioned action operands',
          });
        }
      }
      if (node.kind === 'action') {
        const countEdges = ownerEdges.filter((edge) => edge.relation === 'counts');
        const quantifierEdges = ownerEdges.filter((edge) => edge.relation === 'quantifies');
        const qualifierEdges = ownerEdges.filter((edge) => edge.relation === 'qualifies');
        if (
          countEdges.length > 1 ||
          quantifierEdges.length > 1 ||
          qualifierEdges.length > 1 ||
          (countEdges.length > 0 && quantifierEdges.length > 0) ||
          (countEdges.length > 0 && node.value !== 'examples')
        ) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['nodes'],
            message: 'Action modifiers must follow the approved owner combinations',
          });
        }
        const qualifiers = qualifierEdges.map((edge) => nodes.get(edge.targetPath));
        if (
          qualifiers.some(
            (qualifier) =>
              qualifier?.kind !== 'action_qualifier' ||
              ((qualifier.value === 'worked' || qualifier.value === 'practical') &&
                node.value !== 'examples') ||
              (qualifier.value === 'technical' &&
                node.value !== 'terminology' &&
                node.value !== 'definitions'),
          )
        ) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['nodes'],
            message: 'Action qualifier owner is not approved',
          });
        }
      }
    }

    if (bundle.relation === 'single' && bundle.edges.some((edge) => edge.relation === 'all_of')) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['edges'],
        message: 'Single meaning bundles cannot contain conjunction edges',
      });
    }
    if (bundle.relation === 'allOf') {
      const allOfEdges = bundle.edges.filter((edge) => edge.relation === 'all_of');
      if (allOfEdges.length !== bundle.rootPaths.length - 1) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['edges'],
          message: 'allOf meaning roots require explicit dependency topology',
        });
      }
      const rootIncoming = new Map(bundle.rootPaths.map((path) => [path, 0]));
      for (const edge of allOfEdges) {
        rootIncoming.set(edge.targetPath, (rootIncoming.get(edge.targetPath) ?? 0) + 1);
      }
      for (const [index, path] of bundle.rootPaths.entries()) {
        if ((rootIncoming.get(path) ?? 0) !== (index === 0 ? 0 : 1)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['rootPaths', index],
            message: 'allOf roots require one explicit owner after the first root',
          });
        }
      }
    }

    const visitState = new Map<string, 'visiting' | 'done'>();
    const longestFrom = new Map<string, number>();
    const reached = new Set<string>();
    let cycleDetected = false;
    let depthExceeded = false;
    const visit = (path: string, depth: number): number => {
      if (cycleDetected || depthExceeded) return 0;
      if (depth > 8) {
        depthExceeded = true;
        return 0;
      }
      const prior = visitState.get(path);
      if (prior === 'visiting') {
        cycleDetected = true;
        return 0;
      }
      if (prior === 'done') {
        const height = longestFrom.get(path) ?? 1;
        if (depth + height - 1 > 8) depthExceeded = true;
        return height;
      }
      reached.add(path);
      visitState.set(path, 'visiting');
      let height = 1;
      for (const child of adjacency.get(path) ?? []) {
        if (cycleDetected || depthExceeded) break;
        height = Math.max(height, visit(child, depth + 1) + 1);
      }
      if (cycleDetected || depthExceeded) return height;
      visitState.set(path, 'done');
      longestFrom.set(path, height);
      return height;
    };
    for (const path of bundle.rootPaths) {
      if (cycleDetected || depthExceeded) break;
      visit(path, 1);
    }
    if (cycleDetected) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['edges'],
        message: 'Meaning attachment graph must be acyclic',
      });
    }
    if (depthExceeded) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['edges'],
        message: 'Meaning attachment depth cannot exceed eight nodes',
      });
    }
    if (!cycleDetected && !depthExceeded && reached.size !== bundle.nodes.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['nodes'],
        message: 'Every meaning node must be reachable from a preference root',
      });
    }
  });
export type CompositionalPreferenceMeaningBundle = z.infer<
  typeof CompositionalPreferenceMeaningBundleSchema
>;

const CompositionalPreferenceMeaningBaseSchema = z
  .object({
    version: z.literal(1),
    descriptor: CompositionalPreferenceDescriptorSchema,
    namespace: z
      .string()
      .min(1)
      .max(128)
      .refine((value) => value.trim().length > 0),
    subjectId: z.string().uuid(),
    bundles: z.array(CompositionalPreferenceMeaningBundleSchema).max(32),
  })
  .strict()
  .superRefine((meaning, context) => {
    let nodeCount = 0;
    let preferenceCount = 0;
    let edgeCount = 0;
    for (const [index, bundle] of meaning.bundles.entries()) {
      nodeCount += bundle.nodes.length;
      edgeCount += bundle.edges.length;
      preferenceCount += bundle.rootPaths.length;
      if (
        bundle.nodes.some((node) => node.kind === 'preference') &&
        bundle.relation !== 'allOf' &&
        bundle.rootPaths.length !== 1
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['bundles', index, 'rootPaths'],
          message: 'Single bundles have one preference root',
        });
      }
    }
    if (nodeCount > 128) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['bundles'],
        message: 'Meaning node limit is 128',
      });
    }
    if (preferenceCount > 32) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['bundles'],
        message: 'Meaning predicate limit is 32',
      });
    }
    if (edgeCount > 128) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['bundles'],
        message: 'Meaning edge limit is 128',
      });
    }
  });

const CompositionalPreferenceMeaningPreflightSchema = z
  .unknown()
  .transform((value, context) => {
    let snapshot: unknown;
    try {
      snapshot = snapshotBoundedCompositionalJson(value, 32768);
    } catch {
      snapshot = undefined;
    }
    if (snapshot === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Meaning exceeds bounded plain-JSON admission',
      });
      return z.NEVER;
    }
    return snapshot;
  })
  .superRefine((value, context) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Meaning must be an object' });
      return;
    }
    const bundles = (value as { bundles?: unknown }).bundles;
    if (!Array.isArray(bundles)) return;
    if (bundles.length > 32) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['bundles'],
        message: 'Meaning bundle limit is 32',
      });
      return;
    }
    let nodeCount = 0;
    let predicateCount = 0;
    let edgeCount = 0;
    for (const [index, bundle] of bundles.entries()) {
      if (bundle === null || typeof bundle !== 'object' || Array.isArray(bundle)) continue;
      const candidate = bundle as { nodes?: unknown; edges?: unknown; rootPaths?: unknown };
      if (!Array.isArray(candidate.nodes) || !Array.isArray(candidate.edges)) continue;
      nodeCount += candidate.nodes.length;
      edgeCount += candidate.edges.length;
      if (nodeCount > 128 || edgeCount > 128) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['bundles', index],
          message: 'Meaning node or edge limit is 128',
        });
        return;
      }
      for (const node of candidate.nodes) {
        if (
          node !== null &&
          typeof node === 'object' &&
          !Array.isArray(node) &&
          (node as { kind?: unknown }).kind === 'preference'
        ) {
          predicateCount += 1;
        }
      }
      if (predicateCount > 32) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['bundles', index, 'nodes'],
          message: 'Meaning preference-predicate limit is 32',
        });
        return;
      }
    }
    // `value` is the bounded plain-JSON snapshot produced above. Serializing it
    // here cannot invoke caller getters or unbounded `toJSON` hooks.
    const serialized = JSON.stringify(value);
    if (typeof serialized !== 'string' || Buffer.byteLength(serialized, 'utf8') > 32 * 1024) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Compositional meaning metadata must not exceed 32 KiB serialized',
      });
    }
  });

export const CompositionalPreferenceMeaningSchema =
  CompositionalPreferenceMeaningPreflightSchema.pipe(CompositionalPreferenceMeaningBaseSchema);
export type CompositionalPreferenceMeaning = z.infer<typeof CompositionalPreferenceMeaningSchema>;

export const CompositionalPreferenceInterpretationInputSchema = z
  .object({
    descriptor: CompositionalPreferenceDescriptorSchema,
    rawContent: z.string(),
    mappedContent: z.string(),
    envelope: z.unknown(),
    check: z.function().args().returns(z.void()).optional(),
  })
  .strict();
export type CompositionalPreferenceInterpretationInput = z.infer<
  typeof CompositionalPreferenceInterpretationInputSchema
>;

export const CompositionalPreferenceMeaningProjectionInputSchema = z
  .object({
    preference: z.unknown(),
    namespace: z
      .string()
      .min(1)
      .max(128)
      .refine((value) => value.trim().length > 0),
    subjectId: z.string().uuid(),
    check: z.function().args().returns(z.void()).optional(),
  })
  .strict();
export type CompositionalPreferenceMeaningProjectionInput = z.infer<
  typeof CompositionalPreferenceMeaningProjectionInputSchema
>;

const CompositionalPreferenceMeaningProjectionSuccessSchema = z
  .object({
    ok: z.literal(true),
    meaning: CompositionalPreferenceMeaningSchema,
    canonicalJson: z.string().max(32 * 1024),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
  .superRefine((projection, context) => {
    const canonicalJson = JSON.stringify(projection.meaning);
    const fingerprint = createHash('sha256').update(canonicalJson, 'utf8').digest('hex');
    if (projection.canonicalJson !== canonicalJson || projection.fingerprint !== fingerprint) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['canonicalJson'],
        message: 'Projection bytes and fingerprint must match the typed meaning',
      });
    }
  });

export const CompositionalPreferenceMeaningProjectionResultSchema = z.union([
  CompositionalPreferenceMeaningProjectionSuccessSchema,
  z.object({ ok: z.literal(false), reason: CompositionalPreferenceReasonSchema }).strict(),
]);
export type CompositionalPreferenceMeaningProjectionResult = z.infer<
  typeof CompositionalPreferenceMeaningProjectionResultSchema
>;
