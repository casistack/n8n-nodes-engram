import { performance } from 'node:perf_hooks';
import { applyAutomaticBindingCommand } from '../../../src/storage/AutomaticIdentity';
import type { AutomaticBindingRecord } from '../../../src/schemas/AutomaticOperations.schema';
import type { AutonomousPersonalOperationV4 } from '../../../src/schemas/AutonomousPersonalOperationV4.schema';
import type { AutonomousPersonalTypedSyntaxWorkV1 } from '../../../src/schemas/AutonomousPersonalTypedSyntaxV1.schema';
import {
  createAutonomousPersonalClaimIndexV4,
  inspectAutonomousPersonalClaimCreatorV4,
  qualifyAutonomousPersonalClaimCreatorV4,
  AutonomousPersonalClaimIndexV4Error,
} from '../../../src/extraction/AutonomousPersonalQualifiedClaimV4';
import { AutonomousPersonalTypedSyntaxFailureV1 } from '../../../src/extraction/AutonomousPersonalTypedSyntaxV1';
import * as typedSyntax from '../../../src/extraction/AutonomousPersonalTypedSyntaxV1';
import { autonomousPersonalQualifiedClaimFixtureV4 } from '../../helpers/autonomousPersonalQualifiedClaimV4';
import type { GraphData } from '../../../src/schemas';

jest.setTimeout(30_000);

function typedSyntaxWork(
  absoluteMonotonicDeadlineMs = performance.now() + 30_000,
  signal: AbortSignal = new AbortController().signal,
): AutonomousPersonalTypedSyntaxWorkV1 {
  return { absoluteMonotonicDeadlineMs, signal };
}

function inspect(graph: GraphData, edgeId: string) {
  const index = createAutonomousPersonalClaimIndexV4(graph, typedSyntaxWork(), () => undefined);
  return inspectAutonomousPersonalClaimCreatorV4(index, edgeId);
}

function qualify(graph: GraphData, request: unknown) {
  const index = createAutonomousPersonalClaimIndexV4(graph, typedSyntaxWork(), () => undefined);
  return qualifyAutonomousPersonalClaimCreatorV4(index, request);
}

function combineFixtures<T extends { graph: GraphData }>(first: T, second: T): T {
  first.graph.entities.push(...second.graph.entities);
  first.graph.edges.push(...second.graph.edges);
  first.graph.episodes.push(...second.graph.episodes);
  const firstOperations = first.graph.automatic_operations_v1?.operations;
  const secondOperations = second.graph.automatic_operations_v1?.operations;
  if (!firstOperations || !secondOperations) throw new Error('Expected fixture operations');
  firstOperations.push(...secondOperations);
  return first;
}

function caught(operation: () => unknown): unknown {
  try {
    operation();
  } catch (error) {
    return error;
  }
  throw new Error('Expected operation to throw');
}

function operation(
  graph: GraphData,
): Extract<AutonomousPersonalOperationV4, { state: 'committed' }> {
  const rows = graph.automatic_operations_v1?.operations ?? [];
  const row = rows.find((candidate) => candidate.version === 4);
  if (!row || row.version !== 4 || row.state !== 'committed')
    throw new Error('Expected one committed fixture operation');
  return row;
}

