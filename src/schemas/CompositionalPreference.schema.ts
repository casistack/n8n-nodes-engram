import { createHash } from 'crypto';
import { z } from 'zod';
import { AutomaticSourceEnvelopeSchema } from './AutomaticMemory.schema';

/**
 * Structural contract for the reviewed compositional-preferences v1 AST.
 * Passing these schemas proves only bounded shape, references, and evidence
 * mapping. It does not prove that source text entails the represented meaning,
 * establish speaker intent, or authorize acceptance or storage.
 */

export const COMPOSITIONAL_PREFERENCE_DESCRIPTOR = Object.freeze({
  interpreterId: 'compositional-preferences' as const,
  semanticVersion: 1 as const,
  grammarVersion: 1 as const,
  lexiconVersion: 1 as const,
});

export const CompositionalPreferenceDescriptorSchema = z
  .object({
    interpreterId: z.literal('compositional-preferences'),
    semanticVersion: z.literal(1),
    grammarVersion: z.literal(1),
    lexiconVersion: z.literal(1),
  })
  .strict();
export type CompositionalPreferenceDescriptor = z.infer<
  typeof CompositionalPreferenceDescriptorSchema
>;

export const CompositionalRegionSchema = z
  .object({
    start: z.number().int().min(0).max(65536),
    end: z.number().int().min(1).max(65536),
  })
  .strict()
  .refine((region) => region.start < region.end, 'Region must be non-empty');
export type CompositionalRegion = z.infer<typeof CompositionalRegionSchema>;

export const CompositionalEvidenceSpanSchema = z
  .object({
    content: CompositionalRegionSchema,
    raw: CompositionalRegionSchema,
  })
  .strict()
  .refine(
    (span) => span.content.end - span.content.start === span.raw.end - span.raw.start,
    'Mapped evidence spans must have equal UTF-16 lengths',
  );
export type CompositionalEvidenceSpan = z.infer<typeof CompositionalEvidenceSpanSchema>;

export const CompositionalPreferenceEvidenceSchema = z
  .object({
    descriptor: CompositionalPreferenceDescriptorSchema,
    spans: z.array(CompositionalEvidenceSpanSchema).min(1).max(4),
    lexicalForm: z
      .string()
      .min(1)
      .max(8192)
      .refine((value) => Array.from(value).length <= 2048, 'Evidence exceeds 2048 code points')
      .refine(
        (value) => Buffer.byteLength(value, 'utf8') <= 4096,
        'Evidence exceeds the 4096-byte clause limit',
      ),
  })
  .strict()
  .superRefine((evidence, context) => {
    let previousContentEnd = -1;
    let previousRawEnd = -1;
    for (const [index, span] of evidence.spans.entries()) {
      if (span.content.start < previousContentEnd || span.raw.start < previousRawEnd) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['spans', index],
          message: 'Evidence spans must be ascending and disjoint',
        });
      }
      previousContentEnd = span.content.end;
      previousRawEnd = span.raw.end;
    }
  });
export type CompositionalPreferenceEvidence = z.infer<typeof CompositionalPreferenceEvidenceSchema>;

const OpaqueNodeIdSchema = z.string().regex(/^n_[a-f0-9]{16,64}$/);
const OpaqueBundleIdSchema = z.string().regex(/^b_[a-f0-9]{16,64}$/);

export const CompositionalPreferenceOperatorSchema = z.enum(['prefer', 'like', 'dislike']);
export const CompositionalPreferencePolaritySchema = z.enum(['affirmed', 'negated']);
export const CompositionalPreferenceNegationSchema = z.enum(['none', 'do_not', 'dont']);

const PreferenceNodeSchema = z
  .object({
    nodeId: OpaqueNodeIdSchema,
    kind: z.literal('preference'),
    subject: z.literal('speaker'),
    operator: CompositionalPreferenceOperatorSchema,
    polarity: CompositionalPreferencePolaritySchema,
    negation: CompositionalPreferenceNegationSchema,
    targetNodeId: OpaqueNodeIdSchema,
    attachmentNodeIds: z.array(OpaqueNodeIdSchema).max(16),
    evidence: CompositionalPreferenceEvidenceSchema,
  })
  .strict()
  .superRefine((node, context) => {
    if (node.polarity === 'affirmed' && node.negation !== 'none') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['negation'],
        message: 'Affirmed predicates cannot carry a negation form',
      });
    }
    if (node.polarity === 'negated' && node.negation === 'none') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['negation'],
        message: 'Negated predicates require an explicit reviewed negation form',
      });
    }
    if (node.polarity === 'negated' && node.operator === 'dislike') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['operator'],
        message: 'The reviewed grammar permits negated prefer and like only',
      });
    }
    if (new Set(node.attachmentNodeIds).size !== node.attachmentNodeIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['attachmentNodeIds'],
        message: 'Preference attachment references must be unique',
      });
    }
  });

const LANGUAGE_TAG_BY_PAIR: Record<string, string> = {
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

const LanguageNodeSchema = z
  .object({
    nodeId: OpaqueNodeIdSchema,
    kind: z.literal('language'),
    base: z.enum(['English', 'French', 'Swahili', 'Spanish']),
    region: z.enum(['British', 'American', 'Australian', 'Canadian', 'Kenyan']).optional(),
    languageTag: z.enum(['en', 'en-GB', 'en-US', 'en-AU', 'fr', 'fr-CA', 'sw', 'sw-KE', 'es']),
    evidence: CompositionalPreferenceEvidenceSchema,
  })
  .strict()
  .superRefine((node, context) => {
    if (LANGUAGE_TAG_BY_PAIR[`${node.base}:${node.region ?? ''}`] !== node.languageTag) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['languageTag'],
        message: 'Language tag must match the explicit reviewed base and region pair',
      });
    }
  });

const OutputNodeSchema = z
  .object({
    nodeId: OpaqueNodeIdSchema,
    kind: z.literal('output'),
    value: z.enum(['explanation', 'answer', 'response']),
    evidence: CompositionalPreferenceEvidenceSchema,
  })
  .strict();

const PresentationNodeSchema = z
  .object({
    nodeId: OpaqueNodeIdSchema,
    kind: z.literal('presentation'),
    value: z.enum(['bullets', 'numbered_steps', 'prose', 'table']),
    evidence: CompositionalPreferenceEvidenceSchema,
  })
  .strict();

const ActionNodeSchema = z
  .object({
    nodeId: OpaqueNodeIdSchema,
    kind: z.literal('action'),
    value: z.enum(['examples', 'terminology', 'definitions', 'steps']),
    evidence: CompositionalPreferenceEvidenceSchema,
  })
  .strict();

