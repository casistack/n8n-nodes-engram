import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GraphologyStorage } from '../../src/storage/GraphologyStorage';
import { executeAutonomousPersonalAdminV4 } from '../../src/utils/autonomousPersonalAdmin';
import { NativeMemoryObservabilityV1Schema } from '../../src/schemas/NativeMemoryObservabilityV1.schema';
import {
  nativeAutonomousPersonalCaptureContext,
  seedAutonomousPersonalCaptureSubject,
} from '../helpers/autonomousPersonalCaptureBackend';

describe('native capture opt-in observability', () => {
  let directory: string;
  let store: GraphologyStorage;
  beforeEach(async () => {
    directory = fs.mkdtempSync(join(tmpdir(), 'engram-native-diagnostics-'));
    store = new GraphologyStorage(join(directory, 'store.json'));
    await store.initialize();
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it.each(['disabled', 'enabled'] as const)(
    'preserves accepted source and receipt with diagnostics %s',
    async (nativeDiagnostics) => {
      const seed = await seedAutonomousPersonalCaptureSubject(store);
      const original = structuredClone(await store.getEntity(seed.subject.uuid));
      const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        expect(body).not.toHaveProperty('temperature');
        const input = JSON.parse(body.messages[1].content);
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    version: 1,
                    units: input.units.map((unit: { unitId: string }) => ({
                      unitId: unit.unitId,
                      category: 'preference',
                      risk: 'ordinary',
                      usefulness: 'personal_memory',
                      downgrade: [],
                    })),
                  }),
                },
              },
            ],
            usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
          }),
          { status: 200 },
        );
      });
      const ctx = nativeAutonomousPersonalCaptureContext(seed, {
        extraParameters: { nativeDiagnostics },
      });
      const result = await executeAutonomousPersonalAdminV4(ctx, store);
      expect(result.status).toBe('captured');
      expect(result.should_process).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(1);
      const graph = await store.exportGraph();
      const operation = graph.automatic_operations_v1!.operations[0]!;
      expect(operation.state).toBe('committed');
      expect(graph.edges).toHaveLength(1);
      expect(graph.edges[0]!.episodes).toEqual([operation.identity.sourceId]);
      expect(await store.getEntity(seed.subject.uuid)).toEqual(original);
      expect(JSON.stringify(graph)).not.toContain('native_diagnostics_v1');
      if (nativeDiagnostics === 'disabled') {
        expect(result).not.toHaveProperty('native_diagnostics_v1');
      } else {
        const sidecar = NativeMemoryObservabilityV1Schema.parse(result.native_diagnostics_v1);
        expect(sidecar.purpose).toBe('capture');
        expect(sidecar.native_requests).toMatchObject({
          attempted: 1,
          completed: 1,
          in_flight: 0,
          usage_valid: 1,
          input_tokens: 3,
          output_tokens: 2,
          total_tokens: 5,
        });
        expect(sidecar.storage?.operations).toBeGreaterThan(0);
        expect(sidecar.observer_errors).toBe(0);
        expect(JSON.stringify(sidecar)).not.toContain(seed.request.source.content);
      }
    },
  );

  it('reports missing usage and source-only deferral after native provider retries', async () => {
    const seed = await seedAutonomousPersonalCaptureSubject(store);
    const fetch = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response('synthetic server failure', { status: 503 }));
    const result = await executeAutonomousPersonalAdminV4(
      nativeAutonomousPersonalCaptureContext(seed, {
        extraParameters: { nativeDiagnostics: 'enabled' },
      }),
      store,
    );
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(result.native_diagnostics_v1?.native_requests).toMatchObject({
      attempted: 2,
      failed: 2,
      usage_missing: 2,
      usage_valid: 0,
      input_tokens: null,
      output_tokens: null,
      total_tokens: null,
    });
    const graph = await store.exportGraph();
    expect(graph.episodes).toHaveLength(1);
    expect(graph.edges).toHaveLength(0);
    const operation = graph.automatic_operations_v1!.operations[0]!;
    expect(operation.state).toBe('committed');
    if (operation.version === 4 && operation.state === 'committed') {
      expect(operation.terminalReceipt.acceptedCoverage).toBe('none');
    }
  });
  it.each(['cancel', 'storage'] as const)(
    'keeps %s outcomes separate from request success',
    async (mode) => {
      const seed = await seedAutonomousPersonalCaptureSubject(store);
      const original = structuredClone(await store.getEntity(seed.subject.uuid));
      const controller = new AbortController();
      let armed = false;
      let renameFailures = 0;
      const rename = fs.promises.rename;
      if (mode === 'storage')
        jest.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
          if (armed && String(to) === join(directory, 'store.json')) {
            armed = false;
            renameFailures++;
            throw Object.assign(new Error('Synthetic persistence failure'), { code: 'EIO' });
          }
          return rename(from, to);
        });
      const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
        if (mode === 'cancel') {
          controller.abort();
          expect(init?.signal?.aborted).toBe(true);
          throw new DOMException('Synthetic cancellation', 'AbortError');
        }
        const body = JSON.parse(String(init?.body));
        const input = JSON.parse(body.messages[1].content);
        armed = true;
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    version: 1,
                    units: input.units.map((unit: { unitId: string }) => ({
                      unitId: unit.unitId,
                      category: 'preference',
                      risk: 'ordinary',
                      usefulness: 'personal_memory',
                      downgrade: [],
                    })),
                  }),
                },
              },
            ],
          }),
          { status: 200 },
        );
      });
      const context = nativeAutonomousPersonalCaptureContext(seed, {
        extraParameters: { nativeDiagnostics: 'enabled' },
      });
      context.getExecutionCancelSignal = () => controller.signal;
      const result = await executeAutonomousPersonalAdminV4(context, store);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(result.should_process).toBe(false);
      expect(result.status).toBe(mode === 'cancel' ? 'stopped' : 'unconfirmed');
      expect(result.native_diagnostics_v1?.native_requests).toMatchObject({
        attempted: 1,
        in_flight: 0,
        completed: mode === 'storage' ? 1 : 0,
        cancelled: mode === 'cancel' ? 1 : 0,
        usage_missing: 1,
      });
      expect(renameFailures).toBe(mode === 'storage' ? 1 : 0);
      expect(await store.getEntity(seed.subject.uuid)).toEqual(original);
      const graph = await store.exportGraph();
      expect(graph.edges).toHaveLength(0);
      expect(graph.episodes).toHaveLength(1);
      expect(graph.automatic_operations_v1!.operations[0]!.state).toBe('leased');
    },
  );
});
