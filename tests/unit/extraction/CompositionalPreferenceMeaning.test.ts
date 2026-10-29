import { createHash } from 'crypto';
import {
  COMPOSITIONAL_PREFERENCE_DESCRIPTOR,
  type CompositionalPreference,
} from '../../../src/schemas/CompositionalPreference.schema';
import {
  CompositionalPreferenceMeaningProjectionResultSchema,
  CompositionalPreferenceMeaningSchema,
} from '../../../src/schemas/CompositionalPreferenceMeaning.schema';
import { projectCompositionalPreferenceMeaning } from '../../../src/extraction/CompositionalPreferenceMeaning';
import { interpretCompositionalPreferences } from '../../../src/extraction/CompositionalPreferenceParser';

const SUBJECT_ID = '11111111-1111-4111-8111-111111111111';
const BINDING_ID = '22222222-2222-4222-8222-222222222222';

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function preferenceFromSource(source: string): CompositionalPreference {
  const envelope = {
    version: 1 as const,
    namespace: 'tenant-test',
    issuer: 'test-adapter',
    actorReference: 'actor-1',
    bindingRef: {
      bindingId: BINDING_ID,
      revision: 1,
      subjectId: SUBJECT_ID,
      fingerprint: 'a'.repeat(64),
    },
    contentHash: sha256(source),
    rawContentHash: sha256(source),
    mappingAuthority: 'whole_source' as const,
    humanRegion: { start: 0, end: source.length },
    mappings: [{ contentStart: 0, contentEnd: source.length, rawStart: 0, rawEnd: source.length }],
    quoteRegions: [],
    explicitIntent: false,
  };
  return interpretCompositionalPreferences({
    descriptor: { ...COMPOSITIONAL_PREFERENCE_DESCRIPTOR },
    rawContent: source,
    mappedContent: source,
    envelope,
  });
}

function project(
  source: string,
  options: { namespace?: string; subjectId?: string; check?: () => void } = {},
) {
  return projectCompositionalPreferenceMeaning({
    preference: preferenceFromSource(source),
    namespace: options.namespace ?? 'tenant-test',
    subjectId: options.subjectId ?? SUBJECT_ID,
    ...(options.check === undefined ? {} : { check: options.check }),
  });
}

function allOfWithThreeRoots(source: CompositionalPreference): CompositionalPreference {
  const [first, second, third] = source.bundles;
  if (!first || !second || !third) throw new Error('Fixture needs three independent bundles');
  const firstRoot = first.rootNodeIds[0];
  const secondRoot = second.rootNodeIds[0];
  const thirdRoot = third.rootNodeIds[0];
  if (!firstRoot || !secondRoot || !thirdRoot) throw new Error('Fixture roots are required');
  const conjunctionEdges = [secondRoot, thirdRoot].map((targetNodeId) => ({
    relation: 'all_of' as const,
    ownerNodeId: firstRoot,
    targetNodeId,
    evidence: first.evidence,
  }));
  return {
    ...source,
    bundles: [
      {
        bundleId: `b_${'f'.repeat(32)}`,
        relation: 'allOf',
        coupling: 'coupled',
        rootNodeIds: [firstRoot, secondRoot, thirdRoot],
        members: source.bundles.flatMap((bundle) => bundle.members),
        attachments: [
          ...source.bundles.flatMap((bundle) => bundle.attachments),
          ...conjunctionEdges,
        ],
        evidence: first.evidence,
        coverage: 'complete',
      },
    ],
  };
}

