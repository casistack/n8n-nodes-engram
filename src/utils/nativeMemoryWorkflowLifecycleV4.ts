import { createRequire } from 'node:module';
import { types as utilTypes } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

type HostLifecycleBindingV4 = {
  readonly hooks: WeakRef<object>;
  readonly executionId: string;
  readonly workflowId: string;
  readonly finalize: (record: object) => Promise<void>;
  closePromise?: Promise<void>;
  reportedFailure: boolean;
};

type HostLifecycleProfileV4 = {
  readonly n8nVersion: string;
  readonly coreVersion: string;
  readonly hooksPrototype: object;
};

const HOST_CORE_VERSIONS_V4: Readonly<Record<string, string>> = Object.freeze({
  '2.12.3': '2.12.0',
  '2.44.6': '2.44.4',
});

const registeredFinalizersV4 = new WeakMap<object, HostLifecycleBindingV4>();
const resolvedProfilesV4 = new Map<string, HostLifecycleProfileV4 | null>();
const capturedUnshiftV4 = Array.prototype.unshift;
const capturedApplyV4 = Reflect.apply;

export type NativeMemoryWorkflowFinalizerRegistrationV4 = 'registered' | 'unavailable';

function readJsonFileV4(filePath: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function packageRootFromEntryV4(entryPath: string, packageName: string): string | undefined {
  let directory: string;
  try {
    directory = path.dirname(fs.realpathSync(entryPath));
  } catch {
    return undefined;
  }
  while (directory !== path.dirname(directory)) {
    const manifestPath = path.join(directory, 'package.json');
    const manifest = readJsonFileV4(manifestPath);
    if (manifest?.name === packageName) return directory;
    directory = path.dirname(directory);
  }
  return readJsonFileV4(path.join(directory, 'package.json'))?.name === packageName
    ? directory
    : undefined;
}

function isDeclaredN8nMainV4(
  mainPath: string,
  n8nRoot: string,
  manifest: Record<string, unknown>,
): boolean {
  const declaredEntries: string[] = [];
  if (typeof manifest.main === 'string') declaredEntries.push(manifest.main);
  const bin = manifest.bin;
  if (typeof bin === 'string') declaredEntries.push(bin);
  else if (bin && typeof bin === 'object' && !Array.isArray(bin)) {
    for (const value of Object.values(bin))
      if (typeof value === 'string') declaredEntries.push(value);
  }
  for (const entry of declaredEntries) {
    try {
      if (fs.realpathSync(path.resolve(n8nRoot, entry)) === mainPath) return true;
    } catch {
      // A missing optional declared entry is not the active CLI/main path.
    }
  }
  return false;
}

function resolveHostLifecycleProfileV4(mainPathValue: unknown): HostLifecycleProfileV4 | null {
  if (typeof mainPathValue !== 'string' || mainPathValue.length === 0) return null;
  let mainPath: string;
  try {
    mainPath = fs.realpathSync(mainPathValue);
  } catch {
    return null;
  }
  const cached = resolvedProfilesV4.get(mainPath);
  if (cached !== undefined) return cached;

  const n8nRoot = packageRootFromEntryV4(mainPath, 'n8n');
  if (!n8nRoot) {
    resolvedProfilesV4.set(mainPath, null);
    return null;
  }
  const n8nManifestPath = path.join(n8nRoot, 'package.json');
  const n8nManifest = readJsonFileV4(n8nManifestPath);
  const n8nVersion = n8nManifest?.version;
  if (!n8nManifest || !isDeclaredN8nMainV4(mainPath, n8nRoot, n8nManifest)) {
    resolvedProfilesV4.set(mainPath, null);
    return null;
  }
  if (typeof n8nVersion !== 'string') {
    resolvedProfilesV4.set(mainPath, null);
    return null;
  }
  const expectedCoreVersion = HOST_CORE_VERSIONS_V4[n8nVersion];
  if (!expectedCoreVersion) {
    resolvedProfilesV4.set(mainPath, null);
    return null;
  }

  let coreRoot: string | undefined;
  try {
    const requireFromN8n = createRequire(n8nManifestPath);
    const coreEntry = requireFromN8n.resolve('n8n-core');
    coreRoot = packageRootFromEntryV4(coreEntry, 'n8n-core');
  } catch {
    coreRoot = undefined;
  }
  if (!coreRoot) {
    resolvedProfilesV4.set(mainPath, null);
    return null;
  }

  const coreManifestPath = path.join(coreRoot, 'package.json');
  const coreManifest = readJsonFileV4(coreManifestPath);
  const coreVersion = coreManifest?.version;
  if (coreManifest?.name !== 'n8n-core' || coreVersion !== expectedCoreVersion) {
    resolvedProfilesV4.set(mainPath, null);
    return null;
  }

  const leafPath = path.join(coreRoot, 'dist', 'execution-engine', 'execution-lifecycle-hooks.js');
  let actualLeafPath: string;
  try {
    actualLeafPath = fs.realpathSync(leafPath);
    if (!fs.statSync(actualLeafPath).isFile()) throw new Error('invalid lifecycle module');
  } catch {
    resolvedProfilesV4.set(mainPath, null);
    return null;
  }
  const relativeLeafPath = path.relative(coreRoot, actualLeafPath);
  if (relativeLeafPath.startsWith('..') || path.isAbsolute(relativeLeafPath)) {
    resolvedProfilesV4.set(mainPath, null);
    return null;
  }

  let moduleExports: unknown;
  try {
    moduleExports = createRequire(coreManifestPath)(actualLeafPath);
  } catch {
    resolvedProfilesV4.set(mainPath, null);
    return null;
  }
  if (!moduleExports || typeof moduleExports !== 'object' || utilTypes.isProxy(moduleExports)) {
    resolvedProfilesV4.set(mainPath, null);
    return null;
  }
  const constructorDescriptor = Object.getOwnPropertyDescriptor(
    moduleExports,
    'ExecutionLifecycleHooks',
  );
  const hooksConstructor = constructorDescriptor?.value;
  if (
    !constructorDescriptor ||
    !('value' in constructorDescriptor) ||
    typeof hooksConstructor !== 'function' ||
    utilTypes.isProxy(hooksConstructor)
  ) {
    resolvedProfilesV4.set(mainPath, null);
    return null;
  }

  const prototypeDescriptor = ownDescriptorV4(hooksConstructor, 'prototype');
  const hooksPrototype = prototypeDescriptor?.value;
  if (
    !prototypeDescriptor ||
    !('value' in prototypeDescriptor) ||
    !hooksPrototype ||
    typeof hooksPrototype !== 'object' ||
    utilTypes.isProxy(hooksPrototype)
  ) {
    resolvedProfilesV4.set(mainPath, null);
    return null;
  }

  const addHandlerDescriptor = ownDescriptorV4(hooksPrototype, 'addHandler');
  if (
    !addHandlerDescriptor ||
    !('value' in addHandlerDescriptor) ||
    typeof addHandlerDescriptor.value !== 'function'
  ) {
    resolvedProfilesV4.set(mainPath, null);
    return null;
  }

  const profile: HostLifecycleProfileV4 = Object.freeze({
    n8nVersion,
    coreVersion,
    hooksPrototype,
  });
  resolvedProfilesV4.set(mainPath, profile);
  return profile;
}

function ownDescriptorV4(value: object, key: string): PropertyDescriptor | undefined {
  try {
    return Object.getOwnPropertyDescriptor(value, key);
  } catch {
    return undefined;
  }
}

function getPrototypeMethodV4(
  value: object,
  key: string,
): ((...args: unknown[]) => unknown) | null {
  if (utilTypes.isProxy(value)) return null;
  let current: object | null;
  try {
    current = Object.getPrototypeOf(value) as object | null;
  } catch {
    return null;
  }
  while (current && current !== Object.prototype) {
    if (utilTypes.isProxy(current)) return null;
    const descriptor = ownDescriptorV4(current, key);
    if (descriptor) {
      return 'value' in descriptor && typeof descriptor.value === 'function'
        ? (descriptor.value as (...args: unknown[]) => unknown)
        : null;
    }
    try {
      current = Object.getPrototypeOf(current) as object | null;
    } catch {
      return null;
    }
  }
  return null;
}

function invalidLifecycleErrorV4(): Error {
  return new Error('Engram replay-safe memory: initialization_failed');
}

function reportCleanupFailureV4(): void {
  try {
    console.error('Engram replay-safe memory: workflow cleanup failed');
  } catch {
    // Cleanup reporting must not escape the host's workflow hook chain.
  }
}

function getOrStartClosePromiseV4(binding: HostLifecycleBindingV4, record: object): Promise<void> {
  if (!binding.closePromise) {
    try {
      binding.closePromise = Promise.resolve(binding.finalize(record));
    } catch {
      binding.closePromise = Promise.reject(invalidLifecycleErrorV4());
    }
    void binding.closePromise.catch(() => undefined);
  }
  return binding.closePromise;
}

function validateAndReadContextV4(
  contextValue: unknown,
  expectedHooksPrototype: object,
): { hooks: object; executionId: string; workflowId: string } | null {
  if (!contextValue || typeof contextValue !== 'object' || utilTypes.isProxy(contextValue))
    throw invalidLifecycleErrorV4();

  const context = contextValue as object;
  const additionalDataDescriptor = ownDescriptorV4(context, 'additionalData');
  if (!additionalDataDescriptor) return null;
  if (!('value' in additionalDataDescriptor)) throw invalidLifecycleErrorV4();
  const additionalData = additionalDataDescriptor.value;
  if (!additionalData || typeof additionalData !== 'object' || utilTypes.isProxy(additionalData))
    throw invalidLifecycleErrorV4();
  const hooksDescriptor = ownDescriptorV4(additionalData, 'hooks');
  if (!hooksDescriptor) return null;
  if (!('value' in hooksDescriptor)) throw invalidLifecycleErrorV4();
  const hooksValue = hooksDescriptor.value;
  if (hooksValue === undefined) return null;
  if (!hooksValue || typeof hooksValue !== 'object' || utilTypes.isProxy(hooksValue))
    throw invalidLifecycleErrorV4();
  const hooks = hooksValue as object;

  let hooksInstancePrototype: object | null;
  try {
    hooksInstancePrototype = Object.getPrototypeOf(hooks) as object | null;
  } catch {
    throw invalidLifecycleErrorV4();
  }
  if (
    !hooksInstancePrototype ||
    utilTypes.isProxy(hooksInstancePrototype) ||
    hooksInstancePrototype !== expectedHooksPrototype
  )
    throw invalidLifecycleErrorV4();

  const executionIdDescriptor = ownDescriptorV4(hooks, 'executionId');
  const workflowDataDescriptor = ownDescriptorV4(hooks, 'workflowData');
  const handlersDescriptor = ownDescriptorV4(hooks, 'handlers');
  if (
    !executionIdDescriptor ||
    !('value' in executionIdDescriptor) ||
    typeof executionIdDescriptor.value !== 'string' ||
    !workflowDataDescriptor ||
    !('value' in workflowDataDescriptor) ||
    !workflowDataDescriptor.value ||
    typeof workflowDataDescriptor.value !== 'object' ||
    utilTypes.isProxy(workflowDataDescriptor.value) ||
    !handlersDescriptor ||
    !('value' in handlersDescriptor) ||
    !handlersDescriptor.value ||
    typeof handlersDescriptor.value !== 'object' ||
    utilTypes.isProxy(handlersDescriptor.value)
  )
    throw invalidLifecycleErrorV4();
  const workflowIdDescriptor = ownDescriptorV4(workflowDataDescriptor.value, 'id');
  if (
    !workflowIdDescriptor ||
    !('value' in workflowIdDescriptor) ||
    typeof workflowIdDescriptor.value !== 'string'
  )
    throw invalidLifecycleErrorV4();

  const handlers = handlersDescriptor.value as object;
  const afterDescriptor = ownDescriptorV4(handlers, 'workflowExecuteAfter');
  if (!afterDescriptor) return null;
  if (!('value' in afterDescriptor)) throw invalidLifecycleErrorV4();
  const afterHandlers = afterDescriptor.value;
  if (
    !Array.isArray(afterHandlers) ||
    utilTypes.isProxy(afterHandlers) ||
    Object.getPrototypeOf(afterHandlers) !== Array.prototype ||
    !Object.isExtensible(afterHandlers)
  )
    throw invalidLifecycleErrorV4();
  const lengthDescriptor = ownDescriptorV4(afterHandlers, 'length');
  if (
    !lengthDescriptor ||
    !('value' in lengthDescriptor) ||
    lengthDescriptor.writable !== true ||
    typeof lengthDescriptor.value !== 'number' ||
    !Number.isSafeInteger(lengthDescriptor.value)
  )
    throw invalidLifecycleErrorV4();
  let ownNames: string[];
  try {
    ownNames = Object.getOwnPropertyNames(afterHandlers);
  } catch {
    throw invalidLifecycleErrorV4();
  }
  const handlerCount = lengthDescriptor.value;
  if (ownNames.length !== handlerCount + 1) throw invalidLifecycleErrorV4();
  for (let index = 0; index < handlerCount; index += 1) {
    const descriptor = ownDescriptorV4(afterHandlers, String(index));
    if (
      !descriptor ||
      !('value' in descriptor) ||
      typeof descriptor.value !== 'function' ||
      utilTypes.isProxy(descriptor.value) ||
      descriptor.writable !== true ||
      descriptor.configurable !== true ||
      descriptor.enumerable !== true
    )
      throw invalidLifecycleErrorV4();
  }

  const addHandler = getPrototypeMethodV4(hooks, 'addHandler');
  const expectedAddHandler = ownDescriptorV4(expectedHooksPrototype, 'addHandler')?.value;
  if (!addHandler || addHandler !== expectedAddHandler) throw invalidLifecycleErrorV4();

  const getExecutionId = getPrototypeMethodV4(context, 'getExecutionId');
  const getWorkflow = getPrototypeMethodV4(context, 'getWorkflow');
  if (!getExecutionId || !getWorkflow) throw invalidLifecycleErrorV4();
  let contextExecutionId: unknown;
  let contextWorkflow: unknown;
  try {
    contextExecutionId = capturedApplyV4(getExecutionId, context, []);
    contextWorkflow = capturedApplyV4(getWorkflow, context, []);
  } catch {
    throw invalidLifecycleErrorV4();
  }
  if (!contextWorkflow || typeof contextWorkflow !== 'object' || utilTypes.isProxy(contextWorkflow))
    throw invalidLifecycleErrorV4();
  const contextWorkflowIdDescriptor = ownDescriptorV4(contextWorkflow, 'id');
  if (
    !contextWorkflowIdDescriptor ||
    !('value' in contextWorkflowIdDescriptor) ||
    typeof contextWorkflowIdDescriptor.value !== 'string' ||
    contextExecutionId !== executionIdDescriptor.value ||
    contextWorkflowIdDescriptor.value !== workflowIdDescriptor.value
  )
    throw invalidLifecycleErrorV4();

  return {
    hooks,
    executionId: executionIdDescriptor.value,
    workflowId: workflowIdDescriptor.value,
  };
}

export function registerNativeMemoryWorkflowFinalizerV4<T extends object>(
  context: unknown,
  record: T,
  finalize: (record: T) => Promise<void>,
): NativeMemoryWorkflowFinalizerRegistrationV4 {
  const profile = resolveHostLifecycleProfileV4(process.argv[1]);
  if (!profile) return 'unavailable';

  const contextBinding = validateAndReadContextV4(context, profile.hooksPrototype);
  if (!contextBinding) return 'unavailable';

  const existing = registeredFinalizersV4.get(record);
  if (existing) {
    if (
      existing.hooks.deref() !== contextBinding.hooks ||
      existing.executionId !== contextBinding.executionId ||
      existing.workflowId !== contextBinding.workflowId
    )
      throw invalidLifecycleErrorV4();
    return 'registered';
  }

  const handlerArray = ownDescriptorV4(
    ownDescriptorV4(contextBinding.hooks, 'handlers')?.value as object,
    'workflowExecuteAfter',
  )?.value as unknown[];
  const recordReference = new WeakRef(record);
  const binding: HostLifecycleBindingV4 = {
    hooks: new WeakRef(contextBinding.hooks),
    executionId: contextBinding.executionId,
    workflowId: contextBinding.workflowId,
    finalize: finalize as (record: object) => Promise<void>,
    reportedFailure: false,
  };

  const workflowCleanup = async (): Promise<void> => {
    const current = recordReference.deref();
    if (!current) return;
    const closePromise = getOrStartClosePromiseV4(binding, current);
    try {
      await closePromise;
    } catch {
      if (!binding.reportedFailure) {
        binding.reportedFailure = true;
        reportCleanupFailureV4();
      }
    }
  };

  try {
    registeredFinalizersV4.set(record, binding);
    capturedApplyV4(capturedUnshiftV4, handlerArray, [workflowCleanup]);
  } catch {
    registeredFinalizersV4.delete(record);
    throw invalidLifecycleErrorV4();
  }
  return 'registered';
}