describe('AutonomousPersonalQualifiedClaimV4 creator DATA', () => {
  test('rebuilds typed creator proof and qualifies it without exposing literal data', async () => {
    const fixture = await autonomousPersonalQualifiedClaimFixtureV4();
    if (fixture.candidate.kind !== 'candidate') throw new Error('Expected built Claim3 DATA');
    const index = createAutonomousPersonalClaimIndexV4(
      fixture.graph,
      typedSyntaxWork(),
      () => undefined,
    );

    const structural = inspectAutonomousPersonalClaimCreatorV4(index, fixture.edge.uuid);
    expect(structural).toMatchObject({ status: 'structural', proof: { kind: 'typed_preference' } });
    if (structural.status !== 'structural') throw new Error('Expected structural creator proof');
    expect(structural.proof).toMatchObject({
      storeHash: fixture.request.storeHash,
      namespace: fixture.request.namespace,
      subjectId: fixture.subject.uuid,
      claimId: fixture.edge.uuid,
      valueId: fixture.value.uuid,
      sourceId: fixture.source.uuid,
      operationId: fixture.operation.operationId,
      key: fixture.candidate.claim.key,
      kind: 'typed_preference',
      unitIndex: 0,
      sourceHash: fixture.candidate.claim.sourceHash,
      descriptorHash: fixture.candidate.claim.descriptorHash,
      evidenceHash: fixture.candidate.claim.evidence.evidenceHash,
      meaningHash: fixture.candidate.reference.meaningHash,
      dependencies: fixture.candidate.reference.dependencies,
      createdAt: fixture.createdAt,
      sourceEventTime: '2026-04-01T09:00:00.000Z',
      reviewState: 'accepted',
    });
    expect(structural.proof).not.toHaveProperty('literal');
    expect(Object.isFrozen(structural)).toBe(true);
    expect(Object.isFrozen(structural.proof.dependencies)).toBe(true);

    const qualified = qualifyAutonomousPersonalClaimCreatorV4(index, fixture.request);
    expect(qualified).toEqual({ status: 'qualified', proof: structural.proof });
  });

  test('proves a dated whole statement through a protected application region', async () => {
    const fixture = await autonomousPersonalQualifiedClaimFixtureV4({
      content: 'I work as a ceramicist.',
      prefix: 'Speaker 🧭: ',
    });
    const result = inspect(fixture.graph, fixture.edge.uuid);

    expect(result).toMatchObject({
      status: 'structural',
      proof: {
        kind: 'source_statement_record',
        unitIndex: 0,
        sourceEventTime: '2026-04-01T09:00:00.000Z',
        createdAt: fixture.createdAt,
        rawSpan: { start: fixture.source.content.indexOf('I work'), end: expect.any(Number) },
        mappedSpan: { start: 0, end: 'I work as a ceramicist.'.length },
      },
    });
    const proof = result.status === 'structural' ? result.proof : undefined;
    expect(proof?.createdAt).not.toBe(proof?.sourceEventTime);
    expect(proof?.rawSpan.start).toBeGreaterThan(proof?.mappedSpan.start ?? -1);
    expect(proof!.rawSpan.end - proof!.rawSpan.start).toBe(
      proof!.mappedSpan.end - proof!.mappedSpan.start,
    );
  });

  test('recomputes qualifier, ordering, frequency, and negative typed meanings losslessly', async () => {
    const qualified = await autonomousPersonalQualifiedClaimFixtureV4({
      content:
        'For summaries, I usually prefer answers in plain Canadian French with one practical example before any technical definitions.',
    });
    if (qualified.candidate.kind !== 'candidate') throw new Error('Expected qualified Claim3 DATA');
    if (qualified.candidate.claim.kind !== 'typed_preference')
      throw new Error('Expected typed qualified preference');
    expect(qualified.candidate.claim.bundle.members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'frequency', value: 'usually' }),
        expect.objectContaining({ kind: 'action_qualifier', value: 'practical' }),
        expect.objectContaining({ kind: 'ordering', relation: 'before' }),
      ]),
    );
    const qualifiedProof = inspect(qualified.graph, qualified.edge.uuid);
    expect(qualifiedProof).toMatchObject({
      status: 'structural',
      proof: {
        meaningHash: qualified.candidate.reference.meaningHash,
        dependencies: qualified.candidate.reference.dependencies,
      },
    });

    const negative = await autonomousPersonalQualifiedClaimFixtureV4({
      content: 'I do not prefer concise explanations.',
    });
    if (negative.candidate.kind !== 'candidate') throw new Error('Expected negative Claim3 DATA');
    if (negative.candidate.claim.kind !== 'typed_preference')
      throw new Error('Expected typed negative preference');
    expect(negative.candidate.claim.bundle.members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'preference', polarity: 'negated', negation: 'do_not' }),
      ]),
    );
    expect(inspect(negative.graph, negative.edge.uuid)).toMatchObject({
      status: 'structural',
      proof: {
        meaningHash: negative.candidate.reference.meaningHash,
        dependencies: negative.candidate.reference.dependencies,
      },
    });
  });

  test('keeps the original proposed creator state after later manual rejection', async () => {
    const fixture = await autonomousPersonalQualifiedClaimFixtureV4({ profile: 'reviewFirst' });
    const edgeMetadata = fixture.edge.attributes.engram_extraction as Record<string, unknown>;
    const manuallyRejected = {
      ...edgeMetadata,
      review_status: 'rejected',
      threshold_decision: 'manually_reviewed',
      reviewed_at: fixture.terminalAt,
      reviewed_by: 'synthetic-reviewer',
    };
    fixture.edge.attributes.engram_extraction = manuallyRejected;
    fixture.value.attributes.engram_extraction = { ...manuallyRejected };

    const index = createAutonomousPersonalClaimIndexV4(
      fixture.graph,
      typedSyntaxWork(),
      () => undefined,
    );
    const structural = inspectAutonomousPersonalClaimCreatorV4(index, fixture.edge.uuid);
    expect(structural).toMatchObject({ status: 'structural', proof: { reviewState: 'rejected' } });
    const qualified = qualifyAutonomousPersonalClaimCreatorV4(index, fixture.request);
    expect(qualified).toMatchObject({ status: 'qualified', proof: { reviewState: 'rejected' } });
  });

  test('distinguishes current authority and scope changes from structural history', async () => {
    const fixture = await autonomousPersonalQualifiedClaimFixtureV4();
    const subject = fixture.subject;
    const bindings = subject.attributes.engram_actor_bindings_v1 as AutomaticBindingRecord[];
    const binding = bindings[0];
    if (!binding) throw new Error('Expected fixture binding');
    applyAutomaticBindingCommand(
      fixture.graph,
      {
        action: 'revoke',
        namespace: fixture.request.namespace,
        bindingId: binding.bindingId,
        expectedRevision: binding.revision,
        authorizedBy: 'synthetic-test',
        reason: 'exercise current authority qualification',
      },
      binding.bindingId,
      fixture.backendNow,
    );

    const index = createAutonomousPersonalClaimIndexV4(
      fixture.graph,
      typedSyntaxWork(),
      () => undefined,
    );
    expect(inspectAutonomousPersonalClaimCreatorV4(index, fixture.edge.uuid).status).toBe(
      'structural',
    );
    expect(qualifyAutonomousPersonalClaimCreatorV4(index, fixture.request)).toEqual({
      status: 'inactive',
      reason: 'authority_inactive',
    });
    expect(
      qualifyAutonomousPersonalClaimCreatorV4(index, {
        ...fixture.request,
        storeHash: '0'.repeat(64),
      }),
    ).toEqual({ status: 'inactive', reason: 'store_mismatch' });
    expect(
      qualifyAutonomousPersonalClaimCreatorV4(index, {
        ...fixture.request,
        namespace: 'workflow:other',
      }),
    ).toEqual({ status: 'inactive', reason: 'namespace_mismatch' });
  });

  test('enforces backend time boundaries for terminal, valid, invalid, and expired edges', async () => {
    const validAtNow = await autonomousPersonalQualifiedClaimFixtureV4();
    validAtNow.edge.valid_at = validAtNow.backendNow;
    expect(qualify(validAtNow.graph, validAtNow.request).status).toBe('qualified');

    const terminalAtNow = await autonomousPersonalQualifiedClaimFixtureV4();
    expect(
      qualify(terminalAtNow.graph, {
        ...terminalAtNow.request,
        backendNow: terminalAtNow.terminalAt,
      }).status,
    ).toBe('qualified');

    const invalidAtNow = await autonomousPersonalQualifiedClaimFixtureV4();
    invalidAtNow.edge.invalid_at = invalidAtNow.backendNow;
    expect(qualify(invalidAtNow.graph, invalidAtNow.request)).toEqual({
      status: 'inactive',
      reason: 'time_inactive',
    });

    const expired = await autonomousPersonalQualifiedClaimFixtureV4();
    expired.edge.expired_at = new Date(Date.parse(expired.backendNow) + 60_000).toISOString();
    expect(qualify(expired.graph, expired.request)).toEqual({
      status: 'inactive',
      reason: 'time_inactive',
    });
  });

  test('keeps source review and trust checks in current qualification only', async () => {
    const fixture = await autonomousPersonalQualifiedClaimFixtureV4();
    fixture.source.review_status = 'proposed';
    const index = createAutonomousPersonalClaimIndexV4(
      fixture.graph,
      typedSyntaxWork(),
      () => undefined,
    );

    expect(inspectAutonomousPersonalClaimCreatorV4(index, fixture.edge.uuid).status).toBe(
      'structural',
    );
    expect(qualifyAutonomousPersonalClaimCreatorV4(index, fixture.request)).toEqual({
      status: 'inactive',
      reason: 'source_inactive',
    });

    const changedTrust = await autonomousPersonalQualifiedClaimFixtureV4();
    changedTrust.source.trust_level = 'trusted';
    const trustIndex = createAutonomousPersonalClaimIndexV4(
      changedTrust.graph,
      typedSyntaxWork(),
      () => undefined,
    );
    expect(inspectAutonomousPersonalClaimCreatorV4(trustIndex, changedTrust.edge.uuid).status).toBe(
      'structural',
    );
    expect(qualifyAutonomousPersonalClaimCreatorV4(trustIndex, changedTrust.request)).toEqual({
      status: 'inactive',
      reason: 'source_inactive',
    });
  });

  test('rejects a reference-only occurrence as a creator', async () => {
    const fixture = await autonomousPersonalQualifiedClaimFixtureV4();
    const receipt = operation(fixture.graph).terminalReceipt;
    if (
      receipt.kind !== 'human_autonomous_capture_committed' ||
      receipt.selection.kind !== 'occurrences'
    )
      throw new Error('Expected occurrence receipt');
    const item = receipt.selection.items[0];
    if (!item || item.state !== 'accepted') throw new Error('Expected accepted occurrence');
    item.effect = 'reference';
    item.reason = 'existing_accepted';

    expect(inspect(fixture.graph, fixture.edge.uuid)).toEqual({
      status: 'invalid',
      reason: 'invalid_creator',
    });
  });

  test('rejects a later operation generation without invalidating the graph snapshot', async () => {
    const fixture = await autonomousPersonalQualifiedClaimFixtureV4();
    const row = operation(fixture.graph);
    row.generation = 2;

    expect(inspect(fixture.graph, fixture.edge.uuid)).toEqual({
      status: 'invalid',
      reason: 'unsupported_generation',
    });
  });

  test('owns the input snapshot and never returns graph aliases', async () => {
    const fixture = await autonomousPersonalQualifiedClaimFixtureV4();
    const index = createAutonomousPersonalClaimIndexV4(
      fixture.graph,
      typedSyntaxWork(),
      () => undefined,
    );
    fixture.edge.fact = 'mutated after index creation';

    const result = inspectAutonomousPersonalClaimCreatorV4(index, fixture.edge.uuid);
    expect(result.status).toBe('structural');
    if (result.status !== 'structural') throw new Error('Expected structural proof');
    expect(result).not.toHaveProperty('graph');
    expect(result).not.toHaveProperty('source');
    expect(result.proof).not.toHaveProperty('literal');
    expect(Object.isFrozen(result.proof)).toBe(true);
  });

  test('preserves sticky code-owned failures and uses fixed redacted scalar errors', async () => {
    const fixture = await autonomousPersonalQualifiedClaimFixtureV4();
    const stickyFailure = new Error('private cancellation detail');
    let caught: unknown;
    try {
      createAutonomousPersonalClaimIndexV4(fixture.graph, typedSyntaxWork(), () => {
        throw stickyFailure;
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(stickyFailure);

    const index = createAutonomousPersonalClaimIndexV4(
      fixture.graph,
      typedSyntaxWork(),
      () => undefined,
    );
    const touched: string[] = [];
    const proxy = new Proxy(
      {},
      {
        get() {
          touched.push('get');
          throw new Error('secret request payload');
        },
        ownKeys() {
          touched.push('ownKeys');
          throw new Error('secret request payload');
        },
      },
    );
    expect(() => qualifyAutonomousPersonalClaimCreatorV4(index, proxy)).toThrow(
      'invalid_autonomous_claim_request_data',
    );
    expect(touched).toEqual([]);

    expect(() => inspectAutonomousPersonalClaimCreatorV4({}, fixture.edge.uuid)).toThrow(
      'invalid_autonomous_claim_request_data',
    );
  });

  test('forwards one original absolute deadline and signal to typed compilation across sources', async () => {
    const first = await autonomousPersonalQualifiedClaimFixtureV4();
    const second = await autonomousPersonalQualifiedClaimFixtureV4({
      content: 'I prefer detailed examples.',
    });
    const graph = combineFixtures(first, second).graph;
    const controller = new AbortController();
    const work = typedSyntaxWork(performance.now() + 30_000, controller.signal);
    const originalCompile = typedSyntax.compileAutonomousPersonalTypedSyntaxV1;
    const forwarded: AutonomousPersonalTypedSyntaxWorkV1[] = [];
    const compileSpy = jest
      .spyOn(typedSyntax, 'compileAutonomousPersonalTypedSyntaxV1')
      .mockImplementation((input, suppliedWork) => {
        forwarded.push(suppliedWork);
        return originalCompile(input, suppliedWork);
      });
    try {
      const index = createAutonomousPersonalClaimIndexV4(graph, work, () => undefined);
      expect(inspectAutonomousPersonalClaimCreatorV4(index, first.edge.uuid).status).toBe(
        'structural',
      );
      expect(inspectAutonomousPersonalClaimCreatorV4(index, second.edge.uuid).status).toBe(
        'structural',
      );
    } finally {
      compileSpy.mockRestore();
    }

    expect(forwarded).toHaveLength(2);
    for (const forwardedWork of forwarded) {
      expect(forwardedWork.absoluteMonotonicDeadlineMs).toBe(work.absoluteMonotonicDeadlineMs);
      expect(forwardedWork.signal).toBe(controller.signal);
    }
  });

  test('latches deadline expiry injected inside typed compilation', async () => {
    const fixture = await autonomousPersonalQualifiedClaimFixtureV4();
    const enteredAt = performance.now();
    let expired = false;
    const nowSpy = jest
      .spyOn(performance, 'now')
      .mockImplementation(() => (expired ? enteredAt + 6_000 : enteredAt));
    const originalCompile = typedSyntax.compileAutonomousPersonalTypedSyntaxV1;
    const compileSpy = jest
      .spyOn(typedSyntax, 'compileAutonomousPersonalTypedSyntaxV1')
      .mockImplementation((input, work) => {
        expired = true;
        return originalCompile(input, work);
      });
    try {
      const index = createAutonomousPersonalClaimIndexV4(
        fixture.graph,
        typedSyntaxWork(enteredAt + 5_000),
        () => undefined,
      );
      const error = caught(() => inspectAutonomousPersonalClaimCreatorV4(index, fixture.edge.uuid));
      expect(error).toBeInstanceOf(AutonomousPersonalTypedSyntaxFailureV1);
      expect(error).toMatchObject({ reason: 'deadline' });
    } finally {
      compileSpy.mockRestore();
      nowSpy.mockRestore();
    }
  });

  test('uses the original abort signal inside typed compilation and never returns proof', async () => {
    const fixture = await autonomousPersonalQualifiedClaimFixtureV4();
    const controller = new AbortController();
    const work = typedSyntaxWork(performance.now() + 30_000, controller.signal);
    const originalCompile = typedSyntax.compileAutonomousPersonalTypedSyntaxV1;
    const compileSpy = jest
      .spyOn(typedSyntax, 'compileAutonomousPersonalTypedSyntaxV1')
      .mockImplementation((input, suppliedWork) => {
        expect(suppliedWork.signal).toBe(controller.signal);
        controller.abort();
        return originalCompile(input, suppliedWork);
      });
    try {
      const index = createAutonomousPersonalClaimIndexV4(fixture.graph, work, () => undefined);
      const error = caught(() => inspectAutonomousPersonalClaimCreatorV4(index, fixture.edge.uuid));
      expect(error).toBeInstanceOf(AutonomousPersonalTypedSyntaxFailureV1);
      expect(error).toMatchObject({ reason: 'cancelled' });
    } finally {
      compileSpy.mockRestore();
    }
  });

  test('rejects already expired and aborted work before observing the graph', async () => {
    const observed: string[] = [];
    const graph = new Proxy(
      {},
      {
        get() {
          observed.push('get');
          throw new Error('graph should not be read');
        },
        ownKeys() {
          observed.push('ownKeys');
          throw new Error('graph should not be read');
        },
      },
    );
    const expiredError = caught(() =>
      createAutonomousPersonalClaimIndexV4(
        graph,
        typedSyntaxWork(performance.now() - 1),
        () => undefined,
      ),
    );
    expect(expiredError).toMatchObject({ reason: 'deadline' });

    const controller = new AbortController();
    controller.abort();
    const abortedError = caught(() =>
      createAutonomousPersonalClaimIndexV4(
        graph,
        typedSyntaxWork(performance.now() + 30_000, controller.signal),
        () => undefined,
      ),
    );
    expect(abortedError).toMatchObject({ reason: 'cancelled' });
    expect(observed).toEqual([]);
  });

  test('checks original work on cached proofs and keeps callback failure identity sticky', async () => {
    const fixture = await autonomousPersonalQualifiedClaimFixtureV4();
    const controller = new AbortController();
    const work = typedSyntaxWork(performance.now() + 30_000, controller.signal);
    const index = createAutonomousPersonalClaimIndexV4(fixture.graph, work, () => undefined);
    expect(inspectAutonomousPersonalClaimCreatorV4(index, fixture.edge.uuid).status).toBe(
      'structural',
    );
    controller.abort();
    const firstWorkError = caught(() =>
      inspectAutonomousPersonalClaimCreatorV4(index, fixture.edge.uuid),
    );
    const secondWorkError = caught(() =>
      qualifyAutonomousPersonalClaimCreatorV4(index, fixture.request),
    );
    expect(firstWorkError).toBeInstanceOf(AutonomousPersonalTypedSyntaxFailureV1);
    expect(firstWorkError).toMatchObject({ reason: 'cancelled' });
    expect(secondWorkError).toBe(firstWorkError);

    const callbackFailure = new Error('fixed callback failure');
    let throwCallback = false;
    const callbackIndex = createAutonomousPersonalClaimIndexV4(
      fixture.graph,
      typedSyntaxWork(),
      () => {
        if (throwCallback) throw callbackFailure;
      },
    );
    expect(inspectAutonomousPersonalClaimCreatorV4(callbackIndex, fixture.edge.uuid).status).toBe(
      'structural',
    );
    throwCallback = true;
    const firstCallbackError = caught(() =>
      inspectAutonomousPersonalClaimCreatorV4(callbackIndex, fixture.edge.uuid),
    );
    const secondCallbackError = caught(() =>
      qualifyAutonomousPersonalClaimCreatorV4(callbackIndex, fixture.request),
    );
    expect(firstCallbackError).toBe(callbackFailure);
    expect(secondCallbackError).toBe(callbackFailure);
  });

  test('catches abort and deadline triggered by the final callback before returning proof', async () => {
    const fixture = await autonomousPersonalQualifiedClaimFixtureV4();
    const dryWork = typedSyntaxWork();
    let dryCallbackCount = 0;
    const dryIndex = createAutonomousPersonalClaimIndexV4(fixture.graph, dryWork, () => {
      dryCallbackCount += 1;
    });
    const beforeInspect = dryCallbackCount;
    expect(inspectAutonomousPersonalClaimCreatorV4(dryIndex, fixture.edge.uuid).status).toBe(
      'structural',
    );
    const inspectCallbackCount = dryCallbackCount - beforeInspect;
    expect(inspectCallbackCount).toBeGreaterThan(0);

    const abortController = new AbortController();
    let abortInspectStarted = false;
    let abortCallbackCount = 0;
    const abortIndex = createAutonomousPersonalClaimIndexV4(
      fixture.graph,
      typedSyntaxWork(performance.now() + 30_000, abortController.signal),
      () => {
        if (!abortInspectStarted) return;
        abortCallbackCount += 1;
        if (abortCallbackCount === inspectCallbackCount) abortController.abort();
      },
    );
    abortInspectStarted = true;
    const abortError = caught(() =>
      inspectAutonomousPersonalClaimCreatorV4(abortIndex, fixture.edge.uuid),
    );
    expect(abortCallbackCount).toBe(inspectCallbackCount);
    expect(abortError).toBeInstanceOf(AutonomousPersonalTypedSyntaxFailureV1);
    expect(abortError).toMatchObject({ reason: 'cancelled' });

    const enteredAt = performance.now();
    let expired = false;
    const nowSpy = jest
      .spyOn(performance, 'now')
      .mockImplementation(() => (expired ? enteredAt + 6_000 : enteredAt));
    let deadlineInspectStarted = false;
    let deadlineCallbackCount = 0;
    try {
      const deadlineIndex = createAutonomousPersonalClaimIndexV4(
        fixture.graph,
        typedSyntaxWork(enteredAt + 5_000),
        () => {
          if (!deadlineInspectStarted) return;
          deadlineCallbackCount += 1;
          if (deadlineCallbackCount === inspectCallbackCount) expired = true;
        },
      );
      deadlineInspectStarted = true;
      const deadlineError = caught(() =>
        inspectAutonomousPersonalClaimCreatorV4(deadlineIndex, fixture.edge.uuid),
      );
      expect(deadlineCallbackCount).toBe(inspectCallbackCount);
      expect(deadlineError).toBeInstanceOf(AutonomousPersonalTypedSyntaxFailureV1);
      expect(deadlineError).toMatchObject({ reason: 'deadline' });
    } finally {
      nowSpy.mockRestore();
    }
  });

  test('validates work data without invoking accessors or proxy traps', async () => {
    const fixture = await autonomousPersonalQualifiedClaimFixtureV4();
    const touched: string[] = [];
    const accessorWork = Object.defineProperty(
      { signal: new AbortController().signal },
      'absoluteMonotonicDeadlineMs',
      {
        enumerable: true,
        get() {
          touched.push('getter');
          return performance.now() + 30_000;
        },
      },
    ) as unknown as AutonomousPersonalTypedSyntaxWorkV1;
    const accessorError = caught(() =>
      createAutonomousPersonalClaimIndexV4(fixture.graph, accessorWork, () => undefined),
    );
    expect(accessorError).toMatchObject({ reason: 'internal' });

    const proxiedWork = new Proxy(typedSyntaxWork(), {
      get() {
        touched.push('get');
        throw new Error('work should not be read');
      },
      ownKeys() {
        touched.push('ownKeys');
        throw new Error('work should not be read');
      },
    });
    const proxyError = caught(() =>
      createAutonomousPersonalClaimIndexV4(fixture.graph, proxiedWork, () => undefined),
    );
    expect(proxyError).toMatchObject({ reason: 'internal' });
    expect(touched).toEqual([]);
  });

  test('maps an oversized snapshot to fixed capacity and malformed input to fixed invalid data', async () => {
    const tooLarge = {
      entities: [],
      edges: [],
      episodes: [],
      padding: 'x'.repeat(101 * 1024 * 1024),
    };
    try {
      createAutonomousPersonalClaimIndexV4(tooLarge, typedSyntaxWork(), () => undefined);
    } catch (error) {
      expect(error).toBeInstanceOf(AutonomousPersonalClaimIndexV4Error);
      expect(error).toMatchObject({ reason: 'snapshot_capacity' });
      expect((error as Error).message).not.toContain('x'.repeat(20));
      try {
        createAutonomousPersonalClaimIndexV4(
          { source: 'private text' },
          typedSyntaxWork(),
          () => undefined,
        );
      } catch (invalidError) {
        expect(invalidError).toMatchObject({ reason: 'invalid_snapshot' });
        expect((invalidError as Error).message).not.toContain('private text');
        return;
      }
      throw new Error('Expected malformed snapshot rejection');
    }
    throw new Error('Expected oversized snapshot rejection');
  });
});
