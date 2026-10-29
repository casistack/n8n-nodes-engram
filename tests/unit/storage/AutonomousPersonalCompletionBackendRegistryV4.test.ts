import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { GraphologyStorage } from '../../../src/storage/GraphologyStorage';
import {
  AutonomousPersonalCompletionBackendRegistryV4,
  consumeAutonomousPersonalCompletionBackendOutcomeV4,
  hasAutonomousPersonalCompletionBackendVerifierV4,
  registerAutonomousPersonalCompletionBackendVerifierV4,
  type TrustedAutonomousPersonalCompletionWitnessLinkV4,
} from '../../../src/storage/AutonomousPersonalCompletionBackendRegistryV4';
import {
  closeAutonomousPersonalCompletionV4,
  consumeAutonomousPersonalCompletionHandleV4,
  getAutonomousPersonalCompletionAccessV4,
  isAutonomousPersonalCompletionHandleOpenV4,
  prepareNativeAutonomousPersonalCompletionV4,
} from '../../../src/storage/AutonomousPersonalCaptureHandlesV4';
import { AutonomousPersonalCompletionPlanV4InputOwnedDataSchema } from '../../../src/schemas/AutonomousPersonalCompletionPlanV4.schema';
import { AutonomousPersonalNativeOriginV4OwnedDataSchema } from '../../../src/schemas/AutonomousPersonalNativeOriginV4.schema';
import { planAutonomousPersonalCaptureCompletionV4 } from '../../../src/storage/AutonomousPersonalCompletionPlanV4';
import { projectAutonomousPersonalNativeOriginV4 } from '../../../src/storage/AutonomousPersonalNativeOriginV4';
import {
  nativeAutonomousPersonalCaptureContext,
  seedAutonomousPersonalCaptureSubject,
} from '../../helpers/autonomousPersonalCaptureBackend';

function freezeData<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) freezeData(child);
    Object.freeze(value);
  }
  return value;
}

