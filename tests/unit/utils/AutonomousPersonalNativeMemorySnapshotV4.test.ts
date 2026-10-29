import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { AutonomousPersonalNativeMemoryConfigContextV4 } from '../../../src/utils/AutonomousPersonalNativeMemoryConfigV4';
import {
  AutonomousPersonalNativeMemorySnapshotV4Error,
  createAutonomousPersonalNativeMemorySnapshotReaderV4,
} from '../../../src/utils/AutonomousPersonalNativeMemorySnapshotV4';
import { AutonomousPersonalAssistantNativeSnapshotV4OwnedDataSchema } from '../../../src/schemas/AutonomousPersonalAssistantFinalV4.schema';
import { canonicalAutomaticCaptureV2 } from '../../../src/schemas/AutomaticCapture.schema';
import {
  embeddedAutomaticCaptureStoreHash,
  neo4jAutomaticCaptureStoreHash,
} from '../../../src/storage/AutomaticCaptureStore';
import { resolveStoragePath } from '../../../src/utils/helpers';

const MEMORY_NODE = {
  id: 'snapshot-memory-node',
  type: 'n8n-nodes-engram.engramMemory',
  typeVersion: 3,
  parameters: { automaticCaptureLifecycle: 'replaySafeV2' },
  continueOnFail: false,
  onError: 'stopWorkflow',
};

type ContextOptions = {
  readonly backend?: unknown;
  readonly workflow?: unknown;
  readonly instance?: unknown;
  readonly execution?: unknown;
  readonly namespace?: string;
  readonly parameters?: Record<string, unknown>;
  readonly neoCredentials?: Record<string, unknown>;
  readonly extractionCredentials?: Record<string, unknown>;
  readonly onCredentials?: (name: string) => Promise<unknown> | unknown;
};

function makeContext(options: ContextOptions = {}) {
  const parameters: Record<string, unknown> = {
    sessionIdType: 'customKey',
    sessionKey: options.namespace ?? 'snapshot-native-namespace',
    backend: options.backend ?? 'embedded',
    customStoragePath: '',
    extractionExecution: 'synchronous',
    currentHumanQuery: 'I prefer concise explanations.',
    automaticMemoryProfile: 'conservative',
    automaticIssuer: 'issuer:snapshot',
    automaticActor: 'actor:snapshot-1',
    automaticTurn: 'turn:snapshot-1',
    automaticIntent: 'disabled',
    automaticRawHuman: '',
    automaticWrapper: 'disabled',
    automaticCapturedSource: '54df7873-e0f0-4bfb-95c8-9057e99e0254',
    advancedExtractionPolicy: 'bounded',
    knowledgeSelection: 'durableTemporal',
    extractionRequestLimit: 2,
    extractionDeadlineMs: 30_000,
    extractionRouteId: 'route:snapshot',
    extractionModel: 'model:snapshot',
    extractionTemperatureMode: 'legacy',
    ...options.parameters,
  };
  const node = { ...MEMORY_NODE };
  const getNode = jest.fn(() => node);
  const getNodeParameter = jest.fn((name: string, _index: number, fallback?: unknown) =>
    Object.prototype.hasOwnProperty.call(parameters, name) ? parameters[name] : fallback,
  );
  const getInputData = jest.fn(() => [
    { json: { sessionId: options.namespace ?? 'snapshot-native-namespace' } },
  ]);
  const getExecutionId = jest.fn(() => options.execution ?? 'snapshot-execution-1');
  const getWorkflow = jest.fn(() => ({ id: options.workflow ?? 'snapshot-workflow-1' }));
  const getInstanceId = jest.fn(() => options.instance ?? 'snapshot-instance-1');
  const getCredentials = jest.fn(async (name: string) => {
    if (options.onCredentials) return options.onCredentials(name);
    if (name === 'engramNeo4jApi') {
      return (
        options.neoCredentials ?? {
          uri: 'bolt+s://memory.example.invalid:7687',
          database: 'memory',
          username: 'neo4j',
          password: 'synthetic-neo-secret',
        }
      );
    }
    return (
      options.extractionCredentials ?? {
        apiKey: 'synthetic-extraction-secret',
        baseUrl: 'https://memory.invalid/v1',
      }
    );
  });
  const evaluateExpression = jest.fn(() => options.namespace ?? 'snapshot-native-namespace');
  const context = {
    getNode,
    getNodeParameter,
    getInputData,
    getExecutionId,
    getWorkflow,
    getInstanceId,
    getCredentials,
    evaluateExpression,
  } as unknown as AutonomousPersonalNativeMemoryConfigContextV4;

  return {
    context,
    parameters,
    getNode,
    getNodeParameter,
    getInputData,
    getExecutionId,
    getWorkflow,
    getInstanceId,
    getCredentials,
    evaluateExpression,
  };
}

