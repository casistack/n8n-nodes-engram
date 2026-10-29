import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import {
  createAutonomousPersonalClaimIndexV4,
  getAutonomousPersonalClaimIndexCandidateRowsV4,
  getAutonomousPersonalClaimIndexGraphV4,
} from '../../../src/extraction/AutonomousPersonalQualifiedClaimV4';
import { AutonomousPersonalTypedSyntaxFailureV1 } from '../../../src/extraction/AutonomousPersonalTypedSyntaxV1';
import type { AutonomousPersonalTypedSyntaxWorkV1 } from '../../../src/schemas/AutonomousPersonalTypedSyntaxV1.schema';
import { AutonomousPersonalClaimIndexCandidateRowsV4OwnedDataSchema } from '../../../src/schemas/AutonomousPersonalClaimIndexCandidateRowsV4.schema';
import type { GraphData } from '../../../src/schemas/GraphData.schema';
import { autonomousPersonalQualifiedClaimFixtureV4 } from '../../helpers/autonomousPersonalQualifiedClaimV4';

jest.setTimeout(30_000);

function workContext(): AutonomousPersonalTypedSyntaxWorkV1 {
  return {
    absoluteMonotonicDeadlineMs: performance.now() + 30_000,
    signal: new AbortController().signal,
  };
}

function catchValue(callback: () => unknown): unknown {
  try {
    callback();
  } catch (error) {
    return error;
  }
  throw new Error('Expected callback to throw');
}

function appendFixture(target: GraphData, source: GraphData): void {
  target.entities.push(...source.entities);
  target.edges.push(...source.edges);
  target.episodes.push(...source.episodes);
  if (!target.automatic_operations_v1 || !source.automatic_operations_v1)
    throw new Error('Expected fixture operation ledgers');
  target.automatic_operations_v1.operations.push(...source.automatic_operations_v1.operations);
}

