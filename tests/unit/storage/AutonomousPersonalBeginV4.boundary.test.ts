import { createHash } from 'crypto';
import { ZodError } from 'zod';
import {
  compileAutonomousPersonalDescriptorV4,
  hashAutonomousPersonalDescriptorV4,
} from '../../../src/schemas/AutonomousPersonalDescriptorV4.schema';
import { hashAutomaticCaptureV2 } from '../../../src/schemas/AutomaticCapture.schema';
import {
  reconstructAutonomousPersonalStoredSourceIdentityV4,
  compileAutonomousPersonalSourceTupleV4,
} from '../../../src/schemas/AutonomousPersonalSourceV4.schema';
import type { AutonomousPersonalBeginV4Request } from '../../../src/schemas/AutonomousPersonalBeginV4.schema';
import {
  compileAutonomousPersonalFreshSourceV4,
  hashAutonomousPersonalAttemptV4,
  hashAutonomousPersonalStableRequestV4,
  parseAutonomousPersonalBeginV4Input,
} from '../../../src/storage/AutonomousPersonalCaptureBeginV4';
import { automaticWriteOwnerIdempotencyKey } from '../../../src/storage/AutomaticIdentity';

const ids = {
  source: '20000000-0000-4000-8000-000000000001',
  previous: '20000000-0000-4000-8000-000000000002',
  binding: '20000000-0000-4000-8000-000000000003',
  subject: '20000000-0000-4000-8000-000000000004',
};

const createdAt = '2026-10-27T12:00:00.000Z';
const explicitTime = '2026-10-27T11:59:00.000Z';

function makeRequest(
  content = 'I prefer practical examples 😀.',
): AutonomousPersonalBeginV4Request {
  return {
    version: 4,
    lifecycle: 'replaySafeV2',
    purpose: 'human_turn_memory',
    interpretationFamily: 'autonomous-personal-v1',
    namespace: 'workflow:one',
    issuer: 'n8n',
    actorReference: 'user:42',
    turn: 'turn:7',
    settings: {
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
    },
    source: {
      content,
      sourceMessageId: 'message-1',
      conversationId: 'conversation-1',
      senderId: 'sender-1',
      sourceWorkflowId: 'workflow-1',
      quotedMessageId: null,
      sourceType: 'message',
      eventTime: { mode: 'explicit', value: explicitTime },
      mapping: { mode: 'full_body' },
      quoteRegions: [],
    },
  };
}

function makeContext(execution = 'execution-A') {
  return {
    storeHash: 'a'.repeat(64),
    namespace: 'workflow:one',
    issuer: 'n8n',
    actorReference: 'user:42',
    turn: 'turn:7',
    binding: {
      bindingId: ids.binding,
      revision: 3,
      subjectId: ids.subject,
      fingerprint: 'b'.repeat(64),
    },
    instance: 'instance-1',
    workflow: 'workflow-1',
    execution,
  };
}

function readyRequest(request: AutonomousPersonalBeginV4Request = makeRequest()) {
  const result = parseAutonomousPersonalBeginV4Input({ mode: 'existingStore', request });
  expect(result.kind).toBe('ready');
  if (result.kind !== 'ready') throw new Error('Expected owned Begin4 request DATA');
  return result.request;
}

function expectDeepFrozen(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) expectDeepFrozen(child);
}

