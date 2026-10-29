import { performance } from 'node:perf_hooks';
import {
  AutonomousPersonalRecordIntegrityV4Error,
  assertAutonomousPersonalRecordIntegrityV4,
} from '../../../src/storage/AutonomousPersonalRecordIntegrityV4';
import { AutonomousPersonalTypedSyntaxFailureV1 } from '../../../src/extraction/AutonomousPersonalTypedSyntaxV1';
import type { AutonomousPersonalTypedSyntaxWorkV1 } from '../../../src/schemas/AutonomousPersonalTypedSyntaxV1.schema';
import type { GraphData } from '../../../src/schemas/GraphData.schema';
import { GraphDataSchema } from '../../../src/schemas/GraphData.schema';
import {
  AutonomousPersonalOperationV4OwnedDataSchema,
  AutonomousPersonalReceiptV4OwnedDataSchema,
} from '../../../src/schemas/AutonomousPersonalOperationV4.schema';
import { autonomousPersonalQualifiedClaimFixtureV4 } from '../../helpers/autonomousPersonalQualifiedClaimV4';

let baseline: Awaited<ReturnType<typeof autonomousPersonalQualifiedClaimFixtureV4>>;
let foreignBaseline: Awaited<ReturnType<typeof autonomousPersonalQualifiedClaimFixtureV4>>;

beforeAll(async () => {
  baseline = await autonomousPersonalQualifiedClaimFixtureV4();
  foreignBaseline = await autonomousPersonalQualifiedClaimFixtureV4();
});

function work(
  signal: AbortSignal = new AbortController().signal,
): AutonomousPersonalTypedSyntaxWorkV1 {
  return {
    absoluteMonotonicDeadlineMs: performance.now() + 30_000,
    signal,
  };
}

function graphCopy(): GraphData {
  return structuredClone(baseline.graph);
}

