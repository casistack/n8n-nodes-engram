import { createHash } from 'crypto';
import { hashAutomaticCaptureV2 } from '../../../src/schemas/AutomaticCapture.schema';
import {
  AutonomousPersonalClaimV3KeyInputOwnedDataSchema,
  AutonomousPersonalClaimV3OwnedDataSchema,
  AutonomousPersonalClaimV3Schema,
  AutonomousPersonalValueMarkerV3OwnedDataSchema,
  AutonomousPersonalValueMarkerV3Schema,
  hashAutonomousPersonalClaimEvidenceV3,
  hashAutonomousPersonalClaimKeyV3,
  hashAutonomousPersonalClaimMeaningV3,
  hashAutonomousPersonalPredicateDependencyV1,
  hashAutonomousPersonalSourceUnitIdV1,
} from '../../../src/schemas/AutonomousPersonalClaimV3.schema';
import { compileAutonomousPersonalPolicyV3 } from '../../../src/schemas/AutonomousPersonalPolicyV3.schema';
import {
  COMPOSITIONAL_PREFERENCE_V2_DESCRIPTOR,
  CompositionalPreferenceV2BundleSchema,
  type CompositionalPreferenceV2,
} from '../../../src/schemas/CompositionalPreferenceV2.schema';
import { projectCompositionalPreferenceV2Meaning } from '../../../src/extraction/CompositionalPreferenceV2Meaning';
import { interpretCompositionalPreferencesV2 } from '../../../src/extraction/CompositionalPreferenceV2Parser';

const namespace = 'claim3-schema-test';
const subjectId = '11111111-1111-4111-8111-111111111111';
const sourceId = '22222222-2222-4222-8222-222222222222';
const otherSourceId = '33333333-3333-4333-8333-333333333333';
const canonicalDate = '2026-10-25T12:00:00.000Z';
const sha = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const policy = compileAutonomousPersonalPolicyV3({ profileId: 'conservative' });
const stressNamespace = 'n' + '\u0001'.repeat(127);

type Span = { start: number; end: number };
type TypedMeaning = ReturnType<typeof oneBundleMeaning>;
type MutableClaim = {
  [key: string]: unknown;
  kind: 'typed_preference' | 'source_statement_record';
  key: string;
  namespace: string;
  subjectId: string;
  sourceId: string;
  sourceHash: string;
  descriptorHash: string;
  policy: unknown;
  evidence: {
    unitId: string;
    rawContentHash: string;
    rawSpan: Span;
    mappedSpan: Span;
    literal: string;
    literalHash: string;
    evidenceHash: string;
  };
  interpretation: {
    category: string;
    usefulness: string;
    risk: string;
    downgrade: string[];
  };
  bundle?: CompositionalPreferenceV2['bundles'][number];
  meaning?: TypedMeaning;
  sourceEventTime?: string;
};
type TypedFixture = {
  source: string;
  preference: CompositionalPreferenceV2;
  bundle: CompositionalPreferenceV2['bundles'][number];
  meaning: TypedMeaning;
  claim: MutableClaim;
};

function deepFreezeCheck(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) deepFreezeCheck(child);
}

function fixedFailure(error: unknown, code: string): void {
  expect(error).toMatchObject({
    issues: [{ code: 'custom', path: [], message: code }],
  });
  const value = error as { issues: Array<{ path: unknown[] }> };
  expect(Object.isFrozen(error)).toBe(true);
  expect(Object.isFrozen(value.issues)).toBe(true);
  expect(Object.isFrozen(value.issues[0])).toBe(true);
  expect(Object.isFrozen(value.issues[0]?.path)).toBe(true);
}

function parseV2(source: string, selectedNamespace = namespace): CompositionalPreferenceV2 {
  return interpretCompositionalPreferencesV2({
    descriptor: COMPOSITIONAL_PREFERENCE_V2_DESCRIPTOR,
    rawContent: source,
    mappedContent: source,
    envelope: {
      version: 1,
      namespace: selectedNamespace,
      issuer: 'synthetic-issuer',
      actorReference: 'synthetic-actor',
      bindingRef: {
        bindingId: '44444444-4444-4444-8444-444444444444',
        revision: 1,
        subjectId,
        fingerprint: sha('binding'),
      },
      contentHash: sha(source),
      rawContentHash: sha(source),
      mappingAuthority: 'whole_source',
      humanRegion: { start: 0, end: source.length },
      mappings: [
        { contentStart: 0, contentEnd: source.length, rawStart: 0, rawEnd: source.length },
      ],
      quoteRegions: [],
      explicitIntent: false,
    },
  });
}

function oneBundleMeaning(
  preference: CompositionalPreferenceV2,
  bundle: CompositionalPreferenceV2['bundles'][number],
  selectedNamespace: string,
  selectedSubject = subjectId,
) {
  const result = projectCompositionalPreferenceV2Meaning({
    preference: { ...preference, bundles: [bundle], withheld: [], reasons: [] },
    namespace: selectedNamespace,
    subjectId: selectedSubject,
  });
  if (!result.ok) throw new Error(`Synthetic V2 meaning projection failed: ${result.reason}`);
  return result.meaning;
}

