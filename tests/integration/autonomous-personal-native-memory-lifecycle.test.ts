import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { IExecuteFunctions } from 'n8n-workflow';
import { EngramMemory } from '../../src/nodes/EngramMemory/EngramMemory.node';
import { EngramChatMemory } from '../../src/memory/EngramChatMemory';
import { GraphologyStorage } from '../../src/storage/GraphologyStorage';
import * as StorageFactory from '../../src/storage/StorageFactory';
import { completeNativeAutonomousPersonalCaptureV4 } from '../../src/storage/AutonomousPersonalNativeCompletionV4';
import { publishAutonomousPersonalMemoryHandoffV4 } from '../../src/storage/AutonomousPersonalNativeMemoryHandoffV4';
import {
  nativeAutonomousPersonalCaptureContext,
  seedAutonomousPersonalCaptureSubject,
} from '../helpers/autonomousPersonalCaptureBackend';
import { autonomousPersonalMemoryContextV4 } from '../helpers/autonomousPersonalMemoryBackend';

const QUERY = 'What games are on today?';
const ROUTE = 'route:native-memory-lifecycle';
const MODEL = 'model:native-memory-lifecycle';

type LifecycleHooks = {
  readonly executionId: string;
  readonly workflowData: { readonly id: string };
  readonly handlers: {
    workflowExecuteAfter: Array<(...args: unknown[]) => Promise<void> | void>;
  };
  addHandler(name: string, ...handlers: Array<(...args: unknown[]) => Promise<void> | void>): void;
  runHook(name: string): Promise<void>;
};

type HostLifecycleRuntime = {
  readonly directory: string;
  readonly mainPath: string;
  readonly coreManifestPath: string;
  readonly leafPath: string;
  readonly HostLifecycleHooks: new (
    executionId: string,
    workflowData: { readonly id: string },
  ) => LifecycleHooks;
};

type SourceFixture = {
  readonly directory: string;
  readonly file: string;
  readonly workflow: string;
  readonly namespace: string;
  readonly issuer: string;
  readonly actorReference: string;
  readonly turn: string;
  readonly sourceId: string;
  readonly native: {
    readonly instance: string;
    readonly workflow: string;
    readonly execution: string;
  };
};

type CreatedOwner = {
  storage: GraphologyStorage | null;
};

type MemoryContext = IExecuteFunctions & {
  readonly parentNode: {
    readonly id: string;
    readonly name: string;
    readonly type: string;
    readonly typeVersion: number;
  };
  readonly additionalData: { readonly hooks: LifecycleHooks };
};

const directories = new Set<string>();
const hostDirectories = new Set<string>();
const createdOwners: CreatedOwner[] = [];

function makeHostLifecycleRuntime(): HostLifecycleRuntime {
  const directory = fs.mkdtempSync(join(tmpdir(), 'engram-native-lifecycle-host-'));
  hostDirectories.add(directory);
  const n8nRoot = join(directory, 'node_modules', 'n8n');
  const coreRoot = join(n8nRoot, 'node_modules', 'n8n-core');
  const mainPath = join(n8nRoot, 'bin', 'n8n.js');
  const coreManifestPath = join(coreRoot, 'package.json');
  const leafPath = join(coreRoot, 'dist', 'execution-engine', 'execution-lifecycle-hooks.js');
  fs.mkdirSync(join(n8nRoot, 'bin'), { recursive: true });
  fs.mkdirSync(join(coreRoot, 'dist', 'execution-engine'), { recursive: true });
  fs.writeFileSync(mainPath, '');
  fs.writeFileSync(
    join(n8nRoot, 'package.json'),
    JSON.stringify({ name: 'n8n', version: '2.12.3', bin: { n8n: './bin/n8n.js' } }),
  );
  fs.writeFileSync(
    coreManifestPath,
    JSON.stringify({ name: 'n8n-core', version: '2.12.0', main: 'dist/index.js' }),
  );
  fs.writeFileSync(join(coreRoot, 'dist', 'index.js'), 'module.exports = {};');
  fs.writeFileSync(
    leafPath,
    `class ExecutionLifecycleHooks {
      constructor(executionId, workflowData) {
        this.mode = 'manual';
        this.executionId = executionId;
        this.workflowData = workflowData;
        this.handlers = { workflowExecuteAfter: [] };
      }
      addHandler(name, ...handlers) { this.handlers[name].push(...handlers); }
      async runHook(name) {
        for (const handler of this.handlers[name]) await handler.call(this);
      }
    }
    module.exports = { ExecutionLifecycleHooks };`,
  );
  const HostLifecycleHooks = createRequire(coreManifestPath)(leafPath)
    .ExecutionLifecycleHooks as HostLifecycleRuntime['HostLifecycleHooks'];
  return { directory, mainPath, coreManifestPath, leafPath, HostLifecycleHooks };
}

