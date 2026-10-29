import type { IGraphStorage } from '../../src/storage/IGraphStorage';
import { prepareNativeAutonomousPersonalCaptureProviderV4 } from '../../src/storage/AutonomousPersonalCaptureHandlesV4';
import {
  nativeAutonomousPersonalCaptureContext,
  type AutonomousPersonalCaptureSeed,
} from './autonomousPersonalCaptureBackend';

export const providerTamperCases = [
  'source_content',
  'source_owner',
  'source_envelope',
  'source_missing',
  'operation_missing',
  'operation_descriptor',
  'operation_fence',
  'operation_expired',
] as const;
export type ProviderTamperCase = (typeof providerTamperCases)[number];

export interface ProviderTamperFixture {
  store: IGraphStorage;
  seed: AutonomousPersonalCaptureSeed;
  corrupt(kind: ProviderTamperCase): Promise<void>;
  nativeState(): Promise<unknown>;
  close(): Promise<void>;
}

/** Deliberate corruption is confined to a newly seeded synthetic test namespace. */
export function providerTamperContract(create: () => Promise<ProviderTamperFixture>): void {
  describe('changed actual authority never dispatches or repairs', () => {
    it.each(providerTamperCases)('%s', async (kind) => {
      const fixture = await create();
      const store = fixture.store;
      const original = store.prepareAutonomousPersonalCaptureProviderV4!.bind(store);
      const fetchSpy = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No HTTP'));
      let corruptedState: unknown;
      let afterPreflight: unknown;
      const preflight = jest
        .spyOn(store, 'prepareAutonomousPersonalCaptureProviderV4')
        .mockImplementation(async (handle) => {
          await fixture.corrupt(kind);
          corruptedState = await fixture.nativeState();
          const result = await original(handle);
          afterPreflight = await fixture.nativeState();
          return result;
        });
      try {
        const result = await prepareNativeAutonomousPersonalCaptureProviderV4(
          nativeAutonomousPersonalCaptureContext(fixture.seed),
          store,
        );
        expect(preflight).toHaveBeenCalledTimes(1);
        expect(result.kind).not.toBe('prepared');
        expect(result.eligibleFirstCommit).toBe(false);
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(afterPreflight).toEqual(corruptedState);
        expect(await fixture.nativeState()).toEqual(corruptedState);
      } finally {
        jest.restoreAllMocks();
        await fixture.close();
      }
    });
  });
}

export function corruptProviderOperation(
  operation: Record<string, unknown>,
  kind: ProviderTamperCase,
): void {
  if (kind === 'operation_descriptor') {
    operation.descriptor = { invalid: true };
  } else if (kind === 'operation_fence') {
    const lease = operation.lease as Record<string, unknown>;
    lease.token = '11111111-1111-4111-8111-111111111111';
  } else if (kind === 'operation_expired') {
    const lease = operation.lease as Record<string, unknown>;
    lease.expiresAt = new Date(Date.parse(lease.renewedAt as string) + 1).toISOString();
  }
}
