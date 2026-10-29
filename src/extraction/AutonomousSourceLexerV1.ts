import {
  isAutonomousLetterCodePointV1,
  isAutonomousWhitespaceCodePointV1,
  isAutonomousWordCodePointV1,
} from './AutonomousUnicodeV1';
import type { AutonomousSourceLexicalTokenV1 as Token } from '../schemas/AutonomousSourceLexicalTokenV1.schema';

/** Internal lexical machinery for geometry-validated bounded source bodies.
 * Tokens are mechanical DATA, never source authority or an acceptance decision.
 * This module is intentionally absent from the public schema barrel.
 */
export const AUTONOMOUS_SOURCE_LEXICAL_TOKEN_LIMIT_V1 = 8_192;
const MAX_LEXICAL_TOKENS = AUTONOMOUS_SOURCE_LEXICAL_TOKEN_LIMIT_V1;

export function nextCodePoint(value: string, offset: number): { codePoint: number; width: number } {
  const codePoint = value.codePointAt(offset);
  if (codePoint === undefined) throw new Error('Invalid code point offset');
  return { codePoint, width: codePoint > 0xffff ? 2 : 1 };
}

export function previousCodePoint(value: string, offset: number): number | undefined {
  if (offset <= 0) return undefined;
  const right = value.charCodeAt(offset - 1);
  if (right >= 0xdc00 && right <= 0xdfff && offset >= 2) {
    const left = value.charCodeAt(offset - 2);
    if (left >= 0xd800 && left <= 0xdbff)
      return ((left - 0xd800) << 10) + (right - 0xdc00) + 0x10000;
  }
  return right;
}

function isApostrophe(codePoint: number): boolean {
  return codePoint === 0x27 || codePoint === 0x2019;
}

export function quoteRole(
  codePoint: number,
):
  | 'symmetric_single'
  | 'symmetric_double'
  | 'curly_single_open'
  | 'curly_single_close'
  | 'curly_double_open'
  | 'curly_double_close'
  | null {
  if (codePoint === 0x27) return 'symmetric_single';
  if (codePoint === 0x22) return 'symmetric_double';
  if (codePoint === 0x2018) return 'curly_single_open';
  if (codePoint === 0x2019) return 'curly_single_close';
  if (codePoint === 0x201c) return 'curly_double_open';
  if (codePoint === 0x201d) return 'curly_double_close';
  return null;
}

export function quoteFamily(codePoint: number): 'single' | 'double' | null {
  const role = quoteRole(codePoint);
  if (
    role === 'symmetric_single' ||
    role === 'curly_single_open' ||
    role === 'curly_single_close'
  ) {
    return 'single';
  }
  if (
    role === 'symmetric_double' ||
    role === 'curly_double_open' ||
    role === 'curly_double_close'
  ) {
    return 'double';
  }
  return null;
}

function isQuoteCodePoint(codePoint: number): boolean {
  return quoteRole(codePoint) !== null;
}

export function tokenizeMappedBody(body: string): Token[] | null {
  const tokens: Token[] = [];
  let offset = 0;

  while (offset < body.length) {
    const current = nextCodePoint(body, offset);
    if (isAutonomousWhitespaceCodePointV1(current.codePoint)) {
      offset += current.width;
      continue;
    }

    const start = offset;
    if (isAutonomousWordCodePointV1(current.codePoint)) {
      offset += current.width;
      while (offset < body.length) {
        const next = nextCodePoint(body, offset);
        if (isAutonomousWordCodePointV1(next.codePoint)) {
          offset += next.width;
          continue;
        }
        if (isApostrophe(next.codePoint)) {
          const before = previousCodePoint(body, offset);
          const afterOffset = offset + next.width;
          const after =
            afterOffset < body.length ? nextCodePoint(body, afterOffset).codePoint : undefined;
          if (
            before !== undefined &&
            after !== undefined &&
            isAutonomousLetterCodePointV1(before) &&
            isAutonomousLetterCodePointV1(after)
          ) {
            offset += next.width;
            continue;
          }
        }
        break;
      }
      tokens.push({ kind: 'word', start, end: offset, codePoint: current.codePoint });
    } else {
      offset += current.width;
      tokens.push({
        kind: isQuoteCodePoint(current.codePoint) ? 'quote' : 'punctuation',
        start,
        end: offset,
        codePoint: current.codePoint,
      });
    }

    if (tokens.length > MAX_LEXICAL_TOKENS) return null;
  }

  return tokens;
}