async function createSourceFixture(): Promise<SourceFixture> {
  const directory = fs.mkdtempSync(join(tmpdir(), 'engram-native-lifecycle-source-'));
  directories.add(directory);
  const workflow = `native-memory-lifecycle-workflow-${randomUUID()}`;
  const file = join(directory, `${workflow}-engram.json`);
  const producer = new GraphologyStorage(file);
  await producer.initialize();
  try {
    const seed = await seedAutonomousPersonalCaptureSubject(producer);
    const native = {
      instance: `native-memory-instance-${randomUUID()}`,
      workflow,
      execution: `native-memory-execution-${randomUUID()}`,
    };
    const turn = `native-memory-turn-${randomUUID()}`;
    const captureContext = nativeAutonomousPersonalCaptureContext(seed, {
      content: QUERY,
      executionId: native.execution,
      workflowId: native.workflow,
      instanceId: native.instance,
      routeId: ROUTE,
      model: MODEL,
      requestLimit: 2,
      deadlineMs: 30_000,
      extraParameters: {
        automaticMemoryProfile: 'explicit',
        automaticIntent: 'disabled',
        automaticTurn: turn,
        automaticInput: QUERY,
        automaticWrapper: 'disabled',
        queueTemperatureMode: 'providerDefault',
      },
    });
    const provider = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('The synthetic lifecycle source must not call a provider');
    });
    let completed: Awaited<ReturnType<typeof completeNativeAutonomousPersonalCaptureV4>>;
    try {
      completed = await completeNativeAutonomousPersonalCaptureV4(captureContext, producer);
    } finally {
      provider.mockRestore();
    }
    if (provider.mock.calls.length > 0)
      throw new Error('The synthetic lifecycle source unexpectedly called a provider');
    if (completed.kind !== 'original_turn')
      throw new Error(`Expected actual C2 original turn, got ${completed.kind}`);
    const publication = publishAutonomousPersonalMemoryHandoffV4(
      captureContext,
      producer,
      completed.origin,
    );
    if (publication.kind !== 'published')
      throw new Error(`Expected actual published handoff, got ${publication.kind}`);
    return {
      directory,
      file,
      workflow,
      namespace: seed.request.namespace,
      issuer: seed.request.issuer,
      actorReference: seed.request.actorReference,
      turn,
      sourceId: publication.sourceId,
      native,
    };
  } finally {
    await producer.close();
  }
}

function createMemoryContext(
  fixture: SourceFixture,
  hooks: LifecycleHooks,
  signal: AbortSignal,
): MemoryContext {
  const base = autonomousPersonalMemoryContextV4({
    persistPath: fixture.file,
    storageWorkflowId: fixture.workflow,
    native: fixture.native,
    namespace: fixture.namespace,
    issuer: fixture.issuer,
    actorReference: fixture.actorReference,
    turn: fixture.turn,
    sourceId: fixture.sourceId,
    profileId: 'explicit',
    explicitIntent: false,
    currentHumanQuery: QUERY,
    routeId: ROUTE,
    model: MODEL,
    requestLimit: 2,
    deadlineMs: 30_000,
    temperatureMode: 'providerDefault',
  });
  const parameters: Record<string, unknown> = {
    backend: 'embedded',
    messageWritePolicy: 'finalTurns',
    historyFilter: 'provenance',
    maxHistoryScan: 100,
    legacyArtifactHashes: '',
    storeToolAudit: 'disabled',
    graphContextPolicy: 'current',
    graphContextAt: '',
    extractionExecution: 'synchronous',
    contextWindowLength: 10,
    enableExtraction: 'disabled',
    enableEmbeddings: 'disabled',
    retentionType: 'forever',
    storeHumanEpisodes: 'enabled',
    storeAiEpisodes: 'enabled',
    extractAi: 'disabled',
    extractSystemTool: 'disabled',
    memoryFactPolicy: 'acceptedOnly',
  };
  const nodeBase = base.getNode();
  const node = {
    ...nodeBase,
    id: `native-memory-node-${fixture.turn}`,
    type: 'n8n-nodes-engram.engramMemory',
    typeVersion: 3,
    parameters: {
      ...nodeBase.parameters,
      automaticPreferenceInterpreter: 'autonomousPersonalV1',
    },
  };
  const parentNode = {
    id: `native-memory-agent-${fixture.workflow}`,
    name: 'Synthetic AI Agent',
    type: '@n8n/n8n-nodes-langchain.agent',
    typeVersion: 3.1,
  };
  const outputData: unknown[] = [];
  const baseOwn = { ...base };
  Reflect.deleteProperty(baseOwn, 'getExecutionId');
  Reflect.deleteProperty(baseOwn, 'getWorkflow');
  const context = Object.create({
    getExecutionId: () => base.getExecutionId(),
    getWorkflow: () => base.getWorkflow(),
  }) as Record<string, unknown>;
  Object.assign(context, {
    ...baseOwn,
    parentNode,
    additionalData: { hooks },
    getNode: () => node,
    getNodeParameter: (name: string, itemIndex: number, fallback: unknown) =>
      Object.prototype.hasOwnProperty.call(parameters, name)
        ? parameters[name]
        : base.getNodeParameter(name, itemIndex, fallback),
    getExecutionCancelSignal: () => signal,
    addInputData: () => ({ index: 0 }),
    addOutputData: (...args: unknown[]) => outputData.push(args),
    outputData,
    logger: { info: () => undefined, warn: () => undefined, debug: () => undefined },
  });
  return context as unknown as MemoryContext;
}

