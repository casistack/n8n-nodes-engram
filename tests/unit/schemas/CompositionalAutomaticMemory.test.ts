import { createHash } from 'crypto';
import {
  COMPOSITIONAL_CLAIM_ATTRIBUTE,
  COMPOSITIONAL_VALUE_ATTRIBUTE,
  CompositionalAutomaticPolicyV2Schema,
  compileCompositionalAutomaticPolicyV2,
  CompositionalAutomaticDescriptorV3Schema,
  compileCompositionalAutomaticDescriptorV3,
  hashCompositionalAutomaticDescriptorV3,
  CompositionalAutomaticEnvelopeV2Schema,
  CompositionalAutomaticEnvelopeSourceInputV2Schema,
  validateCompositionalAutomaticEnvelopeSourceV2 as validateSource,
  CompositionalAutomaticClaimMetadataV2Schema,
  compositionalAutomaticClaimKeyV2,
  CompositionalAutomaticValueMarkerV2Schema,
  type CompositionalAutomaticEnvelopeV2,
} from '../../../src/schemas/CompositionalAutomaticMemory.schema';
import {
  AutomaticPolicySchema,
  AutomaticSourceEnvelopeSchema,
} from '../../../src/schemas/AutomaticMemory.schema';
import { AutomaticClaimMetadataSchema } from '../../../src/schemas/AutomaticClaim.schema';
import {
  AutomaticOperationDescriptorV2Schema,
  hashAutomaticCaptureV2,
} from '../../../src/schemas/AutomaticCapture.schema';
import { COMPOSITIONAL_PREFERENCE_V2_DESCRIPTOR } from '../../../src/schemas/CompositionalPreferenceV2.schema';
import { interpretCompositionalPreferencesV2 } from '../../../src/extraction/CompositionalPreferenceV2Parser';
import { projectCompositionalPreferenceV2Meaning } from '../../../src/extraction/CompositionalPreferenceV2Meaning';
import { EntityNodeSchema, EntityEdgeSchema } from '../../../src/schemas';
import { RetrievalGovernance } from '../../../src/search/RetrievalGovernance';
import { automaticClaimVisible } from '../../../src/search/AutomaticRetrieval';
import type { IGraphStorage } from '../../../src/storage/IGraphStorage';

const subjectId = '11111111-1111-4111-8111-111111111111';
const sourceId = '22222222-2222-4222-8222-222222222222';
const bindingId = '33333333-3333-4333-8333-333333333333';
const namespace = 'synthetic-compound-test';
const sha = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const validateCompositionalAutomaticEnvelopeSourceV2 = ({
  rawContent,
  mappedContent,
  envelope,
}: Parameters<typeof validateSource>[0]) => validateSource({ rawContent, mappedContent, envelope });

function fixture(
  mappedContent = 'I like responses in plain Australian English, with one worked example ahead of any technical terms.',
  prefix = 'Application 🧭\n',
) {
  const rawContent = `${prefix}${mappedContent}\nApplication footer`;
  const envelope: CompositionalAutomaticEnvelopeV2 = {
    version: 2,
    namespace,
    issuer: 'synthetic-app',
    actorReference: 'synthetic-actor',
    bindingRef: { bindingId, revision: 1, subjectId, fingerprint: 'a'.repeat(64) },
    contentHash: sha(mappedContent),
    rawContentHash: sha(rawContent),
    mappingAuthority: 'application_region',
    humanRegion: { start: prefix.length, end: prefix.length + mappedContent.length },
    mappings: [
      {
        contentStart: 0,
        contentEnd: mappedContent.length,
        rawStart: prefix.length,
        rawEnd: prefix.length + mappedContent.length,
      },
    ],
    quoteRegions: [],
    explicitIntent: false,
    policy: compileCompositionalAutomaticPolicyV2({ profileId: 'conservative' }),
  };
  // Existing interpreter syntactic input only; deliberately no literal policy or
  // owner is fabricated. The standalone parser establishes no actor authority.
  const { policy, ...mapping } = envelope;
  const syntacticEnvelope = { ...mapping, version: 1 };
  const preference = interpretCompositionalPreferencesV2({
    descriptor: COMPOSITIONAL_PREFERENCE_V2_DESCRIPTOR,
    rawContent,
    mappedContent,
    envelope: syntacticEnvelope,
  });
  expect(preference.coverage).toBe('complete');
  expect(preference.bundles).toHaveLength(1);
  const projection = projectCompositionalPreferenceV2Meaning({ preference, namespace, subjectId });
  if (!projection.ok) throw new Error('Synthetic compound must project');
  const claim = {
    version: 2 as const,
    generation: 'compositional-preferences-v2' as const,
    namespace,
    subjectId,
    binding: envelope.bindingRef,
    issuer: envelope.issuer,
    actorReference: envelope.actorReference,
    policy,
    sourceId,
    bundle: preference.bundles[0],
    meaning: projection.meaning,
    key: compositionalAutomaticClaimKeyV2(projection.meaning),
  };
  return { mappedContent, rawContent, envelope, syntacticEnvelope, preference, claim };
}

