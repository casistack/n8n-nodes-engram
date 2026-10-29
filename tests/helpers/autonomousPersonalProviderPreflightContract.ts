import type { IGraphStorage } from '../../src/storage/IGraphStorage';
import {
  dispatchNativeAutonomousPersonalCaptureV4,
  prepareNativeAutonomousPersonalCaptureProviderV4,
  isLiveAutonomousPersonalCaptureLeaseHandleV4,
} from '../../src/storage/AutonomousPersonalCaptureHandlesV4';
import {
  type AutonomousPersonalCaptureProviderPreflightV4,
  AutonomousPersonalCaptureProviderPreflightV4Schema,
  AutonomousPersonalCaptureProviderCancelledV4OwnedDataSchema,
} from '../../src/schemas/AutonomousPersonalCaptureProviderV4.schema';
import {
  nativeAutonomousPersonalCaptureContext,
  seedAutonomousPersonalCaptureSubject,
  type AutonomousPersonalCaptureSeed,
} from './autonomousPersonalCaptureBackend';

export interface ProviderPreflightBackendFixture {
  store: IGraphStorage;
  seed: AutonomousPersonalCaptureSeed;
  nativeState(): Promise<unknown>;
  readCount(): number;
  anotherOwner(): Promise<IGraphStorage>;
  close(): Promise<void>;
}

