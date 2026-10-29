import {
  inspectNativeCaptureAttributeKeys as inspect,
  inspectNativeCaptureAttributeValue,
  assertNativeCaptureAttributeJsonSize,
} from '../../../src/storage/NativeCaptureAttributeKeys';
import { Neo4jStorage } from '../../../src/storage/Neo4jStorage';
import { makeCompositionalCaptureFixture } from '../../helpers/compositionalCaptureFixture';
import { makeHumanFixture } from '../../helpers/automaticCommittedFixture';
import type { EpisodicNode } from '../../../src/schemas/EpisodicNode.schema';

describe('bounded native attribute key inspection before JSON parsing', () => {
  it.each([
    'engram_write_owner_v2',
    'engram_write_owner_v3',
    'engram_write_owner_v999',
    'engram_source_envelope_v2',
    'engram_source_envelope_v4',
    'engram_write_owner_v1suffix',
  ])('recognizes protected prefix %s', (key) => {
    expect(inspect(JSON.stringify({ padding: 'before', [key]: {} }))).toBe('protected');
  });
  it.each(['engram_write_owner_v1', 'engram_source_envelope_v1'])(
    'keeps canonical legacy key %s separate',
    (key) => {
      expect(inspect(JSON.stringify({ [key]: {}, padding: 'after' }))).toBe('legacy_owned');
    },
  );
  it('decodes root-key JSON escapes without parsing or allocating payload values', () => {
    expect(inspect('{"\\u0065ngram_write_owner_v\\u0033":{}}')).toBe('protected');
    expect(inspect('{"engram\\u005fsource_envelope_v2":{}}')).toBe('protected');
    expect(inspect('{"engram_write_owner_v1\\ud800":{}}')).toBe('protected');
    expect(inspect('{"\\ud83d\\ude00":{},"engram_write_owner_v3":{}}')).toBe('protected');
  });
  it('does not mistake nested keys or quoted values for protected root keys', () => {
    expect(
      inspect(
        JSON.stringify({
          nested: { engram_write_owner_v3: {} },
          text: '"engram_source_envelope_v2":{}',
        }),
      ),
    ).toBe('unowned');
    expect(inspect('{"x":"\\\"engram_write_owner_v3\\\":{}"}')).toBe('unowned');
  });
  it('conservatively retains an earlier protected duplicate even if overwritten', () => {
    expect(inspect('{"engram_write_owner_v3":{},"engram_write_owner_v3":null}')).toBe('protected');
    expect(inspect('{"engram_write_owner_v1":{},"engram_write_owner_v3":{}}')).toBe('protected');
  });
  it('handles long ordinary keys and deeply nested values with scalar scan state', () => {
    expect(inspect(`{"${'x'.repeat(100000)}":0}`)).toBe('unowned');
    const nested = '['.repeat(50000) + '0' + ']'.repeat(50000);
    expect(inspect(`{"nested":${nested},"engram_write_owner_v3":{}}`)).toBe('protected');
    expect(inspect(`{"nested":${nested}}`)).toBe('unowned');
  });
  it.each([
    '',
    '[]',
    '{',
    '{"x":',
    '{"x":"unterminated',
    '{"x":"\\u00xx"}',
    '{"x":1,}',
    '{"x":1}tail',
  ])('leaves malformed or nonobject input uncertain: %#', (raw) => {
    expect(inspect(raw)).toBe('uncertain');
  });
  it('does not downgrade an unterminated protected key to the old parse path', () => {
    expect(inspect('{"engram_write_owner_v3')).toBe('protected');
  });
  it('matches decoded root property identities across escape variants', () => {
    for (const key of ['engram_write_owner_v2', 'engram_source_envelope_v999']) {
      for (let escaped = 0; escaped < key.length; escaped++) {
        let encoded = '';
        for (let index = 0; index < key.length; index++)
          encoded +=
            index % (escaped + 1) === 0
              ? `\\u${key.charCodeAt(index).toString(16).padStart(4, '0')}`
              : key[index];
        expect(inspect(`{"ordinary":[],"${encoded}":null}`)).toBe('protected');
      }
    }
  });
  it('checks UTF-16 length before counting UTF-8 bytes and enforces both bounds', () => {
    const bytes = jest.spyOn(Buffer, 'byteLength');
    try {
      expect(() => assertNativeCaptureAttributeJsonSize('x'.repeat(524289))).toThrow(
        'native_attributes_too_large',
      );
      expect(bytes).not.toHaveBeenCalled();
      expect(() => assertNativeCaptureAttributeJsonSize('界'.repeat(180000))).toThrow(
        'native_attributes_too_large',
      );
      expect(bytes).toHaveBeenCalledTimes(1);
    } finally {
      bytes.mockRestore();
    }
  });
  it('inspects object keys without invoking source getters or proxy traps', () => {
    let calls = 0;
    const value = Object.defineProperty({}, 'engram_write_owner_v3', {
      enumerable: true,
      get() {
        calls++;
        return {};
      },
    });
    expect(inspectNativeCaptureAttributeValue(value)).toBe('protected');
    const proxy = new Proxy(
      {},
      {
        ownKeys() {
          calls++;
          throw new Error('must not execute');
        },
      },
    );
    expect(inspectNativeCaptureAttributeValue(proxy)).toBe('uncertain');
    expect(calls).toBe(0);
  });
});

