import { createHash } from 'crypto';
import { z } from 'zod';
import {
  compileAutonomousPersonalDescriptorV4,
  type AutonomousPersonalDescriptorV4Input,
} from '../../../src/schemas/AutonomousPersonalDescriptorV4.schema';
import {
  parseAutonomousPersonalBeginV4Input,
  type AutonomousPersonalBeginV4Request,
} from '../../../src/schemas/AutonomousPersonalBeginV4.schema';
import { hashAutomaticCaptureV2 } from '../../../src/schemas/AutomaticCapture.schema';
import {
  reconstructAutonomousPersonalStoredSourceIdentityV4,
  AUTONOMOUS_CAPTURE_V3_ENVELOPE_ATTRIBUTE,
  AUTONOMOUS_CAPTURE_V4_OWNER_ATTRIBUTE,
} from '../../../src/schemas/AutonomousPersonalSourceV4.schema';
import {
  compileAutonomousPersonalFreshSourceV4,
  hashAutonomousPersonalAttemptV4,
  hashAutonomousPersonalStableRequestV4,
} from '../../../src/storage/AutonomousPersonalCaptureBeginV4';
import { automaticWriteOwnerIdempotencyKey } from '../../../src/storage/AutomaticIdentity';

const ids = {
  sourceA: '10000000-0000-4000-8000-000000000001',
  sourceB: '10000000-0000-4000-8000-000000000002',
  previous: '10000000-0000-4000-8000-000000000003',
  binding: '10000000-0000-4000-8000-000000000004',
  subject: '10000000-0000-4000-8000-000000000005',
};

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

const makeContext = (execution = 'execution-a') => ({
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
});

const makeRequest = (): AutonomousPersonalBeginV4Request => ({
  version: 4,
  lifecycle: 'replaySafeV2',
  purpose: 'human_turn_memory',
  interpretationFamily: 'autonomous-personal-v1',
  namespace: 'workflow:one',
  issuer: 'n8n',
  actorReference: 'user:42',
  turn: 'turn:7',
  settings: descriptorInput(),
  source: {
    content: '  I prefer practical examples 😀. \n',
    sourceMessageId: 'message-1',
    conversationId: 'conversation-1',
    senderId: 'sender-1',
    sourceWorkflowId: 'workflow-1',
    quotedMessageId: null,
    sourceType: 'message',
    eventTime: { mode: 'explicit', value: '2026-02-01T12:34:56.789Z' },
    mapping: { mode: 'full_body' },
    quoteRegions: [],
  },
});

const makeWrapper = () => ({ mode: 'existingStore', request: makeRequest() });

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function expectDeepFrozen(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) expectDeepFrozen(child);
}

function expectFixedFrozenError(action: () => unknown, message: string): void {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(z.ZodError);
  const error = caught as z.ZodError;
  expect(error.issues).toHaveLength(1);
  expect(error.issues[0].message).toBe(message);
  expect(error.issues[0].path).toEqual([]);
  expect(Object.isFrozen(error)).toBe(true);
  expect(Object.isFrozen(error.issues)).toBe(true);
  expect(Object.isFrozen(error.issues[0])).toBe(true);
  expect(Object.isFrozen(error.issues[0].path)).toBe(true);
}

function sourceBuildInput(
  request = makeRequest(),
  context = makeContext(),
  sourceId = ids.sourceA,
  createdAt = '2026-02-01T13:34:56.789Z',
) {
  return {
    request,
    context,
    sourceId,
    previousEpisodeUuid: ids.previous,
    createdAt,
  };
}

function asStoredSource(fresh: ReturnType<typeof compileAutonomousPersonalFreshSourceV4>) {
  return {
    ...fresh.producer,
    sender_name: null,
    trust_level: fresh.descriptor.requestedTrustLevel,
    confidence: null,
    review_status: 'accepted',
    updated_at: null,
    attributes: {
      [AUTONOMOUS_CAPTURE_V4_OWNER_ATTRIBUTE]: fresh.tuple.owner,
      [AUTONOMOUS_CAPTURE_V3_ENVELOPE_ATTRIBUTE]: fresh.tuple.envelope,
    },
  };
}

