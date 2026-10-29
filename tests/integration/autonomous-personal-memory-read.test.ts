import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EngramChatMessageHistory } from '../../src/memory/EngramChatMessageHistory';
import {
  AutonomousPersonalNativeMemoryAdapterV4Error,
  closeAutonomousPersonalNativeMemoryAdapterV4,
  consumeAutonomousPersonalNativeMemoryAdapterV4,
  prepareNativeAutonomousPersonalMemoryAdapterV4,
  type AutonomousPersonalNativeMemoryAdapterContextV4,
  type PrivateAutonomousPersonalNativeMemoryAdapterTokenV4,
} from '../../src/memory/AutonomousPersonalNativeMemoryAdapterV4';
import {
  openAutonomousPersonalMemoryReadV4,
  readAutonomousPersonalConversationV4,
  type AutonomousPersonalMemoryReadFrameV4,
} from '../../src/memory/AutonomousPersonalMemoryReadV4';
import { getAutonomousPersonalMemoryParentReadStopV4 } from '../../src/memory/AutonomousPersonalMemoryParentReaderV4';
import { ExtractionBudgetError } from '../../src/extraction/ExtractionDiagnostics';
import { completeNativeAutonomousPersonalCaptureV4 } from '../../src/storage/AutonomousPersonalNativeCompletionV4';
import { publishAutonomousPersonalMemoryHandoffV4 } from '../../src/storage/AutonomousPersonalNativeMemoryHandoffV4';
import * as PersonalRecordIntegrity from '../../src/storage/AutonomousPersonalRecordIntegrityV4';
import { GraphologyStorage } from '../../src/storage/GraphologyStorage';
import { HybridSearchEngine } from '../../src/search/HybridSearchEngine';
import {
  autonomousPersonalMemoryContextV4,
  type AutonomousPersonalMemoryContextOptionsV4,
} from '../helpers/autonomousPersonalMemoryBackend';
import {
  nativeAutonomousPersonalCaptureContext,
  seedAutonomousPersonalCaptureSubject,
} from '../helpers/autonomousPersonalCaptureBackend';

jest.setTimeout(30_000);

type MemoryContextOptions = Omit<
  AutonomousPersonalMemoryContextOptionsV4,
  'persistPath' | 'storageWorkflowId'
> & {
  readonly persistPath: string;
  readonly storageWorkflowId: string;
};

type ReadFixture = {
  readonly directory: string;
  readonly namespace: string;
  readonly sourceId: string;
  readonly owner: GraphologyStorage;
  readonly memory: object;
  readonly token: PrivateAutonomousPersonalNativeMemoryAdapterTokenV4;
  readonly controller: AbortController;
  setParameter(name: string, value: unknown): void;
};

const CURRENT_SOURCE = 'I prefer plain English, please.';
const RAW_JSON_HUMAN = '{"genuine":"human JSON stays conversation history"}';