const OrderingNodeSchema = z
  .object({
    nodeId: OpaqueNodeIdSchema,
    kind: z.literal('ordering'),
    relation: z.enum(['before', 'followed_by', 'first_then', 'start_with_then']),
    operandNodeIds: z.tuple([OpaqueNodeIdSchema, OpaqueNodeIdSchema]),
    evidence: CompositionalPreferenceEvidenceSchema,
  })
  .strict()
  .superRefine((node, context) => {
    if (node.operandNodeIds[0] === node.operandNodeIds[1]) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['operandNodeIds'],
        message: 'An ordering relation requires two distinct action operands',
      });
    }
  });

const LanguageUseNodeSchema = z
  .object({
    nodeId: OpaqueNodeIdSchema,
    kind: z.literal('language_use'),
    value: z.literal('plain'),
    targetNodeId: OpaqueNodeIdSchema,
    evidence: CompositionalPreferenceEvidenceSchema,
  })
  .strict();

const ActionQualifierNodeSchema = z
  .object({
    nodeId: OpaqueNodeIdSchema,
    kind: z.literal('action_qualifier'),
    value: z.enum(['worked', 'practical', 'technical']),
    targetNodeId: OpaqueNodeIdSchema,
    evidence: CompositionalPreferenceEvidenceSchema,
  })
  .strict();

const StyleNodeSchema = z
  .object({
    nodeId: OpaqueNodeIdSchema,
    kind: z.literal('style'),
    value: z.literal('plain_language'),
    evidence: CompositionalPreferenceEvidenceSchema,
  })
  .strict();

const LengthNodeSchema = z
  .object({
    nodeId: OpaqueNodeIdSchema,
    kind: z.literal('length'),
    value: z.enum(['concise', 'brief', 'short', 'long']),
    evidence: CompositionalPreferenceEvidenceSchema,
  })
  .strict();

const DetailNodeSchema = z
  .object({
    nodeId: OpaqueNodeIdSchema,
    kind: z.literal('detail'),
    value: z.enum(['detailed', 'high_level']),
    evidence: CompositionalPreferenceEvidenceSchema,
  })
  .strict();

const RegisterNodeSchema = z
  .object({
    nodeId: OpaqueNodeIdSchema,
    kind: z.literal('register'),
    value: z.enum(['formal', 'informal']),
    evidence: CompositionalPreferenceEvidenceSchema,
  })
  .strict();

const CountNodeSchema = z
  .object({
    nodeId: OpaqueNodeIdSchema,
    kind: z.literal('count'),
    value: z.literal(1),
    mode: z.enum(['as_stated', 'only', 'exactly']),
    evidence: CompositionalPreferenceEvidenceSchema,
  })
  .strict();

const QuantifierNodeSchema = z
  .object({
    nodeId: OpaqueNodeIdSchema,
    kind: z.literal('quantifier'),
    value: z.literal('any'),
    evidence: CompositionalPreferenceEvidenceSchema,
  })
  .strict();

const FrequencyNodeSchema = z
  .object({
    nodeId: OpaqueNodeIdSchema,
    kind: z.literal('frequency'),
    value: z.literal('usually'),
    evidence: CompositionalPreferenceEvidenceSchema,
  })
  .strict();

const ConditionNodeSchema = z
  .object({
    nodeId: OpaqueNodeIdSchema,
    kind: z.literal('condition'),
    value: z.literal('on_request'),
    evidence: CompositionalPreferenceEvidenceSchema,
  })
  .strict();

const TaskScopeNodeSchema = z
  .object({
    nodeId: OpaqueNodeIdSchema,
    kind: z.literal('task_scope'),
    value: z.enum(['code_review', 'worked_calculation', 'summary', 'planning']),
    evidence: CompositionalPreferenceEvidenceSchema,
  })
  .strict();

export const CompositionalPreferenceNodeSchema = z.union([
  PreferenceNodeSchema,
  LanguageNodeSchema,
  OutputNodeSchema,
  PresentationNodeSchema,
  ActionNodeSchema,
  OrderingNodeSchema,
  LanguageUseNodeSchema,
  ActionQualifierNodeSchema,
  StyleNodeSchema,
  LengthNodeSchema,
  DetailNodeSchema,
  RegisterNodeSchema,
  CountNodeSchema,
  QuantifierNodeSchema,
  FrequencyNodeSchema,
  ConditionNodeSchema,
  TaskScopeNodeSchema,
]);
export type CompositionalPreferenceNode = z.infer<typeof CompositionalPreferenceNodeSchema>;

const EdgeBase = {
  ownerNodeId: OpaqueNodeIdSchema,
  targetNodeId: OpaqueNodeIdSchema,
  evidence: CompositionalPreferenceEvidenceSchema,
};

export const CompositionalPreferenceEdgeSchema = z.discriminatedUnion('relation', [
  z.object({ ...EdgeBase, relation: z.literal('targets') }).strict(),
  z.object({ ...EdgeBase, relation: z.literal('all_of') }).strict(),
  z.object({ ...EdgeBase, relation: z.literal('language_of') }).strict(),
  z.object({ ...EdgeBase, relation: z.literal('presents') }).strict(),
  z.object({ ...EdgeBase, relation: z.literal('has_ordering') }).strict(),
  z.object({ ...EdgeBase, relation: z.literal('modifies') }).strict(),
  z.object({ ...EdgeBase, relation: z.literal('qualifies') }).strict(),
  z.object({ ...EdgeBase, relation: z.literal('counts') }).strict(),
  z.object({ ...EdgeBase, relation: z.literal('quantifies') }).strict(),
  z.object({ ...EdgeBase, relation: z.literal('frequency') }).strict(),
  z.object({ ...EdgeBase, relation: z.literal('conditions') }).strict(),
  z.object({ ...EdgeBase, relation: z.literal('scopes') }).strict(),
  z
    .object({
      ...EdgeBase,
      relation: z.literal('orders'),
      position: z.enum(['first', 'second']),
    })
    .strict(),
]);
export type CompositionalPreferenceEdge = z.infer<typeof CompositionalPreferenceEdgeSchema>;

const CompositionalPreferenceBundleBaseSchema = z
  .object({
    bundleId: OpaqueBundleIdSchema,
    relation: z.enum(['single', 'allOf']),
    coupling: z.enum(['independent', 'coupled']),
    rootNodeIds: z.array(OpaqueNodeIdSchema).min(1).max(32),
    members: z.array(CompositionalPreferenceNodeSchema).min(1).max(128),
    attachments: z.array(CompositionalPreferenceEdgeSchema).max(128),
    evidence: CompositionalPreferenceEvidenceSchema,
    coverage: z.enum(['complete', 'incomplete', 'unknown']),
  })
  .strict();
type BundleForValidation = z.infer<typeof CompositionalPreferenceBundleBaseSchema>;
export const CompositionalPreferenceBundleSchema =
  CompositionalPreferenceBundleBaseSchema.superRefine(validateBundleIntegrity);
