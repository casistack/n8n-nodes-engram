import { CommunitySummarizer } from '../../../src/community/CommunitySummarizer';
import type { Community, CommunityDetectionResult } from '../../../src/schemas/Community.schema';

// Mock global fetch for LlmClient
const mockFetch = jest.fn();
global.fetch = mockFetch;

function mockLlmResponse(content: string) {
	return {
		ok: true,
		json: async () => ({
			choices: [{ message: { content } }],
			usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
		}),
	};
}

function makeCommunity(overrides: Partial<Community> = {}): Community {
	return {
		id: 'test-id',
		label: 'Alice, Bob',
		members: [
			{
				entity: {
					uuid: 'e1', name: 'Alice', group_id: 'g1', summary: 'A developer',
					entity_type: 'person', name_embedding: null, attributes: {},
					created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
				},
				edges: [{
					uuid: 'edge1', group_id: 'g1', source_node_uuid: 'e1', target_node_uuid: 'e2',
					name: 'KNOWS', fact: 'Alice knows Bob', fact_embedding: null,
					episodes: [], valid_at: null, invalid_at: null, expired_at: null,
					attributes: {}, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
				}],
			},
			{
				entity: {
					uuid: 'e2', name: 'Bob', group_id: 'g1', summary: 'A manager',
					entity_type: 'person', name_embedding: null, attributes: {},
					created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
				},
				edges: [],
			},
		],
		summary: null,
		entity_count: 2,
		edge_count: 1,
		key_entities: ['Alice', 'Bob'],
		...overrides,
	};
}

describe('CommunitySummarizer', () => {
	// Import LlmClient after mock is set
	let LlmClient: typeof import('../../../src/extraction/LlmClient').LlmClient;
	let summarizer: CommunitySummarizer;

	beforeEach(async () => {
		mockFetch.mockReset();
		const mod = await import('../../../src/extraction/LlmClient');
		LlmClient = mod.LlmClient;
		const llm = new LlmClient({
			apiKey: 'test-key',
			baseUrl: 'https://llm.example.com/v1',
			model: 'gpt-4',
		});
		summarizer = new CommunitySummarizer(llm);
	});

	it('should generate a summary for a community', async () => {
		mockFetch.mockResolvedValueOnce(
			mockLlmResponse('Alice and Bob are colleagues who work together.'),
		);

		const community = makeCommunity();
		const summary = await summarizer.summarize(community);

		expect(summary).toBe('Alice and Bob are colleagues who work together.');
		expect(mockFetch).toHaveBeenCalledTimes(1);
	});

	it('should include entity names and facts in the prompt', async () => {
		mockFetch.mockResolvedValueOnce(mockLlmResponse('Summary text'));

		await summarizer.summarize(makeCommunity());

		const body = JSON.parse(mockFetch.mock.calls[0][1].body);
		const userMessage = body.messages.find((m: { role: string }) => m.role === 'user');
		expect(userMessage.content).toContain('Alice');
		expect(userMessage.content).toContain('Bob');
		expect(userMessage.content).toContain('Alice knows Bob');
	});

	it('should summarize all communities in a result', async () => {
		mockFetch
			.mockResolvedValueOnce(mockLlmResponse('Summary for community 1'))
			.mockResolvedValueOnce(mockLlmResponse('Summary for community 2'));

		const result: CommunityDetectionResult = {
			communities: [
				makeCommunity({ id: 'c1', label: 'C1' }),
				makeCommunity({ id: 'c2', label: 'C2' }),
			],
			total_entities: 4,
			unclustered_entities: 0,
			detection_method: 'label_propagation',
		};

		const summarized = await summarizer.summarizeAll(result);

		expect(summarized.communities[0].summary).toBe('Summary for community 1');
		expect(summarized.communities[1].summary).toBe('Summary for community 2');
	});

	it('should handle LLM failure gracefully for individual communities', async () => {
		mockFetch
			.mockResolvedValueOnce(mockLlmResponse('Good summary'))
			.mockRejectedValueOnce(new Error('API error'));

		const warnSpy = jest.spyOn(console, 'warn').mockImplementation();

		const result: CommunityDetectionResult = {
			communities: [
				makeCommunity({ id: 'c1', label: 'Good' }),
				makeCommunity({ id: 'c2', label: 'Bad' }),
			],
			total_entities: 4,
			unclustered_entities: 0,
			detection_method: 'label_propagation',
		};

		const summarized = await summarizer.summarizeAll(result);

		// First community should have summary
		expect(summarized.communities[0].summary).toBe('Good summary');
		// Second community keeps null summary
		expect(summarized.communities[1].summary).toBeNull();

		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringContaining('Failed to summarize community'),
			expect.any(String),
		);

		warnSpy.mockRestore();
	});

	it('should respect concurrency limit', async () => {
		// Set up 5 communities with concurrency of 2
		const communities = Array.from({ length: 5 }, (_, i) =>
			makeCommunity({ id: `c${i}`, label: `C${i}` }),
		);

		for (let i = 0; i < 5; i++) {
			mockFetch.mockResolvedValueOnce(mockLlmResponse(`Summary ${i}`));
		}

		const result: CommunityDetectionResult = {
			communities,
			total_entities: 10,
			unclustered_entities: 0,
			detection_method: 'label_propagation',
		};

		const summarized = await summarizer.summarizeAll(result, 2);

		expect(summarized.communities).toHaveLength(5);
		expect(summarized.communities[0].summary).toBe('Summary 0');
		expect(summarized.communities[4].summary).toBe('Summary 4');
	});
});