describe('standalone compositional runtime contracts (no persistence authority)', () => {
  test.each(['conservative', 'explicit', 'reviewFirst'] as const)(
    'compiles exact immutable profile %s with an independent policy/hash',
    (profileId) => {
      const policy = compileCompositionalAutomaticPolicyV2({ profileId });
      expect(policy.autoAccept).toBe(profileId !== 'reviewFirst');
      expect(policy.requiresExplicitIntent).toBe(profileId === 'explicit');
      expect(Object.isFrozen(policy)).toBe(true);
      expect(Object.isFrozen(policy.interpreter)).toBe(true);
      expect(Object.isFrozen(policy.limits)).toBe(true);
      const { fingerprint, ...body } = policy;
      expect(fingerprint).toBe(hashAutomaticCaptureV2(body));
      expect(AutomaticPolicySchema.safeParse(policy).success).toBe(false);
      expect(CompositionalAutomaticPolicyV2Schema.parse(policy)).toEqual(policy);
    },
  );

  test.each([
    undefined,
    {},
    { profileId: 'existing' },
    { profileId: 'personalAssistant' },
    { profileId: 'conservative', autoAccept: true },
  ])('does not implicitly opt in or accept unlisted settings %p', (input) => {
    expect(() => compileCompositionalAutomaticPolicyV2(input as never)).toThrow();
  });

  test.each([
    'autoAccept',
    'requiresExplicitIntent',
    'limits',
    'interpreter',
    'fingerprint',
  ] as const)('rejects self-rehashed unauthorized policy change %s', (field) => {
    const policy = copy(compileCompositionalAutomaticPolicyV2({ profileId: 'conservative' }));
    if (field === 'autoAccept') policy.autoAccept = false;
    if (field === 'requiresExplicitIntent') policy.requiresExplicitIntent = true;
    if (field === 'limits') (policy.limits.nodes as number) = 129;
    if (field === 'interpreter') (policy.interpreter.grammarVersion as number) = 1;
    const body = Object.fromEntries(
      Object.entries(policy).filter(([key]) => key !== 'fingerprint'),
    );
    policy.fingerprint = field === 'fingerprint' ? '0'.repeat(64) : hashAutomaticCaptureV2(body);
    expect(CompositionalAutomaticPolicyV2Schema.safeParse(policy).success).toBe(false);
  });

  test('descriptor is exact human ALL2/synchronous, settings and complete descriptor hashes are distinct', () => {
    const descriptor = compileCompositionalAutomaticDescriptorV3({
      profileId: 'explicit',
      requestedTrustLevel: 'standard',
      intentSetting: true,
      invocationDeadlineMs: 5000,
    });
    const { settingsHash, ...body } = descriptor;
    expect(settingsHash).toBe(hashAutomaticCaptureV2(body));
    expect(hashCompositionalAutomaticDescriptorV3(descriptor)).toBe(
      hashAutomaticCaptureV2(descriptor),
    );
    expect(hashCompositionalAutomaticDescriptorV3(descriptor)).not.toBe(settingsHash);
    expect(AutomaticOperationDescriptorV2Schema.safeParse(descriptor).success).toBe(false);
    for (const changes of [
      { purpose: 'assistant_final_save' },
      { semanticVersion: 1 },
      { lexiconVersion: 1 },
      { materializerVersion: 2 },
      { executionMode: 'durable' },
      { invocationDeadlineMs: 99 },
      { invocationDeadlineMs: 120001 },
      { settingsHash: '0'.repeat(64) },
      { unexpected: true },
    ]) {
      expect(
        CompositionalAutomaticDescriptorV3Schema.safeParse({ ...descriptor, ...changes }).success,
      ).toBe(false);
    }
  });

  test.each([
    'I like responses in plain Australian English, with one worked example ahead of any technical terms.',
    'For summaries, I prefer answers in plain Canadian French with one practical example before any technical definitions.',
    'I prefer responses in plain British English with one practical example before any terminology.',
  ])(
    'preserves full rich compound, all qualifiers, exact original UTF16 source mapping: %s',
    (text) => {
      const data = fixture(text);
      expect(validateCompositionalAutomaticEnvelopeSourceV2(data)).toEqual({ ok: true });
      expect(CompositionalAutomaticEnvelopeV2Schema.parse(data.envelope)).toEqual(data.envelope);
      const claim = CompositionalAutomaticClaimMetadataV2Schema.parse(data.claim);
      expect(claim.bundle.coupling).toBe('coupled');
      for (const node of claim.bundle.members)
        for (const span of node.evidence.spans) {
          expect(data.mappedContent.slice(span.content.start, span.content.end)).toBe(
            data.rawContent.slice(span.raw.start, span.raw.end),
          );
          expect(span.raw.start - span.content.start).toBe(data.envelope.humanRegion.start);
        }
      expect(JSON.stringify(claim)).toContain('as_stated');
      expect(Buffer.byteLength(JSON.stringify(claim))).toBeLessThanOrEqual(32768);
      expect(Buffer.byteLength(JSON.stringify(data.envelope))).toBeLessThanOrEqual(16384);
      expect(claim).not.toHaveProperty('coverage');
      expect(claim).not.toHaveProperty('sourceRequest');
      expect(AutomaticClaimMetadataSchema.safeParse(claim).success).toBe(false);
      expect(AutomaticSourceEnvelopeSchema.safeParse(data.envelope).success).toBe(false);
    },
  );

  test('semantic keys exclude wrapper offsets and occurrence spelling while retaining semantic qualifiers', () => {
    const first = fixture('I prefer practical examples before technical definitions.');
    const shifted = fixture(
      'I prefer practical examples before technical definitions.',
      'Other app 🐘🐘\n',
    );
    expect(first.claim.bundle).not.toEqual(shifted.claim.bundle);
    expect(first.claim.key).toBe(shifted.claim.key);
    expect(fixture('I prefer worked examples before technical definitions.').claim.key).not.toBe(
      first.claim.key,
    );
    expect(fixture('I prefer practical examples after technical definitions.').claim.key).not.toBe(
      first.claim.key,
    );
    const moved = copy(first.claim.meaning);
    moved.namespace = 'other';
    expect(compositionalAutomaticClaimKeyV2(moved)).not.toBe(first.claim.key);
  });

  test.each(['key', 'subjectId', 'namespace', 'binding', 'meaning', 'bundle', 'coverage'] as const)(
    'rejects claim identity/structural mismatch %s',
    (field) => {
      const claim: Record<string, unknown> = copy(fixture().claim);
      if (field === 'key') claim.key = '0'.repeat(64);
      if (field === 'subjectId') claim.subjectId = sourceId;
      if (field === 'namespace') claim.namespace = 'other';
      if (field === 'binding')
        claim.binding = { ...(claim.binding as object), subjectId: sourceId };
      if (field === 'meaning') claim.meaning = fixture('I like JSON.').claim.meaning;
      if (field === 'bundle') claim.bundle = fixture('I like JSON.').claim.bundle;
      if (field === 'coverage') claim.coverage = 'complete';
      expect(CompositionalAutomaticClaimMetadataV2Schema.safeParse(claim).success).toBe(false);
    },
  );

  test('mapping rejects changed hashes, incomplete ranges, quote confusion and surrogate splits without stripping prefixes', () => {
    const data = fixture();
    expect(
      validateCompositionalAutomaticEnvelopeSourceV2({
        ...data,
        rawContent: data.rawContent + 'changed',
      }),
    ).toEqual({ ok: false, reason: 'content_mismatch' });
    const quoteData = fixture('I like JSON.', '🧭Application\n');
    quoteData.envelope.quoteRegions = [{ start: 0, end: quoteData.mappedContent.length }];
    expect(validateCompositionalAutomaticEnvelopeSourceV2(quoteData)).toEqual({ ok: true });
    const quoted = interpretCompositionalPreferencesV2({
      descriptor: COMPOSITIONAL_PREFERENCE_V2_DESCRIPTOR,
      rawContent: quoteData.rawContent,
      mappedContent: quoteData.mappedContent,
      envelope: { ...quoteData.syntacticEnvelope, quoteRegions: quoteData.envelope.quoteRegions },
    });
    expect(quoted.bundles).toHaveLength(0);
    quoteData.envelope.quoteRegions = [
      { start: quoteData.envelope.humanRegion.start, end: quoteData.envelope.humanRegion.end },
    ];
    expect(validateCompositionalAutomaticEnvelopeSourceV2(quoteData)).toEqual({
      ok: false,
      reason: 'invalid_quote_regions',
    });
    const gap = copy(data.envelope);
    gap.mappings[0].contentEnd--;
    expect(CompositionalAutomaticEnvelopeV2Schema.safeParse(gap).success).toBe(false);
    const full = fixture('I like JSON.', '');
    full.envelope.mappingAuthority = 'whole_source';
    expect(validateCompositionalAutomaticEnvelopeSourceV2(full)).toEqual({
      ok: false,
      reason: 'incomplete_mapping',
    });
    const malformed = '\uD800';
    expect(
      validateCompositionalAutomaticEnvelopeSourceV2({ ...data, mappedContent: malformed }),
    ).toEqual({ ok: false, reason: 'invalid_unicode' });
    const big = '🐘'.repeat(20000);
    expect(validateCompositionalAutomaticEnvelopeSourceV2({ ...data, mappedContent: big })).toEqual(
      { ok: false, reason: 'source_capacity' },
    );
  });

  test('unknown huge, cyclic and accessor metadata is rejected before deep schema work', () => {
    const claim = fixture().claim;
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    let visits = 0;
    const accessor = Object.defineProperty({}, 'sourceId', {
      enumerable: true,
      get: () => {
        visits++;
        throw new Error('must not read');
      },
    });
    for (const input of [
      { ...claim, huge: 'x'.repeat(2_000_000) },
      { ...claim, huge: cycle },
      accessor,
      { ...claim, huge: Array(100000).fill(null) },
    ]) {
      expect(CompositionalAutomaticClaimMetadataV2Schema.safeParse(input).success).toBe(false);
    }
    expect(visits).toBe(0);
    expect(
      CompositionalAutomaticEnvelopeV2Schema.safeParse({
        ...fixture().envelope,
        quoteRegions: Array(33).fill({ start: 0, end: 1 }),
      }).success,
    ).toBe(false);
    expect(
      CompositionalAutomaticEnvelopeV2Schema.safeParse({ ...fixture().envelope, mappings: [] })
        .success,
    ).toBe(false);
  });

  test('all mapped and quote boundaries respect original UTF16 code points', () => {
    const base = fixture();
    const mappedContent = '🐘I like JSON.';
    const rawContent = `🧭app\n${mappedContent}`;
    const start = '🧭app\n'.length;
    const envelope = {
      ...base.envelope,
      contentHash: sha(mappedContent),
      rawContentHash: sha(rawContent),
      humanRegion: { start, end: rawContent.length },
      mappings: [
        {
          contentStart: 0,
          contentEnd: mappedContent.length,
          rawStart: start,
          rawEnd: rawContent.length,
        },
      ],
      quoteRegions: [{ start: 0, end: 2 }],
    };
    expect(validateSource({ rawContent, mappedContent, envelope })).toEqual({ ok: true });
    expect(
      validateSource({
        rawContent,
        mappedContent,
        envelope: { ...envelope, quoteRegions: [{ start: 0, end: 1 }] },
      }),
    ).toEqual({ ok: false, reason: 'invalid_quote_regions' });
    expect(
      validateSource({
        rawContent,
        mappedContent,
        envelope: {
          ...envelope,
          mappings: [
            { contentStart: 0, contentEnd: 1, rawStart: start, rawEnd: start + 1 },
            {
              contentStart: 1,
              contentEnd: mappedContent.length,
              rawStart: start + 1,
              rawEnd: rawContent.length,
            },
          ],
        },
      }),
    ).toEqual({ ok: false, reason: 'invalid_unicode' });
    const normalized = rawContent.normalize('NFC') + '\u0301';
    expect(validateSource({ rawContent: normalized, mappedContent, envelope })).toEqual({
      ok: false,
      reason: 'content_mismatch',
    });
    expect(validateSource({ rawContent, mappedContent, envelope, extra: true } as never)).toEqual({
      ok: false,
      reason: 'invalid_envelope',
    });
  });

  test('one claim cannot package multiple bundles or a vacuous meaning', () => {
    const claim = fixture().claim;
    for (const bundles of [[], [...claim.meaning.bundles, ...claim.meaning.bundles]]) {
      const meaning = { ...claim.meaning, bundles };
      expect(() => compositionalAutomaticClaimKeyV2(meaning)).toThrow();
      expect(
        CompositionalAutomaticClaimMetadataV2Schema.safeParse({ ...claim, meaning }).success,
      ).toBe(false);
    }
  });

  test('source integrity preserves the exact 64KiB UTF8 cap independently of UTF16 length', () => {
    const original = fixture().envelope;
    const validate = (text: string) =>
      validateSource({
        rawContent: text,
        mappedContent: text,
        envelope: {
          ...original,
          mappingAuthority: 'whole_source',
          humanRegion: { start: 0, end: text.length },
          contentHash: sha(text),
          rawContentHash: sha(text),
          mappings: [
            { contentStart: 0, contentEnd: text.length, rawStart: 0, rawEnd: text.length },
          ],
          quoteRegions: [],
        },
      });
    expect(validate('a'.repeat(65536))).toEqual({ ok: true });
    expect(validate('\u0000'.repeat(65536))).toEqual({ ok: true });
    expect(validate('é'.repeat(32768))).toEqual({ ok: true });
    expect(validate('é'.repeat(32769))).toEqual({ ok: false, reason: 'source_capacity' });
  });

  test('source wrapper preflight rejects getters/proxies/unknown data before Zod without scanning source strings as metadata', () => {
    const data = fixture();
    let reads = 0;
    const getter = Object.defineProperty(
      { mappedContent: data.mappedContent, envelope: data.envelope },
      'rawContent',
      {
        enumerable: true,
        get() {
          reads++;
          throw new Error('private error');
        },
      },
    );
    expect(validateSource(getter as never)).toEqual({ ok: false, reason: 'invalid_envelope' });
    expect(CompositionalAutomaticEnvelopeSourceInputV2Schema.safeParse(getter).success).toBe(false);
    expect(reads).toBe(0);
    let traps = 0;
    const proxy = new Proxy(
      {},
      {
        ownKeys() {
          traps++;
          throw new Error('private proxy');
        },
        getPrototypeOf() {
          traps++;
          throw new Error('private prototype');
        },
      },
    );
    expect(validateSource(proxy as never)).toEqual({ ok: false, reason: 'invalid_envelope' });
    expect(traps).toBe(0);
    const thenGetter = Object.defineProperty(
      { rawContent: data.rawContent, mappedContent: data.mappedContent, envelope: data.envelope },
      'then',
      {
        get() {
          reads++;
          throw new Error('must precede Zod type detection');
        },
      },
    );
    expect(validateSource(thenGetter)).toEqual({ ok: false, reason: 'invalid_envelope' });
    expect(reads).toBe(0);
    expect(
      validateSource({
        rawContent: data.rawContent,
        mappedContent: data.mappedContent,
        envelope: data.envelope,
        extra: 'x'.repeat(2_000_000),
      } as never),
    ).toEqual({ ok: false, reason: 'invalid_envelope' });
    expect(
      validateSource({
        rawContent: 'x'.repeat(2_000_000),
        mappedContent: data.mappedContent,
        envelope: data.envelope,
      }),
    ).toEqual({ ok: false, reason: 'invalid_envelope' });
    const detached = structuredClone({
      rawContent: data.rawContent,
      mappedContent: data.mappedContent,
      envelope: data.envelope,
    });
    expect(validateSource(detached)).toEqual({ ok: true });
  });

  test('actual existing entity and edge governance hides the new protected payloads without treating marker as authority', async () => {
    const claim = CompositionalAutomaticClaimMetadataV2Schema.parse(fixture().claim);
    const marker = CompositionalAutomaticValueMarkerV2Schema.parse({
      version: 2,
      generation: 'compositional-preferences-v2',
      key: claim.key,
    });
    const now = '2026-10-25T12:00:00.000Z';
    const entity = EntityNodeSchema.parse({
      uuid: subjectId,
      name: 'Synthetic compound value',
      group_id: namespace,
      created_at: now,
      updated_at: now,
      attributes: { [COMPOSITIONAL_VALUE_ATTRIBUTE]: marker },
    });
    const edge = EntityEdgeSchema.parse({
      uuid: bindingId,
      group_id: namespace,
      source_node_uuid: subjectId,
      target_node_uuid: sourceId,
      name: 'PREFERS',
      fact: 'Synthetic compound',
      created_at: now,
      updated_at: now,
      attributes: { [COMPOSITIONAL_CLAIM_ATTRIBUTE]: claim },
    });
    const storage = {
      getEpisodes: jest.fn().mockResolvedValue([]),
      getEntity: jest.fn(),
      getEpisode: jest.fn(),
    } as unknown as IGraphStorage;
    const governance = new RetrievalGovernance(storage);
    const entities = await governance.governEntitiesWithDecisions([{ entity, score: 1 }]);
    expect(entities.results).toEqual([]);
    expect(entities.decisions[0].reasons).toContain('attributed_value_only');
    const edges = await governance.governEdgesWithDecisions([
      { edge, sourceEntity: entity, targetEntity: { ...entity, uuid: sourceId }, score: 1 },
    ]);
    expect(edges.results).toEqual([]);
    expect(edges.decisions[0].reasons).toContain('automatic_claim_authority');
    for (const mode of ['current', 'historical', 'asOf'] as const) {
      const sources = { remaining: 512, deferred: 0 };
      expect(
        await automaticClaimVisible(storage, edge, sources, { remaining: 128 }, { mode, at: now }),
      ).toBe('hidden');
      expect(sources.remaining).toBe(512);
    }
    expect(storage.getEntity).not.toHaveBeenCalled();
    expect(storage.getEpisode).not.toHaveBeenCalled();
    expect(
      CompositionalAutomaticValueMarkerV2Schema.safeParse({ ...marker, accepted: true }).success,
    ).toBe(false);
  });
});
