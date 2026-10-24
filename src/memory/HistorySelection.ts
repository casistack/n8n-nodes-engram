import { createHash } from 'crypto';
import type { EpisodicNode, HistoryReadDiagnostics, MemoryPolicy } from '../schemas';

export function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Context is evidence, not authority: an exact operator-reviewed hash is also required. */
function isLegacyCandidate(episode: EpisodicNode, older?: EpisodicNode): boolean {
  if (!older || episode.group_id !== older.group_id || episode.previous_episode_uuid !== older.uuid)
    return false;
  if (
    episode.episode_kind !== 'legacy' ||
    older.episode_kind !== 'legacy' ||
    episode.role !== 'human' ||
    older.role !== 'ai'
  )
    return false;
  if (
    episode.source_type !== 'message' ||
    older.source_type !== 'message' ||
    older.content.trim() !== '[]'
  )
    return false;
  if (
    [episode, older].some(
      (ep) => ep.source_message_id || ep.sender_id || ep.sender_name || ep.quoted_message_id,
    )
  )
    return false;
  if (
    episode.source_execution_id !== older.source_execution_id ||
    episode.source_workflow_id !== older.source_workflow_id
  )
    return false;
  try {
    const value: unknown = JSON.parse(episode.content);
    return (
      Array.isArray(value) &&
      value.length > 0 &&
      value.every(
        (item) =>
          item &&
          typeof item === 'object' &&
          !Array.isArray(item) &&
          Object.keys(item).length > 0 &&
          Object.keys(item).every((key) => key === 'response' || key === 'error'),
      )
    );
  } catch {
    return false;
  }
}

/** A bounded, detached snapshot; pages here are local scan pages, not backend keyset pages. */
export function selectHistory(
  snapshot: EpisodicNode[],
  window: number,
  policy: MemoryPolicy,
): { episodes: EpisodicNode[]; diagnostics: HistoryReadDiagnostics } {
  const overflow = snapshot.length > policy.maxHistoryScan;
  const first = Math.max(0, snapshot.length - policy.maxHistoryScan);
  const excluded = new Set<string>();
  const selected: EpisodicNode[] = [];
  const d: HistoryReadDiagnostics = {
    mode: policy.historyFilter,
    fetched: snapshot.length,
    examined: 0,
    pages: 0,
    returned: 0,
    excluded_provenance: 0,
    excluded_legacy: 0,
    legacy_candidates: 0,
    snapshot_overflow: overflow,
    scan_truncated: false,
  };
  const hashes = new Set(policy.legacyArtifactHashes);
  for (let i = snapshot.length - 1; i >= first && selected.length < window; i--) {
    const ep = snapshot[i];
    d.examined++;
    d.pages = Math.ceil(d.examined / 100);
    const audit = ep.attributes.engram_audit === true;
    if (
      (policy.finalTurnWrites && (audit || ep.episode_kind === 'tool_output')) ||
      (policy.historyFilter !== 'off' &&
        (ep.episode_kind === 'tool_output' || ep.episode_kind === 'monitor_summary' || audit))
    ) {
      d.excluded_provenance++;
      continue;
    }
    if (policy.historyFilter === 'reviewedLegacy' && isLegacyCandidate(ep, snapshot[i - 1])) {
      d.legacy_candidates++;
      if (hashes.has(contentHash(ep.content))) {
        excluded.add(ep.uuid);
        excluded.add(snapshot[i - 1].uuid);
      }
    }
    if (excluded.has(ep.uuid)) {
      d.excluded_legacy++;
      continue;
    }
    selected.push(ep);
  }
  d.returned = selected.length;
  d.scan_truncated = selected.length < window && overflow;
  return { episodes: selected.reverse(), diagnostics: d };
}
