import * as fs from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { GraphologyStorage } from '../../src/storage/GraphologyStorage';
import { seedAutomaticCaptureSubject } from '../helpers/automaticCaptureBackend';
import { captureReplaySafeHumanMemory } from '../../src/memory/ReplaySafeCapture';
import type { AutomaticCaptureBeginRequestV2 } from '../../src/schemas/AutomaticCapture.schema';

describe('internal replay-safe synchronous capture coordinator', () => {
  let directory: string;
  let storage: GraphologyStorage;
  let request: AutomaticCaptureBeginRequestV2;
  beforeEach(async () => {
    directory = fs.mkdtempSync(join(tmpdir(), 'engram-coordinator-'));
    storage = new GraphologyStorage(join(directory, 'store.json'));
    await storage.initialize();
    ({ request } = await seedAutomaticCaptureSubject(storage));
  });
  afterEach(async () => {
    await storage.close();
    fs.rmSync(directory, { recursive: true, force: true });
    jest.restoreAllMocks();
  });
  it('permits only the first persisted human commit and reports later events as stopped', async () => {
    const first = await captureReplaySafeHumanMemory(storage, request);
    expect(first).toMatchObject({
      status: 'first_capture_committed',
      should_process: true,
      sourcePersistence: 'persisted',
      receiptSummary: { itemCounts: { accepted: 1 } },
    });
    const original = await storage.readExtractionSnapshot();
    const second = await captureReplaySafeHumanMemory(storage, {
      ...request,
      attemptIdHash: 'b'.repeat(64),
    });
    expect(second).toMatchObject({
      status: 'committed_replay',
      should_process: false,
      sourceId: first.sourceId,
    });
    const after = await storage.readExtractionSnapshot();
    expect(after.episodes).toEqual(original.episodes);
    expect(after.entities).toEqual(original.entities);
    expect(after.edges).toEqual(original.edges);
  });
  it('commits truthful not-selected coverage without claiming that a question became a fact', async () => {
    request.source.content = 'What games are on today?';
    const result = await captureReplaySafeHumanMemory(storage, request);
    expect(result).toMatchObject({
      should_process: true,
      receiptSummary: { acceptedCoverage: 'none', itemCounts: { accepted: 0, not_selected: 1 } },
    });
    expect((await storage.readExtractionSnapshot()).edges).toHaveLength(0);
  });
  it('does not enrich a conflict with stored source or receipt information', async () => {
    await captureReplaySafeHumanMemory(storage, request);
    const read = jest.spyOn(storage, 'getAutomaticCaptureOutcomeV2');
    const result = await captureReplaySafeHumanMemory(storage, {
      ...request,
      source: { ...request.source, content: 'I prefer tables.' },
    });
    expect(result).toMatchObject({
      status: 'conflict',
      should_process: false,
      sourceId: null,
      receiptSummary: null,
    });
    expect(read).not.toHaveBeenCalled();
  });
  it('keeps uncertain begin failures stopped with unknown persistence and never retries', async () => {
    const begin = jest
      .spyOn(storage, 'beginAndClaimAutomaticCaptureV2')
      .mockRejectedValue(new Error('private-provider-or-storage-text'));
    const complete = jest.spyOn(storage, 'completeHumanCaptureV2');
    const result = await captureReplaySafeHumanMemory(storage, request);
    expect(result).toMatchObject({
      status: 'failed',
      should_process: false,
      sourcePersistence: 'unknown',
    });
    expect(JSON.stringify(result)).not.toContain('private-provider-or-storage-text');
    expect(begin).toHaveBeenCalledTimes(1);
    expect(complete).not.toHaveBeenCalled();
  });
  it('uses only a backend-issued successor after a graph conflict', async () => {
    const originalComplete = storage.completeHumanCaptureV2.bind(storage);
    let inject = true;
    const complete = jest
      .spyOn(storage, 'completeHumanCaptureV2')
      .mockImplementation(async (handle, plan) => {
        if (inject) {
          inject = false;
          await storage.addEntity({
            group_id: request.namespace,
            name: 'Concurrent synthetic entity',
          });
        }
        return originalComplete(handle, plan);
      });
    expect(await captureReplaySafeHumanMemory(storage, request)).toMatchObject({
      should_process: true,
    });
    expect(complete).toHaveBeenCalledTimes(2);
    expect((await storage.readExtractionSnapshot()).edges).toHaveLength(1);
  });
  it('rejects forged input fields before backend I/O', async () => {
    const begin = jest.spyOn(storage, 'beginAndClaimAutomaticCaptureV2');
    expect(
      await captureReplaySafeHumanMemory(storage, { ...request, should_process: true } as never),
    ).toMatchObject({
      status: 'invalid_input',
      should_process: false,
      sourcePersistence: 'not_persisted',
    });
    expect(begin).not.toHaveBeenCalled();
  });

  it('stops after the backend bounded graph retry ceiling', async () => {
    const originalComplete = storage.completeHumanCaptureV2.bind(storage);
    const complete = jest
      .spyOn(storage, 'completeHumanCaptureV2')
      .mockImplementation(async (handle, plan) => {
        await storage.addEntity({
          group_id: request.namespace,
          name: `Concurrent change ${plan.graph_hash}`,
        });
        return originalComplete(handle, plan);
      });
    expect(await captureReplaySafeHumanMemory(storage, request)).toMatchObject({
      should_process: false,
      status: 'failed',
    });
    expect(complete).toHaveBeenCalledTimes(4);
    expect((await storage.readExtractionSnapshot()).edges).toHaveLength(0);
  });

  it('does not plan after a late begin acknowledgement', async () => {
    request.settings.invocationDeadlineMs = 100;
    const originalBegin = storage.beginAndClaimAutomaticCaptureV2.bind(storage);
    jest.spyOn(storage, 'beginAndClaimAutomaticCaptureV2').mockImplementation(async (input) => {
      const result = await originalBegin(input);
      await new Promise((resolve) => setTimeout(resolve, 120));
      return result;
    });
    const complete = jest.spyOn(storage, 'completeHumanCaptureV2');
    expect(await captureReplaySafeHumanMemory(storage, request)).toMatchObject({
      should_process: false,
      status: 'failed',
      sourcePersistence: 'unknown',
    });
    expect(complete).not.toHaveBeenCalled();
    expect((await storage.readExtractionSnapshot()).edges).toHaveLength(0);
  });

  it('does not promote a committed acknowledgement that arrives after the shared deadline', async () => {
    request.settings.invocationDeadlineMs = 100;
    const originalComplete = storage.completeHumanCaptureV2.bind(storage);
    const complete = jest
      .spyOn(storage, 'completeHumanCaptureV2')
      .mockImplementation(async (handle, plan) => {
        const result = await originalComplete(handle, plan);
        await new Promise((resolve) => setTimeout(resolve, 120));
        return result;
      });
    expect(await captureReplaySafeHumanMemory(storage, request)).toMatchObject({
      should_process: false,
      status: 'failed',
      sourcePersistence: 'unknown',
    });
    expect(complete).toHaveBeenCalledTimes(1);
    expect((await storage.readExtractionSnapshot()).edges).toHaveLength(1);
    expect(await captureReplaySafeHumanMemory(storage, request)).toMatchObject({
      should_process: false,
      status: 'committed_replay',
    });
  });

  it('does not recreate a rootless store removed while acquiring the capture lock', async () => {
    const internal = storage as unknown as { acquirePersistLock(): Promise<() => Promise<void>> };
    const original = internal.acquirePersistLock.bind(storage);
    const spy = jest.spyOn(internal, 'acquirePersistLock').mockImplementationOnce(async () => {
      const release = await original();
      fs.unlinkSync(join(directory, 'store.json'));
      return release;
    });
    expect(await captureReplaySafeHumanMemory(storage, request)).toMatchObject({
      status: 'failed',
      should_process: false,
      sourcePersistence: 'unknown',
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(join(directory, 'store.json'))).toBe(false);
  });
});
