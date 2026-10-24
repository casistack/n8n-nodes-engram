import { BaseMessage } from '@langchain/core/messages';

export function messageType(message: BaseMessage): string {
  return message._getType();
}
export function messageHasText(message: BaseMessage): boolean {
  return typeof message.content === 'string'
    ? message.content.trim().length > 0
    : message.content.length > 0;
}
export function isToolCall(message: BaseMessage): boolean {
  const calls = (message as BaseMessage & { tool_calls?: unknown[] }).tool_calls;
  return Boolean(
    calls?.length ||
    message.additional_kwargs?.function_call ||
    (Array.isArray(message.additional_kwargs?.tool_calls) &&
      message.additional_kwargs.tool_calls.length),
  );
}
/** Return only assistant replies after all identified calls in a human segment have closed. */
export function finalAssistantIndices(messages: BaseMessage[]): Set<number> {
  const finals = new Set<number>();
  const pending = new Set<string>();
  let candidate: number | undefined;
  for (const [index, message] of messages.entries()) {
    const type = messageType(message);
    if (type === 'human') {
      if (candidate !== undefined && pending.size === 0) finals.add(candidate);
      candidate = undefined;
      pending.clear();
    } else if (type === 'ai' && isToolCall(message)) {
      candidate = undefined;
      const canonical = (message as BaseMessage & { tool_calls?: Array<{ id?: string }> })
        .tool_calls;
      const calls = canonical?.length ? canonical : (message.additional_kwargs.tool_calls ?? []);
      for (const call of calls) pending.add(call.id ?? `unidentified:${index}`);
      const fn = message.additional_kwargs.function_call;
      if (fn) pending.add(`function:${fn.name}`);
    } else if (type === 'tool' || type === 'function') {
      candidate = undefined;
      const callId =
        'tool_call_id' in message && typeof message.tool_call_id === 'string'
          ? message.tool_call_id
          : '';
      if (type === 'tool') pending.delete(callId);
      else pending.delete(`function:${message.name}`);
    } else if (type === 'ai' && messageHasText(message) && pending.size === 0) candidate = index;
  }
  if (candidate !== undefined && pending.size === 0) finals.add(candidate);
  return finals;
}
