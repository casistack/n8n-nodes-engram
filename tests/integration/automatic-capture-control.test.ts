import * as fs from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { GraphologyStorage } from '../../src/storage/GraphologyStorage';
import { seedAutomaticCaptureSubject } from '../helpers/automaticCaptureBackend';
import { planAutomaticClaims } from '../../src/extraction/AutomaticClaims';
import { ExtractionDiagnostics } from '../../src/extraction/ExtractionDiagnostics';
import type { AutomaticCaptureBeginRequestV2 } from '../../src/schemas/AutomaticCapture.schema';

describe('embedded durable human capture controls', () => {
  let directory: string;
  let storage: GraphologyStorage;
  let request: AutomaticCaptureBeginRequestV2;
  const path = () => join(directory, 'store.json');
  const locator = () => ({
    version: 2 as const,
    namespace: request.namespace,
    issuer: request.issuer,
    actorReference: request.actorReference,
    turn: request.turn,
    role: 'human' as const,
  });
  const fence = (generation = 1) => ({
    ...locator(),
    expectedGeneration: generation,
    attemptIdHash: 'b'.repeat(64),
  });
  const plan = async (sourceId: string) => {
    const graph = await storage.readExtractionSnapshot(request.namespace);
    const operation = graph.automatic_operations_v1!.operations[0];
    if (
      operation.version !== 2 ||
      operation.state !== 'leased' ||
      operation.descriptor.purpose !== 'human_turn_memory'
    )
      throw new Error('Expected lease');
    const outcome = new ExtractionDiagnostics().finish();
    outcome.status = 'succeeded';
    return planAutomaticClaims(
      graph,
      request.namespace,
      [sourceId],
      operation.descriptor.policy,
      outcome,
      operation.lease.renewedAt,
    );
  };
  beforeEach(async () => {
    directory = fs.mkdtempSync(join(tmpdir(), 'engram-controls-'));
    storage = new GraphologyStorage(path());
    await storage.initialize();
    ({ request } = await seedAutomaticCaptureSubject(storage));
  });
  afterEach(async () => {
    await storage.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('reads without rewriting and cannot resume an unexpired lease', async () => {
    const begun = await storage.beginAndClaimAutomaticCaptureV2(request);
    expect(begun.kind).toBe('claimed');
    const bytes = fs.readFileSync(path(), 'utf8');
    const read = await storage.getAutomaticCaptureOutcomeV2(locator());
    expect(read.should_process).toBe(false);
    expect(read.sourcePersistence).toBe('persisted');
    expect(await storage.resumeAutomaticCaptureV2(fence())).toEqual({ kind: 'in_progress' });
    expect(fs.readFileSync(path(), 'utf8')).toBe(bytes);
  });

  it('cancels atomically, preserves original records and fences the original handle', async () => {
    const begun = await storage.beginAndClaimAutomaticCaptureV2(request);
    if (begun.kind !== 'claimed' || begun.purpose !== 'human_turn_memory')
      throw new Error('Expected lease');
    const prepared = await plan(begun.sourceId);
    const before = await storage.readExtractionSnapshot();
    expect(await storage.cancelAutomaticCaptureV2(fence())).toMatchObject({
      kind: 'cancelled',
      eligibleFirstCommit: false,
    });
    expect(await storage.completeHumanCaptureV2(begun.leaseHandle, prepared)).toMatchObject({
      eligibleFirstCommit: false,
    });
    const after = await storage.readExtractionSnapshot();
    expect(after.episodes).toEqual(before.episodes);
    expect(after.entities).toEqual(before.entities);
    expect(after.edges).toEqual(before.edges);
    expect(after.automatic_operations_v1!.operations[0].state).toBe('cancelled');
    const bytes = fs.readFileSync(path(), 'utf8');
    expect(await storage.getAutomaticCaptureOutcomeV2(locator())).toMatchObject({
      status: 'cancelled',
      should_process: false,
    });
    expect(fs.readFileSync(path(), 'utf8')).toBe(bytes);
  });

  it('resumes failed work after reopen and completion never grants processing permission', async () => {
    const begun = await storage.beginAndClaimAutomaticCaptureV2(request);
    if (begun.kind !== 'claimed' || begun.purpose !== 'human_turn_memory')
      throw new Error('Expected lease');
    const invalid = await plan(begun.sourceId);
    invalid.outcome.status = 'failed';
    invalid.outcome.error_count = 1;
    expect(await storage.completeHumanCaptureV2(begun.leaseHandle, invalid)).toMatchObject({
      kind: 'invalid_plan',
      eligibleFirstCommit: false,
    });
    const original = await storage.readExtractionSnapshot();
    await storage.close();
    storage = new GraphologyStorage(path());
    await storage.initialize();
    const resumed = await storage.resumeAutomaticCaptureV2(fence());
    if (resumed.kind !== 'resumed' || resumed.purpose !== 'human_turn_memory')
      throw new Error(`Expected resume: ${JSON.stringify(resumed)}`);
    const result = await storage.completeHumanCaptureV2(
      resumed.leaseHandle,
      await plan(resumed.sourceId),
    );
    expect(result).toMatchObject({
      kind: 'committed',
      invocation: 'explicit_resume',
      eligibleFirstCommit: false,
    });
    const after = await storage.readExtractionSnapshot();
    expect(after.episodes).toEqual(original.episodes);
    expect(after.edges).toHaveLength(1);
    expect(await storage.getAutomaticCaptureOutcomeV2(locator())).toMatchObject({
      status: 'committed_replay',
      should_process: false,
    });
  });

  it('rejects changed actor and generation without writing or exposing a source', async () => {
    await storage.beginAndClaimAutomaticCaptureV2(request);
    const bytes = fs.readFileSync(path(), 'utf8');
    expect(await storage.resumeAutomaticCaptureV2(fence(2))).toEqual({ kind: 'fenced' });
    expect(
      await storage.cancelAutomaticCaptureV2({ ...fence(), actorReference: 'another-actor' }),
    ).toMatchObject({ kind: 'conflict', eligibleFirstCommit: false });
    const read = await storage.getAutomaticCaptureOutcomeV2({
      ...locator(),
      actorReference: 'another-actor',
    });
    expect(read.sourceId).toBeNull();
    expect(read.should_process).toBe(false);
    expect(fs.readFileSync(path(), 'utf8')).toBe(bytes);
  });

  it('rolls back a cancelled snapshot that fails before acknowledgement', async () => {
    await storage.beginAndClaimAutomaticCaptureV2(request);
    const bytes = fs.readFileSync(path(), 'utf8');
    const originalOpen = fs.promises.open.bind(fs.promises);
    let injected = false;
    const spy = jest
      .spyOn(fs.promises, 'open')
      .mockImplementation(async (...args: Parameters<typeof fs.promises.open>) => {
        const handle = await originalOpen(...args);
        if (
          !injected &&
          typeof args[0] === 'string' &&
          args[0].startsWith(`${path()}.`) &&
          args[0].endsWith('.tmp')
        ) {
          jest.spyOn(handle, 'sync').mockImplementationOnce(async () => {
            injected = true;
            throw new Error('synthetic-cancel-write-failure');
          });
        }
        return handle;
      });
    try {
      await expect(storage.cancelAutomaticCaptureV2(fence())).rejects.toThrow();
      expect(injected).toBe(true);
      expect(fs.readFileSync(path(), 'utf8')).toBe(bytes);
    } finally {
      spy.mockRestore();
    }
    expect(await storage.getAutomaticCaptureOutcomeV2(locator())).toMatchObject({
      status: 'in_progress',
      should_process: false,
    });
  });
});
