import { cloneBoundedAutomaticCaptureJson } from '../../../src/storage/BoundedAutomaticCaptureJson';
import {
  AutonomousPersonalProviderResponseV1OwnedDataSchema as OwnedDataSchema,
  AutonomousPersonalProviderResponseV1Schema as Schema,
  validateAutonomousPersonalProviderResponseV1 as validate,
} from '../../../src/schemas/AutonomousPersonalProviderV1.schema';

const downgradeReasons = [
  'sensitive',
  'uncertain',
  'conditional',
  'reported',
  'quoted',
  'third_party',
  'transient',
  'ambiguous_scope',
] as const;

const unitId = (index: number) => index.toString(16).padStart(64, '0');
type ProviderRowInput = Record<string, unknown>;
const row = (index: number, overrides: Record<string, unknown> = {}): ProviderRowInput => ({
  unitId: unitId(index),
  category: 'personal_assertion',
  risk: 'ordinary',
  usefulness: 'personal_memory',
  downgrade: [] as string[],
  ...overrides,
});
const response = (units: ProviderRowInput[]) => ({ version: 1, units });
const request = (
  units: ProviderRowInput[],
  ids: string[] = units.map((unit) => String(unit.unitId)),
) => ({
  response: response(units),
  unitIds: ids,
});

function expectDeepFrozen(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) expectDeepFrozen(child);
}