function buildTypedClaim(
  source: string,
  preference: CompositionalPreferenceV2,
  bundle: CompositionalPreferenceV2['bundles'][number],
  options: { namespace?: string; subjectId?: string; sourceId?: string; policy?: unknown } = {},
): { claim: MutableClaim; meaning: ReturnType<typeof oneBundleMeaning> } {
  const selectedNamespace = options.namespace ?? namespace;
  const selectedSubject = options.subjectId ?? subjectId;
  const selectedSource = options.sourceId ?? sourceId;
  const meaning = oneBundleMeaning(preference, bundle, selectedNamespace, selectedSubject);
  const rawContentHash = sha(source);
  const parentSpan = { start: 0, end: source.length };
  const unitId = hashAutonomousPersonalSourceUnitIdV1({
    rawContentHash,
    unitIndex: 0,
    parentRawSpan: parentSpan,
    parentMappedSpan: parentSpan,
  });
  const occurrence = bundle.evidence.spans[0]!;
  const literal = bundle.evidence.lexicalForm;
  const evidence = {
    sourceId: selectedSource,
    rawContentHash,
    unitId,
    kind: 'typed_preference' as const,
    rawSpan: { ...occurrence.raw },
    mappedSpan: { ...occurrence.content },
    literal,
  };
  const computedEvidence = hashAutonomousPersonalClaimEvidenceV3(evidence);
  const logicalInput = {
    kind: 'typed_preference' as const,
    namespace: selectedNamespace,
    subjectId: selectedSubject,
    meaning,
  };
  return {
    meaning,
    claim: {
      version: 3,
      family: 'autonomous-personal-v1',
      kind: 'typed_preference',
      key: hashAutonomousPersonalClaimKeyV3(logicalInput),
      namespace: selectedNamespace,
      subjectId: selectedSubject,
      sourceId: selectedSource,
      sourceHash: sha(`source:${source}`),
      descriptorHash: sha('descriptor-v4-reference'),
      policy: options.policy ?? policy,
      evidence: {
        unitId,
        rawSpan: { ...occurrence.raw },
        mappedSpan: { ...occurrence.content },
        literal,
        rawContentHash,
        ...computedEvidence,
      },
      interpretation: {
        category: 'preference',
        usefulness: 'personal_memory',
        risk: 'ordinary',
        downgrade: [],
      },
      bundle,
      meaning,
    },
  };
}

function typedFixture(
  source = 'I prefer concise explanations.',
  selectedNamespace = namespace,
): TypedFixture {
  const preference = parseV2(source, selectedNamespace);
  if (preference.coverage !== 'complete' || preference.bundles.length !== 1) {
    throw new Error('Typed test fixture must contain exactly one complete bundle');
  }
  const bundle = preference.bundles[0]!;
  const built = buildTypedClaim(source, preference, bundle, { namespace: selectedNamespace });
  return { source, preference, bundle, ...built };
}

function statementClaim(
  literal = 'I adore jazz.',
  options: {
    namespace?: string;
    subjectId?: string;
    sourceId?: string;
    sourceEventTime?: string;
    category?: string;
    policy?: unknown;
    rawContentHash?: string;
    unitId?: string;
    rawSpan?: Span;
    mappedSpan?: Span;
    sourceHash?: string;
    descriptorHash?: string;
  } = {},
): MutableClaim {
  const selectedNamespace = options.namespace ?? namespace;
  const selectedSubject = options.subjectId ?? subjectId;
  const selectedSource = options.sourceId ?? sourceId;
  const sourceEventTime = options.sourceEventTime ?? canonicalDate;
  const rawSpan = options.rawSpan ?? { start: 0, end: literal.length };
  const mappedSpan = options.mappedSpan ?? { ...rawSpan };
  const rawContentHash = options.rawContentHash ?? sha(`raw:${literal}`);
  const unitId =
    options.unitId ??
    hashAutonomousPersonalSourceUnitIdV1({
      rawContentHash,
      unitIndex: 0,
      parentRawSpan: rawSpan,
      parentMappedSpan: mappedSpan,
    });
  const evidenceInput = {
    sourceId: selectedSource,
    rawContentHash,
    unitId,
    kind: 'source_statement_record' as const,
    rawSpan,
    mappedSpan,
    literal,
  };
  const evidence = hashAutonomousPersonalClaimEvidenceV3(evidenceInput);
  const logicalInput = {
    kind: 'source_statement_record' as const,
    namespace: selectedNamespace,
    subjectId: selectedSubject,
    sourceEventTime,
    completeLiteral: literal,
    semantics: 'source_attributed_statement' as const,
  };
  return {
    version: 3,
    family: 'autonomous-personal-v1',
    kind: 'source_statement_record',
    key: hashAutonomousPersonalClaimKeyV3(logicalInput),
    namespace: selectedNamespace,
    subjectId: selectedSubject,
    sourceId: selectedSource,
    sourceHash: options.sourceHash ?? sha(`source:${literal}`),
    descriptorHash: options.descriptorHash ?? sha('descriptor-v4-reference'),
    policy: options.policy ?? policy,
    evidence: {
      unitId,
      rawSpan,
      mappedSpan,
      literal,
      rawContentHash,
      ...evidence,
    },
    interpretation: {
      category: options.category ?? 'personal_assertion',
      usefulness: 'personal_memory',
      risk: 'ordinary',
      downgrade: [],
    },
    sourceEventTime,
    framingVersion: 1,
    headForm: 'first_person_i_main_clause',
    semantics: 'source_attributed_statement',
    typedProjection: null,
  };
}