export type CompositionalPreferenceBundle = z.infer<typeof CompositionalPreferenceBundleSchema>;

export const CompositionalPreferenceReasonSchema = z.enum([
  'invalid_envelope',
  'content_mismatch',
  'incomplete_mapping',
  'quoted_content',
  'reported_statement',
  'third_party',
  'question',
  'hypothetical',
  'instruction',
  'unsupported_grammar',
  'unsupported_operator',
  'unsupported_topic',
  'unsupported_scope',
  'sensitive_scope',
  'ambiguous_attachment',
  'mixed_clauses',
  'too_many_bundles',
  'too_many_nodes',
  'nesting_exceeded',
  'object_too_long',
  'clause_too_long',
  'source_too_large',
  'metadata_too_large',
  'invalid_unicode',
  'invalid_ast_integrity',
]);
export type CompositionalPreferenceReason = z.infer<typeof CompositionalPreferenceReasonSchema>;

const WithheldCompositionalPreferenceSchema = z
  .object({
    sourceRegion: CompositionalRegionSchema.optional(),
    reason: CompositionalPreferenceReasonSchema,
  })
  .strict();

const CompositionalPreferenceBaseSchema = z
  .object({
    version: z.literal(1),
    descriptor: CompositionalPreferenceDescriptorSchema,
    coverage: z.enum(['complete', 'partial', 'none', 'unknown']),
    bundles: z.array(CompositionalPreferenceBundleSchema).max(32),
    withheld: z.array(WithheldCompositionalPreferenceSchema).max(32),
    reasons: z.array(CompositionalPreferenceReasonSchema).max(16),
  })
  .strict();

const CompositionalPreferencePreflightSchema = z.unknown().transform((value, context) => {
  const reject = (path: (string | number)[], message: string) => {
    addIssue(context, path, message);
    return z.NEVER;
  };
  const ownValue = (object: object, key: string): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
  };
  const arrayLength = (array: unknown[]): number => ownValue(array, 'length') as number;
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return reject([], 'Compositional result must be an object');
    }
    const bundles = ownValue(value, 'bundles');
    if (Array.isArray(bundles)) {
      const length = arrayLength(bundles);
      if (length > 32) return reject(['bundles'], 'Bundle limit is 32');
      let nodes = 0,
        preferences = 0,
        edges = 0;
      for (let index = 0; index < length; index++) {
        const bundle = ownValue(bundles, String(index));
        if (bundle === null || typeof bundle !== 'object' || Array.isArray(bundle)) continue;
        const members = ownValue(bundle, 'members');
        const attachments = ownValue(bundle, 'attachments');
        if (Array.isArray(members)) {
          const memberCount = arrayLength(members);
          nodes += memberCount;
          if (nodes > 128) return reject(['bundles'], 'Global semantic-node limit is 128');
          for (let memberIndex = 0; memberIndex < memberCount; memberIndex++) {
            const member = ownValue(members, String(memberIndex));
            if (
              member !== null &&
              typeof member === 'object' &&
              !Array.isArray(member) &&
              ownValue(member, 'kind') === 'preference'
            )
              preferences++;
          }
        }
        if (Array.isArray(attachments)) edges += arrayLength(attachments);
        if (edges > 128) return reject(['bundles'], 'Global attachment-edge limit is 128');
        if (preferences > 32) return reject(['bundles'], 'Global preference-predicate limit is 32');
      }
    }
    const snapshot = snapshotBoundedCompositionalJson(value, 32768);
    if (snapshot === undefined)
      return reject([], 'Compositional AST metadata exceeds bounded plain JSON or 32 KiB limits');
    return snapshot;
  } catch {
    return reject([], 'Compositional result is not bounded plain JSON');
  }
});

export const CompositionalPreferenceSchema = CompositionalPreferencePreflightSchema.pipe(
  CompositionalPreferenceBaseSchema.superRefine(validatePreferenceResult),
);
export type CompositionalPreference = z.infer<typeof CompositionalPreferenceSchema>;

const MODIFIER_KINDS = new Set([
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
]);
const TARGET_KINDS = new Set(['language', 'output', 'presentation', 'action', 'ordering']);

function addIssue(context: z.RefinementCtx, path: (string | number)[], message: string): void {
  context.addIssue({ code: z.ZodIssueCode.custom, path, message });
}

