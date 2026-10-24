import type { IGraphStorage } from '../storage/IGraphStorage';
import type { EntityEdge, GraphData } from '../schemas';
import { extractionMetadataFromAttributes } from '../schemas';
import { AutomaticClaimMetadataSchema } from '../schemas/AutomaticClaim.schema';
import { validateStoredAutomaticClaim } from '../extraction/AutomaticClaims';
import type { SourceHydrationBudget } from '../schemas/ExtractionPolicy.schema';
import type {
  AutomaticReadBudget,
  AutomaticReadContext,
  AutomaticClaimView,
} from '../schemas/AutomaticRuntime.schema';

/** Also used when writers roll back to Existing/Custom on this binary. */
export async function automaticClaimVisible(
  storage: IGraphStorage,
  edge: EntityEdge,
  budget: SourceHydrationBudget,
  scans: AutomaticReadBudget,
  view?: Pick<AutomaticReadContext, 'mode' | 'at'>,
): Promise<AutomaticClaimView> {
  if (edge.attributes.engram_claim_v1 === undefined) return 'current';
  const parsed = AutomaticClaimMetadataSchema.safeParse(edge.attributes.engram_claim_v1);
  if (!parsed.success || budget.remaining < 3) {
    budget.deferred++;
    return 'hidden';
  }
  const claim = parsed.data;
  budget.remaining -= 3;
  const [subject, value, source] = await Promise.all([
    storage.getEntity(edge.source_node_uuid),
    storage.getEntity(edge.target_node_uuid),
    storage.getEpisode(claim.sourceId),
  ]);
  if (!subject || !value || !source) return 'hidden';
  const graph: GraphData = {
    version: '2.0',
    exported_at: new Date().toISOString(),
    group_id: edge.group_id,
    entities: [subject, value],
    episodes: [source],
    edges: [edge],
  };
  if (view?.mode === 'historical' || view?.mode === 'asOf') {
    if (
      view.mode === 'asOf' &&
      (!view.at ||
        !Number.isFinite(Date.parse(view.at)) ||
        Date.parse(edge.created_at) > Date.parse(view.at))
    )
      return 'hidden';
    return validateStoredAutomaticClaim(graph, edge, undefined, true)
      ? 'historical_record'
      : 'hidden';
  }
  if (
    extractionMetadataFromAttributes(edge.attributes)?.review_status !== 'accepted' ||
    extractionMetadataFromAttributes(value.attributes)?.review_status !== 'accepted'
  )
    return 'hidden';
  if (!validateStoredAutomaticClaim(graph, edge)) return 'hidden';
  if (scans.remaining < 1) {
    budget.deferred++;
    return 'hidden';
  }
  const related = await storage.getEdgesBetween(
    edge.source_node_uuid,
    edge.target_node_uuid,
    scans.remaining + 1,
  );
  if (related.length > scans.remaining) {
    scans.remaining = 0;
    budget.deferred++;
    return 'hidden';
  }
  scans.remaining -= related.length;
  let references = 0;
  for (const other of related) {
    if (
      other.uuid === edge.uuid ||
      extractionMetadataFromAttributes(other.attributes)?.review_status === 'rejected'
    )
      continue;
    const otherClaim = AutomaticClaimMetadataSchema.safeParse(other.attributes.engram_claim_v1);
    if (!otherClaim.success || otherClaim.data.claim.polarity === claim.claim.polarity) continue;
    if (++references > 8 || budget.remaining < 1) {
      budget.deferred++;
      return 'hidden';
    }
    budget.remaining--;
    const otherSource = await storage.getEpisode(otherClaim.data.sourceId);
    if (
      otherSource &&
      validateStoredAutomaticClaim(
        { ...graph, episodes: [source, otherSource], edges: [edge, other] },
        other,
      )
    )
      return 'hidden';
  }
  return 'current';
}
