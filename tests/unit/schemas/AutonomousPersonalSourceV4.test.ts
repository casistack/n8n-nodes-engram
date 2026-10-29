import { createHash } from 'crypto';
import {
  compileAutonomousPersonalDescriptorV4,
  hashAutonomousPersonalDescriptorV4,
} from '../../../src/schemas/AutonomousPersonalDescriptorV4.schema';
import { compileAutonomousSourceGeometryV3 } from '../../../src/schemas/AutonomousSourceGeometryV3.schema';
import { hashAutomaticCaptureV2 } from '../../../src/schemas/AutomaticCapture.schema';
import {
  compileAutonomousPersonalSourceTupleV4 as compile,
  AutonomousPersonalOperationIdentityV4Schema as IdentitySchema,
  AutonomousPersonalSourceEnvelopeV3Schema as EnvelopeSchema,
  AutonomousPersonalSourceOwnerV4Schema as OwnerSchema,
  AutonomousPersonalSourceTupleV4Schema as TupleSchema,
  type AutonomousPersonalSourceTupleV4Input,
} from '../../../src/schemas/AutonomousPersonalSourceV4.schema';

const ids = {
  source: '10000000-0000-4000-8000-000000000001',
  previous: '10000000-0000-4000-8000-000000000002',
  binding: '10000000-0000-4000-8000-000000000003',
  subject: '10000000-0000-4000-8000-000000000004',
};

const descriptorInput = () => ({
  profileId: 'conservative',
  requestedTrustLevel: 'standard',
  intentSetting: false,
  invocationDeadlineMs: 30000,
  providerReference: {
    routeId: 'synthetic-route',
    configurationFingerprint: 'd'.repeat(64),
    protocol: 'openai-compatible-json-v1',
    configuredRequestLimit: 2,
    configuredTimeoutMs: 30000,
    configuredRequestBytes: 262144,
    configuredResponseBytes: 65536,
    temperature: { mode: 'providerDefault' },
    responseFormat: 'json_object',
    outputTokenLimit: { mode: 'omit' },
  },
});

const makeInput = (): AutonomousPersonalSourceTupleV4Input => {
  const namespace = 'workflow:one';
  return {
    scope: {
      storeHash: 'a'.repeat(64),
      namespace,
      issuer: 'n8n',
      actorReference: 'user:42',
      turn: 'turn:7',
      binding: {
        bindingId: ids.binding,
        revision: 3,
        subjectId: ids.subject,
        fingerprint: 'b'.repeat(64),
      },
    },
    descriptor: compileAutonomousPersonalDescriptorV4(descriptorInput()),
    producer: {
      uuid: ids.source,
      group_id: namespace,
      content: 'I prefer  practical examples 😀.',
      role: 'human',
      source_type: 'message',
      episode_kind: 'active_human',
      reference_time: '2026-02-01T12:34:56.789+00:00',
      previous_episode_uuid: ids.previous,
      source_message_id: 'message-1',
      idempotency_key: 'event-1',
      conversation_id: 'conversation-1',
      sender_id: 'sender-1',
      source_workflow_id: 'workflow-1',
      source_execution_id: 'original-execution-1',
      quoted_message_id: null,
      created_at: '2026-02-01T13:34:56.789Z',
    },
    eventTimeMode: 'explicit',
    mapping: { mode: 'full_body' },
    quoteRegions: [],
  };
};

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const geometryFor = (input: AutonomousPersonalSourceTupleV4Input) =>
  compileAutonomousSourceGeometryV3({
    rawContent: input.producer.content,
    mapping: input.mapping,
    quoteRegions: input.quoteRegions,
  });

function expectDeepFrozen(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) expectDeepFrozen(child);
}

function setFirstCapture(input: AutonomousPersonalSourceTupleV4Input): void {
  input.eventTimeMode = 'first_capture';
  input.producer.reference_time = input.producer.created_at;
}

