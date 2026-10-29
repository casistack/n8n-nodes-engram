import * as fs from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AIMessage } from '@langchain/core/messages';
import { GraphologyStorage } from '../../src/storage/GraphologyStorage';
import { seedAutomaticCaptureSubject } from '../helpers/automaticCaptureBackend';
import { captureReplaySafeHumanMemory } from '../../src/memory/ReplaySafeCapture';
import { prepareReplaySafeAssistantIntent } from '../../src/memory/ReplaySafeAssistantIntent';
import { embeddedAutomaticCaptureStoreHash } from '../../src/storage/AutomaticCaptureStore';
import type { AutomaticAssistantCaptureIntentV2 } from '../../src/schemas/AutomaticAssistantCapture.schema';
import type { AutomaticBindingRecord } from '../../src/schemas/AutomaticOperations.schema';
import {
  makeAssistantIntentForCompositionalParent,
  makeCompositionalAssistantHumanParentFixture,
} from '../helpers/compositionalAssistantParentFixture';

type MutationRunner = { runMutation<T>(work: () => T | Promise<T>, options?: unknown): Promise<T> };

describe('embedded atomic assistant final saving', () => {
  let directory: string;
  let storage: GraphologyStorage;
  let intent: AutomaticAssistantCaptureIntentV2;
  let binding: AutomaticBindingRecord;
  let fetchSpy: jest.SpyInstance;
  const path = () => join(directory, 'store.json');
  const seed = async (content?: string) => {
    const seeded = await seedAutomaticCaptureSubject(storage);
    binding = seeded.binding;
    if (content) seeded.request.source.content = content;
    const captured = await captureReplaySafeHumanMemory(storage, seeded.request);
    if (!captured.should_process || !captured.sourceId) throw new Error('Expected committed human');
    const result = prepareReplaySafeAssistantIntent(
      {
        profileId: 'conservative',
        storeIdentity: embeddedAutomaticCaptureStoreHash(path())!,
        capturedSourceId: captured.sourceId,
        turnId: seeded.request.turn,
        actor: {
          namespace: seeded.request.namespace,
          issuer: seeded.request.issuer,
          actorReference: seeded.request.actorReference,
        },
      },
      seeded.request.source.content,
      new AIMessage('Synthetic final assistant reply.'),
      'b'.repeat(64),
      30000,
    );
    if (result.kind !== 'prepared') throw new Error('Expected strict final intent');
    intent = result.intent;
  };
  const revoke = () =>
    storage.automaticBindingCommand({
      action: 'revoke',
      namespace: intent.humanTurn.namespace,
      bindingId: binding.bindingId,
      expectedRevision: binding.revision,
      authorizedBy: 'synthetic-reviewer',
      reason: 'Synthetic authority revocation',
    });
  beforeEach(async () => {
    directory = fs.mkdtempSync(join(tmpdir(), 'engram-assistant-'));
    storage = new GraphologyStorage(path());
    await storage.initialize();
    fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('Unexpected provider request'));
    await seed();
  });
  afterEach(async () => {
    expect(fetchSpy).not.toHaveBeenCalled();
    jest.restoreAllMocks();
    await storage.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('commits a write-only assistant receipt and preserves every original record and epoch', async () => {
    const before = await storage.readExtractionSnapshot();
    const result = await storage.saveAssistantFinalV2(intent);
    expect(result).toMatchObject({
      kind: 'committed',
      invocation: 'initial_owner',
      eligibleFirstCommit: false,
    });
    const reopened = new GraphologyStorage(path());
    await reopened.initialize();
    try {
      const after = await reopened.readExtractionSnapshot();
      expect(after.entities).toEqual(before.entities);
      expect(after.edges).toEqual(before.edges);
      for (const episode of before.episodes)
        expect(after.episodes.find((item) => item.uuid === episode.uuid)).toEqual(episode);
      expect(before.metadata?.extraction_epoch).toEqual(expect.any(String));
      expect(after.metadata?.extraction_epoch).toBe(before.metadata?.extraction_epoch);
      const assistant = after.episodes.find((item) => item.role === 'ai')!;
      expect(assistant).toMatchObject({
        content: intent.finalAssistant.content,
        episode_kind: 'assistant_reply',
        trust_level: 'unverified',
        review_status: 'proposed',
        source_execution_id: null,
      });
      expect(assistant.attributes).toHaveProperty('engram_write_owner_v2');
      expect(assistant.attributes).not.toHaveProperty('engram_write_owner_v1');
      expect(assistant.attributes).not.toHaveProperty('engram_source_envelope_v1');
      const op = after.automatic_operations_v1!.operations.find(
        (item) => item.identity.role === 'assistant',
      );
      expect(op).toMatchObject({
        state: 'committed',
        terminalReceipt: { kind: 'assistant_final_saved', persisted: true },
      });
    } finally {
      await reopened.close();
    }
  });

  it.each(['accepted_bundle', 'proposed_bundle', 'source_verdict'] as const)(
    'writes an assistant final against a native committed V3 %s parent without changing human facts',
    async (kind) => {
      await storage.close();
      const storeHash = embeddedAutomaticCaptureStoreHash(path());
      if (!storeHash) throw new Error('Expected stable embedded store identity');
      const parent = makeCompositionalAssistantHumanParentFixture(kind, storeHash);
      fs.writeFileSync(path(), JSON.stringify(parent.graph), 'utf8');
      storage = new GraphologyStorage(path());
      await storage.initialize();
      intent = makeAssistantIntentForCompositionalParent(parent);

      const before = await storage.readExtractionSnapshot();
      const result = await storage.saveAssistantFinalV2(intent);
      expect(result).toMatchObject({
        kind: 'committed',
        invocation: 'initial_owner',
        currentAuthority: 'active',
        eligibleFirstCommit: false,
        terminalReceipt: { kind: 'assistant_final_saved', persisted: true },
      });
      const after = await storage.readExtractionSnapshot();
      expect(after.entities).toEqual(before.entities);
      expect(after.edges).toEqual(before.edges);
      expect(after.episodes).toHaveLength(before.episodes.length + 1);
      expect(after.episodes.find((episode) => episode.uuid === parent.source.uuid)).toEqual(
        parent.source,
      );
      const humanOperation = after.automatic_operations_v1!.operations.find(
        (operation) => operation.operationId === parent.operation.operationId,
      );
      expect(humanOperation).toEqual(parent.operation);
      const assistant = after.episodes.find(
        (episode) => episode.role === 'ai' && episode.group_id === parent.source.group_id,
      );
      expect(assistant).toMatchObject({
        content: intent.finalAssistant.content,
        role: 'ai',
        episode_kind: 'assistant_reply',
        trust_level: 'unverified',
        review_status: 'proposed',
      });
      expect(assistant?.attributes).toHaveProperty('engram_write_owner_v2');
      expect(assistant?.attributes).not.toHaveProperty('engram_write_owner_v1');
      expect(assistant?.attributes).not.toHaveProperty('engram_source_envelope_v1');
    },
  );

  it('keeps a V3-parent assistant receipt historical and audit-free after binding revocation', async () => {
    await storage.close();
    const storeHash = embeddedAutomaticCaptureStoreHash(path());
    if (!storeHash) throw new Error('Expected stable embedded store identity');
    const parent = makeCompositionalAssistantHumanParentFixture('source_verdict', storeHash);
    fs.writeFileSync(path(), JSON.stringify(parent.graph), 'utf8');
    storage = new GraphologyStorage(path());
    await storage.initialize();
    intent = makeAssistantIntentForCompositionalParent(parent);

    const first = await storage.saveAssistantFinalV2(intent);
    if (first.kind !== 'committed') throw new Error('Expected committed assistant receipt');
    const binding = parent.operation.identity.binding;
    await storage.automaticBindingCommand({
      action: 'revoke',
      namespace: parent.operation.identity.namespace,
      bindingId: binding.bindingId,
      expectedRevision: binding.revision,
      authorizedBy: 'synthetic-reviewer',
      reason: 'Synthetic V3 parent revocation',
    });
    const beforeReplay = fs.readFileSync(path(), 'utf8');
    const replay = await storage.saveAssistantFinalV2({ ...intent, attemptIdHash: 'f'.repeat(64) });
    expect(replay).toEqual({
      kind: 'committed_replay',
      terminalReceipt: first.terminalReceipt,
      currentAuthority: 'revoked',
      eligibleFirstCommit: false,
    });
    expect(fs.readFileSync(path(), 'utf8')).toBe(beforeReplay);
  });

  it('keeps a V3-parent assistant receipt historical and audit-free after mutable trust changes', async () => {
    await storage.close();
    const storeHash = embeddedAutomaticCaptureStoreHash(path());
    if (!storeHash) throw new Error('Expected stable embedded store identity');
    const parent = makeCompositionalAssistantHumanParentFixture('source_verdict', storeHash);
    fs.writeFileSync(path(), JSON.stringify(parent.graph), 'utf8');
    storage = new GraphologyStorage(path());
    await storage.initialize();
    intent = makeAssistantIntentForCompositionalParent(parent);

    const committed = await storage.saveAssistantFinalV2(intent);
    if (committed.kind !== 'committed') throw new Error('Expected committed assistant receipt');
    await storage.close();

    const persistedGraph = JSON.parse(fs.readFileSync(path(), 'utf8')) as {
      episodes: Array<{ uuid: string; trust_level: string }>;
    };
    const persistedSource = persistedGraph.episodes.find(
      (episode) => episode.uuid === parent.source.uuid,
    );
    if (!persistedSource) throw new Error('Missing persisted V3 source');
    persistedSource.trust_level =
      persistedSource.trust_level === 'trusted' ? 'standard' : 'trusted';
    fs.writeFileSync(path(), JSON.stringify(persistedGraph), 'utf8');

    storage = new GraphologyStorage(path());
    await storage.initialize();
    const beforeReplay = fs.readFileSync(path(), 'utf8');
    const before = await storage.readExtractionSnapshot();
    const beforeOperation = before.automatic_operations_v1?.operations.find(
      (operation) => operation.identity.role === 'assistant',
    );
    if (!beforeOperation || beforeOperation.state !== 'committed')
      throw new Error('Expected committed assistant operation');

    const replay = await storage.saveAssistantFinalV2({
      ...intent,
      attemptIdHash: 'e'.repeat(64),
    });
    expect(replay).toEqual({
      kind: 'committed_replay',
      terminalReceipt: committed.terminalReceipt,
      currentAuthority: 'changed',
      eligibleFirstCommit: false,
    });
    const after = await storage.readExtractionSnapshot();
    expect(
      after.automatic_operations_v1?.operations.find(
        (operation) => operation.identity.role === 'assistant',
      ),
    ).toEqual(beforeOperation);
    expect(fs.readFileSync(path(), 'utf8')).toBe(beforeReplay);
  });

  it('reuses the exact receipt across execution attempts and restart while auditing only attempts', async () => {
    const first = await storage.saveAssistantFinalV2(intent);
    const original = await storage.readExtractionSnapshot();
    await storage.close();
    storage = new GraphologyStorage(path());
    await storage.initialize();
    const replay = await storage.saveAssistantFinalV2({ ...intent, attemptIdHash: 'c'.repeat(64) });
    expect(replay).toMatchObject({ kind: 'committed_replay', eligibleFirstCommit: false });
    if (first.kind !== 'committed' || replay.kind !== 'committed_replay')
      throw new Error('Expected actual receipts');
    expect(replay.terminalReceipt).toEqual(first.terminalReceipt);
    const after = await storage.readExtractionSnapshot();
    expect(after.episodes).toEqual(original.episodes);
    expect(after.entities).toEqual(original.entities);
    expect(after.edges).toEqual(original.edges);
    expect(
      after.automatic_operations_v1!.operations.find((item) => item.identity.role === 'assistant')!
        .attempts,
    ).toHaveLength(2);
  });

  it('does not write or disclose a receipt for changed content or actor', async () => {
    await storage.saveAssistantFinalV2(intent);
    const bytes = fs.readFileSync(path(), 'utf8');
    for (const changed of [
      {
        ...intent,
        finalAssistant: { ...intent.finalAssistant, content: 'Different final answer' },
      },
      {
        ...intent,
        humanTurn: { ...intent.humanTurn, actorReference: 'different-synthetic-actor' },
      },
    ]) {
      expect(await storage.saveAssistantFinalV2(changed)).toMatchObject({
        kind: 'decision',
        eligibleFirstCommit: false,
      });
      expect(fs.readFileSync(path(), 'utf8')).toBe(bytes);
    }
  });

  it('creates only one source under two-instance arrival and never resumes another owner', async () => {
    const other = new GraphologyStorage(path());
    await other.initialize();
    try {
      const results = await Promise.all([
        storage.saveAssistantFinalV2(intent),
        other.saveAssistantFinalV2({ ...intent, attemptIdHash: 'c'.repeat(64) }),
      ]);
      expect(results.every((item) => item.eligibleFirstCommit === false)).toBe(true);
      const graph = await storage.readExtractionSnapshot();
      expect(graph.episodes.filter((item) => item.role === 'ai')).toHaveLength(1);
      expect(
        graph.automatic_operations_v1!.operations.filter(
          (item) => item.identity.role === 'assistant',
        ),
      ).toHaveLength(1);
      expect(results.some((item) => item.kind === 'committed')).toBe(true);
      expect(await other.saveAssistantFinalV2(intent)).toMatchObject({
        kind: 'committed_replay',
        eligibleFirstCommit: false,
      });
    } finally {
      await other.close();
    }
  });

  it('returns unconfirmed after lost begin acknowledgement without completing or reapplying', async () => {
    const runner = storage as unknown as MutationRunner;
    const original = runner.runMutation.bind(storage) as MutationRunner['runMutation'];
    let injected = false;
    const spy = jest.spyOn(runner, 'runMutation').mockImplementation(async function <T>(
      work: () => T | Promise<T>,
      options?: unknown,
    ): Promise<T> {
      const result = await original(work, options);
      if (!injected && (result as { kind?: string })?.kind === 'prepared_claim') {
        injected = true;
        throw new Error('Synthetic lost begin ack');
      }
      return result;
    });
    expect(await storage.saveAssistantFinalV2(intent)).toEqual({
      kind: 'decision',
      reason: 'acknowledgement_unknown',
      eligibleFirstCommit: false,
    });
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    const graph = await storage.readExtractionSnapshot();
    expect(graph.episodes.filter((item) => item.role === 'ai')).toHaveLength(1);
    expect(
      graph.automatic_operations_v1!.operations.find((item) => item.identity.role === 'assistant')!
        .state,
    ).toBe('leased');
    expect(
      await storage.saveAssistantFinalV2({ ...intent, attemptIdHash: 'c'.repeat(64) }),
    ).toEqual({ kind: 'decision', reason: 'in_progress', eligibleFirstCommit: false });
    expect(
      (await storage.readExtractionSnapshot()).episodes.filter((item) => item.role === 'ai'),
    ).toHaveLength(1);
  });

  it.each([false, true])(
    'recovers only the actual committed completion after lost ack (revoked %s)',
    async (revoked) => {
      const runner = storage as unknown as MutationRunner;
      const original = runner.runMutation.bind(storage) as MutationRunner['runMutation'];
      let injected = false;
      jest.spyOn(runner, 'runMutation').mockImplementation(async function <T>(
        work: () => T | Promise<T>,
        options?: unknown,
      ): Promise<T> {
        const result = await original(work, options);
        if (!injected && (result as { kind?: string })?.kind === 'prepared_commit') {
          injected = true;
          if (revoked) await revoke();
          throw new Error('Synthetic lost completion ack');
        }
        return result;
      });
      expect(await storage.saveAssistantFinalV2(intent)).toMatchObject({
        kind: 'committed',
        invocation: 'same_call_ack_recovered',
        currentAuthority: revoked ? 'revoked' : 'active',
        eligibleFirstCommit: false,
      });
      const graph = await storage.readExtractionSnapshot();
      expect(graph.episodes.filter((item) => item.role === 'ai')).toHaveLength(1);
      expect(
        graph.automatic_operations_v1!.operations.find(
          (item) => item.identity.role === 'assistant',
        )!.state,
      ).toBe('committed');
    },
  );

  it('reads an exact historical receipt after revocation without auditing or writing', async () => {
    const first = await storage.saveAssistantFinalV2(intent);
    await revoke();
    const bytes = fs.readFileSync(path(), 'utf8');
    const replay = await storage.saveAssistantFinalV2({ ...intent, attemptIdHash: 'c'.repeat(64) });
    expect(replay).toMatchObject({
      kind: 'committed_replay',
      currentAuthority: 'revoked',
      eligibleFirstCommit: false,
    });
    if (first.kind !== 'committed' || replay.kind !== 'committed_replay')
      throw new Error('Expected receipts');
    expect(replay.terminalReceipt).toEqual(first.terminalReceipt);
    expect(fs.readFileSync(path(), 'utf8')).toBe(bytes);
  });

  it('revalidates authority after durable source capture and before the receipt', async () => {
    const runner = storage as unknown as MutationRunner;
    const original = runner.runMutation.bind(storage) as MutationRunner['runMutation'];
    let injected = false;
    jest.spyOn(runner, 'runMutation').mockImplementation(async function <T>(
      work: () => T | Promise<T>,
      options?: unknown,
    ): Promise<T> {
      const result = await original(work, options);
      if (!injected && (result as { kind?: string })?.kind === 'prepared_claim') {
        injected = true;
        await revoke();
      }
      return result;
    });
    expect(await storage.saveAssistantFinalV2(intent)).toEqual({
      kind: 'decision',
      reason: 'authority_changed',
      eligibleFirstCommit: false,
    });
    const op = (await storage.readExtractionSnapshot()).automatic_operations_v1!.operations.find(
      (item) => item.identity.role === 'assistant',
    )!;
    expect(op.state).toBe('leased');
    expect(op).not.toHaveProperty('terminalReceipt');
  });

  it.each([1, 2])('preserves records after a snapshot fsync failure in phase %s', async (phase) => {
    const before = await storage.readExtractionSnapshot();
    const bytes = fs.readFileSync(path(), 'utf8');
    const originalOpen = fs.promises.open.bind(fs.promises);
    let snapshots = 0;
    let injected = false;
    const spy = jest
      .spyOn(fs.promises, 'open')
      .mockImplementation(async (...args: Parameters<typeof fs.promises.open>) => {
        const handle = await originalOpen(...args);
        if (
          typeof args[0] === 'string' &&
          args[0].startsWith(`${path()}.`) &&
          args[0].endsWith('.tmp')
        ) {
          snapshots++;
          if (snapshots === phase)
            jest.spyOn(handle, 'sync').mockImplementationOnce(async () => {
              injected = true;
              throw new Error('Synthetic assistant snapshot failure');
            });
        }
        return handle;
      });
    try {
      expect(await storage.saveAssistantFinalV2(intent)).toEqual({
        kind: 'decision',
        reason: 'acknowledgement_unknown',
        eligibleFirstCommit: false,
      });
      expect(injected).toBe(true);
    } finally {
      spy.mockRestore();
    }
    const after = await storage.readExtractionSnapshot();
    expect(after.entities).toEqual(before.entities);
    expect(after.edges).toEqual(before.edges);
    for (const original of before.episodes)
      expect(after.episodes.find((item) => item.uuid === original.uuid)).toEqual(original);
    if (phase === 1) expect(fs.readFileSync(path(), 'utf8')).toBe(bytes);
    expect(after.episodes.filter((item) => item.role === 'ai')).toHaveLength(phase - 1);
    expect(
      after.automatic_operations_v1!.operations.filter(
        (item) => item.identity.role === 'assistant' && item.state === 'committed',
      ),
    ).toHaveLength(0);
  });

  it('stores independently maximum escaped human and assistant content without widening human limits', async () => {
    const content = '\u0001'.repeat(65536);
    const seeded = await seedAutomaticCaptureSubject(storage);
    const humanBody = seeded.request.source.content;
    const prefix = '\u0001'.repeat(65536 - humanBody.length);
    seeded.request.source.content = prefix + humanBody;
    seeded.request.source.applicationOwnedWrapper = true;
    seeded.request.source.humanRegion = { start: prefix.length, end: 65536 };
    const captured = await captureReplaySafeHumanMemory(storage, seeded.request);
    if (!captured.should_process || !captured.sourceId)
      throw new Error('Expected mapped human commit');
    const translated = prepareReplaySafeAssistantIntent(
      {
        profileId: 'conservative',
        storeIdentity: embeddedAutomaticCaptureStoreHash(path())!,
        capturedSourceId: captured.sourceId,
        turnId: seeded.request.turn,
        rawHumanContent: humanBody,
        actor: {
          namespace: seeded.request.namespace,
          issuer: seeded.request.issuer,
          actorReference: seeded.request.actorReference,
          applicationOwnedWrapper: true,
          humanRegion: seeded.request.source.humanRegion,
        },
      },
      seeded.request.source.content,
      new AIMessage(content),
      'b'.repeat(64),
      30000,
    );
    if (translated.kind !== 'prepared') throw new Error('Expected maximum mapped assistant intent');
    intent = translated.intent;
    const before = await storage.readExtractionSnapshot();
    expect(Buffer.byteLength(JSON.stringify(intent))).toBeGreaterThan(512 * 1024);
    expect(await storage.saveAssistantFinalV2(intent)).toMatchObject({
      kind: 'committed',
      eligibleFirstCommit: false,
    });
    const after = await storage.readExtractionSnapshot();
    expect(after.entities).toEqual(before.entities);
    expect(after.edges).toEqual(before.edges);
    expect(
      after.episodes.find(
        (item) => item.group_id === intent.humanTurn.namespace && item.role === 'ai',
      )!.content,
    ).toBe(content);
  });

  it('keeps remaining work time outside stable identity across replay', async () => {
    const first = await storage.saveAssistantFinalV2(intent, { remainingMs: 25000 });
    const before = await storage.readExtractionSnapshot();
    const replay = await storage.saveAssistantFinalV2(
      { ...intent, attemptIdHash: 'c'.repeat(64) },
      { remainingMs: 15000 },
    );
    expect(first.kind).toBe('committed');
    expect(replay.kind).toBe('committed_replay');
    const after = await storage.readExtractionSnapshot();
    expect(after.episodes).toEqual(before.episodes);
    const operation = (snapshot: typeof before) =>
      snapshot.automatic_operations_v1!.operations.find(
        (item) => item.identity.role === 'assistant',
      )!;
    expect(operation(after).identity).toEqual(operation(before).identity);
    expect(operation(after).descriptor).toEqual(operation(before).descriptor);
    const prior = operation(before);
    const current = operation(after);
    if (prior.state !== 'committed' || current.state !== 'committed')
      throw new Error('Expected committed assistant operations');
    expect(current.terminalReceipt).toEqual(prior.terminalReceipt);
  });

  it('rejects malformed work budgets before storage I/O', async () => {
    const spy = jest.spyOn(fs.promises, 'open');
    expect(await storage.saveAssistantFinalV2(intent, { remainingMs: 0 } as never)).toEqual({
      kind: 'decision',
      reason: 'invalid_input',
      eligibleFirstCommit: false,
    });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it.each([1, 2])(
    'handles phase %s acknowledgement arriving after the work budget',
    async (phase) => {
      const runner = storage as unknown as MutationRunner;
      const original = runner.runMutation.bind(storage) as MutationRunner['runMutation'];
      let writes = 0;
      const spy = jest.spyOn(runner, 'runMutation').mockImplementation(async function <T>(
        work: () => T | Promise<T>,
        options?: unknown,
      ): Promise<T> {
        const result = await original(work, options);
        writes++;
        if (writes === phase) await new Promise((resolve) => setTimeout(resolve, 1100));
        return result;
      });
      const result = await storage.saveAssistantFinalV2(intent, { remainingMs: 1000 });
      spy.mockRestore();
      const graph = await storage.readExtractionSnapshot();
      expect(graph.episodes.filter((item) => item.role === 'ai')).toHaveLength(1);
      const operation = graph.automatic_operations_v1!.operations.find(
        (item) => item.identity.role === 'assistant',
      )!;
      if (phase === 1) {
        expect(writes).toBe(1);
        expect(result).toEqual({
          kind: 'decision',
          reason: 'budget_exhausted',
          eligibleFirstCommit: false,
        });
        expect(operation.state).toBe('leased');
      } else {
        expect(writes).toBe(3);
        expect(result).toMatchObject({
          kind: 'committed',
          invocation: 'same_call_ack_recovered',
          eligibleFirstCommit: false,
          terminalReceipt: { kind: 'assistant_final_saved', persisted: true },
        });
        expect(operation.state).toBe('committed');
      }
    },
  );

  it('owns a detached intent before the first await and rejects forged fields before I/O', async () => {
    const original = intent.finalAssistant.content;
    const pending = storage.saveAssistantFinalV2(intent);
    intent.finalAssistant.content = 'Changed after method entry';
    expect(await pending).toMatchObject({ kind: 'committed', eligibleFirstCommit: false });
    expect(
      (await storage.readExtractionSnapshot()).episodes.find((item) => item.role === 'ai')!.content,
    ).toBe(original);
    const spy = jest.spyOn(fs.promises, 'open');
    try {
      expect(
        await storage.saveAssistantFinalV2({ ...intent, should_process: true } as never),
      ).toEqual({ kind: 'decision', reason: 'invalid_input', eligibleFirstCommit: false });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