/** Observable preflight contract shared by embedded storage and a real Neo4j database. */
export function providerPreflightBackendContract(
  name: string,
  create: () => Promise<ProviderPreflightBackendFixture>,
): void {
  describe(name, () => {
    let fixture: ProviderPreflightBackendFixture;
    let fetchSpy: jest.SpyInstance;
    let pending: Array<{ release(): void; done: Promise<unknown> }>;

    beforeEach(async () => {
      fetchSpy = jest
        .spyOn(globalThis, 'fetch')
        .mockRejectedValue(new Error('Unexpected provider I/O'));
      pending = [];
      fixture = await create();
    });
    afterEach(async () => {
      for (const invocation of pending ?? []) invocation.release();
      for (const invocation of pending ?? []) await invocation.done;
      const calls = fetchSpy.mock.calls.length;
      jest.restoreAllMocks();
      await fixture?.close();
      expect(calls).toBe(0);
    });

    async function begin(
      executionId = 'attempt:original',
      extraParameters?: Record<string, unknown>,
    ) {
      const internal = fixture.store as IGraphStorage &
        Required<
          Pick<
            IGraphStorage,
            | 'beginAndClaimAutonomousPersonalCaptureV4'
            | 'prepareAutonomousPersonalCaptureProviderV4'
          >
        >;
      const originalBegin = internal.beginAndClaimAutonomousPersonalCaptureV4;
      let initial: Awaited<ReturnType<typeof originalBegin>> | undefined;
      let captured!: (handle: unknown) => void;
      const handlePromise = new Promise<unknown>((resolve) => {
        captured = resolve;
      });
      let release!: () => void;
      const gate = new Promise<AutonomousPersonalCaptureProviderPreflightV4>((resolve) => {
        release = () => resolve({ kind: 'invalid_handle', eligibleFirstCommit: false });
      });
      const beginSpy = jest
        .spyOn(internal, 'beginAndClaimAutonomousPersonalCaptureV4')
        .mockImplementation(async (input, attempt) => {
          const result = await originalBegin.call(internal, input, attempt);
          initial = result;
          return result;
        });
      const preflightSpy = jest
        .spyOn(internal, 'prepareAutonomousPersonalCaptureProviderV4')
        .mockImplementation((handle) => {
          captured(handle);
          return gate;
        });
      const done = prepareNativeAutonomousPersonalCaptureProviderV4(
        nativeAutonomousPersonalCaptureContext(fixture.seed, { executionId, extraParameters }),
        fixture.store,
      );
      pending.push({ release, done });
      try {
        const handle = await Promise.race([
          handlePromise,
          done.then((result) => {
            throw new Error(`Native preparation stopped before preflight: ${result.kind}`);
          }),
        ]);
        if (!initial || initial.kind !== 'claimed')
          throw new Error('Expected initial native lease');
        expect(initial.handle).toBe(handle);
        return initial;
      } finally {
        beginSpy.mockRestore();
        preflightSpy.mockRestore();
      }
    }
    function prepare(store: IGraphStorage, handle: unknown) {
      if (!store.prepareAutonomousPersonalCaptureProviderV4)
        throw new Error('Missing provider preflight capability');
      return store.prepareAutonomousPersonalCaptureProviderV4(handle);
    }

    test('verifies one actual row without changing records, chains, operations or native metadata', async () => {
      const original = await begin();
      const before = await fixture.nativeState();
      const result = await prepare(fixture.store, original.handle);
      expect(result.kind).toBe('ready');
      if (result.kind !== 'ready') throw new Error('Expected verified source projection');
      expect(result.source.uuid).toBe(original.sourceId);
      expect(result.source.source_execution_id).toBe('attempt:original');
      expect(result.refs.operationId).toBe(original.operationId);
      expect(result.refs.sourceId).toBe(original.sourceId);
      expect(result.refs.leaseRenewedAt).toBe(result.source.created_at);
      expect(result).not.toHaveProperty('eligibleFirstCommit');
      expect(result).not.toHaveProperty('should_process');
      expect(result).not.toHaveProperty('stage');
      expect(result).not.toHaveProperty('receipt');
      expect(result).not.toHaveProperty('graph');
      expect(isLiveAutonomousPersonalCaptureLeaseHandleV4(original.handle)).toBe(false);
      expect(await fixture.nativeState()).toEqual(before);
      expect(JSON.stringify(result)).not.toContain('synthetic-only-key');
    });

    test('reused and copied handles fail before backend reads', async () => {
      const original = await begin();
      const result = await prepare(fixture.store, original.handle);
      expect(result.kind).toBe('ready');
      const count = fixture.readCount();
      const before = await fixture.nativeState();
      for (const handle of [original.handle, { ...original.handle }, null]) {
        expect(await prepare(fixture.store, handle)).toEqual({
          kind: 'invalid_handle',
          eligibleFirstCommit: false,
        });
      }
      expect(fixture.readCount()).toBe(count);
      expect(await fixture.nativeState()).toEqual(before);
    });

    test('a foreign owner cannot consume the original owner’s live handle', async () => {
      const original = await begin();
      const other = await fixture.anotherOwner();
      const count = fixture.readCount();
      expect(await prepare(other, original.handle)).toEqual({
        kind: 'invalid_handle',
        eligibleFirstCommit: false,
      });
      expect(fixture.readCount()).toBe(count);
      expect(isLiveAutonomousPersonalCaptureLeaseHandleV4(original.handle)).toBe(true);
      expect((await prepare(fixture.store, original.handle)).kind).toBe('ready');
    });

    test('concurrent consumption admits exactly one read and one ready projection', async () => {
      const original = await begin();
      const before = await fixture.nativeState();
      const count = fixture.readCount();
      const results = await Promise.all([
        prepare(fixture.store, original.handle),
        prepare(fixture.store, original.handle),
      ]);
      expect(results.map((result) => result.kind).sort()).toEqual(['invalid_handle', 'ready']);
      expect(fixture.readCount()).toBe(count + 1);
      expect(await fixture.nativeState()).toEqual(before);
    });

    test('an original live handle tolerates a valid later audit without rewriting it', async () => {
      const original = await begin();
      const observed = await dispatchNativeAutonomousPersonalCaptureV4(
        nativeAutonomousPersonalCaptureContext(fixture.seed, { executionId: 'attempt:redelivery' }),
        fixture.store,
      );
      expect(observed.kind).toBe('in_progress');
      const before = await fixture.nativeState();
      const result = await prepare(fixture.store, original.handle);
      expect(result.kind).toBe('ready');
      expect(await fixture.nativeState()).toEqual(before);
      if (result.kind !== 'ready') throw new Error('Expected original live lease');
      expect(result.source.source_execution_id).toBe('attempt:original');
    });

    test('current binding revocation refuses preflight and preserves all existing rows', async () => {
      const original = await begin();
      const binding = fixture.seed.binding;
      await fixture.store.automaticBindingCommand!({
        action: 'revoke',
        namespace: binding.namespace,
        bindingId: binding.bindingId,
        expectedRevision: binding.revision,
        authorizedBy: 'synthetic-reviewer',
        reason: 'Synthetic preflight revocation',
      });
      const before = await fixture.nativeState();
      expect(await prepare(fixture.store, original.handle)).toEqual({
        kind: 'authority_changed',
        eligibleFirstCommit: false,
      });
      expect(await fixture.nativeState()).toEqual(before);
    });

    test('missing explicit intent does not masquerade as revoked source authority', async () => {
      const original = await begin('attempt:explicit', { automaticMemoryProfile: 'explicit' });
      const before = await fixture.nativeState();
      expect((await prepare(fixture.store, original.handle)).kind).toBe('ready');
      expect(await fixture.nativeState()).toEqual(before);
    });

    test('preserves an existing namespace with surrounding spaces exactly', async () => {
      const namespace = ` legacy:${fixture.seed.request.namespace} `;
      fixture.seed = await seedAutonomousPersonalCaptureSubject(fixture.store, namespace);
      const original = await begin();
      const before = await fixture.nativeState();
      const result = await prepare(fixture.store, original.handle);
      if (result.kind !== 'ready') throw new Error('Expected exact legacy namespace');
      expect(result.source.group_id).toBe(namespace);
      expect(result.source.group_id).not.toBe(namespace.trim());
      expect(await fixture.nativeState()).toEqual(before);
    });

    test('ready DATA rejects unknown permission fields and source normalization', async () => {
      const original = await begin();
      const result = await prepare(fixture.store, original.handle);
      if (result.kind !== 'ready') throw new Error('Expected verified source projection');
      expect(
        AutonomousPersonalCaptureProviderPreflightV4Schema.safeParse({
          ...result,
          should_process: true,
        }).success,
      ).toBe(false);
      expect(
        AutonomousPersonalCaptureProviderPreflightV4Schema.safeParse({
          ...result,
          source: { ...result.source, source_message_id: ' altered ' },
        }).success,
      ).toBe(false);
      expect(
        AutonomousPersonalCaptureProviderCancelledV4OwnedDataSchema.safeParse({
          kind: 'cancelled',
          eligibleFirstCommit: false,
        }).success,
      ).toBe(true);
      expect(
        AutonomousPersonalCaptureProviderPreflightV4Schema.safeParse({
          kind: 'cancelled_observed',
          eligibleFirstCommit: false,
        }).success,
      ).toBe(false);
    });

    test('proxy handles are rejected without property traps or backend reads', async () => {
      let traps = 0;
      const handle = new Proxy(
        {},
        {
          get() {
            traps++;
            throw new Error('private-sentinel');
          },
          ownKeys() {
            traps++;
            throw new Error('private-sentinel');
          },
        },
      );
      const count = fixture.readCount();
      expect(await prepare(fixture.store, handle)).toEqual({
        kind: 'invalid_handle',
        eligibleFirstCommit: false,
      });
      expect(traps).toBe(0);
      expect(fixture.readCount()).toBe(count);
    });
  });
}
