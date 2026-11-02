import {
  AUTONOMOUS_PERSONAL_FRAMING_CONTEXT_MARKERS_V1,
  AUTONOMOUS_PERSONAL_FRAMING_EPISTEMIC_PHRASES_V1,
  autonomousPersonalFramingHasPhraseV1,
  autonomousPersonalFramingHeadWordV1,
  autonomousPersonalFramingIncompleteHeadV1,
  autonomousPersonalFramingInstructionAtV1,
  autonomousPersonalFramingReportComplementV1,
} from '../schemas/AutonomousPersonalFramingV1.schema';
import type { AutonomousSourceLexicalTokenV1 } from '../schemas/AutonomousSourceLexicalTokenV1.schema';

const COMMA = 0x2c;
const OPENERS = new Set([0x28, 0x5b, 0x7b]);
const CLOSERS = new Set([0x29, 0x5d, 0x7d]);

function asciiLower(value: string): string {
  return value.replace(/[A-Z]/gu, (letter) => String.fromCharCode(letter.charCodeAt(0) + 32));
}

/**
 * Pure, deterministic shape test for one non-typed unit that carries exactly one context marker
 * (`when`/`whenever`) and no epistemic or hypothetical marker. It decides structure only: it
 * neither authorizes a record (the provider row stays necessary, never sufficient) nor relaxes any
 * quote, report, instruction, sensitivity or question veto, which run before this is consulted.
 *
 * - appended form: the existing first-person head is supported and the marker follows its
 *   predicate (`I prefer X when Y`);
 * - prepended form: `<marker> <clause>, <supported first-person main clause>`.
 */
export function recognizeContextQualifiedStatementV1(input: {
  body: string;
  tokens: readonly AutonomousSourceLexicalTokenV1[];
  tokenSpan: { start: number; end: number };
  headSupported: boolean;
  prefixHead: boolean;
}): boolean {
  const { body, tokens, tokenSpan, headSupported, prefixHead } = input;
  const local = tokens.slice(tokenSpan.start, tokenSpan.end);
  const words: string[] = [];
  const wordLocalIndex: number[] = [];
  local.forEach((token, index) => {
    if (token.kind !== 'word') return;
    words.push(asciiLower(body.slice(token.start, token.end)));
    wordLocalIndex.push(index);
  });

  const markers = words.flatMap((word, index) =>
    AUTONOMOUS_PERSONAL_FRAMING_CONTEXT_MARKERS_V1.includes(word) ? [index] : [],
  );
  if (markers.length !== 1) return false;
  const marker = markers[0]!;
  if (marker >= words.length - 1) return false;
  if (
    autonomousPersonalFramingHasPhraseV1(words, AUTONOMOUS_PERSONAL_FRAMING_EPISTEMIC_PHRASES_V1)
  ) {
    return false;
  }
  // Framing only ran these checks at the leading head; re-run them at every first-person word.
  for (let index = 0; index < words.length; index += 1) {
    if (!autonomousPersonalFramingHeadWordV1(words[index])) continue;
    if (
      autonomousPersonalFramingInstructionAtV1(words, index) ||
      autonomousPersonalFramingReportComplementV1(words, index)
    ) {
      return false;
    }
  }

  if (headSupported) {
    return local[0]?.kind === 'word' && marker >= (prefixHead ? 2 : 0) + 2;
  }

  // Prepended form.
  if (marker !== 0 || local[0]?.kind !== 'word') return false;
  let depth = 0;
  let comma = -1;
  for (let index = 1; index < local.length; index += 1) {
    const token = local[index]!;
    if (token.kind !== 'punctuation') continue;
    if (OPENERS.has(token.codePoint)) depth += 1;
    else if (CLOSERS.has(token.codePoint)) {
      depth -= 1;
      if (depth < 0) return false;
    } else if (token.codePoint === COMMA && depth === 0) {
      comma = index;
      break;
    }
  }
  if (comma < 0) return false;
  const clauseWords = wordLocalIndex.filter((index) => index < comma).length;
  if (clauseWords < 2) return false;
  const mainHead = clauseWords;
  if (
    wordLocalIndex[mainHead] !== comma + 1 ||
    local[comma + 2]?.kind !== 'word' ||
    !autonomousPersonalFramingHeadWordV1(words[mainHead]) ||
    autonomousPersonalFramingIncompleteHeadV1(words, mainHead)
  ) {
    return false;
  }
  return true;
}
