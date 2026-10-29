import { type GraphData } from '../schemas/GraphData.schema';
import { parseLosslessAutomaticCaptureGraph } from './LosslessAutomaticCaptureGraph';
import { AUTOMATIC_LEDGER_LIMITS as limits } from '../schemas/AutomaticLedgerPrimitives.schema';
import { assertAutomaticLedgerSourceIntegrity } from './AutomaticIdentity';
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');
const markerBytes = Buffer.byteLength(',"auditTruncated":true');
const active = (state: string) => ['captured', 'leased', 'failed', 'interrupted'].includes(state);

/** Reserve future operation growth without changing legacy V1 accounting or records. */
export function hasAutomaticCaptureCapacity(graph: GraphData, check: () => void): boolean {
  const ledger = graph.automatic_operations_v1;
  let totalReserve = 0;
  const namespaceReserve = new Map<string, number>();
  const namespaceOperations = new Map<string, unknown[]>();
  for (const operation of ledger?.operations ?? []) {
    check();
    const reserve =
      operation.version === 2 || operation.version === 3 || operation.version === 4
        ? active(operation.state)
          ? Math.max(0, limits.operationBytes - bytes(operation))
          : 9 + (operation.auditTruncated === undefined ? markerBytes : 0)
        : 9 + (active(operation.state) ? limits.terminalReceiptBytes : 0);
    totalReserve += reserve;
    const namespace = operation.identity.namespace;
    namespaceReserve.set(namespace, (namespaceReserve.get(namespace) ?? 0) + reserve);
    const records = namespaceOperations.get(namespace) ?? [];
    records.push(operation);
    namespaceOperations.set(namespace, records);
  }
  if (ledger && bytes(ledger) + totalReserve > limits.storeBytes) return false;
  for (const [namespace, records] of namespaceOperations) {
    check();
    if (
      records.length > limits.operationsPerNamespace ||
      bytes({ version: 1, operations: records }) + namespaceReserve.get(namespace)! >
        limits.namespaceBytes
    )
      return false;
  }
  check();
  return (
    graph.entities.length + graph.edges.length + graph.episodes.length <= 100_000 &&
    bytes(graph) + totalReserve <= limits.storeBytes
  );
}

export function validateAutomaticCaptureCandidate(
  value: GraphData,
  check: () => void,
): GraphData | null {
  check();
  let graph: GraphData;
  try {
    graph = parseLosslessAutomaticCaptureGraph(value);
    assertAutomaticLedgerSourceIntegrity(graph);
  } catch {
    return null;
  }
  check();
  return hasAutomaticCaptureCapacity(graph, check) ? graph : null;
}