function validateBundleIntegrity(bundle: BundleForValidation, context: z.RefinementCtx): void {
  const nodes = new Map(bundle.members.map((node) => [node.nodeId, node]));
  const prefs = bundle.members.filter((node) => node.kind === 'preference');
  const rootIds = bundle.rootNodeIds;
  const rootSet = new Set(rootIds);
  const edges = bundle.attachments;
  const adjacency = new Map<string, string[]>();
  const incoming = new Map<string, CompositionalPreferenceEdge[]>();
  const outgoing = new Map<string, CompositionalPreferenceEdge[]>();
  const edgeKeys = new Set<string>();
  const path = (index?: number) => (index === undefined ? [] : ['attachments', index]);

  if (new Set(rootIds).size !== rootIds.length) {
    addIssue(context, ['rootNodeIds'], 'Bundle roots must be unique');
  }
  if (new Set(bundle.members.map((node) => node.nodeId)).size !== bundle.members.length) {
    addIssue(context, ['members'], 'Node IDs must be unique within a bundle');
  }
  if (rootSet.size !== prefs.length || prefs.some((node) => !rootSet.has(node.nodeId))) {
    addIssue(context, ['rootNodeIds'], 'Every preference root must be declared exactly once');
  }
  if (rootIds.some((id) => nodes.get(id)?.kind !== 'preference')) {
    addIssue(context, ['rootNodeIds'], 'Bundle roots must reference preference nodes');
  }
  if (bundle.relation === 'single' && (rootIds.length !== 1 || prefs.length !== 1)) {
    addIssue(context, ['rootNodeIds'], 'A single bundle has exactly one preference root');
  }
  if (bundle.relation === 'allOf' && (rootIds.length < 2 || bundle.coupling !== 'coupled')) {
    addIssue(context, ['relation'], 'An allOf bundle requires coupled multiple preference roots');
  }
  if (bundle.members.some((node) => node.kind === 'ordering') && bundle.coupling !== 'coupled') {
    addIssue(context, ['coupling'], 'Ordering bundles are internally coupled in v1');
  }

  for (const node of bundle.members) {
    adjacency.set(node.nodeId, []);
    incoming.set(node.nodeId, []);
    outgoing.set(node.nodeId, []);
  }

  for (const [index, edge] of edges.entries()) {
    const owner = nodes.get(edge.ownerNodeId);
    const target = nodes.get(edge.targetNodeId);
    if (!owner || !target) {
      addIssue(context, path(index), 'Attachment references must resolve inside this bundle');
      continue;
    }
    const edgeKey = `${edge.relation}:${edge.ownerNodeId}:${edge.targetNodeId}:${
      edge.relation === 'orders' ? edge.position : ''
    }`;
    if (edgeKeys.has(edgeKey)) addIssue(context, path(index), 'Duplicate attachment edge');
    edgeKeys.add(edgeKey);
    adjacency.get(owner.nodeId)?.push(target.nodeId);
    incoming.get(target.nodeId)?.push(edge);
    outgoing.get(owner.nodeId)?.push(edge);

    if (!isAllowedEdge(owner, target, edge)) {
      addIssue(context, path(index), 'Attachment owner and target kinds are not approved');
    }
  }

  for (const node of bundle.members) {
    const nodeIncoming = incoming.get(node.nodeId) ?? [];
    const nodeOutgoing = outgoing.get(node.nodeId) ?? [];
    if (MODIFIER_KINDS.has(node.kind)) {
      if (nodeIncoming.length !== 1) {
        addIssue(
          context,
          ['members', bundle.members.indexOf(node)],
          'Every modifier must have exactly one typed owner',
        );
      }
      if (node.kind === 'language_use' || node.kind === 'action_qualifier') {
        if (nodeIncoming[0]?.ownerNodeId !== node.targetNodeId) {
          addIssue(
            context,
            ['members', bundle.members.indexOf(node), 'targetNodeId'],
            'Qualifier target must match its unique owner edge',
          );
        }
      }
    }
    if (TARGET_KINDS.has(node.kind)) {
      const ownershipEdges = nodeIncoming.filter((edge) =>
        ['targets', 'language_of', 'presents', 'has_ordering', 'orders'].includes(edge.relation),
      );
      if (ownershipEdges.length !== 1) {
        addIssue(
          context,
          ['members', bundle.members.indexOf(node)],
          'Every target must have exactly one approved owner',
        );
      }
    }
    if (node.kind === 'preference') {
      const conjunctionOwners = nodeIncoming.filter((edge) => edge.relation === 'all_of');
      const isFirstRoot = node.nodeId === rootIds[0];
      if (
        (isFirstRoot && conjunctionOwners.length !== 0) ||
        (!isFirstRoot && conjunctionOwners.length !== 1)
      ) {
        addIssue(
          context,
          ['members', bundle.members.indexOf(node)],
          'Preference roots must follow the declared allOf ownership topology',
        );
      }
    }
    if (node.kind === 'preference') {
      const targetEdges = nodeOutgoing.filter((edge) => edge.relation === 'targets');
      const directAttachments = nodeOutgoing
        .filter((edge) => ['frequency', 'conditions', 'scopes'].includes(edge.relation))
        .map((edge) => edge.targetNodeId)
        .sort();
      if (targetEdges.length !== 1 || targetEdges[0]?.targetNodeId !== node.targetNodeId) {
        addIssue(
          context,
          ['members', bundle.members.indexOf(node), 'targetNodeId'],
          'Preference target must have one matching typed target edge',
        );
      }
      if (
        directAttachments.length !== node.attachmentNodeIds.length ||
        directAttachments.some((id, index) => id !== [...node.attachmentNodeIds].sort()[index])
      ) {
        addIssue(
          context,
          ['members', bundle.members.indexOf(node), 'attachmentNodeIds'],
          'Direct preference attachments must match their typed edges',
        );
      }
    }
    if (node.kind === 'ordering') {
      const orderEdges = nodeOutgoing.filter((edge) => edge.relation === 'orders');
      const first = orderEdges.find(
        (edge) => edge.relation === 'orders' && edge.position === 'first',
      );
      const second = orderEdges.find(
        (edge) => edge.relation === 'orders' && edge.position === 'second',
      );
      if (
        orderEdges.length !== 2 ||
        first?.targetNodeId !== node.operandNodeIds[0] ||
        second?.targetNodeId !== node.operandNodeIds[1]
      ) {
        addIssue(
          context,
          ['members', bundle.members.indexOf(node), 'operandNodeIds'],
          'Ordering requires exactly two matching ordered action edges',
        );
      }
      const owners = nodeIncoming.filter(
        (edge) => edge.relation === 'targets' || edge.relation === 'has_ordering',
      );
      if (owners.length !== 1) {
        addIssue(
          context,
          ['members', bundle.members.indexOf(node)],
          'An ordering relation must have exactly one preference or output owner',
        );
      }
    }
  }

  for (const [index, edge] of edges.entries()) {
    if (edge.relation === 'all_of' && bundle.relation !== 'allOf') {
      addIssue(context, path(index), 'Conjunction edges require an allOf bundle');
    }
    if (edge.relation !== 'all_of' && edge.relation !== 'targets') continue;
    if (
      edge.relation === 'all_of' &&
      (!rootSet.has(edge.ownerNodeId) || !rootSet.has(edge.targetNodeId))
    ) {
      addIssue(context, path(index), 'Conjunction edges must connect declared preference roots');
    }
  }

  if (bundle.relation === 'allOf') {
    const conjunctionEdges = edges.filter((edge) => edge.relation === 'all_of');
    const root = rootIds[0];
    const rootIncoming = new Map(rootIds.map((id) => [id, 0]));
    const allOfAdjacency = new Map(rootIds.map((id) => [id, [] as string[]]));
    for (const edge of conjunctionEdges) {
      if (rootIncoming.has(edge.targetNodeId)) {
        rootIncoming.set(edge.targetNodeId, (rootIncoming.get(edge.targetNodeId) ?? 0) + 1);
      }
      allOfAdjacency.get(edge.ownerNodeId)?.push(edge.targetNodeId);
    }
    if (conjunctionEdges.length !== rootIds.length - 1) {
      addIssue(context, ['attachments'], 'allOf roots require explicit conjunction topology');
    }
    if ((rootIncoming.get(root) ?? 0) !== 0) {
      addIssue(context, ['attachments'], 'The first allOf root cannot have a conjunction parent');
    }
    for (const id of rootIds.slice(1)) {
      if (rootIncoming.get(id) !== 1) {
        addIssue(
          context,
          ['attachments'],
          'Each additional allOf root requires one conjunction owner',
        );
      }
    }
    const reachedRoots = new Set<string>();
    const visitRoot = (id: string) => {
      if (reachedRoots.has(id)) return;
      reachedRoots.add(id);
      for (const child of allOfAdjacency.get(id) ?? []) visitRoot(child);
    };
    if (root) visitRoot(root);
    if (reachedRoots.size !== rootIds.length) {
      addIssue(context, ['rootNodeIds'], 'Every allOf root must descend from the first root');
    }
  } else if (edges.some((edge) => edge.relation === 'all_of')) {
    addIssue(context, ['attachments'], 'Single bundles cannot contain conjunction edges');
  }

  validateModifierOwners(bundle, context, incoming, outgoing, nodes);
  validateOutputCombinations(bundle, context, nodes, outgoing);

  const rootId = rootIds[0];
  const state = new Map<string, 'visiting' | 'done'>();
  const longestDepthFrom = new Map<string, number>();
  const reached = new Set<string>();
  let cycleDetected = false;
  let depthExceeded = false;
  const visit = (id: string, depth: number): number => {
    if (cycleDetected || depthExceeded) return 0;
    if (depth > 8) {
      addIssue(context, ['attachments'], 'Semantic attachment depth cannot exceed eight nodes');
      depthExceeded = true;
      return 0;
    }
    const prior = state.get(id);
    if (prior === 'visiting') {
      addIssue(context, ['attachments'], 'Attachment graph must be acyclic');
      cycleDetected = true;
      return 0;
    }
    if (prior === 'done') {
      const longestDepth = longestDepthFrom.get(id) ?? 1;
      if (depth + longestDepth - 1 > 8) {
        addIssue(context, ['attachments'], 'Semantic attachment depth cannot exceed eight nodes');
        depthExceeded = true;
      }
      return longestDepth;
    }
    reached.add(id);
    state.set(id, 'visiting');
    let longestDepth = 1;
    for (const target of adjacency.get(id) ?? []) {
      if (cycleDetected || depthExceeded) break;
      longestDepth = Math.max(longestDepth, visit(target, depth + 1) + 1);
    }
    if (cycleDetected || depthExceeded) return longestDepth;
    state.set(id, 'done');
    longestDepthFrom.set(id, longestDepth);
    return longestDepth;
  };
  if (rootId) visit(rootId, 1);
  if (!cycleDetected && !depthExceeded && reached.size !== bundle.members.length) {
    addIssue(context, ['members'], 'Every semantic node must be reachable from the declared root');
  }
}

