import { createHash } from 'crypto';
import {
  AUTONOMOUS_UNICODE_V1 as descriptor,
  AUTONOMOUS_UNICODE_V1_LETTER_RANGES as letters,
  AUTONOMOUS_UNICODE_V1_WORD_RANGES as words,
  AUTONOMOUS_UNICODE_V1_WHITESPACE_RANGES as whitespace,
  isAutonomousLetterCodePointV1 as isLetter,
  isAutonomousWordCodePointV1 as isWord,
  isAutonomousWhitespaceCodePointV1 as isWhitespace,
} from '../../../src/extraction/AutonomousUnicodeV1';

describe('fixed autonomous lexical Unicode v1 data', () => {
  test('pins the complete range serialization independently of host Unicode', () => {
    expect(descriptor).toEqual({
      unicodeVersion: '16.0.0',
      letterRangeCount: 677,
      wordRangeCount: 819,
      whitespaceCodePointCount: 25,
      tableHash: 'f50cbee92e89dd4470605dc8af6e637faa89175b41e77cdfbfc5e0b379115757',
    });
    expect(
      createHash('sha256')
        .update(JSON.stringify({ unicodeVersion: '16.0.0', letters, words, whitespace }))
        .digest('hex'),
    ).toBe(descriptor.tableHash);
    expect(Object.isFrozen(descriptor)).toBe(true);
  });

  test.each([
    ['letter', letters, isLetter],
    ['word', words, isWord],
    ['whitespace', whitespace, isWhitespace],
  ] as const)(
    'has frozen disjoint scalar %s ranges and correct lookup at every edge',
    (_name, ranges, lookup) => {
      expect(Object.isFrozen(ranges)).toBe(true);
      let previousEnd = -2;
      for (const range of ranges) {
        const [start, end] = range;
        expect(Object.isFrozen(range)).toBe(true);
        expect(start).toBeGreaterThan(previousEnd + 1);
        expect(end).toBeGreaterThanOrEqual(start);
        expect(end).toBeLessThanOrEqual(0x10ffff);
        expect(start <= 0xdfff && end >= 0xd800).toBe(false);
        expect(lookup(start)).toBe(true);
        expect(lookup(end)).toBe(true);
        expect(lookup(Math.floor((start + end) / 2))).toBe(true);
        expect(lookup(start - 1)).toBe(false);
        expect(lookup(end + 1)).toBe(false);
        previousEnd = end;
      }
    },
  );

  test('keeps open Unicode values distinct from English structural tokens and punctuation', () => {
    for (const character of ['A', 'z', 'é', '中', 'م', '𠀀']) {
      const point = character.codePointAt(0)!;
      expect(isLetter(point)).toBe(true);
      expect(isWord(point)).toBe(true);
    }
    for (const character of ['0', '٣', '\u0301']) {
      const point = character.codePointAt(0)!;
      expect(isLetter(point)).toBe(false);
      expect(isWord(point)).toBe(true);
    }
    for (const character of ['😀', '_', '-', "'", '’', '.', ' ']) {
      const point = character.codePointAt(0)!;
      expect(isLetter(point)).toBe(false);
      expect(isWord(point)).toBe(false);
    }
  });

  test('freezes ECMAScript whitespace and line terminators without Unicode White_Space drift', () => {
    const expected = [
      9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201,
      8202, 8232, 8233, 8239, 8287, 12288, 65279,
    ];
    const actual = whitespace.flatMap(([start, end]) =>
      Array.from({ length: end - start + 1 }, (_, index) => start + index),
    );
    expect(actual).toEqual(expected);
    for (const point of expected) expect(isWhitespace(point)).toBe(true);
    for (const point of [0, 8, 14, 0x85, 0x180e, 0x200b, 0x2060, 0xfffe])
      expect(isWhitespace(point)).toBe(false);
  });

  test('rejects invalid scalar inputs without coercion or user code', () => {
    let traps = 0;
    const object = { valueOf: () => ++traps, [Symbol.toPrimitive]: () => ++traps };
    const proxy = new Proxy({}, { get: () => ++traps });
    const invalid: unknown[] = [
      -1,
      1.5,
      NaN,
      Infinity,
      -Infinity,
      0x110000,
      0xd800,
      0xdfff,
      '65',
      null,
      undefined,
      object,
      proxy,
      Symbol('synthetic'),
      BigInt(65),
    ];
    for (const value of invalid)
      for (const lookup of [isLetter, isWord, isWhitespace])
        expect(lookup(value as number)).toBe(false);
    expect(traps).toBe(0);
  });
});
