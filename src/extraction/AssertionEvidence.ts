/** Conservative acceptance gate. Partial or qualified claims remain reviewable proposals. */
export function isDurableAssertion(content: string, start: number, end: number): boolean {
  if (start < 0 || end <= start || end > content.length) return false;
  const text = content.slice(start, end).trim();
  const before = content.slice(0, start).trimEnd();
  const after = content.slice(end).trimStart();
  // Evidence must cover complete sentences, rather than a model-selected affirmative substring.
  if (before && !/[.!?\n]$/.test(before)) return false;
  if (after && !/[.!?]$/.test(text)) return false;
  if (content.includes('"') || /[“”]|^\s*>/m.test(content)) return false;
  return (
    !text.includes('?') &&
    !/\b(said|says|according to|hypothetical|might|maybe|not|never|false|denies|denied|without|no longer|if|unless|would|suppose|supposing|assuming|incorrect|untrue)\b|\b\w+n['’]t\b/i.test(
      text,
    ) &&
    !/^\s*(what|when|where|which|who|how|can you|could you|please|tell me|show me|find me|asks?\b)/i.test(
      text,
    ) &&
    !/\b(today|tomorrow|yesterday|later|next\s+(week|month|tuesday|monday|wednesday|thursday|friday|saturday|sunday)|this weekend)\b/i.test(
      text,
    )
  );
}