function isAllowedEdge(
  owner: CompositionalPreferenceNode,
  target: CompositionalPreferenceNode,
  edge: CompositionalPreferenceEdge,
): boolean {
  switch (edge.relation) {
    case 'targets':
      return owner.kind === 'preference' && TARGET_KINDS.has(target.kind);
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
    default:
      return false;
  }
}

function validateModifierOwners(
  bundle: BundleForValidation,
  context: z.RefinementCtx,
  incoming: Map<string, CompositionalPreferenceEdge[]>,
  outgoing: Map<string, CompositionalPreferenceEdge[]>,
  nodes: Map<string, CompositionalPreferenceNode>,
): void {
  const nodeIndex = new Map(bundle.members.map((node, index) => [node.nodeId, index]));
  for (const node of bundle.members) {
    const owners = incoming.get(node.nodeId) ?? [];
    const ownerEdge = owners[0];
    const owner = ownerEdge ? nodes.get(ownerEdge.ownerNodeId) : undefined;
    const issuePath = ['members', nodeIndex.get(node.nodeId) ?? 0];

    if (node.kind === 'language_use') {
      if (owner?.kind !== 'language' || owner.nodeId !== node.targetNodeId) {
        addIssue(
          context,
          [...issuePath, 'targetNodeId'],
          'Plain language use must qualify one language',
        );
      }
    } else if (node.kind === 'action_qualifier') {
      const allowedOwner =
        owner?.kind === 'action' &&
        owner.nodeId === node.targetNodeId &&
        (node.value === 'worked' || node.value === 'practical'
          ? owner.value === 'examples'
          : owner.value === 'terminology' || owner.value === 'definitions');
      if (!allowedOwner) {
        addIssue(
          context,
          [...issuePath, 'targetNodeId'],
          'Action qualifier has an unapproved owner',
        );
      }
    } else if (node.kind === 'count') {
      if (owner?.kind !== 'action' || owner.value !== 'examples') {
        addIssue(context, issuePath, 'Count applies only to an examples action');
      }
    } else if (node.kind === 'quantifier') {
      if (owner?.kind !== 'action') {
        addIssue(context, issuePath, 'Any quantifier must attach to an action operand');
      }
      const isRightBeforeOperand = bundle.members.some(
        (candidate) =>
          candidate.kind === 'ordering' &&
          candidate.relation === 'before' &&
          candidate.operandNodeIds[1] === owner?.nodeId,
      );
      if (!isRightBeforeOperand) {
        addIssue(context, issuePath, 'Any is approved only on the right operand of before');
      }
    } else if (node.kind === 'condition' && owner?.kind === 'action') {
      const isSecondFirstThenOperand = bundle.members.some(
        (candidate) =>
          candidate.kind === 'ordering' &&
          candidate.relation === 'first_then' &&
          candidate.operandNodeIds[1] === owner.nodeId,
      );
      if (!isSecondFirstThenOperand) {
        addIssue(
          context,
          issuePath,
          'Action request condition applies only to the second first-then action',
        );
      }
    }

    if (node.kind === 'frequency' || node.kind === 'condition' || node.kind === 'task_scope') {
      if (owner?.kind === 'preference') {
        const sameKindCount = (outgoing.get(owner.nodeId) ?? []).filter((edge) =>
          node.kind === 'frequency'
            ? edge.relation === 'frequency'
            : node.kind === 'condition'
              ? edge.relation === 'conditions'
              : edge.relation === 'scopes',
        ).length;
        if (sameKindCount > 1) {
          addIssue(context, issuePath, 'Preference accepts at most one of each direct modifier');
        }
      }
    }

    if (node.kind === 'language_use' && owner?.kind === 'language') {
      if (
        (outgoing.get(owner.nodeId) ?? []).filter((edge) => edge.relation === 'qualifies').length >
        1
      ) {
        addIssue(context, issuePath, 'A language accepts at most one language-use qualifier');
      }
    }

    if (node.kind === 'count' || node.kind === 'quantifier' || node.kind === 'action_qualifier') {
      if (owner?.kind === 'action') {
        const ownerEdges = outgoing.get(owner.nodeId) ?? [];
        const counts = ownerEdges.filter((edge) => edge.relation === 'counts').length;
        const quantifiers = ownerEdges.filter((edge) => edge.relation === 'quantifies').length;
        const qualifiers = ownerEdges.filter((edge) => edge.relation === 'qualifies').length;
        if (counts > 1 || quantifiers > 1 || qualifiers > 1 || (counts > 0 && quantifiers > 0)) {
          addIssue(context, issuePath, 'Action owner has an unapproved modifier combination');
        }
      }
    }
  }

  for (const node of bundle.members) {
    if (node.kind !== 'ordering') continue;
    const first = nodes.get(node.operandNodeIds[0]);
    const second = nodes.get(node.operandNodeIds[1]);
    if (first?.kind !== 'action' || second?.kind !== 'action') {
      addIssue(
        context,
        ['members', nodeIndex.get(node.nodeId) ?? 0, 'operandNodeIds'],
        'Ordering operands must be explicit action nodes',
      );
    }
  }
}