describe('projectCompositionalPreferenceMeaning', () => {
  it('projects the G18 graph into a bounded source-free meaning key', () => {
    const result = project(
      'I like responses in plain Australian English, with one worked example ahead of any technical terms.',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.meaning).toMatchObject({
      version: 1,
      descriptor: {
        interpreterId: 'compositional-preferences',
        semanticVersion: 1,
        grammarVersion: 1,
        lexiconVersion: 1,
      },
      namespace: 'tenant-test',
      subjectId: SUBJECT_ID,
    });
    expect(result.meaning.bundles).toHaveLength(1);
    const json = JSON.stringify(result.meaning);
    expect(Buffer.byteLength(json, 'utf8')).toBeLessThanOrEqual(32 * 1024);
    expect(json).not.toContain('nodeId');
    expect(json).not.toContain('bundleId');
    expect(json).not.toContain('lexicalForm');
    expect(json).not.toContain('responses in plain Australian English');
    expect(result.canonicalJson).toBe(json);
    expect(result.fingerprint).toBe(sha256(json));
    expect(CompositionalPreferenceMeaningProjectionResultSchema.safeParse(result).success).toBe(
      true,
    );
  });

  it.each([
    [
      'I prefer definitions after one worked example.',
      'I prefer one worked example before definitions.',
    ],
    ['I prefer examples ahead of definitions.', 'I prefer examples before definitions.'],
    ["I don't prefer French.", 'I do not prefer French.'],
    ['I prefer Australian English.', 'I prefer English (Australian).'],
  ])('canonicalizes only the reviewed alias or inverse: %s', (left, right) => {
    const leftResult = project(left);
    const rightResult = project(right);
    expect(leftResult.ok).toBe(true);
    expect(rightResult.ok).toBe(true);
    if (leftResult.ok && rightResult.ok) {
      expect(leftResult.canonicalJson).toBe(rightResult.canonicalJson);
    }
  });

  it('ignores evidence IDs and offsets while retaining the complete meaning', () => {
    const plain = preferenceFromSource('I prefer French.');
    const shifted = preferenceFromSource('   I prefer French.');
    expect(plain.bundles[0]?.members.map((node) => node.nodeId)).not.toEqual(
      shifted.bundles[0]?.members.map((node) => node.nodeId),
    );

    const left = projectCompositionalPreferenceMeaning({
      preference: plain,
      namespace: 'tenant-test',
      subjectId: SUBJECT_ID,
    });
    const right = projectCompositionalPreferenceMeaning({
      preference: shifted,
      namespace: 'tenant-test',
      subjectId: SUBJECT_ID,
    });
    expect(left.ok).toBe(true);
    expect(right.ok).toBe(true);
    if (left.ok && right.ok) expect(left.canonicalJson).toBe(right.canonicalJson);
  });

  it('treats independent bundles as an unordered set', () => {
    const left = project('I prefer French. I like tables.');
    const right = project('I like tables. I prefer French.');
    expect(left.ok).toBe(true);
    expect(right.ok).toBe(true);
    if (left.ok && right.ok) expect(left.canonicalJson).toBe(right.canonicalJson);
  });

  it('canonicalizes allOf child roots independent of root, node, and edge array order', () => {
    const parsed = preferenceFromSource(
      'I prefer French. I like tables. I prefer concise explanations.',
    );
    const original = allOfWithThreeRoots(parsed);
    const bundle = original.bundles[0]!;
    const permuted: CompositionalPreference = {
      ...original,
      bundles: [
        {
          ...bundle,
          rootNodeIds: [bundle.rootNodeIds[0]!, bundle.rootNodeIds[2]!, bundle.rootNodeIds[1]!],
          members: [...bundle.members].reverse(),
          attachments: [...bundle.attachments].reverse(),
        },
      ],
    };
    const originalResult = projectCompositionalPreferenceMeaning({
      preference: original,
      namespace: 'tenant-test',
      subjectId: SUBJECT_ID,
    });
    const permutedResult = projectCompositionalPreferenceMeaning({
      preference: permuted,
      namespace: 'tenant-test',
      subjectId: SUBJECT_ID,
    });
    expect(originalResult.ok).toBe(true);
    expect(permutedResult.ok).toBe(true);
    if (originalResult.ok && permutedResult.ok) {
      expect(originalResult.canonicalJson).toBe(permutedResult.canonicalJson);
    }
  });

  it('changes the key when a reviewed semantic qualifier changes', () => {
    const comparisons: Array<[string, string]> = [
      ['I prefer one worked example.', 'I prefer only one worked example.'],
      ['I prefer one worked example.', 'I prefer exactly one worked example.'],
      ['I prefer one worked example.', 'I prefer one practical example.'],
      ['I prefer Australian English.', 'I prefer British English.'],
      ['I prefer Australian English.', 'I prefer plain Australian English.'],
      ['I prefer examples before definitions.', 'I prefer definitions before examples.'],
      ['I prefer examples before definitions.', 'I prefer examples followed by definitions.'],
      ['I prefer examples before definitions.', 'I prefer examples before any definitions.'],
      ['I prefer examples before terminology.', 'I prefer examples before technical terminology.'],
      [
        'I prefer technical definitions before terminology.',
        'I prefer definitions before technical terminology.',
      ],
      [
        'I prefer definitions first, then examples.',
        'I prefer definitions first, then examples on request.',
      ],
      ['I prefer detailed explanations.', 'I prefer detailed explanations on request.'],
      [
        'For summaries, I prefer concise explanations.',
        'For planning, I prefer concise explanations.',
      ],
      ['I prefer concise explanations.', 'I like concise explanations.'],
    ];
    for (const [leftSource, rightSource] of comparisons) {
      const left = project(leftSource);
      const right = project(rightSource);
      expect(left.ok).toBe(true);
      expect(right.ok).toBe(true);
      if (left.ok && right.ok) expect(left.canonicalJson).not.toBe(right.canonicalJson);
    }
  });

  it('binds keys to the supplied namespace and verified subject UUID', () => {
    const baseline = project('I prefer concise explanations.');
    const otherNamespace = project('I prefer concise explanations.', {
      namespace: 'another-tenant',
    });
    const otherSubject = project('I prefer concise explanations.', {
      subjectId: '33333333-3333-4333-8333-333333333333',
    });
    expect(baseline.ok && otherNamespace.ok && otherSubject.ok).toBe(true);
    if (baseline.ok && otherNamespace.ok && otherSubject.ok) {
      expect(otherNamespace.canonicalJson).not.toBe(baseline.canonicalJson);
      expect(otherSubject.canonicalJson).not.toBe(baseline.canonicalJson);
    }
  });

  it('preserves relation kind and frequency absence as distinct meaning', () => {
    const before = project('I prefer examples before definitions.');
    const followedBy = project('I prefer examples followed by definitions.');
    const usually = project('I usually prefer examples before definitions.');
    expect(before.ok && followedBy.ok && usually.ok).toBe(true);
    if (before.ok && followedBy.ok && usually.ok) {
      expect(followedBy.canonicalJson).not.toBe(before.canonicalJson);
      expect(usually.canonicalJson).not.toBe(before.canonicalJson);
    }
  });

  it('validates typed meaning ownership and rejects invalid meaning graphs', () => {
    const valid = project('I prefer French.');
    expect(valid.ok).toBe(true);
    if (!valid.ok) return;
    expect(CompositionalPreferenceMeaningSchema.safeParse(valid.meaning).success).toBe(true);

    const bundle = valid.meaning.bundles[0]!;
    const preference = bundle.nodes.find((node) => node.kind === 'preference')!;
    const language = bundle.nodes.find((node) => node.kind === 'language')!;
    const invalidOwner = {
      ...valid.meaning,
      bundles: [
        {
          ...bundle,
          edges: bundle.edges.map((edge) =>
            edge.relation === 'targets' ? { ...edge, ownerPath: language.path } : edge,
          ),
        },
      ],
    };
    expect(CompositionalPreferenceMeaningSchema.safeParse(invalidOwner).success).toBe(false);

    const invalidTarget = {
      ...valid.meaning,
      bundles: [
        {
          ...bundle,
          nodes: bundle.nodes.map((node) =>
            node.kind === 'language' ? { ...node, languageTag: 'fr-CA' } : node,
          ),
        },
      ],
    };
    expect(CompositionalPreferenceMeaningSchema.safeParse(invalidTarget).success).toBe(false);
    expect(preference.kind).toBe('preference');
  });

  it('rejects cycles and detached meaning nodes', () => {
    const parsed = preferenceFromSource(
      'I prefer French. I like tables. I prefer concise explanations.',
    );
    const allOf = allOfWithThreeRoots(parsed);
    const projected = projectCompositionalPreferenceMeaning({
      preference: allOf,
      namespace: 'tenant-test',
      subjectId: SUBJECT_ID,
    });
    expect(projected.ok).toBe(true);
    if (!projected.ok) return;
    const valid = projected;
    expect(valid.ok).toBe(true);
    if (!valid.ok) return;
    const bundle = valid.meaning.bundles[0]!;
    const preferenceRoots = bundle.rootPaths;
    const firstRoot = preferenceRoots[0]!;
    const secondRoot = preferenceRoots[1]!;
    const language = bundle.nodes.find((node) => node.kind === 'language')!;
    const cycle = {
      ...valid.meaning,
      bundles: [
        {
          ...bundle,
          edges: [
            ...bundle.edges,
            { relation: 'all_of', ownerPath: secondRoot, targetPath: firstRoot },
          ],
        },
      ],
    };
    expect(CompositionalPreferenceMeaningSchema.safeParse(cycle).success).toBe(false);

    const orphan = {
      ...valid.meaning,
      bundles: [
        {
          ...bundle,
          nodes: bundle.nodes.filter((node) => node.path !== language.path),
        },
      ],
    };
    expect(CompositionalPreferenceMeaningSchema.safeParse(orphan).success).toBe(false);
  });

  it('rejects metadata beyond the bounded snapshot without serializing untrusted hooks', () => {
    const baseline = project('I prefer French.');
    expect(baseline.ok).toBe(true);
    if (!baseline.ok) return;

    const oversized = {
      ...baseline.meaning,
      namespace: 'x'.repeat(40_000),
    };
    expect(CompositionalPreferenceMeaningSchema.safeParse(oversized).success).toBe(false);

    let getterCalled = false;
    const getterInput = Object.defineProperty({}, 'version', {
      enumerable: true,
      get() {
        getterCalled = true;
        return 1;
      },
    });
    expect(CompositionalPreferenceMeaningSchema.safeParse(getterInput).success).toBe(false);
    expect(getterCalled).toBe(false);
  });

  it('fails closed on invalid ASTs and propagates cancellation', () => {
    const invalid = projectCompositionalPreferenceMeaning({
      preference: { version: 2, bundles: [] },
      namespace: 'tenant-test',
      subjectId: SUBJECT_ID,
    });
    expect(invalid).toMatchObject({ ok: false, reason: 'invalid_ast_integrity' });

    const oversized = projectCompositionalPreferenceMeaning({
      preference: { source: 'x'.repeat(40_000) },
      namespace: 'tenant-test',
      subjectId: SUBJECT_ID,
    });
    expect(oversized).toMatchObject({ ok: false, reason: 'metadata_too_large' });

    const cancellation = new Error('cancelled');
    const preference = preferenceFromSource('I prefer French.');
    expect(() =>
      projectCompositionalPreferenceMeaning({
        preference,
        namespace: 'tenant-test',
        subjectId: SUBJECT_ID,
        check: () => {
          throw cancellation;
        },
      }),
    ).toThrow(cancellation);

    let checks = 0;
    expect(() =>
      projectCompositionalPreferenceMeaning({
        preference,
        namespace: 'tenant-test',
        subjectId: SUBJECT_ID,
        check: () => {
          checks += 1;
          if (checks === 10) throw cancellation;
        },
      }),
    ).toThrow(cancellation);
  });
});
