import { buildAutonomousPersonalClaimCandidateV1 } from '../../../src/extraction/AutonomousPersonalClaimCandidateV1';
import { projectCompositionalPreferenceV2Meaning } from '../../../src/extraction/CompositionalPreferenceV2Meaning';
import {
  compileAutonomousPersonalDescriptorV4,
  type AutonomousPersonalDescriptorV4Input,
} from '../../../src/schemas/AutonomousPersonalDescriptorV4.schema';
import {
  AutonomousPersonalClaimV3OwnedDataSchema,
  hashAutonomousPersonalClaimEvidenceV3,
  hashAutonomousPersonalClaimKeyV3,
  hashAutonomousPersonalClaimMeaningV3,
  hashAutonomousPersonalPredicateDependencyV1,
  hashAutonomousPersonalSourceUnitIdV1,
} from '../../../src/schemas/AutonomousPersonalClaimV3.schema';
import {
  AutonomousPersonalClaimCandidateV1InputOwnedDataSchema,
  AutonomousPersonalClaimCandidateV1ResultOwnedDataSchema,
  type AutonomousPersonalClaimCandidateV1Input,
} from '../../../src/schemas/AutonomousPersonalClaimCandidateV1.schema';
import { compileAutonomousPersonalSourceScanV1 } from '../../../src/schemas/AutonomousPersonalSourceScanV1.schema';
import {
  compileAutonomousPersonalSourceTupleV4,
  reconstructAutonomousPersonalStoredSourceIdentityV4,
  type AutonomousPersonalSourceTupleV4Input,
} from '../../../src/schemas/AutonomousPersonalSourceV4.schema';
import { compileAutonomousPersonalTypedSyntaxV1 } from '../../../src/extraction/AutonomousPersonalTypedSyntaxV1';

const sourceId = '10000000-0000-4000-8000-000000000001';
const bindingId = '10000000-0000-4000-8000-000000000002';
const subjectId = '10000000-0000-4000-8000-000000000003';
const timestamp = '2026-10-27T11:12:13.000Z';

const descriptorInput = (): AutonomousPersonalDescriptorV4Input => ({
  profileId: 'conservative',
  requestedTrustLevel: 'standard',
  intentSetting: false,
  invocationDeadlineMs: 30_000,
  providerReference: {
    routeId: 'synthetic-route',
    configurationFingerprint: 'd'.repeat(64),
    protocol: 'openai-compatible-json-v1',
    configuredRequestLimit: 2,
    configuredTimeoutMs: 30_000,
    configuredRequestBytes: 262_144,
    configuredResponseBytes: 65_536,
    temperature: { mode: 'providerDefault' },
    responseFormat: 'json_object',
    outputTokenLimit: { mode: 'omit' },
  },
});

type CandidateCategory = AutonomousPersonalClaimCandidateV1Input['category'];

function work() {
  return {
    absoluteMonotonicDeadlineMs: performance.now() + 30_000,
    signal: new AbortController().signal,
  };
}

function makeCapture(
  content: string,
  referenceTime = timestamp,
  namespace = 'workflow:candidate-test',
) {
  const descriptor = compileAutonomousPersonalDescriptorV4(descriptorInput());
  const capture: AutonomousPersonalSourceTupleV4Input = {
    scope: {
      storeHash: 'a'.repeat(64),
      namespace,
      issuer: 'n8n',
      actorReference: 'synthetic-user',
      turn: 'turn-candidate-test',
      binding: {
        bindingId,
        revision: 1,
        subjectId,
        fingerprint: 'b'.repeat(64),
      },
    },
    descriptor,
    producer: {
      uuid: sourceId,
      group_id: namespace,
      content,
      role: 'human',
      source_type: 'message',
      episode_kind: 'active_human',
      reference_time: referenceTime,
      previous_episode_uuid: null,
      source_message_id: 'message-candidate-test',
      idempotency_key: 'idempotency-candidate-test',
      conversation_id: 'conversation-candidate-test',
      sender_id: 'sender-candidate-test',
      source_workflow_id: 'workflow-candidate-test',
      source_execution_id: 'original-execution-candidate-test',
      quoted_message_id: null,
      created_at: timestamp,
    },
    eventTimeMode: 'explicit',
    mapping: { mode: 'full_body' },
    quoteRegions: [],
  };
  const tuple = compileAutonomousPersonalSourceTupleV4(capture);
  const source = {
    ...capture.producer,
    updated_at: null,
    sender_name: null,
    trust_level: descriptor.requestedTrustLevel,
    confidence: null,
    review_status: 'accepted',
    attributes: {
      engram_write_owner_v4: tuple.owner,
      engram_source_envelope_v3: tuple.envelope,
    },
  };
  return { source, descriptor, capture };
}