describe('autonomous provider response v1 is bounded interpretation DATA', () => {
  test('parses the exact closed response and freezes a detached copy', () => {
    const input = response([row(1), row(2, { category: 'preference', usefulness: 'unknown' })]);
    const parsed = Schema.parse(input);
    const before = structuredClone(parsed);

    input.units[0].category = 'interest';
    input.units.reverse();

    expect(parsed).toEqual(before);
    expect(parsed).toEqual({
      version: 1,
      units: [row(1), row(2, { category: 'preference', usefulness: 'unknown' })],
    });
    expectDeepFrozen(parsed);
    expect(parsed).not.toHaveProperty('accepted');
    expect(parsed).not.toHaveProperty('should_process');
    expect(parsed).not.toHaveProperty('actor');
    expect(parsed).not.toHaveProperty('sourceOffsets');
  });

  test('requires exact registered ID-set equality and returns registered order', () => {
    const units = [row(1), row(2), row(3)];
    const reversedIds = [unitId(3), unitId(2), unitId(1)];
    const validated = validate(request(units, reversedIds));
    expect(validated).toEqual(response([row(3), row(2), row(1)]));
    expectDeepFrozen(validated);

    expect(() => validate(request(units, [unitId(1), unitId(2)]))).toThrow(
      'invalid_autonomous_provider_data',
    );
    expect(() => validate(request(units, [unitId(1), unitId(2), unitId(4)]))).toThrow(
      'invalid_autonomous_provider_data',
    );
    expect(() => validate(request([row(1), row(1)], [unitId(1)]))).toThrow(
      'invalid_autonomous_provider_data',
    );
    expect(() => validate(request([row(1), row(2)], [unitId(1), unitId(1)]))).toThrow(
      'invalid_autonomous_provider_data',
    );
  });

  test('accepts empty data and rejects standalone duplicate unit IDs', () => {
    expect(Schema.parse(response([]))).toEqual(response([]));
    expect(validate(request([], []))).toEqual(response([]));
    expect(Schema.safeParse(response([row(1), row(1)])).success).toBe(false);
  });

  test('accepts every closed category, usefulness, risk and downgrade enum value', () => {
    const categories = [
      'preference',
      'work_role',
      'work_affiliation',
      'project',
      'skill',
      'interest',
      'broad_location',
      'self_description',
      'personal_assertion',
      'unknown',
    ];
    const units = categories.map((category, index) =>
      row(index + 1, {
        category,
        usefulness: ['personal_memory', 'not_memory', 'unknown'][index % 3],
        risk: ['ordinary', 'sensitive', 'unknown'][index % 3],
        downgrade: index < downgradeReasons.length ? [downgradeReasons[index]] : [],
      }),
    );
    expect(Schema.parse(response(units)).units.map((unit) => unit.category)).toEqual(categories);
  });

  test('keeps risk contradictions as valid untrusted DATA for later gates', () => {
    const data = response([
      row(1, { risk: 'sensitive', usefulness: 'personal_memory', downgrade: [] }),
      row(2, { risk: 'ordinary', usefulness: 'personal_memory', downgrade: ['sensitive'] }),
      row(3, { category: 'unknown', risk: 'unknown', usefulness: 'unknown' }),
    ]);
    expect(Schema.parse(data)).toEqual(data);
    expect(validate(request(data.units)).units).toEqual(data.units);
  });

  test('rejects unknown keys, invalid versions, missing required fields and non-data verdict fields', () => {
    const valid = response([row(1)]);
    const badResponses = [
      { ...valid, version: 2 },
      { ...valid, accepted: true },
      { ...valid, actor: 'synthetic-actor' },
      { ...valid, should_process: true },
      response([{ ...row(1), sourceOffsets: { start: 0, end: 5 } }]),
      response([{ ...row(1), confidence: 0.99 }]),
      response([{ ...row(1), acceptance: 'accepted' }]),
      response([{ ...row(1), should_process: true }]),
      response([{ ...row(1), rawText: 'raw source' }]),
      response([{ ...row(1), risk: undefined }]),
      response([{ ...row(1), downgrade: undefined }]),
      response([{ ...row(1), usefulness: 'maybe' }]),
      response([{ ...row(1), category: 'unknown-category' }]),
      response([{ ...row(1), unitId: 'A'.repeat(64) }]),
      response([{ ...row(1), downgrade: ['not-a-reason'] }]),
      response([{ ...row(1), downgrade: ['uncertain', 'uncertain'] }]),
      response([{ ...row(1), downgrade: [...downgradeReasons, 'sensitive'] }]),
      response(Array.from({ length: 33 }, (_, index) => row(index + 1))),
    ];
    for (const invalid of badResponses) expect(Schema.safeParse(invalid).success).toBe(false);

    const badRequests = [
      { response: valid },
      { response: valid, unitIds: [unitId(1)], unknown: true },
      { response: valid, unitIds: ['not-a-hash'] },
      { response: valid, unitIds: Array.from({ length: 33 }, (_, index) => unitId(index + 1)) },
    ];
    for (const invalid of badRequests)
      expect(() => validate(invalid)).toThrow('invalid_autonomous_provider_data');
  });

  test('owns every public raw entry before Zod without invoking getters, thenables, proxies or toJSON', () => {
    let traps = 0;
    const thenGetter = Object.defineProperty({}, 'then', {
      enumerable: true,
      get: () => ++traps,
    });
    const unitsGetter = Object.defineProperty({}, 'units', {
      enumerable: true,
      get: () => ++traps,
    });
    const responseGetter = Object.defineProperty({}, 'response', {
      enumerable: true,
      get: () => ++traps,
    });
    const proxy = new Proxy(
      {},
      {
        get: () => {
          traps += 1;
          return undefined;
        },
        ownKeys: () => {
          traps += 1;
          return [];
        },
      },
    );
    const toJson = { toJSON: () => ++traps };
    const nestedGetter = response([row(1, { downgrade: ['sensitive'] })]);
    Object.defineProperty(nestedGetter.units[0].downgrade, '0', {
      enumerable: true,
      configurable: true,
      get: () => ++traps,
    });
    const nestedProxy = response([
      row(1, {
        downgrade: new Proxy(['sensitive'], {
          get: () => {
            traps += 1;
            return undefined;
          },
          ownKeys: () => {
            traps += 1;
            return [];
          },
        }),
      }),
    ]);

    for (const hostile of [thenGetter, unitsGetter, proxy, toJson]) {
      expect(() => Schema.parse(hostile)).toThrow('invalid_autonomous_provider_data');
      expect(Schema.safeParse(hostile).success).toBe(false);
    }
    for (const hostile of [responseGetter, proxy, toJson, nestedGetter, nestedProxy]) {
      expect(() => Schema.parse(hostile)).toThrow('invalid_autonomous_provider_data');
      const result = Schema.safeParse(hostile);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]).toMatchObject({
          code: 'custom',
          path: [],
          message: 'invalid_autonomous_provider_data',
        });
      }
    }
    for (const hostile of [
      responseGetter,
      proxy,
      toJson,
      { response: nestedGetter, unitIds: [unitId(1)] },
      { response: nestedProxy, unitIds: [unitId(1)] },
    ])
      expect(() => validate(hostile)).toThrow('invalid_autonomous_provider_data');
    expect(traps).toBe(0);
  });

  test('returns the fixed redacted failure for invalid data', () => {
    const secret = 'private-synthetic-' + 'x'.repeat(500);
    const invalid = { ...response([row(1)]), privateDiagnostic: secret };
    expect(() => Schema.parse(invalid)).toThrow('invalid_autonomous_provider_data');
    const parsed = Schema.safeParse(invalid);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues).toEqual([
        {
          code: 'custom',
          path: [],
          message: 'invalid_autonomous_provider_data',
        },
      ]);
      expect(parsed.error.message).not.toContain(secret);
    }
    expect(() => validate({ response: invalid, unitIds: [unitId(1)] })).toThrow(
      'invalid_autonomous_provider_data',
    );
  });

  test('accepts the maximum legal 32-row, eight-downgrade aggregate under 16KiB', () => {
    const units = Array.from({ length: 32 }, (_, index) =>
      row(index + 1, {
        category: 'personal_assertion',
        risk: 'sensitive',
        usefulness: 'personal_memory',
        downgrade: [...downgradeReasons],
      }),
    );
    const input = request(units, units.map((unit) => String(unit.unitId)).reverse());
    const responseBytes = Buffer.byteLength(JSON.stringify(input.response), 'utf8');
    const aggregateBytes = Buffer.byteLength(JSON.stringify(input), 'utf8');

    expect(responseBytes).toBe(8855);
    expect(aggregateBytes).toBe(11024);
    expect(responseBytes).toBeLessThanOrEqual(16 * 1024);
    expect(aggregateBytes).toBeLessThanOrEqual(16 * 1024);
    // Bounded-clone accounting: wrapper 3 + response 934 + IDs 66 = 1,003 nodes.
    expect(() => cloneBoundedAutomaticCaptureJson(input, 'policyData')).not.toThrow();
    expect(OwnedDataSchema.safeParse(input.response).success).toBe(true);
    expect(Schema.safeParse(input.response).success).toBe(true);

    const validated = validate(input);
    expect(validated.units).toHaveLength(32);
    expect(validated.units.map((unit) => unit.unitId)).toEqual(input.unitIds);
    expectDeepFrozen(validated);

    const before = structuredClone(validated);
    input.response.units[0].category = 'interest';
    input.unitIds.reverse();
    expect(validated).toEqual(before);
  });

  test('performs no provider or other network I/O', () => {
    const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('Unexpected provider I/O');
    });
    try {
      expect(validate(request([row(1)])).units).toHaveLength(1);
      expect(Schema.parse(response([row(2)])).units).toHaveLength(1);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });

  test('rejects cycles, oversized data and excessive depth with fixed errors', () => {
    const cyclicResponse = response([row(1)]) as Record<string, unknown>;
    cyclicResponse.cycle = cyclicResponse;
    expect(() => Schema.parse(cyclicResponse)).toThrow('invalid_autonomous_provider_data');

    const cyclicRequest = request([row(1)]) as Record<string, unknown>;
    cyclicRequest.cycle = cyclicRequest;
    expect(() => validate(cyclicRequest)).toThrow('invalid_autonomous_provider_data');

    const oversizedResponse = { ...response([row(1)]), padding: 'x'.repeat(17 * 1024) };
    expect(() => Schema.parse(oversizedResponse)).toThrow('invalid_autonomous_provider_data');
    const oversizedRequest = { ...request([row(1)]), padding: 'x'.repeat(17 * 1024) };
    expect(() => validate(oversizedRequest)).toThrow('invalid_autonomous_provider_data');

    const nested = (depth: number): unknown => {
      let value: unknown = 'x';
      for (let index = 0; index < depth; index += 1) value = { nested: value };
      return value;
    };
    expect(() => Schema.parse({ ...response([row(1)]), padding: nested(20) })).toThrow(
      'invalid_autonomous_provider_data',
    );
    expect(() => validate({ ...request([row(1)]), padding: nested(40) })).toThrow(
      'invalid_autonomous_provider_data',
    );
  });
});