function observeCreatedOwner(file: string): jest.SpyInstance {
  const created: CreatedOwner = { storage: null };
  createdOwners.push(created);
  const original = StorageFactory.createStorage;
  return jest.spyOn(StorageFactory, 'createStorage').mockImplementation((config) => {
    const storage = original(config);
    if (config.backend === 'embedded' && config.persistPath === file)
      created.storage = storage as GraphologyStorage;
    return storage;
  });
}

describe('native Memory workflow lifecycle V4 integration', () => {
  let priorArgv1: string | undefined;

  beforeEach(() => {
    priorArgv1 = process.argv[1];
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    for (const created of createdOwners.splice(0))
      await created.storage?.close().catch(() => undefined);
    for (const directory of directories) fs.rmSync(directory, { recursive: true, force: true });
    directories.clear();
    for (const directory of hostDirectories) fs.rmSync(directory, { recursive: true, force: true });
    hostDirectories.clear();
    if (priorArgv1 === undefined) delete process.argv[1];
    else process.argv[1] = priorArgv1;
  });

  async function prepare(): Promise<{
    fixture: SourceFixture;
    runtime: HostLifecycleRuntime;
    hooks: LifecycleHooks;
    context: MemoryContext;
  }> {
    const fixture = await createSourceFixture();
    const runtime = makeHostLifecycleRuntime();
    process.argv[1] = runtime.mainPath;
    const hooks = new runtime.HostLifecycleHooks(fixture.native.execution, {
      id: fixture.native.workflow,
    });
    const context = createMemoryContext(fixture, hooks, new AbortController().signal);
    observeCreatedOwner(fixture.file);
    return { fixture, runtime, hooks, context };
  }

  it('closes after workflow completion, runs later handlers, and rejects a spent continuation', async () => {
    const { hooks, context } = await prepare();
    const order: string[] = [];
    hooks.handlers.workflowExecuteAfter.push(() => {
      order.push('host-after');
    });
    const originalClose = EngramChatMemory.prototype.closeNativeMemoryV4;
    const closeMemory = jest
      .spyOn(EngramChatMemory.prototype, 'closeNativeMemoryV4')
      .mockImplementation(function (this: EngramChatMemory) {
        order.push('memory-close');
        return originalClose.call(this);
      });
    const supplied = await new EngramMemory().supplyData.call(context, 0);
    const memory = supplied.response as unknown as Pick<
      EngramChatMemory,
      'loadMemoryVariables' | 'chatHistory'
    >;
    expect(supplied.closeFunction).toBeDefined();
    expect(hooks.handlers.workflowExecuteAfter).toHaveLength(2);

    await expect(memory.loadMemoryVariables({ input: QUERY })).resolves.toHaveProperty(
      'chat_history',
    );
    await hooks.runHook('workflowExecuteAfter');
    await hooks.runHook('workflowExecuteAfter');

    expect(order).toEqual(['memory-close', 'host-after', 'host-after']);
    expect(closeMemory).toHaveBeenCalledTimes(1);
    await expect(memory.loadMemoryVariables({ input: QUERY })).rejects.toThrow(
      'Engram replay-safe memory: initialization_failed',
    );
    await expect(new EngramMemory().supplyData.call(context, 0)).rejects.toThrow(
      /initialization_failed/u,
    );
  });

  it('drains a pending step operation and seals its response on the next Agent supply', async () => {
    const { hooks, context } = await prepare();
    const first = await new EngramMemory().supplyData.call(context, 0);
    const firstMemory = first.response as unknown as Pick<
      EngramChatMemory,
      'loadMemoryVariables' | 'loadMemoryVariablesWithDiagnostics'
    >;
    const originalLoad = EngramChatMemory.prototype.loadMemoryVariablesWithDiagnostics;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let releaseOperation!: () => void;
    const hold = new Promise<void>((resolve) => {
      releaseOperation = resolve;
    });
    jest
      .spyOn(EngramChatMemory.prototype, 'loadMemoryVariablesWithDiagnostics')
      .mockImplementation(async function (this: EngramChatMemory, values) {
        const result = await originalLoad.call(this, values);
        markStarted();
        await hold;
        return result;
      });

    const pendingLoad = firstMemory.loadMemoryVariables({ input: QUERY });
    await started;
    let closeFinished = false;
    const stepClose = first.closeFunction!().then(() => {
      closeFinished = true;
    });
    await Promise.resolve();
    expect(closeFinished).toBe(false);

    releaseOperation();
    await expect(pendingLoad).resolves.toHaveProperty('chat_history');
    await stepClose;
    expect(closeFinished).toBe(true);
    await expect(firstMemory.loadMemoryVariables({ input: QUERY })).rejects.toThrow(
      'Engram replay-safe memory: initialization_failed',
    );

    const second = await new EngramMemory().supplyData.call(context, 0);
    const secondMemory = second.response as unknown as Pick<
      EngramChatMemory,
      'loadMemoryVariables'
    >;
    expect(secondMemory).not.toBe(firstMemory);
    await expect(secondMemory.loadMemoryVariables({ input: QUERY })).resolves.toHaveProperty(
      'chat_history',
    );
    await hooks.runHook('workflowExecuteAfter');
    await expect(secondMemory.loadMemoryVariables({ input: QUERY })).rejects.toThrow(
      'Engram replay-safe memory: initialization_failed',
    );
  });

  it('joins cancellation with terminal cleanup using one close operation', async () => {
    const fixture = await createSourceFixture();
    const runtime = makeHostLifecycleRuntime();
    process.argv[1] = runtime.mainPath;
    const hooks = new runtime.HostLifecycleHooks(fixture.native.execution, {
      id: fixture.native.workflow,
    });
    const controller = new AbortController();
    const context = createMemoryContext(fixture, hooks, controller.signal);
    observeCreatedOwner(fixture.file);
    const closeMemory = jest.spyOn(EngramChatMemory.prototype, 'closeNativeMemoryV4');
    const supplied = await new EngramMemory().supplyData.call(context, 0);
    const memory = supplied.response as unknown as Pick<EngramChatMemory, 'loadMemoryVariables'>;

    controller.abort();
    await hooks.runHook('workflowExecuteAfter');
    await hooks.runHook('workflowExecuteAfter');

    expect(closeMemory).toHaveBeenCalledTimes(1);
    await expect(memory.loadMemoryVariables({ input: QUERY })).rejects.toThrow(
      'Engram replay-safe memory: initialization_failed',
    );
  });

  it('rejects malformed present host hooks without opening or retaining a storage continuation', async () => {
    const fixture = await createSourceFixture();
    const runtime = makeHostLifecycleRuntime();
    process.argv[1] = runtime.mainPath;
    const forgedHooks = {
      executionId: fixture.native.execution,
      workflowData: { id: fixture.native.workflow },
      handlers: { workflowExecuteAfter: [] },
    } as unknown as LifecycleHooks;
    const context = createMemoryContext(fixture, forgedHooks, new AbortController().signal);
    observeCreatedOwner(fixture.file);

    await expect(new EngramMemory().supplyData.call(context, 0)).rejects.toThrow(
      /initialization_failed/u,
    );
    expect(createdOwners[createdOwners.length - 1]?.storage).toBeNull();
  });

  it('settles initialization when an own-method lookalike context supplies a valid hook instance', async () => {
    const fixture = await createSourceFixture();
    const runtime = makeHostLifecycleRuntime();
    process.argv[1] = runtime.mainPath;
    const hooks = new runtime.HostLifecycleHooks(fixture.native.execution, {
      id: fixture.native.workflow,
    });
    const prototypeContext = createMemoryContext(fixture, hooks, new AbortController().signal);
    const ownMethodContext = {
      ...prototypeContext,
      getExecutionId: () => fixture.native.execution,
      getWorkflow: () => ({ id: fixture.native.workflow }),
    } as MemoryContext;
    observeCreatedOwner(fixture.file);

    await expect(new EngramMemory().supplyData.call(ownMethodContext, 0)).rejects.toThrow(
      /initialization_failed/u,
    );
    expect(createdOwners[createdOwners.length - 1]?.storage).toBeNull();
    expect(hooks.handlers.workflowExecuteAfter).toHaveLength(0);
  });
});
