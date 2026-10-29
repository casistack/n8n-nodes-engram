import type { GraphData } from '../schemas/GraphData.schema';

/** V3-only invariant over an already owned, validated graph; references are not new records. */
export function assertCompositionalRecordIdentityV3(
  graph: GraphData,
  check: () => void = () => {},
): void {
  const ids = new Set<string>();
  const reserve = (id: string) => {
    check();
    if (ids.has(id)) throw new Error('Engram compositional capture: duplicate_record_id');
    ids.add(id);
  };
  for (const rows of [graph.entities, graph.edges, graph.episodes])
    for (const row of rows) reserve(row.uuid);
  for (const operation of graph.automatic_operations_v1?.operations ?? [])
    reserve(operation.operationId);
  check();
}