async function createReadFixture(): Promise<ReadFixture> {
  const directory = fs.mkdtempSync(join(tmpdir(), 'engram-native-memory-read-'));
  const workflowId = `native-memory-read-${randomUUID()}`;
  const file = join(directory, `${workflowId}-engram.json`);
  const sourceOwner = new GraphologyStorage(file);
  await sourceOwner.initialize();
  const seed = await seedAutonomousPersonalCaptureSubject(sourceOwner);

  await sourceOwner.appendEpisodes([
    {
      group_id: seed.request.namespace,
      role: 'human',
      content: 'An older conversation turn.',
      episode_kind: 'active_human',
      reference_time: '2026-10-24T09:00:00.000Z',
    },
    {
      group_id: seed.request.namespace,
      role: 'ai',
      content: 'An older answer.',
      episode_kind: 'assistant_reply',
      reference_time: '2026-10-24T09:01:00.000Z',
    },
    {
      group_id: seed.request.namespace,
      role: 'human',
      content: RAW_JSON_HUMAN,
      episode_kind: 'active_human',
      reference_time: '2026-10-24T10:00:00.000Z',
    },
    {
      group_id: seed.request.namespace,
      role: 'ai',
      content: 'Earlier answer in this conversation.',
      episode_kind: 'assistant_reply',
      reference_time: '2026-10-24T10:01:00.000Z',
    },
    {
      group_id: seed.request.namespace,
      role: 'system',
      content: 'Synthetic tool audit that must stay out of history.',
      episode_kind: 'tool_output',
      reference_time: '2026-10-24T10:02:00.000Z',
      trust_level: 'unverified',
      review_status: 'proposed',
      attributes: { engram_audit: true },
    },
  ]);

  const turn = `native-memory-turn-${randomUUID()}`;
  const native = {
    instance: `native-memory-instance-${randomUUID()}`,
    workflow: workflowId,
    execution: `native-memory-execution-${randomUUID()}`,
  };
  const provider = jest.spyOn(globalThis, 'fetch');
  const sourceContext = nativeAutonomousPersonalCaptureContext(seed, {
    content: CURRENT_SOURCE,
    executionId: native.execution,
    workflowId: native.workflow,
    instanceId: native.instance,
    extraParameters: {
      automaticMemoryProfile: 'explicit',
      automaticIntent: 'disabled',
      automaticTurn: turn,
    },
  });
  const completed = await completeNativeAutonomousPersonalCaptureV4(sourceContext, sourceOwner);
  if (completed.kind !== 'original_turn') {
    await sourceOwner.close();
    fs.rmSync(directory, { recursive: true, force: true });
    throw new Error(`Expected actual C2 original turn; got ${completed.kind}`);
  }
  expect(provider).not.toHaveBeenCalled();
  const publication = publishAutonomousPersonalMemoryHandoffV4(
    sourceContext,
    sourceOwner,
    completed.origin,
  );
  if (publication.kind !== 'published') {
    await sourceOwner.close();
    fs.rmSync(directory, { recursive: true, force: true });
    throw new Error('Expected actual same-execution Memory handoff publication');
  }
  await sourceOwner.close();

  const owner = new GraphologyStorage(file);
  await owner.initialize();
  const memoryOptions: MemoryContextOptions = {
    persistPath: file,
    storageWorkflowId: workflowId,
    native,
    namespace: seed.request.namespace,
    issuer: seed.request.issuer,
    actorReference: seed.request.actorReference,
    turn,
    sourceId: publication.sourceId,
    profileId: 'explicit',
    explicitIntent: false,
    currentHumanQuery: CURRENT_SOURCE,
    sourceMapping: { mode: 'full_body' },
    deadlineMs: 30_000,
    routeId: 'route:synthetic',
    model: 'model:synthetic-memory',
  };
  const base = autonomousPersonalMemoryContextV4(memoryOptions);
  const parameters: Record<string, unknown> = {};
  const controller = new AbortController();
  const context = {
    ...base,
    getNode: () => {
      const node = base.getNode();
      return {
        ...node,
        parameters: {
          ...node.parameters,
          automaticPreferenceInterpreter: 'autonomousPersonalV1',
        },
      };
    },
    getNodeParameter: (name: string, itemIndex: number, fallback: unknown) =>
      Object.prototype.hasOwnProperty.call(parameters, name)
        ? parameters[name]
        : base.getNodeParameter(name, itemIndex, fallback),
    getExecutionCancelSignal: () => controller.signal,
  } as unknown as AutonomousPersonalNativeMemoryAdapterContextV4;
  const token = await prepareNativeAutonomousPersonalMemoryAdapterV4(context, 0, owner);
  const memory = {};
  if (!consumeAutonomousPersonalNativeMemoryAdapterV4(owner, token, memory)) {
    await owner.close();
    fs.rmSync(directory, { recursive: true, force: true });
    throw new Error('Expected one actual native Memory adapter consumption');
  }

  return {
    directory,
    namespace: seed.request.namespace,
    sourceId: publication.sourceId,
    owner,
    memory,
    token,
    controller,
    setParameter(name, value) {
      parameters[name] = value;
    },
  };
}