describe('actual Neo native episode decoder preparse limits', () => {
  const decoder = () =>
    new Neo4jStorage('bolt://synthetic.invalid:7687', 'synthetic', 'synthetic') as unknown as {
      recordToEpisode(props: Record<string, unknown>, preserveRaw?: boolean): EpisodicNode;
    };
  it.each(['late_key', 'escaped_key', 'unknown_key', 'utf8_bytes', 'uncertain'])(
    'never parses oversized capture attributes: %s',
    (kind) => {
      const { source } = makeCompositionalCaptureFixture();
      const padding = kind === 'utf8_bytes' ? '界'.repeat(180000) : 'x'.repeat(600000);
      let raw = JSON.stringify({ padding, engram_write_owner_v3: {} });
      if (kind === 'escaped_key')
        raw = raw.replace('engram_write_owner_v3', '\\u0065ngram_write_owner_v\\u0033');
      if (kind === 'unknown_key')
        raw = raw.replace('engram_write_owner_v3', 'engram_write_owner_v999');
      if (kind === 'uncertain') raw = '{"padding":"' + padding;
      const parse = jest.spyOn(JSON, 'parse');
      try {
        expect(() => decoder().recordToEpisode({ ...source, attributes: raw })).toThrow(
          'native_attributes_too_large',
        );
        expect(parse.mock.calls.some(([input]) => input === raw)).toBe(false);
      } finally {
        parse.mockRestore();
      }
    },
  );
  it.each([false, true])(
    'preserves the old large ordinary/legacy-owned decode path, legacy=%s',
    (owned) => {
      const source = makeHumanFixture('large-legacy-native').human;
      const attributes = owned ? structuredClone(source.attributes) : {};
      delete attributes.engram_write_owner_v2;
      attributes.padding = 'x'.repeat(600000);
      const raw = JSON.stringify(attributes);
      const parse = jest.spyOn(JSON, 'parse');
      try {
        const result = decoder().recordToEpisode({ ...source, attributes: raw });
        expect((result.attributes.padding as string).length).toBe(600000);
        expect(parse.mock.calls.some(([input]) => input === raw)).toBe(true);
      } finally {
        parse.mockRestore();
      }
    },
  );
  it('caps explicit capture snapshot parsing before JSON even for an otherwise ordinary row', () => {
    const { source } = makeCompositionalCaptureFixture();
    const raw = JSON.stringify({ padding: 'x'.repeat(600000) });
    const parse = jest.spyOn(JSON, 'parse');
    try {
      expect(() => decoder().recordToEpisode({ ...source, attributes: raw }, true)).toThrow(
        'native_attributes_too_large',
      );
      expect(parse.mock.calls.some(([input]) => input === raw)).toBe(false);
    } finally {
      parse.mockRestore();
    }
  });
});
