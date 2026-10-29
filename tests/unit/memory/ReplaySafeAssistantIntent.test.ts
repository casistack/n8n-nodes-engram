import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import { prepareReplaySafeAssistantIntent } from '../../../src/memory/ReplaySafeAssistantIntent';
import type { AutomaticRuntimeInput } from '../../../src/schemas/AutomaticRuntime.schema';

const human = 'I prefer explanations with examples.';
const runtime = (): AutomaticRuntimeInput => ({
  profileId: 'conservative',
  storeIdentity: 'a'.repeat(64),
  capturedSourceId: 'f71adae8-61d1-413c-a487-0a85560c99dd',
  turnId: 'synthetic-event',
  actor: {
    namespace: 'synthetic-scope',
    issuer: 'synthetic-app',
    actorReference: 'synthetic-actor',
  },
});
const translate = (message: AIMessage | HumanMessage | SystemMessage | ToolMessage) =>
  prepareReplaySafeAssistantIntent(runtime(), human, message, 'b'.repeat(64), 30000);

describe('strict replay-safe final assistant intent translation', () => {
  it('retains exact inputs and only actual final message provenance', () => {
    const message = new AIMessage({
      content: 'Synthetic final answer.',
      id: 'synthetic-provider-message',
      additional_kwargs: {
        source_execution_id: 'untrusted-processing-id',
        source_workflow_id: 'untrusted-flow',
      },
    });
    const result = translate(message);
    expect(result.kind).toBe('prepared');
    if (result.kind !== 'prepared') throw new Error('Expected intent');
    expect(result.intent.humanTurn).toMatchObject({
      namespace: 'synthetic-scope',
      actorReference: 'synthetic-actor',
      input: { content: human, applicationOwnedWrapper: null, humanRegion: null },
    });
    expect(result.intent.finalAssistant).toMatchObject({
      content: 'Synthetic final answer.',
      sourceMessageId: 'synthetic-provider-message',
      sourceWorkflowId: null,
      originalSourceExecutionId: null,
      senderId: null,
      conversationId: null,
    });
    expect(result.intent).not.toHaveProperty('humanSourceId');
    message.content = 'Mutated later';
    expect(result.intent.finalAssistant.content).toBe('Synthetic final answer.');
  });

  it.each([
    new HumanMessage('human'),
    new SystemMessage('system'),
    new ToolMessage({ content: 'tool', tool_call_id: 'call' }),
  ])('rejects every non-assistant role without reinterpreting JSON', (message) => {
    expect(translate(message)).toEqual({ kind: 'rejected', reason: 'invalid_input' });
  });

  it.each([
    new AIMessage({
      content: '',
      tool_calls: [{ id: 'call', name: 'synthetic', type: 'tool_call', args: {} }],
    }),
    new AIMessage({
      content: 'draft',
      additional_kwargs: {
        tool_calls: [
          { id: 'call', type: 'function', function: { name: 'synthetic', arguments: '{}' } },
        ],
      },
    }),
    new AIMessage({
      content: 'draft',
      additional_kwargs: { function_call: { name: 'synthetic', arguments: '{}' } },
    }),
  ])('rejects canonical, provider and legacy call drafts', (message) => {
    expect(translate(message)).toEqual({ kind: 'rejected', reason: 'invalid_input' });
  });

  it('does not flatten structured content or blank replies', () => {
    expect(translate(new AIMessage([{ type: 'text', text: 'Structured' }]))).toEqual({
      kind: 'rejected',
      reason: 'invalid_input',
    });
    expect(translate(new AIMessage('   '))).toEqual({ kind: 'rejected', reason: 'invalid_input' });
  });

  it('preserves exact Unicode wrapper geometry and rejects changed raw text', () => {
    const config = runtime();
    const prefix = '🔊 Synthetic speaker: ';
    config.rawHumanContent = human;
    config.actor = {
      ...config.actor,
      applicationOwnedWrapper: true,
      humanRegion: { start: prefix.length, end: prefix.length + human.length },
    };
    const result = prepareReplaySafeAssistantIntent(
      config,
      prefix + human,
      new AIMessage('Answer'),
      'b'.repeat(64),
      30000,
    );
    expect(result.kind).toBe('prepared');
    if (result.kind !== 'prepared') throw new Error('Expected mapped intent');
    expect(result.intent.humanTurn.input.humanRegion).toEqual(config.actor.humanRegion);
    config.rawHumanContent = 'Different statement';
    expect(
      prepareReplaySafeAssistantIntent(
        config,
        prefix + human,
        new AIMessage('Answer'),
        'b'.repeat(64),
        30000,
      ).kind,
    ).toBe('rejected');
    delete config.rawHumanContent;
    expect(
      prepareReplaySafeAssistantIntent(
        config,
        prefix + human,
        new AIMessage('Answer'),
        'b'.repeat(64),
        30000,
      ).kind,
    ).toBe('rejected');
  });

  it('rejects getters and tool-call proxies without executing them', () => {
    let reads = 0;
    const message = new AIMessage('Answer');
    Object.defineProperty(message, '_getType', {
      get() {
        reads++;
        throw new Error('private');
      },
    });
    expect(translate(message).kind).toBe('rejected');
    const other = new AIMessage('Answer');
    Object.defineProperty(other, 'tool_calls', {
      value: new Proxy([], {
        get() {
          reads++;
          throw new Error('private');
        },
      }),
    });
    expect(translate(other).kind).toBe('rejected');
    expect(reads).toBe(0);
  });

  it('requires a captured configured profile and bounded source content', () => {
    const config = runtime();
    delete config.capturedSourceId;
    expect(
      prepareReplaySafeAssistantIntent(
        config,
        human,
        new AIMessage('Answer'),
        'b'.repeat(64),
        30000,
      ),
    ).toEqual({ kind: 'rejected', reason: 'unsupported_mode' });
    expect(translate(new AIMessage('x'.repeat(65537)))).toEqual({
      kind: 'rejected',
      reason: 'capacity',
    });
  });

  it('retains independently maximum escaped human and assistant strings', () => {
    const value = '\u0001'.repeat(65536);
    const config = runtime();
    config.rawHumanContent = value;
    const result = prepareReplaySafeAssistantIntent(
      config,
      value,
      new AIMessage(value),
      'b'.repeat(64),
      30000,
    );
    expect(result.kind).toBe('prepared');
    if (result.kind !== 'prepared') throw new Error('Expected bounded dual-source intent');
    expect(Buffer.byteLength(JSON.stringify(result.intent))).toBeGreaterThan(512 * 1024);
    expect(Buffer.byteLength(JSON.stringify(result.intent))).toBeLessThan(1024 * 1024);
  });
});