function validateOutputCombinations(
  bundle: BundleForValidation,
  context: z.RefinementCtx,
  nodes: Map<string, CompositionalPreferenceNode>,
  outgoing: Map<string, CompositionalPreferenceEdge[]>,
): void {
  for (const node of bundle.members) {
    if (node.kind !== 'output') continue;
    const edges = outgoing.get(node.nodeId) ?? [];
    const modifiers = edges.filter((edge) => edge.relation === 'modifies');
    if (modifiers.length > 1) {
      addIssue(
        context,
        ['members', bundle.members.findIndex((member) => member.nodeId === node.nodeId)],
        'At most one style, length, detail, or register modifier applies to an output',
      );
    }
    const hasLanguage = edges.some((edge) => edge.relation === 'language_of');
    const hasOrdering = edges.some((edge) => edge.relation === 'has_ordering');
    const hasPresentation = edges.some((edge) => edge.relation === 'presents');
    if (hasLanguage && hasOrdering && modifiers.length > 0) {
      addIssue(
        context,
        ['members', bundle.members.findIndex((member) => member.nodeId === node.nodeId)],
        'Language plus ordering composition cannot add an output modifier',
      );
    }
    if (hasPresentation && (hasLanguage || hasOrdering)) {
      addIssue(
        context,
        ['members', bundle.members.findIndex((member) => member.nodeId === node.nodeId)],
        'Output presentation cannot be combined with language or ordering in v1',
      );
    }
    for (const relation of ['language_of', 'presents', 'has_ordering'] as const) {
      if (edges.filter((edge) => edge.relation === relation).length > 1) {
        addIssue(
          context,
          ['members', bundle.members.findIndex((member) => member.nodeId === node.nodeId)],
          `An output may have at most one ${relation} attachment`,
        );
      }
    }
    for (const edge of edges.filter((candidate) => candidate.relation === 'modifies')) {
      const modifier = nodes.get(edge.targetNodeId);
      if (
        modifier?.kind !== 'style' &&
        modifier?.kind !== 'length' &&
        modifier?.kind !== 'detail' &&
        modifier?.kind !== 'register'
      ) {
        addIssue(context, ['attachments'], 'Output modifier must use an approved modifier node');
      }
    }
  }
}

function validatePreferenceResult(
  result: z.infer<typeof CompositionalPreferenceBaseSchema>,
  context: z.RefinementCtx,
): void {
  const bundleIds = new Set<string>();
  const nodeIds = new Set<string>();
  let nodeCount = 0;
  let preferenceCount = 0;
  const expectedDescriptor = JSON.stringify(result.descriptor);
  for (const [bundleIndex, bundle] of result.bundles.entries()) {
    if (bundleIds.has(bundle.bundleId)) {
      addIssue(context, ['bundles', bundleIndex, 'bundleId'], 'Bundle IDs must be globally unique');
    }
    bundleIds.add(bundle.bundleId);
    nodeCount += bundle.members.length;
    if (JSON.stringify(bundle.evidence.descriptor) !== expectedDescriptor) {
      addIssue(
        context,
        ['bundles', bundleIndex, 'evidence', 'descriptor'],
        'Mixed interpreter versions',
      );
    }
    for (const [nodeIndex, node] of bundle.members.entries()) {
      if (node.kind === 'preference') preferenceCount += 1;
      if (nodeIds.has(node.nodeId)) {
        addIssue(
          context,
          ['bundles', bundleIndex, 'members', nodeIndex, 'nodeId'],
          'Node IDs must be globally unique',
        );
      }
      nodeIds.add(node.nodeId);
      if (JSON.stringify(node.evidence.descriptor) !== expectedDescriptor) {
        addIssue(
          context,
          ['bundles', bundleIndex, 'members', nodeIndex, 'evidence', 'descriptor'],
          'Mixed interpreter versions',
        );
      }
    }
    for (const [edgeIndex, edge] of bundle.attachments.entries()) {
      if (JSON.stringify(edge.evidence.descriptor) !== expectedDescriptor) {
        addIssue(
          context,
          ['bundles', bundleIndex, 'attachments', edgeIndex, 'evidence', 'descriptor'],
          'Mixed interpreter versions',
        );
      }
    }
    if (JSON.stringify(bundle.evidence.descriptor) !== expectedDescriptor) continue;
  }
  if (nodeCount > 128) addIssue(context, ['bundles'], 'Global semantic-node limit is 128');
  if (preferenceCount > 32) {
    addIssue(context, ['bundles'], 'Global preference-predicate limit is 32');
  }

  if (result.coverage === 'complete') {
    if (
      result.bundles.length === 0 ||
      result.withheld.length > 0 ||
      result.bundles.some((bundle) => bundle.coverage !== 'complete')
    ) {
      addIssue(
        context,
        ['coverage'],
        'Complete coverage cannot contain withheld or incomplete bundles',
      );
    }
  } else if (result.coverage === 'partial') {
    if (
      !result.bundles.some((bundle) => bundle.coverage === 'complete') ||
      result.withheld.length === 0 ||
      result.bundles.some((bundle) => bundle.coverage !== 'complete')
    ) {
      addIssue(
        context,
        ['coverage'],
        'Partial coverage requires complete bundles and withheld siblings',
      );
    }
  } else if (result.coverage === 'none') {
    if (result.bundles.length > 0 || result.withheld.length > 0) {
      addIssue(
        context,
        ['bundles'],
        'None coverage cannot contain preference bundles or withheld regions',
      );
    }
  } else if (result.bundles.length > 0) {
    addIssue(context, ['bundles'], 'Unknown coverage cannot contain preference bundles');
  }
}

export type CompositionalEvidenceValidationReason = z.infer<
  typeof CompositionalPreferenceReasonSchema
>;

/**
 * The AST and envelope remain unknown here intentionally: source byte caps
 * are checked before their deeper schemas are run by the validator.
 */
export const CompositionalEvidenceValidationInputSchema = z
  .object({
    preference: z.unknown(),
    rawContent: z.string(),
    mappedContent: z.string(),
    envelope: z.unknown(),
  })
  .strict();
export type CompositionalEvidenceValidationInput = z.infer<
  typeof CompositionalEvidenceValidationInputSchema
>;

export const CompositionalEvidenceValidationResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }).strict(),
  z.object({ ok: z.literal(false), reason: CompositionalPreferenceReasonSchema }).strict(),
]);
export type CompositionalEvidenceValidationResult = z.infer<
  typeof CompositionalEvidenceValidationResultSchema
