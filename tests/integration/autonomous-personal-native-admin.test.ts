import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { executeAutomaticAdmin } from '../../src/utils/automaticAdmin';
import { embeddedAutomaticCaptureStoreHash } from '../../src/storage/AutomaticCaptureStore';
import { GraphologyStorage } from '../../src/storage/GraphologyStorage';
import * as PersonalNativeOrigin from '../../src/storage/AutonomousPersonalNativeOriginV4';
import * as PersonalHandoff from '../../src/storage/AutonomousPersonalNativeMemoryHandoffV4';
import type { GraphData } from '../../src/schemas/GraphData.schema';
import {
  nativeAutonomousPersonalCaptureContext,
  seedAutonomousPersonalCaptureSubject,
} from '../helpers/autonomousPersonalCaptureBackend';

jest.setTimeout(30_000);

type ProviderBody = {
  messages: Array<{ role: string; content: string }>;
};

type AdminContext = ReturnType<typeof nativeAutonomousPersonalCaptureContext>;

describe('Autonomous Personal Admin native V4 dispatcher', () => {
  let directory: string;
  let file: string;
  let store: GraphologyStorage;
  let seed: Awaited<ReturnType<typeof seedAutonomousPersonalCaptureSubject>>;

  beforeEach(async () => {
    directory = fs.mkdtempSync(join(tmpdir(), 'engram-native-admin-v4-'));
    file = join(directory, 'store.json');
    store = new GraphologyStorage(file);
    await store.initialize();
    seed = await seedAutonomousPersonalCaptureSubject(store);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await store?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  function contextFor(
    turn: string,
    options: {
      readonly intent?: 'enabled' | 'disabled';
      readonly executionId?: string;
      readonly content?: string;
      readonly interpreter?: string;
      readonly profile?: 'conservative' | 'explicit' | 'reviewFirst';
    } = {},
  ): AdminContext {
    return nativeAutonomousPersonalCaptureContext(seed, {
      executionId: options.executionId ?? `execution:${turn}`,
      workflowId: `workflow:${turn}`,
      instanceId: `instance:${turn}`,
      deadlineMs: 30_000,
      content: options.content ?? 'I prefer concise explanations.',
      interpreter: options.interpreter ?? 'autonomousPersonalV1',
      extraParameters: {
        automaticMemoryProfile: options.profile ?? 'explicit',
        automaticIntent: options.intent ?? 'enabled',
        automaticTurn: turn,
      },
    });
  }

  function installProvider(mode: 'success' | 'unavailable' = 'success') {
    return jest.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      if (mode === 'unavailable') return new Response('synthetic unavailable', { status: 503 });

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

  function consumePublishedHandoff(context: AdminContext, turn: string, sourceId: string) {
    const storeHash = embeddedAutomaticCaptureStoreHash(file);
    if (!storeHash) throw new Error('Expected actual embedded store identity');
    return PersonalHandoff.consumeAutonomousPersonalMemoryHandoffV4(
      context,
      storeHash,
      seed.request.namespace,
      seed.request.issuer,
      seed.request.actorReference,
      turn,
      sourceId,
    );
  }

  async function dispatch(context: AdminContext) {
    const storeHash = embeddedAutomaticCaptureStoreHash(file);
    if (!storeHash) throw new Error('Expected actual embedded store identity');
    return executeAutomaticAdmin(context, store, 'captureHuman', 0, storeHash, true);
  }

  function operationRows(graph: GraphData, turn: string) {
    return (
      graph.automatic_operations_v1?.operations.filter(
        (operation) => operation.version === 4 && operation.identity.turn === turn,
      ) ?? []
    );
  }

  it('returns the creation summary and publishes only the actual original-turn handoff', async () => {
    const turn = `admin-native-original-${randomUUID()}`;
    const context = contextFor(turn);
    const fetchSpy = installProvider();
    const beginSpy = jest.spyOn(store, 'beginAndClaimAutonomousPersonalCaptureV4');
    const providerStageSpy = jest.spyOn(store, 'prepareAutonomousPersonalCaptureProviderV4');
    const completeSpy = jest.spyOn(store, 'completeAutonomousPersonalCaptureForNativeV4');
    const publishSpy = jest.spyOn(
      PersonalHandoff,
      'publishAutonomousPersonalMemoryHandoffWithSummaryV4',
    );
    const output = await dispatch(context);

    expect(output).toMatchObject({
      version: 4,
      should_process: true,
      status: 'captured',
      creationSummary: { kind: 'committed' },
    });
    expect(typeof output.sourceId).toBe('string');
    expect(output.creationSummary).toMatchObject({ sourceId: output.sourceId });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(beginSpy).toHaveBeenCalledTimes(1);
    expect(providerStageSpy).toHaveBeenCalledTimes(1);
    expect(completeSpy).toHaveBeenCalledTimes(1);
    expect(publishSpy).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(output)).not.toContain('terminalReceipt');
    expect(JSON.stringify(output)).not.toContain('nativeOrigin');

    const lineage = consumePublishedHandoff(context, turn, output.sourceId as string);
    expect(lineage).not.toBeNull();
    expect(consumePublishedHandoff(context, turn, output.sourceId as string)).toBeNull();
  });

  it('keeps a different-execution replay stopped without repeating provider work or publishing another handoff', async () => {
    const turn = `admin-native-replay-${randomUUID()}`;
    const context = contextFor(turn);
    const fetchSpy = installProvider();
    const beginSpy = jest.spyOn(store, 'beginAndClaimAutonomousPersonalCaptureV4');
    const providerStageSpy = jest.spyOn(store, 'prepareAutonomousPersonalCaptureProviderV4');
    const completeSpy = jest.spyOn(store, 'completeAutonomousPersonalCaptureForNativeV4');
    const publishSpy = jest.spyOn(
      PersonalHandoff,
      'publishAutonomousPersonalMemoryHandoffWithSummaryV4',
    );

    const original = await dispatch(context);
    expect(original).toMatchObject({ should_process: true, status: 'captured' });
    expect(consumePublishedHandoff(context, turn, original.sourceId as string)).not.toBeNull();
    const beforeReplay = await store.readExtractionSnapshot();

    const nativeContext = context as unknown as { getExecutionId(): string };
    nativeContext.getExecutionId = () => `execution:redelivery:${turn}`;
    const replay = await dispatch(context);
    const afterReplay = await store.readExtractionSnapshot();

    expect(replay).toMatchObject({
      version: 4,
      should_process: false,
      status: 'replay',
      sourceId: original.sourceId,
      creationSummary: original.creationSummary,
    });
    expect(beginSpy).toHaveBeenCalledTimes(2);
    expect(providerStageSpy).toHaveBeenCalledTimes(1);
    expect(completeSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(publishSpy).toHaveBeenCalledTimes(1);
    expect(afterReplay.entities).toEqual(beforeReplay.entities);
    expect(afterReplay.edges).toEqual(beforeReplay.edges);
    expect(afterReplay.episodes).toEqual(beforeReplay.episodes);
    const beforeOperations = beforeReplay.automatic_operations_v1?.operations ?? [];
    const afterOperations = afterReplay.automatic_operations_v1?.operations ?? [];
    expect(beforeOperations).toHaveLength(1);
    expect(afterOperations).toHaveLength(1);
    expect(afterOperations[0]).toMatchObject({
      operationId: beforeOperations[0]!.operationId,
      state: 'committed',
      attempts: [
        ...beforeOperations[0]!.attempts,
        expect.objectContaining({ disposition: 'committed_replay' }),
      ],
    });
    expect(operationRows(afterReplay, turn)).toHaveLength(1);
    expect(consumePublishedHandoff(context, turn, original.sourceId as string)).toBeNull();
  });

  it('maps a known native no-write completion to false and does not publish a handoff', async () => {
    const turn = `admin-native-no-write-${randomUUID()}`;
    const context = contextFor(turn);
    const fetchSpy = installProvider();
    const beginSpy = jest.spyOn(store, 'beginAndClaimAutonomousPersonalCaptureV4');
    jest
      .spyOn(PersonalNativeOrigin, 'projectAutonomousPersonalNativeOriginV4')
      .mockImplementation(() => {
        throw new PersonalNativeOrigin.AutonomousPersonalNativeOriginV4Error('capacity');
      });
    const publishSpy = jest.spyOn(
      PersonalHandoff,
      'publishAutonomousPersonalMemoryHandoffWithSummaryV4',
    );
    const beforeNoWrite = await store.readExtractionSnapshot();

    const output = await dispatch(context);

    expect(output).toEqual({
      version: 4,
      should_process: false,
      status: 'stopped',
      reason: 'capacity',
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(beginSpy).toHaveBeenCalledTimes(1);
    expect(publishSpy).not.toHaveBeenCalled();
    const noWriteSnapshot = await store.readExtractionSnapshot();
    expect(noWriteSnapshot.entities).toEqual(beforeNoWrite.entities);
    expect(noWriteSnapshot.edges).toEqual(beforeNoWrite.edges);
    expect(noWriteSnapshot.episodes).toHaveLength(beforeNoWrite.episodes.length + 1);
    expect(noWriteSnapshot.episodes.at(-1)).toMatchObject({
      role: 'human',
      episode_kind: 'active_human',
    });
    const rows = operationRows(noWriteSnapshot, turn);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: 'leased' });
    expect('terminalReceipt' in rows[0]!).toBe(false);
  });

  it('stops safely when the configured actor has no matching current authority', async () => {
    const turn = `admin-native-foreign-actor-${randomUUID()}`;
    const context = contextFor(turn);
    const originalGet = context.getNodeParameter.bind(context) as (...args: unknown[]) => unknown;
    Object.defineProperty(context, 'getNodeParameter', {
      configurable: true,
      value: (...args: unknown[]) =>
        args[0] === 'automaticActor' ? 'actor:foreign' : originalGet(...args),
    });
    const fetchSpy = installProvider();
    const publishSpy = jest.spyOn(
      PersonalHandoff,
      'publishAutonomousPersonalMemoryHandoffWithSummaryV4',
    );

    const output = await dispatch(context);

    expect(output).toMatchObject({ version: 4, should_process: false, status: 'stopped' });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(publishSpy).not.toHaveBeenCalled();
    expect(operationRows(await store.readExtractionSnapshot(), turn)).toHaveLength(0);
  });

  it('rejects ReviewFirst before creating a source episode or operation', async () => {
    const turn = `admin-native-review-first-${randomUUID()}`;
    const context = contextFor(turn, { profile: 'reviewFirst' });
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    const beginSpy = jest.spyOn(store, 'beginAndClaimAutonomousPersonalCaptureV4');
    const providerStageSpy = jest.spyOn(store, 'prepareAutonomousPersonalCaptureProviderV4');
    const completeSpy = jest.spyOn(store, 'completeAutonomousPersonalCaptureForNativeV4');
    const before = await store.readExtractionSnapshot();

    const output = await dispatch(context);
    const after = await store.readExtractionSnapshot();

    expect(output).toEqual({
      version: 4,
      should_process: false,
      status: 'stopped',
      reason: 'unsupported_mode',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(beginSpy).not.toHaveBeenCalled();
    expect(providerStageSpy).not.toHaveBeenCalled();
    expect(completeSpy).not.toHaveBeenCalled();
    expect(after.entities).toEqual(before.entities);
    expect(after.edges).toEqual(before.edges);
    expect(after.episodes).toEqual(before.episodes);
    expect(after.automatic_operations_v1).toEqual(before.automatic_operations_v1);
  });

  it('keeps the existing literal/default replay-safe route when the interpreter is absent', async () => {
    const turn = `admin-native-literal-default-${randomUUID()}`;
    const context = contextFor(turn, { interpreter: 'literalV1' });
    const originalGetNode = context.getNode.bind(context);
    context.getNode = () => {
      const node = originalGetNode();
      const parameters = { ...node.parameters };
      delete parameters.automaticPreferenceInterpreter;
      return { ...node, parameters };
    };
    const legacyBegin = jest.spyOn(store, 'beginAndClaimAutomaticCaptureV2');
    const nativeBegin = jest.spyOn(store, 'beginAndClaimAutonomousPersonalCaptureV4');
    const fetchSpy = jest.spyOn(globalThis, 'fetch');

    const output = await dispatch(context);

    expect(output).toMatchObject({
      version: 2,
      should_process: true,
      status: 'first_capture_committed',
    });
    expect(legacyBegin).toHaveBeenCalledTimes(1);
    expect(nativeBegin).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
