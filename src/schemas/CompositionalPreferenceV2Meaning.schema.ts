import { createHash } from 'crypto';
import { z } from 'zod';
import {
  CompositionalPreferenceV2LanguageNameSchema,
  CompositionalPreferenceV2DescriptorSchema,
  CompositionalPreferenceV2ReasonSchema,
  snapshotBoundedCompositionalJson,
} from './CompositionalPreferenceV2.schema';

const MeaningPathSchema = z
  .string()
  .max(128)
  .regex(
    /^p(?:0|[1-9][0-9]{0,1})(?:\.(?:target|modifier|language|presentation|ordering|first|second|language_use|qualifier|count|quantifier|frequency|condition|scope|included|format|quality|emoji|characteristic))*$/,
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

const TaggedMeaningLanguageNodeSchema = z
  .object({
    path: MeaningPathSchema,
    kind: z.literal('language'),
    representation: z.literal('tagged'),
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

const NamedMeaningLanguageNodeSchema = z
  .object({
    path: MeaningPathSchema,
    kind: z.literal('language'),
    representation: z.literal('named'),
    registryId: z.literal('literal-v1-safe-language-names'),
    registryVersion: z.literal(1),
    name: CompositionalPreferenceV2LanguageNameSchema,
  })
  .strict();

const MeaningLanguageNodeSchema = z.union([
  TaggedMeaningLanguageNodeSchema,
  NamedMeaningLanguageNodeSchema,
]);

const MeaningOutputNodeSchema = z
  .object({
    path: MeaningPathSchema,
    kind: z.literal('output'),
    value: z.enum(['explanation', 'answer', 'response', 'summary', 'instruction']),
  })
  .strict();

const MeaningPresentationNodeSchema = z
  .object({
    path: MeaningPathSchema,
    kind: z.literal('presentation'),
    value: z.enum([
      'bullets',
      'numbered_steps',
      'prose',
      'table',
      'numbered_lists',
      'checklists',
      'short_paragraphs',
      'paragraphs',
      'headings',
      'code_blocks',
      'inline_code',
      'diagrams',
      'charts',
      'lists',
    ]),
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
  .object({
    path: MeaningPathSchema,
    kind: z.literal('language_use'),
    value: z.enum(['plain', 'simple', 'clear']),
  })
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

const MeaningFormatSelectionNodeSchema = z
  .object({
    path: MeaningPathSchema,
    kind: z.literal('format_selection'),
    value: z.enum([
      'plain_text',
      'rich_text',
      'markdown',
      'json',
      'csv',
      'yaml',
      'xml',
      'html',
      'latex',
    ]),
  })
  .strict();

const MeaningCommunicationQualityNodeSchema = z
  .object({
    path: MeaningPathSchema,
    kind: z.literal('communication_quality'),
    facet: z.enum(['tone', 'style']),
    value: z.enum([
      'friendly',
      'professional',
      'warm',
      'neutral',
      'direct',
      'conversational',
      'formal',
      'informal',
      'encouraging',
      'matter_of_fact',
      'concise',
      'polite',
    ]),
  })
  .strict();

const MeaningEmojiUsageNodeSchema = z.union([
  z
    .object({ path: MeaningPathSchema, kind: z.literal('emoji_usage'), value: z.literal('none') })
    .strict(),
  z
    .object({
      path: MeaningPathSchema,
      kind: z.literal('emoji_usage'),
      value: z.literal('fewer'),
      comparisonBaseline: z.literal('unspecified'),
    })
    .strict(),
]);

const MeaningOutputCharacteristicNodeSchema = z
  .object({
    path: MeaningPathSchema,
    kind: z.literal('output_characteristic'),
    value: z.enum([
      'clear',
      'thorough',
      'simple',
      'step_by_step',
      'technical',
      'nontechnical',
      'beginner_friendly',
      'accessible',
      'practical',
      'in_depth',
      'succinct',
      'straightforward',
    ]),
  })
  .strict();

export const CompositionalPreferenceV2MeaningNodeSchema = z.union([
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
  MeaningFormatSelectionNodeSchema,
  MeaningCommunicationQualityNodeSchema,
  MeaningEmojiUsageNodeSchema,
  MeaningOutputCharacteristicNodeSchema,
]);
export type CompositionalPreferenceV2MeaningNode = z.infer<
  typeof CompositionalPreferenceV2MeaningNodeSchema
>;

const MeaningEdgeBase = {
  ownerPath: MeaningPathSchema,
  targetPath: MeaningPathSchema,
};

export const CompositionalPreferenceV2MeaningEdgeSchema = z.discriminatedUnion('relation', [
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
  z.object({ ...MeaningEdgeBase, relation: z.literal('includes') }).strict(),
  z
    .object({
      ...MeaningEdgeBase,
      relation: z.literal('orders'),
      position: z.enum(['first', 'second']),
    })
    .strict(),
]);
export type CompositionalPreferenceV2MeaningEdge = z.infer<
  typeof CompositionalPreferenceV2MeaningEdgeSchema
>;

function meaningEdgeAllowed(
  owner: CompositionalPreferenceV2MeaningNode,
  target: CompositionalPreferenceV2MeaningNode,
  edge: CompositionalPreferenceV2MeaningEdge,
): boolean {
  switch (edge.relation) {
    case 'targets':
      return (
        owner.kind === 'preference' &&
        [
          'language',
          'output',
          'presentation',
          'action',
          'ordering',
          'format_selection',
          'communication_quality',
          'emoji_usage',
        ].includes(target.kind)
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
        owner.kind === 'output' &&
        ['style', 'length', 'detail', 'register', 'output_characteristic'].includes(target.kind)
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
    case 'includes':
      return (
        owner.kind === 'output' &&
        target.kind === 'action' &&
        (target.value === 'examples' || target.value === 'steps')
      );
  }
}

function meaningChildSegment(
  edge: CompositionalPreferenceV2MeaningEdge,
  ownerKind: CompositionalPreferenceV2MeaningNode['kind'],
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
  if (edge.relation === 'includes') return 'included';
  return 'scope';
}

const CompositionalPreferenceV2MeaningBundleSchema = z
  .object({
    relation: z.enum(['single', 'allOf']),
    coupling: z.enum(['independent', 'coupled']),
    rootPaths: z.array(MeaningPathSchema).min(1).max(32),
    nodes: z.array(CompositionalPreferenceV2MeaningNodeSchema).min(1).max(128),
    edges: z.array(CompositionalPreferenceV2MeaningEdgeSchema).max(128),
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
      if (
        [
          'language',
          'output',
          'presentation',
          'action',
          'ordering',
          'format_selection',
          'communication_quality',
          'emoji_usage',
        ].includes(node.kind)
      ) {
        const owners = nodeIncoming.filter((relation) =>
          ['targets', 'language_of', 'presents', 'has_ordering', 'orders', 'includes'].includes(
            relation,
          ),
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
          'output_characteristic',
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
      if (node.kind === 'preference') {
        const target = nodes.get(node.targetPath);
        if (
          target?.kind === 'emoji_usage' &&
          (node.polarity !== 'affirmed' || (node.operator !== 'prefer' && node.operator !== 'like'))
        ) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['nodes'],
            message: 'Emoji usage permits only affirmed prefer and like predicates',
          });
        }
      }
      if (node.kind === 'output') {
        const ownerEdges = edgesByOwner.get(node.path) ?? [];
        const modifiers = ownerEdges.filter((edge) => edge.relation === 'modifies');
        const includes = ownerEdges.filter((edge) => edge.relation === 'includes');
        const hasLanguage = ownerEdges.some((edge) => edge.relation === 'language_of');
        const hasOrdering = ownerEdges.some((edge) => edge.relation === 'has_ordering');
        const hasPresentation = ownerEdges.some((edge) => edge.relation === 'presents');
        if (modifiers.length > 1 || includes.length > 1) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['nodes'],
            message: 'Output supports at most one modifier and one included action',
          });
        }
        if (hasLanguage && hasOrdering && modifiers.length > 0) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['nodes'],
            message: 'Language plus ordering cannot add an output modifier',
          });
        }
        if (hasPresentation && (hasLanguage || hasOrdering)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['nodes'],
            message: 'Output presentation cannot combine with language or ordering',
          });
        }
        if (includes.length > 0 && (hasOrdering || hasPresentation)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['nodes'],
            message: 'Included action cannot combine with ordering or presentation',
          });
        }
        if (includes.length > 0 && hasLanguage) {
          const languagePath = `${node.path}.language`;
          const language = nodes.get(languagePath);
          const usage = nodes.get(`${languagePath}.language_use`);
          if (
            language?.kind !== 'language' ||
            language.representation !== 'tagged' ||
            language.base !== 'English' ||
            language.region !== undefined ||
            language.languageTag !== 'en' ||
            usage?.kind !== 'language_use' ||
            usage.value !== 'plain' ||
            modifiers.length > 0
          ) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['nodes'],
              message: 'Included output permits only atomic plain English language attachment',
            });
          }
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
export type CompositionalPreferenceV2MeaningBundle = z.infer<
  typeof CompositionalPreferenceV2MeaningBundleSchema
