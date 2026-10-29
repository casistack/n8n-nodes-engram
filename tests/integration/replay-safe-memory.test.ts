import * as fs from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { performance } from 'perf_hooks';
import { AIMessage, HumanMessage, ToolMessage, SystemMessage } from '@langchain/core/messages';
import { GraphologyStorage } from '../../src/storage/GraphologyStorage';
import { EngramChatMemory, type EngramChatMemoryInput } from '../../src/memory/EngramChatMemory';
import type { EngramChatMessageHistory } from '../../src/memory/EngramChatMessageHistory';
import { captureReplaySafeHumanMemory } from '../../src/memory/ReplaySafeCapture';
import { seedAutomaticCaptureSubject } from '../helpers/automaticCaptureBackend';
import type { AutomaticCaptureBeginRequestV2 } from '../../src/schemas/AutomaticCapture.schema';
import { AutomaticWriteOwnerSchema } from '../../src/schemas/AutomaticClaim.schema';

describe('replay-safe Memory with actual persisted embedded capture', () => {
  let directory: string;
  let path: string;
  let storage: GraphologyStorage;
  let request: AutomaticCaptureBeginRequestV2;
  let binding: Awaited<ReturnType<typeof seedAutomaticCaptureSubject>>['binding'];

  beforeEach(async () => {
    directory = fs.mkdtempSync(join(tmpdir(), 'engram-replay-memory-'));
    path = join(directory, 'store.json');
    storage = new GraphologyStorage(path);
    await storage.initialize();
    ({ request, binding } = await seedAutomaticCaptureSubject(storage));
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('Unexpected provider call'));
  });
  afterEach(async () => {
    expect(global.fetch).not.toHaveBeenCalled();
    jest.restoreAllMocks();
    await storage.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  async function captured(wrapped = false) {
    const body = request.source.content;
    if (wrapped) {
      const prefix = 'Application 🧭\n';
      request.source.content = prefix + body + '\nApplication footer';
      request.source.applicationOwnedWrapper = true;
      request.source.humanRegion = { start: prefix.length, end: prefix.length + body.length };
    }
    const result = await captureReplaySafeHumanMemory(storage, request);
    expect(result).toMatchObject({
      status: 'first_capture_committed',
      should_process: true,
      sourcePersistence: 'persisted',
    });
    const graph = await storage.readExtractionSnapshot();
    const human = graph.episodes.find((episode) => episode.uuid === result.sourceId)!;
    const owner = AutomaticWriteOwnerSchema.parse(human.attributes.engram_write_owner_v1);
    const fields: EngramChatMemoryInput = {
      storage,
      groupId: request.namespace,
      captureLifecycle: 'replaySafeV2',
      processingAttemptHash: 'b'.repeat(64),
      currentHumanQuery: request.source.content,
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
      acceptedOnlyRetrieval: true,
      automaticMemory: {
        profileId: 'conservative',
        storeIdentity: owner.store,
        turnId: request.turn,
        capturedSourceId: human.uuid,
        actor: {
          namespace: request.namespace,
          issuer: request.issuer,
          actorReference: request.actorReference,
          ...(wrapped
            ? { applicationOwnedWrapper: true as const, humanRegion: request.source.humanRegion! }
            : {}),
        },
        ...(wrapped ? { rawHumanContent: body } : {}),
      },
    };
    return { fields, human, graph, result };
  }

  const tool = (id: string, content = 'Synthetic tool result') =>
    new ToolMessage({ content, tool_call_id: id });
  const draft = (id: string) =>
    new AIMessage({
      content: '',
      tool_calls: [{ id, name: 'synthetic_probe', args: { sample: true } }],
    });

  it('captures, loads and saves one final through normal Memory APIs without extracting it', async () => {
    const { fields, human, graph } = await captured();
    const memory = new EngramChatMemory(fields);
    const save = jest.spyOn(storage, 'saveAssistantFinalV2');
    const loaded = await memory.loadMemoryVariables({ input: request.source.content });
    expect(
      loaded.chat_history.filter(
        (message: { _getType(): string }) => message._getType() === 'human',
      ),
    ).toEqual([]);
    expect(
      loaded.chat_history.map((message: { content: string }) => message.content).join('\n'),
    ).toContain('concise explanations');
    const outcome = await memory.saveContextWithDelivery(
      { input: request.source.content },
      { output: 'Synthetic final response.' },
    );
    expect(outcome).toMatchObject({
      extraction: { status: 'disabled', reason: 'disabled' },
      replaySafe: {
        should_process: false,
        finalAssistant: { state: 'persisted', terminalReceipt: { kind: 'assistant_final_saved' } },
        audit: { state: 'not_requested' },
      },
    });
    expect(save).toHaveBeenCalledTimes(1);
    const after = await storage.readExtractionSnapshot();
    expect(after.episodes.filter((episode) => episode.role === 'human')).toEqual([human]);
    expect(
      after.episodes.filter((episode) => episode.role === 'ai').map((episode) => episode.content),
    ).toEqual(['Synthetic final response.']);
    expect(after.entities).toEqual(graph.entities);
    expect(after.edges).toEqual(graph.edges);
    expect(after.automatic_operations_v1?.operations).toHaveLength(2);
    expect(
      after.automatic_operations_v1?.operations.filter(
        (op) => op.version === 2 && op.identity.purpose === 'assistant_final_save',
      )[0].state,
    ).toBe('committed');
  });

  it('native bulk with tool draft/result converges on final receipt and excludes audit history', async () => {
    const { fields, graph } = await captured();
    const memory = new EngramChatMemory(fields);
    const save = jest.spyOn(storage, 'saveAssistantFinalV2');
    await memory.chatHistory.addMessages([
      new HumanMessage(request.source.content),
      draft('call-1'),
      tool('call-1'),
      new AIMessage('Tool-aware final.'),
    ]);
    const first = await storage.readExtractionSnapshot();
    const audits = first.episodes.filter((episode) => episode.attributes.engram_audit === true);
    expect(audits).toHaveLength(2);
    expect(
      audits.every(
        (episode) =>
          episode.role === 'system' &&
          episode.episode_kind === 'tool_output' &&
          episode.trust_level === 'unverified' &&
          episode.review_status === 'proposed',
      ),
    ).toBe(true);
    expect(
      audits
        .map(
          (episode) =>
            (episode.attributes.engram_message as { original_role: string }).original_role,
        )
        .sort(),
    ).toEqual(['ai', 'tool']);
    const replay = await memory.saveContextWithDelivery(
      { input: request.source.content },
      { output: 'Tool-aware final.' },
    );
    expect(replay).toMatchObject({
      written: 0,
      duplicates: 1,
      replaySafe: { finalAssistant: { state: 'persisted' } },
    });
    expect(save).toHaveBeenCalledTimes(2);
    expect((await storage.readExtractionSnapshot()).episodes).toEqual(first.episodes);
    expect(first.edges).toEqual(graph.edges);
    const loaded = await memory.loadMemoryVariablesWithDiagnostics({
      input: request.source.content,
    });
    expect(
      loaded.variables.chat_history
        .filter((message: { _getType(): string }) => message._getType() !== 'system')
        .map((message: { content: string }) => message.content),
    ).toEqual(['Tool-aware final.']);
    expect(loaded.diagnostics.history.excluded_provenance).toBeGreaterThanOrEqual(2);
  });

  it('assistant-only bulk uses configured exact human input and survives restart/changed processing hash replay', async () => {
    const { fields, graph } = await captured(true);
    const first = await new EngramChatMemory(fields).saveMessagesWithOutcome([
      new AIMessage('Wrapped-input final.'),
    ]);
    expect(first.replaySafe?.finalAssistant.state).toBe('persisted');
    const before = await storage.readExtractionSnapshot();
    await storage.close();
    storage = new GraphologyStorage(path);
    await storage.initialize();
    const captureReplay = await captureReplaySafeHumanMemory(storage, {
      ...request,
      attemptIdHash: 'c'.repeat(64),
    });
    expect(captureReplay).toMatchObject({ status: 'committed_replay', should_process: false });
    const again = await new EngramChatMemory({
      ...fields,
      storage,
      processingAttemptHash: 'd'.repeat(64),
    }).saveMessagesWithOutcome([new AIMessage('Wrapped-input final.')]);
    expect(again).toMatchObject({ written: 0, duplicates: 1 });
    expect(again.replaySafe?.finalAssistant).toEqual(first.replaySafe?.finalAssistant);
    const after = await storage.readExtractionSnapshot();
    expect(after.episodes).toEqual(before.episodes);
    expect(after.entities).toEqual(graph.entities);
    expect(after.edges).toEqual(graph.edges);
  });

  it('audit-only saves never create an assistant lease or reinsert the human', async () => {
    const { fields, graph } = await captured();
    const memory = new EngramChatMemory(fields);
    const save = jest.spyOn(storage, 'saveAssistantFinalV2');
    const result = await memory.saveMessagesWithOutcome([
      new SystemMessage('Synthetic operational note'),
      draft('audit-only'),
      tool('audit-only'),
    ]);
    expect(result).toMatchObject({
      replaySafe: {
        finalAssistant: { state: 'not_requested' },
        audit: { state: 'complete', requested: 3, confirmedNew: 3 },
      },
    });
    expect(save).not.toHaveBeenCalled();
    const after = await storage.readExtractionSnapshot();
    expect(after.episodes.filter((episode) => episode.role === 'human')).toEqual(graph.episodes);
    expect(after.automatic_operations_v1?.operations).toEqual(
      graph.automatic_operations_v1?.operations,
    );
    expect(after.edges).toEqual(graph.edges);
  });

  it('caller nested runtime mutations cannot rebind the parent or wrapper after Memory construction', async () => {
    const { fields, human } = await captured(true);
    const memory = new EngramChatMemory(fields);
    fields.automaticMemory!.actor.actorReference = 'mutated-external-actor';
    fields.automaticMemory!.actor.humanRegion!.start++;
    fields.automaticMemory!.actor.quoteRegions = [{ start: 0, end: 1 }];
    fields.automaticMemory!.capturedSourceId = randomUUID();
    fields.automaticMemory!.turnId = 'mutated-external-turn';
    fields.automaticMemory!.storeIdentity = '0'.repeat(64);
    fields.currentHumanQuery = 'mutated-external-input';
    const result = await memory.saveMessagesWithOutcome([
      new AIMessage('Bound original parent final.'),
    ]);
    expect(result.replaySafe?.finalAssistant.state).toBe('persisted');
    const graph = await storage.readExtractionSnapshot();
    expect(graph.episodes.filter((episode) => episode.role === 'human')).toEqual([human]);
    const final = graph.episodes.find((episode) => episode.role === 'ai')!;
    expect(JSON.stringify(final.attributes)).toContain(human.uuid);
    expect(JSON.stringify(final.attributes)).not.toContain('mutated-external');
  });

  it('caller extraction deadline mutation cannot extend the bound save deadline', async () => {
    const { fields } = await captured();
    fields.extractionPolicy = { mode: 'bounded', quality: 'durableTemporal', deadline_ms: 100 };
    const memory = new EngramChatMemory(fields);
    fields.extractionPolicy.deadline_ms = 120000;
    let now = 0;
    const clock = jest.spyOn(performance, 'now').mockImplementation(() => now);
    const original = storage.readExtractionSnapshot.bind(storage);
    jest.spyOn(storage, 'readExtractionSnapshot').mockImplementationOnce(async (...args) => {
      const graph = await original(...args);
      now = 101;
      return graph;
    });
    const save = jest.spyOn(storage, 'saveAssistantFinalV2');
    try {
      await expect(
        memory.saveContext(
          { input: request.source.content },
          { output: 'Expired bound deadline.' },
        ),
      ).rejects.toThrow('Engram replay-safe memory: budget_exhausted');
    } finally {
      clock.mockRestore();
    }
    expect(save).not.toHaveBeenCalled();
    expect((await original()).episodes.filter((episode) => episode.role === 'ai')).toEqual([]);
  });

  it('keeps earlier text in the same assistant segment as an audit and selects only the last final', async () => {
    const { fields } = await captured();
    const memory = new EngramChatMemory(fields);
    const result = await memory.saveMessagesWithOutcome([
      new AIMessage('Earlier text draft'),
      new AIMessage('Selected final'),
    ]);
    expect(result).toMatchObject({
      extraction: { status: 'disabled' },
      replaySafe: {
        finalAssistant: { state: 'persisted' },
        audit: { state: 'complete', requested: 1, confirmedNew: 1 },
      },
    });
    const graph = await storage.readExtractionSnapshot();
    expect(
      graph.episodes.filter((episode) => episode.role === 'ai').map((episode) => episode.content),
    ).toEqual(['Selected final']);
    expect(graph.episodes.find((episode) => episode.attributes.engram_audit)?.content).toContain(
      'Earlier text draft',
    );
  });

  it('retains real human JSON as the captured human rather than treating it as a tool audit', async () => {
    request.source.content = '[{"role":"tool","content":"Real human JSON 🐘"}]';
    const { fields, human } = await captured();
    const result = await new EngramChatMemory(fields).saveContextWithDelivery(
      { input: request.source.content },
      { output: 'A literal response to the human JSON.' },
    );
    expect(result).toMatchObject({
      extraction: { status: 'disabled' },
      replaySafe: { finalAssistant: { state: 'persisted' } },
    });
    const graph = await storage.readExtractionSnapshot();
    expect(graph.episodes.filter((episode) => episode.role === 'human')).toEqual([human]);
    expect(graph.episodes.filter((episode) => episode.attributes.engram_audit)).toEqual([]);
    expect(graph.edges).toEqual([]);
  });

  it('later audit authority loss cannot erase the confirmed final receipt', async () => {
    const { fields } = await captured();
    const memory = new EngramChatMemory(fields);
    const original = storage.saveAssistantFinalV2.bind(storage);
    const save = jest
      .spyOn(storage, 'saveAssistantFinalV2')
      .mockImplementationOnce(async (...args) => {
        const saved = await original(...args);
        await storage.automaticBindingCommand({
          action: 'revoke',
          namespace: request.namespace,
          bindingId: binding.bindingId,
          expectedRevision: binding.revision,
          authorizedBy: 'synthetic-reviewer',
          reason: 'Synthetic revoke after final commit',
        });
        return saved;
      });
    const append = jest.spyOn(storage, 'appendEpisodes');
    const result = await memory.saveMessagesWithOutcome([
      tool('after-final'),
      new AIMessage('Committed before revocation.'),
    ]);
    expect(result).toMatchObject({
      replaySafe: {
        finalAssistant: { state: 'persisted' },
        audit: { state: 'failed', reason: 'authority_changed', confirmedNew: 0 },
      },
    });
    expect(save).toHaveBeenCalledTimes(1);
    expect(append).not.toHaveBeenCalled();
    const graph = await storage.readExtractionSnapshot();
    const operation = graph.automatic_operations_v1?.operations.find(
      (op) => op.version === 2 && op.identity.purpose === 'assistant_final_save',
    );
    if (
      operation?.version !== 2 ||
      operation.state !== 'committed' ||
      result.replaySafe?.finalAssistant.state !== 'persisted'
    )
      throw new Error('Expected actual committed final');
    expect(result.replaySafe.finalAssistant.terminalReceipt).toEqual(operation.terminalReceipt);
    expect(graph.episodes.filter((episode) => episode.role === 'ai')).toHaveLength(1);
  });

  it.each(['revoked', 'missing', 'mapping', 'mapping_bounds', 'actor', 'changed_input'] as const)(
    'rejects %s parent before modeled continuation or final saving',
    async (kind) => {
      const { fields } = await captured(true);
      if (kind === 'revoked')
        await storage.automaticBindingCommand({
          action: 'revoke',
          namespace: request.namespace,
          bindingId: binding.bindingId,
          expectedRevision: binding.revision,
          authorizedBy: 'synthetic-reviewer',
          reason: 'Synthetic revoke',
        });
      if (kind === 'missing')
        fields.automaticMemory = { ...fields.automaticMemory!, capturedSourceId: randomUUID() };
      if (kind === 'mapping')
        fields.automaticMemory = {
          ...fields.automaticMemory!,
          rawHumanContent: 'A different mapped assertion',
        };
      if (kind === 'mapping_bounds')
        fields.automaticMemory = {
          ...fields.automaticMemory!,
          actor: {
            ...fields.automaticMemory!.actor,
            humanRegion: {
              start: request.source.humanRegion!.start + 1,
              end: request.source.humanRegion!.end,
            },
          },
        };
      if (kind === 'actor')
        fields.automaticMemory = {
          ...fields.automaticMemory!,
          actor: { ...fields.automaticMemory!.actor, actorReference: 'another-actor' },
        };
      const memory = new EngramChatMemory(fields);
      const model = jest.fn();
      const save = jest.spyOn(storage, 'saveAssistantFinalV2');
      const run = async () => {
        await memory.loadMemoryVariables({
          input: kind === 'changed_input' ? 'Different human input' : request.source.content,
        });
        model();
      };
      await expect(run()).rejects.toThrow(/Engram (?:automatic|replay-safe memory)/u);
      expect(model).not.toHaveBeenCalled();
      expect(save).not.toHaveBeenCalled();
    },
  );

  it('revalidates authority after load and before final save', async () => {
    const { fields } = await captured();
    const memory = new EngramChatMemory(fields);
    await memory.loadMemoryVariables({ input: request.source.content });
    await storage.automaticBindingCommand({
      action: 'revoke',
      namespace: request.namespace,
      bindingId: binding.bindingId,
      expectedRevision: binding.revision,
      authorizedBy: 'synthetic-reviewer',
      reason: 'Synthetic revoke after load',
    });
    const save = jest.spyOn(storage, 'saveAssistantFinalV2');
    await expect(
      memory.saveContext({ input: request.source.content }, { output: 'Must not persist.' }),
    ).rejects.toThrow(/Engram replay-safe memory/u);
    expect(save).not.toHaveBeenCalled();
    expect(
      (await storage.readExtractionSnapshot()).episodes.filter((episode) => episode.role === 'ai'),
    ).toEqual([]);
  });

  it.each(['missing', 'revoked', 'mismapped'] as const)(
    'direct history %s parent fails before any recent-episode scan',
    async (kind) => {
      const { fields } = await captured(true);
      if (kind === 'missing')
        fields.automaticMemory = { ...fields.automaticMemory!, capturedSourceId: randomUUID() };
      if (kind === 'mismapped')
        fields.automaticMemory = {
          ...fields.automaticMemory!,
          rawHumanContent: 'Wrong configured mapped source',
        };
      if (kind === 'revoked')
        await storage.automaticBindingCommand({
          action: 'revoke',
          namespace: request.namespace,
          bindingId: binding.bindingId,
          expectedRevision: binding.revision,
          authorizedBy: 'synthetic-reviewer',
          reason: 'Synthetic direct-history revoke',
        });
      const memory = new EngramChatMemory(fields);
      const recent = jest.spyOn(storage, 'getRecentEpisodes');
      await expect(memory.chatHistory.getMessages()).rejects.toThrow(
        /Engram (?:automatic|replay-safe memory)/u,
      );
      await expect(
        (memory.chatHistory as EngramChatMessageHistory).getMessagesWithDiagnostics(),
      ).rejects.toThrow(/Engram (?:automatic|replay-safe memory)/u);
      expect(recent).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, ''])(
    'new mode requires a configured current human query (%p)',
    async (query) => {
      const { fields } = await captured();
      const recent = jest.spyOn(storage, 'getRecentEpisodes');
      expect(() => new EngramChatMemory({ ...fields, currentHumanQuery: query })).toThrow(
        /^Engram replay-safe memory:/u,
      );
      expect(recent).not.toHaveBeenCalled();
    },
  );

  it('governed child and direct history retain bound policy after caller disables its filter', async () => {
    const { fields } = await captured();
    fields.retrievalMode = 'current';
    const memory = new EngramChatMemory(fields);
    await memory.saveMessagesWithOutcome([
      draft('immutable-filter'),
      tool('immutable-filter', 'Must remain excluded audit payload'),
      new AIMessage('Visible final with immutable filter.'),
    ]);
    fields.policy!.historyFilter = 'off';
    fields.policy!.finalTurnWrites = false;
    // No prior load: the constructor must already exclude its captured parent.
    expect((await memory.chatHistory.getMessages()).map((message) => message.content)).toEqual([
      'Visible final with immutable filter.',
    ]);
    const loaded = await memory.loadMemoryVariables({ input: request.source.content });
    const history = loaded.chat_history as Array<{ content: string; _getType(): string }>;
    expect(history.filter((message) => message._getType() === 'human')).toEqual([]);
    expect(history.map((message) => message.content).join('\n')).not.toContain(
      'Must remain excluded audit payload',
    );
    expect(
      history.filter((message) => message._getType() === 'ai').map((message) => message.content),
    ).toEqual(['Visible final with immutable filter.']);
  });

  it('direct saveContextWithOutcome requires the explicit named human input without legacy fallback', async () => {
    const { fields, graph } = await captured();
    const memory = new EngramChatMemory(fields);
    const save = jest.spyOn(storage, 'saveAssistantFinalV2');
    const append = jest.spyOn(storage, 'appendEpisodes');
    await expect(
      memory.saveContextWithOutcome(
        { anotherField: request.source.content },
        { output: 'Must not use legacy input fallback.' },
      ),
    ).rejects.toThrow(/^Engram replay-safe memory:/u);
    expect(save).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
    expect((await storage.readExtractionSnapshot()).episodes).toEqual(graph.episodes);
  });

  it('load and saveContext reject proxies without executing arbitrary traps', async () => {
    const { fields, graph } = await captured();
    const memory = new EngramChatMemory(fields);
    let traps = 0;
    const proxy = new Proxy(
      {},
      {
        ownKeys() {
          traps++;
          throw new Error('private ownKeys');
        },
        getPrototypeOf() {
          traps++;
          throw new Error('private prototype');
        },
        getOwnPropertyDescriptor() {
          traps++;
          throw new Error('private descriptor');
        },
        get() {
          traps++;
          throw new Error('private getter');
        },
      },
    );
    const save = jest.spyOn(storage, 'saveAssistantFinalV2');
    const append = jest.spyOn(storage, 'appendEpisodes');
    await expect(memory.loadMemoryVariables(proxy)).rejects.toThrow(/^Engram replay-safe memory:/u);
    await expect(memory.saveContext(proxy, { output: 'Must not persist.' })).rejects.toThrow(
      /^Engram replay-safe memory:/u,
    );
    await expect(memory.saveContext({ input: request.source.content }, proxy)).rejects.toThrow(
      /^Engram replay-safe memory:/u,
    );
    expect(traps).toBe(0);
    expect(save).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
    expect((await storage.readExtractionSnapshot()).episodes).toEqual(graph.episodes);
  });

  it.each([null, []])(
    'load and saveContext reject non-object turn wrapper %p before any save',
    async (invalid) => {
      const { fields } = await captured();
      const memory = new EngramChatMemory(fields);
      const save = jest.spyOn(storage, 'saveAssistantFinalV2');
      await expect(memory.loadMemoryVariables(invalid as never)).rejects.toThrow(
        /^Engram replay-safe memory:/u,
      );
      await expect(
        memory.saveContext(invalid as never, { output: 'Must not persist.' }),
      ).rejects.toThrow(/^Engram replay-safe memory:/u);
      expect(save).not.toHaveBeenCalled();
    },
  );

  it('33 optional audits report actual requested capacity while preserving one confirmed final', async () => {
    const { fields } = await captured();
    const memory = new EngramChatMemory(fields);
    const save = jest.spyOn(storage, 'saveAssistantFinalV2');
    const result = await memory.saveMessagesWithOutcome([
      ...Array.from({ length: 33 }, (_, i) => tool(`capacity-${i}`)),
      new AIMessage('Capacity-independent final.'),
    ]);
    expect(result).toMatchObject({
      replaySafe: {
        finalAssistant: { state: 'persisted' },
        audit: { state: 'failed', requested: 33, confirmedNew: 0, reason: 'capacity' },
      },
    });
    expect(save).toHaveBeenCalledTimes(1);
    const after = await storage.readExtractionSnapshot();
    expect(after.episodes.filter((episode) => episode.attributes.engram_audit)).toHaveLength(0);
    expect(after.episodes.filter((episode) => episode.role === 'ai')).toHaveLength(1);
  });

  it('backend in-progress defers the final and skips audits without retry or provider work', async () => {
    const { fields, graph } = await captured();
    const memory = new EngramChatMemory(fields);
    const save = jest
      .spyOn(storage, 'saveAssistantFinalV2')
      .mockResolvedValue({ kind: 'decision', reason: 'in_progress', eligibleFirstCommit: false });
    const append = jest.spyOn(storage, 'appendEpisodes');
    const begin = jest.spyOn(storage, 'beginAndClaimAutomaticCaptureV2');
    const result = await memory.saveMessagesWithOutcome([
      tool('pending-final'),
      new AIMessage('Pending final must not reapply.'),
    ]);
    expect(result).toMatchObject({
      written: 0,
      duplicates: 0,
      extraction: { status: 'disabled' },
      replaySafe: {
        should_process: false,
        finalAssistant: { state: 'deferred', reason: 'in_progress' },
        audit: { state: 'failed', requested: 1, confirmedNew: 0, reason: 'interrupted' },
      },
    });
    expect(save).toHaveBeenCalledTimes(1);
    expect(append).not.toHaveBeenCalled();
    expect(begin).not.toHaveBeenCalled();
    expect((await storage.readExtractionSnapshot()).episodes).toEqual(graph.episodes);
  });

  it.each(['cancelled_replay', 'legacy_unconfirmed', 'source_only_unconfirmed'] as const)(
    'backend %s ownership denies continuation and optional writes',
    async (reason) => {
      const { fields, graph } = await captured();
      const memory = new EngramChatMemory(fields);
      const save = jest
        .spyOn(storage, 'saveAssistantFinalV2')
        .mockResolvedValue({ kind: 'decision', reason, eligibleFirstCommit: false });
      const append = jest.spyOn(storage, 'appendEpisodes');
      await expect(
        memory.saveMessagesWithOutcome([
          tool('denied-final'),
          new AIMessage('Denied final must not write.'),
        ]),
      ).rejects.toThrow('Engram replay-safe memory: final_not_authorized');
      expect(save).toHaveBeenCalledTimes(1);
      expect(append).not.toHaveBeenCalled();
      expect((await storage.readExtractionSnapshot()).episodes).toEqual(graph.episodes);
    },
  );

  it.each(['throw_before', 'partial_ack', 'mismatch_ack', 'throw_after'] as const)(
    'optional audit %s preserves actual final receipt without retry',
    async (fault) => {
      const { fields } = await captured();
      const memory = new EngramChatMemory(fields);
      const save = jest.spyOn(storage, 'saveAssistantFinalV2');
      const original = storage.appendEpisodes.bind(storage);
      const append = jest
        .spyOn(storage, 'appendEpisodes')
        .mockImplementationOnce(async (inputs) => {
          if (fault === 'throw_before') throw new Error('private audit failure');
          const results = await original(fault === 'partial_ack' ? inputs.slice(0, 1) : inputs);
          if (fault === 'throw_after') throw new Error('private acknowledgement failure');
          if (fault === 'mismatch_ack')
            return [
              results[0],
              {
                ...results[1],
                episode: {
                  ...results[1].episode,
                  idempotency_key: 'mismatched-audit-acknowledgement',
                },
              },
            ];
          return results;
        });
      const result = await memory.saveMessagesWithOutcome([
        tool('fault-1'),
        tool('fault-2'),
        new AIMessage('Confirmed final survives optional audits.'),
      ]);
      expect(result.replaySafe?.finalAssistant.state).toBe('persisted');
      expect(result.extraction).toMatchObject({ status: 'disabled', reason: 'disabled' });
      expect(result.replaySafe?.audit).toMatchObject({
        state: 'unknown',
        requested: 2,
        confirmedNew: fault === 'partial_ack' || fault === 'mismatch_ack' ? 1 : 0,
        unconfirmed: fault === 'partial_ack' || fault === 'mismatch_ack' ? 1 : 2,
        reason: 'acknowledgement_unknown',
      });
      expect(save).toHaveBeenCalledTimes(1);
      expect(append).toHaveBeenCalledTimes(1);
      const actual = await storage.readExtractionSnapshot();
      const operation = actual.automatic_operations_v1?.operations.find(
        (op) => op.version === 2 && op.identity.purpose === 'assistant_final_save',
      );
      expect(operation?.state).toBe('committed');
      if (
        result.replaySafe?.finalAssistant.state === 'persisted' &&
        operation?.version === 2 &&
        operation.state === 'committed'
      )
        expect(result.replaySafe.finalAssistant.terminalReceipt).toEqual(operation.terminalReceipt);
      expect(actual.episodes.filter((episode) => episode.attributes.engram_audit)).toHaveLength(
        fault === 'throw_before' ? 0 : fault === 'partial_ack' ? 1 : 2,
      );
      expect(JSON.stringify(result)).not.toContain('private');
    },
  );

  it('multiple human-separated final segments fail before any final or audit write', async () => {
    const { fields, graph } = await captured();
    const memory = new EngramChatMemory(fields);
    const save = jest.spyOn(storage, 'saveAssistantFinalV2');
    const append = jest.spyOn(storage, 'appendEpisodes');
    await expect(
      memory.saveMessagesWithOutcome([
        new AIMessage('Previous segment final'),
        new HumanMessage(request.source.content),
        new AIMessage('Current segment final'),
      ]),
    ).rejects.toThrow('Engram replay-safe memory: invalid_current_turn');
    expect(save).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
    expect((await storage.readExtractionSnapshot()).episodes).toEqual(graph.episodes);
  });

  it('absence of lifecycle keeps ordinary legacy saveContext behavior', async () => {
    const groupId = `legacy-${randomUUID()}`;
    const save = jest.spyOn(storage, 'saveAssistantFinalV2');
    const memory = new EngramChatMemory({ storage, groupId, returnMessages: true });
    await memory.saveContext({ input: 'Legacy human' }, { output: 'Legacy assistant' });
    const episodes = await storage.listEpisodes(groupId, { sort_order: 'asc' });
    expect(episodes.map((episode) => [episode.role, episode.content])).toEqual([
      ['human', 'Legacy human'],
      ['ai', 'Legacy assistant'],
    ]);
    expect(
      episodes.every(
        (episode) =>
          !Object.prototype.hasOwnProperty.call(episode.attributes, 'engram_write_owner_v2'),
      ),
    ).toBe(true);
    expect(save).not.toHaveBeenCalled();
  });
});
