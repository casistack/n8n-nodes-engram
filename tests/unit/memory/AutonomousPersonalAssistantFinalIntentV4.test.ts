import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import { AutonomousPersonalAssistantFinalIntentV4OwnedDataSchema } from '../../../src/schemas/AutonomousPersonalAssistantFinalV4.schema';
import { prepareAutonomousPersonalAssistantFinalIntentV4 } from '../../../src/memory/AutonomousPersonalAssistantFinalIntentV4';

const attemptHash = 'a'.repeat(64);
const deadlineMs = 30_000;

describe('V4 assistant final intent translation', () => {
  it('preserves the exact human and final AI strings and only sanitized producer fields', () => {
    const human = '  🔎 Query with exact Unicode and spaces.\n';
    const final = '  Answer with exact Unicode 🧠.\n';
    const result = prepareAutonomousPersonalAssistantFinalIntentV4(
      new HumanMessage(human),
      new AIMessage({
        content: final,
        id: 'synthetic-provider-message',
        additional_kwargs: {
          source_execution_id: 'untrusted-execution',
          source_workflow_id: 'untrusted-workflow',
          conversation_id: 'untrusted-conversation',
        },
      }),
      attemptHash,
      deadlineMs,
    );

    expect(result.kind).toBe('prepared');
    if (result.kind !== 'prepared') throw new Error('Expected V4 final intent');
    expect(result.intent.humanObservation).toEqual({ kind: 'message', content: human });
    expect(result.intent.finalAssistant).toEqual({
      content: final,
      sourceMessageId: 'synthetic-provider-message',
      conversationId: null,
      senderId: null,
      senderName: null,
      sourceWorkflowId: null,
      originalSourceExecutionId: null,
      sourceType: 'message',
      quotedMessageId: null,
      eventTime: { mode: 'first_capture' },
    });
    expect(result.intent).toMatchObject({
      version: 4,
      purpose: 'assistant_final_save',
      memoryAttemptHash: attemptHash,
      invocationDeadlineMs: deadlineMs,
    });
    expect(result.intent).not.toHaveProperty('sourceId');
    expect(result.intent).not.toHaveProperty('operationId');
    expect(result.intent).not.toHaveProperty('authority');
    expect(result.intent).not.toHaveProperty('origin');
    expect(result.intent).not.toHaveProperty('graph');
  });

  it('uses a configured-query observation when no human message was supplied', () => {
    const result = prepareAutonomousPersonalAssistantFinalIntentV4(
      undefined,
      new AIMessage('Final answer.'),
      attemptHash,
      deadlineMs,
    );
    expect(result).toEqual({
      kind: 'prepared',
      intent: expect.objectContaining({ humanObservation: { kind: 'configured_query' } }),
    });
    if (result.kind !== 'prepared') throw new Error('Expected V4 final intent');
    expect(result.intent.humanObservation).toEqual({ kind: 'configured_query' });
  });

  it.each([
    ['AI as the human input', new AIMessage('not a human')],
    ['system input', new SystemMessage('not a human')],
    ['tool input', new ToolMessage({ content: 'tool result', tool_call_id: 'call-1' })],
  ])('rejects %s as the human message', (_label, human) => {
    expect(
      prepareAutonomousPersonalAssistantFinalIntentV4(
        human,
        new AIMessage('Final answer.'),
        attemptHash,
        deadlineMs,
      ),
    ).toEqual({ kind: 'rejected', reason: 'invalid_input' });
  });

  it.each([
    new HumanMessage('not final AI'),
    new SystemMessage('not final AI'),
    new ToolMessage({ content: 'tool result', tool_call_id: 'call-2' }),
  ])('rejects a non-AI final message', (final) => {
    expect(
      prepareAutonomousPersonalAssistantFinalIntentV4(
        new HumanMessage('human query'),
        final,
        attemptHash,
        deadlineMs,
      ),
    ).toEqual({ kind: 'rejected', reason: 'invalid_input' });
  });

  it.each([
    new AIMessage({
      content: 'draft answer',
      tool_calls: [{ id: 'call', name: 'synthetic', type: 'tool_call', args: {} }],
    }),
    new AIMessage({
      content: 'draft answer',
      additional_kwargs: {
        tool_calls: [
          { id: 'call', type: 'function', function: { name: 'synthetic', arguments: '{}' } },
        ],
      },
    }),
    new AIMessage({
      content: 'draft answer',
      additional_kwargs: { function_call: { name: 'synthetic', arguments: '{}' } },
    }),
  ])('rejects a final AI message that still has a tool call', (final) => {
    expect(
      prepareAutonomousPersonalAssistantFinalIntentV4(undefined, final, attemptHash, deadlineMs),
    ).toEqual({ kind: 'rejected', reason: 'invalid_input' });
  });

  it('rejects blank or structured content without rewriting it', () => {
    expect(
      prepareAutonomousPersonalAssistantFinalIntentV4(
        new HumanMessage('   '),
        new AIMessage('Answer'),
        attemptHash,
        deadlineMs,
      ),
    ).toEqual({ kind: 'rejected', reason: 'invalid_input' });
    expect(
      prepareAutonomousPersonalAssistantFinalIntentV4(
        undefined,
        new AIMessage('   '),
        attemptHash,
        deadlineMs,
      ),
    ).toEqual({ kind: 'rejected', reason: 'invalid_input' });
    expect(
      prepareAutonomousPersonalAssistantFinalIntentV4(
        undefined,
        new AIMessage([{ type: 'text', text: 'structured' }]),
        attemptHash,
        deadlineMs,
      ),
    ).toEqual({ kind: 'rejected', reason: 'invalid_input' });
  });

  it('rejects oversized human or assistant content as capacity', () => {
    expect(
      prepareAutonomousPersonalAssistantFinalIntentV4(
        new HumanMessage('x'.repeat(65_537)),
        new AIMessage('Final answer'),
        attemptHash,
        deadlineMs,
      ),
    ).toEqual({ kind: 'rejected', reason: 'capacity' });
    expect(
      prepareAutonomousPersonalAssistantFinalIntentV4(
        undefined,
        new AIMessage('x'.repeat(65_537)),
        attemptHash,
        deadlineMs,
      ),
    ).toEqual({ kind: 'rejected', reason: 'capacity' });
    expect(
      prepareAutonomousPersonalAssistantFinalIntentV4(
        undefined,
        new AIMessage('🧭'.repeat(32_769)),
        attemptHash,
        deadlineMs,
      ),
    ).toEqual({ kind: 'rejected', reason: 'capacity' });
  });

  it('does not invoke hostile getters or proxy traps on message data', () => {
    let reads = 0;
    const getterMessage = new AIMessage('Answer');
    Object.defineProperty(getterMessage, '_getType', {
      get() {
        reads += 1;
        throw new Error('unexpected getter');
      },
    });
    expect(
      prepareAutonomousPersonalAssistantFinalIntentV4(
        undefined,
        getterMessage,
        attemptHash,
        deadlineMs,
      ),
    ).toEqual({ kind: 'rejected', reason: 'invalid_input' });

    const contentGetter = new AIMessage('Answer');
    Object.defineProperty(contentGetter, 'content', {
      get() {
        reads += 1;
        throw new Error('unexpected content getter');
      },
    });
    expect(
      prepareAutonomousPersonalAssistantFinalIntentV4(
        undefined,
        contentGetter,
        attemptHash,
        deadlineMs,
      ),
    ).toEqual({ kind: 'rejected', reason: 'invalid_input' });

    const proxiedCalls = new AIMessage('Answer');
    Object.defineProperty(proxiedCalls, 'tool_calls', {
      value: new Proxy([], {
        get() {
          reads += 1;
          throw new Error('unexpected proxy read');
        },
      }),
    });
    expect(
      prepareAutonomousPersonalAssistantFinalIntentV4(
        undefined,
        proxiedCalls,
        attemptHash,
        deadlineMs,
      ),
    ).toEqual({ kind: 'rejected', reason: 'invalid_input' });
    expect(reads).toBe(0);
  });

  it('lets the root strict schema reject caller-added authority data', () => {
    const result = prepareAutonomousPersonalAssistantFinalIntentV4(
      undefined,
      new AIMessage('Final answer'),
      attemptHash,
      deadlineMs,
    );
    expect(result.kind).toBe('prepared');
    if (result.kind !== 'prepared') throw new Error('Expected V4 final intent');
    expect(
      AutonomousPersonalAssistantFinalIntentV4OwnedDataSchema.safeParse({
        ...result.intent,
        assistantWriteAuthority: {
          kind: 'owned_human_turn_v4',
          sourceId: '00000000-0000-4000-8000-000000000001',
        },
      }).success,
    ).toBe(false);
    expect(
      AutonomousPersonalAssistantFinalIntentV4OwnedDataSchema.safeParse({
        ...result.intent,
        nativeOrigin: {},
      }).success,
    ).toBe(false);
  });

  it('rejects invalid hash and deadline values through the strict root schema', () => {
    expect(
      prepareAutonomousPersonalAssistantFinalIntentV4(
        undefined,
        new AIMessage('Final answer'),
        'not-a-hash',
        deadlineMs,
      ),
    ).toEqual({ kind: 'rejected', reason: 'invalid_input' });
    expect(
      prepareAutonomousPersonalAssistantFinalIntentV4(
        undefined,
        new AIMessage('Final answer'),
        attemptHash,
        99,
      ),
    ).toEqual({ kind: 'rejected', reason: 'invalid_input' });
  });
});
