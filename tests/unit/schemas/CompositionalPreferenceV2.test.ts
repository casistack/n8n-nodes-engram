import { createHash } from 'crypto';
import {
  CompositionalPreferenceV2BundleSchema,
  COMPOSITIONAL_PREFERENCE_V2_DESCRIPTOR,
  CompositionalPreferenceV2Schema,
  snapshotBoundedCompositionalJson,
  validateCompositionalPreferenceV2Evidence,
} from '../../../src/schemas/CompositionalPreferenceV2.schema';

const descriptor = { ...COMPOSITIONAL_PREFERENCE_V2_DESCRIPTOR };
const RAW_COMPOUND =
  'I like responses in plain Australian English, with one worked example ahead of any technical terms.';

function id(value: number): string {
  return `n_${value.toString(16).padStart(16, '0')}`;
}

function bundleId(value: number): string {
  return `b_${value.toString(16).padStart(16, '0')}`;
}

function evidence(content: string, phrase: string, rawOffset = 0, occurrence = 0) {
  let start = -1;
  let from = 0;
  for (let index = 0; index <= occurrence; index += 1) {
    start = content.indexOf(phrase, from);
    if (start < 0) throw new Error(`Fixture phrase not found: ${phrase}`);
    from = start + phrase.length;
  }
  const end = start + phrase.length;
  return {
    descriptor,
    spans: [
      {
        content: { start, end },
        raw: { start: rawOffset + start, end: rawOffset + end },
      },
    ],
    lexicalForm: phrase,
  };
}

function makeCompound(content = RAW_COMPOUND, rawOffset = 0) {
  const preferenceId = id(1);
  const outputId = id(2);
  const languageId = id(3);
  const orderingId = id(4);
  const examplesId = id(5);
  const terminologyId = id(6);
  const languageUseId = id(7);
  const countId = id(8);
  const workedId = id(9);
  const anyId = id(10);
  const technicalId = id(11);

  const nodes = [
    {
      nodeId: preferenceId,
      kind: 'preference',
      subject: 'speaker',
      operator: 'like',
      polarity: 'affirmed',
      negation: 'none',
      targetNodeId: outputId,
      attachmentNodeIds: [],
      evidence: evidence(content, 'I like', rawOffset),
    },
    {
      nodeId: outputId,
      kind: 'output',
      value: 'response',
      evidence: evidence(content, 'responses', rawOffset),
    },
    {
      nodeId: languageId,
      kind: 'language',
      representation: 'tagged',
      base: 'English',
      region: 'Australian',
      languageTag: 'en-AU',
      evidence: evidence(content, 'Australian English', rawOffset),
    },
    {
      nodeId: orderingId,
      kind: 'ordering',
      relation: 'before',
      operandNodeIds: [examplesId, terminologyId],
      evidence: evidence(content, 'ahead of', rawOffset),
    },
    {
      nodeId: examplesId,
      kind: 'action',
      value: 'examples',
      evidence: evidence(content, 'example', rawOffset),
    },
    {
      nodeId: terminologyId,
      kind: 'action',
      value: 'terminology',
      evidence: evidence(content, 'terms', rawOffset),
    },
    {
      nodeId: languageUseId,
      kind: 'language_use',
      value: 'plain',
      targetNodeId: languageId,
      evidence: evidence(content, 'plain', rawOffset),
    },
    {
      nodeId: countId,
      kind: 'count',
      value: 1,
      mode: 'as_stated',
      evidence: evidence(content, 'one', rawOffset),
    },
    {
      nodeId: workedId,
      kind: 'action_qualifier',
      value: 'worked',
      targetNodeId: examplesId,
      evidence: evidence(content, 'worked', rawOffset),
    },
    {
      nodeId: anyId,
      kind: 'quantifier',
      value: 'any',
      evidence: evidence(content, 'any', rawOffset),
    },
    {
      nodeId: technicalId,
      kind: 'action_qualifier',
      value: 'technical',
      targetNodeId: terminologyId,
      evidence: evidence(content, 'technical', rawOffset),
    },
  ];
  const edgeEvidence = (phrase: string) => evidence(content, phrase, rawOffset);
  const attachments = [
    {
      relation: 'targets',
      ownerNodeId: preferenceId,
      targetNodeId: outputId,
      evidence: edgeEvidence('I like'),
    },
    {
      relation: 'language_of',
      ownerNodeId: outputId,
      targetNodeId: languageId,
      evidence: edgeEvidence('in'),
    },
    {
      relation: 'has_ordering',
      ownerNodeId: outputId,
      targetNodeId: orderingId,
      evidence: edgeEvidence('with'),
    },
    {
      relation: 'orders',
      position: 'first',
      ownerNodeId: orderingId,
      targetNodeId: examplesId,
      evidence: edgeEvidence('ahead of'),
    },
    {
      relation: 'orders',
      position: 'second',
      ownerNodeId: orderingId,
      targetNodeId: terminologyId,
      evidence: edgeEvidence('ahead of'),
    },
    {
      relation: 'qualifies',
      ownerNodeId: languageId,
      targetNodeId: languageUseId,
      evidence: edgeEvidence('plain'),
    },
    {
      relation: 'counts',
      ownerNodeId: examplesId,
      targetNodeId: countId,
      evidence: edgeEvidence('one'),
    },
    {
      relation: 'qualifies',
      ownerNodeId: examplesId,
      targetNodeId: workedId,
      evidence: edgeEvidence('worked'),
    },
    {
      relation: 'quantifies',
      ownerNodeId: terminologyId,
      targetNodeId: anyId,
      evidence: edgeEvidence('any'),
    },
    {
      relation: 'qualifies',
      ownerNodeId: terminologyId,
      targetNodeId: technicalId,
      evidence: edgeEvidence('technical'),
    },
  ];
  return {
    version: 2,
    descriptor,
    coverage: 'complete',
    bundles: [
      {
        bundleId: bundleId(1),
        relation: 'single',
        coupling: 'coupled',
        rootNodeIds: [preferenceId],
        members: nodes,
        attachments,
        evidence: evidence(content, content, rawOffset),
        coverage: 'complete',
      },
    ],
    withheld: [],
    reasons: [],
  };
}

