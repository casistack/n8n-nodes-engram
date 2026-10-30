import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { EngramAdmin } from '../../src/nodes/EngramAdmin/EngramAdmin.node';
import { AutonomousPersonalNativeAdminV4OutputSchema } from '../../src/schemas/AutonomousPersonalNativeAdminV4.schema';
import { AUTONOMOUS_CAPTURE_V4_OWNER_ATTRIBUTE } from '../../src/schemas/AutonomousPersonalSourceV4.schema';
import { GraphologyStorage } from '../../src/storage/GraphologyStorage';
import { resolveStoragePath } from '../../src/utils/helpers';
import {
  nativeAutonomousPersonalCaptureContext,
  seedAutonomousPersonalCaptureSubject,
} from '../helpers/autonomousPersonalCaptureBackend';
import type { GraphData } from '../../src/schemas/GraphData.schema';

type ProviderBody = { messages: Array<{ content: string }> };

jest.setTimeout(30_000);

/**
 * Regression for the Admin's last output projection. The first diagnostic projection advances
 * the monotonic clock beyond the invocation deadline after the durable completion has committed.
 * The Admin must run that projection inside the fixed entry callback, so its final check returns
 * a stopped result while leaving the committed receipt intact. If attachment moves after the
 * scope callback, this returns `captured` and the test fails.
 */
describe('Autonomous Personal Admin diagnostic projection deadline boundary', () => {
  let directory: string;
  let workflowId: string;
  let persistPath: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(join(tmpdir(), 'engram-admin-diagnostic-projection-'));
    workflowId = 'workflow:diagnostic-projection';
    persistPath = resolveStoragePath({ customStoragePath: directory, workflowId });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  async function readGraph(namespace: string): Promise<GraphData> {
    const reader = new GraphologyStorage(persistPath);
    await reader.initialize();
    try {
      return await reader.readExtractionSnapshot(namespace);
    } finally {
      await reader.close();
    }
  }

  function contextFor(
    namespaceSeed: Awaited<ReturnType<typeof seedAutonomousPersonalCaptureSubject>>,
    turn: string,
    executionId: string,
  ) {
    const context = nativeAutonomousPersonalCaptureContext(namespaceSeed, {
      executionId,
      workflowId,
      instanceId: 'instance:diagnostic-projection',
      deadlineMs: 30_000,
      content: 'I prefer concise explanations.',
      extraParameters: {
        resource: 'automaticMemory',
        operation: 'captureHuman',
        automaticWorkflowId: workflowId,
        customStoragePath: directory,
        automaticExecutionBudgetMode: 'configuredV1',
        automaticMemoryProfile: 'explicit',
        automaticIntent: 'enabled',
        automaticTurn: turn,
      },
    });
    const originalGetNode = context.getNode.bind(context);
    const mutable = context as unknown as { getNode: typeof context.getNode };
    mutable.getNode = () => {
      const node = originalGetNode();
      return {
        ...node,
        parameters: {
          ...node.parameters,
          automaticExecutionBudgetMode: 'configuredV1',
        },
      };
    };
    return context;
  }

  function installProvider() {
    return jest.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as ProviderBody;
      const user = JSON.parse(body.messages[1]!.content) as {
        units: Array<{ unitId: string }>;
      };
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  version: 1,
                  units: user.units.map(({ unitId }) => ({
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
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
  }

  function operationFor(graph: GraphData, turn: string) {
    const matches = (graph.automatic_operations_v1?.operations ?? []).filter(
      (operation) => operation.version === 4 && operation.identity.turn === turn,
    );
    expect(matches).toHaveLength(1);
    return matches[0]!;
  }

  it('stops after diagnostic attachment crosses the deadline while preserving the committed receipt', async () => {
    const store = new GraphologyStorage(persistPath);
    await store.initialize();
    const seed = await seedAutonomousPersonalCaptureSubject(store);
    await store.close();

    const turn = 'turn:diagnostic-projection-deadline';
    const admin = new EngramAdmin();
    const fetchSpy = installProvider();
    const nativeNow = performance.now.bind(performance);
    let clockOffsetMs = 0;
    jest.spyOn(performance, 'now').mockImplementation(() => nativeNow() + clockOffsetMs);

    let diagnosticProjectionCount = 0;
    const schema = AutonomousPersonalNativeAdminV4OutputSchema;
    const originalSafeParse = schema.safeParse.bind(schema);
    jest.spyOn(schema, 'safeParse').mockImplementation((input, params) => {
      const result = originalSafeParse(input, params);
      if (
        input !== null &&
        typeof input === 'object' &&
        !Array.isArray(input) &&
        Object.prototype.hasOwnProperty.call(input, 'execution_diagnostics')
      ) {
        diagnosticProjectionCount += 1;
        if (diagnosticProjectionCount === 1) clockOffsetMs = 30_001;
      }
      return result;
    });

    const first = await admin.execute.call(contextFor(seed, turn, 'execution:first'));
    expect(diagnosticProjectionCount).toBeGreaterThan(0);
    expect(first[0]).toEqual([]);
    expect(first[1][0]?.json).toMatchObject({
      version: 4,
      should_process: false,
      status: 'unconfirmed',
      reason: 'budget_exhausted',
      execution_diagnostics: {
        firstStop: 'invocation_deadline',
      },
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const afterFirst = await readGraph(seed.request.namespace);
    const firstOperation = operationFor(afterFirst, turn);
    expect(firstOperation).toMatchObject({ version: 4, state: 'committed' });
    if (firstOperation.version !== 4 || firstOperation.state !== 'committed') {
      throw new Error('Expected a durable committed V4 operation');
    }
    expect(firstOperation.terminalReceipt).toBeDefined();
    expect(
      afterFirst.episodes.filter(
        (episode) => episode.attributes[AUTONOMOUS_CAPTURE_V4_OWNER_ATTRIBUTE],
      ),
    ).toHaveLength(1);
    expect(afterFirst.edges.filter((edge) => edge.attributes.engram_claim_v1)).toHaveLength(1);

    // The test clock jump is only the injected projection cost; restore it before redelivery.
    clockOffsetMs = 0;
    const replay = await admin.execute.call(contextFor(seed, turn, 'execution:replay'));
    expect(replay[1][0]?.json).toMatchObject({
      version: 4,
      should_process: false,
      status: 'replay',
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const afterReplay = await readGraph(seed.request.namespace);
    const replayOperation = operationFor(afterReplay, turn);
    expect(replayOperation).toMatchObject({ version: 4, state: 'committed' });
    if (replayOperation.version !== 4 || replayOperation.state !== 'committed') {
      throw new Error('Expected the replay to retain the durable committed V4 operation');
    }
    expect(replayOperation.terminalReceipt).toEqual(firstOperation.terminalReceipt);
    expect(afterReplay.entities).toEqual(afterFirst.entities);
    expect(afterReplay.edges).toEqual(afterFirst.edges);
    expect(afterReplay.episodes).toEqual(afterFirst.episodes);
    expect(
      afterReplay.episodes.filter(
        (episode) => episode.attributes[AUTONOMOUS_CAPTURE_V4_OWNER_ATTRIBUTE],
      ),
    ).toHaveLength(1);
    expect(afterReplay.edges.filter((edge) => edge.attributes.engram_claim_v1)).toHaveLength(1);
  });
});
