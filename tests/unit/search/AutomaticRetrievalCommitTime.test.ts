import { makeHumanFixture } from '../../helpers/automaticCommittedFixture';
import { automaticClaimVisible } from '../../../src/search/AutomaticRetrieval';
import { projectAutomaticClaimReadContext } from '../../../src/extraction/AutomaticClaimCommitProof';
import { AutomaticCaptureOperationV2Schema } from '../../../src/schemas/AutomaticCaptureOperation.schema';
import {
  beginAutomaticClaimReadAttempt,
  type AutomaticClaimReadScope,
} from '../../../src/storage/AutomaticClaimReadScope';
import type { IGraphStorage } from '../../../src/storage/IGraphStorage';

describe('capture commitment time in historical recall', () => {
  it.each([1, 2])(
    'does not expose generation %i before its actual terminal commit',
    async (generation) => {
      const fixture = makeHumanFixture();
      const operation = fixture.humanOperation;
      if (
        operation.state !== 'committed' ||
        operation.terminalReceipt.kind !== 'human_capture_committed'
      )
        throw new Error('Expected human terminal fixture');
      const commitAt = '2026-10-25T12:01:00.000Z';
      operation.generation = generation;
      operation.lastObservedAt = commitAt;
      operation.terminalReceipt.terminalAt = commitAt;
      operation.terminalReceipt.receipt.commitAt = commitAt;
      fixture.graph.automatic_operations_v1!.operations = [
        AutomaticCaptureOperationV2Schema.parse(operation),
      ];
      const edge = fixture.graph.edges[0];
      const storage = {
        getEntity: async (id: string) =>
          fixture.graph.entities.find((entity) => entity.uuid === id) ?? null,
        getEpisode: async (id: string) =>
          fixture.graph.episodes.find((episode) => episode.uuid === id) ?? null,
        getEdgesBetween: async () => [],
        readAutomaticClaimContext: async (
          group: string,
          id: string,
          scope: AutomaticClaimReadScope,
        ) => {
          expect(beginAutomaticClaimReadAttempt(scope)).toBe(true);
          return projectAutomaticClaimReadContext(fixture.graph, group, id);
        },
      } as unknown as IGraphStorage;
      const read = (at: string) =>
        automaticClaimVisible(
          storage,
          edge,
          { remaining: 512, deferred: 0 },
          { remaining: 128 },
          { mode: 'asOf', at },
        );
      expect(await read('2026-10-25T12:00:30.000Z')).toBe('hidden');
      expect(await read(commitAt)).toBe('historical_record');
      expect(await read('2026-10-25T12:01:30.000Z')).toBe('historical_record');
    },
  );
});
