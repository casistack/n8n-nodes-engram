import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { registerNativeMemoryWorkflowFinalizerV4 } from '../../../src/utils/nativeMemoryWorkflowLifecycleV4';

type HostHooks = {
  readonly executionId: string;
  readonly workflowData: { readonly id: string };
  readonly handlers: {
    workflowExecuteAfter: Array<(...args: unknown[]) => Promise<void> | void>;
  };
  runHook(name: string, args?: unknown[]): Promise<void>;
};

type HostRuntimeFixture = {
  readonly directory: string;
  readonly mainPath: string;
  readonly coreManifestPath: string;
  readonly leafPath: string;
  readonly HostLifecycleHooks: new (
    executionId: string,
    workflowData: { readonly id: string },
  ) => HostHooks;
};

const hookClassSource = `
class ExecutionLifecycleHooks {
  constructor(executionId, workflowData) {
    this.mode = 'manual';
    this.executionId = executionId;
    this.workflowData = workflowData;
    this.handlers = { workflowExecuteAfter: [] };
  }
  addHandler(name, ...handlers) { this.handlers[name].push(...handlers); }
  async runHook(name, args = []) {
    const handlers = this.handlers[name];
    for (const handler of handlers) await handler.apply(this, args);
  }
}
module.exports = { ExecutionLifecycleHooks };
`;

function makeHostRuntime(
  n8nVersion = '2.12.3',
  coreVersion = '2.12.0',
  moduleSource = hookClassSource,
): HostRuntimeFixture {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-native-lifecycle-'));
  const n8nRoot = path.join(directory, 'node_modules', 'n8n');
  const coreRoot = path.join(n8nRoot, 'node_modules', 'n8n-core');
  const mainPath = path.join(n8nRoot, 'bin', 'n8n.js');
  const coreManifestPath = path.join(coreRoot, 'package.json');
  const leafPath = path.join(coreRoot, 'dist', 'execution-engine', 'execution-lifecycle-hooks.js');
  fs.mkdirSync(path.dirname(mainPath), { recursive: true });
  fs.mkdirSync(path.dirname(leafPath), { recursive: true });
  fs.writeFileSync(mainPath, '');
  fs.writeFileSync(
    path.join(n8nRoot, 'package.json'),
    JSON.stringify({ name: 'n8n', version: n8nVersion, bin: { n8n: './bin/n8n.js' } }),
  );
  fs.writeFileSync(
    coreManifestPath,
    JSON.stringify({ name: 'n8n-core', version: coreVersion, main: 'dist/index.js' }),
  );
  fs.writeFileSync(path.join(coreRoot, 'dist', 'index.js'), 'module.exports = {};');
  fs.writeFileSync(leafPath, moduleSource);
  const HostLifecycleHooks = createRequire(coreManifestPath)(leafPath)
    .ExecutionLifecycleHooks as HostRuntimeFixture['HostLifecycleHooks'];
  return { directory, mainPath, coreManifestPath, leafPath, HostLifecycleHooks };
}

function makeContext(hooks: unknown, identity = { executionId: 'exec-1', workflowId: 'wf-1' }) {
  class SupplyContext {
    readonly additionalData: { hooks?: unknown };

    constructor() {
      this.additionalData = hooks === undefined ? {} : { hooks };
    }

    getExecutionId(): string {
      return identity.executionId;
    }

    getWorkflow(): { id: string } {
      return { id: identity.workflowId };
    }
  }
  return new SupplyContext();
}