function expectFixedError(invoke: () => unknown, code: string, sentinel: string): void {
  let caught: unknown;
  try {
    invoke();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  const error = caught as Error;
  expect(error.message).not.toContain(sentinel);
  if (error instanceof ZodError) {
    expect(error.issues).toHaveLength(1);
    expect(error.issues[0]).toMatchObject({ code: 'custom', path: [], message: code });
    expect(Object.isFrozen(error)).toBe(true);
    expect(Object.isFrozen(error.issues)).toBe(true);
    expect(Object.isFrozen(error.issues[0]?.path)).toBe(true);
    expect(Object.isFrozen(error.issues[0])).toBe(true);
  } else {
    expect(error.message).toBe(code);
  }
}

function storedRow(
  fresh: ReturnType<typeof compileAutonomousPersonalFreshSourceV4>,
): Record<string, unknown> {
  return {
    uuid: fresh.producer.uuid,
    group_id: fresh.producer.group_id,
    content: fresh.producer.content,
    role: fresh.producer.role,
    source_type: fresh.producer.source_type,
    reference_time: fresh.producer.reference_time,
    previous_episode_uuid: fresh.producer.previous_episode_uuid,
    created_at: fresh.producer.created_at,
    updated_at: fresh.producer.created_at,
    source_message_id: fresh.producer.source_message_id,
    idempotency_key: fresh.producer.idempotency_key,
    conversation_id: fresh.producer.conversation_id,
    sender_id: fresh.producer.sender_id,
    sender_name: 'Synthetic User',
    episode_kind: fresh.producer.episode_kind,
    quoted_message_id: fresh.producer.quoted_message_id,
    trust_level: fresh.descriptor.requestedTrustLevel,
    confidence: null,
    review_status: 'accepted',
    source_workflow_id: fresh.producer.source_workflow_id,
    source_execution_id: fresh.producer.source_execution_id,
    attributes: {
      engram_write_owner_v4: fresh.tuple.owner,
      engram_source_envelope_v3: fresh.tuple.envelope,
      external_tag: { retained: true },
    },
  };
}

describe('autonomous Begin4 Stage1 remains bounded DATA only', () => {
  test('owns, detaches and freezes the strict request before returning ready', () => {
    const rawRequest = makeRequest();
    const raw = { mode: 'existingStore', request: rawRequest };
    const result = parseAutonomousPersonalBeginV4Input(raw);

    expect(result).toMatchObject({ kind: 'ready', mode: 'existingStore' });
    expectDeepFrozen(result);
    if (result.kind !== 'ready') return;
    expect(result.request).not.toBe(rawRequest);
    expect(result.request.source).not.toBe(rawRequest.source);

    rawRequest.source.content = 'mutated after ownership';
    expect(result.request.source.content).toBe('I prefer practical examples 😀.');
    expect(result).not.toHaveProperty('operation');
    expect(result).not.toHaveProperty('handle');
    expect(result).not.toHaveProperty('authorized');
  });

  test('uses strict mode/request parsing without consulting a native-store authority', () => {
    expect(
      parseAutonomousPersonalBeginV4Input({ mode: 'existingStore', request: makeRequest() }),
    ).toMatchObject({
      kind: 'ready',
    });
    expect(
      parseAutonomousPersonalBeginV4Input({ mode: 'otherStore', request: makeRequest() }),
    ).toEqual({
      kind: 'unsupported_mode',
    });
    expect(
      parseAutonomousPersonalBeginV4Input({
        mode: 'otherStore',
        request: { ...makeRequest(), unexpected: 'private-sentinel' },
      }),
    ).toEqual({ kind: 'unsupported_mode' });
    expect(
      parseAutonomousPersonalBeginV4Input({
        mode: 'existingStore',
        request: { ...makeRequest(), callerHash: 'private-sentinel' },
      }),
    ).toEqual({ kind: 'invalid_input' });
  });

  test('rejects hostile raw wrappers without invoking getters, proxies or serialization hooks', () => {
    let calls = 0;
    const getterWrapper = { request: makeRequest() } as Record<string, unknown>;
    Object.defineProperty(getterWrapper, 'mode', {
      enumerable: true,
      get() {
        calls += 1;
        throw new Error('private-sentinel');
      },
    });
    const nestedGetter = makeRequest();
    Object.defineProperty(nestedGetter.source, 'content', {
      enumerable: true,
      get() {
        calls += 1;
        throw new Error('private-sentinel');
      },
    });
    const proxy = new Proxy(
      { mode: 'existingStore', request: makeRequest() },
      {
        get() {
          calls += 1;
          throw new Error('private-sentinel');
        },
        ownKeys() {
          calls += 1;
          throw new Error('private-sentinel');
        },
      },
    );
    const proto = Object.create(null) as Record<string, unknown>;
    const fakeConstructor = () => {};
    Object.defineProperty(fakeConstructor, 'name', {
      configurable: true,
      get() {
        calls += 1;
        throw new Error('private-sentinel');
      },
    });
    Object.defineProperty(fakeConstructor, 'prototype', {
      configurable: true,
      get() {
        calls += 1;
        throw new Error('private-sentinel');
      },
    });
    Object.defineProperty(proto, 'constructor', { value: fakeConstructor });
    const fakeNativeObject = Object.create(proto) as Record<string, unknown>;
    Object.defineProperty(fakeNativeObject, 'mode', {
      value: 'existingStore',
      enumerable: true,
    });
    Object.defineProperty(fakeNativeObject, 'request', {
      value: makeRequest(),
      enumerable: true,
    });
    const protoKey = { mode: 'existingStore', request: makeRequest() } as Record<string, unknown>;
    Object.defineProperty(protoKey, '__proto__', { value: { poisoned: true }, enumerable: true });
    const toJson = { mode: 'existingStore', request: makeRequest() } as Record<string, unknown>;
    Object.defineProperty(toJson, 'toJSON', {
      enumerable: true,
      get() {
        calls += 1;
        throw new Error('private-sentinel');
      },
    });

    for (const hostile of [
      getterWrapper,
      { mode: 'existingStore', request: nestedGetter },
      proxy,
      fakeNativeObject,
      protoKey,
      toJson,
    ]) {
      expect(parseAutonomousPersonalBeginV4Input(hostile)).toEqual({ kind: 'invalid_input' });
    }
    expect(calls).toBe(0);
  });

  test('enforces the full escaped-source and outer beginRequest bounds', () => {
    const maximumEscaped = makeRequest('\u0001'.repeat(65_536));
    expect(
      parseAutonomousPersonalBeginV4Input({ mode: 'existingStore', request: maximumEscaped }),
    ).toMatchObject({
      kind: 'ready',
    });

    const overSource = makeRequest('\u0001'.repeat(65_537));
    expect(
      parseAutonomousPersonalBeginV4Input({ mode: 'existingStore', request: overSource }),
    ).toEqual({
      kind: 'invalid_input',
    });

    const overOuter = {
      mode: 'existingStore',
      request: makeRequest(),
      padding: 'x'.repeat(512 * 1024),
    };
    expect(parseAutonomousPersonalBeginV4Input(overOuter)).toEqual({ kind: 'invalid_input' });

    const overUtf8 = makeRequest('😀'.repeat(16_385));
    expect(
      parseAutonomousPersonalBeginV4Input({ mode: 'existingStore', request: overUtf8 }),
    ).toEqual({
      kind: 'invalid_input',
    });
  });

  test('hashes exact source and native-attempt preimages without normalizing Unicode', () => {
    const request = readyRequest();
    const context = makeContext();
    const descriptor = compileAutonomousPersonalDescriptorV4(request.settings);
    const descriptorHash = hashAutonomousPersonalDescriptorV4(descriptor);
    const eventTime = request.source.eventTime;
    const event = {
      lifecycle: request.lifecycle,
      purpose: request.purpose,
      interpretationFamily: request.interpretationFamily,
      storeHash: context.storeHash,
      namespace: request.namespace,
      issuer: request.issuer,
      actorReference: request.actorReference,
      turn: request.turn,
      originMode: 'processing_first_capture',
      source: {
        contentHash: createHash('sha256').update(request.source.content, 'utf8').digest('hex'),
        sourceMessageId: request.source.sourceMessageId,
        conversationId: request.source.conversationId,
        senderId: request.source.senderId,
        sourceWorkflowId: request.source.sourceWorkflowId,
        sourceType: 'message',
        episodeKind: 'active_human',
        quotedMessageId: request.source.quotedMessageId,
        eventTime,
        mapping: request.source.mapping,
        quoteRegions: request.source.quoteRegions,
      },
      descriptorHash,
      binding: context.binding,
    };
    const expectedStable = hashAutomaticCaptureV2({
      domain: 'engram-autonomous-begin-event-v1',
      event,
    });
    const expectedAttempt = hashAutomaticCaptureV2({
      domain: 'engram-native-human-processing-v4',
      instance: context.instance,
      workflow: context.workflow,
      execution: context.execution,
      namespace: context.namespace,
      issuer: context.issuer,
      actorReference: context.actorReference,
      turn: context.turn,
    });

    expect(hashAutonomousPersonalStableRequestV4({ request, context })).toBe(expectedStable);
    expect(hashAutonomousPersonalAttemptV4(context)).toBe(expectedAttempt);

    const nfcRequest = readyRequest(makeRequest('I prefer café.'));
    const nfdRequest = readyRequest(makeRequest('I prefer cafe\u0301.'));
    expect(hashAutonomousPersonalStableRequestV4({ request: nfcRequest, context })).not.toBe(
      hashAutonomousPersonalStableRequestV4({ request: nfdRequest, context }),
    );
  });

  test('rejects ill-formed Unicode in raw content and context before hashing', () => {
    const malformedContent = makeRequest('bad\ud800');
    expect(
      parseAutonomousPersonalBeginV4Input({ mode: 'existingStore', request: malformedContent }),
    ).toEqual({
      kind: 'invalid_input',
    });

    const request = readyRequest();
    const malformedContext = { ...makeContext(), execution: 'bad\ud800' };
    expectFixedError(
      () => hashAutonomousPersonalAttemptV4(malformedContext),
      'invalid_autonomous_begin_v4_hash_data',
      'bad\ud800',
    );
    expectFixedError(
      () => hashAutonomousPersonalStableRequestV4({ request, context: malformedContext }),
      'invalid_autonomous_begin_v4_hash_data',
      'bad\ud800',
    );

    const validNfc = readyRequest(makeRequest('é'));
    const validNfd = readyRequest(makeRequest('e\u0301'));
    expect(validNfc.source.content).not.toBe(validNfd.source.content);
  });

  test('rejects hostile context values with fixed redacted hash failures and no trap calls', () => {
    let calls = 0;
    const getterContext = makeContext() as Record<string, unknown>;
    Object.defineProperty(getterContext, 'execution', {
      enumerable: true,
      get() {
        calls += 1;
        throw new Error('private-context-sentinel');
      },
    });
    const proxiedContext = new Proxy(makeContext(), {
      get() {
        calls += 1;
        throw new Error('private-context-sentinel');
      },
      ownKeys() {
        calls += 1;
        throw new Error('private-context-sentinel');
      },
    });
    expectFixedError(
      () => hashAutonomousPersonalAttemptV4(getterContext),
      'invalid_autonomous_begin_v4_hash_data',
      'private-context-sentinel',
    );
    expectFixedError(
      () => hashAutonomousPersonalAttemptV4(proxiedContext),
      'invalid_autonomous_begin_v4_hash_data',
      'private-context-sentinel',
    );
    expect(calls).toBe(0);
  });

  test('requires request/context scope DATA to agree without treating valid forged context as authority', () => {
    const request = readyRequest();
    const mismatchedContext = { ...makeContext(), namespace: 'another-namespace' };
    expectFixedError(
      () => hashAutonomousPersonalStableRequestV4({ request, context: mismatchedContext }),
      'invalid_autonomous_begin_v4_hash_data',
      'another-namespace',
    );
    expectFixedError(
      () =>
        compileAutonomousPersonalFreshSourceV4({
          request,
          context: mismatchedContext,
          sourceId: ids.source,
          previousEpisodeUuid: ids.previous,
          createdAt,
        }),
      'invalid_autonomous_begin_v4_source_data',
      'another-namespace',
    );

    const forgedButWellFormedContext = {
      ...makeContext(),
      storeHash: 'f'.repeat(64),
      binding: { ...makeContext().binding, revision: 77 },
    };
    const dataHash = hashAutonomousPersonalStableRequestV4({
      request,
      context: forgedButWellFormedContext,
    });
    expect(dataHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify({ dataHash })).not.toMatch(/authority|authorized|permit|handle/iu);
  });

  test('builds a fresh Source4 tuple from owned data and handles first_capture without defaults', () => {
    const request = readyRequest();
    const context = makeContext();
    const fresh = compileAutonomousPersonalFreshSourceV4({
      request,
      context,
      sourceId: ids.source,
      previousEpisodeUuid: ids.previous,
      createdAt,
    });
    const descriptor = compileAutonomousPersonalDescriptorV4(request.settings);
    const expectedProducer = {
      uuid: ids.source,
      group_id: context.namespace,
      content: request.source.content,
      role: 'human',
      source_type: 'message',
      episode_kind: 'active_human',
      reference_time: explicitTime,
      previous_episode_uuid: ids.previous,
      source_message_id: request.source.sourceMessageId,
      idempotency_key: automaticWriteOwnerIdempotencyKey({ turn: context.turn, role: 'human' }),
      conversation_id: request.source.conversationId,
      sender_id: request.source.senderId,
      source_workflow_id: request.source.sourceWorkflowId,
      source_execution_id: context.execution,
      quoted_message_id: request.source.quotedMessageId,
      created_at: createdAt,
    };
    const expectedTuple = compileAutonomousPersonalSourceTupleV4({
      scope: {
        storeHash: context.storeHash,
        namespace: context.namespace,
        issuer: context.issuer,
        actorReference: context.actorReference,
        turn: context.turn,
        binding: context.binding,
      },
      descriptor,
      producer: expectedProducer,
      eventTimeMode: 'explicit',
      mapping: request.source.mapping,
      quoteRegions: request.source.quoteRegions,
    });
    expect(fresh).toEqual({
      version: 4,
      descriptor,
      producer: expectedProducer,
      tuple: expectedTuple,
    });
    expectDeepFrozen(fresh);
    expect(fresh).not.toHaveProperty('operation');
    expect(fresh).not.toHaveProperty('handle');
    expect(fresh.producer.content).toBe(request.source.content);

    const firstCaptureBase = makeRequest();
    const firstCaptureRequest = readyRequest({
      ...firstCaptureBase,
      source: { ...firstCaptureBase.source, eventTime: { mode: 'first_capture' } },
    });
    const firstCapture = compileAutonomousPersonalFreshSourceV4({
      request: firstCaptureRequest,
      context,
      sourceId: ids.source,
      previousEpisodeUuid: null,
      createdAt,
    });
    expect(firstCapture.producer.created_at).toBe(createdAt);
    expect(firstCapture.producer.reference_time).toBe(createdAt);
    expect(firstCapture.tuple.identity.eventTimeMode).toBe('first_capture');
  });

  test('reuses Source4 geometry compilation for application regions and mapped quote offsets', () => {
    const body = 'I like jazz 😀 “at home”.';
    const prefix = 'Wrapper [human: ';
    const rawContent = `${prefix}${body}] footer`;
    const base = makeRequest(rawContent);
    const quoteStart = body.indexOf('“at home”');
    const request = readyRequest({
      ...base,
      source: {
        ...base.source,
        mapping: {
          mode: 'application_region',
          humanRegion: { start: prefix.length, end: prefix.length + body.length },
          applicationWrapper: { configurationFingerprint: 'c'.repeat(64) },
        },
        quoteRegions: [{ start: quoteStart, end: quoteStart + '“at home”'.length }],
      },
    });
    const result = compileAutonomousPersonalFreshSourceV4({
      request,
      context: makeContext(),
      sourceId: ids.source,
      previousEpisodeUuid: null,
      createdAt,
    });

    expect(result.tuple.envelope.geometry).toMatchObject({
      mode: 'application_region',
      rawContentHash: createHash('sha256').update(rawContent, 'utf8').digest('hex'),
      mappedContentHash: createHash('sha256').update(body, 'utf8').digest('hex'),
      humanRegion: { start: prefix.length, end: prefix.length + body.length },
      quoteRegions: [{ start: quoteStart, end: quoteStart + '“at home”'.length }],
    });
  });

  test('reconstructs stored execution A while B changes only processing-attempt DATA', () => {
    const request = readyRequest();
    const contextA = makeContext('execution-A');
    const contextB = makeContext('execution-B');
    const stableA = hashAutonomousPersonalStableRequestV4({ request, context: contextA });
    const stableB = hashAutonomousPersonalStableRequestV4({ request, context: contextB });
    const attemptA = hashAutonomousPersonalAttemptV4(contextA);
    const attemptB = hashAutonomousPersonalAttemptV4(contextB);
    expect(stableB).toBe(stableA);
    expect(attemptB).not.toBe(attemptA);

    const firstSource = compileAutonomousPersonalFreshSourceV4({
      request,
      context: contextA,
      sourceId: ids.source,
      previousEpisodeUuid: ids.previous,
      createdAt,
    });
    expect(firstSource.producer.source_execution_id).toBe('execution-A');
    const reconstructed = reconstructAutonomousPersonalStoredSourceIdentityV4({
      source: storedRow(firstSource),
      descriptor: firstSource.descriptor,
    });
    expect(reconstructed.tuple).toEqual(firstSource.tuple);
    expect(reconstructed.tuple.identity.producerHash).toBe(firstSource.tuple.identity.producerHash);
    expect(firstSource.producer.source_execution_id).toBe('execution-A');
    // Stage1 computes replay DATA only: never rebuild this stored source using execution B.
    expect(stableB).toMatch(/^[a-f0-9]{64}$/u);
    expect(attemptB).toMatch(/^[a-f0-9]{64}$/u);
  });

  test('fresh-source output is detached from the raw request and never gains a lifecycle result', () => {
    const rawRequest = makeRequest();
    const fresh = compileAutonomousPersonalFreshSourceV4({
      request: rawRequest,
      context: makeContext(),
      sourceId: ids.source,
      previousEpisodeUuid: ids.previous,
      createdAt,
    });
    rawRequest.source.content = 'mutated after compilation';

    expect(fresh.producer.content).toBe('I prefer practical examples 😀.');
    expectDeepFrozen(fresh);
    expect(Object.keys(fresh).sort()).toEqual(['descriptor', 'producer', 'tuple', 'version']);
    expect(fresh).not.toHaveProperty('operationId');
    expect(fresh).not.toHaveProperty('state');
    expect(fresh).not.toHaveProperty('accepted');
    expect(fresh).not.toHaveProperty('eligible');
    expect(fresh).not.toHaveProperty('handle');
  });

  test('rejects geometry that is structurally shaped but invalid for the actual UTF-16 source', () => {
    const request = makeRequest('x😀y');
    request.source.quoteRegions = [{ start: 2, end: 3 }];
    const parsed = parseAutonomousPersonalBeginV4Input({ mode: 'existingStore', request });
    expect(parsed.kind).toBe('ready');
    if (parsed.kind !== 'ready') return;

    expectFixedError(
      () =>
        compileAutonomousPersonalFreshSourceV4({
          request: parsed.request,
          context: makeContext(),
          sourceId: ids.source,
          previousEpisodeUuid: ids.previous,
          createdAt,
        }),
      'invalid_autonomous_begin_v4_source_data',
      'x😀y',
    );
  });
});
