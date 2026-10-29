import * as fs from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GraphologyStorage } from '../../src/storage/GraphologyStorage';
import { ExtractionDiagnostics } from '../../src/extraction/ExtractionDiagnostics';
import { graphFingerprint, sourceFingerprint } from '../../src/extraction/QueueState';
import { reviewExtractionMetadata } from '../../src/schemas/ExtractionMetadata.schema';
import { StagedExtractionSchema } from '../../src/schemas/ExtractionQueue.schema';
import { assertAutonomousPersonalRecordIntegrityV4 } from '../../src/storage/AutonomousPersonalRecordIntegrityV4';
import {
  closeAutonomousPersonalCompletionV4,
  dispatchNativeAutonomousPersonalCaptureV4,
  prepareNativeAutonomousPersonalCompletionV4,
} from '../../src/storage/AutonomousPersonalCaptureHandlesV4';
import { AutonomousPersonalCompletionStorageV4ResultOwnedDataSchema } from '../../src/schemas/AutonomousPersonalCompletionStorageV4.schema';
import {
  nativeAutonomousPersonalCaptureContext,
  seedAutonomousPersonalCaptureSubject,
  type AutonomousPersonalCaptureSeed,
} from '../helpers/autonomousPersonalCaptureBackend';

describe('Graphology native autonomous personal completion V4', () => {
  let directory: string;
  let file: string;
  let store: GraphologyStorage;
  let seed: AutonomousPersonalCaptureSeed;
  let handles: unknown[];

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'engram-completion-embedded-'));
    file = join(directory, 'store.json');
    store = new GraphologyStorage(file);
    handles = [];
    await store.initialize();
    seed = await seedAutonomousPersonalCaptureSubject(store);
  });

  afterEach(async () => {
    for (const handle of handles) closeAutonomousPersonalCompletionV4(store, handle);
    jest.restoreAllMocks();
    await store?.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const context = (
    turn: string,
    options: { content?: string; intent?: 'enabled' | 'disabled' } = {},
  ) =>
    nativeAutonomousPersonalCaptureContext(seed, {
      ...(options.content === undefined ? {} : { content: options.content }),
      extraParameters: {
        automaticMemoryProfile: 'explicit',
        automaticIntent: options.intent ?? 'disabled',
        automaticTurn: turn,
      },
    });

  const prepare = async (
    turn = 'embedded-completion-turn',
    intent: 'enabled' | 'disabled' = 'disabled',
  ) => {
    const result = await prepareNativeAutonomousPersonalCompletionV4(
      context(turn, { intent }),
      store,
    );
    if (result.kind !== 'completion_prepared') {
      throw new Error(
        `Expected a completion handle; received ${result.kind}; operation=${store.getLastMutationDiagnostics()?.operation}`,
      );
    }
    handles.push(result.handle);
    return result.handle;
  };

  const installSuccessfulProviderResponse = () => {
    const originalFetch = globalThis.fetch;
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as {
        messages: Array<{ role: string; content: string }>;
      };
      const user = JSON.parse(request.messages[1]!.content) as {
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
    return () => {
      jest.restoreAllMocks();
      globalThis.fetch = originalFetch;
    };
  };

  it('returns only a matched observation and commits a coherent source-only terminal operation', async () => {
    const handle = await prepare();
    const result = await store.completeAutonomousPersonalCaptureV4!(handle);

    expect(AutonomousPersonalCompletionStorageV4ResultOwnedDataSchema.parse(result)).toEqual({
      kind: 'matched',
    });
    expect(result).not.toHaveProperty('eligibleFirstCommit');
    expect(result).not.toHaveProperty('receipt');
    const graph = await store.exportGraph();
    const committed = graph.automatic_operations_v1?.operations.find(
      (operation) => operation.state === 'committed',
    );
    expect(committed?.version).toBe(4);
    expect(committed?.state).toBe('committed');
    expect(graph.episodes).toHaveLength(1);

    closeAutonomousPersonalCompletionV4(store, handle);
    handles = [];
    await store.close();
    store = new GraphologyStorage(file);
    await store.initialize();
    expect(
      (await store.exportGraph()).automatic_operations_v1?.operations.some(
        (operation) => operation.version === 4 && operation.state === 'committed',
      ),
    ).toBe(true);
  });

  it('binds the handle to its owner and consumes it once before storage I/O', async () => {
    const handle = await prepare();
    const other = new GraphologyStorage();
    await other.initialize();
    try {
      expect(await other.completeAutonomousPersonalCaptureV4!(handle)).toEqual({
        kind: 'no_write',
        reason: 'invalid_input',
      });
      const result = await store.completeAutonomousPersonalCaptureV4!(handle);
      expect(result.kind).toBe('matched');
      expect(await store.completeAutonomousPersonalCaptureV4!(handle)).toEqual({
        kind: 'no_write',
        reason: 'invalid_input',
      });
    } finally {
      await other.close();
    }
  });

  it('keeps later mutations queued when a middle entry check fails', async () => {
    const queueStore = new GraphologyStorage();
    await queueStore.initialize();
    const internal = queueStore as unknown as {
      runMutation: (
        mutation: () => unknown | Promise<unknown>,
        options?: { captureRead?: { scope: object; check: () => void } },
      ) => Promise<unknown>;
    };
    const events: string[] = [];
    let firstStarted!: () => void;
    const firstStartedPromise = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    try {
      const first = internal.runMutation(async () => {
        events.push('first:start');
        firstStarted();
        await firstGate;
        events.push('first:end');
      });
      await firstStartedPromise;

      await expect(
        internal.runMutation(
          () => {
            events.push('second:ran');
          },
          {
            captureRead: {
              scope: {},
              check: () => {
                throw new Error('entry_check_failed');
              },
            },
          },
        ),
      ).rejects.toThrow('entry_check_failed');

      const third = internal.runMutation(() => {
        events.push('third:start');
      });
      await Promise.resolve();
      expect(events).toEqual(['first:start']);

      releaseFirst();
      await Promise.all([first, third]);
      expect(events).toEqual(['first:start', 'first:end', 'third:start']);
    } finally {
      releaseFirst();
      await queueStore.close();
    }
  });

  it('rolls back before rename when completion work aborts during temp snapshot sync', async () => {
    const hostController = new AbortController();
    const restoreFetch = installSuccessfulProviderResponse();
    let handle: unknown;
    try {
      const hostSignalContext = Object.assign(
        context('embedded-completion-abort-before-replace', { intent: 'enabled' }),
        { getExecutionCancelSignal: () => hostController.signal },
      );
      const prepared = await prepareNativeAutonomousPersonalCompletionV4(hostSignalContext, store);
      if (prepared.kind !== 'completion_prepared') {
        throw new Error(`Expected a completion handle; received ${prepared.kind}`);
      }
      handle = prepared.handle;
      handles.push(handle);
    } finally {
      restoreFetch();
    }

    const before = fs.readFileSync(file);
    const beforeSnapshot = JSON.parse(before.toString('utf8')) as {
      entities: unknown[];
      edges: unknown[];
      episodes: unknown[];
      automatic_operations_v1?: unknown;
    };
    const originalOpen = fs.promises.open.bind(fs.promises);
    let tempSnapshotSynced = false;
    const open = jest.spyOn(fs.promises, 'open').mockImplementation(async (target, flags, mode) => {
      const fileHandle = await originalOpen(target, flags, mode);
      if (
        flags !== 'w' ||
        !String(target).startsWith(`${file}.`) ||
        !String(target).endsWith('.tmp')
      ) {
        return fileHandle;
      }
      return new Proxy(fileHandle, {
        get(targetHandle, property, receiver) {
          if (property === 'sync') {
            return async () => {
              await targetHandle.sync();
              tempSnapshotSynced = true;
              hostController.abort();
            };
          }
          const value = Reflect.get(targetHandle, property, receiver) as unknown;
          return typeof value === 'function' ? value.bind(targetHandle) : value;
        },
      });
    });
    const originalRename = fs.promises.rename.bind(fs.promises);
    const rename = jest.spyOn(fs.promises, 'rename').mockImplementation(originalRename);

    const result = await store.completeAutonomousPersonalCaptureV4!(handle);

    expect(result).toEqual({ kind: 'no_write', reason: 'budget_exhausted' });
    expect(tempSnapshotSynced).toBe(true);
    expect(hostController.signal.aborted).toBe(true);
    expect(rename.mock.calls.filter(([, target]) => String(target) === file)).toHaveLength(0);
    expect(fs.readFileSync(file)).toEqual(before);
    expect(open.mock.calls.filter(([target]) => String(target) === file)).toHaveLength(1);
    const afterSnapshot = JSON.parse(fs.readFileSync(file, 'utf8')) as typeof beforeSnapshot;
    expect(afterSnapshot.entities).toEqual(beforeSnapshot.entities);
    expect(afterSnapshot.edges).toEqual(beforeSnapshot.edges);
    expect(afterSnapshot.episodes).toEqual(beforeSnapshot.episodes);
    expect(afterSnapshot.automatic_operations_v1).toEqual(beforeSnapshot.automatic_operations_v1);
    const afterMemory = await store.exportGraph();
    expect(afterMemory.entities).toEqual(beforeSnapshot.entities);
    expect(afterMemory.edges).toEqual(beforeSnapshot.edges);
    expect(afterMemory.episodes).toEqual(beforeSnapshot.episodes);
    expect(afterMemory.automatic_operations_v1).toEqual(beforeSnapshot.automatic_operations_v1);
  });

  it('reconciles the old snapshot when rename fails before its side effect', async () => {
    const handle = await prepare();
    const before = fs.readFileSync(file);
    const originalRename = fs.promises.rename.bind(fs.promises);
    const rename = jest.spyOn(fs.promises, 'rename').mockImplementation(async (source, target) => {
      if (String(target) === file) throw new Error('synthetic_pre_replace_failure');
      return originalRename(source, target);
    });
    const originalOpen = fs.promises.open.bind(fs.promises);
    const open = jest.spyOn(fs.promises, 'open').mockImplementation(async (target, flags, mode) => {
      return originalOpen(target, flags, mode);
    });

    const result = await store.completeAutonomousPersonalCaptureV4!(handle);

    expect(result).toEqual({ kind: 'unconfirmed' });
    expect(rename).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(file)).toEqual(before);
    expect((await store.exportGraph()).episodes).toHaveLength(1);
    expect(open.mock.calls.filter(([target]) => String(target) === file)).toHaveLength(2);
    expect(store.getLastMutationDiagnostics()?.operation).toBe(
      'autonomous_personal_completion_v4_readback',
    );
  });

  it('reconciles the candidate when rename replaces the snapshot and then throws', async () => {
    const handle = await prepare();
    const originalRename = fs.promises.rename.bind(fs.promises);
    const rename = jest.spyOn(fs.promises, 'rename').mockImplementation(async (source, target) => {
      await originalRename(source, target);
      if (String(target) === file) throw new Error('synthetic_post_rename_rejection');
    });
    const originalOpen = fs.promises.open.bind(fs.promises);
    const open = jest.spyOn(fs.promises, 'open').mockImplementation(async (target, flags, mode) => {
      return originalOpen(target, flags, mode);
    });

    const result = await store.completeAutonomousPersonalCaptureV4!(handle);

    expect(result).toEqual({ kind: 'matched' });
    expect(rename).toHaveBeenCalledTimes(1);
    expect((await store.exportGraph()).automatic_operations_v1?.operations).toContainEqual(
      expect.objectContaining({ version: 4, state: 'committed' }),
    );
    expect(
      JSON.parse(fs.readFileSync(file, 'utf8')).automatic_operations_v1.operations,
    ).toContainEqual(expect.objectContaining({ version: 4, state: 'committed' }));
    expect(open.mock.calls.filter(([target]) => String(target) === file)).toHaveLength(2);
  });

  it('keeps the renamed snapshot and performs one readback after a post-rename chmod failure', async () => {
    const handle = await prepare();
    const originalRename = fs.promises.rename.bind(fs.promises);
    const originalChmod = fs.promises.chmod.bind(fs.promises);
    const rename = jest.spyOn(fs.promises, 'rename').mockImplementation(originalRename);
    jest.spyOn(fs.promises, 'chmod').mockImplementation(async (target, mode) => {
      if (String(target) === file) throw new Error('synthetic_post_replace_chmod_failure');
      return originalChmod(target, mode);
    });

    const result = await store.completeAutonomousPersonalCaptureV4!(handle);

    expect(result).toEqual({ kind: 'matched' });
    expect(rename).toHaveBeenCalledTimes(1);
    expect((await store.exportGraph()).episodes).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).episodes).toHaveLength(1);
    expect((await store.exportGraph()).automatic_operations_v1?.operations).toContainEqual(
      expect.objectContaining({ version: 4, state: 'committed' }),
    );
  });

  it('keeps the renamed snapshot and reads it back after a directory fsync failure', async () => {
    const handle = await prepare();
    const originalRename = fs.promises.rename.bind(fs.promises);
    const rename = jest.spyOn(fs.promises, 'rename').mockImplementation(originalRename);
    const originalOpen = fs.promises.open.bind(fs.promises);
    let injectedDirectorySyncFailure = false;
    const open = jest.spyOn(fs.promises, 'open').mockImplementation(async (target, flags, mode) => {
      const fileHandle = await originalOpen(target, flags, mode);
      if (String(target) !== directory || flags !== 'r') return fileHandle;
      return new Proxy(fileHandle, {
        get(targetHandle, property, receiver) {
          if (property === 'sync') {
            return async () => {
              injectedDirectorySyncFailure = true;
              throw new Error('synthetic_directory_fsync_failure');
            };
          }
          const value = Reflect.get(targetHandle, property, receiver) as unknown;
          return typeof value === 'function' ? value.bind(targetHandle) : value;
        },
      });
    });

    const result = await store.completeAutonomousPersonalCaptureV4!(handle);

    expect(result).toEqual({ kind: 'matched' });
    expect(injectedDirectorySyncFailure).toBe(true);
    expect(rename).toHaveBeenCalledTimes(1);
    expect(open.mock.calls.filter(([target]) => String(target) === file)).toHaveLength(2);
    expect((await store.exportGraph()).automatic_operations_v1?.operations).toContainEqual(
      expect.objectContaining({ version: 4, state: 'committed' }),
    );
    expect(
      JSON.parse(fs.readFileSync(file, 'utf8')).automatic_operations_v1.operations,
    ).toContainEqual(expect.objectContaining({ version: 4, state: 'committed' }));
  });

  it('fails closed when an attempted replacement cannot be reconciled from disk', async () => {
    const handle = await prepare();
    const originalRename = fs.promises.rename.bind(fs.promises);
    jest.spyOn(fs.promises, 'rename').mockImplementation(async (source, target) => {
      if (String(target) === file) throw new Error('synthetic_pre_replace_failure');
      return originalRename(source, target);
    });
    const originalOpen = fs.promises.open.bind(fs.promises);
    let snapshotReads = 0;
    jest.spyOn(fs.promises, 'open').mockImplementation(async (target, flags, mode) => {
      if (String(target) === file) {
        snapshotReads += 1;
        if (snapshotReads === 2) throw new Error('synthetic_readback_io_failure');
      }
      return originalOpen(target, flags, mode);
    });

    expect(await store.completeAutonomousPersonalCaptureV4!(handle)).toEqual({
      kind: 'unconfirmed',
    });
    expect(snapshotReads).toBe(2);
    await expect(store.listEntities(seed.request.namespace)).rejects.toThrow('recovery_required');
  });

  it('allows unrelated edits while retaining a committed family4 claim tag', async () => {
    const restoreFetch = installSuccessfulProviderResponse();
    let handle: unknown;
    try {
      handle = await prepare('embedded-completion-unrelated-edit', 'enabled');
    } finally {
      restoreFetch();
    }
    expect(await store.completeAutonomousPersonalCaptureV4!(handle)).toEqual({ kind: 'matched' });
    const unrelated = await store.addEntity({
      name: 'Unrelated ordinary entity',
      group_id: seed.request.namespace,
      summary: 'initial summary',
    });
    await expect(
      store.updateEntity(unrelated.uuid, { summary: 'updated summary' }),
    ).resolves.toMatchObject({ summary: 'updated summary' });
    expect(
      (await store.exportGraph()).edges.some(
        (edge) => edge.attributes.engram_claim_v1 !== undefined,
      ),
    ).toBe(true);
  });

  it.each(['proposed', 'rejected'] as const)(
    'rejects a coherent generic staged pair transition to %s review state',
    async (reviewStatus) => {
      const restoreFetch = installSuccessfulProviderResponse();
      let handle: unknown;
      try {
        handle = await prepare(`embedded-completion-staged-review-${reviewStatus}`, 'enabled');
      } finally {
        restoreFetch();
      }
      expect(await store.completeAutonomousPersonalCaptureV4!(handle)).toEqual({ kind: 'matched' });

      const legacySource = await store.addEpisode({
        group_id: seed.request.namespace,
        content: 'A separate ordinary human source for a staged extraction plan.',
        role: 'human',
        reference_time: new Date().toISOString(),
      });
      const graph = await store.exportGraph();
      const operation = graph.automatic_operations_v1!.operations.find(
        (item) => item.version === 4 && item.state === 'committed',
      );
      if (!operation || operation.version !== 4 || operation.state !== 'committed') {
        throw new Error('Expected committed synthetic Operation4');
      }
      const value = graph.entities.find((item) => item.entity_type === 'autonomous_personal_value');
      const claim = graph.edges.find((item) => item.attributes.engram_claim_v1 !== undefined);
      if (!value || !claim) throw new Error('Expected the committed synthetic family4 pair');
      const reviewedAt = new Date(
        Date.parse(operation.terminalReceipt.terminalAt) + 1_000,
      ).toISOString();
      const updatedValue = {
        ...value,
        attributes: {
          ...value.attributes,
          engram_extraction: reviewExtractionMetadata(
            value.attributes.engram_extraction,
            reviewStatus,
            'synthetic operator',
            reviewedAt,
          ),
        },
      };
      const updatedClaim = {
        ...claim,
        attributes: {
          ...claim.attributes,
          engram_extraction: reviewExtractionMetadata(
            claim.attributes.engram_extraction,
            reviewStatus,
            'synthetic operator',
            reviewedAt,
          ),
        },
      };
      const plan = StagedExtractionSchema.parse({
        version: 1,
        group_id: seed.request.namespace,
        graph_hash: graphFingerprint(graph, seed.request.namespace),
        source_guards: [{ uuid: legacySource.uuid, hash: sourceFingerprint(legacySource) }],
        entities: [updatedValue],
        edges: [updatedClaim],
        outcome: new ExtractionDiagnostics().finish('disabled'),
      });
      const reviewedGraph = JSON.parse(JSON.stringify(graph)) as typeof graph;
      reviewedGraph.entities = reviewedGraph.entities.map((item) =>
        item.uuid === updatedValue.uuid ? updatedValue : item,
      );
      reviewedGraph.edges = reviewedGraph.edges.map((item) =>
        item.uuid === updatedClaim.uuid ? updatedClaim : item,
      );
      assertAutonomousPersonalRecordIntegrityV4(
        reviewedGraph,
        {
          absoluteMonotonicDeadlineMs: performance.now() + 5_000,
          signal: new AbortController().signal,
        },
        () => {},
      );
      const before = fs.readFileSync(file);

      await expect(store.applyStagedExtraction!(plan)).rejects.toThrow();

      expect(fs.readFileSync(file)).toEqual(before);
      const after = await store.exportGraph();
      expect(after.entities.find((item) => item.uuid === value.uuid)).toEqual(value);
      expect(after.edges.find((item) => item.uuid === claim.uuid)).toEqual(claim);
    },
  );

  it('rejects neutral attribute changes to an existing family4 value row', async () => {
    const restoreFetch = installSuccessfulProviderResponse();
    let handle: unknown;
    try {
      handle = await prepare('embedded-completion-staged-neutral-attribute', 'enabled');
    } finally {
      restoreFetch();
    }
    expect(await store.completeAutonomousPersonalCaptureV4!(handle)).toEqual({ kind: 'matched' });

    const legacySource = await store.addEpisode({
      group_id: seed.request.namespace,
      content: 'A separate ordinary human source for a staged extraction plan.',
      role: 'human',
      reference_time: new Date().toISOString(),
    });
    const graph = await store.exportGraph();
    const value = graph.entities.find((item) => item.entity_type === 'autonomous_personal_value');
    if (!value) throw new Error('Expected the committed synthetic family4 value row');
    const updatedValue = {
      ...value,
      attributes: { ...value.attributes, synthetic_neutral_note: 'unchanged claim tags' },
    };
    const plan = StagedExtractionSchema.parse({
      version: 1,
      group_id: seed.request.namespace,
      graph_hash: graphFingerprint(graph, seed.request.namespace),
      source_guards: [{ uuid: legacySource.uuid, hash: sourceFingerprint(legacySource) }],
      entities: [updatedValue],
      edges: [],
      outcome: new ExtractionDiagnostics().finish('disabled'),
    });
    const before = fs.readFileSync(file);

    await expect(store.applyStagedExtraction!(plan)).rejects.toThrow();

    expect(fs.readFileSync(file)).toEqual(before);
    expect((await store.exportGraph()).entities.find((item) => item.uuid === value.uuid)).toEqual(
      value,
    );
  });

  it('rejects direct entity updates that add a neutral attribute to a family4 value row', async () => {
    const restoreFetch = installSuccessfulProviderResponse();
    let handle: unknown;
    try {
      handle = await prepare('embedded-completion-direct-neutral-attribute', 'enabled');
    } finally {
      restoreFetch();
    }
    expect(await store.completeAutonomousPersonalCaptureV4!(handle)).toEqual({ kind: 'matched' });

    const graph = await store.exportGraph();
    const value = graph.entities.find((item) => item.entity_type === 'autonomous_personal_value');
    if (!value) throw new Error('Expected the committed synthetic family4 value row');
    const before = fs.readFileSync(file);

    await expect(
      store.updateEntity(value.uuid, {
        attributes: { ...value.attributes, synthetic_neutral_note: 'unchanged family4 tags' },
      }),
    ).rejects.toThrow('autonomous personal record integrity failed');

    expect(fs.readFileSync(file)).toEqual(before);
    expect((await store.exportGraph()).entities.find((item) => item.uuid === value.uuid)).toEqual(
      value,
    );
  });

  it('allows supported vector metadata updates while preserving family4 provenance', async () => {
    const restoreFetch = installSuccessfulProviderResponse();
    let handle: unknown;
    try {
      handle = await prepare('embedded-completion-direct-neutral-vector', 'enabled');
    } finally {
      restoreFetch();
    }
    expect(await store.completeAutonomousPersonalCaptureV4!(handle)).toEqual({ kind: 'matched' });

    const graph = await store.exportGraph();
    const value = graph.entities.find((item) => item.entity_type === 'autonomous_personal_value');
    if (!value) throw new Error('Expected the committed synthetic family4 value row');
    const claim = graph.edges.find((item) => item.attributes.engram_claim_v1 !== undefined);
    if (!claim) throw new Error('Expected the committed synthetic family4 claim edge');

    // Vector embeddings are a supported ordinary update. The historical guard protects the
    // committed source, meaning, and review proof without freezing this mutable metadata.
    await expect(
      store.updateEntity(value.uuid, { name_embedding: [0.1, 0.2] }),
    ).resolves.toMatchObject({ name_embedding: [0.1, 0.2] });

    const after = await store.exportGraph();
    const updatedValue = after.entities.find((item) => item.uuid === value.uuid);
    const unchangedClaim = after.edges.find((item) => item.uuid === claim.uuid);
    expect(updatedValue).toMatchObject({
      uuid: value.uuid,
      group_id: value.group_id,
      entity_type: value.entity_type,
      name: value.name,
      summary: value.summary,
      attributes: value.attributes,
      name_embedding: [0.1, 0.2],
    });
    expect(unchangedClaim).toEqual(claim);
    expect(after.automatic_operations_v1).toEqual(graph.automatic_operations_v1);
    const losslessSnapshot = { ...after };
    delete losslessSnapshot.group_id;
    assertAutonomousPersonalRecordIntegrityV4(
      losslessSnapshot,
      {
        absoluteMonotonicDeadlineMs: performance.now() + 5_000,
        signal: new AbortController().signal,
      },
      () => {},
    );
  });

  it('rejects ordinary edge deletion that would break a committed family4 pair', async () => {
    const restoreFetch = installSuccessfulProviderResponse();
    let handle: unknown;
    try {
      handle = await prepare('embedded-completion-delete-pair', 'enabled');
    } finally {
      restoreFetch();
    }
    expect(await store.completeAutonomousPersonalCaptureV4!(handle)).toEqual({ kind: 'matched' });
    const before = fs.readFileSync(file);
    const graph = await store.exportGraph();
    const claim = graph.edges.find((edge) => {
      const value = edge.attributes.engram_claim_v1;
      return (
        value !== null &&
        typeof value === 'object' &&
        (value as { version?: unknown }).version === 3
      );
    });
    expect(claim).toBeDefined();

    await expect(store.deleteEdge(claim!.uuid)).rejects.toThrow(
      'autonomous personal record integrity failed',
    );

    expect(fs.readFileSync(file)).toEqual(before);
    expect((await store.exportGraph()).edges.some((edge) => edge.uuid === claim!.uuid)).toBe(true);
  });

  it.each([
    [
      'claim tag',
      {
        entities: [],
        edges: [
          {
            uuid: '10000000-0000-4000-8000-000000000001',
            attributes: { engram_claim_v1: { version: 3, family: 'autonomous-personal-v1' } },
          },
        ],
      },
    ],
    [
      'literal marker',
      {
        entities: [
          {
            uuid: '10000000-0000-4000-8000-000000000002',
            entity_type: 'ordinary',
            attributes: { engram_literal_v1: { family: 'autonomous-personal-v1' } },
          },
        ],
        edges: [],
      },
    ],
    [
      'personal value entity type',
      {
        entities: [
          {
            uuid: '10000000-0000-4000-8000-000000000003',
            entity_type: 'autonomous_personal_value',
            attributes: {},
          },
        ],
        edges: [],
      },
    ],
  ])('rejects raw JSON family4 %s imports before normal graph parsing', async (_label, rows) => {
    const raw = {
      version: '2.0',
      exported_at: new Date().toISOString(),
      ...rows,
      episodes: [],
    };
    const before = fs.readFileSync(file);
    await expect(store.importGraph(raw as never)).rejects.toThrow('native_family_import_forbidden');
    expect(fs.readFileSync(file)).toEqual(before);
  });

  it('rejects public entity creation that tries to mint a family4 value marker', async () => {
    const restoreFetch = installSuccessfulProviderResponse();
    let handle: unknown;
    try {
      handle = await prepare('embedded-completion-generic-write', 'enabled');
    } finally {
      restoreFetch();
    }
    expect(await store.completeAutonomousPersonalCaptureV4!(handle)).toEqual({ kind: 'matched' });
    const before = fs.readFileSync(file);

    await expect(
      store.addEntity({
        name: 'Unauthorized synthetic value',
        group_id: seed.request.namespace,
        entity_type: 'autonomous_personal_value',
        attributes: {
          engram_literal_v1: { version: 3, family: 'autonomous-personal-v1' },
        },
      }),
    ).rejects.toThrow('native_write_required');

    expect(fs.readFileSync(file)).toEqual(before);
    expect(
      (await store.exportGraph()).entities.some((entity) =>
        entity.name.includes('Unauthorized synthetic value'),
      ),
    ).toBe(false);
  });

  it('preserves the legacy no-enrollment path and refuses to enroll an orphan legacy value', async () => {
    const legacy = await store.addEntity({
      name: 'Legacy personal value',
      group_id: seed.request.namespace,
      entity_type: 'ordinary',
    });
    await store.close();
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      entities: Array<{ uuid: string; entity_type: string }>;
    };
    const legacyRow = raw.entities.find((entity) => entity.uuid === legacy.uuid)!;
    legacyRow.entity_type = 'autonomous_personal_value';
    fs.writeFileSync(file, JSON.stringify(raw));

    store = new GraphologyStorage(file);
    await store.initialize();
    await expect(
      store.updateEntity(legacy.uuid, { summary: 'legacy edit remains supported' }),
    ).resolves.toMatchObject({ entity_type: 'autonomous_personal_value' });

    const before = fs.readFileSync(file);
    const admission = await dispatchNativeAutonomousPersonalCaptureV4(
      context('legacy-value-enrollment-attempt'),
      store,
    );
    expect(admission.kind).not.toBe('claimed');
    expect(fs.readFileSync(file)).toEqual(before);
    expect(
      (await store.exportGraph()).episodes.some(
        (episode) => 'engram_source_envelope_v3' in episode.attributes,
      ),
    ).toBe(false);
  });

  it('fails startup when an enrolled snapshot has a broken historical family4 pair', async () => {
    const restoreFetch = installSuccessfulProviderResponse();
    let handle: unknown;
    try {
      handle = await prepare('embedded-completion-malformed-startup', 'enabled');
    } finally {
      restoreFetch();
    }
    expect(await store.completeAutonomousPersonalCaptureV4!(handle)).toEqual({ kind: 'matched' });
    await store.close();

    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      edges: Array<{ attributes: Record<string, unknown> }>;
    };
    const claim = raw.edges.find((edge) => edge.attributes.engram_claim_v1 !== undefined);
    expect(claim).toBeDefined();
    delete claim!.attributes.engram_claim_v1;
    fs.writeFileSync(file, JSON.stringify(raw));

    const corrupted = new GraphologyStorage(file);
    await expect(corrupted.initialize()).rejects.toThrow(
      'Failed to load or migrate embedded storage',
    );
    await corrupted.close();
  });

  it('commits a qualified pair from a native provider result', async () => {
    const restoreFetch = installSuccessfulProviderResponse();
    let handle: unknown;
    try {
      handle = await prepare('embedded-completion-fact-turn', 'enabled');
    } finally {
      restoreFetch();
    }
    const result = await store.completeAutonomousPersonalCaptureV4!(handle);

    expect(result).toEqual({ kind: 'matched' });
    const graph = await store.exportGraph();
    expect(
      graph.edges.some((edge) => {
        const claim = edge.attributes.engram_claim_v1;
        return (
          claim !== null &&
          typeof claim === 'object' &&
          (claim as { version?: unknown }).version === 3
        );
      }),
    ).toBe(true);
    expect(
      graph.entities.some((entity) => {
        const marker = entity.attributes.engram_literal_v1;
        return (
          marker !== null &&
          typeof marker === 'object' &&
          (marker as { version?: unknown }).version === 3
        );
      }),
    ).toBe(true);
  });
});
