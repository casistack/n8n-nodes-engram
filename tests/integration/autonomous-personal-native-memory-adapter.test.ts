import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AIMessage } from '@langchain/core/messages';
import {
  AutonomousPersonalNativeMemoryAdapterV4Error,
  closeAutonomousPersonalNativeMemoryAdapterV4,
  closePreparedAutonomousPersonalNativeMemoryAdapterV4,
  consumeAutonomousPersonalNativeMemoryAdapterV4,
  getAutonomousPersonalNativeMemoryAdapterAccessV4,
  prepareNativeAutonomousPersonalMemoryAdapterV4,
  refreshAutonomousPersonalNativeMemoryAdapterV4,
  type AutonomousPersonalNativeMemoryAdapterContextV4,
  type PrivateAutonomousPersonalNativeMemoryAdapterTokenV4,
} from '../../src/memory/AutonomousPersonalNativeMemoryAdapterV4';
import { AutonomousPersonalNativeMemorySnapshotV4Error } from '../../src/utils/AutonomousPersonalNativeMemorySnapshotV4';
import { GraphologyStorage } from '../../src/storage/GraphologyStorage';
import { ExtractionBudgetError } from '../../src/extraction/ExtractionDiagnostics';
import { openAutonomousPersonalMemoryReadV4 } from '../../src/memory/AutonomousPersonalMemoryReadV4';
import { completeNativeAutonomousPersonalCaptureV4 } from '../../src/storage/AutonomousPersonalNativeCompletionV4';
import { publishAutonomousPersonalMemoryHandoffV4 } from '../../src/storage/AutonomousPersonalNativeMemoryHandoffV4';
import {
  closeAutonomousPersonalAssistantFinalInvocationV4,
  issueAutonomousPersonalAssistantFinalInvocationV4,
} from '../../src/storage/AutonomousPersonalAssistantFinalInvocationV4';
import { prepareAutonomousPersonalAssistantFinalIntentV4 } from '../../src/memory/AutonomousPersonalAssistantFinalIntentV4';
import { createAutonomousPersonalNativeMemoryWorkV4 } from '../../src/utils/AutonomousPersonalNativeMemoryWorkV4';
import type { IGraphStorage } from '../../src/storage/IGraphStorage';
import type { AutomaticAssistantFinalWriterResultV2 } from '../../src/schemas/AutomaticAssistantCapture.schema';
import {
  autonomousPersonalMemoryContextV4,
  type AutonomousPersonalMemoryContextOptionsV4,
} from '../helpers/autonomousPersonalMemoryBackend';
import { nativeAutonomousPersonalCaptureContext } from '../helpers/autonomousPersonalCaptureBackend';
import { seedAutonomousPersonalCaptureSubject } from '../helpers/autonomousPersonalCaptureBackend';

jest.setTimeout(30_000);

type MemoryContextOptions = Omit<
  AutonomousPersonalMemoryContextOptionsV4,
  'persistPath' | 'storageWorkflowId'
> & {
  readonly persistPath: string;
  readonly storageWorkflowId: string;
};

type MutableMemoryContext = {
  readonly context: AutonomousPersonalNativeMemoryAdapterContextV4;
  readonly parameters: Record<string, unknown>;
  setParameter(name: string, value: unknown): void;
  clearParameter(name: string): void;
  setProfile(value: unknown): void;
  setInterpreter(value: unknown): void;
  setCredentialBlocker?(block: boolean): void;
  waitForCredentialBlock?: Promise<void>;
  releaseCredentialBlock?: () => void;
  abortNative?(): void;
};

type Fixture = {
  readonly directory: string;
  readonly file: string;
  readonly workflowId: string;
  readonly native: { instance: string; workflow: string; execution: string };
  readonly turn: string;
  readonly sourceId: string;
  readonly contextFixture: MutableMemoryContext;
  sourceOwner: GraphologyStorage | null;
  memoryOwner: GraphologyStorage | null;
  memoryOwnerOpen: boolean;
  token: PrivateAutonomousPersonalNativeMemoryAdapterTokenV4 | null;
};

