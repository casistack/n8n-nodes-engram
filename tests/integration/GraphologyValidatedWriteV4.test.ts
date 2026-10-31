import * as fs from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as RecordIntegrity from '../../src/storage/AutonomousPersonalRecordIntegrityV4';
import { AutonomousPersonalRecordIntegrityV4Error } from '../../src/storage/AutonomousPersonalRecordIntegrityV4';
import * as LosslessGraph from '../../src/storage/LosslessAutomaticCaptureGraph';
import {
  closeAutonomousPersonalCompletionV4,
  prepareNativeAutonomousPersonalCompletionV4,
} from '../../src/storage/AutonomousPersonalCaptureHandlesV4';
import { GraphologyStorage } from '../../src/storage/GraphologyStorage';
import type { GraphData } from '../../src/schemas';
import {
  nativeAutonomousPersonalCaptureContext,
  seedAutonomousPersonalCaptureSubject,
} from '../helpers/autonomousPersonalCaptureBackend';

/**
 * An enrolled write validates its post-state once through the fully validating
 * record helper and serializes that private parser output directly. The old final
 * compact re-export + re-parse no longer runs between validation and the write.
 */
const realValidateOwned = RecordIntegrity.validateOwnedAutonomousPersonalRecordGraphV4;
const realParse = LosslessGraph.parseLosslessAutomaticCaptureGraph;
type WriteTextAtomic = (
  payload: string,
  path: string,
  durable: boolean,
  onReplaced?: () => void,
  onReplacementAttempted?: () => void,
) => Promise<void>;
const proto = GraphologyStorage.prototype as unknown as { writeTextAtomic: WriteTextAtomic };
const realWriteTextAtomic = proto.writeTextAtomic;

let directories: string[] = [];
let openStores: GraphologyStorage[] = [];

afterEach(async () => {
  jest.restoreAllMocks();
  for (const store of openStores) await store.close();
  openStores = [];
  for (const directory of directories) fs.rmSync(directory, { recursive: true, force: true });
  directories = [];
});

function track(store: GraphologyStorage): GraphologyStorage {
  openStores.push(store);
  return store;
}

