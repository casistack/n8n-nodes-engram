import { randomUUID } from 'crypto';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import neo4j from 'neo4j-driver';
import { Neo4jStorage } from '../../src/storage/Neo4jStorage';
import { EngramChatMemory, type EngramChatMemoryInput } from '../../src/memory/EngramChatMemory';
import { captureReplaySafeHumanMemory } from '../../src/memory/ReplaySafeCapture';
import { seedAutomaticCaptureSubject } from '../helpers/automaticCaptureBackend';
import { AutomaticWriteOwnerSchema } from '../../src/schemas/AutomaticClaim.schema';

jest.setTimeout(60_000);
const describeNeo = process.env.NEO4J_TEST_URI ? describe : describe.skip;
const uri = process.env.NEO4J_TEST_URI;
const username = process.env.NEO4J_TEST_USERNAME ?? 'neo4j';
const password = process.env.NEO4J_TEST_PASSWORD ?? 'password';
const database = process.env.NEO4J_TEST_DATABASE ?? 'neo4j';

describeNeo('replay-safe Memory through actual Neo4j adapters', () => {
  let storage: Neo4jStorage;
  let fixture: Awaited<ReturnType<typeof seedAutomaticCaptureSubject>>;
  let fields: EngramChatMemoryInput;
  let namespace: string;
  let initialized: boolean;

  beforeEach(async () => {
    if (!uri) throw new Error('NEO4J_TEST_URI required');
    initialized = false;
    storage = new Neo4jStorage(uri, username, password, database);
    await storage.initialize();
    initialized = true;
    namespace = `neo-memory-${randomUUID()}`;
    fixture = await seedAutomaticCaptureSubject(storage, namespace);
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('Unexpected provider call'));
    const captured = await captureReplaySafeHumanMemory(storage, fixture.request);
    expect(captured).toMatchObject({ status: 'first_capture_committed', should_process: true });
    const graph = await storage.readExtractionSnapshot(namespace);
    const human = graph.episodes.find((episode) => episode.uuid === captured.sourceId)!;
    const owner = AutomaticWriteOwnerSchema.parse(human.attributes.engram_write_owner_v1);
    fields = {
      storage,
      groupId: namespace,
      captureLifecycle: 'replaySafeV2',
      processingAttemptHash: 'b'.repeat(64),
      currentHumanQuery: fixture.request.source.content,
      extractAi: false,
      extractSystemTool: false,
      enableExtraction: true,
      llmConfig: {
        apiKey: 'synthetic-unused',
        baseUrl: 'https://provider.test/v1',
        model: 'must-not-be-called',
      },
      extractionPolicy: { mode: 'bounded', quality: 'durableTemporal' },
      policy: { finalTurnWrites: true, storeToolAudit: true, historyFilter: 'provenance' },
      returnMessages: true,
      contextWindow: 10,
      minRelevanceScore: 0,
      automaticMemory: {
        profileId: 'conservative',
        storeIdentity: owner.store,
        turnId: fixture.request.turn,
        capturedSourceId: human.uuid,
        actor: {
          namespace,
          issuer: fixture.request.issuer,
          actorReference: fixture.request.actorReference,
        },
      },
    };
  });
  afterEach(async () => {
    if (jest.isMockFunction(global.fetch)) expect(global.fetch).not.toHaveBeenCalled();
    jest.restoreAllMocks();
    // Native fixture cleanup only: generic deletion correctly protects owned
    // operation sources. Never clear the shared database or another namespace.
    if (storage) {
      await storage.close();
      if (initialized && namespace && uri) {
        const driver = neo4j.driver(uri, neo4j.auth.basic(username, password));
        const session = driver.session({ database });
        try {
          await session.executeWrite(async (tx) => {
            await tx.run('MATCH (op:AutomaticOperation {namespace:$namespace}) DETACH DELETE op', {
              namespace,
            });
            await tx.run(
              'MATCH (n) WHERE n.group_id=$namespace AND (n:Entity OR n:Episode) DETACH DELETE n',
              { namespace },
            );
            await tx.run('MATCH (lock:EpisodeGroupLock {group_id:$namespace}) DELETE lock', {
              namespace,
            });
          });
        } finally {
          await session.close();
          await driver.close();
        }
      }
    }
  });

  it('actual capture -> load -> saveContext commits a write-only assistant receipt with extraction disabled', async () => {
    const before = await storage.readExtractionSnapshot(namespace);
    const memory = new EngramChatMemory(fields);
    const loaded = await memory.loadMemoryVariables({ input: fixture.request.source.content });
    expect(
      loaded.chat_history.some((message: { _getType(): string }) => message._getType() === 'human'),
    ).toBe(false);
    expect(
      loaded.chat_history.map((message: { content: string }) => message.content).join('\n'),
    ).toContain('concise explanations');
    const result = await memory.saveContextWithDelivery(
      { input: fixture.request.source.content },
      { output: 'Neo synthetic final.' },
    );
    expect(result).toMatchObject({
      extraction: { status: 'disabled', reason: 'disabled' },
      replaySafe: {
        should_process: false,
        finalAssistant: { state: 'persisted', terminalReceipt: { kind: 'assistant_final_saved' } },
      },
    });
    const after = await storage.readExtractionSnapshot(namespace);
    expect(after.entities).toEqual(before.entities);
    expect(after.edges).toEqual(before.edges);
    expect(
      after.episodes.filter((episode) => episode.role === 'ai').map((episode) => episode.content),
    ).toEqual(['Neo synthetic final.']);
    expect(after.episodes.filter((episode) => episode.role === 'human')).toEqual(before.episodes);
    expect(after.automatic_operations_v1?.operations).toHaveLength(2);
  });

  it('native bulk tool draft/result and independent attempt replay converge without extra sources', async () => {
    const memory = new EngramChatMemory(fields);
    await memory.chatHistory.addMessages([
      new HumanMessage(fixture.request.source.content),
      new AIMessage({
        content: '',
        tool_calls: [{ id: 'neo-call', name: 'synthetic_probe', args: { sample: true } }],
      }),
      new ToolMessage({ content: 'Neo tool result', tool_call_id: 'neo-call' }),
      new AIMessage('Neo tool-aware final.'),
    ]);
    const first = await storage.readExtractionSnapshot(namespace);
    expect(first.episodes.filter((episode) => episode.attributes.engram_audit)).toHaveLength(2);
    const replay = await new EngramChatMemory({
      ...fields,
      processingAttemptHash: 'c'.repeat(64),
    }).saveMessagesWithOutcome([new AIMessage('Neo tool-aware final.')]);
    expect(replay).toMatchObject({
      written: 0,
      duplicates: 1,
      extraction: { status: 'disabled' },
      replaySafe: { finalAssistant: { state: 'persisted' } },
    });
    expect((await storage.readExtractionSnapshot(namespace)).episodes).toEqual(first.episodes);
    const loaded = await memory.loadMemoryVariables({ input: fixture.request.source.content });
    expect(
      loaded.chat_history
        .filter((message: { _getType(): string }) => message._getType() !== 'system')
        .map((message: { content: string }) => message.content),
    ).toEqual(['Neo tool-aware final.']);
  });

  it('revoked actual parent denies Memory load before model execution and preserves historical receipt separately', async () => {
    const memory = new EngramChatMemory(fields);
    await storage.automaticBindingCommand({
      action: 'revoke',
      namespace,
      bindingId: fixture.binding.bindingId,
      expectedRevision: fixture.binding.revision,
      authorizedBy: 'synthetic-reviewer',
      reason: 'Synthetic Neo revocation',
    });
    const model = jest.fn();
    const save = jest.spyOn(storage, 'saveAssistantFinalV2');
    const run = async () => {
      await memory.loadMemoryVariables({ input: fixture.request.source.content });
      model();
    };
    await expect(run()).rejects.toThrow(/Engram (?:automatic|replay-safe memory)/u);
    expect(model).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    const read = await storage.getAutomaticCaptureOutcomeV2({
      version: 2,
      namespace,
      issuer: fixture.request.issuer,
      actorReference: fixture.request.actorReference,
      turn: fixture.request.turn,
      role: 'human',
    });
    expect(read).toMatchObject({
      status: 'committed_replay',
      should_process: false,
      receiptSummary: { persisted: true },
    });
    expect(read.currentAuthority).not.toBe('active');
    expect(
      (await storage.readExtractionSnapshot(namespace)).episodes.filter(
        (episode) => episode.role === 'ai',
      ),
    ).toHaveLength(0);
  });

  it('a new backend instance and processing hash read the actual same final source/terminal receipt', async () => {
    const first = await new EngramChatMemory(fields).saveMessagesWithOutcome([
      new AIMessage('Neo cross-instance final.'),
    ]);
    const before = await storage.readExtractionSnapshot(namespace);
    await storage.close();
    if (!uri) throw new Error('NEO4J_TEST_URI required');
    storage = new Neo4jStorage(uri, username, password, database);
    await storage.initialize();
    const capturedAgain = await captureReplaySafeHumanMemory(storage, {
      ...fixture.request,
      attemptIdHash: 'd'.repeat(64),
    });
    expect(capturedAgain).toMatchObject({ status: 'committed_replay', should_process: false });
    const result = await new EngramChatMemory({
      ...fields,
      storage,
      processingAttemptHash: 'e'.repeat(64),
    }).saveMessagesWithOutcome([new AIMessage('Neo cross-instance final.')]);
    expect(result).toMatchObject({ written: 0, duplicates: 1, extraction: { status: 'disabled' } });
    expect(result.replaySafe?.finalAssistant).toEqual(first.replaySafe?.finalAssistant);
    expect((await storage.readExtractionSnapshot(namespace)).episodes).toEqual(before.episodes);
  });
});
