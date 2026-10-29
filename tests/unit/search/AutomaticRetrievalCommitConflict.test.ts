import { randomUUID } from 'crypto';
import { performance } from 'perf_hooks';
import { makeHumanFixture } from '../../helpers/automaticCommittedFixture';
import { automaticClaimVisible } from '../../../src/search/AutomaticRetrieval';
import { projectAutomaticClaimReadContext } from '../../../src/extraction/AutomaticClaimCommitProof';
import * as claims from '../../../src/extraction/AutomaticClaims';
import {
  beginAutomaticClaimReadAttempt,
  type AutomaticClaimReadScope,
} from '../../../src/storage/AutomaticClaimReadScope';
import type { AutomaticClaimReadResult } from '../../../src/schemas/AutomaticClaimRead.schema';

describe('committed claim conflict read qualification', () => {
  afterEach(() => jest.restoreAllMocks());

  function fixture(oppositeResult?: AutomaticClaimReadResult) {
    const parent = makeHumanFixture();
    const edge = parent.graph.edges[0];
    const opposite = structuredClone(edge);
    opposite.uuid = randomUUID();
    const meta = opposite.attributes.engram_claim_v1 as {
      sourceId: string;
      claim: { polarity: string };
    };
    const source = structuredClone(parent.human);
    source.uuid = randomUUID();
    meta.sourceId = source.uuid;
    meta.claim.polarity = 'negative';
    const scopes: AutomaticClaimReadScope[] = [];
    const storage = {
      getEntity: async (id: string) =>
        parent.graph.entities.find((item) => item.uuid === id) ?? null,
      getEpisode: async (id: string) =>
        id === source.uuid
          ? source
          : (parent.graph.episodes.find((item) => item.uuid === id) ?? null),
      getEdgesBetween: async () => (oppositeResult ? [edge, opposite] : []),
      readAutomaticClaimContext: jest.fn(
        async (group: string, id: string, scope: AutomaticClaimReadScope) => {
          scopes.push(scope);
          expect(beginAutomaticClaimReadAttempt(scope)).toBe(true);
          return id === opposite.uuid && oppositeResult
            ? oppositeResult
            : projectAutomaticClaimReadContext(parent.graph, group, id);
        },
      ),
    };
    return { edge, storage, scopes };
  }

  it.each(['missing_operation', 'capture_not_committed'] as const)(
    'ignores a definitively uncommitted opposite (%s) without resetting shared resources',
    async (reason) => {
      const { edge, storage, scopes } = fixture({ status: 'uncommitted', reason });
      const budget = { remaining: 512, deferred: 0 };
      await expect(
        automaticClaimVisible(storage as never, edge, budget, { remaining: 128 }),
      ).resolves.toBe('current');
      expect(storage.readAutomaticClaimContext).toHaveBeenCalledTimes(2);
      expect(scopes[1]).toBe(scopes[0]);
      expect(budget).toEqual({ remaining: 500, deferred: 0 });
    },
  );

  it.each([
    { status: 'invalid', reason: 'invalid_context' },
    { status: 'ambiguous', reason: 'ambiguous_operation' },
    { status: 'deferred', reason: 'budget_exhausted' },
    { status: 'unavailable', reason: 'missing_store' },
  ] as const)('withholds when opposite qualification is uncertain ($status)', async (result) => {
    const { edge, storage } = fixture(result);
    const budget = { remaining: 512, deferred: 0 };
    await expect(
      automaticClaimVisible(storage as never, edge, budget, { remaining: 128 }),
    ).resolves.toBe('hidden');
    expect(budget).toEqual({ remaining: 500, deferred: 1 });
  });

  it.each(['storage', 'validation'] as const)(
    'rechecks the shared deadline after %s completes',
    async (phase) => {
      let now = 0;
      jest.spyOn(performance, 'now').mockImplementation(() => now);
      const { edge, storage } = fixture();
      if (phase === 'storage') {
        const read = storage.readAutomaticClaimContext.getMockImplementation()!;
        storage.readAutomaticClaimContext.mockImplementation(async (...args) => {
          const result = await read(...args);
          now = 5_001;
          return result;
        });
      } else {
        const validate = claims.validateAutomaticClaimReadContext;
        jest.spyOn(claims, 'validateAutomaticClaimReadContext').mockImplementation((...args) => {
          const valid = validate(...args);
          now = 5_001;
          return valid;
        });
      }
      const budget = { remaining: 512, deferred: 0 };
      await expect(
        automaticClaimVisible(storage as never, edge, budget, { remaining: 128 }),
      ).resolves.toBe('hidden');
      expect(budget).toEqual({ remaining: 505, deferred: 1 });
    },
  );
});
