import {
  AutonomousPersonalEvidenceSelectionV1OwnedDataSchema,
  AutonomousPersonalEvidenceSelectionV1Schema,
} from '../../../src/schemas/AutonomousPersonalEvidenceSelectionV1.schema';

const hash = 'a'.repeat(64);
function complete(count = 1) {
  return {
    version: 1,
    status: 'complete',
    sourceId: '10000000-0000-4000-8000-000000000001',
    sourceHash: hash,
    descriptorHash: hash,
    policyFingerprint: hash,
    geometryHash: hash,
    sourceScanHash: hash,
    framingHash: hash,
    typedSyntaxHash: hash,
    sourceCoverage: {
      status: 'complete',
      scanStatus: 'complete',
      sourceUnitCount: count,
      candidateUnitCount: count,
      neutralUnitCount: 0,
      withheldUnitCount: 0,
      unresolvedUnitCount: 0,
      unresolvedReason: null,
    },
    units: Array.from({ length: count }, (_, unitIndex) => ({
      unitIndex,
      unitId: unitIndex.toString(16).padStart(64, '0'),
      outcome: 'candidate',
      kind: 'source_statement_record',
      reason: null,
    })),
    occurrences: Array.from({ length: count }, (_, candidateIndex) => ({
      candidateIndex,
      unitIndex: candidateIndex,
      kind: 'source_statement_record',
      category: 'personal_assertion',
      key: hash,
      evidenceHash: hash,
      meaningHash: hash,
      dependencies: [{ index: 0, dependencyHash: hash }],
      rawSpan: { start: candidateIndex * 10, end: candidateIndex * 10 + 9 },
      mappedSpan: { start: candidateIndex * 10, end: candidateIndex * 10 + 9 },
    })),
  };
}

function frozen(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  expect(Object.isFrozen(value)).toBe(true);
  Object.values(value).forEach(frozen);
}

