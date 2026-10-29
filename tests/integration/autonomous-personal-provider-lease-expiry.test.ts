import * as fs from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { performance } from 'perf_hooks';
import { GraphologyStorage } from '../../src/storage/GraphologyStorage';
import { prepareNativeAutonomousPersonalCaptureProviderV4 } from '../../src/storage/AutonomousPersonalCaptureHandlesV4';
import {
  nativeAutonomousPersonalCaptureContext,
  seedAutonomousPersonalCaptureSubject,
} from '../helpers/autonomousPersonalCaptureBackend';

it('stops on the projected backend lease deadline even while the original invocation is live', async () => {
  const directory = fs.mkdtempSync(join(tmpdir(), 'engram-provider-lease-expiry-'));
  const file = join(directory, 'store.json');
  const store = new GraphologyStorage(file);
  try {
    await store.initialize();
    const seed = await seedAutonomousPersonalCaptureSubject(store);
    let monotonicNow = 0;
    jest.spyOn(performance, 'now').mockImplementation(() => monotonicNow);
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    const original = store.prepareAutonomousPersonalCaptureProviderV4.bind(store);
    let storedBeforeExpiry: string | undefined;
    let readyKind: string | undefined;
    let remainingLeaseMs: number | undefined;
    const preflight = jest
      .spyOn(store, 'prepareAutonomousPersonalCaptureProviderV4')
      .mockImplementation(async (handle) => {
        // Model a backend wall-clock jump after initial ownership. Keep real
        // timers and the separately controlled monotonic clock unchanged.
        jest.useFakeTimers({
          now: Date.now() + 60_000,
          doNotFake: [
            'performance',
            'hrtime',
            'nextTick',
            'queueMicrotask',
            'setTimeout',
            'clearTimeout',
            'setInterval',
            'clearInterval',
            'setImmediate',
            'clearImmediate',
          ],
        });
        let result;
        try {
          result = await original(handle);
          readyKind = result.kind;
          const graph = JSON.parse(fs.readFileSync(file, 'utf8'));
          const operation = graph.automatic_operations_v1.operations[0];
          remainingLeaseMs = Date.parse(operation.lease.expiresAt) - Date.now();
        } finally {
          jest.useRealTimers();
        }
        storedBeforeExpiry = fs.readFileSync(file, 'utf8');
        // Model monotonic elapsed time after an actual backend-ready read. The
        // 120-second invocation remains live, but its shorter lease has elapsed.
        monotonicNow = 90_000;
        return result;
      });
    const result = await prepareNativeAutonomousPersonalCaptureProviderV4(
      nativeAutonomousPersonalCaptureContext(seed, { deadlineMs: 120_000 }),
      store,
    );
    expect(preflight).toHaveBeenCalledTimes(1);
    expect(readyKind).toBe('ready');
    expect(remainingLeaseMs).toBeGreaterThan(0);
    expect(remainingLeaseMs).toBeLessThan(90_000);
    expect(result).toEqual({ kind: 'budget_exhausted', eligibleFirstCommit: false });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(fs.readFileSync(file, 'utf8')).toBe(storedBeforeExpiry);
  } finally {
    jest.useRealTimers();
    jest.restoreAllMocks();
    await store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
