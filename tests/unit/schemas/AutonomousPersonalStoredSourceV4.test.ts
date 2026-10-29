import { ZodError } from 'zod';
import {
  compileAutonomousPersonalDescriptorV4,
  type AutonomousPersonalDescriptorV4Input,
} from '../../../src/schemas/AutonomousPersonalDescriptorV4.schema';
import {
  compileAutonomousPersonalSourceTupleV4,
  reconstructAutonomousPersonalStoredSourceIdentityV4,
  reconstructAutonomousPersonalStoredSourceV4,
  type AutonomousPersonalSourceTupleV4Input,
} from '../../../src/schemas/AutonomousPersonalSourceV4.schema';

const ids = {
  source: '10000000-0000-4000-8000-000000000001',
  previous: '10000000-0000-4000-8000-000000000002',
  replacement: '10000000-0000-4000-8000-000000000099',
  binding: '10000000-0000-4000-8000-000000000003',
  subject: '10000000-0000-4000-8000-000000000004',
};

const descriptorInput = (): AutonomousPersonalDescriptorV4Input => ({
  profileId: 'conservative',
  requestedTrustLevel: 'standard',
  intentSetting: false,
  invocationDeadlineMs: 30_000,
  providerReference: {
    routeId: 'synthetic-route',
    configurationFingerprint: 'd'.repeat(64),
    protocol: 'openai-compatible-json-v1' as const,
    configuredRequestLimit: 2,
    configuredTimeoutMs: 30_000,
    configuredRequestBytes: 262_144,
    configuredResponseBytes: 65_536,
    temperature: { mode: 'providerDefault' as const },
    responseFormat: 'json_object' as const,
    outputTokenLimit: { mode: 'omit' as const },
  },
});

type StoredRow = { [key: string]: unknown; attributes: Record<string, unknown> };

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
      reference_time: '2026-02-01T12:34:56.789Z',
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

function storedRow(
  input: AutonomousPersonalSourceTupleV4Input,
  tuple = compileAutonomousPersonalSourceTupleV4(input),
): StoredRow {
  return {
    uuid: input.producer.uuid,
    group_id: input.producer.group_id,
    content: input.producer.content,
    role: input.producer.role,
    source_type: input.producer.source_type,
    reference_time: input.producer.reference_time,
    previous_episode_uuid: input.producer.previous_episode_uuid,
    created_at: input.producer.created_at,
    updated_at: '2026-02-01T13:35:00.000Z',
    source_message_id: input.producer.source_message_id,
    idempotency_key: input.producer.idempotency_key,
    conversation_id: input.producer.conversation_id,
    sender_id: input.producer.sender_id,
    sender_name: 'Synthetic User',
    episode_kind: input.producer.episode_kind,
    quoted_message_id: input.producer.quoted_message_id,
    trust_level: input.descriptor.requestedTrustLevel,
    confidence: null,
    review_status: 'accepted',
    source_workflow_id: input.producer.source_workflow_id,
    source_execution_id: input.producer.source_execution_id,
    attributes: {
      engram_write_owner_v4: tuple.owner,
      engram_source_envelope_v3: tuple.envelope,
      external_tag: { keep: 'verbatim' },
    },
  };
}

function expectDeepFrozen(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) expectDeepFrozen(child);
}

function expectInvalid(invoke: () => unknown, sentinel?: string): void {
  let caught: unknown;
  try {
    invoke();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ZodError);
  const error = caught as ZodError;
  expect(error.issues).toHaveLength(1);
  expect(error.issues[0]).toMatchObject({
    code: 'custom',
    path: [],
    message: 'invalid_autonomous_stored_source_data',
  });
  expect(error.message).not.toContain(sentinel ?? 'private-source-sentinel');
}

function opaque(row: unknown) {
  return reconstructAutonomousPersonalStoredSourceV4(row);
}

function full(row: unknown, descriptor: unknown) {
  return reconstructAutonomousPersonalStoredSourceIdentityV4({ source: row, descriptor });
}

