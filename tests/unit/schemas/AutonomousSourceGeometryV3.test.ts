import { createHash } from 'crypto';
import {
  compileAutonomousSourceGeometryV3 as compile,
  hashAutonomousSourceGeometryV3 as hash,
  AutonomousSourceGeometryV3Schema as Schema,
} from '../../../src/schemas/AutonomousSourceGeometryV3.schema';
import { hashAutomaticCaptureV2 } from '../../../src/schemas/AutomaticCapture.schema';
const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const full = (rawContent: string, quoteRegions: Array<{ start: number; end: number }> = []) => ({
  rawContent,
  mapping: { mode: 'full_body' },
  quoteRegions,
});
const region = (
  rawContent: string,
  start: number,
  end: number,
  quoteRegions: Array<{ start: number; end: number }> = [],
) => ({
  rawContent,
  mapping: {
    mode: 'application_region',
    humanRegion: { start, end },
    applicationWrapper: { configurationFingerprint: 'a'.repeat(64) },
  },
  quoteRegions,
});

describe('autonomous source geometry is data, not source authority', () => {
  test('preserves the complete raw body without normalization or heuristic prefix removal', () => {
    const raw = 'Speaker: Remember this:  Cafe\u0301 😀\n';
    const result = compile(full(raw));
    expect(result.mappedHumanBody).toBe(raw);
    expect(result.geometry).toEqual({
      version: 3,
      mode: 'full_body',
      rawContentHash: sha(raw),
      mappedContentHash: sha(raw),
      rawUtf16Length: raw.length,
      mappedUtf16Length: raw.length,
      humanRegion: null,
      mappings: [],
      quoteRegionSpace: 'mapped_utf16',
      quoteRegions: [],
      applicationWrapper: null,
    });
    expect(result.geometryHash).toBe(
      hashAutomaticCaptureV2({
        domain: 'engram-autonomous-geometry-v1',
        geometry: result.geometry,
      }),
    );
    expect(hash(result.geometry)).toBe(result.geometryHash);
    expect(compile(full('é')).geometryHash).not.toBe(compile(full('e\u0301')).geometryHash);
  });
  test.each([
    ['', 'footer'],
    ['🧭 Application: ', '\nFooter'],
    ['prefix', ''],
  ])('derives exactly one explicit region with prefix %j and suffix %j', (prefix, suffix) => {
    const body = 'I prefer  practical examples.';
    const raw = prefix + body + suffix;
    const result = compile(region(raw, prefix.length, prefix.length + body.length));
    expect(result.mappedHumanBody).toBe(body);
    expect(result.geometry).toMatchObject({
      mode: 'application_region',
      rawContentHash: sha(raw),
      mappedContentHash: sha(body),
      rawUtf16Length: raw.length,
      mappedUtf16Length: body.length,
      humanRegion: { start: prefix.length, end: prefix.length + body.length },
      mappings: [
        {
          rawStart: prefix.length,
          rawEnd: prefix.length + body.length,
          mappedStart: 0,
          mappedEnd: body.length,
        },
      ],
      applicationWrapper: { configurationFingerprint: 'a'.repeat(64) },
    });
    expect(result).not.toHaveProperty('should_process');
    expect(result).not.toHaveProperty('actor');
    expect(result).not.toHaveProperty('accepted');
  });
  test('does not accept a second supplied body, missing attestation or stitched maps', () => {
    const value = region('[human]', 1, 6);
    for (const changed of [
      { ...value, mappedHumanBody: 'human' },
      { ...value, mapping: { ...value.mapping, applicationWrapper: undefined } },
      {
        ...value,
        mapping: {
          ...value.mapping,
          mappings: [{ rawStart: 1, rawEnd: 2, mappedStart: 0, mappedEnd: 1 }],
        },
      },
      { ...value, mapping: { mode: 'substring_search', literal: 'human' } },
      { ...value, quoted_message_id: 'synthetic-reference' },
    ])
      expect(() => compile(changed)).toThrow('invalid_source_geometry_data');
  });
  test('checks surrogate boundaries in both the raw region and mapped quote coordinates', () => {
    const raw = 'x😀y';
    expect(compile(region(raw, 1, 3)).mappedHumanBody).toBe('😀');
    expect(compile(full(raw, [{ start: 1, end: 3 }])).geometry.quoteRegions).toEqual([
      { start: 1, end: 3 },
    ]);
    for (const value of [
      region(raw, 1, 2),
      region(raw, 2, 3),
      full(raw, [{ start: 1, end: 2 }]),
      full(raw, [{ start: 2, end: 3 }]),
    ])
      expect(() => compile(value)).toThrow('invalid_source_geometry_data');
    for (const rawContent of ['\ud800', '\udfff', 'x\ud800y'])
      expect(() => compile(full(rawContent))).toThrow('invalid_source_geometry_data');
  });
  test('uses mapped quote offsets and rejects overlap, reversed order and invalid bounds', () => {
    const body = 'abcdef';
    const prefix = 'Application: ';
    const raw = prefix + body;
    const result = compile(region(raw, prefix.length, raw.length, [{ start: 1, end: 3 }]));
    expect(result.geometry.quoteRegions).toEqual([{ start: 1, end: 3 }]);
    expect(() =>
      compile(
        region(raw, prefix.length, raw.length, [
          { start: prefix.length + 1, end: prefix.length + 3 },
        ]),
      ),
    ).toThrow();
    for (const quotes of [
      [
        { start: 0, end: 3 },
        { start: 2, end: 4 },
      ],
      [
        { start: 4, end: 5 },
        { start: 1, end: 2 },
      ],
      [{ start: 1, end: 1 }],
      [{ start: -1, end: 1 }],
      [{ start: 1.5, end: 3 }],
      [{ start: 0, end: 7 }],
    ])
      expect(() => compile(full(body, quotes))).toThrow('invalid_source_geometry_data');
  });
  test('allows 32 combined regions but never truncates a 33rd region', () => {
    const quotes = Array.from({ length: 32 }, (_, index) => ({
      start: index * 2,
      end: index * 2 + 1,
    }));
    expect(compile(full('x'.repeat(64), quotes)).geometry.quoteRegions).toHaveLength(32);
    expect(
      compile(region('[' + 'x'.repeat(64) + ']', 1, 65, quotes.slice(0, 31))).geometry.quoteRegions,
    ).toHaveLength(31);
    expect(() => compile(region('[' + 'x'.repeat(64) + ']', 1, 65, quotes))).toThrow(
      'invalid_source_geometry_data',
    );
    expect(() => compile(full('x'.repeat(66), [...quotes, { start: 64, end: 65 }]))).toThrow(
      'invalid_source_geometry_data',
    );
  });
  test.each(['x'.repeat(65536), 'é'.repeat(32768), '😀'.repeat(16384), '\u0001'.repeat(65536)])(
    'accepts one maximum-byte source under the single-source preflight bound',
    (raw) => {
      expect(Buffer.byteLength(raw)).toBe(65536);
      const result = compile(full(raw));
      expect(result.mappedHumanBody).toBe(raw);
      expect(result.geometry.rawContentHash).toBe(sha(raw));
      expect(() => compile(full(raw + 'x'))).toThrow('invalid_source_geometry_data');
    },
  );
  test('represents an empty full body as data without manufacturing a source permission', () => {
    const empty = compile(full(''));
    expect(empty.geometry).toMatchObject({
      rawUtf16Length: 0,
      mappedUtf16Length: 0,
      rawContentHash: sha(''),
      mappedContentHash: sha(''),
    });
    expect(empty.mappedHumanBody).toBe('');
    expect(empty).not.toHaveProperty('sourceId');
    expect(() => compile(region('', 0, 0))).toThrow();
  });
  test('enforces intrinsic metadata equality for full body and full-span application mappings', () => {
    for (const result of [compile(full('abcd')), compile(region('abcd', 0, 4))]) {
      expect(
        Schema.safeParse({ ...result.geometry, mappedContentHash: 'b'.repeat(64) }).success,
      ).toBe(false);
      expect(Schema.safeParse({ ...result.geometry, mappedUtf16Length: 3 }).success).toBe(false);
    }
    const partial = compile(region('[abcd]', 1, 5));
    const dataOnly = { ...partial.geometry, mappedContentHash: 'b'.repeat(64) };
    expect(Schema.safeParse(dataOnly).success).toBe(true);
    expect(hash(dataOnly)).not.toBe(partial.geometryHash);
    // Metadata has no raw text: only the compiler/actual-source gate can verify this hash.
    expect(compile(region('[abcd]', 1, 5)).geometry.mappedContentHash).toBe(sha('abcd'));
  });
  test('rejects inconsistent metadata, preserves key-order hashing and freezes detached outputs', () => {
    const value = region('[abcd]', 1, 5, [{ start: 0, end: 1 }]);
    const result = compile(value);
    const geometry = result.geometry;
    for (const invalid of [
      { ...geometry, version: 2 },
      { ...geometry, quoteRegionSpace: 'raw_utf16' },
      { ...geometry, mappings: [] },
      { ...geometry, humanRegion: null },
      { ...geometry, mappings: [{ ...geometry.mappings[0], mappedEnd: 3 }] },
      { ...geometry, rawUtf16Length: 65537 },
      { ...geometry, accepted: true },
    ])
      expect(Schema.safeParse(invalid).success).toBe(false);
    expect(hash(Object.fromEntries(Object.entries(geometry).reverse()))).toBe(result.geometryHash);
    value.quoteRegions[0].end = 2;
    expect(geometry.quoteRegions[0].end).toBe(1);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(geometry.mappings[0])).toBe(true);
    expect(Object.isFrozen(geometry.quoteRegions[0])).toBe(true);
    expect(Object.isFrozen(Schema.parse(geometry))).toBe(true);
  });
  test('measures the largest valid closed metadata inventory honestly below 16 KiB', () => {
    const raw = '[' + 'x'.repeat(65534) + ']';
    const quotes = Array.from({ length: 31 }, (_, index) => ({
      start: 65472 + index * 2,
      end: 65473 + index * 2,
    }));
    const result = compile(region(raw, 1, 65535, quotes));
    const bytes = Buffer.byteLength(JSON.stringify(result.geometry));
    expect(bytes).toBeGreaterThan(1000);
    expect(bytes).toBeLessThanOrEqual(16384);
    expect(Schema.safeParse(result.geometry).success).toBe(true);
  });
  test('owns raw inputs before Zod or hashing with fixed errors and no I/O', () => {
    const request = jest.spyOn(global, 'fetch').mockImplementation(() => {
      throw new Error('Unexpected provider request');
    });
    try {
      let traps = 0;
      for (const value of [
        Object.defineProperty({}, 'then', { enumerable: true, get: () => ++traps }),
        Object.defineProperty({}, 'rawContent', { enumerable: true, get: () => ++traps }),
        new Proxy(
          {},
          {
            get: () => ++traps,
            ownKeys: () => {
              traps++;
              return [];
            },
          },
        ),
        { ...full('x'), toJSON: () => ++traps },
      ]) {
        expect(() => compile(value)).toThrow('invalid_source_geometry_data');
        expect(() => hash(value)).toThrow('invalid_source_geometry_data');
        expect(Schema.safeParse(value).success).toBe(false);
      }
      expect(traps).toBe(0);
      const cyclic = { child: null as unknown };
      cyclic.child = cyclic;
      for (const value of [cyclic, { padding: 'synthetic-private-'.repeat(2000) }]) {
        const result = Schema.safeParse(value);
        expect(result.success).toBe(false);
        if (!result.success)
          expect(result.error.issues).toEqual([
            { code: 'custom', path: [], message: 'invalid_source_geometry_data' },
          ]);
      }
      expect(request).not.toHaveBeenCalled();
    } finally {
      request.mockRestore();
    }
  });
});
