import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import { prepareReplaySafeAudits } from '../../../src/memory/ReplaySafeAudits';

const scope = {
  version: 2 as const,
  namespace: 'synthetic-scope',
  issuer: 'synthetic-app',
  actorReference: 'synthetic-actor',
  turn: 'synthetic-event',
  role: 'human' as const,
};
const tool = (content = 'Synthetic result', id: string | undefined = 'synthetic-call') =>
  new ToolMessage({ content, tool_call_id: id ?? '' });
const prepared = (messages: Array<ToolMessage | SystemMessage | AIMessage>, localScope = scope) => {
  const result = prepareReplaySafeAudits(
    messages.map((message, position) => ({ message, position })),
    localScope,
  );
  if (result.kind !== 'prepared') throw new Error(`Expected audit preflight: ${result.reason}`);
  return result;
};

describe('bounded replay-safe audit preflight', () => {
  it('keeps roles, IDs and payload as unverified audit data, outside extraction', () => {
    const message = tool();
    message.id = 'synthetic-message';
    const result = prepared([message]);
    const write = result.writes[0];
    expect(write.message._getType()).toBe('system');
    expect(write.metadata).toMatchObject({
      episode_kind: 'tool_output',
      trust_level: 'unverified',
      review_status: 'proposed',
      source_execution_id: null,
      source_workflow_id: null,
      attributes: {
        engram_audit: true,
        engram_message: {
          original_role: 'tool',
          original_message_id: 'synthetic-message',
          tool_call_id: 'synthetic-call',
        },
      },
    });
    expect(JSON.parse(write.message.content as string).content).toBe('Synthetic result');
  });

  it('reuses stable tool identity across positions, without global text deduplication', () => {
    const first = prepared([tool()]).writes[0].metadata!.idempotency_key;
    const shifted = prepareReplaySafeAudits([{ message: tool(), position: 12 }], scope);
    if (shifted.kind !== 'prepared') throw new Error('Expected audit');
    expect(shifted.writes[0].metadata!.idempotency_key).toBe(first);
    expect(
      prepared([tool()], { ...scope, turn: 'another-event' }).writes[0].metadata!.idempotency_key,
    ).not.toBe(first);
    expect(
      prepared([tool()], { ...scope, namespace: 'another-scope' }).writes[0].metadata!
        .idempotency_key,
    ).not.toBe(first);
    expect(prepared([tool('Changed result')]).writes[0].metadata!.idempotency_key).not.toBe(first);
  });

  it('retains positions when no message or call IDs exist', () => {
    const result = prepared([new SystemMessage('same'), new SystemMessage('same')]);
    expect(result.writes[0].metadata!.idempotency_key).not.toBe(
      result.writes[1].metadata!.idempotency_key,
    );
  });

  it('preserves structured call arguments even when a draft has empty content', () => {
    const first = new AIMessage({
      content: '',
      tool_calls: [{ name: 'synthetic', id: 'call', type: 'tool_call', args: { value: 1 } }],
    });
    const second = new AIMessage({
      content: '',
      tool_calls: [{ name: 'synthetic', id: 'call', type: 'tool_call', args: { value: 2 } }],
    });
    const result = prepared([first, second]);
    expect(JSON.parse(result.writes[0].message.content as string).tool_calls[0].args).toEqual({
      value: 1,
    });
    expect(result.writes[0].metadata!.idempotency_key).not.toBe(
      result.writes[1].metadata!.idempotency_key,
    );
  });

  it('preserves provider tool-call data when parsed calls are absent', () => {
    const message = new SystemMessage({
      content: '',
      additional_kwargs: {
        tool_calls: [
          { id: 'synthetic', type: 'function', function: { name: 'test', arguments: '{"x":1}' } },
        ],
      },
    });
    const payload = JSON.parse(prepared([message]).writes[0].message.content as string);
    expect(payload.provider_tool_calls[0].function.arguments).toBe('{"x":1}');
  });

  it('never converts genuine human JSON into a tool audit', () => {
    expect(
      prepareReplaySafeAudits(
        [{ message: new HumanMessage('[{"error":"quoted data"}]'), position: 0 }],
        scope,
      ),
    ).toEqual({ kind: 'rejected', requested: 1, reason: 'invalid_input' });
  });

  it('admits 32 small audits and rejects 33 before accessing their payloads', () => {
    expect(prepared(Array.from({ length: 32 }, () => tool())).writes).toHaveLength(32);
    const hostile = {
      get content() {
        throw new Error('must not inspect');
      },
    };
    expect(
      prepareReplaySafeAudits(
        Array.from({ length: 33 }, (_, position) => ({ message: hostile as never, position })),
        scope,
      ),
    ).toEqual({ kind: 'rejected', requested: 33, reason: 'capacity' });
  });

  it('rejects a single oversized payload and aggregate overflow before returning any writes', () => {
    expect(
      prepareReplaySafeAudits([{ message: tool('x'.repeat(65536)), position: 0 }], scope),
    ).toEqual({ kind: 'rejected', requested: 1, reason: 'capacity' });
    expect(
      prepareReplaySafeAudits(
        Array.from({ length: 9 }, (_, position) => ({
          message: tool('x'.repeat(65000)),
          position,
        })),
        scope,
      ),
    ).toEqual({ kind: 'rejected', requested: 9, reason: 'capacity' });
  });

  it('rejects accessors and cyclic structured data without invoking their hooks', () => {
    let reads = 0;
    const message = new SystemMessage('value');
    Object.defineProperty(message, 'content', {
      get() {
        reads++;
        throw new Error('private');
      },
    });
    expect(prepareReplaySafeAudits([{ message, position: 0 }], scope).kind).toBe('rejected');
    expect(reads).toBe(0);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const other = new SystemMessage('value');
    other.content = cyclic as never;
    expect(prepareReplaySafeAudits([{ message: other, position: 0 }], scope).kind).toBe('rejected');
  });

  it('returns detached payloads and fixed errors for invalid identifiers or scope', () => {
    const message = tool();
    const result = prepared([message]);
    message.content = 'Mutated later';
    expect(JSON.parse(result.writes[0].message.content as string).content).toBe('Synthetic result');
    message.id = 'x'.repeat(513);
    expect(prepareReplaySafeAudits([{ message, position: 0 }], scope).kind).toBe('rejected');
    expect(prepareReplaySafeAudits([], { ...scope, role: 'assistant' })).toEqual({
      kind: 'rejected',
      requested: 0,
      reason: 'invalid_input',
    });
  });

  it('does not invoke role or candidate accessors and rejects proxy traps first', () => {
    let reads = 0;
    const message = new SystemMessage('Synthetic');
    Object.defineProperty(message, '_getType', {
      get() {
        reads++;
        throw new Error('private-role');
      },
    });
    expect(prepareReplaySafeAudits([{ message, position: 0 }], scope).kind).toBe('rejected');
    const candidate = {
      get message() {
        reads++;
        throw new Error('private-candidate');
      },
      position: 0,
    };
    expect(prepareReplaySafeAudits([candidate as never], scope).kind).toBe('rejected');
    const proxy = new Proxy(
      {},
      {
        get() {
          reads++;
          throw new Error('private-proxy');
        },
      },
    );
    expect(prepareReplaySafeAudits([proxy as never], scope).kind).toBe('rejected');
    expect(prepareReplaySafeAudits([{ message: proxy as never, position: 0 }], scope).kind).toBe(
      'rejected',
    );
    expect(reads).toBe(0);
  });

  it('rejects noncanonical IDs and sparse audit arrays', () => {
    const message = tool();
    message.id = ' padded-id ';
    expect(prepareReplaySafeAudits([{ message, position: 0 }], scope).kind).toBe('rejected');
    expect(prepareReplaySafeAudits(new Array(1), scope).kind).toBe('rejected');
  });
});
