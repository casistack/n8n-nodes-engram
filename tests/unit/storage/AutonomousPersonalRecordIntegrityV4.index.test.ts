import { performance } from 'node:perf_hooks';
import * as lossless from '../../../src/storage/LosslessAutomaticCaptureGraph';
import * as qualifiedClaims from '../../../src/extraction/AutonomousPersonalQualifiedClaimV4';
import { AutonomousPersonalTypedSyntaxFailureV1 } from '../../../src/extraction/AutonomousPersonalTypedSyntaxV1';
import type { AutonomousPersonalTypedSyntaxWorkV1 } from '../../../src/schemas/AutonomousPersonalTypedSyntaxV1.schema';
import { GraphDataSchema, type GraphData } from '../../../src/schemas/GraphData.schema';
import {
  AutonomousPersonalOperationV4OwnedDataSchema,
  AutonomousPersonalReceiptV4OwnedDataSchema,
} from '../../../src/schemas/AutonomousPersonalOperationV4.schema';
import {
  assertAutonomousPersonalRecordIntegrityV4,
  AutonomousPersonalRecordIntegrityV4Error,
  createIntegrityCheckedAutonomousPersonalClaimIndexV4,
} from '../../../src/storage/AutonomousPersonalRecordIntegrityV4';
import { autonomousPersonalQualifiedClaimFixtureV4 } from '../../helpers/autonomousPersonalQualifiedClaimV4';

let baseline: Awaited<ReturnType<typeof autonomousPersonalQualifiedClaimFixtureV4>>;

beforeAll(async () => {
  baseline = await autonomousPersonalQualifiedClaimFixtureV4();
});

afterEach(() => {
  jest.restoreAllMocks();
});

function work(
  signal: AbortSignal = new AbortController().signal,
): AutonomousPersonalTypedSyntaxWorkV1 {
  return { absoluteMonotonicDeadlineMs: performance.now() + 30_000, signal };
}

function graphCopy(): GraphData {
  return structuredClone(baseline.graph);
}

function checkedTerminalWithoutPairs(kind: 'deferred' | 'source_verdict'): GraphData {
  const graph = graphCopy();
  const operation = graph.automatic_operations_v1?.operations[0];
  if (!operation || operation.version !== 4 || operation.state !== 'committed') {
    throw new Error('Expected a committed Operation4 fixture');
  }
  const prior = operation.terminalReceipt;
  if (kind === 'deferred') {
    operation.terminalReceipt = AutonomousPersonalReceiptV4OwnedDataSchema.parse({
      version: 4,
      operationId: operation.operationId,
      sourceId: operation.identity.sourceId,
      sourceHash: operation.identity.sourceHash,
      descriptorHash: operation.identity.descriptorHash,
      policyFingerprint: operation.identity.policyFingerprint,
      terminalAt: prior.terminalAt,
      kind: 'human_autonomous_source_deferred_committed',
      interpretationCoverage: 'unknown',
      acceptedCoverage: 'none',
      acceptanceSemantics: 'per_item_kind_v1',
      sourceCoverage: {
        status: 'unknown',
        scanStatus: 'complete',
        sourceUnitCount: 1,
        candidateUnitCount: 0,
        neutralUnitCount: 0,
        withheldUnitCount: 0,
        unresolvedUnitCount: 1,
        unresolvedReason: 'provider_failure',
      },
      selection: { kind: 'source_only_deferred', reason: 'provider_auth' },
    });
  } else {
    operation.terminalReceipt = AutonomousPersonalReceiptV4OwnedDataSchema.parse({
      version: 4,
      operationId: operation.operationId,
      sourceId: operation.identity.sourceId,
      sourceHash: operation.identity.sourceHash,
      descriptorHash: operation.identity.descriptorHash,
      policyFingerprint: operation.identity.policyFingerprint,
      terminalAt: prior.terminalAt,
      kind: 'human_autonomous_source_verdict_committed',
      interpretationCoverage: 'complete',
      acceptedCoverage: 'none',
      acceptanceSemantics: 'per_item_kind_v1',
      sourceCoverage: {
        status: 'complete',
        scanStatus: 'complete',
        sourceUnitCount: 1,
        candidateUnitCount: 0,
        neutralUnitCount: 1,
        withheldUnitCount: 0,
        unresolvedUnitCount: 0,
        unresolvedReason: null,
      },
      selection: { kind: 'source_verdict', outcome: 'known_no_memory' },
    });
  }
  AutonomousPersonalOperationV4OwnedDataSchema.parse(operation);
  graph.edges = [];
  graph.entities = graph.entities.filter((entity) => entity.uuid === baseline.subject.uuid);
  return GraphDataSchema.parse(graph);
}