describe('Autonomous Begin4 Stage1 compiles bounded DATA only', () => {
  test('owns and freezes a detached strict request before returning ready', () => {
    const callerInput = makeWrapper();
    const result = parseAutonomousPersonalBeginV4Input(callerInput);
    expect(result.kind).toBe('ready');
    if (result.kind !== 'ready') throw new Error('expected ready input');
    expect(result.mode).toBe('existingStore');
    expectDeepFrozen(result);

    callerInput.request.source.content = 'changed after parse';
    callerInput.request.settings.providerReference.routeId = 'changed route';
    expect(result.request.source.content).toBe('  I prefer practical examples 😀. \n');
    expect(result.request.settings.providerReference.routeId).toBe('synthetic-route');
  });

  test('returns unsupported_mode only after owning a valid outer wrapper', () => {
    const wrongMode = { mode: 'newStore', request: makeRequest() };
    expect(parseAutonomousPersonalBeginV4Input(wrongMode)).toEqual({ kind: 'unsupported_mode' });

    const invalidRequest = makeRequest() as ReturnType<typeof makeRequest> & { extra?: boolean };
    invalidRequest.extra = true;
    expect(
      parseAutonomousPersonalBeginV4Input({ mode: 'newStore', request: invalidRequest }),
    ).toEqual({ kind: 'unsupported_mode' });
    expect(parseAutonomousPersonalBeginV4Input({ mode: 4, request: makeRequest() })).toEqual({
      kind: 'invalid_input',
    });
    expect(
      parseAutonomousPersonalBeginV4Input({
        mode: 'existingStore',
        request: makeRequest(),
        extra: 1,
      }),
    ).toEqual({ kind: 'invalid_input' });
  });

  test('rejects accessors, proxies, cycles, own reserved keys, and oversized raw wrappers without leaking errors', () => {
    let getterCalls = 0;
    const accessorInput = makeWrapper();
    Object.defineProperty(accessorInput, 'mode', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 'existingStore';
      },
    });
    expect(parseAutonomousPersonalBeginV4Input(accessorInput)).toEqual({ kind: 'invalid_input' });
    expect(getterCalls).toBe(0);

    let proxyTrapCalls = 0;
    const proxied = new Proxy(
      {},
      {
        get() {
          proxyTrapCalls += 1;
          return undefined;
        },
        getPrototypeOf() {
          proxyTrapCalls += 1;
          return Object.prototype;
        },
        ownKeys() {
          proxyTrapCalls += 1;
          return [];
        },
        getOwnPropertyDescriptor() {
          proxyTrapCalls += 1;
          return undefined;
        },
      },
    );
    expect(parseAutonomousPersonalBeginV4Input(proxied)).toEqual({ kind: 'invalid_input' });
    expect(proxyTrapCalls).toBe(0);

    const cyclic = makeWrapper() as ReturnType<typeof makeWrapper> & { self?: unknown };
    cyclic.mode = 'newStore';
    cyclic.self = cyclic;
    expect(parseAutonomousPersonalBeginV4Input(cyclic)).toEqual({ kind: 'invalid_input' });

    const ownProto = makeWrapper();
    Object.defineProperty(ownProto, '__proto__', {
      enumerable: true,
      configurable: true,
      value: { polluted: true },
    });
    expect(parseAutonomousPersonalBeginV4Input(ownProto)).toEqual({ kind: 'invalid_input' });
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();

    const tooLarge = { mode: 'existingStore', request: makeRequest() };
    tooLarge.request.source.content = '\u0001'.repeat(90_000);
    expect(parseAutonomousPersonalBeginV4Input(tooLarge)).toEqual({ kind: 'invalid_input' });
  });

  test('preserves max escaped source bytes and rejects invalid Unicode or excess UTF-8 bytes', () => {
    const maxEscaped = makeWrapper();
    maxEscaped.request.source.content = '\u0001'.repeat(65_536);
    expect(parseAutonomousPersonalBeginV4Input(maxEscaped).kind).toBe('ready');
    const maxEscapedFresh = compileAutonomousPersonalFreshSourceV4(
      sourceBuildInput(maxEscaped.request),
    );
    expect(Buffer.byteLength(JSON.stringify(maxEscapedFresh), 'utf8')).toBeLessThanOrEqual(
      512 * 1024,
    );

    const excessUtf8 = makeWrapper();
    excessUtf8.request.source.content = 'é'.repeat(32_769);
    expect(parseAutonomousPersonalBeginV4Input(excessUtf8)).toEqual({ kind: 'invalid_input' });

    const malformedUnicode = makeWrapper();
    malformedUnicode.request.source.content = '\ud800';
    expect(parseAutonomousPersonalBeginV4Input(malformedUnicode)).toEqual({
      kind: 'invalid_input',
    });
  });

  test('hashes exact stable event preimage and separates attempt identity', () => {
    const request = makeRequest();
    const contextA = makeContext('execution-a');
    const contextB = makeContext('execution-b');
    const stableA = hashAutonomousPersonalStableRequestV4({ request, context: contextA });
    const stableB = hashAutonomousPersonalStableRequestV4({ request, context: contextB });
    const attemptA = hashAutonomousPersonalAttemptV4(contextA);
    const attemptB = hashAutonomousPersonalAttemptV4(contextB);
    const descriptor = compileAutonomousPersonalDescriptorV4(request.settings);
    const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
    const expectedStable = hashAutomaticCaptureV2({
      domain: 'engram-autonomous-begin-event-v1',
      event: {
        lifecycle: request.lifecycle,
        purpose: request.purpose,
        interpretationFamily: request.interpretationFamily,
        storeHash: contextA.storeHash,
        namespace: contextA.namespace,
        issuer: contextA.issuer,
        actorReference: contextA.actorReference,
        turn: contextA.turn,
        originMode: 'processing_first_capture',
        source: {
          contentHash: sha256(request.source.content),
          sourceMessageId: request.source.sourceMessageId,
          conversationId: request.source.conversationId,
          senderId: request.source.senderId,
          sourceWorkflowId: request.source.sourceWorkflowId,
          sourceType: 'message',
          episodeKind: 'active_human',
          quotedMessageId: request.source.quotedMessageId,
          eventTime: request.source.eventTime,
          mapping: request.source.mapping,
          quoteRegions: request.source.quoteRegions,
        },
        descriptorHash: hashAutomaticCaptureV2({
          domain: 'engram-autonomous-descriptor-v1',
          descriptor,
        }),
        binding: contextA.binding,
      },
    });
    const expectedAttemptA = hashAutomaticCaptureV2({
      domain: 'engram-native-human-processing-v4',
      instance: contextA.instance,
      workflow: contextA.workflow,
      execution: contextA.execution,
      namespace: contextA.namespace,
      issuer: contextA.issuer,
      actorReference: contextA.actorReference,
      turn: contextA.turn,
    });

    expect(stableA).toBe(expectedStable);
    expect(stableB).toBe(stableA);
    expect(attemptA).toBe(expectedAttemptA);
    expect(attemptB).not.toBe(attemptA);

    const changedStableRequest = clone(request);
    changedStableRequest.source.content = 'I prefer compact examples.';
    expect(
      hashAutonomousPersonalStableRequestV4({ request: changedStableRequest, context: contextA }),
    ).not.toBe(stableA);
    const changedBinding = clone(contextA);
    changedBinding.binding.revision += 1;
    expect(() =>
      hashAutonomousPersonalStableRequestV4({ request, context: changedBinding }),
    ).not.toThrow();
    expect(hashAutonomousPersonalStableRequestV4({ request, context: changedBinding })).not.toBe(
      stableA,
    );
    const changedDescriptorRequest = clone(request);
    changedDescriptorRequest.settings.providerReference.routeId = 'other-route';
    expect(
      hashAutonomousPersonalStableRequestV4({
        request: changedDescriptorRequest,
        context: contextA,
      }),
    ).not.toBe(stableA);
  });

  test('hashes plain context DATA without claiming it is native or authoritative', () => {
    const forgedButWellFormedContext = makeContext('caller-chosen-execution');
    expect(() => hashAutonomousPersonalAttemptV4(forgedButWellFormedContext)).not.toThrow();
    expect(hashAutonomousPersonalAttemptV4(forgedButWellFormedContext)).toMatch(/^[a-f0-9]{64}$/u);

    const badScope = makeContext();
    badScope.namespace = 'different-namespace';
    expectFixedFrozenError(
      () => hashAutonomousPersonalStableRequestV4({ request: makeRequest(), context: badScope }),
      'invalid_autonomous_begin_v4_hash_data',
    );
    const extra = { ...makeContext(), unrecognized: true };
    expectFixedFrozenError(
      () => hashAutonomousPersonalAttemptV4(extra),
      'invalid_autonomous_begin_v4_hash_data',
    );
  });

  test('builds exact first-capture and explicit producer DATA through Source4 without mapped text output', () => {
    const firstCaptureRequest = makeRequest();
    firstCaptureRequest.source.eventTime = { mode: 'first_capture' };
    const firstCapture = compileAutonomousPersonalFreshSourceV4(
      sourceBuildInput(firstCaptureRequest),
    );
    expect(firstCapture.producer.reference_time).toBe(firstCapture.producer.created_at);
    expect(firstCapture.producer.source_execution_id).toBe('execution-a');
    expect(firstCapture.producer.idempotency_key).toBe(
      automaticWriteOwnerIdempotencyKey({ turn: 'turn:7', role: 'human' }),
    );
    expect(firstCapture.producer.content).toBe(firstCaptureRequest.source.content);
    expect('mappedHumanBody' in firstCapture).toBe(false);
    expectDeepFrozen(firstCapture);

    const mappedRequest = makeRequest();
    const raw = '[wrapper]I like jazz.[/wrapper]';
    const humanText = 'I like jazz.';
    const start = raw.indexOf(humanText);
    mappedRequest.source.content = raw;
    mappedRequest.source.mapping = {
      mode: 'application_region',
      humanRegion: { start, end: start + humanText.length },
      applicationWrapper: { configurationFingerprint: 'f'.repeat(64) },
    };
    mappedRequest.source.quoteRegions = [{ start: 2, end: 6 }];
    const explicit = compileAutonomousPersonalFreshSourceV4(
      sourceBuildInput(mappedRequest, makeContext(), ids.sourceB),
    );
    expect(explicit.producer.reference_time).toBe('2026-02-01T12:34:56.789Z');
    expect(explicit.producer.created_at).toBe('2026-02-01T13:34:56.789Z');
    expect(explicit.tuple.envelope.geometry.mode).toBe('application_region');
    expect(explicit.tuple.envelope.geometry.rawUtf16Length).toBe(raw.length);
    expect(explicit.tuple.envelope.geometry.mappedUtf16Length).toBe(humanText.length);
    expect(explicit.tuple.envelope.geometry.quoteRegions).toEqual([{ start: 2, end: 6 }]);
    expect(explicit.producer.content).toBe(raw);
    expect('mappedHumanBody' in explicit).toBe(false);
    expectDeepFrozen(explicit);
  });

  test('preserves explicit null metadata and rejects missing required nullable fields', () => {
    const nullable = makeRequest();
    nullable.source.sourceMessageId = null;
    expect(
      parseAutonomousPersonalBeginV4Input({ mode: 'existingStore', request: nullable }).kind,
    ).toBe('ready');

    const missing = makeRequest();
    delete (missing.source as Partial<AutonomousPersonalBeginV4Request['source']>).sourceMessageId;
    expect(
      parseAutonomousPersonalBeginV4Input({ mode: 'existingStore', request: missing }),
    ).toEqual({
      kind: 'invalid_input',
    });
  });

  test('stored-source reconstruction checks the original A producer while B remains a separate attempt', () => {
    const request = makeRequest();
    const contextA = makeContext('execution-a');
    const freshA = compileAutonomousPersonalFreshSourceV4(
      sourceBuildInput(request, contextA, ids.sourceA),
    );
    const storedA = asStoredSource(freshA);
    const contextB = makeContext('execution-b');
    const stableB = hashAutonomousPersonalStableRequestV4({ request, context: contextB });
    const attemptB = hashAutonomousPersonalAttemptV4(contextB);
    const reconstructedA = reconstructAutonomousPersonalStoredSourceIdentityV4({
      source: storedA,
      descriptor: freshA.descriptor,
    });

    expect(stableB).toBe(hashAutonomousPersonalStableRequestV4({ request, context: contextA }));
    expect(attemptB).not.toBe(hashAutonomousPersonalAttemptV4(contextA));
    expect(reconstructedA.source.source_execution_id).toBe('execution-a');
    expect(reconstructedA.tuple).toEqual(freshA.tuple);
    expect(storedA.uuid).toBe(ids.sourceA);
    expect(storedA.idempotency_key).toBe(
      automaticWriteOwnerIdempotencyKey({ turn: 'turn:7', role: 'human' }),
    );
    // The replay fixture deliberately reconstructs stored A; it does not fresh-build source B.
    expect(reconstructedA.source.source_execution_id).not.toBe(contextB.execution);
  });

  test('rejects malformed source, time, scope, and output-over-cap data with one fixed source error', () => {
    const invalidTime = makeRequest();
    invalidTime.source.eventTime = { mode: 'explicit', value: '2026-02-01T12:34:56+00:00' };
    expectFixedFrozenError(
      () => compileAutonomousPersonalFreshSourceV4(sourceBuildInput(invalidTime)),
      'invalid_autonomous_begin_v4_source_data',
    );

    const mismatchedScope = makeContext();
    mismatchedScope.turn = 'different-turn';
    expectFixedFrozenError(
      () =>
        compileAutonomousPersonalFreshSourceV4(sourceBuildInput(makeRequest(), mismatchedScope)),
      'invalid_autonomous_begin_v4_source_data',
    );

    const badQuoteRegion = makeRequest();
    badQuoteRegion.source.quoteRegions = [{ start: 0, end: 65_536 }];
    expectFixedFrozenError(
      () => compileAutonomousPersonalFreshSourceV4(sourceBuildInput(badQuoteRegion)),
      'invalid_autonomous_begin_v4_source_data',
    );

    const excessSource = makeRequest();
    excessSource.source.content = '\u0001'.repeat(65_537);
    expectFixedFrozenError(
      () => compileAutonomousPersonalFreshSourceV4(sourceBuildInput(excessSource)),
      'invalid_autonomous_begin_v4_source_data',
    );
  });
});