describe('AutonomousPersonalClaimIndexCandidateRowsV4 DATA lookup', () => {
  test('returns same frozen row references from one existing index', async () => {
    const fixture = await autonomousPersonalQualifiedClaimFixtureV4();
    let checks = 0;
    const index = createAutonomousPersonalClaimIndexV4(fixture.graph, workContext(), () => {
      checks += 1;
    });
    const graph = getAutonomousPersonalClaimIndexGraphV4(index);
    const checksBeforeLookup = checks;

    const rows = getAutonomousPersonalClaimIndexCandidateRowsV4(index, fixture.edge.uuid);

    expect(rows).not.toBeNull();
    if (rows === null) throw new Error('Expected candidate DATA rows');
    expect(checks).toBeGreaterThan(checksBeforeLookup);
    expect(rows).toEqual({
      edge: graph.edges.find((row) => row.uuid === fixture.edge.uuid),
      subject: graph.entities.find((row) => row.uuid === fixture.edge.source_node_uuid),
      value: graph.entities.find((row) => row.uuid === fixture.edge.target_node_uuid),
      source: graph.episodes.find((row) => row.uuid === fixture.source.uuid),
      operation: graph.automatic_operations_v1?.operations.find(
        (row) => row.version === 4 && row.identity.sourceId === fixture.source.uuid,
      ),
    });
    expect(rows.edge).toBe(graph.edges.find((row) => row.uuid === fixture.edge.uuid));
    expect(rows.subject).toBe(
      graph.entities.find((row) => row.uuid === fixture.edge.source_node_uuid),
    );
    expect(rows.value).toBe(
      graph.entities.find((row) => row.uuid === fixture.edge.target_node_uuid),
    );
    expect(rows.source).toBe(graph.episodes.find((row) => row.uuid === fixture.source.uuid));
    expect(rows.operation).toBe(
      graph.automatic_operations_v1?.operations.find(
        (row) => row.version === 4 && row.identity.sourceId === fixture.source.uuid,
      ),
    );
    expect(Object.isFrozen(rows)).toBe(true);
    expect(AutonomousPersonalClaimIndexCandidateRowsV4OwnedDataSchema.safeParse(rows).success).toBe(
      true,
    );
    expect(rows).not.toHaveProperty('status');
    expect(rows).not.toHaveProperty('proof');
    expect(rows).not.toHaveProperty('qualified');
  });

  test('does not observe later caller graph changes or caller work-object replacement', async () => {
    const fixture = await autonomousPersonalQualifiedClaimFixtureV4();
    const originalSignalController = new AbortController();
    const replacementSignalController = new AbortController();
    replacementSignalController.abort();
    const work = {
      absoluteMonotonicDeadlineMs: performance.now() + 30_000,
      signal: originalSignalController.signal,
    };
    const index = createAutonomousPersonalClaimIndexV4(fixture.graph, work, () => undefined);
    const graph = getAutonomousPersonalClaimIndexGraphV4(index);
    const ownedEdge = graph.edges.find((row) => row.uuid === fixture.edge.uuid)!;
    const originalFact = ownedEdge.fact;
    const originalClaimSource = (ownedEdge.attributes.engram_claim_v1 as { sourceId: string })
      .sourceId;

    fixture.edge.fact = 'caller-side mutation';
    (fixture.edge.attributes.engram_claim_v1 as { sourceId: string }).sourceId = randomUUID();
    work.absoluteMonotonicDeadlineMs = performance.now() - 1;
    work.signal = replacementSignalController.signal;

    const rows = getAutonomousPersonalClaimIndexCandidateRowsV4(index, fixture.edge.uuid);
    expect(rows?.edge).toBe(ownedEdge);
    expect(rows?.edge.fact).toBe(originalFact);
    expect(
      (rows?.edge.attributes.engram_claim_v1 as { sourceId: string } | undefined)?.sourceId,
    ).toBe(originalClaimSource);

    originalSignalController.abort();
    const cancellation = catchValue(() =>
      getAutonomousPersonalClaimIndexCandidateRowsV4(index, fixture.edge.uuid),
    ) as AutonomousPersonalTypedSyntaxFailureV1;
    expect(cancellation).toBeInstanceOf(AutonomousPersonalTypedSyntaxFailureV1);
    expect(cancellation.reason).toBe('cancelled');
    expect(
      catchValue(() => getAutonomousPersonalClaimIndexCandidateRowsV4(index, fixture.edge.uuid)),
    ).toBe(cancellation);
  });

  test('returns null for missing, non-Claim3, malformed Claim3, or incomplete join rows', async () => {
    const fixture = await autonomousPersonalQualifiedClaimFixtureV4();
    const ordinaryEdgeId = randomUUID();
    fixture.graph.edges.push({
      ...fixture.edge,
      uuid: ordinaryEdgeId,
      name: 'RELATED_TO',
      attributes: {},
    });
    fixture.edge.attributes.engram_claim_v1 = {
      ...(fixture.edge.attributes.engram_claim_v1 as Record<string, unknown>),
      unknownClaimField: true,
    };
    const index = createAutonomousPersonalClaimIndexV4(
      fixture.graph,
      workContext(),
      () => undefined,
    );

    expect(getAutonomousPersonalClaimIndexCandidateRowsV4(index, randomUUID())).toBeNull();
    expect(getAutonomousPersonalClaimIndexCandidateRowsV4(index, ordinaryEdgeId)).toBeNull();
    expect(getAutonomousPersonalClaimIndexCandidateRowsV4(index, fixture.edge.uuid)).toBeNull();
  });

  test('returns null when source, value, subject, or version-4 operation is absent', async () => {
    const sourceMissing = await autonomousPersonalQualifiedClaimFixtureV4();
    sourceMissing.graph.episodes = sourceMissing.graph.episodes.filter(
      (row) => row.uuid !== sourceMissing.source.uuid,
    );
    const sourceMissingIndex = createAutonomousPersonalClaimIndexV4(
      sourceMissing.graph,
      workContext(),
      () => undefined,
    );
    expect(
      getAutonomousPersonalClaimIndexCandidateRowsV4(sourceMissingIndex, sourceMissing.edge.uuid),
    ).toBeNull();

    const valueMissing = await autonomousPersonalQualifiedClaimFixtureV4();
    valueMissing.graph.entities = valueMissing.graph.entities.filter(
      (row) => row.uuid !== valueMissing.value.uuid,
    );
    const valueMissingIndex = createAutonomousPersonalClaimIndexV4(
      valueMissing.graph,
      workContext(),
      () => undefined,
    );
    expect(
      getAutonomousPersonalClaimIndexCandidateRowsV4(valueMissingIndex, valueMissing.edge.uuid),
    ).toBeNull();

    const subjectMissing = await autonomousPersonalQualifiedClaimFixtureV4();
    subjectMissing.graph.entities = subjectMissing.graph.entities.filter(
      (row) => row.uuid !== subjectMissing.edge.source_node_uuid,
    );
    const subjectMissingIndex = createAutonomousPersonalClaimIndexV4(
      subjectMissing.graph,
      workContext(),
      () => undefined,
    );
    expect(
      getAutonomousPersonalClaimIndexCandidateRowsV4(subjectMissingIndex, subjectMissing.edge.uuid),
    ).toBeNull();

    const operationMissing = await autonomousPersonalQualifiedClaimFixtureV4();
    operationMissing.graph.automatic_operations_v1!.operations = [];
    const operationMissingIndex = createAutonomousPersonalClaimIndexV4(
      operationMissing.graph,
      workContext(),
      () => undefined,
    );
    expect(
      getAutonomousPersonalClaimIndexCandidateRowsV4(
        operationMissingIndex,
        operationMissing.edge.uuid,
      ),
    ).toBeNull();
  });

  test('returns foreign-namespace rows as DATA without treating lookup as authorization', async () => {
    const first = await autonomousPersonalQualifiedClaimFixtureV4();
    const second = await autonomousPersonalQualifiedClaimFixtureV4();
    appendFixture(first.graph, second.graph);
    const index = createAutonomousPersonalClaimIndexV4(first.graph, workContext(), () => undefined);

    const rows = getAutonomousPersonalClaimIndexCandidateRowsV4(index, second.edge.uuid);

    expect(rows?.edge.uuid).toBe(second.edge.uuid);
    expect(rows?.source.uuid).toBe(second.source.uuid);
    expect(rows?.source.group_id).toBe(second.source.group_id);
    expect(rows?.source.group_id).not.toBe(first.source.group_id);
    expect(rows).not.toHaveProperty('authorized');
  });

  test('keeps invalid-token and malformed-edge errors fixed and rethrows trusted check identity', async () => {
    const fixture = await autonomousPersonalQualifiedClaimFixtureV4();
    const index = createAutonomousPersonalClaimIndexV4(
      fixture.graph,
      workContext(),
      () => undefined,
    );
    const invalidIndexFailure = catchValue(() =>
      getAutonomousPersonalClaimIndexCandidateRowsV4({}, fixture.edge.uuid),
    ) as Error;
    expect(invalidIndexFailure).toMatchObject({
      name: 'AutonomousPersonalClaimV4Error',
      message: 'invalid_autonomous_claim_request_data',
    });
    const invalidIdFailure = catchValue(() =>
      getAutonomousPersonalClaimIndexCandidateRowsV4(index, { edgeId: fixture.edge.uuid }),
    ) as Error;
    expect(invalidIdFailure).toMatchObject({
      name: 'AutonomousPersonalQualifiedClaimV4Error',
      message: 'invalid_autonomous_claim_request_data',
    });

    const sentinel = new Error('trusted callback identity');
    let shouldFail = false;
    const checkedIndex = createAutonomousPersonalClaimIndexV4(fixture.graph, workContext(), () => {
      if (shouldFail) throw sentinel;
    });
    shouldFail = true;
    expect(
      catchValue(() =>
        getAutonomousPersonalClaimIndexCandidateRowsV4(checkedIndex, fixture.edge.uuid),
      ),
    ).toBe(sentinel);
    expect(
      catchValue(() =>
        getAutonomousPersonalClaimIndexCandidateRowsV4(checkedIndex, fixture.edge.uuid),
      ),
    ).toBe(sentinel);
  });
});