function inputsFor(
  content: string,
  options: {
    referenceTime?: string;
    namespace?: string;
    statementCategory?: CandidateCategory;
  } = {},
): AutonomousPersonalClaimCandidateV1Input[] {
  const fixture = makeCapture(content, options.referenceTime, options.namespace);
  const stored = reconstructAutonomousPersonalStoredSourceIdentityV4({
    source: fixture.source,
    descriptor: fixture.descriptor,
  });
  const scan = compileAutonomousPersonalSourceScanV1({
    rawContent: fixture.source.content,
    mapping: fixture.capture.mapping,
    quoteRegions: fixture.capture.quoteRegions,
  });
  if (scan.status !== 'complete') throw new Error('Expected a complete source scan');
  const syntax = compileAutonomousPersonalTypedSyntaxV1(
    {
      rawContent: fixture.source.content,
      mapping: fixture.capture.mapping,
      quoteRegions: fixture.capture.quoteRegions,
      syntaxScope: {
        namespace: fixture.capture.scope.namespace,
        issuer: fixture.capture.scope.issuer,
        actorReference: fixture.capture.scope.actorReference,
        binding: fixture.capture.scope.binding,
      },
    },
    work(),
  );
  if (syntax.status !== 'complete') throw new Error('Expected complete typed syntax');

  const inputs: AutonomousPersonalClaimCandidateV1Input[] = [];
  for (const unit of scan.units) {
    const syntaxUnit = syntax.units[unit.index];
    if (!syntaxUnit || syntaxUnit.unitIndex !== unit.index)
      throw new Error('Expected a matching syntax unit');
    const unitId = hashAutonomousPersonalSourceUnitIdV1({
      rawContentHash: scan.rawContentHash,
      unitIndex: unit.index,
      parentRawSpan: unit.rawSpan,
      parentMappedSpan: unit.mappedSpan,
    });
    const common = {
      sourceId: stored.tuple.owner.sourceId,
      contentHash: stored.tuple.owner.contentHash,
      descriptorHash: stored.tuple.owner.descriptorHash,
      namespace: stored.tuple.owner.namespace,
      subjectId: stored.tuple.owner.binding.subjectId,
      sourceHash: stored.tuple.identity.sourceHash,
      policy: fixture.descriptor.policy,
      sourceEventTime: new Date(Date.parse(fixture.source.reference_time)).toISOString(),
      unitId,
      unitIndex: unit.index,
    };
    if (syntaxUnit.kind === 'typed') {
      for (const bundle of syntaxUnit.preference.bundles) {
        const occurrence = bundle.evidence.spans[0];
        if (!occurrence) throw new Error('Expected a typed evidence occurrence');
        inputs.push({
          ...common,
          kind: 'typed_preference' as const,
          category: 'preference' as const,
          literal: bundle.evidence.lexicalForm,
          rawSpan: occurrence.raw,
          mappedSpan: occurrence.content,
          bundle,
        });
      }
      continue;
    }
    inputs.push({
      ...common,
      kind: 'source_statement_record',
      category: options.statementCategory ?? 'personal_assertion',
      literal: fixture.source.content.slice(unit.rawSpan.start, unit.rawSpan.end),
      rawSpan: unit.rawSpan,
      mappedSpan: unit.mappedSpan,
      bundle: null,
    });
  }
  return inputs;
}

