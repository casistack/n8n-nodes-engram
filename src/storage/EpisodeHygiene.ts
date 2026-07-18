import type { EpisodicNode } from '../schemas';
import type { EpisodeFilterOptions } from './IGraphStorage';

export function isEmptyAssistantOutput(episode: EpisodicNode): boolean {
  if (episode.role !== 'ai') return false;
  const content = episode.content.trim();
  return content === '' || /^\[\s*\]$/.test(content);
}

export function matchesEpisodeHygieneFilters(
  episode: EpisodicNode,
  options: Pick<EpisodeFilterOptions, 'hygiene_rule' | 'content_contains'>,
): boolean {
  if (options.hygiene_rule === 'empty_assistant_output' && !isEmptyAssistantOutput(episode)) {
    return false;
  }

  const contentContains = options.content_contains?.trim().toLocaleLowerCase();
  if (contentContains && !episode.content.toLocaleLowerCase().includes(contentContains)) {
    return false;
  }

  return true;
}