>;

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function isCodePointBoundary(value: string, offset: number): boolean {
  if (offset <= 0 || offset >= value.length) return offset >= 0 && offset <= value.length;
  const left = value.charCodeAt(offset - 1);
  const right = value.charCodeAt(offset);
  return !(left >= 0xd800 && left <= 0xdbff && right >= 0xdc00 && right <= 0xdfff);
}

function mappedRawRegion(
  start: number,
  end: number,
  mappings: z.infer<typeof AutomaticSourceEnvelopeSchema>['mappings'],
): { start: number; end: number } | null {
  let cursor = start;
  let rawStart: number | undefined;
  let rawEnd: number | undefined;
  for (const mapping of mappings) {
    const overlapStart = Math.max(start, mapping.contentStart);
    const overlapEnd = Math.min(end, mapping.contentEnd);
    if (overlapStart >= overlapEnd) continue;
    if (overlapStart !== cursor) return null;
    const mappedStart = mapping.rawStart + (overlapStart - mapping.contentStart);
    const mappedEnd = mapping.rawStart + (overlapEnd - mapping.contentStart);
    if (rawEnd !== undefined && rawEnd !== mappedStart) return null;
    rawStart ??= mappedStart;
    rawEnd = mappedEnd;
    cursor = overlapEnd;
  }
  if (cursor !== end || rawStart === undefined || rawEnd === undefined) return null;
  return { start: rawStart, end: rawEnd };
}

/**
 * Snapshot plain JSON without serializing an unbounded unknown tree first.
 * Limits are code-owned admission presets, not caller-supplied source authority.
 */
export function snapshotBoundedCompositionalJson(
  value: unknown,
  maxBytes: 16384 | 32768,
): unknown | undefined {
  try {
    return snapshotBoundedCompositionalJsonInternal(value, maxBytes);
  } catch {
    // Descriptor/prototype traps are invalid data, never diagnostic text.
    return undefined;
  }
}

function snapshotBoundedCompositionalJsonInternal(
  value: unknown,
  maxBytes: 16384 | 32768,
): unknown | undefined {
  if (maxBytes !== 16384 && maxBytes !== 32768) return undefined;
  const maxNodes = maxBytes === 16384 ? 1024 : 8192;
  const maxDepth = maxBytes === 16384 ? 16 : 32;
  let bytes = 0;
  let nodes = 0;
  const active = new Set<object>();
  const add = (amount: number): boolean => {
    bytes += amount;
    return bytes <= maxBytes;
  };
  const stringBytes = (text: string): boolean => {
    // Escape only individually bounded strings, never the unknown whole input.
    if (text.length > maxBytes) return false;
    const encoded = JSON.stringify(text);
    if (encoded.length > maxBytes) return false;
    return add(Buffer.byteLength(encoded, 'utf8'));
  };
  const visit = (current: unknown, depth: number): unknown | undefined => {
    if (++nodes > maxNodes || depth > maxDepth) return undefined;
    if (current === null) return add(4) ? null : undefined;
    if (typeof current === 'string') return stringBytes(current) ? current : undefined;
    if (typeof current === 'boolean') return add(current ? 4 : 5) ? current : undefined;
    if (typeof current === 'number') {
      return Number.isFinite(current) && add(String(current).length) ? current : undefined;
    }
    if (typeof current !== 'object' || active.has(current)) return undefined;
    const array = Array.isArray(current);
    const prototype = Object.getPrototypeOf(current);
    // Cross-realm JSON objects/arrays (including structuredClone in Jest) have
    // different prototype identities. Check their shallow prototype shape;
    // read only own data descriptors and never invoke serialization hooks.
    if (
      array
        ? !Array.isArray(prototype)
        : prototype !== null && Object.getPrototypeOf(prototype) !== null
    )
      return undefined;
    if (array && current.length > maxNodes) return undefined;
    active.add(current);
    if (!add(2)) return undefined;
    if (array) {
      const copy: unknown[] = [];
      for (let index = 0; index < current.length; index++) {
        const entry = Object.getOwnPropertyDescriptor(current, String(index));
        if (!entry || !('value' in entry)) return undefined;
        if (index > 0 && !add(1)) return undefined;
        const child = visit(entry.value, depth + 1);
        if (child === undefined) return undefined;
        copy.push(child);
      }
      active.delete(current);
      return copy;
    }
    const copy: Record<string, unknown> = Object.create(null);
    let count = 0;
    const keys = Reflect.ownKeys(current);
    if (keys.length > maxNodes) return undefined;
    for (const key of keys) {
      if (typeof key !== 'string') continue;
      const entry = Object.getOwnPropertyDescriptor(current, key);
      if (!entry || !entry.enumerable) continue;
      if (++count > maxNodes) return undefined;
      if (!('value' in entry)) return undefined;
      if (count > 1 && !add(1)) return undefined;
      if (!stringBytes(key) || !add(1)) return undefined;
      const child = visit(entry.value, depth + 1);
      if (child === undefined) return undefined;
      copy[key] = child;
    }
    active.delete(current);
    return copy;
  };
  return visit(value, 1);
}

function boundedEnvelopeInput(value: unknown): unknown | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const mappings = Object.getOwnPropertyDescriptor(value, 'mappings');
  const quotes = Object.getOwnPropertyDescriptor(value, 'quoteRegions');
  if (
    !mappings ||
    !('value' in mappings) ||
    !Array.isArray(mappings.value) ||
    !quotes ||
    !('value' in quotes) ||
    !Array.isArray(quotes.value) ||
    mappings.value.length > 32 ||
    quotes.value.length > 32 ||
    mappings.value.length + quotes.value.length > 32
  )
    return undefined;
  return snapshotBoundedCompositionalJson(value, 16384);
}

/**
 * Validates bounded AST integrity and exact UTF-16 evidence-to-source mapping.
 * It does not parse natural language, prove semantic entailment, classify
 * speaker intent, or grant acceptance authority.
 */
