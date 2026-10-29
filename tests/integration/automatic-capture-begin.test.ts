import { randomUUID } from 'crypto';
import * as fs from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { GraphologyStorage } from '../../src/storage/GraphologyStorage';
import {
  AutomaticCaptureBeginRequestV2Schema,
  type AutomaticCaptureBeginRequestV2,
} from '../../src/schemas/AutomaticCapture.schema';
import { embeddedAutomaticCaptureStoreHash } from '../../src/storage/AutomaticCaptureStore';

describe('persistent embedded atomic human capture begin', () => {
  let directory: string;
  let storage: GraphologyStorage;
  let request: AutomaticCaptureBeginRequestV2;
  const persistPath = () => join(directory, 'store.json');
  beforeEach(async () => {
    directory = fs.mkdtempSync(join(tmpdir(), 'engram-capture-begin-'));
    storage = new GraphologyStorage(persistPath());
    await storage.initialize();
    const namespace = `begin-${randomUUID()}`;
    const time = new Date().toISOString();
    const subject = await storage.addEntity({
      group_id: namespace,
      name: 'Synthetic reviewed human',
      entity_type: 'person',
      attributes: {
        engram_extraction: {
          version: 2,
          source: 'manual',
          confidence: null,
          review_status: 'accepted',
          threshold_decision: 'manually_reviewed',
          extracted_at: time,
          episode_uuids: [],
          reviewed_at: time,
          reviewed_by: 'synthetic-reviewer',
        },
      },
    });
    await storage.automaticBindingCommand({
      action: 'create',
      namespace,
      issuer: 'synthetic-app',
      actorReference: 'synthetic-actor',
      subjectId: subject.uuid,
      authorizedBy: 'synthetic-reviewer',
      reason: 'Synthetic verification',
    });
    request = AutomaticCaptureBeginRequestV2Schema.parse({
      version: 2,
      lifecycle: 'replaySafeV2',
      purpose: 'human_turn_memory',
      namespace,
      issuer: 'synthetic-app',
      actorReference: 'synthetic-actor',
      turn: 'synthetic-event',
      attemptIdHash: 'a'.repeat(64),
      settings: {
        profileId: 'conservative',
        requestedTrustLevel: 'standard',
        intentSetting: false,
        invocationDeadlineMs: 30000,
      },
      source: {
        content: 'I prefer concise explanations.',
        sourceMessageId: 'synthetic-original-message',
        conversationId: 'synthetic-conversation',
        senderId: 'synthetic-sender',
        senderName: 'Synthetic Display',
        sourceWorkflowId: null,
        originalSourceExecutionId: null,
        sourceType: 'message',
        quotedMessageId: null,
        eventTime: { mode: 'first_capture' },
        applicationOwnedWrapper: null,
        humanRegion: null,
        quoteRegions: [],
      },
    });
  });
  afterEach(async () => {
    await storage.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('durably saves one raw source and lease before returning a private handle, without facts', async () => {
    const before = await storage.exportGraph();
    const result = await storage.beginAndClaimAutomaticCaptureV2(request);
    expect(result.kind).toBe('claimed');
    if (result.kind !== 'claimed') throw new Error('Expected initial lease');
    expect(Object.keys(result.leaseHandle)).toEqual([]);
    expect(Object.isFrozen(result.leaseHandle)).toBe(true);
    expect(result).not.toHaveProperty('should_process');
    const reopened = new GraphologyStorage(persistPath());
    await reopened.initialize();
    try {
      const graph = await reopened.readExtractionSnapshot();
      expect(graph.entities).toEqual(before.entities);
      expect(graph.edges).toEqual(before.edges);
      expect(graph.episodes).toHaveLength(1);
      expect(graph.episodes[0]).toMatchObject({
        uuid: result.sourceId,
        content: request.source.content,
        source_execution_id: null,
        source_workflow_id: null,
      });
      expect(graph.automatic_operations_v1?.operations).toHaveLength(1);
      const op = graph.automatic_operations_v1!.operations[0];
      expect(op).toMatchObject({
        version: 2,
        state: 'leased',
        operationId: result.operationId,
        generation: 1,
        identity: { storeHash: embeddedAutomaticCaptureStoreHash(persistPath()) },
      });
    } finally {
      await reopened.close();
    }
  });

  it('serializes concurrent independent arrivals across two storage instances', async () => {
    const other = new GraphologyStorage(persistPath());
    await other.initialize();
    try {
      const results = await Promise.all([
        storage.beginAndClaimAutomaticCaptureV2(request),
        other.beginAndClaimAutomaticCaptureV2({ ...request, attemptIdHash: 'b'.repeat(64) }),
      ]);
      expect(results.map((result) => result.kind).sort()).toEqual(['claimed', 'in_progress']);
      const graph = await storage.readExtractionSnapshot();
      expect(graph.episodes).toHaveLength(1);
      expect(graph.automatic_operations_v1?.operations).toHaveLength(1);
      expect(graph.edges).toHaveLength(0);
      expect(graph.automatic_operations_v1!.operations[0].attempts).toHaveLength(2);
    } finally {
      await other.close();
    }
  });

  it('records an independent redelivery attempt without changing the original source', async () => {
    await storage.beginAndClaimAutomaticCaptureV2(request);
    const before = await storage.readExtractionSnapshot();
    const retry = { ...request, attemptIdHash: 'b'.repeat(64) };
    expect(await storage.beginAndClaimAutomaticCaptureV2(retry)).toEqual({ kind: 'in_progress' });
    const after = await storage.readExtractionSnapshot();
    expect(after.entities).toEqual(before.entities);
    expect(after.edges).toEqual(before.edges);
    expect(after.episodes).toEqual(before.episodes);
    expect(after.automatic_operations_v1!.operations[0].attempts).toHaveLength(2);
    const persisted = fs.readFileSync(persistPath(), 'utf8');
    expect(await storage.beginAndClaimAutomaticCaptureV2(retry)).toEqual({ kind: 'in_progress' });
    expect(fs.readFileSync(persistPath(), 'utf8')).toBe(persisted);
  });

  it('does not audit or write a changed immutable event', async () => {
    await storage.beginAndClaimAutomaticCaptureV2(request);
    const before = fs.readFileSync(persistPath(), 'utf8');
    expect(
      await storage.beginAndClaimAutomaticCaptureV2({
        ...request,
        attemptIdHash: 'b'.repeat(64),
        source: { ...request.source, content: 'Different immutable event text.' },
      }),
    ).toEqual({ kind: 'conflict' });
    expect(fs.readFileSync(persistPath(), 'utf8')).toBe(before);
  });

  it.each([false, true])(
    'does not normalize stored metadata while beginning a capture (ledger present: %s)',
    async (ledgerPresent) => {
      if (ledgerPresent) await storage.beginAndClaimAutomaticCaptureV2(request);
      const data = JSON.parse(fs.readFileSync(persistPath(), 'utf8'));
      Object.defineProperty(data.entities[0].attributes, '__proto__', {
        value: { synthetic: 'must remain raw metadata' },
        enumerable: true,
        configurable: true,
        writable: true,
      });
      const original = JSON.stringify(data, null, 2);
      fs.writeFileSync(persistPath(), original);
      const next = {
        ...request,
        turn: 'synthetic-next-event',
        source: { ...request.source, sourceMessageId: 'synthetic-next-message' },
      };
      await expect(storage.beginAndClaimAutomaticCaptureV2(next)).rejects.toThrow(
        'record_normalization',
      );
      expect(fs.readFileSync(persistPath(), 'utf8')).toBe(original);
      const unchanged = JSON.parse(original);
      expect(unchanged.episodes).toHaveLength(ledgerPresent ? 1 : 0);
      expect(unchanged.automatic_operations_v1?.operations.length ?? 0).toBe(ledgerPresent ? 1 : 0);
      expect(
        Object.prototype.hasOwnProperty.call(unchanged.entities[0].attributes, '__proto__'),
      ).toBe(true);
    },
  );

  it('rejects an oversized backing file before reading its payload', async () => {
    fs.truncateSync(persistPath(), 100 * 1024 * 1024 + 1);
    const open = fs.promises.open.bind(fs.promises);
    const reads: jest.SpyInstance[] = [];
    const spy = jest
      .spyOn(fs.promises, 'open')
      .mockImplementation(async (...args: Parameters<typeof fs.promises.open>) => {
        const handle = await open(...args);
        if (args[0] === persistPath()) reads.push(jest.spyOn(handle, 'readFile'));
        return handle;
      });
    try {
      await expect(storage.beginAndClaimAutomaticCaptureV2(request)).rejects.toThrow(
        'snapshot_limit',
      );
      expect(reads.length).toBeGreaterThan(0);
      expect(reads.every((read) => read.mock.calls.length === 0)).toBe(true);
      expect(fs.statSync(persistPath()).size).toBe(100 * 1024 * 1024 + 1);
    } finally {
      spy.mockRestore();
    }
  });

  it('keeps capture and subsequent ordinary writes compact without changing stored values', async () => {
    let nested: unknown = { value: 'Synthetic retained deep metadata' };
    for (let index = 0; index < 45; index++) nested = { child: nested };
    await storage.addEntity({
      group_id: request.namespace,
      name: 'Synthetic deep metadata',
      attributes: { nested },
    });
    await storage.beginAndClaimAutomaticCaptureV2(request);
    const before = await storage.readExtractionSnapshot();
    const raw = fs.readFileSync(persistPath(), 'utf8');
    expect(raw).toBe(JSON.stringify(JSON.parse(raw)));
    await storage.addEntity({ group_id: request.namespace, name: 'Synthetic ordinary append' });
    const next = fs.readFileSync(persistPath(), 'utf8');
    expect(next).toBe(JSON.stringify(JSON.parse(next)));
    expect(Buffer.byteLength(next, 'utf8')).toBeLessThanOrEqual(100 * 1024 * 1024);
    const after = await storage.readExtractionSnapshot();
    expect(after.entities).toEqual(expect.arrayContaining(before.entities));
    expect(after.episodes).toEqual(before.episodes);
    expect(after.automatic_operations_v1).toEqual(before.automatic_operations_v1);
  });

  it('restores a compact V2 snapshot after an ordinary write fails following rename', async () => {
    await storage.beginAndClaimAutomaticCaptureV2(request);
    const before = await storage.readExtractionSnapshot();
    const open = fs.promises.open.bind(fs.promises);
    let injected = false;
    const spy = jest
      .spyOn(fs.promises, 'open')
      .mockImplementation(async (...args: Parameters<typeof fs.promises.open>) => {
        const handle = await open(...args);
        if (!injected && args[0] === directory) {
          jest.spyOn(handle, 'sync').mockImplementationOnce(async () => {
            injected = true;
            throw new Error('synthetic-after-rename');
          });
        }
        return handle;
      });
    try {
      await expect(
        storage.addEntity({ group_id: request.namespace, name: 'Must roll back' }),
      ).rejects.toThrow('synthetic-after-rename');
      expect(injected).toBe(true);
      const raw = fs.readFileSync(persistPath(), 'utf8');
      expect(raw).toBe(JSON.stringify(JSON.parse(raw)));
      expect(Buffer.byteLength(raw, 'utf8')).toBeLessThanOrEqual(100 * 1024 * 1024);
      const after = await storage.readExtractionSnapshot();
      expect(after.entities).toEqual(before.entities);
      expect(after.edges).toEqual(before.edges);
      expect(after.episodes).toEqual(before.episodes);
      expect(after.automatic_operations_v1).toEqual(before.automatic_operations_v1);
      expect(after.metadata).toEqual(before.metadata);
    } finally {
      spy.mockRestore();
    }
  });

  it('does not return a handle or leave a source/operation after a snapshot fsync failure', async () => {
    const before = await storage.readExtractionSnapshot();
    const disk = fs.readFileSync(persistPath(), 'utf8');
    const open = fs.promises.open.bind(fs.promises);
    let injected = false;
    const spy = jest
      .spyOn(fs.promises, 'open')
      .mockImplementation(async (...args: Parameters<typeof fs.promises.open>) => {
        const handle = await open(...args);
        if (
          !injected &&
          typeof args[0] === 'string' &&
          args[0].startsWith(`${persistPath()}.`) &&
          args[0].endsWith('.tmp')
        ) {
          jest.spyOn(handle, 'sync').mockImplementationOnce(async () => {
            injected = true;
            throw new Error('synthetic-capture-fsync-failure');
          });
        }
        return handle;
      });
    try {
      await expect(storage.beginAndClaimAutomaticCaptureV2(request)).rejects.toThrow(
        'synthetic-capture-fsync-failure',
      );
      expect(injected).toBe(true);
      expect(fs.readFileSync(persistPath(), 'utf8')).toBe(disk);
      const after = await storage.readExtractionSnapshot();
      expect(after.entities).toEqual(before.entities);
      expect(after.edges).toEqual(before.edges);
      expect(after.episodes).toEqual(before.episodes);
      expect(after.automatic_operations_v1).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
    expect((await storage.beginAndClaimAutomaticCaptureV2(request)).kind).toBe('claimed');
  });

  it('uses the actual tail without rewriting existing episodes', async () => {
    const previous = await storage.appendEpisode({
      group_id: request.namespace,
      content: 'Synthetic earlier conversation',
      role: 'human',
      source_type: 'message',
      reference_time: new Date().toISOString(),
    });
    await storage.beginAndClaimAutomaticCaptureV2(request);
    const graph = await storage.readExtractionSnapshot();
    expect(graph.episodes.find((episode) => episode.uuid === previous.episode.uuid)).toEqual(
      previous.episode,
    );
    const captured = graph.episodes.find((episode) => episode.uuid !== previous.episode.uuid)!;
    expect(captured.previous_episode_uuid).toBe(previous.episode.uuid);
  });

  it('requires a persistent backend and does not accept unsupported assistant construction', async () => {
    const uninitialized = new GraphologyStorage(persistPath());
    const original = fs.readFileSync(persistPath(), 'utf8');
    expect(await uninitialized.beginAndClaimAutomaticCaptureV2(request)).toEqual({
      kind: 'unsupported_mode',
    });
    expect(fs.readFileSync(persistPath(), 'utf8')).toBe(original);
    // Reopen through the supported lifecycle before closing this second view.
    await uninitialized.initialize();
    await uninitialized.close();
    const memoryOnly = new GraphologyStorage();
    await memoryOnly.initialize();
    try {
      expect(await memoryOnly.beginAndClaimAutomaticCaptureV2(request)).toEqual({
        kind: 'unsupported_mode',
      });
      expect((await memoryOnly.exportGraph()).episodes).toHaveLength(0);
    } finally {
      await memoryOnly.close();
    }
    const before = fs.readFileSync(persistPath(), 'utf8');
    const assistant = {
      ...request,
      purpose: 'assistant_final_save' as const,
      settings: {
        profileId: null,
        requestedTrustLevel: null,
        intentSetting: null,
        invocationDeadlineMs: 30000,
      },
    };
    expect(await storage.beginAndClaimAutomaticCaptureV2(assistant)).toEqual({
      kind: 'unsupported_mode',
    });
    expect(fs.readFileSync(persistPath(), 'utf8')).toBe(before);
  });
});
