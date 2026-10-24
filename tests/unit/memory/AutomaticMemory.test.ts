import { HumanMessage, AIMessage, ToolMessage } from '@langchain/core/messages';
import { GraphologyStorage } from '../../../src/storage/GraphologyStorage';
import { EngramChatMemory, type EngramChatMemoryInput } from '../../../src/memory/EngramChatMemory';
import { captureHumanMemory } from '../../../src/memory/AutomaticCapture';

const text = 'I prefer concise explanations.';
describe('automatic memory entry-point ownership and useful recall', () => {
  let storage: GraphologyStorage;
  let fields: EngramChatMemoryInput;
  beforeEach(async () => {
    storage = new GraphologyStorage();
    await storage.initialize();
    const subject = await storage.addEntity({
      group_id: 'scope',
      name: 'Verified subject',
      entity_type: 'person',
      summary: '',
      attributes: {
        engram_extraction: {
          version: 2,
          source: 'manual',
          confidence: null,
          review_status: 'accepted',
          threshold_decision: 'manually_reviewed',
          extracted_at: new Date().toISOString(),
          episode_uuids: [],
          reviewed_at: new Date().toISOString(),
          reviewed_by: 'operator',
        },
      },
    });
    await storage.automaticBindingCommand!({
      action: 'create',
      namespace: 'scope',
      issuer: 'app',
      actorReference: 'actor',
      subjectId: subject.uuid,
      authorizedBy: 'operator',
      reason: 'verified upstream identity',
    });
    fields = {
      storage,
      groupId: 'scope',
      enableExtraction: true,
      extractAi: false,
      extractSystemTool: false,
      llmConfig: { apiKey: 'synthetic', baseUrl: 'https://provider.test/v1', model: 'unused' },
      extractionPolicy: { mode: 'bounded', quality: 'durableTemporal' },
      policy: { finalTurnWrites: true, storeToolAudit: true, historyFilter: 'provenance' },
      episodeMetadata: { trust_level: 'standard', review_status: 'accepted' },
      automaticMemory: {
        profileId: 'conservative',
        actor: { namespace: 'scope', issuer: 'app', actorReference: 'actor' },
        turnId: 'turn-1',
        storeIdentity: 'a'.repeat(64),
      },
      retrievalMode: 'current',
      acceptedOnlyRetrieval: true,
      minRelevanceScore: 0,
      contextWindow: 2,
      returnMessages: true,
    };
    jest
      .spyOn(global, 'fetch')
      .mockRejectedValue(new Error('Automatic literal extraction must not call provider'));
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await storage.close();
  });
  it.each(['normal', 'bulk'])(
    'writes one attributed accepted preference through %s',
    async (mode) => {
      const memory = new EngramChatMemory(fields);
      if (mode === 'normal')
        await memory.saveContextWithOutcome({ input: text }, { output: 'Understood.' });
      else
        await memory.saveMessagesWithOutcome([
          new HumanMessage(text),
          new AIMessage({
            content: '',
            tool_calls: [{ id: 'tool-1', name: 'calculator', args: {}, type: 'tool_call' }],
          }),
          new ToolMessage({ content: '4', tool_call_id: 'tool-1' }),
          new AIMessage('Understood.'),
        ]);
      const graph = await storage.exportGraph('scope');
      expect(graph.edges).toHaveLength(1);
      expect(graph.edges[0].fact).toBe(text);
      expect(graph.edges[0].attributes.engram_extraction).toMatchObject({
        source: 'policy',
        review_status: 'accepted',
      });
      expect(graph.episodes.filter((ep) => ep.role === 'human')).toHaveLength(1);
      expect(graph.episodes.filter((ep) => ep.episode_kind === 'assistant_reply')).toHaveLength(1);
      expect(global.fetch).not.toHaveBeenCalled();
    },
  );
  it.each(['current', 'legacy'] as const)(
    'preserves negative preference polarity in %s graph context',
    async (retrievalMode) => {
      await new EngramChatMemory(fields).saveContextWithOutcome(
        { input: 'I do not like long explanations.' },
        { output: 'Understood.' },
      );
      for (let i = 0; i < 3; i++)
        await storage.addEpisode({
          group_id: 'scope',
          content: `Unrelated turn ${i}`,
          role: 'human',
          reference_time: new Date().toISOString(),
        });
      const result = await new EngramChatMemory({
        ...fields,
        retrievalMode,
      }).loadMemoryVariablesWithDiagnostics({ input: 'explanations' });
      const context = (
        result.variables.chat_history as Array<{ content: unknown; _getType(): string }>
      )
        .filter((message) => message._getType() === 'system')
        .map((message) => message.content)
        .join(' ');
      expect(context).toContain('I do not like long explanations.');
      expect(context).not.toContain('preference_value');
    },
  );
  it.each(['current', 'legacy'] as const)(
    'suppresses current personalization for opposite pending claims in %s context',
    async (retrievalMode) => {
      await new EngramChatMemory(fields).saveContextWithOutcome(
        { input: text },
        { output: 'Understood.' },
      );
      await new EngramChatMemory({
        ...fields,
        automaticMemory: { ...fields.automaticMemory!, turnId: 'turn-2' },
      }).saveContextWithOutcome(
        { input: 'I do not like concise explanations.' },
        { output: 'Understood.' },
      );
      const graph = await storage.exportGraph('scope');
      expect(graph.edges).toHaveLength(2);
      expect(
        graph.edges
          .map(
            (edge) =>
              (edge.attributes.engram_extraction as { review_status: string }).review_status,
          )
          .sort(),
      ).toEqual(['accepted', 'proposed']);
      for (let i = 0; i < 3; i++)
        await storage.addEpisode({
          group_id: 'scope',
          content: `Unrelated turn ${i}`,
          role: 'human',
          reference_time: new Date().toISOString(),
        });
      const result = await new EngramChatMemory({
        ...fields,
        retrievalMode,
      }).loadMemoryVariablesWithDiagnostics({ input: 'explanations' });
      const context = (
        result.variables.chat_history as Array<{ content: unknown; _getType(): string }>
      )
        .filter((message) => message._getType() === 'system')
        .map((message) => message.content)
        .join(' ');
      expect(context).not.toContain('concise explanations');
    },
  );
  it('deduplicates replay and rejects the same turn with changed human content', async () => {
    const memory = new EngramChatMemory(fields);
    await memory.saveContextWithOutcome({ input: text }, { output: 'Understood.' });
    await memory.saveContextWithOutcome({ input: text }, { output: 'Understood.' });
    expect((await storage.exportGraph('scope')).episodes).toHaveLength(2);
    await expect(
      memory.saveContextWithOutcome({ input: 'I prefer English.' }, { output: 'Understood.' }),
    ).rejects.toThrow();
    expect((await storage.exportGraph('scope')).edges).toHaveLength(1);
  });
  it('captures once before the agent and stores only its final assistant afterwards', async () => {
    const captured = await captureHumanMemory(fields, text);
    expect(captured.acknowledgement).toBe('facts_accepted');
    const memory = new EngramChatMemory({
      ...fields,
      automaticMemory: { ...fields.automaticMemory!, capturedSourceId: captured.sourceId },
    });
    await memory.saveContextWithOutcome({ input: text }, { output: 'Understood.' });
    const graph = await storage.exportGraph('scope');
    expect(graph.episodes.map((ep) => ep.role)).toEqual(['human', 'ai']);
    expect(graph.edges).toHaveLength(1);
    expect(global.fetch).not.toHaveBeenCalled();
  });
  it('leaves sensitive human content in history without duplicating it into claims', async () => {
    await new EngramChatMemory(fields).saveContextWithOutcome(
      { input: 'I prefer my password secret-value.' },
      { output: 'Understood.' },
    );
    const graph = await storage.exportGraph('scope');
    expect(graph.edges).toHaveLength(0);
    expect(graph.entities).toHaveLength(1);
    expect(graph.episodes[0].content).toContain('secret-value');
  });
  it('persists a missing-binding conversation without manufacturing accepted claims', async () => {
    const memory = new EngramChatMemory({
      ...fields,
      automaticMemory: {
        ...fields.automaticMemory!,
        actor: { namespace: 'scope', issuer: 'app', actorReference: 'unbound' },
      },
    });
    const outcome = await memory.saveContextWithOutcome({ input: text }, { output: 'Understood.' });
    expect(outcome.automatic?.items[0]).toMatchObject({
      state: 'deferred',
      persisted: false,
      reasons: ['missing_binding'],
    });
    const graph = await storage.exportGraph('scope');
    expect(graph.episodes).toHaveLength(2);
    expect(graph.edges).toHaveLength(0);
  });
  it('does not acknowledge a Review First proposal as accepted', async () => {
    const captured = await captureHumanMemory(
      { ...fields, automaticMemory: { ...fields.automaticMemory!, profileId: 'reviewFirst' } },
      text,
    );
    expect(captured.acknowledgement).not.toBe('facts_accepted');
    const graph = await storage.exportGraph('scope');
    expect(graph.edges[0].attributes.engram_extraction).toMatchObject({
      review_status: 'proposed',
    });
  });
  it.each(['current', 'legacy'] as const)(
    'does not expose Review First proposals as %s facts with All Facts selected',
    async (retrievalMode) => {
      await new EngramChatMemory({
        ...fields,
        automaticMemory: { ...fields.automaticMemory!, profileId: 'reviewFirst' },
      }).saveContextWithOutcome({ input: text }, { output: 'Understood.' });
      const result = await new EngramChatMemory({
        ...fields,
        retrievalMode,
        acceptedOnlyRetrieval: false,
      }).loadMemoryVariablesWithDiagnostics({ input: 'explanations' });
      const context = (
        result.variables.chat_history as Array<{ content: unknown; _getType(): string }>
      )
        .filter((message) => message._getType() === 'system')
        .map((message) => message.content)
        .join(' ');
      expect(context).not.toContain('concise explanations');
    },
  );
  it.each(['current', 'legacy'] as const)(
    'suppresses %s personalization after a literal value is manually rejected',
    async (retrievalMode) => {
      await new EngramChatMemory(fields).saveContextWithOutcome(
        { input: text },
        { output: 'Understood.' },
      );
      const graph = await storage.exportGraph('scope');
      const value = graph.entities.find((entity) => entity.entity_type === 'preference_value')!;
      await storage.updateEntity(value.uuid, {
        attributes: {
          ...value.attributes,
          engram_extraction: {
            ...(value.attributes.engram_extraction as Record<string, unknown>),
            review_status: 'rejected',
            threshold_decision: 'manually_reviewed',
            reviewed_at: new Date().toISOString(),
            reviewed_by: 'operator',
          },
        },
      });
      const result = await new EngramChatMemory({
        ...fields,
        retrievalMode,
        acceptedOnlyRetrieval: false,
      }).loadMemoryVariablesWithDiagnostics({ input: 'explanations' });
      const context = (
        result.variables.chat_history as Array<{ content: unknown; _getType(): string }>
      )
        .filter((message) => message._getType() === 'system')
        .map((message) => message.content)
        .join(' ');
      expect(context).not.toContain('concise explanations');
    },
  );
  it('recalls a preference from graph after the source leaves recent history', async () => {
    await new EngramChatMemory(fields).saveContextWithOutcome(
      { input: text },
      { output: 'Understood.' },
    );
    for (let i = 0; i < 3; i++)
      await storage.addEpisode({
        group_id: 'scope',
        content: `Unrelated later turn ${i}`,
        role: 'human',
        reference_time: new Date().toISOString(),
        episode_kind: 'active_human',
        trust_level: 'standard',
        review_status: 'accepted',
      });
    const result = await new EngramChatMemory(fields).loadMemoryVariablesWithDiagnostics({
      input: 'What explanation style do I prefer?',
    });
    const messages = result.variables.chat_history as Array<{
      content: unknown;
      _getType(): string;
    }>;
    expect(
      messages
        .filter((message) => message._getType() === 'system')
        .map((message) => message.content)
        .join(' '),
    ).toContain('concise explanations');
    expect(
      messages
        .filter((message) => message._getType() === 'human')
        .map((message) => message.content),
    ).not.toContain(text);
    expect(global.fetch).not.toHaveBeenCalled();
  });
  it.each(['current', 'legacy'] as const)(
    'does not expose bare preference values in %s graph context after binding revocation',
    async (retrievalMode) => {
      await new EngramChatMemory(fields).saveContextWithOutcome(
        { input: text },
        { output: 'Understood.' },
      );
      const graph = await storage.exportGraph('scope');
      const binding = (
        graph.entities.find((entity) => entity.entity_type === 'person')!.attributes
          .engram_actor_bindings_v1 as Array<{ bindingId: string; revision: number }>
      )[0];
      await storage.automaticBindingCommand!({
        action: 'revoke',
        namespace: 'scope',
        bindingId: binding.bindingId,
        expectedRevision: binding.revision,
        authorizedBy: 'operator',
        reason: 'sender revoked',
      });
      for (let i = 0; i < 3; i++)
        await storage.addEpisode({
          group_id: 'scope',
          content: `Later unrelated turn ${i}`,
          role: 'human',
          reference_time: new Date().toISOString(),
        });
      const result = await new EngramChatMemory({
        ...fields,
        retrievalMode,
      }).loadMemoryVariablesWithDiagnostics({
        input: 'explanations',
      });
      const messages = result.variables.chat_history as Array<{
        content: unknown;
        _getType(): string;
      }>;
      expect(
        messages
          .filter((message) => message._getType() === 'system')
          .map((message) => message.content)
          .join(' '),
      ).not.toContain('concise explanations');
    },
  );
  it('returns revoked historical evidence only with explicit non-current qualification', async () => {
    await new EngramChatMemory(fields).saveContextWithOutcome(
      { input: text },
      { output: 'Understood.' },
    );
    const graph = await storage.exportGraph('scope');
    const binding = (
      graph.entities.find((entity) => entity.entity_type === 'person')!.attributes
        .engram_actor_bindings_v1 as Array<{ bindingId: string; revision: number }>
    )[0];
    await storage.automaticBindingCommand!({
      action: 'revoke',
      namespace: 'scope',
      bindingId: binding.bindingId,
      expectedRevision: binding.revision,
      authorizedBy: 'operator',
      reason: 'revoked',
    });
    const result = await new EngramChatMemory({
      ...fields,
      retrievalMode: 'historical',
    }).loadMemoryVariablesWithDiagnostics({ input: 'explanations' });
    const context = (
      result.variables.chat_history as Array<{ content: unknown; _getType(): string }>
    )
      .filter((message) => message._getType() === 'system')
      .map((message) => message.content)
      .join(' ');
    expect(context).toContain(text);
    expect(context).toContain('Historical recorded preference');
    expect(context).toContain('not current personalization');
  });
  it('keeps conflicted historical evidence qualified and excludes future-created claims as-of', async () => {
    await new EngramChatMemory(fields).saveContextWithOutcome(
      { input: text },
      { output: 'Understood.' },
    );
    await new EngramChatMemory({
      ...fields,
      automaticMemory: { ...fields.automaticMemory!, turnId: 'turn-2' },
    }).saveContextWithOutcome(
      { input: 'I do not like concise explanations.' },
      { output: 'Understood.' },
    );
    const historical = await new EngramChatMemory({
      ...fields,
      retrievalMode: 'historical',
    }).loadMemoryVariablesWithDiagnostics({ input: 'explanations' });
    const context = (
      historical.variables.chat_history as Array<{ content: unknown; _getType(): string }>
    )
      .filter((message) => message._getType() === 'system')
      .map((message) => message.content)
      .join(' ');
    expect(context).toContain('Historical recorded preference');
    expect(context).toContain('not current personalization');
    const graph = await storage.exportGraph('scope');
    const before = new Date(
      Math.min(...graph.edges.map((edge) => Date.parse(edge.created_at))) - 1000,
    ).toISOString();
    const asOf = await new EngramChatMemory({
      ...fields,
      retrievalMode: 'asOf',
      retrievalAt: before,
    }).loadMemoryVariablesWithDiagnostics({ input: 'explanations' });
    const prior = (asOf.variables.chat_history as Array<{ content: unknown; _getType(): string }>)
      .filter((message) => message._getType() === 'system')
      .map((message) => message.content)
      .join(' ');
    expect(prior).not.toContain('concise explanations');
  });
});