export function validateCompositionalPreferenceEvidence(
  input: CompositionalEvidenceValidationInput,
): CompositionalEvidenceValidationResult {
  let inputShape: ReturnType<typeof CompositionalEvidenceValidationInputSchema.safeParse>;
  try {
    inputShape = CompositionalEvidenceValidationInputSchema.safeParse(input);
  } catch {
    return { ok: false, reason: 'invalid_envelope' };
  }
  if (!inputShape.success) return { ok: false, reason: 'invalid_envelope' };
  const supplied = inputShape.data;
  if (
    supplied.rawContent.length > 65536 ||
    supplied.mappedContent.length > 65536 ||
    Buffer.byteLength(supplied.rawContent, 'utf8') > 65536 ||
    Buffer.byteLength(supplied.mappedContent, 'utf8') > 65536
  ) {
    return { ok: false, reason: 'source_too_large' };
  }
  if (!isWellFormedUnicode(supplied.rawContent) || !isWellFormedUnicode(supplied.mappedContent)) {
    return { ok: false, reason: 'invalid_unicode' };
  }

  let envelopeInput: unknown;
  try {
    envelopeInput = boundedEnvelopeInput(supplied.envelope);
  } catch {
    return { ok: false, reason: 'invalid_envelope' };
  }
  if (envelopeInput === undefined) return { ok: false, reason: 'invalid_envelope' };
  const envelope = AutomaticSourceEnvelopeSchema.safeParse(envelopeInput);
  if (!envelope.success) return { ok: false, reason: 'invalid_envelope' };
  if (
    envelope.data.rawContentHash !== sha256(supplied.rawContent) ||
    envelope.data.contentHash !== sha256(supplied.mappedContent)
  ) {
    return { ok: false, reason: 'content_mismatch' };
  }

  const parsed = CompositionalPreferenceSchema.safeParse(supplied.preference);
  if (!parsed.success) {
    return {
      ok: false,
      reason: parsed.error.issues.some((issue) => issue.message.includes('32 KiB'))
        ? 'metadata_too_large'
        : 'invalid_ast_integrity',
    };
  }
  if (
    envelope.data.humanRegion.end > supplied.rawContent.length ||
    !isCodePointBoundary(supplied.rawContent, envelope.data.humanRegion.start) ||
    !isCodePointBoundary(supplied.rawContent, envelope.data.humanRegion.end)
  ) {
    return { ok: false, reason: 'invalid_unicode' };
  }

  const [mapping] = envelope.data.mappings;
  if (
    envelope.data.mappings.length !== 1 ||
    !mapping ||
    mapping.contentStart !== 0 ||
    mapping.contentEnd !== supplied.mappedContent.length ||
    mapping.rawStart !== envelope.data.humanRegion.start ||
    mapping.rawEnd !== envelope.data.humanRegion.end ||
    mapping.rawEnd > supplied.rawContent.length ||
    !isCodePointBoundary(supplied.mappedContent, mapping.contentStart) ||
    !isCodePointBoundary(supplied.mappedContent, mapping.contentEnd) ||
    !isCodePointBoundary(supplied.rawContent, mapping.rawStart) ||
    !isCodePointBoundary(supplied.rawContent, mapping.rawEnd)
  ) {
    return { ok: false, reason: 'incomplete_mapping' };
  }
  if (
    supplied.mappedContent.slice(mapping.contentStart, mapping.contentEnd) !==
    supplied.rawContent.slice(mapping.rawStart, mapping.rawEnd)
  ) {
    return { ok: false, reason: 'content_mismatch' };
  }
  if (
    envelope.data.mappingAuthority === 'whole_source' &&
    (mapping.rawStart !== 0 ||
      mapping.rawEnd !== supplied.rawContent.length ||
      supplied.rawContent !== supplied.mappedContent)
  ) {
    return { ok: false, reason: 'incomplete_mapping' };
  }

  // Envelope quote regions use mapped-content UTF-16 offsets. Map each quote
  // through the one full-body source mapping before checking its raw slice.
  for (const quote of envelope.data.quoteRegions) {
    if (
      quote.end > supplied.mappedContent.length ||
      !isCodePointBoundary(supplied.mappedContent, quote.start) ||
      !isCodePointBoundary(supplied.mappedContent, quote.end)
    ) {
      return { ok: false, reason: 'invalid_unicode' };
    }
    const rawQuote = mappedRawRegion(quote.start, quote.end, envelope.data.mappings);
    if (!rawQuote) return { ok: false, reason: 'incomplete_mapping' };
    if (
      !isCodePointBoundary(supplied.rawContent, rawQuote.start) ||
      !isCodePointBoundary(supplied.rawContent, rawQuote.end)
    ) {
      return { ok: false, reason: 'invalid_unicode' };
    }
    if (
      supplied.mappedContent.slice(quote.start, quote.end) !==
      supplied.rawContent.slice(rawQuote.start, rawQuote.end)
    ) {
      return { ok: false, reason: 'content_mismatch' };
    }
  }

  for (const withheld of parsed.data.withheld) {
    const region = withheld.sourceRegion;
    if (!region) continue;
    if (
      region.end > supplied.mappedContent.length ||
      !isCodePointBoundary(supplied.mappedContent, region.start) ||
      !isCodePointBoundary(supplied.mappedContent, region.end)
    ) {
      return { ok: false, reason: 'invalid_unicode' };
    }
    const rawRegion = mappedRawRegion(region.start, region.end, envelope.data.mappings);
    if (!rawRegion) return { ok: false, reason: 'incomplete_mapping' };
    if (
      !isCodePointBoundary(supplied.rawContent, rawRegion.start) ||
      !isCodePointBoundary(supplied.rawContent, rawRegion.end)
    ) {
      return { ok: false, reason: 'invalid_unicode' };
    }
  }

  const quotes = envelope.data.quoteRegions;
  const evidenceList: CompositionalPreferenceEvidence[] = [];
  for (const bundle of parsed.data.bundles) {
    evidenceList.push(bundle.evidence);
    for (const node of bundle.members) evidenceList.push(node.evidence);
    for (const edge of bundle.attachments) evidenceList.push(edge.evidence);
  }

  for (const evidence of evidenceList) {
    let lexical = '';
    for (const span of evidence.spans) {
      if (
        span.content.end > supplied.mappedContent.length ||
        span.raw.end > supplied.rawContent.length ||
        span.raw.start < envelope.data.humanRegion.start ||
        span.raw.end > envelope.data.humanRegion.end ||
        !isCodePointBoundary(supplied.mappedContent, span.content.start) ||
        !isCodePointBoundary(supplied.mappedContent, span.content.end) ||
        !isCodePointBoundary(supplied.rawContent, span.raw.start) ||
        !isCodePointBoundary(supplied.rawContent, span.raw.end)
      ) {
        return { ok: false, reason: 'invalid_unicode' };
      }
      const mapped = mappedRawRegion(span.content.start, span.content.end, envelope.data.mappings);
      if (!mapped) return { ok: false, reason: 'incomplete_mapping' };
      if (mapped.start !== span.raw.start || mapped.end !== span.raw.end) {
        return { ok: false, reason: 'content_mismatch' };
      }
      const contentSlice = supplied.mappedContent.slice(span.content.start, span.content.end);
      const rawSlice = supplied.rawContent.slice(span.raw.start, span.raw.end);
      if (contentSlice !== rawSlice) return { ok: false, reason: 'content_mismatch' };
      if (
        quotes.some((quote) => span.content.start < quote.end && span.content.end > quote.start)
      ) {
        return { ok: false, reason: 'quoted_content' };
      }
      lexical += contentSlice;
    }
    if (lexical !== evidence.lexicalForm) return { ok: false, reason: 'content_mismatch' };
  }
  return { ok: true };
}
