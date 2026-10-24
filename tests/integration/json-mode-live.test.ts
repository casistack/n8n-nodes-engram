import { BOUNDED_IDENTITY_INSTRUCTION } from '../../src/extraction/BoundedExtraction';
import { LlmClient } from '../../src/extraction/LlmClient';
import { z } from 'zod';

// Deliberate opt-in only: one synthetic comparison, no production records or persistence.
const live = process.env.ENGRAM_TEST_LIVE_JSON === '1' ? describe : describe.skip;
live('optional official-provider JSON comparison contract', () => {
  it('accepts the shipped trusted instruction with provider-default temperature', async () => {
    if (!process.env.OPENAI_API_KEY || !process.env.ENGRAM_TEST_MODEL)
      throw new Error('Live comparison requires explicit OPENAI_API_KEY and ENGRAM_TEST_MODEL');
    const client = new LlmClient({
      apiKey: process.env.OPENAI_API_KEY,
      baseUrl: 'https://api.openai.com/v1',
      model: process.env.ENGRAM_TEST_MODEL,
      temperature: { mode: 'providerDefault' },
      timeoutMs: 30000,
    });
    const result = await client.chatJson<unknown>(
      [
        { role: 'system', content: BOUNDED_IDENTITY_INSTRUCTION },
        {
          role: 'user',
          content: JSON.stringify({
            incoming: { name: 'Robert Example', type: 'person' },
            candidate: {
              name: 'Bob Example',
              type: 'person',
              summary: 'A fictional person used only for testing.',
            },
          }),
        },
      ],
      { requireJsonInstruction: true },
    );
    expect(
      z.object({ decision: z.enum(['duplicate', 'distinct', 'unknown']) }).safeParse(result)
        .success,
    ).toBe(true);
  }, 35000);
});
