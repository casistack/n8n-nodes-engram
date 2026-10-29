import { randomUUID } from 'crypto';
import { makeCompositionalCaptureFixture } from '../../helpers/compositionalCaptureFixture';
import { makeHumanFixture } from '../../helpers/automaticCommittedFixture';
import {
  AutomaticLedgerSchema,
  StoredAutomaticOperationSchema,
} from '../../../src/schemas/AutomaticLedger.schema';
import { GraphDataSchema, ImportGraphDataSchema } from '../../../src/schemas/GraphData.schema';

describe('additive exact V3 operation parsing', () => {
  it('preserves persisted V3 key order without converting it to a literal operation', () => {
    const { operation } = makeCompositionalCaptureFixture();
    const parsed = StoredAutomaticOperationSchema.parse(operation);
    expect(parsed).toBe(operation);
    expect(JSON.stringify(parsed)).toBe(JSON.stringify(operation));
    expect(parsed.version).toBe(3);
  });

  it('retains complete mixed V2 and V3 root records without a version migration', () => {
    const literal = makeHumanFixture('mixed-v2-v3-literal');
    const rich = makeCompositionalCaptureFixture();
    const graph = {
      version: '2.0' as const,
      exported_at: rich.graph.exported_at,
      entities: [...literal.graph.entities, ...rich.graph.entities],
      episodes: [...literal.graph.episodes, ...rich.graph.episodes],
      edges: literal.graph.edges,
      automatic_operations_v1: {
        version: 1 as const,
        operations: [...literal.graph.automatic_operations_v1!.operations, rich.operation],
      },
    };
    expect(GraphDataSchema.parse(graph)).toEqual(graph);
    expect(graph.automatic_operations_v1.operations.map((op) => op.version)).toEqual([2, 3]);
  });

  it('enforces shared operation/source/event uniqueness across the new family', () => {
    const { operation } = makeCompositionalCaptureFixture();
    const duplicate = { ...operation, operationId: randomUUID() };
    const parsed = AutomaticLedgerSchema.safeParse({
      version: 1,
      operations: [operation, duplicate],
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error('Expected duplicate event rejection');
    expect(
      parsed.error.issues.some((issue) => issue.message.includes('locators must be unique')),
    ).toBe(true);
  });

  it('does not admit unknown families or a privileged root under the legacy graph version', () => {
    const { graph, operation } = makeCompositionalCaptureFixture();
    expect(StoredAutomaticOperationSchema.safeParse({ ...operation, version: 4 }).success).toBe(
      false,
    );
    expect(
      ImportGraphDataSchema.safeParse({
        ...graph,
        version: '1.0',
        automatic_operations_v1: { version: 1, operations: [operation] },
      }).success,
    ).toBe(false);
  });
});