const SOURCE_CONTENT = 'I prefer concise explanations.';

function memoryContext(
  options: MemoryContextOptions,
  withNativeSignal: boolean,
): MutableMemoryContext {
  const base = autonomousPersonalMemoryContextV4(options);
  const overrides: Record<string, unknown> = {};
  const controller = withNativeSignal ? new AbortController() : null;
  let credentialBlock = false;
  let interpreter: unknown = 'autonomousPersonalV1';
  let markCredentialBlocked: (() => void) | null = null;
  let releaseCredentialBlock: (() => void) | null = null;
  const waitForCredentialBlock = new Promise<void>((resolve) => {
    markCredentialBlocked = resolve;
  });
  const credentialGate = new Promise<void>((resolve) => {
    releaseCredentialBlock = resolve;
  });

  const context = {
    ...base,
    getNode: () => {
      const node = base.getNode();
      return {
        ...node,
        parameters: {
          ...node.parameters,
          automaticPreferenceInterpreter: interpreter,
        },
      };
    },
    getNodeParameter: (name: string, index: number, fallback: unknown) =>
      Object.prototype.hasOwnProperty.call(overrides, name)
        ? overrides[name]
        : base.getNodeParameter(name, index, fallback),
    getCredentials: async (name: string) => {
      if (credentialBlock && name === 'engramExtractionApi') {
        markCredentialBlocked?.();
        await credentialGate;
      }
      return base.getCredentials(name);
    },
    ...(controller ? { getExecutionCancelSignal: () => controller.signal } : {}),
  } as unknown as AutonomousPersonalNativeMemoryAdapterContextV4;

  return {
    context,
    parameters: overrides,
    setParameter(name, value) {
      overrides[name] = value;
    },
    clearParameter(name) {
      delete overrides[name];
    },
    setProfile(value) {
      overrides.automaticMemoryProfile = value;
    },
    setInterpreter(value) {
      interpreter = value;
    },
    setCredentialBlocker(block) {
      credentialBlock = block;
    },
    waitForCredentialBlock,
    releaseCredentialBlock() {
      releaseCredentialBlock?.();
    },
    abortNative() {
      controller?.abort();
    },
  };
}

async function makeFixture(
  options: {
    readonly profileId?: 'conservative' | 'explicit' | 'reviewFirst';
    readonly withNativeSignal?: boolean;
  } = {},
): Promise<Fixture> {
  const directory = fs.mkdtempSync(join(tmpdir(), 'engram-native-memory-adapter-'));
  const workflowId = `native-memory-adapter-${randomUUID()}`;
  const file = join(directory, `${workflowId}-engram.json`);
  let sourceOwner: GraphologyStorage | null = new GraphologyStorage(file);
  await sourceOwner.initialize();
  const seed = await seedAutonomousPersonalCaptureSubject(sourceOwner);
  const turn = `native-memory-turn-${randomUUID()}`;
  const native = {
    instance: `native-memory-instance-${randomUUID()}`,
    workflow: workflowId,
    execution: `native-memory-execution-${randomUUID()}`,
  };
  const sourceContext = nativeAutonomousPersonalCaptureContext(seed, {
    content: SOURCE_CONTENT,
    executionId: native.execution,
    workflowId: native.workflow,
    instanceId: native.instance,
    routeId: 'route:native-memory-adapter-test',
    model: 'model:native-memory-adapter-test',
    extraParameters: {
      automaticMemoryProfile: 'explicit',
      automaticIntent: 'disabled',
      automaticTurn: turn,
    },
  });
  const provider = jest.spyOn(globalThis, 'fetch');
  const completed = await completeNativeAutonomousPersonalCaptureV4(sourceContext, sourceOwner);
  expect(provider).not.toHaveBeenCalled();
  if (completed.kind !== 'original_turn') {
    throw new Error(`Expected actual C2 original turn; got ${completed.kind}`);
  }
  const publication = publishAutonomousPersonalMemoryHandoffV4(
    sourceContext,
    sourceOwner,
    completed.origin,
  );
  if (publication.kind !== 'published') {
    throw new Error('Expected actual same-execution Memory handoff publication');
  }

  await sourceOwner.close();
  sourceOwner = null;
  const memoryOwner = new GraphologyStorage(file);
  await memoryOwner.initialize();

  const contextFixture = memoryContext(
    {
      persistPath: file,
      storageWorkflowId: workflowId,
      native,
      namespace: seed.request.namespace,
      issuer: seed.request.issuer,
      actorReference: seed.request.actorReference,
      turn,
      sourceId: publication.sourceId,
      profileId: options.profileId ?? 'conservative',
      explicitIntent: false,
      currentHumanQuery: SOURCE_CONTENT,
      sourceMapping: { mode: 'full_body' },
      routeId: 'route:native-memory-adapter-test',
      model: 'model:native-memory-adapter-test',
      deadlineMs: 30_000,
    },
    options.withNativeSignal ?? true,
  );

  return {
    directory,
    file,
    workflowId,
    native,
    turn,
    sourceId: publication.sourceId,
    contextFixture,
    sourceOwner,
    memoryOwner,
    memoryOwnerOpen: true,
    token: null,
  };
}