describe('native Memory workflow lifecycle bridge V4', () => {
  let fixture: HostRuntimeFixture | undefined;
  let priorArgv1: string | undefined;

  beforeEach(() => {
    priorArgv1 = process.argv[1];
  });

  afterEach(() => {
    if (priorArgv1 === undefined) delete process.argv[1];
    else process.argv[1] = priorArgv1;
    if (fixture) fs.rmSync(fixture.directory, { recursive: true, force: true });
    fixture = undefined;
    jest.restoreAllMocks();
  });

  function activate(runtime?: HostRuntimeFixture): HostHooks | undefined {
    fixture = runtime ?? makeHostRuntime();
    process.argv[1] = fixture.mainPath;
    return new fixture.HostLifecycleHooks('exec-1', { id: 'wf-1' });
  }

  it.each([
    ['n8n 2.12.3 with core 2.12.0', '2.12.3', '2.12.0'],
    ['n8n 2.44.6 with core 2.44.4', '2.44.6', '2.44.4'],
  ])('authenticates the exact qualified host pair: %s', (_label, n8nVersion, coreVersion) => {
    const hooks = activate(makeHostRuntime(n8nVersion, coreVersion));
    const record = {};
    const finalize = jest.fn(async () => undefined);

    const result = registerNativeMemoryWorkflowFinalizerV4(makeContext(hooks), record, finalize);

    expect(result).toBe('registered');
    expect(hooks!.handlers.workflowExecuteAfter).toHaveLength(1);
  });

  it('prepends once, awaits cleanup, and retains existing handler order across reentry', async () => {
    const hooks = activate();
    const events: string[] = [];
    hooks!.handlers.workflowExecuteAfter.push(
      async () => {
        events.push('existing-1');
      },
      async () => {
        events.push('existing-2');
      },
    );
    const record = {};
    const finalize = jest.fn(async () => {
      await Promise.resolve();
      events.push('cleanup');
    });
    const context = makeContext(hooks);

    expect(registerNativeMemoryWorkflowFinalizerV4(context, record, finalize)).toBe('registered');
    const handlerOrder = [...hooks!.handlers.workflowExecuteAfter.slice(1)];
    expect(registerNativeMemoryWorkflowFinalizerV4(context, record, finalize)).toBe('registered');
    expect(hooks!.handlers.workflowExecuteAfter).toHaveLength(3);
    expect(hooks!.handlers.workflowExecuteAfter.slice(1)).toEqual(handlerOrder);

    await hooks!.runHook('workflowExecuteAfter');
    await hooks!.runHook('workflowExecuteAfter');

    expect(events).toEqual(['cleanup', 'existing-1', 'existing-2', 'existing-1', 'existing-2']);
    expect(finalize).toHaveBeenCalledTimes(1);
  });

  it('contains cleanup failures with one fixed redacted log and still runs later handlers', async () => {
    const hooks = activate();
    const later = jest.fn();
    hooks!.handlers.workflowExecuteAfter.push(later);
    const record = {};
    const rawFailure = new Error('secret storage path must not appear');
    const finalize = jest.fn(async () => {
      throw rawFailure;
    });
    const log = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    registerNativeMemoryWorkflowFinalizerV4(makeContext(hooks), record, finalize);
    await hooks!.runHook('workflowExecuteAfter');
    await hooks!.runHook('workflowExecuteAfter');

    expect(finalize).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('Engram replay-safe memory: workflow cleanup failed');
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining('secret storage path'));
    expect(later).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['unsupported host version', makeHostRuntime('2.99.0', '2.99.0')],
    ['wrong core pair', makeHostRuntime('2.12.3', '2.12.1')],
  ])('uses the legacy fallback for an unavailable resolver: %s', (_label, runtime) => {
    const hooks = activate(runtime);
    const finalize = jest.fn(async () => undefined);

    expect(registerNativeMemoryWorkflowFinalizerV4(makeContext(hooks), {}, finalize)).toBe(
      'unavailable',
    );
    expect(hooks!.handlers.workflowExecuteAfter).toHaveLength(0);
    expect(finalize).not.toHaveBeenCalled();
  });

  it('uses the legacy fallback when the authenticated host has no hooks object', () => {
    activate();
    expect(
      registerNativeMemoryWorkflowFinalizerV4(makeContext(undefined), {}, async () => undefined),
    ).toBe('unavailable');
  });

  it('rejects present lookalike hooks and mismatched identity before installing cleanup', () => {
    const hooks = activate();
    const finalize = jest.fn(async () => undefined);
    const lookalike = {
      executionId: 'exec-1',
      workflowData: { id: 'wf-1' },
      handlers: { workflowExecuteAfter: [] },
      addHandler() {},
    };

    expect(() =>
      registerNativeMemoryWorkflowFinalizerV4(makeContext(lookalike), {}, finalize),
    ).toThrow('Engram replay-safe memory: initialization_failed');
    expect(() =>
      registerNativeMemoryWorkflowFinalizerV4(
        makeContext(hooks, { executionId: 'different-exec', workflowId: 'wf-1' }),
        {},
        finalize,
      ),
    ).toThrow('Engram replay-safe memory: initialization_failed');
    expect(hooks!.handlers.workflowExecuteAfter).toHaveLength(0);
    expect(finalize).not.toHaveBeenCalled();
  });

  it('rejects proxy hook arrays and accessors without evaluating them', () => {
    const hooks = activate();
    const finalize = jest.fn(async () => undefined);
    hooks!.handlers.workflowExecuteAfter = new Proxy(hooks!.handlers.workflowExecuteAfter, {});
    expect(() => registerNativeMemoryWorkflowFinalizerV4(makeContext(hooks), {}, finalize)).toThrow(
      'Engram replay-safe memory: initialization_failed',
    );

    const accessorHooks = new fixture!.HostLifecycleHooks('exec-1', { id: 'wf-1' });
    let accessorCalled = false;
    Object.defineProperty(accessorHooks, 'executionId', {
      configurable: true,
      get() {
        accessorCalled = true;
        return 'exec-1';
      },
    });
    expect(() =>
      registerNativeMemoryWorkflowFinalizerV4(makeContext(accessorHooks), {}, finalize),
    ).toThrow('Engram replay-safe memory: initialization_failed');
    expect(accessorCalled).toBe(false);
  });

  it('preflights every after-handler slot before unshifting', () => {
    const runtime = makeHostRuntime();
    fixture = runtime;
    process.argv[1] = runtime.mainPath;
    const finalize = jest.fn(async () => undefined);
    let accessorCalls = 0;
    const validFirst = () => undefined;
    const accessorArray = [validFirst, () => undefined];
    Object.defineProperty(accessorArray, '1', {
      configurable: true,
      enumerable: true,
      get() {
        accessorCalls += 1;
        return () => undefined;
      },
      set() {
        accessorCalls += 1;
      },
    });

    const sparseArray: Array<() => void> = [];
    sparseArray.length = 2;
    sparseArray[0] = validFirst;
    const nonWritableArray = [validFirst];
    Object.defineProperty(nonWritableArray, '0', {
      configurable: true,
      enumerable: true,
      value: validFirst,
      writable: false,
    });
    let proxyFunctionCalls = 0;
    const proxyFunction = new Proxy(validFirst, {
      apply(target, thisValue, argumentsList) {
        proxyFunctionCalls += 1;
        return Reflect.apply(target, thisValue, argumentsList);
      },
      getOwnPropertyDescriptor(target, key) {
        proxyFunctionCalls += 1;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    const proxyFunctionArray = [proxyFunction];

    for (const afterHandlers of [
      accessorArray,
      sparseArray,
      nonWritableArray,
      proxyFunctionArray,
    ]) {
      const hooks = new runtime.HostLifecycleHooks('exec-1', { id: 'wf-1' });
      hooks.handlers.workflowExecuteAfter = afterHandlers;
      const beforeLength = afterHandlers.length;
      const beforeFirst = Object.getOwnPropertyDescriptor(afterHandlers, '0')?.value;
      expect(() =>
        registerNativeMemoryWorkflowFinalizerV4(makeContext(hooks), {}, finalize),
      ).toThrow('Engram replay-safe memory: initialization_failed');
      expect(hooks.handlers.workflowExecuteAfter).toBe(afterHandlers);
      expect(afterHandlers.length).toBe(beforeLength);
      expect(Object.getOwnPropertyDescriptor(afterHandlers, '0')?.value).toBe(beforeFirst);
    }

    expect(accessorCalls).toBe(0);
    expect(proxyFunctionCalls).toBe(0);
    expect(finalize).not.toHaveBeenCalled();
  });

  it('rejects proxy prototypes before reflecting on them', () => {
    const hooks = activate();
    const finalize = jest.fn(async () => undefined);
    let prototypeTraps = 0;
    const hooksPrototype = Object.getPrototypeOf(hooks!);
    Object.setPrototypeOf(
      hooks!,
      new Proxy(hooksPrototype, {
        getOwnPropertyDescriptor(target, key) {
          prototypeTraps += 1;
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
        getPrototypeOf(target) {
          prototypeTraps += 1;
          return Reflect.getPrototypeOf(target);
        },
      }),
    );
    expect(() => registerNativeMemoryWorkflowFinalizerV4(makeContext(hooks), {}, finalize)).toThrow(
      'Engram replay-safe memory: initialization_failed',
    );
    expect(prototypeTraps).toBe(0);

    const validHooks = new fixture!.HostLifecycleHooks('exec-1', { id: 'wf-1' });
    const context = makeContext(validHooks);
    const contextPrototype = Object.getPrototypeOf(context);
    Object.setPrototypeOf(
      context,
      new Proxy(contextPrototype, {
        getOwnPropertyDescriptor(target, key) {
          prototypeTraps += 1;
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
        getPrototypeOf(target) {
          prototypeTraps += 1;
          return Reflect.getPrototypeOf(target);
        },
      }),
    );
    expect(() => registerNativeMemoryWorkflowFinalizerV4(context, {}, finalize)).toThrow(
      'Engram replay-safe memory: initialization_failed',
    );
    expect(prototypeTraps).toBe(0);
    expect(validHooks.handlers.workflowExecuteAfter).toHaveLength(0);
  });

  it('does not inspect a proxy constructor prototype before selecting the legacy fallback', () => {
    const globalState = globalThis as typeof globalThis & {
      __nativeLifecycleConstructorTraps?: number;
    };
    const proxyConstructorSource = `
      class ExecutionLifecycleHooks {}
      globalThis.__nativeLifecycleConstructorTraps = 0;
      module.exports = {
        ExecutionLifecycleHooks: new Proxy(ExecutionLifecycleHooks, {
          get(target, key, receiver) {
            globalThis.__nativeLifecycleConstructorTraps += 1;
            return Reflect.get(target, key, receiver);
          },
          getOwnPropertyDescriptor(target, key) {
            globalThis.__nativeLifecycleConstructorTraps += 1;
            return Reflect.getOwnPropertyDescriptor(target, key);
          },
        }),
      };
    `;
    const runtime = makeHostRuntime('2.12.3', '2.12.0', proxyConstructorSource);
    fixture = runtime;
    process.argv[1] = runtime.mainPath;

    expect(
      registerNativeMemoryWorkflowFinalizerV4(makeContext(undefined), {}, async () => undefined),
    ).toBe('unavailable');
    expect(globalState.__nativeLifecycleConstructorTraps).toBe(0);
    delete globalState.__nativeLifecycleConstructorTraps;
  });

  it('rejects reentry through a different authenticated hook instance', () => {
    const firstHooks = activate();
    const record = {};
    const finalize = jest.fn(async () => undefined);
    expect(registerNativeMemoryWorkflowFinalizerV4(makeContext(firstHooks), record, finalize)).toBe(
      'registered',
    );
    const secondHooks = new fixture!.HostLifecycleHooks('exec-1', { id: 'wf-1' });

    expect(() =>
      registerNativeMemoryWorkflowFinalizerV4(makeContext(secondHooks), record, finalize),
    ).toThrow('Engram replay-safe memory: initialization_failed');
    expect(firstHooks!.handlers.workflowExecuteAfter).toHaveLength(1);
    expect(secondHooks.handlers.workflowExecuteAfter).toHaveLength(0);
  });
});
