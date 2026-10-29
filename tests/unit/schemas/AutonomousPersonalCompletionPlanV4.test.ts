import { AutonomousPersonalCompletionPlanV4OwnedDataSchema } from '../../../src/schemas/AutonomousPersonalCompletionPlanV4.schema';
import { planAutonomousPersonalCaptureCompletionV4 } from '../../../src/storage/AutonomousPersonalCompletionPlanV4';
import {
  autonomousPersonalCompletionPlanFixtureV4,
  autonomousPersonalCompletionPlanNextStageV4,
} from '../../helpers/autonomousPersonalCompletionPlanV4';
import {
  getAutomaticClaimReadScope,
  reserveAutomaticClaimSnapshotBytes,
} from '../../../src/storage/AutomaticClaimReadScope';
import type { AutonomousPersonalCompletionPlanV4 } from '../../../src/schemas/AutonomousPersonalCompletionPlanV4.schema';

let baseline: Extract<AutonomousPersonalCompletionPlanV4, { kind: 'planned' }>;
let references: typeof baseline;
let repeatedBaseline: typeof baseline;
beforeAll(async () => {
  const fixture = await autonomousPersonalCompletionPlanFixtureV4();
  try {
    const value = planAutonomousPersonalCaptureCompletionV4(
      fixture.input,
      fixture.graph,
      fixture.response,
      fixture.selection,
      fixture.work,
      fixture.check,
      fixture.budget,
    );
    if (value.kind !== 'planned') throw new Error('Expected synthetic complete DATA plan');
    baseline = value;
    const next = await autonomousPersonalCompletionPlanNextStageV4(fixture.store, fixture.seed, {
      content: 'I prefer concise explanations. I prefer concise explanations.',
      turn: 'synthetic:reference-schema',
      executionId: 'synthetic:reference-schema-execution',
    });
    try {
      const originalBytes = Buffer.byteLength(JSON.stringify(next.graph), 'utf8');
      next.graph.automatic_operations_v1!.operations =
        next.graph.automatic_operations_v1!.operations.map((operation) =>
          operation.operationId === value.operation.operationId
            ? structuredClone(value.operation)
            : operation,
        );
      next.graph.entities.push(...structuredClone(value.createEntities));
      next.graph.edges.push(...structuredClone(value.createEdges));
      const added = Buffer.byteLength(JSON.stringify(next.graph), 'utf8') - originalBytes;
      if (
        added > 0 &&
        !reserveAutomaticClaimSnapshotBytes(getAutomaticClaimReadScope(next.budget), added)
      )
        throw new Error('Unable to reserve synthetic reference fixture bytes');
      const result = planAutonomousPersonalCaptureCompletionV4(
        next.input,
        next.graph,
        next.response,
        next.selection,
        next.work,
        next.check,
        next.budget,
      );
      if (result.kind !== 'planned') throw new Error('Expected synthetic complete reference DATA');
      references = result;
    } finally {
      next.close();
    }
  } finally {
    await fixture.close();
  }
});
beforeAll(async () => {
  const fixture = await autonomousPersonalCompletionPlanFixtureV4({
    content: 'I prefer concise explanations. I prefer concise explanations.',
  });
  try {
    const value = planAutonomousPersonalCaptureCompletionV4(
      fixture.input,
      fixture.graph,
      fixture.response,
      fixture.selection,
      fixture.work,
      fixture.check,
      fixture.budget,
    );
    if (value.kind !== 'planned')
      throw new Error('Expected a complete synthetic duplicate DATA plan');
    repeatedBaseline = value;
  } finally {
    await fixture.close();
  }
});
function copy() {
  return structuredClone(baseline);
}
function valid(value: unknown) {
  return AutonomousPersonalCompletionPlanV4OwnedDataSchema.safeParse(value).success;
}
it('accepts the strict complete generated DATA without granting processing permission', () => {
  expect(valid(baseline)).toBe(true);
  expect(valid({ ...baseline, eligibleFirstCommit: true })).toBe(false);
  expect(valid({ ...baseline, proof: {} })).toBe(false);
});
it('rejects a missing value and mismatched edge endpoint', () => {
  const missing = copy();
  missing.createEntities = [];
  expect(valid(missing)).toBe(false);
  const endpoint = copy();
  endpoint.createEdges[0]!.target_node_uuid = '90000000-0000-4000-8000-000000000003';
  expect(valid(endpoint)).toBe(false);
});
it('rejects a non-deterministic claim UUID even when the receipt is changed consistently', () => {
  const value = copy();
  const original = value.createEdges[0]!.uuid;
  const replacement = '90000000-0000-4000-8000-000000000003';
  value.createEdges[0]!.uuid = replacement;
  const receipt = value.operation.terminalReceipt;
  if (receipt.kind !== 'human_autonomous_capture_committed')
    throw new Error('Expected occurrence receipt');
  receipt.selection.items.forEach((item) => {
    if (item.claimId === original) item.claimId = replacement;
  });
  expect(valid(value)).toBe(false);
});
it('rejects model-confidence metadata substituted into both initial policy rows', () => {
  const value = copy();
  for (const row of [value.createEdges[0]!, value.createEntities[0]!]) {
    (row.attributes.engram_extraction as Record<string, unknown>).confidence = 0.99;
  }
  expect(valid(value)).toBe(false);
});
it('rejects an unsolicited generated value summary', () => {
  const value = copy();
  value.createEntities[0]!.summary = 'Unsupported inferred summary';
  expect(valid(value)).toBe(false);
});
it('rejects a receipt dependency hash that no longer describes the created claim', () => {
  const value = copy();
  const receipt = value.operation.terminalReceipt;
  if (receipt.kind !== 'human_autonomous_capture_committed')
    throw new Error('Expected occurrence receipt');
  receipt.selection.items[0]!.dependencies[0]!.dependencyHash = 'f'.repeat(64);
  expect(valid(value)).toBe(false);
});