function makeEnvelope(
  content: string,
  rawContent = content,
  rawStart = 0,
  quoteRegions: Array<{ start: number; end: number }> = [],
) {
  const rawEnd = rawStart + content.length;
  const mappingAuthority = rawContent === content ? 'whole_source' : 'application_region';
  return {
    version: 1,
    namespace: 'schema-tests',
    issuer: 'local-test',
    actorReference: 'synthetic-speaker',
    bindingRef: {
      bindingId: '00000000-0000-4000-8000-000000000001',
      revision: 1,
      subjectId: '00000000-0000-4000-8000-000000000002',
      fingerprint: 'a'.repeat(64),
    },
    contentHash: sha256(content),
    rawContentHash: sha256(rawContent),
    mappingAuthority,
    humanRegion: { start: rawStart, end: rawEnd },
    mappings: [
      {
        contentStart: 0,
        contentEnd: content.length,
        rawStart,
        rawEnd,
      },
    ],
    quoteRegions,
    explicitIntent: false,
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function makeSimpleBundle(index: number, text = 'I like tables.', customEvidence?: unknown) {
  const preferenceId = id(index * 2 + 1);
  const presentationId = id(index * 2 + 2);
  const itemEvidence = customEvidence ?? evidence(text, text.slice(0, -1));
  return {
    bundleId: bundleId(index),
    relation: 'single',
    coupling: 'independent',
    rootNodeIds: [preferenceId],
    members: [
      {
        nodeId: preferenceId,
        kind: 'preference',
        subject: 'speaker',
        operator: 'like',
        polarity: 'affirmed',
        negation: 'none',
        targetNodeId: presentationId,
        attachmentNodeIds: [],
        evidence: itemEvidence,
      },
      {
        nodeId: presentationId,
        kind: 'presentation',
        value: 'table',
        evidence: itemEvidence,
      },
    ],
    attachments: [
      {
        relation: 'targets',
        ownerNodeId: preferenceId,
        targetNodeId: presentationId,
        evidence: itemEvidence,
      },
    ],
    evidence: itemEvidence,
    coverage: 'complete',
  };
}

function makeAllOfBundle(bundleIndex: number, rootCount: number) {
  const source = 'I like tables and I like prose and I like bullets and I like numbered steps.';
  const sourceEvidence = evidence(source, source);
  const rootIds = Array.from({ length: rootCount }, (_, index) =>
    id(2000 + bundleIndex * 100 + index * 2),
  );
  const targetIds = Array.from({ length: rootCount }, (_, index) =>
    id(2001 + bundleIndex * 100 + index * 2),
  );
  const presentationValues = ['table', 'prose', 'bullets', 'numbered_steps'] as const;
  const members = rootIds.flatMap((preferenceId, index) => [
    {
      nodeId: preferenceId,
      kind: 'preference',
      subject: 'speaker',
      operator: 'like',
      polarity: 'affirmed',
      negation: 'none',
      targetNodeId: targetIds[index],
      attachmentNodeIds: [],
      evidence: sourceEvidence,
    },
    {
      nodeId: targetIds[index],
      kind: 'presentation',
      value: presentationValues[index % presentationValues.length],
      evidence: sourceEvidence,
    },
  ]);
  const attachments = rootIds.flatMap((preferenceId, index) => {
    const result = [
      {
        relation: 'targets',
        ownerNodeId: preferenceId,
        targetNodeId: targetIds[index],
        evidence: sourceEvidence,
      },
    ];
    if (index > 0) {
      result.push({
        relation: 'all_of',
        ownerNodeId: rootIds[0],
        targetNodeId: preferenceId,
        evidence: sourceEvidence,
      });
    }
    return result;
  });
  return {
    bundleId: bundleId(100 + bundleIndex),
    relation: 'allOf',
    coupling: 'coupled',
    rootNodeIds: rootIds,
    members,
    attachments,
    evidence: sourceEvidence,
    coverage: 'complete',
  };
}

function makeReconvergentAllOfBundle() {
  const source = 'I like tables and I like prose and I like bullets and I like steps.';
  const sourceEvidence = evidence(source, source);
  const layerCount = 7;
  const rootsPerLayer = 4;
  const rootIds = Array.from({ length: layerCount * rootsPerLayer }, (_, index) =>
    id(10_000 + index),
  );
  const targetIds = Array.from({ length: rootIds.length }, (_, index) => id(11_000 + index));
  const members: Array<Record<string, unknown>> = [];
  const attachments: Array<Record<string, unknown>> = [];

  for (let index = 0; index < rootIds.length; index += 1) {
    members.push({
      nodeId: rootIds[index],
      kind: 'preference',
      subject: 'speaker',
      operator: 'like',
      polarity: 'affirmed',
      negation: 'none',
      targetNodeId: targetIds[index],
      attachmentNodeIds: [],
      evidence: sourceEvidence,
    });
    members.push({
      nodeId: targetIds[index],
      kind: 'presentation',
      value: 'table',
      evidence: sourceEvidence,
    });
    attachments.push({
      relation: 'targets',
      ownerNodeId: rootIds[index],
      targetNodeId: targetIds[index],
      evidence: sourceEvidence,
    });
  }

  for (let layer = 0; layer < layerCount - 1; layer += 1) {
    for (let owner = 0; owner < rootsPerLayer; owner += 1) {
      for (let target = 0; target < rootsPerLayer; target += 1) {
        attachments.push({
          relation: 'all_of',
          ownerNodeId: rootIds[layer * rootsPerLayer + owner],
          targetNodeId: rootIds[(layer + 1) * rootsPerLayer + target],
          evidence: sourceEvidence,
        });
      }
    }
  }

  return {
    bundleId: bundleId(500),
    relation: 'allOf',
    coupling: 'coupled',
    rootNodeIds: rootIds,
    members,
    attachments,
    evidence: sourceEvidence,
    coverage: 'complete',
  };
}

function rootWithBundles(
  bundles: unknown[],
  coverage: 'complete' | 'partial' | 'none' | 'unknown' = 'complete',
) {
  return {
    version: 2,
    descriptor,
    coverage,
    bundles,
    withheld: coverage === 'partial' ? [{ reason: 'unsupported_grammar' }] : [],
    reasons: [],
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function anyIssueContains(
  result: ReturnType<typeof CompositionalPreferenceV2Schema.safeParse>,
  text: string,
) {
  return !result.success && result.error.issues.some((issue) => issue.message.includes(text));
}

describe('CompositionalPreferenceV2Schema', () => {
  test('accepts the representative composition with bounded nodes, depth, and bytes', () => {
    const parsed = CompositionalPreferenceV2Schema.safeParse(makeCompound());
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const bundle = parsed.data.bundles[0];
    expect({
      serializedBytes: Buffer.byteLength(JSON.stringify(parsed.data), 'utf8'),
      nodes: bundle.members.length,
      edges: bundle.attachments.length,
      depth: 5,
      sourceBytes: Buffer.byteLength(RAW_COMPOUND, 'utf8'),
    }).toEqual({ serializedBytes: 7519, nodes: 11, edges: 10, depth: 5, sourceBytes: 99 });
    expect(bundle.members).toHaveLength(11);
    expect(Buffer.byteLength(JSON.stringify(parsed.data), 'utf8')).toBeLessThanOrEqual(32 * 1024);

    const edgeMap = new Map<string, string[]>();
    for (const edge of bundle.attachments) {
      const children = edgeMap.get(edge.ownerNodeId) ?? [];
      children.push(edge.targetNodeId);
      edgeMap.set(edge.ownerNodeId, children);
    }
    const depth = (nodeId: string, current: number): number =>
      Math.max(current, ...(edgeMap.get(nodeId) ?? []).map((child) => depth(child, current + 1)));
    expect(depth(bundle.rootNodeIds[0], 1)).toBe(5);
    expect(parsed.data.descriptor).toEqual({
      interpreterId: 'compositional-preferences',
      semanticVersion: 2,
      grammarVersion: 2,
      lexiconVersion: 2,
    });

    const independentOrdering = clone(makeCompound());
    independentOrdering.bundles[0].coupling = 'independent';
    expect(CompositionalPreferenceV2Schema.safeParse(independentOrdering).success).toBe(false);
  });

  test('keeps the operator and count mode enums distinct and rejects unknown versions/values', () => {
    const base = makeCompound();
    const invalidRootVersion = clone(base);
    invalidRootVersion.version = 1;
    expect(CompositionalPreferenceV2Schema.safeParse(invalidRootVersion).success).toBe(false);

    const invalidVersion = clone(base);
    Object.assign(invalidVersion.descriptor, { lexiconVersion: 1 });
    expect(CompositionalPreferenceV2Schema.safeParse(invalidVersion).success).toBe(false);

    const invalidLanguage = clone(base);
    invalidLanguage.bundles[0].members[2].base = 'Danish';
    expect(CompositionalPreferenceV2Schema.safeParse(invalidLanguage).success).toBe(false);

    const mixedEvidenceVersion = clone(base);
    Object.assign(mixedEvidenceVersion.bundles[0].members[0].evidence.descriptor, {
      interpreterId: 'literal-preferences',
    });
    expect(CompositionalPreferenceV2Schema.safeParse(mixedEvidenceVersion).success).toBe(false);

    for (const mode of ['as_stated', 'only', 'exactly'] as const) {
      const countMode = clone(base);
      countMode.bundles[0].members[7].mode = mode;
      expect(CompositionalPreferenceV2Schema.safeParse(countMode).success).toBe(true);
    }

    const invalidNegatedDislike = clone(base);
    Object.assign(invalidNegatedDislike.bundles[0].members[0], {
      operator: 'dislike',
      polarity: 'negated',
      negation: 'do_not',
    });
    expect(CompositionalPreferenceV2Schema.safeParse(invalidNegatedDislike).success).toBe(false);

    const invalidCountMode = clone(base);
    invalidCountMode.bundles[0].members[7].mode = 'maximum';
    expect(CompositionalPreferenceV2Schema.safeParse(invalidCountMode).success).toBe(false);

    const acceptedField = clone(base) as Record<string, unknown>;
    acceptedField.accepted = true;
    expect(CompositionalPreferenceV2Schema.safeParse(acceptedField).success).toBe(false);
  });

  test('requires opaque IDs, globally unique IDs, and references local to each bundle', () => {
    const nonOpaqueId = clone(makeCompound());
    nonOpaqueId.bundles[0].members[0].nodeId = 'speaker-prefers-tables';
    expect(CompositionalPreferenceV2Schema.safeParse(nonOpaqueId).success).toBe(false);

    const duplicateId = clone(makeCompound());
    duplicateId.bundles[0].members[2].nodeId = duplicateId.bundles[0].members[1].nodeId;
    expect(CompositionalPreferenceV2Schema.safeParse(duplicateId).success).toBe(false);

    const first = makeSimpleBundle(1);
    const second = makeSimpleBundle(2);
    const crossBundle = rootWithBundles([first, second]);
    const firstBundle = crossBundle.bundles[0] as {
      members: Array<Record<string, unknown>>;
      attachments: Array<Record<string, unknown>>;
    };
    firstBundle.members[0].targetNodeId = second.members[1].nodeId;
    firstBundle.attachments[0].targetNodeId = second.members[1].nodeId;
    expect(CompositionalPreferenceV2Schema.safeParse(crossBundle).success).toBe(false);
  });

  test('rejects wrong owner pairs, missing owners, and unsupported modifier combinations', () => {
    const wrongOwner = clone(makeCompound());
    wrongOwner.bundles[0].attachments.find((edge) => edge.relation === 'counts')!.ownerNodeId =
      id(2);
    expect(CompositionalPreferenceV2Schema.safeParse(wrongOwner).success).toBe(false);

    const missingOwner = clone(makeCompound());
    missingOwner.bundles[0].attachments = missingOwner.bundles[0].attachments.filter(
      (edge) => edge.targetNodeId !== id(9),
    );
    expect(CompositionalPreferenceV2Schema.safeParse(missingOwner).success).toBe(false);

    const twoOutputModifiers = clone(makeCompound());
    const newModifier = {
      nodeId: id(12),
      kind: 'length',
      value: 'short',
      evidence: evidence(RAW_COMPOUND, 'responses'),
    };
    twoOutputModifiers.bundles[0].members.push(newModifier);
    twoOutputModifiers.bundles[0].attachments.push({
      relation: 'modifies',
      ownerNodeId: id(2),
      targetNodeId: id(12),
      evidence: evidence(RAW_COMPOUND, 'responses'),
    });
    expect(CompositionalPreferenceV2Schema.safeParse(twoOutputModifiers).success).toBe(false);
  });

  test('rejects unapproved count, quantifier, qualifier, and output-language combinations', () => {
    const wrongCountAction = clone(makeCompound());
    wrongCountAction.bundles[0].members[4].value = 'definitions';
    expect(CompositionalPreferenceV2Schema.safeParse(wrongCountAction).success).toBe(false);

    const anyOnFirstOperand = clone(makeCompound());
    anyOnFirstOperand.bundles[0].members[3].operandNodeIds = [id(6), id(5)];
    anyOnFirstOperand.bundles[0].attachments.find(
      (edge) => edge.relation === 'quantifies',
    )!.ownerNodeId = id(5);
    expect(CompositionalPreferenceV2Schema.safeParse(anyOnFirstOperand).success).toBe(false);

    const wrongQualifier = clone(makeCompound());
    wrongQualifier.bundles[0].members[10].targetNodeId = id(5);
    expect(CompositionalPreferenceV2Schema.safeParse(wrongQualifier).success).toBe(false);

    const presentationPlusLanguage = clone(makeCompound());
    presentationPlusLanguage.bundles[0].members.push({
      nodeId: id(12),
      kind: 'presentation',
      value: 'bullets',
      evidence: evidence(RAW_COMPOUND, 'responses'),
    });
    presentationPlusLanguage.bundles[0].attachments.push({
      relation: 'presents',
      ownerNodeId: id(2),
      targetNodeId: id(12),
      evidence: evidence(RAW_COMPOUND, 'responses'),
    });
    expect(CompositionalPreferenceV2Schema.safeParse(presentationPlusLanguage).success).toBe(false);
  });

  test('rejects conjunction cycles and orphan semantic nodes', () => {
    const source = 'I like tables and I like prose.';
    const left = id(101);
    const right = id(102);
    const leftTarget = id(103);
    const rightTarget = id(104);
    const textEvidence = evidence(source, source.slice(0, -1));
    const conjunctionBundle = {
      bundleId: bundleId(50),
      relation: 'allOf',
      coupling: 'coupled',
      rootNodeIds: [left, right],
      members: [
        {
          nodeId: left,
          kind: 'preference',
          subject: 'speaker',
          operator: 'like',
          polarity: 'affirmed',
          negation: 'none',
          targetNodeId: leftTarget,
          attachmentNodeIds: [],
          evidence: textEvidence,
        },
        {
          nodeId: right,
          kind: 'preference',
          subject: 'speaker',
          operator: 'like',
          polarity: 'affirmed',
          negation: 'none',
          targetNodeId: rightTarget,
          attachmentNodeIds: [],
          evidence: textEvidence,
        },
        { nodeId: leftTarget, kind: 'presentation', value: 'table', evidence: textEvidence },
        { nodeId: rightTarget, kind: 'presentation', value: 'prose', evidence: textEvidence },
      ],
      attachments: [
        {
          relation: 'targets',
          ownerNodeId: left,
          targetNodeId: leftTarget,
          evidence: textEvidence,
        },
        {
          relation: 'targets',
          ownerNodeId: right,
          targetNodeId: rightTarget,
          evidence: textEvidence,
        },
        { relation: 'all_of', ownerNodeId: left, targetNodeId: right, evidence: textEvidence },
        { relation: 'all_of', ownerNodeId: right, targetNodeId: left, evidence: textEvidence },
      ],
      evidence: textEvidence,
      coverage: 'complete',
    };
    expect(
      CompositionalPreferenceV2Schema.safeParse(rootWithBundles([conjunctionBundle])).success,
    ).toBe(false);

    const orphan = clone(makeCompound());
    orphan.bundles[0].members.push({
      nodeId: id(99),
      kind: 'style',
      value: 'plain_language',
      evidence: evidence(RAW_COMPOUND, 'plain'),
    });
    expect(CompositionalPreferenceV2Schema.safeParse(orphan).success).toBe(false);
  });

  test('enforces the global depth limit on a validly typed allOf dependency chain', () => {
    const source = 'I like tables and I like prose and I like bullets and I like numbered steps.';
    const roots = Array.from({ length: 8 }, (_, index) => id(200 + index * 2));
    const targets = Array.from({ length: 8 }, (_, index) => id(201 + index * 2));
    const sharedEvidence = evidence(source, source);
    const members = roots.flatMap((preferenceId, index) => [
      {
        nodeId: preferenceId,
        kind: 'preference',
        subject: 'speaker',
        operator: 'like',
        polarity: 'affirmed',
        negation: 'none',
        targetNodeId: targets[index],
        attachmentNodeIds: [],
        evidence: sharedEvidence,
      },
      {
        nodeId: targets[index],
        kind: 'presentation',
        value: 'table',
        evidence: sharedEvidence,
      },
    ]);
    const attachments = roots.flatMap((preferenceId, index) => {
      const edges = [
        {
          relation: 'targets',
          ownerNodeId: preferenceId,
          targetNodeId: targets[index],
          evidence: sharedEvidence,
        },
      ];
      if (index > 0) {
        edges.push({
          relation: 'all_of',
          ownerNodeId: roots[index - 1],
          targetNodeId: preferenceId,
          evidence: sharedEvidence,
        });
      }
      return edges;
    });
    const bundle = {
      bundleId: bundleId(60),
      relation: 'allOf',
      coupling: 'coupled',
      rootNodeIds: roots,
      members,
      attachments,
      evidence: sharedEvidence,
      coverage: 'complete',
    };
    const parsed = CompositionalPreferenceV2Schema.safeParse(rootWithBundles([bundle]));
    expect(parsed.success).toBe(false);
    expect(anyIssueContains(parsed, 'depth cannot exceed eight')).toBe(true);
  });

  test('bounds traversal work linearly for a reconvergent allOf DAG', () => {
    const bundle = makeReconvergentAllOfBundle();
    expect(bundle.members).toHaveLength(56);
    expect(bundle.attachments).toHaveLength(124);

    const mapGetSpy = jest.spyOn(Map.prototype, 'get');
    let succeeded = true;
    let mapGetCount = 0;
    try {
      succeeded = CompositionalPreferenceV2BundleSchema.safeParse(bundle).success;
      mapGetCount = mapGetSpy.mock.calls.length;
    } finally {
      mapGetSpy.mockRestore();
    }

    expect(succeeded).toBe(false);
    expect(mapGetCount).toBeLessThanOrEqual(
      20 * (bundle.members.length + bundle.attachments.length),
    );
  });

  test('preflights bundle, global node, edge, cycle, and serialized metadata limits', () => {
    expect(
      CompositionalPreferenceV2Schema.safeParse(rootWithBundles(Array(33).fill({}))).success,
    ).toBe(false);

    const first = makeSimpleBundle(100);
    const second = makeSimpleBundle(200);
    for (let index = 0; index < 126; index += 1) {
      first.members.push({
        nodeId: id(1000 + index),
        kind: 'style',
        value: 'plain_language',
        evidence: evidence('I like tables.', 'I like'),
      });
    }
    const nodeOverflow = CompositionalPreferenceV2Schema.safeParse(
      rootWithBundles([first, second]),
    );
    expect(nodeOverflow.success).toBe(false);
    expect(anyIssueContains(nodeOverflow, 'Global semantic-node limit')).toBe(true);

    const edgeOverflow = clone(makeCompound());
    const edge = edgeOverflow.bundles[0].attachments[0];
    for (let index = 0; index < 119; index += 1) {
      edgeOverflow.bundles[0].attachments.push({ ...edge });
    }
    const edgeOverflowResult = CompositionalPreferenceV2Schema.safeParse(edgeOverflow);
    expect(edgeOverflowResult.success).toBe(false);
    expect(anyIssueContains(edgeOverflowResult, 'Global attachment-edge limit is 128')).toBe(true);

    const cyclic: Record<string, unknown> = rootWithBundles([]);
    cyclic.self = cyclic;
    expect(CompositionalPreferenceV2Schema.safeParse(cyclic).success).toBe(false);

    const largeText = 'x'.repeat(2000);
    const largeEvidence = {
      descriptor,
      spans: [{ content: { start: 0, end: 2000 }, raw: { start: 0, end: 2000 } }],
      lexicalForm: largeText,
    };
    const largeBundles = Array.from({ length: 6 }, (_, index) =>
      makeSimpleBundle(300 + index, largeText, largeEvidence),
    );
    const metadataOverflow = CompositionalPreferenceV2Schema.safeParse(
      rootWithBundles(largeBundles),
    );
    expect(metadataOverflow.success).toBe(false);
    expect(anyIssueContains(metadataOverflow, '32 KiB')).toBe(true);

    expect(CompositionalPreferenceV2Schema.safeParse(rootWithBundles([], 'complete')).success).toBe(
      false,
    );
  });

  test('admits exactly 32 KiB of serialized metadata and rejects the next byte', () => {
    const empty = rootWithBundles([], 'none');
    const emptyWithPadding = { ...empty, padding: '' };
    const serializedBaseBytes = Buffer.byteLength(JSON.stringify(emptyWithPadding), 'utf8');
    const exactLimit = {
      ...empty,
      padding: 'x'.repeat(32768 - serializedBaseBytes),
    };
    expect(Buffer.byteLength(JSON.stringify(exactLimit), 'utf8')).toBe(32768);
    expect(snapshotBoundedCompositionalJson(exactLimit, 32768)).toEqual(exactLimit);

    const atLimit = CompositionalPreferenceV2Schema.safeParse(exactLimit);
    expect(atLimit.success).toBe(false);
    expect(anyIssueContains(atLimit, '32 KiB')).toBe(false);

    const overLimit = { ...exactLimit, padding: `${exactLimit.padding}x` };
    expect(Buffer.byteLength(JSON.stringify(overLimit), 'utf8')).toBe(32769);
    expect(snapshotBoundedCompositionalJson(overLimit, 32768)).toBeUndefined();
    const overLimitResult = CompositionalPreferenceV2Schema.safeParse(overLimit);
    expect(overLimitResult.success).toBe(false);
    expect(anyIssueContains(overLimitResult, '32 KiB')).toBe(true);
  });

  test('caps preference predicates across bundles before nested AST validation', () => {
    const oneOversizedBundle = CompositionalPreferenceV2Schema.safeParse(
      rootWithBundles([makeAllOfBundle(0, 33)]),
    );
    expect(oneOversizedBundle.success).toBe(false);
    expect(anyIssueContains(oneOversizedBundle, 'Global preference-predicate limit is 32')).toBe(
      true,
    );

    const sizes = [5, 5, 5, 5, 5, 4, 4];
    const bundles = sizes.map((size, index) => makeAllOfBundle(index, size));
    const result = CompositionalPreferenceV2Schema.safeParse(rootWithBundles(bundles));
    expect(result.success).toBe(false);
    expect(anyIssueContains(result, 'Global preference-predicate limit is 32')).toBe(true);
    expect(sizes.reduce((sum, size) => sum + size, 0)).toBe(33);
  });

  test('preflights huge lexical and unknown AST strings without serializing or scanning them', () => {
    const huge = 'x'.repeat(1000000);
    for (const extraField of [false, true]) {
      const ast = makeCompound();
      const candidate = extraField ? { ...ast, unknown: huge } : ast;
      if (!extraField) ast.bundles[0].members[0].evidence.lexicalForm = huge;
      const stringify = jest.spyOn(JSON, 'stringify');
      const byteLength = jest.spyOn(Buffer, 'byteLength');
      try {
        expect(CompositionalPreferenceV2Schema.safeParse(candidate).success).toBe(false);
        expect(stringify.mock.calls.some(([value]) => value === candidate || value === huge)).toBe(
          false,
        );
        expect(byteLength.mock.calls.some(([value]) => value === huge)).toBe(false);
      } finally {
        stringify.mockRestore();
        byteLength.mockRestore();
      }
    }
  });

  test('bounds unknown AST JSON depth and snapshots own data without getter reaccess', () => {
    let descriptorReads = 0;
    let nested: unknown = null;
    for (let index = 0; index < 10000; index++) {
      nested = new Proxy(
        { child: nested },
        {
          getOwnPropertyDescriptor(target, property) {
            descriptorReads++;
            return Reflect.getOwnPropertyDescriptor(target, property);
          },
        },
      );
    }
    expect(
      CompositionalPreferenceV2Schema.safeParse({ ...makeCompound(), unknown: nested }).success,
    ).toBe(false);
    expect(descriptorReads).toBeLessThanOrEqual(128);
    let getterReads = 0;
    const accessor = makeCompound();
    Object.defineProperty(accessor, 'unknown', {
      enumerable: true,
      get() {
        getterReads++;
        return nested;
      },
    });
    expect(CompositionalPreferenceV2Schema.safeParse(accessor).success).toBe(false);
    expect(getterReads).toBe(0);
    const data = makeCompound();
    const proxy = new Proxy(data, {
      get(target, property, receiver) {
        if (
          ['version', 'descriptor', 'coverage', 'bundles', 'withheld', 'reasons'].includes(
            String(property),
          )
        ) {
          throw new Error('Original data property must not be reread');
        }
        return Reflect.get(target, property, receiver);
      },
    });
    expect(CompositionalPreferenceV2Schema.safeParse(proxy).success).toBe(true);
  });

  test('snapshots only own JSON properties without enumerating a wide inherited prototype', () => {
    const inherited: Record<string, number> = Object.create(null);
    for (let index = 0; index < 100000; index++) inherited[`inherited${index}`] = 0;
    let inheritedEnumerations = 0;
    const prototype = new Proxy(inherited, {
      ownKeys() {
        inheritedEnumerations++;
        throw new Error('Inherited keys must not be enumerated');
      },
    });
    const ast = Object.assign(Object.create(prototype), makeCompound());
    expect(CompositionalPreferenceV2Schema.safeParse(ast).success).toBe(true);
    const envelope = Object.assign(Object.create(prototype), makeEnvelope(RAW_COMPOUND));
    expect(
      validateCompositionalPreferenceV2Evidence({
        preference: ast,
        rawContent: RAW_COMPOUND,
        mappedContent: RAW_COMPOUND,
        envelope,
      }),
    ).toEqual({ ok: true });
    expect(inheritedEnumerations).toBe(0);
  });

  test('returns fixed failures for throwing descriptor and prototype inspection traps', () => {
    const descriptorTrap = new Proxy(makeEnvelope(RAW_COMPOUND), {
      getOwnPropertyDescriptor() {
        throw new Error('Untrusted descriptor text');
      },
    });
    const prototypeTrap = new Proxy(makeEnvelope(RAW_COMPOUND), {
      getPrototypeOf() {
        throw new Error('Untrusted prototype text');
      },
    });
    for (const envelope of [descriptorTrap, prototypeTrap]) {
      expect(snapshotBoundedCompositionalJson(envelope, 16384)).toBeUndefined();
      expect(
        validateCompositionalPreferenceV2Evidence({
          preference: makeCompound(),
          rawContent: RAW_COMPOUND,
          mappedContent: RAW_COMPOUND,
          envelope,
        }),
      ).toEqual({ ok: false, reason: 'invalid_envelope' });
    }
    const ast = new Proxy(makeCompound(), {
      getOwnPropertyDescriptor() {
        throw new Error('Untrusted AST text');
      },
    });
    expect(CompositionalPreferenceV2Schema.safeParse(ast).success).toBe(false);
  });
});

describe('validateCompositionalPreferenceV2Evidence', () => {
  test('accepts exact evidence and hashes for the full mapped body', () => {
    const ast = makeCompound();
    expect(
      validateCompositionalPreferenceV2Evidence({
        preference: ast,
        rawContent: RAW_COMPOUND,
        mappedContent: RAW_COMPOUND,
        envelope: makeEnvelope(RAW_COMPOUND),
      }),
    ).toEqual({ ok: true });
  });

  test('accepts ascending disjoint spans only when lexicalForm is their exact concatenation', () => {
    const ast = makeCompound();
    const languageNode = ast.bundles[0].members[2];
    const australianStart = RAW_COMPOUND.indexOf('Australian');
    const englishStart = RAW_COMPOUND.indexOf('English', australianStart);
    languageNode.evidence.spans = [
      {
        content: { start: australianStart, end: australianStart + 'Australian'.length },
        raw: { start: australianStart, end: australianStart + 'Australian'.length },
      },
      {
        content: { start: englishStart, end: englishStart + 'English'.length },
        raw: { start: englishStart, end: englishStart + 'English'.length },
      },
    ];
    languageNode.evidence.lexicalForm = 'AustralianEnglish';
    expect(
      validateCompositionalPreferenceV2Evidence({
        preference: ast,
        rawContent: RAW_COMPOUND,
        mappedContent: RAW_COMPOUND,
        envelope: makeEnvelope(RAW_COMPOUND),
      }),
    ).toEqual({ ok: true });
  });

  test('rejects overlapping and reversed evidence spans at schema validation', () => {
    const reversed = clone(makeCompound());
    const language = reversed.bundles[0].members[2];
    const australianStart = RAW_COMPOUND.indexOf('Australian');
    const englishStart = RAW_COMPOUND.indexOf('English', australianStart);
    language.evidence.spans = [
      {
        content: { start: englishStart, end: englishStart + 'English'.length },
        raw: { start: englishStart, end: englishStart + 'English'.length },
      },
      {
        content: { start: australianStart, end: australianStart + 'Australian'.length },
        raw: { start: australianStart, end: australianStart + 'Australian'.length },
      },
    ];
    language.evidence.lexicalForm = 'EnglishAustralian';
    expect(CompositionalPreferenceV2Schema.safeParse(reversed).success).toBe(false);

    const overlapping = clone(makeCompound());
    const overlapLanguage = overlapping.bundles[0].members[2];
    overlapLanguage.evidence.spans = [
      {
        content: { start: australianStart, end: englishStart + 1 },
        raw: { start: australianStart, end: englishStart + 1 },
      },
      {
        content: { start: englishStart, end: englishStart + 'English'.length },
        raw: { start: englishStart, end: englishStart + 'English'.length },
      },
    ];
    overlapLanguage.evidence.lexicalForm = 'AustralianEnglish';
    expect(CompositionalPreferenceV2Schema.safeParse(overlapping).success).toBe(false);
  });

  test('rejects altered source bytes, evidence text, missing mapping tails, and forged raw offsets', () => {
    const ast = makeCompound();
    const alteredSource = `${RAW_COMPOUND} extra`;
    expect(
      validateCompositionalPreferenceV2Evidence({
        preference: ast,
        rawContent: alteredSource,
        mappedContent: RAW_COMPOUND,
        envelope: makeEnvelope(RAW_COMPOUND),
      }),
    ).toEqual({ ok: false, reason: 'content_mismatch' });

    const alteredEvidence = clone(ast);
    alteredEvidence.bundles[0].members[0].evidence.lexicalForm = 'I prefer';
    expect(
      validateCompositionalPreferenceV2Evidence({
        preference: alteredEvidence,
        rawContent: RAW_COMPOUND,
        mappedContent: RAW_COMPOUND,
        envelope: makeEnvelope(RAW_COMPOUND),
      }),
    ).toEqual({ ok: false, reason: 'content_mismatch' });

    const incomplete = makeEnvelope(RAW_COMPOUND);
    incomplete.mappings[0].contentEnd -= 1;
    incomplete.mappings[0].rawEnd -= 1;
    incomplete.humanRegion.end -= 1;
    const incompleteResult = validateCompositionalPreferenceV2Evidence({
      preference: ast,
      rawContent: RAW_COMPOUND,
      mappedContent: RAW_COMPOUND,
      envelope: incomplete,
    });
    expect(incompleteResult).toEqual({ ok: false, reason: 'incomplete_mapping' });

    const wrapper = 'system 🧪: ';
    const rawContent = wrapper + RAW_COMPOUND + 'x';
    const wrongRawOffset = makeEnvelope(RAW_COMPOUND, rawContent, wrapper.length + 1);
    const wrongOffsetResult = validateCompositionalPreferenceV2Evidence({
      preference: makeCompound(RAW_COMPOUND, wrapper.length + 1),
      rawContent,
      mappedContent: RAW_COMPOUND,
      envelope: wrongRawOffset,
    });
    expect(wrongOffsetResult).toEqual({ ok: false, reason: 'content_mismatch' });
  });

  test('converts content quote offsets through the raw mapping and rejects quoted evidence', () => {
    const content = `🧪 ${RAW_COMPOUND}`;
    const wrapper = 'system 🧪: ';
    const rawContent = wrapper + content;
    const rawOffset = wrapper.length;
    const quotedStart = content.indexOf('technical');
    const quote = { start: quotedStart, end: quotedStart + 'technical'.length };
    const result = validateCompositionalPreferenceV2Evidence({
      preference: makeCompound(content, rawOffset),
      rawContent,
      mappedContent: content,
      envelope: makeEnvelope(content, rawContent, rawOffset, [quote]),
    });
    expect({
      mappedUtf16: content.length,
      rawUtf16: rawContent.length,
      rawOffsetUtf16: rawOffset,
      mappedBytes: Buffer.byteLength(content, 'utf8'),
      rawBytes: Buffer.byteLength(rawContent, 'utf8'),
      mappedQuoteSpan: quote,
      rawQuoteSpan: { start: rawOffset + quote.start, end: rawOffset + quote.end },
    }).toEqual({
      mappedUtf16: 102,
      rawUtf16: 113,
      rawOffsetUtf16: 11,
      mappedBytes: 104,
      rawBytes: 117,
      mappedQuoteSpan: { start: 86, end: 95 },
      rawQuoteSpan: { start: 97, end: 106 },
    });
    expect(result).toEqual({ ok: false, reason: 'quoted_content' });
  });

  test('rejects span endpoints inside UTF-16 surrogate pairs and out-of-range withheld spans', () => {
    const content = `🧪 ${RAW_COMPOUND}`;
    const ast = makeCompound(content);
    ast.bundles[0].evidence.spans[0].content.start = 1;
    ast.bundles[0].evidence.spans[0].raw.start = 1;
    const boundaryResult = validateCompositionalPreferenceV2Evidence({
      preference: ast,
      rawContent: content,
      mappedContent: content,
      envelope: makeEnvelope(content),
    });
    expect(boundaryResult).toEqual({ ok: false, reason: 'invalid_unicode' });

    const partial = makeCompound() as {
      coverage: 'complete' | 'partial' | 'none' | 'unknown';
      withheld: Array<{ reason: string; sourceRegion?: { start: number; end: number } }>;
    };
    partial.coverage = 'partial';
    partial.withheld = [{ reason: 'unsupported_grammar', sourceRegion: { start: 0, end: 500 } }];
    const withheldResult = validateCompositionalPreferenceV2Evidence({
      preference: partial,
      rawContent: RAW_COMPOUND,
      mappedContent: RAW_COMPOUND,
      envelope: makeEnvelope(RAW_COMPOUND),
    });
    expect(withheldResult).toEqual({ ok: false, reason: 'invalid_unicode' });
  });

  test('rejects oversized envelope arrays before visiting their entries', () => {
    let entryReads = 0;
    const large = new Proxy(new Array(100000), {
      get(target, property, receiver) {
        if (/^\d+$/.test(String(property))) entryReads++;
        return Reflect.get(target, property, receiver);
      },
      getOwnPropertyDescriptor(target, property) {
        if (/^\d+$/.test(String(property))) entryReads++;
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    });
    for (const field of ['mappings', 'quoteRegions'] as const) {
      const envelope = { ...makeEnvelope(RAW_COMPOUND), [field]: large };
      expect(
        validateCompositionalPreferenceV2Evidence({
          preference: makeCompound(),
          rawContent: RAW_COMPOUND,
          mappedContent: RAW_COMPOUND,
          envelope,
        }),
      ).toEqual({ ok: false, reason: 'invalid_envelope' });
    }
    const combined = {
      ...makeEnvelope(RAW_COMPOUND),
      quoteRegions: new Array(32).fill({ start: 0, end: 1 }),
    };
    expect(
      validateCompositionalPreferenceV2Evidence({
        preference: makeCompound(),
        rawContent: RAW_COMPOUND,
        mappedContent: RAW_COMPOUND,
        envelope: combined,
      }),
    ).toEqual({ ok: false, reason: 'invalid_envelope' });
    expect(entryReads).toBe(0);
  });

  test('bounds nested and wide unknown envelope traversal without invoking accessors', () => {
    let descriptorReads = 0;
    let nested: unknown = null;
    for (let index = 0; index < 10000; index++) {
      nested = new Proxy(
        { child: nested },
        {
          getOwnPropertyDescriptor(target, property) {
            descriptorReads++;
            return Reflect.getOwnPropertyDescriptor(target, property);
          },
        },
      );
    }
    const check = (envelope: unknown) =>
      validateCompositionalPreferenceV2Evidence({
        preference: makeCompound(),
        rawContent: RAW_COMPOUND,
        mappedContent: RAW_COMPOUND,
        envelope,
      });
    expect(check({ ...makeEnvelope(RAW_COMPOUND), unknown: nested })).toEqual({
      ok: false,
      reason: 'invalid_envelope',
    });
    expect(descriptorReads).toBeLessThanOrEqual(64);

    let wideReads = 0;
    const wideRecord: Record<string, number> = Object.create(null);
    for (let index = 0; index < 10000; index++) wideRecord[`k${index}`] = 0;
    const wide = new Proxy(wideRecord, {
      getOwnPropertyDescriptor(target, property) {
        wideReads++;
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    });
    expect(check({ ...makeEnvelope(RAW_COMPOUND), unknown: wide })).toEqual({
      ok: false,
      reason: 'invalid_envelope',
    });
    expect(wideReads).toBeLessThanOrEqual(3 * 1024);

    let getterReads = 0;
    const accessor = { ...makeEnvelope(RAW_COMPOUND) };
    Object.defineProperty(accessor, 'unknown', {
      enumerable: true,
      get() {
        getterReads++;
        return nested;
      },
    });
    expect(check(accessor)).toEqual({ ok: false, reason: 'invalid_envelope' });
    expect(getterReads).toBe(0);

    const cyclic: Record<string, unknown> = { ...makeEnvelope(RAW_COMPOUND) };
    cyclic.unknown = cyclic;
    expect(check(cyclic)).toEqual({ ok: false, reason: 'invalid_envelope' });
  });

  test('rejects huge envelope strings before whole-input serialization or UTF-8 scanning', () => {
    const huge = 'x'.repeat(1000000);
    const envelope = { ...makeEnvelope(RAW_COMPOUND), unknown: huge };
    const stringify = jest.spyOn(JSON, 'stringify');
    const byteLength = jest.spyOn(Buffer, 'byteLength');
    let result: ReturnType<typeof validateCompositionalPreferenceV2Evidence>;
    try {
      result = validateCompositionalPreferenceV2Evidence({
        preference: makeCompound(),
        rawContent: RAW_COMPOUND,
        mappedContent: RAW_COMPOUND,
        envelope,
      });
      expect(stringify.mock.calls.some(([value]) => value === envelope || value === huge)).toBe(
        false,
      );
      expect(byteLength.mock.calls.some(([value]) => value === huge)).toBe(false);
    } finally {
      stringify.mockRestore();
      byteLength.mockRestore();
    }
    expect(result!).toEqual({ ok: false, reason: 'invalid_envelope' });
  });

  test('rejects over-limit source, invalid envelope shape, and evidence with stitched slices', () => {
    const tooLarge = 'x'.repeat(65537);
    expect(
      validateCompositionalPreferenceV2Evidence({
        preference: makeCompound(),
        rawContent: tooLarge,
        mappedContent: RAW_COMPOUND,
        envelope: makeEnvelope(RAW_COMPOUND),
      }),
    ).toEqual({ ok: false, reason: 'source_too_large' });

    expect(
      validateCompositionalPreferenceV2Evidence({
        preference: makeCompound(),
        rawContent: RAW_COMPOUND,
        mappedContent: RAW_COMPOUND,
        envelope: { ...makeEnvelope(RAW_COMPOUND), version: 2 },
      }),
    ).toEqual({ ok: false, reason: 'invalid_envelope' });

    const stitched = clone(makeCompound());
    const evidenceNode = stitched.bundles[0].members[0].evidence;
    evidenceNode.spans = [
      {
        content: { start: 0, end: 1 },
        raw: { start: 0, end: 1 },
      },
      {
        content: { start: 2, end: 6 },
        raw: { start: 2, end: 6 },
      },
    ];
    evidenceNode.lexicalForm = 'I like';
    expect(
      validateCompositionalPreferenceV2Evidence({
        preference: stitched,
        rawContent: RAW_COMPOUND,
        mappedContent: RAW_COMPOUND,
        envelope: makeEnvelope(RAW_COMPOUND),
      }),
    ).toEqual({ ok: false, reason: 'content_mismatch' });
  });
});