function isDeeplyFrozen(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return true;
  if (!Object.isFrozen(value)) return false;
  return Reflect.ownKeys(value).every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return !!descriptor && 'value' in descriptor && isDeeplyFrozen(descriptor.value);
  });
}

describe('AutonomousPersonalRecordIntegrityV4 checked index', () => {
  // The package and ts-jest compile to CommonJS; this observes its imported parse boundary.
  it('constructs one checked index for a creator graph and returns the same frozen owned graph', () => {
    const graph = graphCopy();
    const parse = jest.spyOn(lossless, 'parseLosslessAutomaticCaptureGraph');
    const index = createIntegrityCheckedAutonomousPersonalClaimIndexV4(
      graph,
      work(),
      () => undefined,
    );

    expect(parse).toHaveBeenCalledTimes(1);
    const ownedGraph = qualifiedClaims.getAutonomousPersonalClaimIndexGraphV4(index);
    expect(qualifiedClaims.getAutonomousPersonalClaimIndexGraphV4(index)).toBe(ownedGraph);
    expect(ownedGraph).not.toBe(graph);
    expect(isDeeplyFrozen(ownedGraph)).toBe(true);
    expect(graph.edges).toHaveLength(1);
    expect(
      qualifiedClaims.inspectAutonomousPersonalClaimCreatorV4(index, baseline.edge.uuid),
    ).toMatchObject({
      status: 'structural',
      proof: { claimId: baseline.edge.uuid },
    });
    expect(
      qualifiedClaims.qualifyAutonomousPersonalClaimCreatorV4(index, baseline.request),
    ).toMatchObject({ status: 'qualified' });
  });

  it.each(['deferred', 'source_verdict'] as const)(
    'constructs exactly one complete-graph index for an empty %s terminal graph',
    (kind) => {
      const graph = checkedTerminalWithoutPairs(kind);
      expect(graph.edges).toHaveLength(0);
      const parse = jest.spyOn(lossless, 'parseLosslessAutomaticCaptureGraph');
      const index = createIntegrityCheckedAutonomousPersonalClaimIndexV4(
        graph,
        work(),
        () => undefined,
      );

      expect(parse).toHaveBeenCalledTimes(1);
      const ownedGraph = qualifiedClaims.getAutonomousPersonalClaimIndexGraphV4(index);
      expect(ownedGraph).not.toBe(graph);
      expect(ownedGraph.edges).toHaveLength(0);
      expect(isDeeplyFrozen(ownedGraph)).toBe(true);
    },
  );

  it('keeps the old assertion no-footprint path ahead of Work inspection and index creation', () => {
    const graph = graphCopy();
    graph.automatic_operations_v1!.operations = [];
    graph.edges.find((edge) => edge.uuid === baseline.edge.uuid)!.attributes.engram_claim_v1 = {
      version: 2,
      key: 'legacy-claim',
    };
    const value = graph.entities.find((entity) => entity.uuid === baseline.value.uuid)!;
    value.entity_type = 'legacy_personal_value';
    value.attributes.engram_literal_v1 = { version: 2, key: 'legacy-marker' };
    let workReads = 0;
    const hostileWork = new Proxy(
      {},
      {
        get() {
          workReads += 1;
          throw new Error('old no-footprint path inspected Work');
        },
        ownKeys() {
          workReads += 1;
          throw new Error('old no-footprint path inspected Work');
        },
      },
    ) as unknown as AutonomousPersonalTypedSyntaxWorkV1;
    const parse = jest.spyOn(lossless, 'parseLosslessAutomaticCaptureGraph');
    const trustedCheck = jest.fn();

    expect(() =>
      assertAutonomousPersonalRecordIntegrityV4(graph, hostileWork, trustedCheck),
    ).not.toThrow();
    expect(trustedCheck).toHaveBeenCalled();
    expect(workReads).toBe(0);
    expect(parse).toHaveBeenCalledTimes(1);
  });

  it('refuses malformed or orphaned creator DATA before returning an index', () => {
    const malformed = graphCopy();
    const malformedOperation = malformed.automatic_operations_v1!.operations[0]!;
    if (
      malformedOperation.version !== 4 ||
      malformedOperation.state !== 'committed' ||
      malformedOperation.terminalReceipt.kind !== 'human_autonomous_capture_committed' ||
      malformedOperation.terminalReceipt.selection.kind !== 'occurrences'
    ) {
      throw new Error('Expected a committed occurrence fixture');
    }
    const occurrence = malformedOperation.terminalReceipt.selection.items[0]!;
    occurrence.evidenceHash =
      occurrence.evidenceHash === 'f'.repeat(64) ? 'e'.repeat(64) : 'f'.repeat(64);
    expect(() =>
      createIntegrityCheckedAutonomousPersonalClaimIndexV4(malformed, work(), () => undefined),
    ).toThrow(AutonomousPersonalRecordIntegrityV4Error);

    const orphan = graphCopy();
    orphan.edges = orphan.edges.filter((edge) => edge.uuid !== baseline.edge.uuid);
    expect(() =>
      createIntegrityCheckedAutonomousPersonalClaimIndexV4(orphan, work(), () => undefined),
    ).toThrow(AutonomousPersonalRecordIntegrityV4Error);
  });

  it('rejects foreign, copied, and proxied index tokens without observing proxy traps', () => {
    const index = createIntegrityCheckedAutonomousPersonalClaimIndexV4(
      graphCopy(),
      work(),
      () => undefined,
    );
    const copied = Object.freeze(Object.create(Object.getPrototypeOf(index))) as typeof index;
    const foreign = Object.freeze(Object.create(null)) as typeof index;
    let proxyTraps = 0;
    const proxied = new Proxy(index, {
      get() {
        proxyTraps += 1;
        throw new Error('index proxy observed');
      },
      ownKeys() {
        proxyTraps += 1;
        throw new Error('index proxy observed');
      },
      getPrototypeOf() {
        proxyTraps += 1;
        throw new Error('index proxy observed');
      },
    });

    expect(() => qualifiedClaims.getAutonomousPersonalClaimIndexGraphV4(copied)).toThrow(
      'invalid_autonomous_claim_request_data',
    );
    expect(() => qualifiedClaims.getAutonomousPersonalClaimIndexGraphV4(foreign)).toThrow(
      'invalid_autonomous_claim_request_data',
    );
    expect(() => qualifiedClaims.getAutonomousPersonalClaimIndexGraphV4(proxied)).toThrow(
      'invalid_autonomous_claim_request_data',
    );
    expect(proxyTraps).toBe(0);
  });

  it('keeps cancellation sticky for access to an already-created index graph', () => {
    const controller = new AbortController();
    const index = createIntegrityCheckedAutonomousPersonalClaimIndexV4(
      graphCopy(),
      work(controller.signal),
      () => undefined,
    );
    const ownedGraph = qualifiedClaims.getAutonomousPersonalClaimIndexGraphV4(index);
    expect(isDeeplyFrozen(ownedGraph)).toBe(true);
    controller.abort();

    let first: unknown;
    let second: unknown;
    try {
      qualifiedClaims.getAutonomousPersonalClaimIndexGraphV4(index);
    } catch (error) {
      first = error;
    }
    try {
      qualifiedClaims.getAutonomousPersonalClaimIndexGraphV4(index);
    } catch (error) {
      second = error;
    }
    expect(first).toBeInstanceOf(AutonomousPersonalTypedSyntaxFailureV1);
    expect(first).toMatchObject({ reason: 'cancelled' });
    expect(second).toBe(first);
  });

  it('preserves the trusted check error identity on later owned-graph access', () => {
    const failure = new Error('trusted reader work expired');
    let expired = false;
    const index = createIntegrityCheckedAutonomousPersonalClaimIndexV4(graphCopy(), work(), () => {
      if (expired) throw failure;
    });
    expired = true;

    let first: unknown;
    let second: unknown;
    try {
      qualifiedClaims.getAutonomousPersonalClaimIndexGraphV4(index);
    } catch (error) {
      first = error;
    }
    try {
      qualifiedClaims.getAutonomousPersonalClaimIndexGraphV4(index);
    } catch (error) {
      second = error;
    }
    expect(first).toBe(failure);
    expect(second).toBe(failure);
  });
});