function markerFor(claim: Record<string, unknown>): Record<string, unknown> {
  return {
    version: 3,
    family: 'autonomous-personal-v1',
    kind: claim.kind,
    key: claim.key,
    namespace: claim.namespace,
    subjectId: claim.subjectId,
  };
}

function recalculateEvidence(claim: MutableClaim): void {
  const evidence = claim.evidence;
  const hashes = hashAutonomousPersonalClaimEvidenceV3({
    sourceId: claim.sourceId,
    rawContentHash: evidence.rawContentHash,
    unitId: evidence.unitId,
    kind: claim.kind,
    rawSpan: evidence.rawSpan,
    mappedSpan: evidence.mappedSpan,
    literal: evidence.literal,
  });
  Object.assign(evidence, hashes);
  if (claim.kind === 'source_statement_record') {
    claim.key = hashAutonomousPersonalClaimKeyV3({
      kind: 'source_statement_record',
      namespace: claim.namespace,
      subjectId: claim.subjectId,
      sourceEventTime: claim.sourceEventTime ?? canonicalDate,
      completeLiteral: evidence.literal,
      semantics: 'source_attributed_statement',
    });
  }
}

describe('autonomous personal Claim3 and Marker3 strict DATA schemas', () => {
  test('parses typed and whole-literal statement branches and freezes detached copies', () => {
    const typed = typedFixture();
    const typedBefore = structuredClone(typed.claim);
    const parsedTyped = AutonomousPersonalClaimV3Schema.parse(typed.claim);
    (typed.claim.evidence as Record<string, unknown>).literal = 'mutated input';
    (typed.claim.bundle as Record<string, unknown>).coverage = 'unknown';
    expect(parsedTyped).toEqual(typedBefore);
    deepFreezeCheck(parsedTyped);

    const statement = statementClaim();
    const statementBefore = structuredClone(statement);
    const parsedStatement = AutonomousPersonalClaimV3Schema.parse(statement);
    (statement.evidence as Record<string, unknown>).literal = 'changed after parsing';
    expect(parsedStatement).toEqual(statementBefore);
    deepFreezeCheck(parsedStatement);
    expect(parsedStatement).toHaveProperty('typedProjection', null);
    expect(parsedStatement).toHaveProperty('headForm', 'first_person_i_main_clause');

    const typedMarker = markerFor(typedBefore);
    const statementMarker = markerFor(statementBefore);
    const parsedTypedMarker = AutonomousPersonalValueMarkerV3Schema.parse(typedMarker);
    const parsedStatementMarker = AutonomousPersonalValueMarkerV3Schema.parse(statementMarker);
    deepFreezeCheck(parsedTypedMarker);
    deepFreezeCheck(parsedStatementMarker);
    expect(parsedTypedMarker).toEqual(typedMarker);
    expect(parsedStatementMarker).toEqual(statementMarker);
  });

  test('rejects branch confusion, unknown fields, wrong versions and intrinsic contradictions', () => {
    const typed = typedFixture().claim;
    const statement = statementClaim();
    const invalid = [
      { ...typed, unexpected: 'no' },
      { ...typed, version: 2 },
      { ...typed, family: 'other' },
      { ...typed, kind: 'source_statement_record' },
      { ...typed, interpretation: { ...(typed.interpretation as object), category: 'interest' } },
      { ...typed, interpretation: { ...(typed.interpretation as object), risk: 'sensitive' } },
      {
        ...typed,
        interpretation: { ...(typed.interpretation as object), downgrade: ['uncertain'] },
      },
      { ...typed, evidence: { ...(typed.evidence as object), rawSpan: { start: 0, end: 2 } } },
      { ...typed, meaning: { ...(typed.meaning as object), namespace: 'another-namespace' } },
      { ...statement, meaning: {} },
      { ...statement, headForm: 'other' },
      { ...statement, framingVersion: 2 },
      { ...statement, semantics: 'external_fact' },
      { ...statement, typedProjection: {} },
      { ...statement, sourceEventTime: '2026-10-25T12:00:00Z' },
      { ...statement, sourceEventTime: '2026-02-30T12:00:00.000Z' },
      {
        ...statement,
        interpretation: { ...(statement.interpretation as object), category: 'unknown' },
      },
      {
        ...statement,
        evidence: { ...(statement.evidence as object), literalHash: sha('incorrect') },
      },
      { ...statement, key: sha('incorrect-key') },
    ];
    for (const value of invalid)
      expect(AutonomousPersonalClaimV3Schema.safeParse(value).success).toBe(false);

    const invalidMarkers = [
      { ...markerFor(statement), unexpected: true },
      { ...markerFor(statement), version: 2 },
      { ...markerFor(statement), kind: 'unknown' },
      { ...markerFor(statement), key: 'not-a-hash' },
      { ...markerFor(statement), namespace: '  ' },
    ];
    for (const value of invalidMarkers)
      expect(AutonomousPersonalValueMarkerV3Schema.safeParse(value).success).toBe(false);

    expect(
      AutonomousPersonalClaimV3KeyInputOwnedDataSchema.safeParse({
        kind: 'source_statement_record',
        namespace,
        subjectId,
        sourceEventTime: canonicalDate,
        completeLiteral: 'I adore jazz.',
        semantics: 'source_attributed_statement',
        key: sha('circular-key-is-not-allowed'),
      }).success,
    ).toBe(false);
  });

  test('requires a single typed bundle evidence span matching both occurrence offsets and exact literal', () => {
    const fixture = typedFixture();
    const claim = fixture.claim;
    expect(AutonomousPersonalClaimV3Schema.safeParse(claim).success).toBe(true);
    const originalSpan = fixture.bundle.evidence.spans[0]!;
    const midpoint =
      originalSpan.raw.start +
      Math.max(1, Math.floor((originalSpan.raw.end - originalSpan.raw.start) / 2));
    const splitBundle = structuredClone(fixture.bundle);
    splitBundle.evidence.spans = [
      {
        raw: { start: originalSpan.raw.start, end: midpoint },
        content: { start: originalSpan.content.start, end: midpoint },
      },
      {
        raw: { start: midpoint, end: originalSpan.raw.end },
        content: { start: midpoint, end: originalSpan.content.end },
      },
    ];
    expect(CompositionalPreferenceV2BundleSchema.safeParse(splitBundle).success).toBe(true);
    expect(
      AutonomousPersonalClaimV3Schema.safeParse({ ...claim, bundle: splitBundle }).success,
    ).toBe(false);

    const mismatchedRaw = structuredClone(claim);
    mismatchedRaw.evidence.rawSpan.start += 1;
    mismatchedRaw.evidence.rawSpan.end += 1;
    recalculateEvidence(mismatchedRaw);
    expect(AutonomousPersonalClaimV3Schema.safeParse(mismatchedRaw).success).toBe(false);

    const mismatchedMapped = structuredClone(claim);
    mismatchedMapped.evidence.mappedSpan.start += 1;
    mismatchedMapped.evidence.mappedSpan.end += 1;
    recalculateEvidence(mismatchedMapped);
    expect(AutonomousPersonalClaimV3Schema.safeParse(mismatchedMapped).success).toBe(false);

    const mismatchedLiteral = structuredClone(claim);
    const mismatchedBundle = mismatchedLiteral.bundle!;
    mismatchedBundle.evidence.lexicalForm = `${mismatchedBundle.evidence.lexicalForm}!`;
    expect(CompositionalPreferenceV2BundleSchema.safeParse(mismatchedBundle).success).toBe(true);
    expect(AutonomousPersonalClaimV3Schema.safeParse(mismatchedLiteral).success).toBe(false);
  });

  test('uses exact named nested hash recipes for unit, evidence, meaning, key and dependency helpers', () => {
    const fixture = typedFixture();
    const claim = fixture.claim;
    const keyInput = {
      kind: 'typed_preference' as const,
      namespace,
      subjectId,
      meaning: fixture.meaning,
    };
    const rawContentHash = sha(fixture.source);
    const parentSpan = { start: 0, end: fixture.source.length };
    const expectedUnit = hashAutomaticCaptureV2({
      domain: 'engram-autonomous-unit-v1',
      unit: {
        rawContentHash,
        unitIndex: 0,
        parentRawSpan: parentSpan,
        parentMappedSpan: parentSpan,
      },
    });
    expect(
      hashAutonomousPersonalSourceUnitIdV1({
        rawContentHash,
        unitIndex: 0,
        parentRawSpan: parentSpan,
        parentMappedSpan: parentSpan,
      }),
    ).toBe(expectedUnit);

    const literalHash = sha(claim.evidence.literal);
    const expectedEvidence = hashAutomaticCaptureV2({
      domain: 'engram-autonomous-evidence-v1',
      evidence: {
        sourceId,
        rawContentHash,
        unitId: expectedUnit,
        kind: 'typed_preference',
        rawSpan: fixture.bundle.evidence.spans[0]!.raw,
        mappedSpan: fixture.bundle.evidence.spans[0]!.content,
        literalHash,
      },
    });
    expect(
      hashAutonomousPersonalClaimEvidenceV3({
        sourceId,
        rawContentHash,
        unitId: expectedUnit,
        kind: 'typed_preference',
        rawSpan: fixture.bundle.evidence.spans[0]!.raw,
        mappedSpan: fixture.bundle.evidence.spans[0]!.content,
        literal: claim.evidence.literal,
      }),
    ).toEqual({ literalHash, evidenceHash: expectedEvidence });

    const expectedMeaning = hashAutomaticCaptureV2({
      domain: 'engram-autonomous-meaning-v1',
      logicalMeaning: {
        kind: 'typed_preference',
        typedPreference: fixture.meaning,
        sourceStatement: null,
      },
    });
    expect(hashAutonomousPersonalClaimMeaningV3(keyInput)).toBe(expectedMeaning);
    expect(hashAutonomousPersonalClaimKeyV3(keyInput)).toBe(
      hashAutomaticCaptureV2({
        domain: 'engram-autonomous-preference-key-v1',
        preferenceIdentity: { namespace, subjectId, meaning: fixture.meaning },
      }),
    );

    const roots = fixture.meaning.bundles[0]!.rootPaths;
    expect(roots.length).toBeGreaterThan(0);
    roots.forEach((rootPath, rootIndex) => {
      expect(
        hashAutonomousPersonalPredicateDependencyV1({
          logicalInput: keyInput,
          meaningHash: expectedMeaning,
          rootIndex,
          rootPath,
        }),
      ).toBe(
        hashAutomaticCaptureV2({
          domain: 'engram-autonomous-predicate-dependency-v1',
          predicateDependency: {
            kind: 'typed_preference',
            meaningHash: expectedMeaning,
            rootIndex,
            rootPath,
          },
        }),
      );
    });
    expect(() =>
      hashAutonomousPersonalPredicateDependencyV1({
        logicalInput: keyInput,
        meaningHash: expectedMeaning,
        rootIndex: 0,
        rootPath: 'invented.root',
      }),
    ).toThrow('invalid_autonomous_claim_dependency_data');

    const statementInput = {
      kind: 'source_statement_record' as const,
      namespace,
      subjectId,
      sourceEventTime: canonicalDate,
      completeLiteral: 'I adore jazz.',
      semantics: 'source_attributed_statement' as const,
    };
    const emptyStatementInput = { ...statementInput, completeLiteral: '' };
    const emptyStatementMeaningHash = hashAutomaticCaptureV2({
      domain: 'engram-autonomous-meaning-v1',
      logicalMeaning: {
        kind: 'source_statement_record',
        typedPreference: null,
        sourceStatement: {
          namespace,
          subjectId,
          sourceEventTime: canonicalDate,
          completeLiteral: '',
          semantics: 'source_attributed_statement',
        },
      },
    });
    expect(
      AutonomousPersonalClaimV3KeyInputOwnedDataSchema.safeParse(emptyStatementInput).success,
    ).toBe(false);
    expect(() => hashAutonomousPersonalClaimKeyV3(emptyStatementInput)).toThrow(
      'invalid_autonomous_claim_key_data',
    );
    expect(() => hashAutonomousPersonalClaimMeaningV3(emptyStatementInput)).toThrow(
      'invalid_autonomous_claim_meaning_data',
    );
    expect(() =>
      hashAutonomousPersonalPredicateDependencyV1({
        logicalInput: emptyStatementInput,
        meaningHash: emptyStatementMeaningHash,
        rootIndex: 0,
        rootPath: 'record',
      }),
    ).toThrow('invalid_autonomous_claim_dependency_data');

    const statementMeaning = hashAutomaticCaptureV2({
      domain: 'engram-autonomous-meaning-v1',
      logicalMeaning: {
        kind: 'source_statement_record',
        typedPreference: null,
        sourceStatement: {
          namespace,
          subjectId,
          sourceEventTime: canonicalDate,
          completeLiteral: 'I adore jazz.',
          semantics: 'source_attributed_statement',
        },
      },
    });
    expect(hashAutonomousPersonalClaimMeaningV3(statementInput)).toBe(statementMeaning);
    expect(
      hashAutonomousPersonalPredicateDependencyV1({
        logicalInput: statementInput,
        meaningHash: statementMeaning,
        rootIndex: 0,
        rootPath: 'record',
      }),
    ).toBe(
      hashAutomaticCaptureV2({
        domain: 'engram-autonomous-predicate-dependency-v1',
        predicateDependency: {
          kind: 'source_statement_record',
          meaningHash: statementMeaning,
          rootIndex: 0,
          rootPath: 'record',
        },
      }),
    );
  });

  test('keeps parent unit identity lane-independent and hashes each occurrence separately', () => {
    const source = 'I prefer Canadian French, and I like concise explanations.';
    const preference = parseV2(source);
    expect(preference.coverage).toBe('complete');
    expect(preference.bundles).toHaveLength(2);
    const first = buildTypedClaim(source, preference, preference.bundles[0]!);
    const second = buildTypedClaim(source, preference, preference.bundles[1]!);
    expect(first.claim.evidence).toMatchObject({ unitId: second.claim.evidence.unitId });
    expect(first.claim.evidence.literal).not.toBe(second.claim.evidence.literal);
    expect(first.claim.evidence.evidenceHash).not.toBe(second.claim.evidence.evidenceHash);
    expect(AutonomousPersonalClaimV3Schema.safeParse(first.claim).success).toBe(true);
    expect(AutonomousPersonalClaimV3Schema.safeParse(second.claim).success).toBe(true);

    const implicitSource = 'I prefer Canadian French and like concise explanations.';
    const implicit = parseV2(implicitSource);
    expect(implicit.coverage).toBe('complete');
    expect(implicit.bundles).toHaveLength(1);
    expect(implicit.bundles[0]!.relation).toBe('allOf');
    expect(implicit.bundles[0]!.coupling).toBe('coupled');
    expect(implicit.bundles[0]!.rootNodeIds).toHaveLength(2);
    const coupledClaim = buildTypedClaim(implicitSource, implicit, implicit.bundles[0]!);
    expect(AutonomousPersonalClaimV3Schema.safeParse(coupledClaim.claim).success).toBe(true);
  });

  test('checks typed subspan literal and meaning projection without treating opaque origins as proof', () => {
    const claim = typedFixture().claim;
    const opaque = structuredClone(claim);
    opaque.sourceId = otherSourceId;
    opaque.sourceHash = sha('unrelated persisted source');
    opaque.descriptorHash = sha('unrelated descriptor');
    opaque.evidence.rawContentHash = sha('unrelated producer content');
    opaque.evidence.unitId = sha('caller-computed parent identity');
    const evidence = hashAutonomousPersonalClaimEvidenceV3({
      sourceId: opaque.sourceId,
      rawContentHash: opaque.evidence.rawContentHash,
      unitId: opaque.evidence.unitId,
      kind: opaque.kind,
      rawSpan: opaque.evidence.rawSpan,
      mappedSpan: opaque.evidence.mappedSpan,
      literal: opaque.evidence.literal,
    });
    Object.assign(opaque.evidence, evidence);
    expect(AutonomousPersonalClaimV3Schema.safeParse(opaque).success).toBe(true);
  });

  test('keeps statement identity independent of category, occurrence metadata, head label and policy', () => {
    const original = statementClaim();
    const alternate = statementClaim('I adore jazz.', {
      category: 'interest',
      policy: compileAutonomousPersonalPolicyV3({ profileId: 'reviewFirst' }),
      sourceId: otherSourceId,
      rawContentHash: sha('another producer body'),
      unitId: sha('another unit identity'),
      sourceHash: sha('another source row'),
      descriptorHash: sha('another descriptor'),
    });
    expect(alternate.key).toBe(original.key);
    expect(alternate.interpretation.category).toBe('interest');
    expect(AutonomousPersonalClaimV3Schema.safeParse(alternate).success).toBe(true);

    const changedDate = statementClaim('I adore jazz.', {
      sourceEventTime: '2026-10-26T12:00:00.000Z',
    });
    const changedLiteral = statementClaim('I enjoy jazz.', { sourceEventTime: canonicalDate });
    const changedNamespace = statementClaim('I adore jazz.', { namespace: 'another-namespace' });
    const changedSubject = statementClaim('I adore jazz.', {
      subjectId: '55555555-5555-4555-8555-555555555555',
    });
    expect(changedDate.key).not.toBe(original.key);
    expect(changedLiteral.key).not.toBe(original.key);
    expect(changedNamespace.key).not.toBe(original.key);
    expect(changedSubject.key).not.toBe(original.key);
  });

  test('accepts the actual parser/projector near-cap candidate and rejects complete over-cap before Claim3 Zod', () => {
    const base =
      'For summaries, I usually prefer answers in plain Canadian French with one practical example before any technical definitions and like responses in plain Australian English with one worked example ahead of any technical terms.';
    const nearSource = base.split(' ').join(' '.repeat(50));
    const nearV2 = parseV2(nearSource, stressNamespace);
    expect(nearV2.coverage).toBe('complete');
    expect(nearV2.bundles).toHaveLength(1);
    const nearClaim = buildTypedClaim(nearSource, nearV2, nearV2.bundles[0]!, {
      namespace: stressNamespace,
    }).claim;
    const nearBytes = Buffer.byteLength(JSON.stringify(nearClaim), 'utf8');
    expect(nearBytes).toBe(30_055);
    expect(nearBytes).toBeLessThanOrEqual(32 * 1024);
    expect(AutonomousPersonalClaimV3Schema.safeParse(nearClaim).success).toBe(true);

    const overSource = base.split(' ').join('\u00a0'.repeat(45));
    const overV2 = parseV2(overSource, stressNamespace);
    expect(overV2.coverage).toBe('complete');
    expect(overV2.bundles).toHaveLength(1);
    const overClaim = buildTypedClaim(overSource, overV2, overV2.bundles[0]!, {
      namespace: stressNamespace,
    }).claim;
    const overBytes = Buffer.byteLength(JSON.stringify(overClaim), 'utf8');
    expect(overBytes).toBe(33_003);
    const zodParse = jest.spyOn(AutonomousPersonalClaimV3OwnedDataSchema, 'parse');
    try {
      const result = AutonomousPersonalClaimV3Schema.safeParse(overClaim);
      expect(result.success).toBe(false);
      if (!result.success) fixedFailure(result.error, 'invalid_autonomous_claim_data');
      expect(zodParse).not.toHaveBeenCalled();
    } finally {
      zodParse.mockRestore();
    }
  });

  test('keeps the maximum control-character statement fixture within Claim3 JSON cap', () => {
    const literal = '\u0001'.repeat(2048);
    const claim = statementClaim(literal, { namespace: stressNamespace });
    const bytes = Buffer.byteLength(JSON.stringify(claim), 'utf8');
    expect(bytes).toBe(15_725);
    expect(JSON.stringify(literal)).toHaveLength(12_290);
    expect(AutonomousPersonalClaimV3Schema.safeParse(claim).success).toBe(true);
  });

  test('rejects hostile raw values before invoking accessors across every public facade and helper', () => {
    let traps = 0;
    const rootGetter = Object.defineProperty({}, 'then', {
      enumerable: true,
      get: () => ++traps,
    });
    const proxy = new Proxy(
      {},
      {
        get: () => {
          traps += 1;
          return undefined;
        },
        ownKeys: () => {
          traps += 1;
          return [];
        },
      },
    );
    const nested = structuredClone(statementClaim());
    Object.defineProperty(nested.evidence, 'literal', {
      enumerable: true,
      configurable: true,
      get: () => ++traps,
    });
    const nestedProxy = statementClaim();
    nestedProxy.evidence = new Proxy(nestedProxy.evidence, {
      get: () => {
        traps += 1;
        return undefined;
      },
      ownKeys: () => {
        traps += 1;
        return [];
      },
    });
    const toJson = { toJSON: () => ++traps };
    const circular = statementClaim() as Record<string, unknown>;
    circular.self = circular;

    const fakeCtorGetter = () => ++traps;
    const fakeCtor = function fakeConstructor() {};
    Object.defineProperty(fakeCtor, 'name', { get: fakeCtorGetter });
    const fakePrototypeCtor = () => {};
    Object.defineProperty(fakePrototypeCtor, 'prototype', { get: fakeCtorGetter });
    const fakeConstructorObject = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(fakeConstructorObject, 'constructor', {
      enumerable: true,
      value: fakeCtor,
    });
    const fakePrototypeObject = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(fakePrototypeObject, 'constructor', {
      enumerable: true,
      value: fakePrototypeCtor,
    });

    const publicRawEntries: Array<{ run: (value: unknown) => unknown; safeParse?: boolean }> = [
      { run: (value) => AutonomousPersonalClaimV3Schema.parse(value) },
      { run: (value) => AutonomousPersonalClaimV3Schema.safeParse(value), safeParse: true },
      { run: (value) => AutonomousPersonalValueMarkerV3Schema.parse(value) },
      { run: (value) => AutonomousPersonalValueMarkerV3Schema.safeParse(value), safeParse: true },
      { run: (value) => hashAutonomousPersonalClaimKeyV3(value) },
      { run: (value) => hashAutonomousPersonalClaimMeaningV3(value) },
      { run: (value) => hashAutonomousPersonalClaimEvidenceV3(value) },
      { run: (value) => hashAutonomousPersonalSourceUnitIdV1(value) },
      { run: (value) => hashAutonomousPersonalPredicateDependencyV1(value) },
    ];
    const hostile = [
      rootGetter,
      proxy,
      nested,
      nestedProxy,
      toJson,
      circular,
      fakeConstructorObject,
      fakePrototypeObject,
    ];
    for (const entry of publicRawEntries) {
      for (const value of hostile) {
        if (entry.safeParse) {
          expect(entry.run(value)).toMatchObject({ success: false });
        } else {
          expect(() => entry.run(value)).toThrow();
        }
      }
    }
    expect(traps).toBe(0);
  });

  test('returns one fixed redacted error per public entry point', () => {
    const secret = 'secret diagnostic ' + 'x'.repeat(300);
    const badClaim = { ...statementClaim(), diagnostic: secret };
    const badMarker = { ...markerFor(statementClaim()), diagnostic: secret };
    const cases: Array<{ run: () => unknown; code: string; throws?: boolean }> = [
      {
        run: () => AutonomousPersonalClaimV3Schema.safeParse(badClaim),
        code: 'invalid_autonomous_claim_data',
      },
      {
        run: () => AutonomousPersonalValueMarkerV3Schema.safeParse(badMarker),
        code: 'invalid_autonomous_marker_data',
      },
      {
        run: () =>
          hashAutonomousPersonalClaimKeyV3({
            kind: 'source_statement_record',
            key: sha('no'),
            namespace,
            subjectId,
            sourceEventTime: canonicalDate,
            completeLiteral: 'I adore jazz.',
            semantics: 'source_attributed_statement',
          }),
        code: 'invalid_autonomous_claim_key_data',
        throws: true,
      },
      {
        run: () => hashAutonomousPersonalClaimMeaningV3({ kind: 'bad' }),
        code: 'invalid_autonomous_claim_meaning_data',
        throws: true,
      },
      {
        run: () => hashAutonomousPersonalClaimEvidenceV3({ secret }),
        code: 'invalid_autonomous_claim_evidence_data',
        throws: true,
      },
      {
        run: () => hashAutonomousPersonalSourceUnitIdV1({ secret }),
        code: 'invalid_autonomous_claim_unit_data',
        throws: true,
      },
      {
        run: () => hashAutonomousPersonalPredicateDependencyV1({ secret }),
        code: 'invalid_autonomous_claim_dependency_data',
        throws: true,
      },
    ];
    for (const { run, code, throws } of cases) {
      if (throws) {
        try {
          run();
          throw new Error('Expected fixed failure');
        } catch (error) {
          fixedFailure(error, code);
          expect(JSON.stringify(error)).not.toContain(secret);
        }
      } else {
        const result = run() as { success: false; error: unknown };
        expect(result.success).toBe(false);
        if (result.success === false) fixedFailure(result.error, code);
        expect(JSON.stringify(result)).not.toContain(secret);
      }
    }

    expect(() => AutonomousPersonalClaimV3Schema.parse(badClaim)).toThrow(
      'invalid_autonomous_claim_data',
    );
    expect(() => AutonomousPersonalValueMarkerV3Schema.parse(badMarker)).toThrow(
      'invalid_autonomous_marker_data',
    );
  });

  test('bounds every helper and rejects cycles, sparse arrays and oversized public inputs', () => {
    const sparseTyped = typedFixture(
      'I prefer Canadian French and like concise explanations.',
    ).claim;
    const sparseMeaning = structuredClone(sparseTyped.meaning!);
    expect(sparseMeaning.bundles[0].rootPaths).toHaveLength(2);
    delete (sparseMeaning.bundles[0].rootPaths as unknown[])[1];
    expect(() =>
      hashAutonomousPersonalClaimKeyV3({
        kind: 'typed_preference',
        namespace,
        subjectId,
        meaning: sparseMeaning,
      }),
    ).toThrow('invalid_autonomous_claim_key_data');

    const oversized = { unknown: 'x'.repeat(33 * 1024) };
    expect(() => hashAutonomousPersonalClaimKeyV3(oversized)).toThrow(
      'invalid_autonomous_claim_key_data',
    );
    expect(() => hashAutonomousPersonalClaimMeaningV3(oversized)).toThrow(
      'invalid_autonomous_claim_meaning_data',
    );
    expect(() => hashAutonomousPersonalClaimEvidenceV3(oversized)).toThrow(
      'invalid_autonomous_claim_evidence_data',
    );
    expect(() => hashAutonomousPersonalSourceUnitIdV1(oversized)).toThrow(
      'invalid_autonomous_claim_unit_data',
    );
    expect(() => hashAutonomousPersonalPredicateDependencyV1(oversized)).toThrow(
      'invalid_autonomous_claim_dependency_data',
    );

    const cyclicKey = {
      kind: 'source_statement_record',
      namespace,
      subjectId,
      sourceEventTime: canonicalDate,
      completeLiteral: 'I adore jazz.',
      semantics: 'source_attributed_statement',
    } as Record<string, unknown>;
    cyclicKey.self = cyclicKey;
    expect(() => hashAutonomousPersonalClaimKeyV3(cyclicKey)).toThrow(
      'invalid_autonomous_claim_key_data',
    );

    const oversizedClaim = {
      ...statementClaim(),
      evidence: { ...(statementClaim().evidence as object), literal: 'x'.repeat(5 * 1024) },
    };
    expect(AutonomousPersonalClaimV3Schema.safeParse(oversizedClaim).success).toBe(false);
    const oversizedMarker = { ...markerFor(statementClaim()), padding: 'x'.repeat(17 * 1024) };
    expect(AutonomousPersonalValueMarkerV3Schema.safeParse(oversizedMarker).success).toBe(false);
  });

  test('enforces begin-request and per-entry byte bounds before the corresponding Zod schema', () => {
    const beginRequestOversize = { padding: 'x'.repeat(512 * 1024 + 1) };
    const claimParse = jest.spyOn(AutonomousPersonalClaimV3OwnedDataSchema, 'parse');
    const markerParse = jest.spyOn(AutonomousPersonalValueMarkerV3OwnedDataSchema, 'parse');
    const keyInputParse = jest.spyOn(AutonomousPersonalClaimV3KeyInputOwnedDataSchema, 'parse');
    try {
      expect(() => AutonomousPersonalClaimV3Schema.parse(beginRequestOversize)).toThrow(
        'invalid_autonomous_claim_data',
      );
      expect(() => AutonomousPersonalValueMarkerV3Schema.parse(beginRequestOversize)).toThrow(
        'invalid_autonomous_marker_data',
      );
      expect(() => hashAutonomousPersonalClaimKeyV3(beginRequestOversize)).toThrow(
        'invalid_autonomous_claim_key_data',
      );
      expect(claimParse).not.toHaveBeenCalled();
      expect(markerParse).not.toHaveBeenCalled();
      expect(keyInputParse).not.toHaveBeenCalled();

      const claimOverCap = { ...statementClaim(), padding: 'x'.repeat(33 * 1024) };
      const markerOverCap = { ...markerFor(statementClaim()), padding: 'x'.repeat(17 * 1024) };
      const helperOverCap = { unknown: 'x'.repeat(33 * 1024) };
      claimParse.mockClear();
      markerParse.mockClear();
      keyInputParse.mockClear();
      expect(() => AutonomousPersonalClaimV3Schema.parse(claimOverCap)).toThrow(
        'invalid_autonomous_claim_data',
      );
      expect(() => AutonomousPersonalValueMarkerV3Schema.parse(markerOverCap)).toThrow(
        'invalid_autonomous_marker_data',
      );
      expect(() => hashAutonomousPersonalClaimKeyV3(helperOverCap)).toThrow(
        'invalid_autonomous_claim_key_data',
      );
      expect(() => hashAutonomousPersonalClaimMeaningV3(helperOverCap)).toThrow(
        'invalid_autonomous_claim_meaning_data',
      );
      expect(() => hashAutonomousPersonalClaimEvidenceV3(helperOverCap)).toThrow(
        'invalid_autonomous_claim_evidence_data',
      );
      expect(() => hashAutonomousPersonalSourceUnitIdV1(helperOverCap)).toThrow(
        'invalid_autonomous_claim_unit_data',
      );
      expect(() => hashAutonomousPersonalPredicateDependencyV1(helperOverCap)).toThrow(
        'invalid_autonomous_claim_dependency_data',
      );
      expect(claimParse).not.toHaveBeenCalled();
      expect(markerParse).not.toHaveBeenCalled();
      expect(keyInputParse).not.toHaveBeenCalled();
    } finally {
      claimParse.mockRestore();
      markerParse.mockRestore();
      keyInputParse.mockRestore();
    }
  });

  test('performs no provider, database or network I/O', () => {
    const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('Unexpected I/O');
    });
    try {
      expect(AutonomousPersonalClaimV3Schema.parse(statementClaim()).kind).toBe(
        'source_statement_record',
      );
      expect(
        hashAutonomousPersonalClaimKeyV3({
          kind: 'source_statement_record',
          namespace,
          subjectId,
          sourceEventTime: canonicalDate,
          completeLiteral: 'I adore jazz.',
          semantics: 'source_attributed_statement',
        }),
      ).toMatch(/^[a-f0-9]{64}$/u);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });
});
