import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GraphologyStorage } from '../../../src/storage/GraphologyStorage';
import { executeAutonomousPersonalAdminV4 } from '../../../src/utils/autonomousPersonalAdmin';
import { runWithAutonomousPersonalExecutionEntryV1 } from '../../../src/utils/AutonomousPersonalExecutionEntryV1';
import {
  currentAutonomousPersonalExecutionScopeWorkV1,
  checkCurrentAutonomousPersonalExecutionScopeWorkV1,
} from '../../../src/storage/AutonomousPersonalExecutionScopeV1';
import {
  seedAutonomousPersonalCaptureSubject,
  nativeAutonomousPersonalCaptureContext,
} from '../../helpers/autonomousPersonalCaptureBackend';
import { seedAutomaticCaptureSubject } from '../../helpers/automaticCaptureBackend';
import { captureCompositionalHumanMemoryV3 } from '../../../src/memory/CompositionalHumanCaptureV3';
import { CompositionalAutomaticCaptureBeginRequestV3Schema } from '../../../src/schemas/CompositionalAutomaticCaptureV3.schema';

type Internals = {
  runMutation(body: () => unknown, options?: Record<string, unknown>): Promise<unknown>;
  refreshFromDiskUnderLock(...args: unknown[]): Promise<unknown>;
};

describe('ordinary rollback optimization excludes actual native and capture factories', () => {
  let directory: string;
  let store: GraphologyStorage;
  beforeEach(async () => {
    directory = fs.mkdtempSync(join(tmpdir(), 'engram084-native-exclusion-'));
    store = new GraphologyStorage(join(directory, 'synthetic-workflow-engram.json'));
    await store.initialize();
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      const input = JSON.parse(
        body.messages.find((row: { role: string }) => row.role === 'user').content,
      );
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  version: 1,
                  units: input.units.map(({ unitId }: { unitId: string }) => ({
                    unitId,
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
        { headers: { 'content-type': 'application/json' } },
      );
    });
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  async function autonomous() {
    const seed = await seedAutonomousPersonalCaptureSubject(store, 'synthetic-native-exclusion');
    const context = nativeAutonomousPersonalCaptureContext(seed, {
      workflowId: 'synthetic-workflow',
      content: 'I prefer concise explanations.',
      extraParameters: {
        automaticExecutionBudgetMode: 'configuredV1',
        automaticCompletionBudgetMode: 'inheritOverall',
        automaticSyntaxBudgetMode: 'inheritOverall',
        automaticFinalizationReserveMode: 'automatic',
      },
    });
    return runWithAutonomousPersonalExecutionEntryV1(context, () =>
      executeAutonomousPersonalAdminV4(context, store),
    );
  }

  function observe() {
    const target = store as unknown as Internals;
    const mutations: Array<{ completion: boolean; capture: boolean }> = [];
    const refreshes: Array<{ retained: unknown; configuredGuard: boolean }> = [];
    const mutation = target.runMutation.bind(store);
    jest.spyOn(target, 'runMutation').mockImplementation(async (body, options = {}) => {
      mutations.push({
        completion: options.autonomousPersonalCompletionV4 !== undefined,
        capture: options.captureRead !== undefined,
      });
      return mutation(body, options);
    });
    const refresh = target.refreshFromDiskUnderLock.bind(store);
    jest.spyOn(target, 'refreshFromDiskUnderLock').mockImplementation(async (...args) => {
      const result = await refresh(...args);
      const scopeWork = currentAutonomousPersonalExecutionScopeWorkV1();
      const guardWork = (args[3] as { typedSyntaxWork?: unknown } | undefined)?.typedSyntaxWork;
      refreshes.push({
        retained: result,
        configuredGuard:
          scopeWork === undefined ||
          checkCurrentAutonomousPersonalExecutionScopeWorkV1(guardWork as never) === 'configured',
      });
      expect(args[4]).not.toBe(true);
      return result;
    });
    return { mutations, refreshes };
  }

  it('keeps the native completion path and its registered guard through real autonomous capture', async () => {
    const observed = observe();
    const result = await autonomous();
    expect(result).toMatchObject({ status: 'captured', should_process: true });
    expect(observed.mutations.some((row) => row.completion)).toBe(true);
    expect(observed.refreshes.length).toBeGreaterThan(0);
    for (const row of observed.refreshes) {
      expect(row.retained).toBeUndefined();
      expect(row.configuredGuard).toBe(true);
    }
  });

  it('keeps real compositional capture-read capabilities on the export-based path of an enrolled store', async () => {
    await autonomous();
    const seeded = await seedAutomaticCaptureSubject(store, 'synthetic-compositional-exclusion');
    const request = CompositionalAutomaticCaptureBeginRequestV3Schema.parse({
      ...seeded.request,
      version: 3,
      preferenceInterpreter: 'compositionalV2',
      source: { ...seeded.request.source, content: 'What games are on today?' },
    });
    const observed = observe();
    const result = await captureCompositionalHumanMemoryV3(store, request);
    expect(result).toMatchObject({ status: 'first_capture_committed', should_process: true });
    expect(observed.mutations.some((row) => row.capture)).toBe(true);
    expect(observed.refreshes.length).toBeGreaterThan(0);
    expect(observed.refreshes.every((row) => row.retained === undefined)).toBe(true);
  });
});
