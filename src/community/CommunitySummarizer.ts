import type { LlmClient } from '../extraction/LlmClient';
import type { Community, CommunityDetectionResult } from '../schemas/Community.schema';

const COMMUNITY_SUMMARY_SYSTEM = `You are analyzing a knowledge graph community (a cluster of related entities).
Summarize the following cluster of entities and their relationships in 2-3 concise sentences.
Focus on the key theme or connection that binds these entities together.
Return only the summary text, no JSON or formatting.`;

function buildCommunityPrompt(community: Community): string {
	const entityLines = community.members.map(
		(m) => `- ${m.entity.name} (${m.entity.entity_type}): ${m.entity.summary || 'No summary'}`,
	);

	const factSet = new Set<string>();
	for (const m of community.members) {
		for (const e of m.edges) {
			factSet.add(`- ${e.fact}`);
		}
	}

	const parts = ['Entities:', ...entityLines];
	if (factSet.size > 0) {
		parts.push('', 'Relationships:', ...factSet);
	}

	return parts.join('\n');
}

/**
 * Generates LLM summaries for detected communities.
 * Optional — communities work without summaries.
 */
export class CommunitySummarizer {
	private llm: LlmClient;

	constructor(llm: LlmClient) {
		this.llm = llm;
	}

	async summarize(community: Community): Promise<string> {
		const response = await this.llm.chat([
			{ role: 'system', content: COMMUNITY_SUMMARY_SYSTEM },
			{ role: 'user', content: buildCommunityPrompt(community) },
		]);
		return response.content.trim();
	}

	async summarizeAll(
		result: CommunityDetectionResult,
		concurrency: number = 3,
	): Promise<CommunityDetectionResult> {
		const communities = [...result.communities];

		// Process in batches for concurrency control
		for (let i = 0; i < communities.length; i += concurrency) {
			const batch = communities.slice(i, i + concurrency);
			const summaries = await Promise.allSettled(
				batch.map((c) => this.summarize(c)),
			);

			for (let j = 0; j < batch.length; j++) {
				const outcome = summaries[j];
				if (outcome.status === 'fulfilled') {
					batch[j] = { ...batch[j], summary: outcome.value };
				} else {
					console.warn(
						`Engram: Failed to summarize community "${batch[j].label}":`,
						outcome.reason?.message ?? 'Unknown error',
					);
				}
			}

			// Write back to array
			for (let j = 0; j < batch.length; j++) {
				communities[i + j] = batch[j];
			}
		}

		return { ...result, communities };
	}
}