function installSyntheticProvider() {
  return jest.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
    const user = JSON.parse(body.messages[1]!.content) as { units: Array<{ unitId: string }> };
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

/** Native enrollment + committed claim through the supported entry points only. */
async function createCommittedEnrolledStore(): Promise<{ file: string; namespace: string }> {
  const directory = fs.mkdtempSync(join(tmpdir(), 'engram-validated-write-'));
  directories.push(directory);
  const file = join(directory, 'store.json');
  const store = new GraphologyStorage(file);
  await store.initialize();
  const seed = await seedAutonomousPersonalCaptureSubject(store);
  const fetchSpy = installSyntheticProvider();
  const turn = 'validated-write-turn';
  const prepared = await prepareNativeAutonomousPersonalCompletionV4(
    nativeAutonomousPersonalCaptureContext(seed, {
      executionId: `execution:${turn}`,
      workflowId: `workflow:${turn}`,
      instanceId: `instance:${turn}`,
      deadlineMs: 30_000,
      content: 'I prefer concise explanations.',
      extraParameters: {
        automaticMemoryProfile: 'explicit',
        automaticIntent: 'enabled',
        automaticTurn: turn,
      },
    }),
    store,
  );
  if (prepared.kind !== 'completion_prepared') throw new Error(`Unexpected ${prepared.kind}`);
  try {
    expect(await store.completeAutonomousPersonalCaptureV4!(prepared.handle)).toEqual({
      kind: 'matched',
    });
  } finally {
    closeAutonomousPersonalCompletionV4(store, prepared.handle);
  }
  fetchSpy.mockRestore();
  await store.close();
  expect(claimEdge(readGraph(file))).toBeDefined();
  return { file, namespace: seed.request.namespace };
}

function claimEdge(graph: GraphData) {
  return graph.edges.find((edge) => edge.attributes.engram_claim_v1 !== undefined);
}

function readGraph(file: string): GraphData {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as GraphData;
}

/** Compact form the removed final re-parse produced for the same data. */
function compactBytes(graph: GraphData): string {
  const copy = { ...graph };
  if (copy.group_id === undefined) delete copy.group_id;
  return JSON.stringify(realParse(copy));
}

function observeWrite() {
  const events: string[] = [];
  const payloads: string[] = [];
  const validate = jest
    .spyOn(RecordIntegrity, 'validateOwnedAutonomousPersonalRecordGraphV4')
    .mockImplementation((...args) => {
      const owned = realValidateOwned(...args);
      events.push('validated');
      return owned;
    });
  jest.spyOn(LosslessGraph, 'parseLosslessAutomaticCaptureGraph').mockImplementation((...args) => {
    events.push('parse');
    return realParse(...args);
  });
  const write = jest.spyOn(proto, 'writeTextAtomic').mockImplementation(async function (
    this: unknown,
    payload,
    ...rest
  ) {
    events.push('write');
    payloads.push(payload);
    return realWriteTextAtomic.call(this, payload, ...rest);
  });
  return { events, payloads, validate, write };
}

async function openEnrolled() {
  const fixture = await createCommittedEnrolledStore();
  const store = track(new GraphologyStorage(fixture.file));
  await store.initialize();
  return {
    ...fixture,
    store,
    before: readGraph(fixture.file),
    bytes: fs.readFileSync(fixture.file),
  };
}

describe('enrolled validated write', () => {
  it('serializes the validated copy without a parse between validation and write', async () => {
    const { store, file, namespace, before } = await openEnrolled();
    const observed = observeWrite();

    const appended = await store.addEntity({
      group_id: namespace,
      name: 'Synthetic appended entity',
      entity_type: 'concept',
      attributes: { nested: { kept: [1, { deep: true }] } },
    });

    expect(observed.validate).toHaveBeenCalledTimes(1);
    expect(observed.write).toHaveBeenCalledTimes(1);
    const validatedAt = observed.events.indexOf('validated');
    const writeAt = observed.events.indexOf('write');
    expect(validatedAt).toBeGreaterThanOrEqual(0);
    expect(observed.events.slice(validatedAt + 1, writeAt)).not.toContain('parse');

    const payload = observed.payloads[0]!;
    expect(fs.readFileSync(file, 'utf8')).toBe(payload);
    const after = JSON.parse(payload) as GraphData;
    // Same bytes the old compact re-parse would have produced; payload is valid.
    expect(payload).toBe(compactBytes(after));
    // Equal to the live post-state except the per-export timestamp.
    const live = await store.exportGraph();
    const stamp = (graph: GraphData) => ({
      ...graph,
      exported_at: before.exported_at,
    });
    expect(compactBytes(stamp(after))).toBe(compactBytes(stamp(live)));
    expect('group_id' in after).toBe(false);

    expect(after.entities.map((row) => row.uuid)).toEqual([
      ...before.entities.map((row) => row.uuid),
      appended.uuid,
    ]);
    expect(after.entities.slice(0, before.entities.length)).toEqual(before.entities);
    expect(after.edges).toEqual(before.edges);
    expect(after.episodes).toEqual(before.episodes);
    expect(after.automatic_operations_v1).toEqual(before.automatic_operations_v1);

    await store.close();
    const again = track(new GraphologyStorage(file));
    await again.initialize();
    expect((await again.exportGraph()).entities.at(-1)?.uuid).toBe(appended.uuid);
  });

  it('writes validated bytes even if the validated input is mutated after validation', async () => {
    const { store, file, namespace, before } = await openEnrolled();
    jest
      .spyOn(RecordIntegrity, 'validateOwnedAutonomousPersonalRecordGraphV4')
      .mockImplementation((graph, ...rest) => {
        const owned = realValidateOwned(graph, ...rest);
        claimEdge(graph as GraphData)!.attributes.engram_claim_v1 = { version: 7, family: 'x' };
        return owned;
      });

    await store.addEntity({ group_id: namespace, name: 'Late alias', entity_type: 'concept' });

    expect(readGraph(file).edges).toEqual(before.edges);
  });

  it('rejects a tampered claim post-state before writing and retains original entities', async () => {
    const { store, file, namespace, bytes, before } = await openEnrolled();
    const observed = observeWrite();
    observed.validate.mockImplementation((graph, ...rest) => {
      claimEdge(graph as GraphData)!.attributes.engram_claim_v1 = { version: 7, family: 'x' };
      return realValidateOwned(graph, ...rest);
    });

    const failure = await store
      .addEntity({ group_id: namespace, name: 'Rejected', entity_type: 'concept' })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(failure).toBeInstanceOf(AutonomousPersonalRecordIntegrityV4Error);
    expect(observed.write).not.toHaveBeenCalled();
    expect(fs.readFileSync(file).equals(bytes)).toBe(true);
    expect((await store.exportGraph()).entities).toEqual(before.entities);
  });

  it('rejects a tampered source post-state before any write', async () => {
    const { store, file, namespace, bytes } = await openEnrolled();
    const observed = observeWrite();
    // Tamper only the post-mutation export (the one containing the new row).
    const realExport = GraphologyStorage.prototype.exportGraph;
    jest.spyOn(GraphologyStorage.prototype, 'exportGraph').mockImplementation(async function (
      this: GraphologyStorage,
      ...args
    ) {
      const graph = await realExport.apply(this, args);
      const source = graph.episodes.find((row) => row.attributes.engram_write_owner_v4);
      if (source && graph.entities.some((row) => row.name === 'Rejected'))
        source.content += ' tampered';
      return graph;
    });

    await expect(
      store.addEntity({ group_id: namespace, name: 'Rejected', entity_type: 'concept' }),
    ).rejects.toThrow();
    expect(observed.write).not.toHaveBeenCalled();
    expect(fs.readFileSync(file).equals(bytes)).toBe(true);
  });

  it('rolls back memory and keeps disk when the atomic write fails before rename', async () => {
    const { store, file, namespace, bytes, before } = await openEnrolled();
    jest.spyOn(proto, 'writeTextAtomic').mockRejectedValueOnce(new Error('synthetic_write'));

    await expect(
      store.addEntity({ group_id: namespace, name: 'Lost', entity_type: 'concept' }),
    ).rejects.toThrow('synthetic_write');

    expect(fs.readFileSync(file).equals(bytes)).toBe(true);
    expect((await store.exportGraph()).entities).toEqual(before.entities);
  });

  it('restores the pre-mutation snapshot when sync fails after rename', async () => {
    const { store, file, namespace, before } = await openEnrolled();
    const write = jest.spyOn(proto, 'writeTextAtomic').mockImplementationOnce(async function (
      this: unknown,
      ...args
    ) {
      await realWriteTextAtomic.apply(this, args);
      throw new Error('synthetic_fsync_after_rename');
    });

    await expect(
      store.addEntity({ group_id: namespace, name: 'Unsynced', entity_type: 'concept' }),
    ).rejects.toThrow('synthetic_fsync_after_rename');

    // Second call is the existing rollback rewrite of the exact pre-mutation graph.
    expect(write).toHaveBeenCalledTimes(2);
    const restored = readGraph(file);
    expect(restored.entities).toEqual(before.entities);
    expect(restored.edges).toEqual(before.edges);
    expect(restored.episodes).toEqual(before.episodes);
    expect(restored.automatic_operations_v1).toEqual(before.automatic_operations_v1);
    expect((await store.exportGraph()).entities).toEqual(before.entities);
  });

  it('keeps the old writer for a non-enrolled store', async () => {
    const directory = fs.mkdtempSync(join(tmpdir(), 'engram-plain-write-'));
    directories.push(directory);
    const file = join(directory, 'store.json');
    const store = track(new GraphologyStorage(file));
    await store.initialize();
    const observed = observeWrite();
    await store.addEntity({ group_id: 'plain', name: 'Plain', entity_type: 'concept' });
    expect(observed.validate).not.toHaveBeenCalled();
    // Default writer: pretty-printed, unchanged format.
    expect(observed.payloads[0]).toMatch(/^\{\n {2}"/);
    expect(JSON.parse(observed.payloads[0]!).entities).toEqual(
      (await store.exportGraph()).entities,
    );
  });
});