describe('autonomous source4 tuple is bounded DATA, not authority', () => {
  test('uses the exact nested hash recipes and returns only frozen metadata', () => {
    const input = makeInput();
    const tuple = compile(input);
    const geometry = geometryFor(input);
    const descriptorHash = hashAutonomousPersonalDescriptorV4(input.descriptor);
    expect(descriptorHash).toBe(
      hashAutomaticCaptureV2({
        domain: 'engram-autonomous-descriptor-v1',
        descriptor: input.descriptor,
      }),
    );
    expect(geometry.geometryHash).toBe(
      hashAutomaticCaptureV2({
        domain: 'engram-autonomous-geometry-v1',
        geometry: geometry.geometry,
      }),
    );
    const contentHash = sha256(input.producer.content);
    const producerHash = hashAutomaticCaptureV2({
      domain: 'engram-autonomous-producer-v1',
      producer: input.producer,
    });
    const eventTimeHash = hashAutomaticCaptureV2({
      domain: 'engram-autonomous-event-time-v1',
      eventTime: {
        mode: input.eventTimeMode,
        canonicalUtcInstant: new Date(Date.parse(input.producer.reference_time)).toISOString(),
      },
    });
    const authority = {
      lifecycle: 'replaySafeV2',
      storeHash: input.scope.storeHash,
      namespace: input.scope.namespace,
      issuer: input.scope.issuer,
      actorReference: input.scope.actorReference,
      turn: input.scope.turn,
      role: 'human',
      purpose: 'human_turn_memory',
      sourceId: input.producer.uuid,
      contentHash,
      producerHash,
      geometryHash: geometry.geometryHash,
      eventTimeMode: input.eventTimeMode,
      eventTimeHash,
      settingsHash: input.descriptor.settingsHash,
      descriptorHash,
      policyFingerprint: input.descriptor.policy.fingerprint,
      binding: input.scope.binding,
      requestedTrustLevel: input.descriptor.requestedTrustLevel,
    };
    const requestedAuthorityHash = hashAutomaticCaptureV2({
      domain: 'engram-autonomous-authority-v1',
      authority,
    });
    const owner = {
      version: 4,
      family: 'autonomous-personal-v1',
      lifecycle: 'replaySafeV2',
      storeHash: input.scope.storeHash,
      namespace: input.scope.namespace,
      issuer: input.scope.issuer,
      actorReference: input.scope.actorReference,
      turn: input.scope.turn,
      role: 'human',
      purpose: 'human_turn_memory',
      sourceId: input.producer.uuid,
      binding: input.scope.binding,
      contentHash,
      producerHash,
      geometryHash: geometry.geometryHash,
      eventTimeMode: input.eventTimeMode,
      eventTimeHash,
      settingsHash: input.descriptor.settingsHash,
      descriptorHash,
      policyFingerprint: input.descriptor.policy.fingerprint,
      requestedAuthorityHash,
      requestedTrustLevel: input.descriptor.requestedTrustLevel,
    };
    const envelope = {
      version: 3,
      family: 'autonomous-personal-v1',
      geometry: geometry.geometry,
      policyRef: {
        version: input.descriptor.policy.version,
        policyId: input.descriptor.policy.policyId,
        policyVersion: input.descriptor.policy.policyVersion,
        profileId: input.descriptor.policy.profileId,
        profileVersion: input.descriptor.policy.profileVersion,
        fingerprint: input.descriptor.policy.fingerprint,
      },
      descriptorHash,
      requestedAuthorityHash,
    };
    const sourceHash = hashAutomaticCaptureV2({
      domain: 'engram-autonomous-source-identity-v1',
      sourceIdentity: { owner, envelope, producerHash, requestedReview: 'accepted' },
    });
    const identity = {
      version: 4,
      lifecycle: 'replaySafeV2',
      storeHash: input.scope.storeHash,
      namespace: input.scope.namespace,
      issuer: input.scope.issuer,
      actorReference: input.scope.actorReference,
      turn: input.scope.turn,
      role: 'human',
      purpose: 'human_turn_memory',
      sourceId: input.producer.uuid,
      sourceHash,
      contentHash,
      producerHash,
      geometryHash: geometry.geometryHash,
      eventTimeMode: input.eventTimeMode,
      eventTimeHash,
      settingsHash: input.descriptor.settingsHash,
      descriptorHash,
      policyFingerprint: input.descriptor.policy.fingerprint,
      requestedAuthorityHash,
      binding: input.scope.binding,
    };

    expect(tuple).toEqual({ owner, envelope, identity });
    expect(Object.keys(tuple).sort()).toEqual(['envelope', 'identity', 'owner']);
    expect(tuple).not.toHaveProperty('source');
    expect(tuple).not.toHaveProperty('producer');
    expect(tuple).not.toHaveProperty('descriptor');
    expect(tuple).not.toHaveProperty('mappedHumanBody');
    expect(JSON.stringify(tuple)).not.toContain(input.producer.content);
    expect(OwnerSchema.parse(tuple.owner)).toEqual(tuple.owner);
    expect(EnvelopeSchema.parse(tuple.envelope)).toEqual(tuple.envelope);
    expect(IdentitySchema.parse(tuple.identity)).toEqual(tuple.identity);
    expect(TupleSchema.parse(tuple)).toEqual(tuple);
    expectDeepFrozen(tuple);
  });

  test('derives exact full-body and application-region geometry with mapped quote offsets', () => {
    const whole = makeInput();
    whole.producer.content = ' Speaker: I prefer  practical examples 😀. ';
    const full = compile(whole);
    expect(full.envelope.geometry).toMatchObject({
      mode: 'full_body',
      rawContentHash: sha256(whole.producer.content),
      mappedContentHash: sha256(whole.producer.content),
      rawUtf16Length: whole.producer.content.length,
      mappedUtf16Length: whole.producer.content.length,
      humanRegion: null,
      mappings: [],
      applicationWrapper: null,
    });

    const region = makeInput();
    const body = 'Quoted “briefly” then I prefer  practical examples 😀.';
    const prefix = 'Application 🧭 human: ';
    region.producer.content = prefix + body + ' [footer]';
    region.mapping = {
      mode: 'application_region',
      humanRegion: { start: prefix.length, end: prefix.length + body.length },
      applicationWrapper: { configurationFingerprint: 'e'.repeat(64) },
    };
    const quoteStart = body.indexOf('“briefly”');
    region.quoteRegions = [{ start: quoteStart, end: quoteStart + '“briefly”'.length }];
    const mapped = compile(region);
    expect(mapped.envelope.geometry).toMatchObject({
      mode: 'application_region',
      rawContentHash: sha256(region.producer.content),
      mappedContentHash: sha256(body),
      rawUtf16Length: region.producer.content.length,
      mappedUtf16Length: body.length,
      humanRegion: { start: prefix.length, end: prefix.length + body.length },
      mappings: [
        {
          rawStart: prefix.length,
          rawEnd: prefix.length + body.length,
          mappedStart: 0,
          mappedEnd: body.length,
        },
      ],
      quoteRegionSpace: 'mapped_utf16',
      quoteRegions: [{ start: quoteStart, end: quoteStart + '“briefly”'.length }],
      applicationWrapper: { configurationFingerprint: 'e'.repeat(64) },
    });
  });

  test('counts application mapping and quote regions together while full-body allows 32 quotes', () => {
    const body = 'x'.repeat(64);
    const quoteRegions = (count: number) =>
      Array.from({ length: count }, (_, index) => ({ start: index * 2, end: index * 2 + 1 }));

    const application31 = makeInput();
    application31.producer.content = '[' + body + ']';
    application31.mapping = {
      mode: 'application_region',
      humanRegion: { start: 1, end: 65 },
      applicationWrapper: { configurationFingerprint: 'e'.repeat(64) },
    };
    application31.quoteRegions = quoteRegions(31);
    expect(compile(application31).envelope.geometry.mappings).toHaveLength(1);
    expect(compile(application31).envelope.geometry.quoteRegions).toHaveLength(31);

    const application32 = makeInput();
    application32.producer.content = '[' + body + ']';
    application32.mapping = application31.mapping;
    application32.quoteRegions = quoteRegions(32);
    expect(() => compile(application32)).toThrow();

    const full32 = makeInput();
    full32.producer.content = body;
    full32.quoteRegions = quoteRegions(32);
    expect(compile(full32).envelope.geometry.quoteRegions).toHaveLength(32);
    full32.quoteRegions = quoteRegions(33);
    expect(() => compile(full32)).toThrow();
  });

  test('rejects missing/forged mapping, quote bounds and surrogate-splitting offsets', () => {
    const base = makeInput();
    base.producer.content = 'x😀y';
    for (const mapping of [
      { mode: 'application_region', humanRegion: { start: 1, end: 3 } },
      {
        mode: 'application_region',
        humanRegion: { start: 1, end: 2 },
        applicationWrapper: { configurationFingerprint: 'e'.repeat(64) },
      },
      {
        mode: 'application_region',
        humanRegion: { start: 1, end: 3 },
        applicationWrapper: { configurationFingerprint: 'not-a-hash' },
      },
    ])
      expect(() => compile({ ...base, mapping } as never)).toThrow();

    const halfQuote = makeInput();
    halfQuote.producer.content = 'x😀y';
    halfQuote.quoteRegions = [{ start: 1, end: 2 }];
    expect(() => compile(halfQuote)).toThrow();

    const overlap = makeInput();
    overlap.producer.content = 'abcdefgh';
    overlap.quoteRegions = [
      { start: 0, end: 3 },
      { start: 2, end: 4 },
    ];
    expect(() => compile(overlap)).toThrow();

    const secondBody = { ...makeInput(), mappedHumanBody: 'forged copy' };
    expect(() => compile(secondBody as never)).toThrow();
  });

  test.each([
    [
      'uuid',
      (input: AutonomousPersonalSourceTupleV4Input) =>
        (input.producer.uuid = '20000000-0000-4000-8000-000000000001'),
    ],
    ['content', (input: AutonomousPersonalSourceTupleV4Input) => (input.producer.content += '!')],
    [
      'reference_time',
      (input: AutonomousPersonalSourceTupleV4Input) =>
        (input.producer.reference_time = '2026-02-02T00:00:00.000Z'),
    ],
    [
      'previous_episode_uuid',
      (input: AutonomousPersonalSourceTupleV4Input) =>
        (input.producer.previous_episode_uuid = null),
    ],
    [
      'source_message_id',
      (input: AutonomousPersonalSourceTupleV4Input) =>
        (input.producer.source_message_id = 'message-2'),
    ],
    [
      'idempotency_key',
      (input: AutonomousPersonalSourceTupleV4Input) => (input.producer.idempotency_key = 'event-2'),
    ],
    [
      'conversation_id',
      (input: AutonomousPersonalSourceTupleV4Input) =>
        (input.producer.conversation_id = 'conversation-2'),
    ],
    [
      'sender_id',
      (input: AutonomousPersonalSourceTupleV4Input) => (input.producer.sender_id = 'sender-2'),
    ],
    [
      'source_workflow_id',
      (input: AutonomousPersonalSourceTupleV4Input) =>
        (input.producer.source_workflow_id = 'workflow-2'),
    ],
    [
      'source_execution_id',
      (input: AutonomousPersonalSourceTupleV4Input) =>
        (input.producer.source_execution_id = 'original-execution-2'),
    ],
    [
      'quoted_message_id',
      (input: AutonomousPersonalSourceTupleV4Input) =>
        (input.producer.quoted_message_id = 'parent-message-1'),
    ],
    [
      'created_at',
      (input: AutonomousPersonalSourceTupleV4Input) =>
        (input.producer.created_at = '2026-02-02T13:34:56.789Z'),
    ],
  ])('binds immutable producer field %s into producerHash and sourceHash', (_field, change) => {
    const original = makeInput();
    const baseline = compile(original);
    const replay = compile(makeInput());
    expect(replay.identity.sourceHash).toBe(baseline.identity.sourceHash);
    expect(replay.owner.producerHash).toBe(baseline.owner.producerHash);

    const changed = makeInput();
    change(changed);
    const compiled = compile(changed);
    expect(compiled.owner.producerHash).not.toBe(baseline.owner.producerHash);
    expect(compiled.identity.sourceHash).not.toBe(baseline.identity.sourceHash);
  });

  test('binds group/scope changes and keeps fixed producer discriminators strict', () => {
    const baseline = compile(makeInput());
    const changed = makeInput();
    changed.scope.namespace = 'workflow:two';
    changed.producer.group_id = changed.scope.namespace;
    const changedTuple = compile(changed);
    expect(changedTuple.owner.producerHash).not.toBe(baseline.owner.producerHash);
    expect(changedTuple.identity.sourceHash).not.toBe(baseline.identity.sourceHash);

    for (const [field, value] of [
      ['role', 'ai'],
      ['source_type', 'document'],
      ['episode_kind', 'assistant_reply'],
    ] as const) {
      const invalid = makeInput();
      (invalid.producer as Record<string, unknown>)[field] = value;
      expect(() => compile(invalid)).toThrow();
    }
  });

  test('requires canonical first-capture equality but preserves explicit timestamps', () => {
    const firstCapture = makeInput();
    setFirstCapture(firstCapture);
    const accepted = compile(firstCapture);
    expect(accepted.identity.eventTimeMode).toBe('first_capture');

    const mismatchedReference = makeInput();
    setFirstCapture(mismatchedReference);
    mismatchedReference.producer.reference_time = '2026-02-01T13:34:56.790Z';
    expect(() => compile(mismatchedReference)).toThrow();

    const mismatchedCreatedAt = makeInput();
    setFirstCapture(mismatchedCreatedAt);
    mismatchedCreatedAt.producer.created_at = '2026-02-01T13:34:56.790Z';
    expect(() => compile(mismatchedCreatedAt)).toThrow();

    const explicit = makeInput();
    expect(explicit.producer.reference_time).not.toBe(explicit.producer.created_at);
    const explicitTuple = compile(explicit);
    const changedTime = makeInput();
    changedTime.producer.reference_time = '2026-02-02T02:34:56.789+02:00';
    const changedTuple = compile(changedTime);
    expect(explicitTuple.owner.eventTimeHash).not.toBe(changedTuple.owner.eventTimeHash);
    expect(explicitTuple.owner.producerHash).not.toBe(changedTuple.owner.producerHash);
  });

  test('keeps explicit producer bytes while canonical event-time hashes compare the same instant', () => {
    const utcOffset = makeInput();
    utcOffset.producer.reference_time = '2026-02-01T12:34:56.789+00:00';
    const utcZ = makeInput();
    utcZ.producer.reference_time = '2026-02-01T12:34:56.789Z';
    const first = compile(utcOffset);
    const second = compile(utcZ);
    expect(first.owner.eventTimeHash).toBe(second.owner.eventTimeHash);
    expect(first.owner.producerHash).not.toBe(second.owner.producerHash);
    expect(first.identity.sourceHash).not.toBe(second.identity.sourceHash);
  });

  test('enforces strict scopes, UUIDs, required nullable fields and complete input keys', () => {
    const base = makeInput();
    const invalidInputs = [
      { ...base, extra: 'unknown' },
      { ...base, scope: { ...base.scope, unknown: true } },
      { ...base, scope: { ...base.scope, storeHash: 'not-a-hash' } },
      {
        ...base,
        scope: {
          ...base.scope,
          binding: { ...base.scope.binding, revision: 0 },
        },
      },
      {
        ...base,
        scope: {
          ...base.scope,
          binding: { ...base.scope.binding, subjectId: 'not-a-uuid' },
        },
      },
      {
        ...base,
        scope: {
          ...base.scope,
          binding: { ...base.scope.binding, invented: true },
        },
      },
      { ...base, producer: { ...base.producer, attributes: {} } },
      { ...base, producer: { ...base.producer, uuid: 'not-a-uuid' } },
      { ...base, producer: { ...base.producer, previous_episode_uuid: 'not-a-uuid' } },
      { ...base, producer: { ...base.producer, group_id: 'some-other-group' } },
      { ...base, producer: { ...base.producer, quoted_message_id: undefined } },
      { ...base, scope: { ...base.scope, actorReference: '\ud800' } },
      { ...base, scope: { ...base.scope, namespace: '   ' } },
      { ...base, eventTimeMode: undefined },
      { ...base, descriptor: { ...base.descriptor, inventedAuthority: true } },
    ];
    for (const invalid of invalidInputs) expect(() => compile(invalid as never)).toThrow();
  });

  test('rejects intrinsic tampering and repeated-field disagreement', () => {
    const tuple = compile(makeInput());
    const badGeometryHash = structuredClone(tuple);
    badGeometryHash.owner.geometryHash = 'c'.repeat(64);
    expect(TupleSchema.safeParse(badGeometryHash).success).toBe(false);

    const badSourceHash = structuredClone(tuple);
    badSourceHash.identity.sourceHash = 'c'.repeat(64);
    expect(TupleSchema.safeParse(badSourceHash).success).toBe(false);

    const repeatedField = structuredClone(tuple);
    repeatedField.identity.contentHash = 'c'.repeat(64);
    expect(TupleSchema.safeParse(repeatedField).success).toBe(false);

    const badPolicyRef = structuredClone(tuple) as unknown as {
      envelope: { policyRef: Record<string, unknown> };
    };
    badPolicyRef.envelope.policyRef.profileVersion = 1;
    expect(TupleSchema.safeParse(badPolicyRef).success).toBe(false);

    const badAuthority = structuredClone(tuple);
    badAuthority.envelope.requestedAuthorityHash = 'c'.repeat(64);
    expect(TupleSchema.safeParse(badAuthority).success).toBe(false);

    const unknown = { ...tuple, should_process: true };
    expect(TupleSchema.safeParse(unknown).success).toBe(false);
  });

  test('treats self-consistent opaque hash origins as DATA, not proof of source bytes', () => {
    const tuple = structuredClone(compile(makeInput()));
    const rawHash = 'c'.repeat(64);
    tuple.envelope.geometry.rawContentHash = rawHash;
    tuple.envelope.geometry.mappedContentHash = rawHash;
    tuple.owner.contentHash = rawHash;
    tuple.identity.contentHash = rawHash;
    tuple.owner.geometryHash = hashAutomaticCaptureV2({
      domain: 'engram-autonomous-geometry-v1',
      geometry: tuple.envelope.geometry,
    });
    tuple.identity.geometryHash = tuple.owner.geometryHash;
    const authority = {
      lifecycle: tuple.owner.lifecycle,
      storeHash: tuple.owner.storeHash,
      namespace: tuple.owner.namespace,
      issuer: tuple.owner.issuer,
      actorReference: tuple.owner.actorReference,
      turn: tuple.owner.turn,
      role: tuple.owner.role,
      purpose: tuple.owner.purpose,
      sourceId: tuple.owner.sourceId,
      contentHash: tuple.owner.contentHash,
      producerHash: tuple.owner.producerHash,
      geometryHash: tuple.owner.geometryHash,
      eventTimeMode: tuple.owner.eventTimeMode,
      eventTimeHash: tuple.owner.eventTimeHash,
      settingsHash: tuple.owner.settingsHash,
      descriptorHash: tuple.owner.descriptorHash,
      policyFingerprint: tuple.owner.policyFingerprint,
      binding: tuple.owner.binding,
      requestedTrustLevel: tuple.owner.requestedTrustLevel,
    };
    tuple.owner.requestedAuthorityHash = hashAutomaticCaptureV2({
      domain: 'engram-autonomous-authority-v1',
      authority,
    });
    tuple.envelope.requestedAuthorityHash = tuple.owner.requestedAuthorityHash;
    tuple.identity.requestedAuthorityHash = tuple.owner.requestedAuthorityHash;
    tuple.identity.sourceHash = hashAutomaticCaptureV2({
      domain: 'engram-autonomous-source-identity-v1',
      sourceIdentity: {
        owner: tuple.owner,
        envelope: tuple.envelope,
        producerHash: tuple.owner.producerHash,
        requestedReview: 'accepted',
      },
    });
    expect(TupleSchema.safeParse(tuple).success).toBe(true);
  });

  test('owns hostile JavaScript without invoking getters, thenables, proxies or toJSON', () => {
    let traps = 0;
    const getter = Object.defineProperty({}, 'then', {
      enumerable: true,
      get: () => ++traps,
    });
    const nestedGetter = makeInput();
    Object.defineProperty(nestedGetter.scope, 'issuer', {
      enumerable: true,
      get: () => ++traps,
    });
    const toJson = { ...makeInput(), toJSON: () => ++traps };
    const proxy = new Proxy(makeInput(), {
      get: () => {
        traps += 1;
        return undefined;
      },
      ownKeys: () => {
        traps += 1;
        return [];
      },
    });
    const cyclic = makeInput() as AutonomousPersonalSourceTupleV4Input & { self?: unknown };
    cyclic.self = cyclic;

    for (const hostile of [getter, nestedGetter, toJson, proxy, cyclic]) {
      expect(() => compile(hostile as never)).toThrow();
      expect(TupleSchema.safeParse(hostile).success).toBe(false);
    }

    const hostileFacades = [OwnerSchema, EnvelopeSchema, IdentitySchema, TupleSchema] as const;
    const hostileValues = [
      Object.defineProperty({}, 'then', { enumerable: true, get: () => ++traps }),
      new Proxy(
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
      ),
      Object.defineProperty({}, 'privateField', { enumerable: true, get: () => ++traps }),
      Object.defineProperty({}, 'toJSON', { enumerable: true, get: () => ++traps }),
    ];
    hostileFacades.forEach((facade, index) => {
      expect(() => facade.parse(hostileValues[index])).toThrow('invalid_autonomous_source_data');
      const result = facade.safeParse(hostileValues[index]);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues).toEqual([
          {
            code: 'custom',
            path: [],
            message: 'invalid_autonomous_source_data',
          },
        ]);
      }
    });
    expect(traps).toBe(0);
  });

  test('detaches output from all caller-owned source, scope and geometry objects', () => {
    const input = makeInput();
    input.mapping = {
      mode: 'application_region',
      humanRegion: { start: 0, end: input.producer.content.length },
      applicationWrapper: { configurationFingerprint: 'e'.repeat(64) },
    };
    input.quoteRegions = [{ start: 0, end: 1 }];
    const tuple = compile(input);
    const before = structuredClone(tuple);

    input.scope.namespace = 'changed-namespace';
    input.scope.binding.revision = 99;
    input.producer.content = 'mutated caller body';
    input.producer.source_execution_id = 'changed-execution';
    input.mapping.humanRegion.start = 1;
    input.quoteRegions[0].end = 2;

    expect(tuple).toEqual(before);
    expectDeepFrozen(tuple);
  });

  test('returns fixed redacted failures for invalid source data', () => {
    const secret = 'private-synthetic-' + 'x'.repeat(500);
    const invalid = { ...makeInput(), privateField: secret };
    expect(() => compile(invalid as never)).toThrow('invalid_autonomous_source_data');
    const result = TupleSchema.safeParse(invalid);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual([
        {
          code: 'custom',
          path: [],
          message: 'invalid_autonomous_source_data',
        },
      ]);
      expect(result.error.message).not.toContain(secret);
    }
  });

  test('performs no provider I/O while compiling or parsing source DATA', () => {
    const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('Unexpected provider I/O');
    });
    try {
      const tuple = compile(makeInput());
      expect(TupleSchema.parse(tuple)).toEqual(tuple);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });

  test('accepts one maximum escaped 64KiB source under the single-source input bound', () => {
    const input = makeInput();
    input.producer.content = '\u0001'.repeat(65_536);
    expect(Buffer.byteLength(input.producer.content, 'utf8')).toBe(65_536);
    expect(Buffer.byteLength(JSON.stringify(input), 'utf8')).toBeLessThan(512 * 1024);
    const tuple = compile(input);
    expect(tuple.owner.contentHash).toBe(sha256(input.producer.content));
    expect(tuple.envelope.geometry.rawUtf16Length).toBe(65_536);
    expect(() =>
      compile({
        ...input,
        producer: { ...input.producer, content: input.producer.content + '\u0001' },
      }),
    ).toThrow();
  });

  test('allows bounded tuple aggregates above 16KiB while each child stays under 16KiB', () => {
    const input = makeInput();
    input.scope.namespace = 'n' + '\u0001'.repeat(127);
    input.scope.issuer = 'i' + '\u0001'.repeat(255);
    input.scope.actorReference = 'a' + '\u0001'.repeat(511);
    input.scope.turn = 't' + '\u0001'.repeat(511);
    input.producer.group_id = input.scope.namespace;
    const tuple = compile(input);
    const ownerBytes = Buffer.byteLength(JSON.stringify(tuple.owner), 'utf8');
    const envelopeBytes = Buffer.byteLength(JSON.stringify(tuple.envelope), 'utf8');
    const identityBytes = Buffer.byteLength(JSON.stringify(tuple.identity), 'utf8');
    const tupleBytes = Buffer.byteLength(JSON.stringify(tuple), 'utf8');

    expect(tupleBytes).toBeGreaterThan(16 * 1024);
    expect(ownerBytes).toBeLessThanOrEqual(16 * 1024);
    expect(envelopeBytes).toBeLessThanOrEqual(16 * 1024);
    expect(identityBytes).toBeLessThanOrEqual(16 * 1024);
    expect(tupleBytes).toBeLessThanOrEqual(32 * 1024);
    expect(TupleSchema.safeParse(tuple).success).toBe(true);
  });
});