describe('Autonomous evidence selection DATA schema', () => {
  test('owns and freezes a detached maximum legal complete report', () => {
    const input = complete(32);
    const result = AutonomousPersonalEvidenceSelectionV1Schema.parse(input);
    expect(result.units).toHaveLength(32);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(512 * 1024);
    frozen(result);
    input.occurrences[0].rawSpan.start = 4;
    expect(result.occurrences[0].rawSpan.start).toBe(0);
  });

  test('empty complete input has honest complete zero-unit coverage', () => {
    expect(AutonomousPersonalEvidenceSelectionV1Schema.parse(complete(0)).units).toEqual([]);
  });

  test.each(['accepted', 'eligible', 'permission', 'receipt', 'sourceText'])(
    'rejects undeclared authority or payload field %s',
    (key) => {
      expect(
        AutonomousPersonalEvidenceSelectionV1Schema.safeParse({ ...complete(), [key]: true })
          .success,
      ).toBe(false);
    },
  );

  test('rejects a candidate without its complete occurrence', () => {
    const input = complete();
    input.occurrences = [];
    expect(AutonomousPersonalEvidenceSelectionV1Schema.safeParse(input).success).toBe(false);
  });

  test('rejects false coverage, unit linkage, category and unequal span lengths', () => {
    const coverage = complete();
    coverage.sourceCoverage.candidateUnitCount = 0;
    const linkage = complete();
    linkage.occurrences[0].unitIndex = 1;
    const category = complete();
    category.occurrences[0].kind = 'typed_preference';
    category.units[0].kind = 'typed_preference';
    const geometry = complete();
    geometry.occurrences[0].mappedSpan.end++;
    for (const input of [coverage, linkage, category, geometry])
      expect(AutonomousPersonalEvidenceSelectionV1Schema.safeParse(input).success).toBe(false);
  });

  test('retains partial coverage and specific unresolved reasons without claiming all units selected', () => {
    const input = complete(3);
    const unresolvedUnit = {
      unitIndex: 1,
      unitId: '1'.padStart(64, '0'),
      outcome: 'unresolved',
      kind: null,
      reason: 'provider_conflict',
    };
    const suffixUnit = {
      unitIndex: 2,
      unitId: '2'.padStart(64, '0'),
      outcome: 'unresolved',
      kind: null,
      reason: 'ambiguous_scope',
    };
    input.occurrences = input.occurrences.slice(0, 1);
    const report = {
      ...input,
      units: [input.units[0], unresolvedUnit, suffixUnit],
      sourceCoverage: {
        ...input.sourceCoverage,
        status: 'partial',
        candidateUnitCount: 1,
        unresolvedUnitCount: 2,
        unresolvedReason: 'multiple',
      },
    };
    expect(AutonomousPersonalEvidenceSelectionV1Schema.parse(report).sourceCoverage.status).toBe(
      'partial',
    );
    expect(
      AutonomousPersonalEvidenceSelectionV1Schema.safeParse({
        ...report,
        sourceCoverage: { ...report.sourceCoverage, unresolvedReason: 'provider_unknown' },
      }).success,
    ).toBe(false);
  });

  test('validates a no-prefix capacity branch over all 128 scanned units', () => {
    const input = {
      ...complete(0),
      status: 'capacity',
      reason: 'unit_count',
      sourceCoverage: {
        status: 'unknown',
        scanStatus: 'complete',
        sourceUnitCount: 128,
        candidateUnitCount: 0,
        neutralUnitCount: 0,
        withheldUnitCount: 0,
        unresolvedUnitCount: 128,
        unresolvedReason: 'interpretation_capacity',
      },
    };
    expect(AutonomousPersonalEvidenceSelectionV1Schema.parse(input).occurrences).toEqual([]);
    expect(
      AutonomousPersonalEvidenceSelectionV1Schema.safeParse({
        ...input,
        occurrences: complete().occurrences,
      }).success,
    ).toBe(false);
  });

  test('preserves distinct whole-report capacity reasons and rejects incorrect pairing', () => {
    for (const reason of ['typed_metadata', 'aggregate']) {
      const input = {
        ...complete(0),
        status: 'capacity',
        reason,
        sourceCoverage: {
          status: 'unknown',
          scanStatus: 'complete',
          sourceUnitCount: 1,
          candidateUnitCount: 0,
          neutralUnitCount: 0,
          withheldUnitCount: 0,
          unresolvedUnitCount: 1,
          unresolvedReason: 'interpretation_capacity',
        },
      };
      expect(AutonomousPersonalEvidenceSelectionV1Schema.parse(input)).toMatchObject({ reason });
      expect(
        AutonomousPersonalEvidenceSelectionV1Schema.safeParse({ ...input, reason: 'unit_count' })
          .success,
      ).toBe(false);
    }
  });

  test('rejects more than 32 total dependency roots without weakening individual shapes', () => {
    const input = complete(32);
    input.units[0].kind = 'typed_preference';
    input.occurrences[0].kind = 'typed_preference';
    input.occurrences[0].category = 'preference';
    input.occurrences[0].dependencies.push({ index: 1, dependencyHash: hash });
    expect(AutonomousPersonalEvidenceSelectionV1Schema.safeParse(input).success).toBe(false);
  });

  test('raw getters/proxies are rejected without observation and errors stay bounded', () => {
    let reads = 0;
    const getter = Object.defineProperty({}, 'version', {
      enumerable: true,
      get() {
        reads++;
        throw new Error('private-sentinel');
      },
    });
    const proxy = new Proxy(complete(), {
      ownKeys() {
        reads++;
        throw new Error('private-sentinel');
      },
    });
    for (const input of [getter, proxy]) {
      const result = AutonomousPersonalEvidenceSelectionV1Schema.safeParse(input);
      expect(result.success).toBe(false);
      if (result.success) throw new Error('Expected rejection');
      expect(result.error.issues).toEqual([
        { code: 'custom', path: [], message: 'invalid_autonomous_evidence_selection_data' },
      ]);
      frozen(result.error.issues);
    }
    expect(reads).toBe(0);
  });

  test('the already-owned schema remains strict about outcome/reason pairing', () => {
    const input = complete(0);
    const invalid = {
      ...input,
      units: [{ unitIndex: 0, unitId: hash, outcome: 'neutral', kind: null, reason: null }],
    };
    expect(AutonomousPersonalEvidenceSelectionV1OwnedDataSchema.safeParse(invalid).success).toBe(
      false,
    );
  });
});