describe('native autonomous personal Memory read V4', () => {
  const fixtures: ReadFixture[] = [];
  const frames: AutonomousPersonalMemoryReadFrameV4[] = [];

  afterEach(async () => {
    jest.restoreAllMocks();
    for (const frame of frames.splice(0)) frame.close();
    for (const fixture of fixtures.splice(0)) {
      closeAutonomousPersonalNativeMemoryAdapterV4(fixture.memory);
      await fixture.owner.close();
      fs.rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  async function fixture(): Promise<ReadFixture> {
    const created = await createReadFixture();
    fixtures.push(created);
    return created;
  }

  async function openFrame(readFixture: ReadFixture): Promise<AutonomousPersonalMemoryReadFrameV4> {
    const result = await openAutonomousPersonalMemoryReadV4(readFixture.memory);
    if (result.kind !== 'read_ready')
      throw new Error(`Expected read frame, got rejected:${result.reason}`);
    frames.push(result.frame);
    return result.frame;
  }

  it('opens one checked parent and returns only raw conversation after source and audit exclusion', async () => {
    const current = await fixture();
    const readSnapshot = jest.spyOn(current.owner, 'readCompositionalRetrievalSnapshotV3');
    const backendHistory = jest.spyOn(current.owner, 'getRecentEpisodes');
    const checkedIndex = jest.spyOn(
      PersonalRecordIntegrity,
      'createIntegrityCheckedAutonomousPersonalClaimIndexV4',
    );
    const engineFactory = jest.spyOn(HybridSearchEngine, 'forAutonomousPersonalMemoryV4');
    const frame = await openFrame(current);
    expect(readSnapshot).toHaveBeenCalledTimes(1);
    expect(checkedIndex).toHaveBeenCalledTimes(1);
    expect(engineFactory).toHaveBeenCalledTimes(1);
    expect(frame.parentReader).not.toBeNull();
    expect(frame.compatibilityReader).not.toBeNull();
    expect(frame.storage).not.toBe(current.owner);
    expect(frame.receiptSummary).not.toBeNull();
    expect(JSON.stringify(frame)).toBe('{}');

    const history = new EngramChatMessageHistory({
      storage: current.owner,
      groupId: current.namespace,
      contextWindow: 2,
      policy: { historyFilter: 'provenance', finalTurnWrites: true },
    });
    const forbiddenGuard = jest.fn(async () => {
      throw new Error('native delegate must own the full read');
    });
    history.setReadGuard(forbiddenGuard);
    history.setSnapshotReadProvider(() =>
      readAutonomousPersonalConversationV4(frame, {
        contextWindow: 2,
        humanEpisodeKind: 'active_human',
        policy: { historyFilter: 'provenance', finalTurnWrites: true },
      }),
    );

    const result = await history.getMessagesWithDiagnostics();
    expect(forbiddenGuard).not.toHaveBeenCalled();
    expect(backendHistory).not.toHaveBeenCalled();
    expect(result.messages.map((message) => message._getType())).toEqual(['human', 'ai']);
    expect(result.messages[0].content).toBe(RAW_JSON_HUMAN);
    expect(String(result.messages[1].content)).toBe('Earlier answer in this conversation.');
    expect(result.history.excluded_provenance).toBeGreaterThan(0);
    expect(result.history.returned).toBe(2);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(CURRENT_SOURCE);
    expect(serialized).not.toContain(current.sourceId);
    expect(serialized).not.toContain('Synthetic tool audit');
    expect(Object.keys(result).sort()).toEqual(['history', 'messages']);

    // With no native delegate installed, the original direct storage read still runs.
    const ordinaryHistory = new EngramChatMessageHistory({
      storage: current.owner,
      groupId: current.namespace,
      contextWindow: 2,
    });
    await ordinaryHistory.getMessagesWithDiagnostics();
    expect(backendHistory).toHaveBeenCalledTimes(1);
  });

  it('blocks live configuration drift before any ParentReader snapshot is opened', async () => {
    const current = await fixture();
    current.setParameter('automaticMemoryProfile', 'reviewFirst');
    const readSnapshot = jest.spyOn(current.owner, 'readCompositionalRetrievalSnapshotV3');

    await expect(openAutonomousPersonalMemoryReadV4(current.memory)).rejects.toBeInstanceOf(
      AutonomousPersonalNativeMemoryAdapterV4Error,
    );
    expect(readSnapshot).not.toHaveBeenCalled();
  });

  it('fails closed after native abort without falling back to actual backend history', async () => {
    const current = await fixture();
    const frame = await openFrame(current);
    const readSnapshot = jest.spyOn(current.owner, 'readCompositionalRetrievalSnapshotV3');
    const backendHistory = jest.spyOn(current.owner, 'getRecentEpisodes');
    current.controller.abort();

    await expect(
      readAutonomousPersonalConversationV4(frame, {
        contextWindow: 2,
        humanEpisodeKind: 'active_human',
        policy: { historyFilter: 'provenance', finalTurnWrites: true },
      }),
    ).rejects.toBeInstanceOf(ExtractionBudgetError);
    expect(readSnapshot).not.toHaveBeenCalled();
    expect(backendHistory).not.toHaveBeenCalled();
    expect(frame.storage).toBeNull();
  });

  it('fails closed after adapter close and removes its ParentReader without backend fallback', async () => {
    const current = await fixture();
    const frame = await openFrame(current);
    const parent = frame.parentReader!;
    const readSnapshot = jest.spyOn(current.owner, 'readCompositionalRetrievalSnapshotV3');
    const backendHistory = jest.spyOn(current.owner, 'getRecentEpisodes');
    closeAutonomousPersonalNativeMemoryAdapterV4(current.memory);

    await expect(
      readAutonomousPersonalConversationV4(frame, {
        contextWindow: 2,
        humanEpisodeKind: 'active_human',
        policy: { historyFilter: 'provenance', finalTurnWrites: true },
      }),
    ).rejects.toBeInstanceOf(AutonomousPersonalNativeMemoryAdapterV4Error);
    expect(readSnapshot).not.toHaveBeenCalled();
    expect(backendHistory).not.toHaveBeenCalled();
    expect(getAutonomousPersonalMemoryParentReadStopV4(current.owner, parent)).toBe(
      'invalid_reader',
    );
    expect(frame.storage).toBeNull();
  });

  it('uses fresh read work after adapter setup expires and closes the parent after read expiry', async () => {
    const current = await fixture();
    const setupFinished = performance.now();
    let now = setupFinished + 31_000;
    jest.spyOn(performance, 'now').mockImplementation(() => now);

    const frame = await openFrame(current);
    const first = await readAutonomousPersonalConversationV4(frame, {
      contextWindow: 2,
      humanEpisodeKind: 'active_human',
      policy: { historyFilter: 'provenance', finalTurnWrites: true },
    });
    const second = await readAutonomousPersonalConversationV4(frame, {
      contextWindow: 2,
      humanEpisodeKind: 'active_human',
      policy: { historyFilter: 'provenance', finalTurnWrites: true },
    });
    expect(second.messages.map((message) => message.content)).toEqual(
      first.messages.map((message) => message.content),
    );

    const owner = frame.owner!;
    const parent = frame.parentReader!;
    now += 6_000;
    expect(() => frame.check()).toThrow(ExtractionBudgetError);
    frame.close();
    expect(getAutonomousPersonalMemoryParentReadStopV4(owner, parent)).toBe('invalid_reader');
    expect(frame.parentReader).toBeNull();
  });
});