function expectedCandidate(input: AutonomousPersonalClaimCandidateV1Input) {
  const evidenceInput = {
    sourceId: input.sourceId,
    rawContentHash: input.contentHash,
    unitId: input.unitId,
    kind: input.kind,
    rawSpan: input.rawSpan,
    mappedSpan: input.mappedSpan,
    literal: input.literal,
  };
  const evidenceHashes = hashAutonomousPersonalClaimEvidenceV3(evidenceInput);
  let logicalInput: Record<string, unknown>;
  let claimKindInput: Record<string, unknown>;
  let rootPaths: string[];
  if (input.kind === 'typed_preference') {
    const projected = projectCompositionalPreferenceV2Meaning({
      preference: {
        version: 2,
        descriptor: input.bundle.evidence.descriptor,
        coverage: 'complete',
        bundles: [input.bundle],
        withheld: [],
        reasons: [],
      },
      namespace: input.namespace,
      subjectId: input.subjectId,
    });
    if (!projected.ok) throw new Error('Expected a complete typed meaning');
    const meaning = projected.meaning;
    logicalInput = {
      kind: 'typed_preference',
      namespace: input.namespace,
      subjectId: input.subjectId,
      meaning,
    };
    claimKindInput = { bundle: input.bundle, meaning };
    rootPaths = [...meaning.bundles[0]!.rootPaths];
  } else {
    logicalInput = {
      kind: 'source_statement_record',
      namespace: input.namespace,
      subjectId: input.subjectId,
      sourceEventTime: input.sourceEventTime,
      completeLiteral: input.literal,
      semantics: 'source_attributed_statement',
    };
    claimKindInput = {
      sourceEventTime: input.sourceEventTime,
      framingVersion: 1,
      headForm: 'first_person_i_main_clause',
      semantics: 'source_attributed_statement',
      typedProjection: null,
    };
    rootPaths = ['record'];
  }
  const meaningHash = hashAutonomousPersonalClaimMeaningV3(logicalInput);
  const key = hashAutonomousPersonalClaimKeyV3(logicalInput);
  const dependencies = rootPaths.map((rootPath, index) => ({
    index,
    dependencyHash: hashAutonomousPersonalPredicateDependencyV1({
      logicalInput,
      meaningHash,
      rootIndex: index,
      rootPath,
    }),
  }));
  const claim = AutonomousPersonalClaimV3OwnedDataSchema.parse({
    version: 3,
    family: 'autonomous-personal-v1',
    kind: input.kind,
    key,
    namespace: input.namespace,
    subjectId: input.subjectId,
    sourceId: input.sourceId,
    sourceHash: input.sourceHash,
    descriptorHash: input.descriptorHash,
    policy: input.policy,
    evidence: {
      unitId: input.unitId,
      rawSpan: input.rawSpan,
      mappedSpan: input.mappedSpan,
      literal: input.literal,
      rawContentHash: input.contentHash,
      ...evidenceHashes,
    },
    interpretation: {
      category: input.category,
      usefulness: 'personal_memory',
      risk: 'ordinary',
      downgrade: [],
    },
    ...claimKindInput,
  });
  return AutonomousPersonalClaimCandidateV1ResultOwnedDataSchema.parse({
    kind: 'candidate',
    claim,
    reference: {
      unitIndex: input.unitIndex,
      kind: input.kind,
      category: input.category,
      key,
      evidenceHash: evidenceHashes.evidenceHash,
      meaningHash,
      dependencies,
      rawSpan: input.rawSpan,
      mappedSpan: input.mappedSpan,
    },
    dependencyCount: dependencies.length,
  });
}

function expectDeepFrozen(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) expectDeepFrozen(child);
}

function expectFixedInvalid(value: unknown): void {
  try {
    buildAutonomousPersonalClaimCandidateV1(value);
    throw new Error('Expected invalid candidate data');
  } catch (error) {
    expect(error).toMatchObject({
      name: 'AutonomousPersonalClaimCandidateV1Error',
      message: 'invalid_autonomous_personal_claim_candidate_data',
    });
  }
}

