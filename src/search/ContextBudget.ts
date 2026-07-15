const CHARS_PER_TOKEN = 4;

export interface BudgetedContextItem {
  id: string;
  line: string;
}

export interface BudgetedSectionResult {
  text: string;
  token_budget: number | null;
  estimated_tokens: number;
  included_ids: string[];
  excluded_ids: string[];
}

export function estimateContextTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function contextCharacterLimit(tokenBudget: number): number {
  return Math.max(0, Math.floor(tokenBudget) * CHARS_PER_TOKEN);
}

export function formatBudgetedSection(
  heading: string,
  lines: string[],
  tokenBudget?: number,
): string {
  return formatBudgetedItems(
    heading,
    lines.map((line, index) => ({ id: String(index), line })),
    tokenBudget,
  ).text;
}

export function formatBudgetedItems(
  heading: string,
  items: BudgetedContextItem[],
  tokenBudget?: number,
): BudgetedSectionResult {
  if (items.length === 0) {
    return {
      text: '',
      token_budget: tokenBudget ?? null,
      estimated_tokens: 0,
      included_ids: [],
      excluded_ids: [],
    };
  }
  if (tokenBudget === undefined) {
    const text = [heading, ...items.map((item) => item.line)].join('\n');
    return {
      text,
      token_budget: null,
      estimated_tokens: estimateContextTokens(text),
      included_ids: items.map((item) => item.id),
      excluded_ids: [],
    };
  }
  const characterLimit = contextCharacterLimit(tokenBudget);
  if (heading.length > characterLimit) {
    return {
      text: '',
      token_budget: tokenBudget,
      estimated_tokens: 0,
      included_ids: [],
      excluded_ids: items.map((item) => item.id),
    };
  }

  const includedLines = [heading];
  const includedIds: string[] = [];
  const excludedIds: string[] = [];
  let used = heading.length;
  for (const item of items) {
    const additional = 1 + item.line.length;
    if (used + additional > characterLimit) {
      excludedIds.push(item.id);
      continue;
    }
    includedLines.push(item.line);
    includedIds.push(item.id);
    used += additional;
  }
  const text = includedLines.length > 1 ? includedLines.join('\n') : '';
  return {
    text,
    token_budget: tokenBudget,
    estimated_tokens: estimateContextTokens(text),
    included_ids: includedIds,
    excluded_ids: excludedIds,
  };
}