it('requires every created receipt item to have a complete pair', () => {
  const value = copy();
  value.createEntities = [];
  value.createEdges = [];
  expect(valid(value)).toBe(false);
});
it('requires one guard to cover the complete repeated reference index set', () => {
  expect(valid(references)).toBe(true);
  expect(references.referenceGuards).toHaveLength(1);
  expect(references.referenceGuards[0]!.occurrenceIndexes).toEqual([0, 1]);
  const value = structuredClone(references);
  value.referenceGuards[0]!.occurrenceIndexes = [0];
  expect(valid(value)).toBe(false);
});
it('requires reference receipt state and reason to match the actual guarded review state', () => {
  const value = structuredClone(references);
  value.referenceGuards[0]!.reviewState = 'proposed';
  expect(valid(value)).toBe(false);
});
it('never treats a pair created in this plan as a pre-existing reference guard', () => {
  const value = structuredClone(repeatedBaseline);
  expect(valid(value)).toBe(true);
  const receipt = value.operation.terminalReceipt;
  if (receipt.kind !== 'human_autonomous_capture_committed')
    throw new Error('Expected occurrence DATA');
  const first = receipt.selection.items[0]!;
  const claim = value.createEdges[0]!.attributes.engram_claim_v1 as { key: string };
  value.referenceGuards.push({
    claimId: value.createEdges[0]!.uuid,
    valueId: value.createEntities[0]!.uuid,
    sourceId: '90000000-0000-4000-8000-000000000004',
    operationId: '90000000-0000-4000-8000-000000000005',
    key: claim.key,
    meaningHash: first.meaningHash,
    reviewState: 'accepted',
    occurrenceIndexes: [1],
    claimRowHash: 'e'.repeat(64),
    valueRowHash: 'e'.repeat(64),
    sourceRowHash: 'e'.repeat(64),
    operationRowHash: 'e'.repeat(64),
  });
  expect(valid(value)).toBe(false);
});
it('inherits uniform same-plan duplicate state, meaning and dependencies from the nested Receipt4 schema', () => {
  const repeated = structuredClone(repeatedBaseline);
  expect(valid(repeated)).toBe(true);
  for (const corruption of ['state', 'meaning', 'dependencies'] as const) {
    const value = structuredClone(repeated);
    const changed = value.operation.terminalReceipt;
    if (changed.kind !== 'human_autonomous_capture_committed')
      throw new Error('Expected occurrence DATA');
    const reference = changed.selection.items[1]!;
    if (corruption === 'state') {
      reference.state = 'rejected';
      reference.reason = 'existing_rejected';
      changed.acceptedCoverage = 'partial';
    }
    if (corruption === 'meaning') reference.meaningHash = 'f'.repeat(64);
    if (corruption === 'dependencies') reference.dependencies[0]!.dependencyHash = 'f'.repeat(64);
    expect(valid(value)).toBe(false);
  }
});