async function fixture() {
  const directory = fs.mkdtempSync(join(tmpdir(), 'engram-outcome-registry-'));
  const store = new GraphologyStorage(join(directory, 'store.json'));
  let handle: unknown;
  try {
    await store.initialize();
    const seed = await seedAutonomousPersonalCaptureSubject(store);
    const controller = new AbortController();
    const ctx = nativeAutonomousPersonalCaptureContext(seed, {
      extraParameters: { automaticMemoryProfile: 'explicit', automaticIntent: 'disabled' },
    });
    (ctx as unknown as { getExecutionCancelSignal: () => AbortSignal }).getExecutionCancelSignal =
      () => controller.signal;
    const prepared = await prepareNativeAutonomousPersonalCompletionV4(ctx, store);
    if (prepared.kind !== 'completion_prepared') throw new Error('Expected native preparation');
    handle = prepared.handle;
    const access = consumeAutonomousPersonalCompletionHandleV4(store, prepared.handle);
    const runtime = getAutonomousPersonalCompletionAccessV4(store, access);
    if (runtime.view.outcome.kind !== 'no_dispatch')
      throw new Error('The registry fixture must not dispatch a provider');
    const graph = await store.exportGraph();
    if (graph.group_id === undefined) delete graph.group_id;
    const input = AutonomousPersonalCompletionPlanV4InputOwnedDataSchema.parse({
      scope: runtime.view.scope,
      stagedFresh: runtime.view.stagedFresh,
      outcome: runtime.view.outcome,
      backendNow: new Date(
        Math.max(Date.now(), Date.parse(runtime.view.stagedFresh.operation.lastObservedAt)),
      ).toISOString(),
      completionCallHash: runtime.view.completionCallHash,
      audit: runtime.view.audit,
    });
    const plan = planAutonomousPersonalCaptureCompletionV4(
      input,
      graph,
      null,
      null,
      runtime.typedSyntaxWork,
      runtime.check,
      runtime.legacyReadBudget,
    );
    if (plan.kind !== 'planned') throw new Error('Expected a strict source-only plan');
    const origin = projectAutonomousPersonalNativeOriginV4(input, plan, runtime.check);
    // These unit tests substitute a backend-local witness reader. They do not
    // assert that the synthetic planned terminal was actually committed.
    const witnesses = new WeakMap<object, TrustedAutonomousPersonalCompletionWitnessLinkV4>();
    const reader = jest.fn((key: unknown) => {
      if (key === null || typeof key !== 'object') return null;
      const link = witnesses.get(key);
      witnesses.delete(key);
      return link ?? null;
    });
    const registry = new AutonomousPersonalCompletionBackendRegistryV4(store, reader);
    const witness = (nativeOrigin = origin) => {
      const key = Object.freeze({});
      witnesses.set(key, {
        originalHandle: prepared.handle,
        completionAccess: access,
        nativeOrigin,
      });
      return key;
    };
    return {
      store,
      handle: prepared.handle,
      access,
      origin,
      controller,
      runtime,
      reader,
      registry,
      witness,
      close: async () => {
        closeAutonomousPersonalCompletionV4(store, prepared.handle);
        await store.close();
        fs.rmSync(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    if (handle) closeAutonomousPersonalCompletionV4(store, handle);
    await store.close();
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

let current: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  current = await fixture();
});
afterEach(async () => {
  jest.restoreAllMocks();
  await current?.close();
});

it('consumes an empty identity token once and retains the same frozen origin reference', () => {
  const token = current.registry.registerCoreOutcome(
    current.handle,
    { kind: 'matched' },
    current.witness(),
  );
  expect(Object.isFrozen(token)).toBe(true);
  expect(Reflect.ownKeys(token)).toEqual([]);
  const result = current.registry.consume(current.handle, token);
  expect(result?.observation).toEqual({ kind: 'matched' });
  expect(result?.proof?.nativeOrigin).toBe(current.origin);
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result?.proof)).toBe(true);
  expect(current.registry.consume(current.handle, token)).toBeNull();
});

it('requires backend consumption before registering a diagnostic outcome', async () => {
  const seed = await seedAutonomousPersonalCaptureSubject(current.store);
  const prepared = await prepareNativeAutonomousPersonalCompletionV4(
    nativeAutonomousPersonalCaptureContext(seed, {
      extraParameters: { automaticMemoryProfile: 'explicit', automaticIntent: 'disabled' },
    }),
    current.store,
  );
  if (prepared.kind !== 'completion_prepared') throw new Error('Expected an issued handle');
  try {
    expect(isAutonomousPersonalCompletionHandleOpenV4(current.store, prepared.handle)).toBe(false);
    expect(() =>
      current.registry.registerCoreOutcome(
        prepared.handle,
        { kind: 'no_write', reason: 'capacity' },
        null,
      ),
    ).toThrow('Engram native completion registry: invalid_value');
    consumeAutonomousPersonalCompletionHandleV4(current.store, prepared.handle);
    expect(isAutonomousPersonalCompletionHandleOpenV4(current.store, prepared.handle)).toBe(true);
    const token = current.registry.registerCoreOutcome(
      prepared.handle,
      { kind: 'no_write', reason: 'capacity' },
      null,
    );
    expect(current.registry.consume(prepared.handle, token)).toEqual({
      observation: { kind: 'no_write', reason: 'capacity' },
      proof: null,
    });
  } finally {
    closeAutonomousPersonalCompletionV4(current.store, prepared.handle);
  }
});

it('does not turn matched DATA or an unrecognized/replayed witness into proof', () => {
  for (const witness of [null, {}, { acknowledged: true, nativeOrigin: current.origin }]) {
    const token = current.registry.registerCoreOutcome(
      current.handle,
      { kind: 'matched' },
      witness,
    );
    expect(current.registry.consume(current.handle, token)).toEqual({
      observation: { kind: 'matched' },
      proof: null,
    });
  }
  const witness = current.witness();
  const first = current.registry.registerCoreOutcome(current.handle, { kind: 'matched' }, witness);
  const second = current.registry.registerCoreOutcome(current.handle, { kind: 'matched' }, witness);
  expect(current.registry.consume(current.handle, first)?.proof).not.toBeNull();
  expect(current.registry.consume(current.handle, second)?.proof).toBeNull();
});

it.each([{ kind: 'unconfirmed' }, { kind: 'no_write', reason: 'capacity' }] as const)(
  'never attaches proof to $kind even with a recognized witness',
  (observation) => {
    const token = current.registry.registerCoreOutcome(
      current.handle,
      observation,
      current.witness(),
    );
    expect(current.registry.consume(current.handle, token)).toEqual({ observation, proof: null });
    expect(current.reader).toHaveBeenCalledTimes(1);
  },
);

it('rejects copied, proxied, JSON, foreign-handle and foreign-registry tokens without traps', () => {
  const token = current.registry.registerCoreOutcome(
    current.handle,
    { kind: 'matched' },
    current.witness(),
  );
  const trap = jest.fn(() => {
    throw new Error('Synthetic private trap');
  });
  const proxy = new Proxy(token, { get: trap, ownKeys: trap, getPrototypeOf: trap });
  for (const copied of [{ ...token }, proxy, JSON.parse(JSON.stringify(token))])
    expect(current.registry.consume(current.handle, copied)).toBeNull();
  expect(current.registry.consume({}, token)).toBeNull();
  expect(
    new AutonomousPersonalCompletionBackendRegistryV4({}, () => null).consume(
      current.handle,
      token,
    ),
  ).toBeNull();
  expect(trap).not.toHaveBeenCalled();
  expect(current.registry.consume(current.handle, token)?.proof?.nativeOrigin).toBe(current.origin);
});

it.each(['execution', 'receipt_source', 'receipt_operation'] as const)(
  'does not attach a schema-valid origin with a mismatched %s',
  (field) => {
    const origin = structuredClone(current.origin);
    if (field === 'execution') origin.execution = 'synthetic:another-execution';
    else if (field === 'receipt_source')
      origin.terminalReceipt.sourceId = '0a489df5-df1a-41c0-b348-85d44f34a8d1';
    else origin.terminalReceipt.operationId = '9fdfc7aa-d7d6-4d2d-b491-8eaa22f3ef3c';
    expect(AutonomousPersonalNativeOriginV4OwnedDataSchema.safeParse(origin).success).toBe(true);
    const token = current.registry.registerCoreOutcome(
      current.handle,
      { kind: 'matched' },
      current.witness(freezeData(origin)),
    );
    expect(current.registry.consume(current.handle, token)?.proof).toBeNull();
  },
);

it.each(['before_registration', 'before_consumption'] as const)(
  'does not revive proof after abort %s and keeps the observation',
  (when) => {
    if (when === 'before_registration') current.controller.abort();
    const token = current.registry.registerCoreOutcome(
      current.handle,
      { kind: 'matched' },
      current.witness(),
    );
    if (when === 'before_consumption') current.controller.abort();
    expect(isAutonomousPersonalCompletionHandleOpenV4(current.store, current.handle)).toBe(true);
    expect(current.registry.consume(current.handle, token)).toEqual({
      observation: { kind: 'matched' },
      proof: null,
    });
    expect(current.registry.consume(current.handle, token)).toBeNull();
  },
);

it.each(['abort', 'deadline'] as const)(
  'retains known no-write diagnostics after %s',
  (failure) => {
    const token = current.registry.registerCoreOutcome(
      current.handle,
      { kind: 'no_write', reason: 'capacity' },
      null,
    );
    if (failure === 'abort') current.controller.abort();
    else
      jest
        .spyOn(performance, 'now')
        .mockReturnValue(current.runtime.typedSyntaxWork.absoluteMonotonicDeadlineMs + 1);
    expect(isAutonomousPersonalCompletionHandleOpenV4(current.store, current.handle)).toBe(true);
    expect(current.registry.consume(current.handle, token)).toEqual({
      observation: { kind: 'no_write', reason: 'capacity' },
      proof: null,
    });
  },
);

it('strips an already registered proof after the original deadline expires', () => {
  const token = current.registry.registerCoreOutcome(
    current.handle,
    { kind: 'matched' },
    current.witness(),
  );
  jest
    .spyOn(performance, 'now')
    .mockReturnValue(current.runtime.typedSyntaxWork.absoluteMonotonicDeadlineMs + 1);
  expect(current.registry.consume(current.handle, token)).toEqual({
    observation: { kind: 'matched' },
    proof: null,
  });
  expect(current.registry.consume(current.handle, token)).toBeNull();
});

it('does not borrow a different live completion access from the same owner', async () => {
  const seed = await seedAutonomousPersonalCaptureSubject(current.store);
  const prepared = await prepareNativeAutonomousPersonalCompletionV4(
    nativeAutonomousPersonalCaptureContext(seed, {
      extraParameters: { automaticMemoryProfile: 'explicit', automaticIntent: 'disabled' },
    }),
    current.store,
  );
  if (prepared.kind !== 'completion_prepared') throw new Error('Expected another real handle');
  try {
    const otherAccess = consumeAutonomousPersonalCompletionHandleV4(current.store, prepared.handle);
    const registry = new AutonomousPersonalCompletionBackendRegistryV4(current.store, () => ({
      originalHandle: current.handle,
      completionAccess: otherAccess,
      nativeOrigin: current.origin,
    }));
    const token = registry.registerCoreOutcome(current.handle, { kind: 'matched' }, {});
    expect(registry.consume(current.handle, token)?.proof).toBeNull();
  } finally {
    closeAutonomousPersonalCompletionV4(current.store, prepared.handle);
  }
});

it('rejects every outstanding token after owner-checked completion close', () => {
  const token = current.registry.registerCoreOutcome(
    current.handle,
    { kind: 'matched' },
    current.witness(),
  );
  closeAutonomousPersonalCompletionV4(current.store, current.handle);
  expect(current.registry.consume(current.handle, token)).toBeNull();
});

it('refuses malformed permission-shaped observations without reading hostile properties', () => {
  const trap = jest.fn(() => {
    throw new Error('Synthetic observation getter');
  });
  const observation = Object.defineProperty({}, 'kind', { enumerable: true, get: trap });
  expect(() =>
    current.registry.registerCoreOutcome(current.handle, observation as never, null),
  ).toThrow('Engram native completion registry: invalid_value');
  expect(() =>
    current.registry.registerCoreOutcome(
      current.handle,
      { kind: 'matched', eligibleFirstCommit: true } as never,
      current.witness(),
    ),
  ).toThrow('Engram native completion registry: invalid_value');
  expect(trap).not.toHaveBeenCalled();
  expect(current.reader).not.toHaveBeenCalled();
});

it('registers a read-only owner verifier once without replacement or token inspection', () => {
  const owner = {};
  const verifier = jest.fn(() => null);
  const replacement = jest.fn(() => null);
  expect(hasAutonomousPersonalCompletionBackendVerifierV4(owner)).toBe(false);
  registerAutonomousPersonalCompletionBackendVerifierV4(owner, verifier);
  expect(hasAutonomousPersonalCompletionBackendVerifierV4(owner)).toBe(true);
  expect(() => registerAutonomousPersonalCompletionBackendVerifierV4(owner, replacement)).toThrow();
  const handle = {};
  const token = {};
  expect(consumeAutonomousPersonalCompletionBackendOutcomeV4(owner, handle, token)).toBeNull();
  expect(verifier).toHaveBeenCalledWith(handle, token);
  expect(replacement).not.toHaveBeenCalled();
  expect(consumeAutonomousPersonalCompletionBackendOutcomeV4({}, handle, token)).toBeNull();
});