describe('native personal Memory adapter V4', () => {
  const fixtures: Fixture[] = [];

  afterEach(async () => {
    jest.restoreAllMocks();
    for (const fixture of fixtures.splice(0)) {
      if (fixture.memoryOwner && fixture.token) {
        closePreparedAutonomousPersonalNativeMemoryAdapterV4(fixture.memoryOwner, fixture.token);
      }
      if (fixture.memoryOwner && fixture.memoryOwnerOpen) {
        await fixture.memoryOwner.close();
        fixture.memoryOwnerOpen = false;
      }
      if (fixture.sourceOwner) await fixture.sourceOwner.close();
      fs.rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  async function createFixture(options: Parameters<typeof makeFixture>[0] = {}): Promise<Fixture> {
    const fixture = await makeFixture(options);
    fixtures.push(fixture);
    return fixture;
  }

  async function prepare(
    fixture: Fixture,
  ): Promise<PrivateAutonomousPersonalNativeMemoryAdapterTokenV4> {
    const token = await prepareNativeAutonomousPersonalMemoryAdapterV4(
      fixture.contextFixture.context,
      0,
      fixture.memoryOwner!,
    );
    fixture.token = token;
    return token;
  }

  function freshContext(
    fixture: Fixture,
    options: {
      readonly automaticTurn?: string;
      readonly getCredentials?: unknown;
      readonly signal?: AbortSignal;
    } = {},
  ): {
    context: AutonomousPersonalNativeMemoryAdapterContextV4;
    getNodeParameter: jest.Mock;
  } {
    const base = fixture.contextFixture.context;
    const getBaseParameter = base.getNodeParameter as unknown as (
      name: string,
      index: number,
      fallback: unknown,
    ) => unknown;
    const getNodeParameter = jest.fn((name: string, index: number, fallback: unknown) => {
      if (name === 'automaticTurn' && options.automaticTurn !== undefined)
        return options.automaticTurn;
      return getBaseParameter(name, index, fallback);
    });
    const context = {
      ...base,
      getNodeParameter,
      ...(options.getCredentials ? { getCredentials: options.getCredentials } : {}),
      ...(options.signal ? { getExecutionCancelSignal: () => options.signal } : {}),
    } as unknown as AutonomousPersonalNativeMemoryAdapterContextV4;
    return { context, getNodeParameter };
  }

  it('prepares from a real C2 handoff after owner reopen and retains a reusable bounded reader', async () => {
    const fixture = await createFixture();
    const token = await prepare(fixture);
    const memory = {};

    expect(Object.keys(token)).toEqual([]);
    expect(JSON.stringify(token)).toBe('{}');
    expect(
      consumeAutonomousPersonalNativeMemoryAdapterV4(fixture.memoryOwner!, token, memory),
    ).toBe(true);
    const access = getAutonomousPersonalNativeMemoryAdapterAccessV4(memory);
    expect(access).not.toBeNull();
    expect(Object.isFrozen(access)).toBe(true);
    expect(access?.owner).toBe(fixture.memoryOwner);
    expect(access?.lineage).not.toBeNull();
    expect(access?.initialSnapshot?.config.sourceId).toBe(fixture.sourceId);
    expect(access?.initialSnapshot?.config.native).toEqual(fixture.native);
    expect(access?.nativeCancellationAvailable).toBe(true);
    expect(Object.isFrozen(access?.initialSnapshot)).toBe(true);
    expect(JSON.stringify(access?.initialSnapshot)).not.toContain('synthetic-memory-secret');

    access?.checkOpen();
    const repeatedSnapshot = await access!.readSnapshot();
    expect(repeatedSnapshot).toEqual(access?.initialSnapshot);
    expect(await access!.readSnapshot()).toEqual(repeatedSnapshot);

    closeAutonomousPersonalNativeMemoryAdapterV4(memory);
    expect(getAutonomousPersonalNativeMemoryAdapterAccessV4(memory)).toBeNull();
    expect(access?.owner).toBeNull();
    expect(access?.lineage).toBeNull();
    expect(access?.initialSnapshot).toBeNull();
    expect(access?.signal).toBeNull();
  });

  it('refreshes the reader for the same admitted Memory without changing its lineage or snapshot', async () => {
    const fixture = await createFixture({ profileId: 'explicit' });
    const token = await prepare(fixture);
    const memory = {};
    expect(
      consumeAutonomousPersonalNativeMemoryAdapterV4(fixture.memoryOwner!, token, memory),
    ).toBe(true);
    const access = getAutonomousPersonalNativeMemoryAdapterAccessV4(memory)!;
    const originalLineage = access.lineage;
    const originalSnapshot = access.initialSnapshot;
    const oldReaderSnapshot = await access.readSnapshot();
    const opened = await openAutonomousPersonalMemoryReadV4(memory);
    if (opened.kind !== 'read_ready')
      throw new Error(`Expected a live native read frame, got ${opened.reason}`);
    const fresh = freshContext(fixture);

    try {
      await expect(
        refreshAutonomousPersonalNativeMemoryAdapterV4(
          fixture.memoryOwner!,
          memory,
          fresh.context,
          0,
        ),
      ).resolves.toBe(true);
      expect(() => opened.frame.check()).not.toThrow();

      const callsAfterRefresh = fresh.getNodeParameter.mock.calls.length;
      expect(callsAfterRefresh).toBeGreaterThan(0);
      expect(await access.readSnapshot()).toEqual(oldReaderSnapshot);
      expect(fresh.getNodeParameter.mock.calls.length).toBeGreaterThan(callsAfterRefresh);
      expect(access.owner).toBe(fixture.memoryOwner);
      expect(access.lineage).toBe(originalLineage);
      expect(access.initialSnapshot).toBe(originalSnapshot);
    } finally {
      opened.frame.close();
    }
  });

  it('closes the admitted Memory on a fresh configuration or owner mismatch', async () => {
    const fixture = await createFixture({ profileId: 'explicit' });
    const token = await prepare(fixture);
    const memory = {};
    expect(
      consumeAutonomousPersonalNativeMemoryAdapterV4(fixture.memoryOwner!, token, memory),
    ).toBe(true);
    const opened = await openAutonomousPersonalMemoryReadV4(memory);
    if (opened.kind !== 'read_ready')
      throw new Error(`Expected a live native read frame, got ${opened.reason}`);
    const mismatch = freshContext(fixture, { automaticTurn: 'foreign-memory-turn' });

    try {
      await expect(
        refreshAutonomousPersonalNativeMemoryAdapterV4(
          fixture.memoryOwner!,
          memory,
          mismatch.context,
          0,
        ),
      ).resolves.toBe(false);
      expect(getAutonomousPersonalNativeMemoryAdapterAccessV4(memory)).toBeNull();
      expect(() => opened.frame.check()).toThrow();
    } finally {
      opened.frame.close();
    }

    const secondFixture = await createFixture();
    const secondToken = await prepare(secondFixture);
    const secondMemory = {};
    expect(
      consumeAutonomousPersonalNativeMemoryAdapterV4(
        secondFixture.memoryOwner!,
        secondToken,
        secondMemory,
      ),
    ).toBe(true);
    const foreignOwner = {} as IGraphStorage;
    await expect(
      refreshAutonomousPersonalNativeMemoryAdapterV4(
        foreignOwner,
        secondMemory,
        freshContext(secondFixture).context,
        0,
      ),
    ).resolves.toBe(false);
    expect(getAutonomousPersonalNativeMemoryAdapterAccessV4(secondMemory)).toBeNull();
  });

  it('stops an in-flight final writer before commit after the continuation snapshot mismatches', async () => {
    const fixture = await createFixture({ profileId: 'explicit' });
    const token = await prepare(fixture);
    const memory = {};
    expect(
      consumeAutonomousPersonalNativeMemoryAdapterV4(fixture.memoryOwner!, token, memory),
    ).toBe(true);
    const access = getAutonomousPersonalNativeMemoryAdapterAccessV4(memory)!;
    const snapshot = access.initialSnapshot!;
    const translated = prepareAutonomousPersonalAssistantFinalIntentV4(
      undefined,
      new AIMessage('A synthetic final response.'),
      snapshot.memoryAttemptHash,
      snapshot.config.invocationDeadlineMs,
    );
    if (translated.kind !== 'prepared') throw new Error('Expected a valid native final intent');
    const work = createAutonomousPersonalNativeMemoryWorkV4(
      fixture.contextFixture.context,
      snapshot.config.invocationDeadlineMs,
    );
    const invocation = await issueAutonomousPersonalAssistantFinalInvocationV4(
      fixture.memoryOwner!,
      access.lineage!,
      translated.intent,
      () => access.readSnapshot(),
      work.work,
      () => {
        access.checkOpen();
        work.check();
      },
    );
    if (!invocation) throw new Error('Expected a genuine owner-bound final invocation');

    const before = await fixture.memoryOwner!.exportGraph();
    const persistedBefore = fs.readFileSync(fixture.file);
    let markWriterStarted!: () => void;
    let releaseWriter!: () => void;
    const writerStarted = new Promise<void>((resolve) => {
      markWriterStarted = resolve;
    });
    const writerGate = new Promise<void>((resolve) => {
      releaseWriter = resolve;
    });
    const originalExport = fixture.memoryOwner!.exportGraph.bind(fixture.memoryOwner);
    let blocked = false;
    const exportSpy = jest
      .spyOn(fixture.memoryOwner!, 'exportGraph')
      .mockImplementation(async () => {
        if (!blocked) {
          blocked = true;
          markWriterStarted();
          await writerGate;
        }
        return originalExport();
      });
    let saving: Promise<AutomaticAssistantFinalWriterResultV2> | undefined;
    try {
      saving = fixture.memoryOwner!.saveAssistantFinalV4!(invocation);
      await writerStarted;
      const mismatched = freshContext(fixture, { automaticTurn: 'foreign-memory-turn' });
      await expect(
        refreshAutonomousPersonalNativeMemoryAdapterV4(
          fixture.memoryOwner!,
          memory,
          mismatched.context,
          0,
        ),
      ).resolves.toBe(false);
      releaseWriter();
      const result = await saving;
      expect(result.kind).toBe('decision');
      exportSpy.mockRestore();
      expect(result.kind === 'decision' ? result.reason : null).toBe('storage_error');
      const after = await fixture.memoryOwner!.exportGraph();
      expect({ ...after, exported_at: null }).toEqual({ ...before, exported_at: null });
      expect(fs.readFileSync(fixture.file)).toEqual(persistedBefore);
    } finally {
      releaseWriter();
      exportSpy.mockRestore();
      if (saving) await saving.catch(() => undefined);
      closeAutonomousPersonalAssistantFinalInvocationV4(fixture.memoryOwner!, invocation);
    }
  });

  it('serializes refresh behind an in-flight snapshot and uses the new reader afterward', async () => {
    const fixture = await createFixture();
    const token = await prepare(fixture);
    const memory = {};
    expect(
      consumeAutonomousPersonalNativeMemoryAdapterV4(fixture.memoryOwner!, token, memory),
    ).toBe(true);
    const access = getAutonomousPersonalNativeMemoryAdapterAccessV4(memory)!;
    fixture.contextFixture.setCredentialBlocker?.(true);
    const reading = access.readSnapshot();
    await fixture.contextFixture.waitForCredentialBlock;

    const base = fixture.contextFixture.context;
    const freshCredentialReader = jest.fn(async (type: string, itemIndex?: number) =>
      base.getCredentials(type, itemIndex),
    );
    const fresh = freshContext(fixture, { getCredentials: freshCredentialReader });
    const refreshing = refreshAutonomousPersonalNativeMemoryAdapterV4(
      fixture.memoryOwner!,
      memory,
      fresh.context,
      0,
    );
    await Promise.resolve();
    expect(freshCredentialReader).not.toHaveBeenCalled();

    fixture.contextFixture.releaseCredentialBlock?.();
    await expect(reading).resolves.toEqual(access.initialSnapshot);
    await expect(refreshing).resolves.toBe(true);
    expect(freshCredentialReader).toHaveBeenCalled();
    expect(await access.readSnapshot()).toEqual(access.initialSnapshot);
  });

  it('closes a candidate reader when the adapter is aborted or closed during refresh', async () => {
    async function blockedRefreshFixture(): Promise<{
      fixture: Fixture;
      memory: object;
      started: Promise<void>;
      release(): void;
      refreshing: Promise<boolean>;
    }> {
      const fixture = await createFixture();
      const token = await prepare(fixture);
      const memory = {};
      expect(
        consumeAutonomousPersonalNativeMemoryAdapterV4(fixture.memoryOwner!, token, memory),
      ).toBe(true);
      let markStarted!: () => void;
      let release!: () => void;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const base = fixture.contextFixture.context;
      const gatedCredentials = jest.fn(async (type: string, itemIndex?: number) => {
        if (type === 'engramExtractionApi') {
          markStarted();
          await gate;
        }
        return base.getCredentials(type, itemIndex);
      });
      const refreshing = refreshAutonomousPersonalNativeMemoryAdapterV4(
        fixture.memoryOwner!,
        memory,
        freshContext(fixture, { getCredentials: gatedCredentials }).context,
        0,
      );
      return { fixture, memory, started, release, refreshing };
    }

    const aborted = await blockedRefreshFixture();
    await aborted.started;
    aborted.fixture.contextFixture.abortNative?.();
    aborted.release();
    await expect(aborted.refreshing).rejects.toBeInstanceOf(ExtractionBudgetError);
    expect(getAutonomousPersonalNativeMemoryAdapterAccessV4(aborted.memory)).toBeNull();

    const closed = await blockedRefreshFixture();
    await closed.started;
    closeAutonomousPersonalNativeMemoryAdapterV4(closed.memory);
    closed.release();
    await expect(closed.refreshing).resolves.toBe(false);
    expect(getAutonomousPersonalNativeMemoryAdapterAccessV4(closed.memory)).toBeNull();
  });

  it('rejects Review First before spending the genuine handoff', async () => {
    const fixture = await createFixture();
    fixture.contextFixture.setProfile('reviewFirst');

    await expect(
      prepareNativeAutonomousPersonalMemoryAdapterV4(
        fixture.contextFixture.context,
        0,
        fixture.memoryOwner!,
      ),
    ).rejects.toBeInstanceOf(AutonomousPersonalNativeMemoryAdapterV4Error);

    fixture.contextFixture.clearParameter('automaticMemoryProfile');
    await expect(prepare(fixture)).resolves.toBeDefined();
  });

  it('requires the actual current owner identity and preserves a handoff after a foreign-owner attempt', async () => {
    const fixture = await createFixture();
    const foreignOwner = new GraphologyStorage(join(fixture.directory, 'foreign-store.json'));
    await foreignOwner.initialize();
    try {
      await expect(
        prepareNativeAutonomousPersonalMemoryAdapterV4(
          fixture.contextFixture.context,
          0,
          foreignOwner,
        ),
      ).rejects.toBeInstanceOf(AutonomousPersonalNativeMemoryAdapterV4Error);
    } finally {
      await foreignOwner.close();
    }

    await expect(prepare(fixture)).resolves.toBeDefined();
  });

  it('rejects copied, proxied, foreign-owner, and reused constructor tokens', async () => {
    const fixture = await createFixture();
    const token = await prepare(fixture);
    const firstMemory = {};
    const secondMemory = {};
    const foreignOwner = {} as IGraphStorage;

    expect(consumeAutonomousPersonalNativeMemoryAdapterV4(foreignOwner, token, firstMemory)).toBe(
      false,
    );
    expect(
      consumeAutonomousPersonalNativeMemoryAdapterV4(
        fixture.memoryOwner!,
        { ...(token as object) },
        firstMemory,
      ),
    ).toBe(false);
    expect(
      consumeAutonomousPersonalNativeMemoryAdapterV4(
        fixture.memoryOwner!,
        new Proxy(token as object, {}),
        firstMemory,
      ),
    ).toBe(false);
    expect(
      consumeAutonomousPersonalNativeMemoryAdapterV4(
        fixture.memoryOwner!,
        token,
        new Proxy(firstMemory, {}),
      ),
    ).toBe(false);

    expect(
      consumeAutonomousPersonalNativeMemoryAdapterV4(fixture.memoryOwner!, token, firstMemory),
    ).toBe(true);
    expect(
      consumeAutonomousPersonalNativeMemoryAdapterV4(fixture.memoryOwner!, token, secondMemory),
    ).toBe(false);
    expect(
      consumeAutonomousPersonalNativeMemoryAdapterV4(fixture.memoryOwner!, token, firstMemory),
    ).toBe(false);
    expect(getAutonomousPersonalNativeMemoryAdapterAccessV4(secondMemory)).toBeNull();

    closePreparedAutonomousPersonalNativeMemoryAdapterV4(fixture.memoryOwner!, token);
    expect(getAutonomousPersonalNativeMemoryAdapterAccessV4(firstMemory)).toBeNull();
  });

  it('enforces live strict configuration changes and ignores no-signaling fallback cleanup', async () => {
    const fixture = await createFixture({ withNativeSignal: false });
    const addListener = jest.spyOn(AbortSignal.prototype, 'addEventListener');
    fixture.contextFixture.setInterpreter('autonomousPersonalV1 ');
    await expect(
      prepareNativeAutonomousPersonalMemoryAdapterV4(
        fixture.contextFixture.context,
        0,
        fixture.memoryOwner!,
      ),
    ).rejects.toBeInstanceOf(AutonomousPersonalNativeMemoryAdapterV4Error);
    fixture.contextFixture.setInterpreter('autonomousPersonalV1');

    fixture.contextFixture.setParameter('automaticTurn', 'foreign-memory-turn');
    await expect(
      prepareNativeAutonomousPersonalMemoryAdapterV4(
        fixture.contextFixture.context,
        0,
        fixture.memoryOwner!,
      ),
    ).rejects.toBeInstanceOf(AutonomousPersonalNativeMemoryAdapterV4Error);
    fixture.contextFixture.clearParameter('automaticTurn');

    const token = await prepare(fixture);
    expect(addListener).not.toHaveBeenCalled();
    const memory = {};
    expect(
      consumeAutonomousPersonalNativeMemoryAdapterV4(fixture.memoryOwner!, token, memory),
    ).toBe(true);
    const access = getAutonomousPersonalNativeMemoryAdapterAccessV4(memory)!;
    expect(access.nativeCancellationAvailable).toBe(false);

    fixture.contextFixture.setProfile('reviewFirst');
    await expect(access.readSnapshot()).rejects.toBeInstanceOf(
      AutonomousPersonalNativeMemoryAdapterV4Error,
    );
    expect(getAutonomousPersonalNativeMemoryAdapterAccessV4(memory)).toBeNull();
  });

  it('does not retain the setup deadline and lets a fresh operation enforce its own deadline', async () => {
    const fixture = await createFixture();
    const token = await prepare(fixture);
    const memory = {};
    expect(
      consumeAutonomousPersonalNativeMemoryAdapterV4(fixture.memoryOwner!, token, memory),
    ).toBe(true);
    const access = getAutonomousPersonalNativeMemoryAdapterAccessV4(memory)!;

    let now = 100_000;
    jest.spyOn(performance, 'now').mockImplementation(() => now);
    access.checkOpen();
    const firstRead = await access.readSnapshot();
    expect(await access.readSnapshot()).toEqual(firstRead);

    const operationWork = createAutonomousPersonalNativeMemoryWorkV4(
      fixture.contextFixture.context,
      30_000,
    );
    operationWork.check();
    now = 130_000;
    let operationFailure: unknown;
    try {
      operationWork.check();
    } catch (error) {
      operationFailure = error;
    }
    expect(operationFailure).toBeInstanceOf(ExtractionBudgetError);
    expect((operationFailure as ExtractionBudgetError).budgetReason).toBe('deadline');

    access.checkOpen();
    expect(await access.readSnapshot()).toEqual(firstRead);
    fixture.contextFixture.abortNative?.();
    expect(getAutonomousPersonalNativeMemoryAdapterAccessV4(memory)).toBeNull();
  });

  it('removes a real native abort listener on close and rejects an in-flight snapshot after close', async () => {
    const fixture = await createFixture();
    const token = await prepare(fixture);
    const memory = {};
    expect(
      consumeAutonomousPersonalNativeMemoryAdapterV4(fixture.memoryOwner!, token, memory),
    ).toBe(true);
    const access = getAutonomousPersonalNativeMemoryAdapterAccessV4(memory)!;
    const signal = access.signal!;
    const removeListener = jest.spyOn(signal, 'removeEventListener');

    fixture.contextFixture.setCredentialBlocker?.(true);
    const inFlight = access.readSnapshot();
    await fixture.contextFixture.waitForCredentialBlock;
    closeAutonomousPersonalNativeMemoryAdapterV4(memory);
    fixture.contextFixture.releaseCredentialBlock?.();
    await expect(inFlight).rejects.toBeInstanceOf(AutonomousPersonalNativeMemorySnapshotV4Error);
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(getAutonomousPersonalNativeMemoryAdapterAccessV4(memory)).toBeNull();
    expect(access.owner).toBeNull();

    const abortFixture = await createFixture();
    const abortToken = await prepare(abortFixture);
    const abortMemory = {};
    expect(
      consumeAutonomousPersonalNativeMemoryAdapterV4(
        abortFixture.memoryOwner!,
        abortToken,
        abortMemory,
      ),
    ).toBe(true);
    const abortAccess = getAutonomousPersonalNativeMemoryAdapterAccessV4(abortMemory)!;
    const abortSignal = abortAccess.signal!;
    const removeOnAbort = jest.spyOn(abortSignal, 'removeEventListener');
    abortFixture.contextFixture.abortNative?.();
    expect(removeOnAbort).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(getAutonomousPersonalNativeMemoryAdapterAccessV4(abortMemory)).toBeNull();
    expect(abortAccess.owner).toBeNull();
  });
});