>;

const CompositionalPreferenceV2MeaningBaseSchema = z
  .object({
    version: z.literal(2),
    descriptor: CompositionalPreferenceV2DescriptorSchema,
    namespace: z
      .string()
      .min(1)
      .max(128)
      .refine((value) => value.trim().length > 0),
    subjectId: z.string().uuid(),
    bundles: z.array(CompositionalPreferenceV2MeaningBundleSchema).max(32),
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

const CompositionalPreferenceV2MeaningPreflightSchema = z
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

export const CompositionalPreferenceV2MeaningSchema =
  CompositionalPreferenceV2MeaningPreflightSchema.pipe(CompositionalPreferenceV2MeaningBaseSchema);
export type CompositionalPreferenceV2Meaning = z.infer<
  typeof CompositionalPreferenceV2MeaningSchema
>;

export const CompositionalPreferenceV2InterpretationInputSchema = z
  .object({
    descriptor: CompositionalPreferenceV2DescriptorSchema,
    rawContent: z.string(),
    mappedContent: z.string(),
    envelope: z.unknown(),
    check: z.function().args().returns(z.void()).optional(),
  })
  .strict();
export type CompositionalPreferenceV2InterpretationInput = z.infer<
  typeof CompositionalPreferenceV2InterpretationInputSchema
>;

export const CompositionalPreferenceV2MeaningProjectionInputSchema = z
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
export type CompositionalPreferenceV2MeaningProjectionInput = z.infer<
  typeof CompositionalPreferenceV2MeaningProjectionInputSchema
>;

const CompositionalPreferenceV2MeaningProjectionSuccessSchema = z
  .object({
    ok: z.literal(true),
    meaning: CompositionalPreferenceV2MeaningSchema,
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

export const CompositionalPreferenceV2MeaningProjectionResultSchema = z.union([
  CompositionalPreferenceV2MeaningProjectionSuccessSchema,
  z.object({ ok: z.literal(false), reason: CompositionalPreferenceV2ReasonSchema }).strict(),
]);
export type CompositionalPreferenceV2MeaningProjectionResult = z.infer<
  typeof CompositionalPreferenceV2MeaningProjectionResultSchema
>;