describe('stored autonomous Source4 reconstruction is bounded DATA, not authority', () => {
  test('rebuilds the opaque orphan tuple and full descriptor tuple without an operation or authority', () => {
    const input = makeInput();
    const tuple = compileAutonomousPersonalSourceTupleV4(input);
    const row = storedRow(input, tuple);

    const sourceInput = structuredClone(row);
    const sourceOnly = opaque(sourceInput);
    sourceInput.attributes['external_tag'] = { keep: 'caller mutation' };
    expect(sourceOnly).toMatchObject({
      version: 4,
      descriptorValidation: 'opaque_only',
      source: row,
      tuple,
    });
    expect(sourceOnly.source).not.toBe(sourceInput);
    expect(sourceOnly.source.attributes['external_tag']).toEqual({ keep: 'verbatim' });
    expect(sourceOnly.tuple.identity).toEqual(tuple.identity);
    expect(sourceOnly).not.toHaveProperty('operation');
    expect(sourceOnly).not.toHaveProperty('receipt');
    expect(sourceOnly).not.toHaveProperty('accepted');
    expect(sourceOnly).not.toHaveProperty('currentAuthority');
    expect(sourceOnly).not.toHaveProperty('safeToUse');
    expect(sourceOnly).not.toHaveProperty('mappedHumanBody');

    const descriptorInput = structuredClone(input.descriptor);
    const fullInput = { source: structuredClone(row), descriptor: descriptorInput };
    const reconstructed = reconstructAutonomousPersonalStoredSourceIdentityV4(fullInput);
    fullInput.source['content'] = 'caller mutation after compilation';
    descriptorInput.provider.routeId = 'mutated-after-compilation';
    expect(reconstructed).toMatchObject({
      version: 4,
      descriptorValidation: 'compiled_descriptor',
      source: row,
      descriptor: input.descriptor,
      tuple,
    });
    expect(reconstructed.tuple.identity).toEqual(tuple.identity);
    expect(reconstructed.source.content).toBe(input.producer.content);
    expect(reconstructed.descriptor.provider.routeId).toBe(input.descriptor.provider.routeId);
    expect(reconstructed).not.toHaveProperty('operation');
    expect(reconstructed).not.toHaveProperty('receipt');
    expect(reconstructed).not.toHaveProperty('authority');
    expect(reconstructed).not.toHaveProperty('verified');
    expectDeepFrozen(sourceOnly);
    expectDeepFrozen(reconstructed);
  });

  test('accepts opaque self-consistent descriptor references but rejects them against a mismatched full descriptor', () => {
    const originalInput = makeInput();
    const changedDescriptorInput = descriptorInput();
    changedDescriptorInput.requestedTrustLevel = 'trusted';
    changedDescriptorInput.providerReference.routeId = 'alternate-route';
    const alternate = {
      ...originalInput,
      descriptor: compileAutonomousPersonalDescriptorV4(changedDescriptorInput),
    };
    const alternateTuple = compileAutonomousPersonalSourceTupleV4(alternate);
    const row = storedRow(originalInput, alternateTuple);

    const sourceOnly = opaque(row);
    expect(sourceOnly.descriptorValidation).toBe('opaque_only');
    expect(sourceOnly.tuple).toEqual(alternateTuple);
    expect(sourceOnly.tuple.owner.requestedTrustLevel).toBe('trusted');
    expectInvalid(() => full(row, originalInput.descriptor));

    const matchingFull = full(row, alternate.descriptor);
    expect(matchingFull.descriptorValidation).toBe('compiled_descriptor');
    expect(matchingFull.tuple).toEqual(alternateTuple);
  });

  test('preserves exact application geometry, astral offsets, quotes, and stored UTC timestamps', () => {
    const input = makeInput();
    const body = 'Quoted “briefly” then I prefer  practical examples 😀.';
    const prefix = 'Application 🧭 human: ';
    input.producer.content = `${prefix}${body} [footer]`;
    input.mapping = {
      mode: 'application_region',
      humanRegion: { start: prefix.length, end: prefix.length + body.length },
      applicationWrapper: { configurationFingerprint: 'e'.repeat(64) },
    };
    const quoteStart = body.indexOf('“briefly”');
    input.quoteRegions = [{ start: quoteStart, end: quoteStart + '“briefly”'.length }];
    const tuple = compileAutonomousPersonalSourceTupleV4(input);
    const row = storedRow(input, tuple);

    expect(opaque(row).tuple).toEqual(tuple);
    const reconstructed = full(row, input.descriptor);
    expect(reconstructed.tuple).toEqual(tuple);
    expect(reconstructed.source.content).toBe(input.producer.content);
    expect(reconstructed.source.reference_time).toBe(input.producer.reference_time);
    expect(reconstructed.source.created_at).toBe(input.producer.created_at);
    expect(reconstructed.tuple.envelope.geometry).toMatchObject({
      mode: 'application_region',
      humanRegion: input.mapping.humanRegion,
      quoteRegions: input.quoteRegions,
    });
  });

  test('requires first-capture time equality and the existing stored UTC-Z episode boundary', () => {
    const firstCapture = makeInput();
    firstCapture.eventTimeMode = 'first_capture';
    firstCapture.producer.reference_time = firstCapture.producer.created_at;
    const firstTuple = compileAutonomousPersonalSourceTupleV4(firstCapture);
    const firstRow = storedRow(firstCapture, firstTuple);
    const reconstructed = full(firstRow, firstCapture.descriptor);
    expect(reconstructed.source.reference_time).toBe(firstCapture.producer.created_at);
    expect(reconstructed.tuple.identity.eventTimeMode).toBe('first_capture');

    const mismatch = structuredClone(firstRow);
    mismatch['reference_time'] = '2026-02-01T12:34:56.789Z';
    expectInvalid(() => opaque(mismatch));

    const offset = structuredClone(firstRow);
    offset['reference_time'] = '2026-02-01T13:34:56.789+00:00';
    expectInvalid(() => opaque(offset));
  });

  test.each([
    ['uuid', (row: StoredRow) => (row['uuid'] = ids.replacement)],
    ['group_id', (row: StoredRow) => (row['group_id'] = 'other-namespace')],
    ['content', (row: StoredRow) => (row['content'] = `${String(row['content'])}!`)],
    ['role', (row: StoredRow) => (row['role'] = 'ai')],
    ['source_type', (row: StoredRow) => (row['source_type'] = 'api')],
    ['episode_kind', (row: StoredRow) => (row['episode_kind'] = 'passive_human')],
    ['reference_time', (row: StoredRow) => (row['reference_time'] = '2026-02-02T12:34:56.789Z')],
    ['previous_episode_uuid', (row: StoredRow) => (row['previous_episode_uuid'] = ids.replacement)],
    ['source_message_id', (row: StoredRow) => (row['source_message_id'] = 'message-2')],
    ['idempotency_key', (row: StoredRow) => (row['idempotency_key'] = 'event-2')],
    ['conversation_id', (row: StoredRow) => (row['conversation_id'] = 'conversation-2')],
    ['sender_id', (row: StoredRow) => (row['sender_id'] = 'sender-2')],
    ['source_workflow_id', (row: StoredRow) => (row['source_workflow_id'] = 'workflow-2')],
    [
      'source_execution_id',
      (row: StoredRow) => (row['source_execution_id'] = 'processing-execution-2'),
    ],
    ['quoted_message_id', (row: StoredRow) => (row['quoted_message_id'] = 'reply-2')],
    ['created_at', (row: StoredRow) => (row['created_at'] = '2026-02-02T13:34:56.789Z')],
  ])(
    'rejects mutation of original producer field %s without substituting processing context',
    (_field, mutate) => {
      const input = makeInput();
      const original = storedRow(input, compileAutonomousPersonalSourceTupleV4(input));
      const changed = structuredClone(original);
      mutate(changed);
      expectInvalid(() => opaque(changed));
      if (_field === 'source_execution_id') {
        expect(original['source_execution_id']).toBe('original-execution-1');
        expect(changed['source_execution_id']).toBe('processing-execution-2');
      }
    },
  );

  test('rejects forged metadata, missing companions, and reserved mixed versions while preserving unrelated attributes', () => {
    const input = makeInput();
    const tuple = compileAutonomousPersonalSourceTupleV4(input);
    const row = storedRow(input, tuple);
    const mutations: Array<(copy: StoredRow) => void> = [
      (copy) => {
        (copy.attributes['engram_write_owner_v4'] as Record<string, unknown>)['contentHash'] =
          'f'.repeat(64);
      },
      (copy) => {
        (copy.attributes['engram_write_owner_v4'] as Record<string, unknown>)[
          'requestedAuthorityHash'
        ] = 'f'.repeat(64);
      },
      (copy) => {
        (copy.attributes['engram_write_owner_v4'] as Record<string, unknown>)['geometryHash'] =
          'f'.repeat(64);
      },
      (copy) => {
        const envelope = copy.attributes['engram_source_envelope_v3'] as Record<string, unknown>;
        (envelope['policyRef'] as Record<string, unknown>)['fingerprint'] = 'f'.repeat(64);
      },
      (copy) => {
        const envelope = copy.attributes['engram_source_envelope_v3'] as Record<string, unknown>;
        (envelope['geometry'] as Record<string, unknown>)['rawContentHash'] = 'f'.repeat(64);
      },
      (copy) => {
        const envelope = copy.attributes['engram_source_envelope_v3'] as Record<string, unknown>;
        (envelope['geometry'] as Record<string, unknown>)['quoteRegions'] = [{ start: 1, end: 2 }];
      },
      (copy) => {
        delete copy.attributes['engram_source_envelope_v3'];
      },
      (copy) => {
        copy.attributes['engram_write_owner_v3'] = structuredClone(
          copy.attributes['engram_write_owner_v4'],
        );
      },
      (copy) => {
        copy.attributes['engram_source_envelope_v4'] = structuredClone(
          copy.attributes['engram_source_envelope_v3'],
        );
      },
      (copy) => {
        const owner = copy.attributes['engram_write_owner_v4'] as Record<string, unknown>;
        owner['version'] = 3;
      },
      (copy) => {
        const envelope = copy.attributes['engram_source_envelope_v3'] as Record<string, unknown>;
        envelope['version'] = 2;
      },
      (copy) => {
        const envelope = copy.attributes['engram_source_envelope_v3'] as Record<string, unknown>;
        envelope['family'] = 'other-family';
      },
    ];
    for (const mutate of mutations) {
      const copy = structuredClone(row);
      mutate(copy);
      expectInvalid(() => opaque(copy));
    }

    const noOwner = structuredClone(row);
    delete noOwner.attributes['engram_write_owner_v4'];
    expectInvalid(() => opaque(noOwner));

    const copied = opaque(row);
    expect(copied.source.attributes['external_tag']).toEqual({ keep: 'verbatim' });
    expect(copied.source.attributes).toEqual(row.attributes);

    const application = makeInput();
    const body = 'Application region with a quote “here” and source facts.';
    const prefix = 'UI wrapper 🧭: ';
    application.producer.content = `${prefix}${body} footer`;
    application.mapping = {
      mode: 'application_region',
      humanRegion: { start: prefix.length, end: prefix.length + body.length },
      applicationWrapper: { configurationFingerprint: 'e'.repeat(64) },
    };
    const applicationTuple = compileAutonomousPersonalSourceTupleV4(application);
    const applicationRow = storedRow(application, applicationTuple);
    const changedRegion = structuredClone(applicationRow);
    const envelope = changedRegion.attributes['engram_source_envelope_v3'] as Record<
      string,
      unknown
    >;
    const geometry = envelope['geometry'] as Record<string, unknown>;
    const oldRegion = geometry['humanRegion'] as { start: number; end: number };
    const changedStart = oldRegion.start + 1;
    const changedEnd = oldRegion.end + 1;
    geometry['humanRegion'] = { start: changedStart, end: changedEnd };
    geometry['mappings'] = [
      {
        rawStart: changedStart,
        rawEnd: changedEnd,
        mappedStart: 0,
        mappedEnd: changedEnd - changedStart,
      },
    ];
    expectInvalid(() => opaque(changedRegion));
  });

  test('rejects an own __proto__ source field before either row parser can strip it', () => {
    const input = makeInput();
    const row = storedRow(input, compileAutonomousPersonalSourceTupleV4(input));
    const forged = structuredClone(row);
    Object.defineProperty(forged, '__proto__', {
      configurable: true,
      enumerable: true,
      writable: true,
      value: { unexpected: 'must not be stripped' },
    });
    expect(Object.prototype.hasOwnProperty.call(forged, '__proto__')).toBe(true);
    expectInvalid(() => opaque(forged));
    expectInvalid(() =>
      reconstructAutonomousPersonalStoredSourceIdentityV4({
        source: forged,
        descriptor: input.descriptor,
      }),
    );
  });

  test('keeps mutable display, review, trust, update, and unrelated metadata out of original identity', () => {
    const input = makeInput();
    const tuple = compileAutonomousPersonalSourceTupleV4(input);
    const original = storedRow(input, tuple);
    const changed = structuredClone(original);
    changed['sender_name'] = 'Renamed display';
    changed['trust_level'] = 'untrusted';
    changed['confidence'] = 0.9;
    changed['review_status'] = 'rejected';
    changed['updated_at'] = '2026-02-02T13:35:00.000Z';
    changed.attributes['external_tag'] = { keep: 'changed unrelated value' };

    const before = opaque(original);
    const after = opaque(changed);
    expect(after.source).toEqual(changed);
    expect(after.tuple).toEqual(before.tuple);
    expect(after.tuple.identity).toEqual(tuple.identity);
    expect(after).not.toHaveProperty('currentTrust');
    expect(after).not.toHaveProperty('reviewDecision');
    expect(after).not.toHaveProperty('proceed');
  });

  test('owns hostile raw rows before Zod, returns one fixed redacted error, and has no I/O', () => {
    const input = makeInput();
    const row = storedRow(input, compileAutonomousPersonalSourceTupleV4(input));
    const sentinel = 'private-source-sentinel';
    let trapCalls = 0;
    const getter = Object.defineProperty({}, 'content', {
      enumerable: true,
      get: () => {
        trapCalls += 1;
        throw new Error(sentinel);
      },
    });
    const proxy = new Proxy(row, {
      get: () => {
        trapCalls += 1;
        throw new Error(sentinel);
      },
    });
    const nestedProxy = structuredClone(row);
    nestedProxy.attributes['external_tag'] = new Proxy(
      {},
      {
        get: () => {
          trapCalls += 1;
          throw new Error(sentinel);
        },
      },
    );
    const cyclic = structuredClone(row);
    cyclic.attributes['cycle'] = cyclic;
    for (const hostile of [getter, proxy, nestedProxy, cyclic]) {
      expectInvalid(() => opaque(hostile), sentinel);
    }

    const getterFullInput = Object.defineProperty({ descriptor: input.descriptor }, 'source', {
      enumerable: true,
      get: () => {
        trapCalls += 1;
        throw new Error(sentinel);
      },
    });
    expectInvalid(
      () => reconstructAutonomousPersonalStoredSourceIdentityV4(getterFullInput),
      sentinel,
    );
    expectInvalid(() =>
      reconstructAutonomousPersonalStoredSourceIdentityV4({
        source: row,
        descriptor: input.descriptor,
        operation: {},
      }),
    );

    for (const key of ['then', 'toJSON']) {
      const hostile = structuredClone(row);
      Object.defineProperty(hostile.attributes, key, {
        enumerable: true,
        value: () => {
          trapCalls += 1;
          throw new Error(sentinel);
        },
      });
      expectInvalid(() => opaque(hostile), sentinel);
    }

    for (const accessor of ['name', 'prototype'] as const) {
      const fakeConstructor = () => undefined;
      if (accessor === 'name') {
        Object.defineProperty(fakeConstructor, 'name', {
          configurable: true,
          get: () => {
            trapCalls += 1;
            throw new Error(sentinel);
          },
        });
      } else {
        Object.defineProperty(fakeConstructor, 'name', { configurable: true, value: 'Object' });
        Object.defineProperty(fakeConstructor, 'prototype', {
          configurable: true,
          get: () => {
            trapCalls += 1;
            throw new Error(sentinel);
          },
        });
      }
      const fakePrototype = Object.create(null) as object;
      Object.defineProperty(fakePrototype, 'constructor', { value: fakeConstructor });
      const hostile = structuredClone(row);
      const fakeValue = Object.create(fakePrototype) as Record<string, unknown>;
      fakeValue.value = 'custom-prototype';
      hostile.attributes.custom = fakeValue;
      expectInvalid(() => opaque(hostile), sentinel);
    }
    expect(trapCalls).toBe(0);

    const large = structuredClone(row);
    large.attributes['large'] = 'x'.repeat(512 * 1024);
    expectInvalid(() => opaque(large));

    const largeNodeCount = structuredClone(row);
    largeNodeCount.attributes['nodes'] = Array.from({ length: 16_500 }, () => null);
    expectInvalid(() => opaque(largeNodeCount));

    const tooDeep = structuredClone(row);
    let cursor: Record<string, unknown> = {};
    tooDeep.attributes['deep'] = cursor;
    for (let index = 0; index < 40; index += 1) {
      const next: Record<string, unknown> = {};
      cursor.next = next;
      cursor = next;
    }
    expectInvalid(() => opaque(tooDeep));

    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('Unexpected network access');
    });
    try {
      expect(fetchSpy).not.toHaveBeenCalled();
      opaque(row);
      full(row, input.descriptor);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test('rejects output expansion past the unchanged 512 KiB aggregate profile', () => {
    const input = makeInput();
    const tuple = compileAutonomousPersonalSourceTupleV4(input);
    const row = storedRow(input, tuple);
    const currentBytes = Buffer.byteLength(JSON.stringify(row), 'utf8');
    const tupleBytes = Buffer.byteLength(JSON.stringify(tuple), 'utf8');
    const cap = 512 * 1024;
    const payloadLength = cap - currentBytes - 128;
    expect(payloadLength).toBeGreaterThan(tupleBytes);
    row.attributes['large'] = 'x'.repeat(payloadLength);
    expect(Buffer.byteLength(JSON.stringify(row), 'utf8')).toBeLessThanOrEqual(cap);
    expectInvalid(() => opaque(row));
  });
});