describe('AutonomousPersonalClaimCandidateV1 builds a shared strict Claim3 candidate', () => {
  test('matches public Claim3 hash recipes for regional, ordered, complete typed evidence', () => {
    const input = inputsFor(
      'I prefer explanations in plain British English, with one practical example before any technical terminology.',
    )[0]!;
    expect(input.kind).toBe('typed_preference');
    const result = buildAutonomousPersonalClaimCandidateV1(input);
    expect(result.kind).toBe('candidate');
    if (result.kind !== 'candidate') throw new Error('Expected a candidate');
    expect(result).toEqual(expectedCandidate(input));
    expect(result.reference).not.toHaveProperty('candidateIndex');
    expect(result.claim.kind).toBe('typed_preference');
    if (result.claim.kind !== 'typed_preference') throw new Error('Expected typed Claim3');
    expect(result.claim.meaning.bundles[0]?.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'language', base: 'English', region: 'British' }),
        expect.objectContaining({ kind: 'ordering', relation: 'before' }),
      ]),
    );
    expect(result.claim.meaning.bundles[0]?.edges).toContainEqual(
      expect.objectContaining({ relation: 'orders' }),
    );
    expectDeepFrozen(result);
  });

  test('keeps negative polarity and returns separate candidates for a complete compound preference', () => {
    const negativeInput = inputsFor('I do not like concise explanations.')[0]!;
    const negative = buildAutonomousPersonalClaimCandidateV1(negativeInput);
    expect(negative.kind).toBe('candidate');
    if (negative.kind !== 'candidate' || negative.claim.kind !== 'typed_preference')
      throw new Error('Expected a typed negative candidate');
    expect(negative.claim.meaning.bundles[0]?.nodes).toContainEqual(
      expect.objectContaining({ kind: 'preference', operator: 'like', polarity: 'negated' }),
    );
    expect(negative).toEqual(expectedCandidate(negativeInput));

    const compoundInputs = inputsFor('I prefer Canadian French, and I like concise explanations.');
    expect(compoundInputs).toHaveLength(2);
    const compound = compoundInputs.map((input) => buildAutonomousPersonalClaimCandidateV1(input));
    expect(compound.every((result) => result.kind === 'candidate')).toBe(true);
    for (const [index, result] of compound.entries()) {
      expect(result).toEqual(expectedCandidate(compoundInputs[index]!));
    }
    const claims = compound.flatMap((result) =>
      result.kind === 'candidate' ? [result.claim] : [],
    );
    expect(claims).toHaveLength(2);
    expect(new Set(claims.map((claim) => claim.key)).size).toBe(2);
  });

  test('uses the strict kind discriminant and canonicalizes dated statement provenance', () => {
    const [input] = inputsFor('I adore jazz.', {
      referenceTime: '2026-10-28T11:12:13.000Z',
      statementCategory: 'preference',
    });
    expect(input?.kind).toBe('source_statement_record');
    expect(input?.category).toBe('preference');
    expect(input?.bundle).toBeNull();
    expect(input?.sourceEventTime).toBe('2026-10-28T11:12:13.000Z');
    const result = buildAutonomousPersonalClaimCandidateV1(input);
    expect(result.kind).toBe('candidate');
    if (result.kind !== 'candidate') throw new Error('Expected statement candidate');
    expect(result).toEqual(expectedCandidate(input));
    expect(result.claim.kind).toBe('source_statement_record');
    if (result.claim.kind !== 'source_statement_record')
      throw new Error('Expected statement Claim3');
    expect(result.claim).toMatchObject({
      sourceEventTime: '2026-10-28T11:12:13.000Z',
      framingVersion: 1,
      headForm: 'first_person_i_main_clause',
      semantics: 'source_attributed_statement',
      typedProjection: null,
      interpretation: { category: 'preference' },
    });
  });

  test('accepts the 2,048-code-point and 4,096-byte literal boundary and maps overflow to capacity', () => {
    const base = inputsFor('I adore jazz.')[0]!;
    if (base.kind !== 'source_statement_record') throw new Error('Expected statement input');
    const exactLiteral = 'I 𐐀' + 'é'.repeat(2045);
    expect(Array.from(exactLiteral)).toHaveLength(2048);
    expect(Buffer.byteLength(exactLiteral, 'utf8')).toBe(4096);
    const exact = {
      ...base,
      literal: exactLiteral,
      rawSpan: { start: 0, end: exactLiteral.length },
      mappedSpan: { start: 0, end: exactLiteral.length },
    };
    expect(AutonomousPersonalClaimCandidateV1InputOwnedDataSchema.safeParse(exact).success).toBe(
      true,
    );
    expect(buildAutonomousPersonalClaimCandidateV1(exact).kind).toBe('candidate');

    const over = {
      ...exact,
      literal: `${exactLiteral}x`,
      rawSpan: { start: 0, end: exactLiteral.length + 1 },
      mappedSpan: { start: 0, end: exactLiteral.length + 1 },
    };
    expect(buildAutonomousPersonalClaimCandidateV1(over)).toEqual({ kind: 'candidate_capacity' });
    expect(
      buildAutonomousPersonalClaimCandidateV1({
        ...base,
        literal: 'x'.repeat(2049),
        rawSpan: { start: 0, end: 2049 },
        mappedSpan: { start: 0, end: 2049 },
      }),
    ).toEqual({ kind: 'candidate_capacity' });
  });

  test('preserves the current generated Claim3 byte cap', () => {
    const base =
      'For summaries, I usually prefer answers in plain Canadian French with one practical example before any technical definitions and like responses in plain Australian English with one worked example ahead of any technical terms.';
    const stressNamespace = 'n' + '\u0001'.repeat(127);
    const near = inputsFor(base.split(' ').join(' '.repeat(50)), {
      namespace: stressNamespace,
    })[0]!;
    expect(buildAutonomousPersonalClaimCandidateV1(near).kind).toBe('candidate');
    const over = inputsFor(base.split(' ').join('\u00a0'.repeat(45)), {
      namespace: stressNamespace,
    })[0]!;
    expect(buildAutonomousPersonalClaimCandidateV1(over)).toEqual({ kind: 'candidate_capacity' });
  });

  test('rejects malformed or mismatched typed DATA with one fixed redacted error', () => {
    const typed = inputsFor('I prefer concise explanations.')[0]!;
    expect(typed.kind).toBe('typed_preference');
    expectFixedInvalid({ ...typed, category: 'project' });
    expectFixedInvalid({ ...typed, kind: 'source_statement_record', bundle: typed.bundle });
    expectFixedInvalid({ ...typed, bundle: null });
    expectFixedInvalid({ ...typed, surprise: 'private-input' });
    expectFixedInvalid({ ...typed, sourceEventTime: 'not-a-canonical-time' });
    expectFixedInvalid({ ...typed, literal: 'private-input' });
    for (const malformedWidth of [
      { ...typed, rawSpan: { ...typed.rawSpan, end: typed.rawSpan.end + 1 } },
      { ...typed, mappedSpan: { ...typed.mappedSpan, end: typed.mappedSpan.end + 1 } },
    ]) {
      expect(
        AutonomousPersonalClaimCandidateV1InputOwnedDataSchema.safeParse(malformedWidth).success,
      ).toBe(false);
      expectFixedInvalid(malformedWidth);
    }

    const statement = inputsFor('I adore jazz.')[0]!;
    expect(statement.kind).toBe('source_statement_record');
    for (const malformedWidth of [
      { ...statement, rawSpan: { ...statement.rawSpan, end: statement.rawSpan.end + 1 } },
      { ...statement, mappedSpan: { ...statement.mappedSpan, end: statement.mappedSpan.end + 1 } },
    ]) {
      expect(
        AutonomousPersonalClaimCandidateV1InputOwnedDataSchema.safeParse(malformedWidth).success,
      ).toBe(false);
      expectFixedInvalid(malformedWidth);
    }
    expect(
      AutonomousPersonalClaimCandidateV1ResultOwnedDataSchema.safeParse({
        kind: 'candidate_capacity',
        detail: 'must stay tag-only',
      }).success,
    ).toBe(false);

    const valid = buildAutonomousPersonalClaimCandidateV1(typed);
    if (valid.kind !== 'candidate') throw new Error('Expected a valid candidate');
    expect(
      AutonomousPersonalClaimCandidateV1ResultOwnedDataSchema.safeParse({
        ...valid,
        reference: { ...valid.reference, meaningHash: '0'.repeat(64) },
      }).success,
    ).toBe(false);
    expect(
      AutonomousPersonalClaimCandidateV1ResultOwnedDataSchema.safeParse({
        ...valid,
        reference: {
          ...valid.reference,
          dependencies: valid.reference.dependencies.map((dependency, index) =>
            index === 0 ? { ...dependency, dependencyHash: '0'.repeat(64) } : dependency,
          ),
        },
      }).success,
    ).toBe(false);
  });

  test('owns arbitrary JavaScript without invoking getters or Proxy traps', () => {
    const base = inputsFor('I adore jazz.')[0]!;
    let getterCalls = 0;
    const withGetter = { ...base };
    Object.defineProperty(withGetter, 'namespace', {
      enumerable: true,
      configurable: true,
      get() {
        getterCalls += 1;
        throw new Error('private getter value');
      },
    });
    expectFixedInvalid(withGetter);
    expect(getterCalls).toBe(0);

    let proxyTrapCalls = 0;
    const proxy = new Proxy(base, {
      ownKeys() {
        proxyTrapCalls += 1;
        throw new Error('private proxy value');
      },
      get() {
        proxyTrapCalls += 1;
        throw new Error('private proxy value');
      },
    });
    expectFixedInvalid(proxy);
    expect(proxyTrapCalls).toBe(0);
  });

  test('enforces beginRequest ownership bound before schema projection', () => {
    const base = inputsFor('I adore jazz.')[0]!;
    expectFixedInvalid({ ...base, unknownPadding: 'x'.repeat(512 * 1024) });
  });
});