function makeTemporaryDirectory(): string {
  return mkdtempSync(path.join(tmpdir(), 'engram-native-snapshot-'));
}

describe('createAutonomousPersonalNativeMemorySnapshotReaderV4', () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('captures strict frozen native DATA with the existing processing-attempt hash recipe', async () => {
    const directory = makeTemporaryDirectory();
    temporaryDirectories.push(directory);
    const workflow = 'snapshot-workflow-1';
    const persistPath = resolveStoragePath({ customStoragePath: directory, workflowId: workflow });
    const { context, parameters } = makeContext();
    parameters.customStoragePath = directory;
    const reader = createAutonomousPersonalNativeMemorySnapshotReaderV4(context, 0);

    const snapshot = await reader.read();

    expect(snapshot).toMatchObject({
      config: {
        version: 4,
        native: {
          instance: 'snapshot-instance-1',
          workflow,
          execution: 'snapshot-execution-1',
        },
        storeHash: embeddedAutomaticCaptureStoreHash(persistPath),
        namespace: 'snapshot-native-namespace',
        profileId: 'conservative',
        explicitIntent: false,
        currentHumanQuery: 'I prefer concise explanations.',
        sourceMapping: { mode: 'full_body' },
        quoteRegions: [],
        invocationDeadlineMs: 30_000,
      },
    });
    const expectedAttemptHash = createHash('sha256')
      .update(
        canonicalAutomaticCaptureV2({
          domain: 'engram-native-memory-attempt-v2',
          workflow,
          execution: 'snapshot-execution-1',
          node: MEMORY_NODE.id,
          action: 'saveFinalAssistant',
        }),
        'utf8',
      )
      .digest('hex');
    expect(snapshot.memoryAttemptHash).toBe(expectedAttemptHash);
    expect(
      AutonomousPersonalAssistantNativeSnapshotV4OwnedDataSchema.safeParse(snapshot).success,
    ).toBe(true);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.config)).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain('synthetic-extraction-secret');
    expect(JSON.stringify(snapshot)).not.toContain('synthetic-neo-secret');
    expect(snapshot).not.toHaveProperty('credentials');
    expect(snapshot).not.toHaveProperty('ctx');
    reader.close();
  });

  it('recomputes embedded workflow and path identity on every read', async () => {
    const firstDirectory = makeTemporaryDirectory();
    const secondDirectory = makeTemporaryDirectory();
    temporaryDirectories.push(firstDirectory, secondDirectory);
    const fixture = makeContext();
    const { context, parameters } = fixture;
    let currentWorkflow = 'snapshot-workflow-1';
    fixture.getWorkflow.mockImplementation(() => ({ id: currentWorkflow }));
    parameters.customStoragePath = firstDirectory;
    const reader = createAutonomousPersonalNativeMemorySnapshotReaderV4(context, 0);

    const first = await reader.read();
    parameters.customStoragePath = secondDirectory;
    const second = await reader.read();
    currentWorkflow = 'snapshot-workflow-2';
    const changedWorkflow = await reader.read();
    parameters.customStoragePath = '';
    const defaultPathRead = await reader.read();

    expect(first.config.storeHash).toBe(
      embeddedAutomaticCaptureStoreHash(
        resolveStoragePath({
          customStoragePath: firstDirectory,
          workflowId: 'snapshot-workflow-1',
        }),
      ),
    );
    expect(second.config.storeHash).toBe(
      embeddedAutomaticCaptureStoreHash(
        resolveStoragePath({
          customStoragePath: secondDirectory,
          workflowId: 'snapshot-workflow-1',
        }),
      ),
    );
    expect(second.config.storeHash).not.toBe(first.config.storeHash);
    expect(changedWorkflow.config.native.workflow).toBe('snapshot-workflow-2');
    expect(changedWorkflow.config.storeHash).toBe(
      embeddedAutomaticCaptureStoreHash(
        resolveStoragePath({
          customStoragePath: secondDirectory,
          workflowId: 'snapshot-workflow-2',
        }),
      ),
    );
    expect(defaultPathRead.config.storeHash).toBe(
      embeddedAutomaticCaptureStoreHash(
        resolveStoragePath({ customStoragePath: '', workflowId: 'snapshot-workflow-2' }),
      ),
    );
    reader.close();
  });

  it('uses the current backend selector rather than the backend from reader creation', async () => {
    const directory = makeTemporaryDirectory();
    temporaryDirectories.push(directory);
    const fixture = makeContext();
    fixture.parameters.customStoragePath = directory;
    const reader = createAutonomousPersonalNativeMemorySnapshotReaderV4(fixture.context, 0);

    const embedded = await reader.read();
    fixture.parameters.backend = 'neo4j';
    const neo4j = await reader.read();

    expect(embedded.config.storeHash).toBe(
      embeddedAutomaticCaptureStoreHash(
        resolveStoragePath({ customStoragePath: directory, workflowId: 'snapshot-workflow-1' }),
      ),
    );
    expect(neo4j.config.storeHash).toBe(
      neo4jAutomaticCaptureStoreHash('bolt+s://memory.example.invalid:7687', 'memory'),
    );
    expect(neo4j.config.storeHash).not.toBe(embedded.config.storeHash);
    reader.close();
  });

  it('recomputes Neo4j URI and database identity while allowing credential key rotation', async () => {
    const credentials = {
      uri: 'bolt+s://memory.example.invalid:7687',
      database: 'memory',
      username: 'neo4j',
      password: 'first-synthetic-password',
    };
    const extractionCredentials = {
      apiKey: 'first-synthetic-extraction-key',
      baseUrl: 'https://memory.invalid/v1',
    };
    const { context } = makeContext({
      backend: 'neo4j',
      neoCredentials: credentials,
      extractionCredentials,
    });
    const reader = createAutonomousPersonalNativeMemorySnapshotReaderV4(context, 0);

    const first = await reader.read();
    credentials.username = 'rotated-user';
    credentials.password = 'rotated-synthetic-password';
    const rotatedCredentials = await reader.read();
    extractionCredentials.apiKey = 'rotated-synthetic-extraction-key';
    const rotatedExtractionKey = await reader.read();
    credentials.database = 'memory-two';
    const changedDatabase = await reader.read();
    credentials.uri = 'bolt+s://other.example.invalid:7687';
    const changedUri = await reader.read();

    expect(first.config.storeHash).toBe(
      neo4jAutomaticCaptureStoreHash('bolt+s://memory.example.invalid:7687', 'memory'),
    );
    expect(rotatedCredentials.config.storeHash).toBe(first.config.storeHash);
    expect(rotatedExtractionKey.config.storeHash).toBe(first.config.storeHash);
    expect(rotatedExtractionKey.config.providerReference).toEqual(first.config.providerReference);
    expect(changedDatabase.config.storeHash).toBe(
      neo4jAutomaticCaptureStoreHash('bolt+s://memory.example.invalid:7687', 'memory-two'),
    );
    expect(changedUri.config.storeHash).toBe(
      neo4jAutomaticCaptureStoreHash('bolt+s://other.example.invalid:7687', 'memory-two'),
    );
    expect(changedUri.config.storeHash).not.toBe(changedDatabase.config.storeHash);
    expect(JSON.stringify(changedUri)).not.toContain('rotated-synthetic-password');
    expect(JSON.stringify(changedUri)).not.toContain('rotated-synthetic-extraction-key');
    reader.close();
  });

  it('rejects a store identity change that occurs while config credentials are awaited', async () => {
    const directory = makeTemporaryDirectory();
    const replacementDirectory = makeTemporaryDirectory();
    temporaryDirectories.push(directory, replacementDirectory);
    const state: { parameters?: Record<string, unknown> } = {};
    const fixture = makeContext({
      onCredentials: async (name) => {
        if (name === 'engramExtractionApi') {
          if (!state.parameters) throw new Error('fixture not initialized');
          state.parameters.customStoragePath = replacementDirectory;
          return { apiKey: 'temporary-secret', baseUrl: 'https://memory.invalid/v1' };
        }
        return undefined;
      },
    });
    state.parameters = fixture.parameters;
    fixture.parameters.customStoragePath = directory;
    const reader = createAutonomousPersonalNativeMemorySnapshotReaderV4(fixture.context, 0);

    await expect(reader.read()).rejects.toMatchObject({
      name: 'AutonomousPersonalNativeMemorySnapshotV4Error',
      reason: 'unsupported_configuration',
    });
    reader.close();
  });

  it('rejects a Neo4j route change during config loading without exposing credential values', async () => {
    const credentials = {
      uri: 'bolt+s://memory.example.invalid:7687',
      database: 'memory',
      username: 'neo4j',
      password: 'first-synthetic-password',
    };
    const fixture = makeContext({
      backend: 'neo4j',
      neoCredentials: credentials,
      onCredentials: async (name) => {
        if (name === 'engramNeo4jApi') return credentials;
        if (name === 'engramExtractionApi') {
          credentials.uri = 'bolt+s://changed.example.invalid:7687';
          return { apiKey: 'extraction-secret', baseUrl: 'https://memory.invalid/v1' };
        }
        return undefined;
      },
    });
    const reader = createAutonomousPersonalNativeMemorySnapshotReaderV4(fixture.context, 0);

    let observed: unknown;
    try {
      await reader.read();
    } catch (error) {
      observed = error;
    }
    expect(observed).toMatchObject({ reason: 'unsupported_configuration' });
    expect((observed as Error).message).not.toContain('changed.example.invalid');
    expect((observed as Error).message).not.toContain('first-synthetic-password');
    reader.close();
  });

  it.each([
    ['unknown backend', { backend: 'mysql' }],
    [
      'wrong credential field type',
      { backend: 'neo4j', neoCredentials: { uri: 7, username: 'u', password: 'p' } },
    ],
    [
      'missing credential fields',
      { backend: 'neo4j', neoCredentials: { uri: 'bolt://localhost:7687', username: 'u' } },
    ],
  ])('rejects %s as a fixed bounded failure', async (_name, options) => {
    const fixture = makeContext(options);
    const reader = createAutonomousPersonalNativeMemorySnapshotReaderV4(fixture.context, 0);

    await expect(reader.read()).rejects.toBeInstanceOf(
      AutonomousPersonalNativeMemorySnapshotV4Error,
    );
    try {
      await reader.read();
    } catch (error) {
      expect((error as Error).message).not.toContain('synthetic');
      expect((error as Error).message.length).toBeLessThan(100);
    }
    reader.close();
  });

  it('rejects a nonzero item index before retaining host methods', () => {
    const fixture = makeContext();
    expect(() => createAutonomousPersonalNativeMemorySnapshotReaderV4(fixture.context, 1)).toThrow(
      AutonomousPersonalNativeMemorySnapshotV4Error,
    );
    expect(fixture.getNode).not.toHaveBeenCalled();
    expect(fixture.getNodeParameter).not.toHaveBeenCalled();
  });

  it('close drops bound methods and prevents both pending and later reads from calling the host', async () => {
    let releaseCredentials: ((value: unknown) => void) | undefined;
    const credentialWait = new Promise<unknown>((resolve) => {
      releaseCredentials = resolve;
    });
    const fixture = makeContext({ onCredentials: () => credentialWait });
    const reader = createAutonomousPersonalNativeMemorySnapshotReaderV4(fixture.context, 0);
    const pending = reader.read();
    await Promise.resolve();
    await Promise.resolve();
    expect(fixture.getCredentials).toHaveBeenCalledWith('engramExtractionApi');

    reader.close();
    const callCountsAtClose = [
      fixture.getNode.mock.calls.length,
      fixture.getNodeParameter.mock.calls.length,
      fixture.getInputData.mock.calls.length,
      fixture.getExecutionId.mock.calls.length,
      fixture.getWorkflow.mock.calls.length,
      fixture.getInstanceId.mock.calls.length,
      fixture.getCredentials.mock.calls.length,
      fixture.evaluateExpression.mock.calls.length,
    ];
    releaseCredentials?.({ apiKey: 'close-test-secret', baseUrl: 'https://memory.invalid/v1' });
    await expect(pending).rejects.toBeInstanceOf(AutonomousPersonalNativeMemorySnapshotV4Error);
    await expect(reader.read()).rejects.toBeInstanceOf(
      AutonomousPersonalNativeMemorySnapshotV4Error,
    );
    expect([
      fixture.getNode.mock.calls.length,
      fixture.getNodeParameter.mock.calls.length,
      fixture.getInputData.mock.calls.length,
      fixture.getExecutionId.mock.calls.length,
      fixture.getWorkflow.mock.calls.length,
      fixture.getInstanceId.mock.calls.length,
      fixture.getCredentials.mock.calls.length,
      fixture.evaluateExpression.mock.calls.length,
    ]).toEqual(callCountsAtClose);
    reader.close();
  });
});
