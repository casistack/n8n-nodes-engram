import * as fs from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { seedAutomaticCaptureSubject } from '../helpers/automaticCaptureBackend';
import { GraphologyStorage } from '../../src/storage/GraphologyStorage';
import {
  planAutomaticClaims,
  validateAutomaticClaimReadContext,
} from '../../src/extraction/AutomaticClaims';
import { ExtractionDiagnostics } from '../../src/extraction/ExtractionDiagnostics';
import { getAutomaticClaimReadScope } from '../../src/storage/AutomaticClaimReadScope';
import type { AutomaticCaptureBeginRequestV2 } from '../../src/schemas/AutomaticCapture.schema';
import type { PrivateOneUseAutomaticLeaseHandle } from '../../src/storage/AutomaticCaptureHandles';
import type { AutomaticBindingRecord } from '../../src/schemas/AutomaticOperations.schema';

type MutationRunner = { runMutation<T>(work: () => T | Promise<T>, options?: unknown): Promise<T> };

describe('embedded atomic human capture completion', () => {
  let directory: string;
  let storage: GraphologyStorage;
  let request: AutomaticCaptureBeginRequestV2;
  let binding: AutomaticBindingRecord;
  const path = () => join(directory, 'store.json');
  beforeEach(async () => {
    directory = fs.mkdtempSync(join(tmpdir(), 'engram-complete-'));
    storage = new GraphologyStorage(path());
    await storage.initialize();
    ({ request, binding } = await seedAutomaticCaptureSubject(storage));
  });
  afterEach(async () => {
    await storage.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const prepare = async () => {
    const begun = await storage.beginAndClaimAutomaticCaptureV2(request);
    if (begun.kind !== 'claimed' || begun.purpose !== 'human_turn_memory')
      throw new Error('Expected initial capture lease');
    return { ...begun, plan: await replan(begun.sourceId, begun.operationId) };
  };
  const replan = async (sourceId: string, operationId: string) => {
    const graph = await storage.readExtractionSnapshot(request.namespace);
    const op = graph.automatic_operations_v1!.operations.find(
      (item) => item.operationId === operationId,
    )!;
    if (op.version !== 2 || op.state !== 'leased' || op.descriptor.purpose !== 'human_turn_memory')
      throw new Error('Expected actual leased human operation');
    const outcome = new ExtractionDiagnostics().finish();
    outcome.status = 'succeeded';
    return planAutomaticClaims(
      graph,
      request.namespace,
      [sourceId],
      op.descriptor.policy,
      outcome,
      op.lease.renewedAt,
    );
  };

  it('commits graph facts, source provenance and terminal receipt together, then qualifies graph recall', async () => {
    const captured = await prepare();
    const before = await storage.readExtractionSnapshot();
    const result = await storage.completeHumanCaptureV2(captured.leaseHandle, captured.plan);
    expect(result.kind).toBe('committed');
    if (result.kind !== 'committed') throw new Error('Expected durable terminal result');
    expect(result.eligibleFirstCommit).toBe(true);
    expect(result.invocation).toBe('initial_owner');
    const reopened = new GraphologyStorage(path());
    await reopened.initialize();
    try {
      const graph = await reopened.readExtractionSnapshot();
      expect(graph.episodes).toEqual(before.episodes);
      expect(graph.entities).toEqual(expect.arrayContaining(before.entities));
      expect(graph.edges).toHaveLength(1);
      expect(graph.automatic_operations_v1!.operations[0]).toMatchObject({
        state: 'committed',
        terminalReceipt: result.terminalReceipt,
      });
      const proof = await reopened.readAutomaticClaimContext(
        request.namespace,
        graph.edges[0].uuid,
        getAutomaticClaimReadScope({ remaining: 512, deferred: 0 }),
      );
      expect(proof.status).toBe('committed');
      if (proof.status !== 'committed') throw new Error('Expected committed graph evidence');
      expect(validateAutomaticClaimReadContext(graph.edges[0], proof.context)).toBe(true);
    } finally {
      await reopened.close();
    }
    const terminal = result.terminalReceipt;
    const arrays = await storage.readExtractionSnapshot();
    expect(
      await storage.beginAndClaimAutomaticCaptureV2({ ...request, attemptIdHash: 'b'.repeat(64) }),
    ).toEqual({ kind: 'committed_replay' });
    const replay = await storage.readExtractionSnapshot();
    expect(replay.episodes).toEqual(arrays.episodes);
    expect(replay.entities).toEqual(arrays.entities);
    expect(replay.edges).toEqual(arrays.edges);
    const replayOp = replay.automatic_operations_v1!.operations[0];
    if (replayOp.version !== 2 || replayOp.state !== 'committed')
      throw new Error('Expected unchanged terminal operation');
    expect(replayOp.terminalReceipt).toEqual(terminal);
  });

  it('consumes handles before accessing a plan or issuing storage I/O', async () => {
    const captured = await prepare();
    await storage.completeHumanCaptureV2(captured.leaseHandle, captured.plan);
    let readPlan = false;
    const hostilePlan = new Proxy(
      {},
      {
        get() {
          readPlan = true;
          throw new Error('must-not-read-plan');
        },
      },
    );
    const open = jest.spyOn(fs.promises, 'open');
    try {
      for (const handle of [captured.leaseHandle, {}, structuredClone(captured.leaseHandle)]) {
        expect(
          await storage.completeHumanCaptureV2(
            handle as PrivateOneUseAutomaticLeaseHandle<'human_turn_memory'>,
            hostilePlan as never,
          ),
        ).toEqual({ kind: 'invalid_handle', eligibleFirstCommit: false });
      }
      expect(readPlan).toBe(false);
      expect(open).not.toHaveBeenCalled();
    } finally {
      open.mockRestore();
    }
  });

  it('does not apply an invalid plan or turn a failed outcome into graph retry', async () => {
    const captured = await prepare();
    const original = await storage.readExtractionSnapshot();
    const bad = structuredClone(captured.plan);
    bad.graph_hash = '0'.repeat(64);
    bad.outcome.status = 'failed';
    bad.outcome.error_count = 1;
    expect(await storage.completeHumanCaptureV2(captured.leaseHandle, bad)).toEqual({
      kind: 'invalid_plan',
      eligibleFirstCommit: false,
    });
    const after = await storage.readExtractionSnapshot();
    expect(after.episodes).toEqual(original.episodes);
    expect(after.entities).toEqual(original.entities);
    expect(after.edges).toEqual(original.edges);
    expect(after.automatic_operations_v1!.operations[0].state).toBe('failed');
    expect(
      await storage.beginAndClaimAutomaticCaptureV2({ ...request, attemptIdHash: 'b'.repeat(64) }),
    ).toEqual({ kind: 'resume_available' });
  });

  it('persists a bounded retry lease before issuing the sole successor handle', async () => {
    const captured = await prepare();
    await storage.addEntity({
      group_id: request.namespace,
      name: 'Synthetic concurrent graph change',
    });
    const retry = await storage.completeHumanCaptureV2(captured.leaseHandle, captured.plan);
    expect(retry.kind).toBe('graph_conflict_retry');
    if (retry.kind !== 'graph_conflict_retry') throw new Error('Expected bounded reprepare');
    expect(retry.eligibleFirstCommit).toBe(false);
    expect((await storage.readExtractionSnapshot()).edges).toHaveLength(0);
    const next = await replan(captured.sourceId, captured.operationId);
    const committed = await storage.completeHumanCaptureV2(retry.retryHandle, next);
    expect(committed.kind).toBe('committed');
    if (committed.kind !== 'committed') throw new Error('Expected successor commit');
    expect(committed.eligibleFirstCommit).toBe(true);
    expect((await storage.readExtractionSnapshot()).edges).toHaveLength(1);
  });

  it('returns no permit and leaves the original graph intact after a failed snapshot write', async () => {
    const captured = await prepare();
    const disk = fs.readFileSync(path(), 'utf8');
    const before = await storage.readExtractionSnapshot();
    const open = fs.promises.open.bind(fs.promises);
    let injected = false;
    const spy = jest
      .spyOn(fs.promises, 'open')
      .mockImplementation(async (...args: Parameters<typeof fs.promises.open>) => {
        const handle = await open(...args);
        if (
          !injected &&
          typeof args[0] === 'string' &&
          args[0].startsWith(`${path()}.`) &&
          args[0].endsWith('.tmp')
        ) {
          jest.spyOn(handle, 'sync').mockImplementationOnce(async () => {
            injected = true;
            throw new Error('synthetic-complete-write-failure');
          });
        }
        return handle;
      });
    try {
      expect(await storage.completeHumanCaptureV2(captured.leaseHandle, captured.plan)).toEqual({
        kind: 'storage_error',
        eligibleFirstCommit: false,
      });
      expect(injected).toBe(true);
      expect(fs.readFileSync(path(), 'utf8')).toBe(disk);
      const after = await storage.readExtractionSnapshot();
      expect(after.episodes).toEqual(before.episodes);
      expect(after.entities).toEqual(before.entities);
      expect(after.edges).toEqual(before.edges);
      expect(after.automatic_operations_v1).toEqual(before.automatic_operations_v1);
    } finally {
      spy.mockRestore();
    }
    expect(await storage.completeHumanCaptureV2(captured.leaseHandle, captured.plan)).toEqual({
      kind: 'invalid_handle',
      eligibleFirstCommit: false,
    });
  });

  it.each([false, true])(
    'recovers only the same committed call after lost acknowledgement (revoked: %s)',
    async (revoke) => {
      const captured = await prepare();
      const internal = storage as unknown as MutationRunner;
      const original = internal.runMutation.bind(storage) as MutationRunner['runMutation'];
      let injected = false;
      let committedDisk = '';
      const spy = jest.spyOn(internal, 'runMutation').mockImplementation(async function <T>(
        work: () => T | Promise<T>,
        options?: unknown,
      ): Promise<T> {
        const result = await original(work, options);
        if (
          !injected &&
          result !== null &&
          typeof result === 'object' &&
          (result as Record<string, unknown>).kind === 'prepared_commit'
        ) {
          injected = true;
          committedDisk = fs.readFileSync(path(), 'utf8');
          if (revoke) {
            await storage.automaticBindingCommand({
              action: 'revoke',
              namespace: request.namespace,
              bindingId: binding.bindingId,
              expectedRevision: binding.revision,
              authorizedBy: 'synthetic-reviewer',
              reason: 'Synthetic post-commit revocation',
            });
          }
          throw new Error('synthetic-lost-complete-ack');
        }
        return result;
      });
      try {
        const result = await storage.completeHumanCaptureV2(captured.leaseHandle, captured.plan);
        expect(injected).toBe(true);
        expect(result.kind).toBe('committed');
        if (result.kind !== 'committed') throw new Error('Expected historical same-call recovery');
        expect(result.invocation).toBe('same_call_ack_recovered');
        expect(result.eligibleFirstCommit).toBe(!revoke);
        expect(result.currentAuthority).toBe(revoke ? 'revoked' : 'active');
        const committed = JSON.parse(committedDisk);
        const after = await storage.readExtractionSnapshot();
        expect(after.episodes).toEqual(committed.episodes);
        expect(after.edges).toEqual(committed.edges);
        expect(after.automatic_operations_v1).toEqual(committed.automatic_operations_v1);
        expect(after.edges).toHaveLength(1);
        expect(after.automatic_operations_v1!.operations[0].attempts).toHaveLength(1);
        if (!revoke) expect(fs.readFileSync(path(), 'utf8')).toBe(committedDisk);
      } finally {
        spy.mockRestore();
      }
    },
  );

  it('rejects a handle presented to another instance before storage I/O', async () => {
    const captured = await prepare();
    const other = new GraphologyStorage(path());
    await other.initialize();
    const open = jest.spyOn(fs.promises, 'open');
    try {
      expect(await other.completeHumanCaptureV2(captured.leaseHandle, captured.plan)).toEqual({
        kind: 'invalid_handle',
        eligibleFirstCommit: false,
      });
      expect(open).not.toHaveBeenCalled();
    } finally {
      open.mockRestore();
      await other.close();
    }
    expect((await storage.completeHumanCaptureV2(captured.leaseHandle, captured.plan)).kind).toBe(
      'committed',
    );
  });
  it('preserves a legacy namespace including its leading and trailing spaces', async () => {
    const namespace = `  synthetic legacy namespace ${directory.split('/').pop()}  `;
    ({ request, binding } = await seedAutomaticCaptureSubject(storage, namespace));
    const captured = await prepare();
    const result = await storage.completeHumanCaptureV2(captured.leaseHandle, captured.plan);
    expect(result.kind).toBe('committed');
    const graph = await storage.readExtractionSnapshot(namespace);
    expect(graph.episodes).toHaveLength(1);
    expect(graph.episodes[0].group_id).toBe(namespace);
    expect(graph.edges[0].group_id).toBe(namespace);
    expect((await storage.readExtractionSnapshot(namespace.trim())).episodes).toHaveLength(0);
  });
});