function expectReason(graph: unknown, reason: string): void {
  let caught: unknown;
  try {
    assertAutonomousPersonalRecordIntegrityV4(graph, work(), () => undefined);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(AutonomousPersonalRecordIntegrityV4Error);
  expect(caught).toMatchObject({ reason });
  expect((caught as Error).message).toBe('Engram autonomous personal record integrity failed');
}

function committedOccurrenceOperation(graph: GraphData) {
  const operation = graph.automatic_operations_v1?.operations.find(
    (row) => row.version === 4 && row.state === 'committed',
  );
  if (
    !operation ||
    operation.version !== 4 ||
    operation.state !== 'committed' ||
    operation.terminalReceipt.kind !== 'human_autonomous_capture_committed' ||
    operation.terminalReceipt.selection.kind !== 'occurrences'
  ) {
    throw new Error('Expected a committed synthetic occurrence receipt');
  }
  return operation;
}

function foreignReferenceGraph(mismatchedAxis?: 'storeHash' | 'namespace' | 'subjectId'): {
  graph: GraphData;
  foreignOperation: ReturnType<typeof committedOccurrenceOperation>;
} {
  const graph = graphCopy();
  const localOperation = committedOccurrenceOperation(graph);
  const foreignOperation = structuredClone(foreignBaseline.operation);
  if (
    localOperation.terminalReceipt.kind !== 'human_autonomous_capture_committed' ||
    localOperation.terminalReceipt.selection.kind !== 'occurrences' ||
    foreignOperation.terminalReceipt.kind !== 'human_autonomous_capture_committed' ||
    foreignOperation.terminalReceipt.selection.kind !== 'occurrences'
  ) {
    throw new Error('Expected committed synthetic occurrence receipts');
  }

  const localOccurrence = localOperation.terminalReceipt.selection.items[0]!;
  const foreignOccurrence = foreignOperation.terminalReceipt.selection.items[0]!;
  if (foreignOccurrence.state === 'not_selected' || localOccurrence.claimId === null) {
    throw new Error('Expected persisted occurrences with claim IDs');
  }
  foreignOccurrence.kind = localOccurrence.kind;
  foreignOccurrence.meaningHash = localOccurrence.meaningHash;
  foreignOccurrence.effect = 'reference';
  foreignOccurrence.claimId = localOccurrence.claimId;
  foreignOccurrence.reason =
    foreignOccurrence.state === 'accepted'
      ? 'existing_accepted'
      : foreignOccurrence.state === 'proposed'
        ? 'existing_proposed'
        : 'existing_rejected';

  if (mismatchedAxis) {
    // These variants isolate direct DATA scope equality. They remain schema-valid Op4/GraphData
    // fixtures, not Source4/native ownership proofs; the source guard remains separately required.
    if (mismatchedAxis !== 'storeHash') {
      foreignOperation.identity.storeHash = localOperation.identity.storeHash;
    }
    if (mismatchedAxis !== 'namespace') {
      foreignOperation.identity.namespace = localOperation.identity.namespace;
    }
    if (mismatchedAxis !== 'subjectId') {
      foreignOperation.identity.binding.subjectId = localOperation.identity.binding.subjectId;
    }
    foreignOperation.identity.turn = `${foreignOperation.identity.turn}-scope-join-${mismatchedAxis}`;
  }

  AutonomousPersonalOperationV4OwnedDataSchema.parse(foreignOperation);
  graph.entities.push(
    ...foreignBaseline.graph.entities.filter((row) => row.uuid !== foreignBaseline.value.uuid),
  );
  graph.edges.push(
    ...foreignBaseline.graph.edges.filter((row) => row.uuid !== foreignBaseline.edge.uuid),
  );
  graph.episodes.push(...foreignBaseline.graph.episodes);
  graph.automatic_operations_v1!.operations.push(foreignOperation);
  return { graph: GraphDataSchema.parse(graph), foreignOperation };
}

describe('AutonomousPersonalRecordIntegrityV4', () => {
  it('accepts the complete synthetic creator DATA pair', () => {
    expect(() =>
      assertAutonomousPersonalRecordIntegrityV4(graphCopy(), work(), () => undefined),
    ).not.toThrow();
  });

  it('validates references by kind and meaning while retaining their historical evidence hash', () => {
    const graph = graphCopy();
    const operation = committedOccurrenceOperation(graph);
    const receipt = operation.terminalReceipt;
    if (
      receipt.kind !== 'human_autonomous_capture_committed' ||
      receipt.selection.kind !== 'occurrences'
    ) {
      throw new Error('Expected occurrence receipt');
    }
    const creator = receipt.selection.items[0]!;
    const referenceEvidenceHash =
      creator.evidenceHash === 'f'.repeat(64) ? 'e'.repeat(64) : 'f'.repeat(64);
    receipt.selection.items.push({
      ...creator,
      occurrenceIndex: 1,
      effect: 'reference',
      reason: creator.state === 'accepted' ? 'existing_accepted' : 'existing_proposed',
      evidenceHash: referenceEvidenceHash,
    });
    AutonomousPersonalOperationV4OwnedDataSchema.parse(operation);

    expect(() =>
      assertAutonomousPersonalRecordIntegrityV4(graph, work(), () => undefined),
    ).not.toThrow();
  });

  it('rejects a coherent foreign store, namespace, and bound subject reference', () => {
    const { graph, foreignOperation } = foreignReferenceGraph();
    const localOperation = committedOccurrenceOperation(graph);

    expect(foreignOperation.identity.storeHash).not.toBe(localOperation.identity.storeHash);
    expect(foreignOperation.identity.namespace).not.toBe(localOperation.identity.namespace);
    expect(foreignOperation.identity.binding.subjectId).not.toBe(
      localOperation.identity.binding.subjectId,
    );
    expect(GraphDataSchema.safeParse(graph).success).toBe(true);
    expectReason(graph, 'invalid_pair');
  });

  it.each(['storeHash', 'namespace', 'subjectId'] as const)(
    'rejects a reference with only its %s scope join mismatched',
    (mismatchedAxis) => {
      const { graph, foreignOperation } = foreignReferenceGraph(mismatchedAxis);
      const localOperation = committedOccurrenceOperation(graph);
      const operationIdentity = foreignOperation.identity;
      const localIdentity = localOperation.identity;

      expect(operationIdentity.storeHash === localIdentity.storeHash).toBe(
        mismatchedAxis !== 'storeHash',
      );
      expect(operationIdentity.namespace === localIdentity.namespace).toBe(
        mismatchedAxis !== 'namespace',
      );
      expect(operationIdentity.binding.subjectId === localIdentity.binding.subjectId).toBe(
        mismatchedAxis !== 'subjectId',
      );
      expect(GraphDataSchema.safeParse(graph).success).toBe(true);
      expectReason(graph, 'invalid_pair');
    },
  );

  it('detects a committed creator receipt after both pair rows are deleted', () => {
    const graph = graphCopy();
    graph.edges = graph.edges.filter((row) => row.uuid !== baseline.edge.uuid);
    graph.entities = graph.entities.filter((row) => row.uuid !== baseline.value.uuid);

    expectReason(graph, 'orphan_record');
  });

  it('rejects a pair whose creator receipt no longer matches the structural evidence', () => {
    const graph = graphCopy();
    const operation = committedOccurrenceOperation(graph);
    if (
      operation.terminalReceipt.kind !== 'human_autonomous_capture_committed' ||
      operation.terminalReceipt.selection.kind !== 'occurrences'
    )
      throw new Error('Expected occurrence receipt');
    operation.terminalReceipt.selection.items[0]!.evidenceHash = 'f'.repeat(64);

    expectReason(graph, 'invalid_creator');
  });

  it('rejects a second creator for the same claim ID across operations', () => {
    const graph = graphCopy();
    const duplicate = structuredClone(committedOccurrenceOperation(graph));
    duplicate.operationId = 'a0000000-0000-4000-8000-000000000001';
    duplicate.identity.sourceId = 'a0000000-0000-4000-8000-000000000003';
    duplicate.identity.turn = `${duplicate.identity.turn}-second-creator`;
    duplicate.terminalReceipt.operationId = duplicate.operationId;
    duplicate.terminalReceipt.sourceId = duplicate.identity.sourceId;
    duplicate.completionCallHash = 'd'.repeat(64);
    graph.automatic_operations_v1!.operations.push(duplicate);

    expectReason(graph, 'invalid_creator');
  });

  it('rejects an orphan tagged value even when an unrelated valid pair exists', () => {
    const graph = graphCopy();
    const orphan = structuredClone(baseline.value);
    orphan.uuid = 'a0000000-0000-4000-8000-000000000002';
    graph.entities.push(orphan);

    expectReason(graph, 'orphan_record');
  });

  it('fails closed on malformed and future family tags', () => {
    const graph = graphCopy();
    graph.edges.find((row) => row.uuid === baseline.edge.uuid)!.attributes.engram_claim_v1 = {
      version: 7,
      family: 'autonomous-personal-future',
    };

    expectReason(graph, 'invalid_pair');
  });

  it('does not enroll legacy shared-key v2 data or inspect Work when no family4 footprint exists', () => {
    const graph = graphCopy();
    graph.automatic_operations_v1!.operations = [];
    graph.edges.find((row) => row.uuid === baseline.edge.uuid)!.attributes.engram_claim_v1 = {
      version: 2,
      key: 'legacy-claim-data',
    };
    const value = graph.entities.find((row) => row.uuid === baseline.value.uuid)!;
    value.entity_type = 'legacy_personal_value';
    value.attributes.engram_literal_v1 = { version: 2, key: 'legacy-marker-data' };
    let workReads = 0;
    const hostileWork = new Proxy(
      {},
      {
        get() {
          workReads += 1;
          throw new Error('Work must remain untouched on the old-family path');
        },
        ownKeys() {
          workReads += 1;
          throw new Error('Work must remain untouched on the old-family path');
        },
      },
    ) as unknown as AutonomousPersonalTypedSyntaxWorkV1;

    expect(() =>
      assertAutonomousPersonalRecordIntegrityV4(graph, hostileWork, () => undefined),
    ).not.toThrow();
    expect(workReads).toBe(0);
  });

  it('keeps source-only deferred receipts outside pair validation', () => {
    const graph = graphCopy();
    const operation = committedOccurrenceOperation(graph);
    const originalReceipt = operation.terminalReceipt;
    const deferredReceipt = AutonomousPersonalReceiptV4OwnedDataSchema.parse({
      version: 4,
      operationId: operation.operationId,
      sourceId: operation.identity.sourceId,
      sourceHash: operation.identity.sourceHash,
      descriptorHash: operation.identity.descriptorHash,
      policyFingerprint: operation.identity.policyFingerprint,
      terminalAt: originalReceipt.terminalAt,
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
    operation.terminalReceipt = deferredReceipt;
    AutonomousPersonalOperationV4OwnedDataSchema.parse(operation);
    graph.edges = graph.edges.filter((row) => row.uuid !== baseline.edge.uuid);
    graph.entities = graph.entities.filter((row) => row.uuid !== baseline.value.uuid);

    let workReads = 0;
    let checks = 0;
    const hostileWork = new Proxy(
      {},
      {
        get() {
          workReads += 1;
          throw new Error('Deferred source-only DATA must not inspect Work');
        },
        ownKeys() {
          workReads += 1;
          throw new Error('Deferred source-only DATA must not inspect Work');
        },
      },
    ) as unknown as AutonomousPersonalTypedSyntaxWorkV1;

    expect(() =>
      assertAutonomousPersonalRecordIntegrityV4(graph, hostileWork, () => {
        checks += 1;
      }),
    ).not.toThrow();
    expect(checks).toBeGreaterThan(0);
    expect(workReads).toBe(0);
  });

  it('preserves the trusted callback error raised at the final validation check', () => {
    const graph = graphCopy();
    let expectedCalls = 0;
    assertAutonomousPersonalRecordIntegrityV4(graph, work(), () => {
      expectedCalls += 1;
    });

    const failure = new Error('trusted private work failure');
    let actualCalls = 0;
    let caught: unknown;
    try {
      assertAutonomousPersonalRecordIntegrityV4(graph, work(), () => {
        actualCalls += 1;
        if (actualCalls === expectedCalls) throw failure;
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(failure);
    expect(actualCalls).toBe(expectedCalls);
  });

  it('keeps the supplied work signal active through the final trusted callback', () => {
    const graph = graphCopy();
    let expectedCalls = 0;
    assertAutonomousPersonalRecordIntegrityV4(graph, work(), () => {
      expectedCalls += 1;
    });

    const controller = new AbortController();
    let actualCalls = 0;
    let caught: unknown;
    try {
      assertAutonomousPersonalRecordIntegrityV4(graph, work(controller.signal), () => {
        actualCalls += 1;
        if (actualCalls === expectedCalls) controller.abort();
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AutonomousPersonalTypedSyntaxFailureV1);
    expect(caught).toMatchObject({ reason: 'cancelled' });
    expect(actualCalls).toBe(expectedCalls);
  });
});
