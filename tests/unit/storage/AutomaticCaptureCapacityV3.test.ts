import { makeCompositionalCaptureFixture } from '../../helpers/compositionalCaptureFixture';
import { CompositionalAutomaticCaptureOperationV3Schema } from '../../../src/schemas/CompositionalAutomaticCaptureV3.schema';

describe('shared V3 capacity accounting', () => {
  it('reserves the full active operation allowance while retaining bounded cancelled tombstones', () => {
    const { graph, operation } = makeCompositionalCaptureFixture();
    const cancelled = CompositionalAutomaticCaptureOperationV3Schema.parse({
      ...operation,
      state: 'cancelled',
      terminalReceipt: {
        version: 3,
        kind: 'cancelled',
        operationId: operation.operationId,
        sourceId: operation.identity.sourceId,
        sourceHash: operation.identity.sourceHash,
        descriptorHash: operation.identity.descriptorHash,
        policyFingerprint: operation.identity.policyFingerprint,
        terminalAt: operation.lastObservedAt,
        acceptedCoverage: 'none',
      },
    });
    // A smaller fixture ceiling exposes the reservation boundary without
    // allocating hundreds of large operation records in a unit test.
    jest.doMock('../../../src/schemas/AutomaticLedgerPrimitives.schema', () => {
      const actual = jest.requireActual('../../../src/schemas/AutomaticLedgerPrimitives.schema');
      return {
        ...actual,
        AUTOMATIC_LEDGER_LIMITS: { ...actual.AUTOMATIC_LEDGER_LIMITS, namespaceBytes: 24000 },
      };
    });
    try {
      jest.isolateModules(() => {
        const { hasAutomaticCaptureCapacity } = jest.requireActual(
          '../../../src/storage/AutomaticCaptureCapacity',
        ) as typeof import('../../../src/storage/AutomaticCaptureCapacity');
        expect(
          hasAutomaticCaptureCapacity(
            { ...graph, automatic_operations_v1: { version: 1, operations: [operation] } },
            () => {},
          ),
        ).toBe(false);
        expect(
          hasAutomaticCaptureCapacity(
            { ...graph, automatic_operations_v1: { version: 1, operations: [cancelled] } },
            () => {},
          ),
        ).toBe(true);
      });
    } finally {
      jest.dontMock('../../../src/schemas/AutomaticLedgerPrimitives.schema');
    }
  });
});
