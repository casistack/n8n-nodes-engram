import * as CompositionalParser from '../../../src/extraction/CompositionalPreferenceV2Parser';
import { captureEnvelope, compileAutomaticPolicy } from '../../../src/extraction/AutomaticEvidence';
import { COMPOSITIONAL_PREFERENCE_V2_DESCRIPTOR } from '../../../src/schemas/CompositionalPreferenceV2.schema';
import type { CompositionalAutomaticClaimMeaningV2 } from '../../../src/schemas/CompositionalAutomaticMemory.schema';
import { createCompositionalSnapshotIndexV3 } from '../../../src/extraction/CompositionalSnapshotIndexV3';
import {
  createLiteralV1SemanticOverlapPrivateProjectorV1,
  inspectLiteralV1SemanticOverlap,
} from '../../../src/extraction/LiteralV1SemanticOverlap';
import { projectCompositionalPreferenceV2Meaning } from '../../../src/extraction/CompositionalPreferenceV2Meaning';
import { makeHumanFixture } from '../../helpers/automaticCommittedFixture';

const NAMESPACE = 'literal-overlap-private-projection';
const ISSUER = 'synthetic-workflow';
const ACTOR = 'synthetic-human-actor';
const NOW = '2026-10-25T12:00:00.000Z';
const POLICY = compileAutomaticPolicy({ profileId: 'conservative' });

function makeMeaning(text: string, subjectId: string): CompositionalAutomaticClaimMeaningV2 {
  const capture = captureEnvelope(
    text,
    text,
    { namespace: NAMESPACE, issuer: ISSUER, actorReference: ACTOR },
    {
      bindingId: '00000000-0000-4000-8000-000000000001',
      revision: 1,
      subjectId,
      fingerprint: 'a'.repeat(64),
    },
    false,
    POLICY,
  );
  if (!capture.ok) throw new Error(`Synthetic new meaning capture failed: ${capture.reason}`);
  const preference = CompositionalParser.interpretCompositionalPreferencesV2({
    descriptor: COMPOSITIONAL_PREFERENCE_V2_DESCRIPTOR,
    rawContent: text,
    mappedContent: text,
    envelope: capture.envelope,
  });
  if (preference.coverage !== 'complete') throw new Error('Expected a complete synthetic meaning');
  const projection = projectCompositionalPreferenceV2Meaning({
    preference,
    namespace: NAMESPACE,
    subjectId,
  });
  if (!projection.ok) throw new Error(`Synthetic meaning projection failed: ${projection.reason}`);
  return projection.meaning;
}

describe('private literal-v1 candidate projection hook', () => {
  it('matches the legacy inspector from the same full root and refuses copied tokens', () => {
    const fixture = makeHumanFixture(NAMESPACE);
    const meaning = makeMeaning('I like concise explanations.', fixture.binding.subjectId);
    const request = {
      descriptor: { ...COMPOSITIONAL_PREFERENCE_V2_DESCRIPTOR },
      namespace: NAMESPACE,
      subjectId: fixture.binding.subjectId,
      newMeaning: meaning,
    };
    const legacy = inspectLiteralV1SemanticOverlap(
      fixture.graph,
      request,
      { remaining: 512, deferred: 0 },
      { remaining: 128 },
    );

    const token = createCompositionalSnapshotIndexV3(fixture.graph, {
      namespace: NAMESPACE,
      subjectId: fixture.binding.subjectId,
    });
    const projector = createLiteralV1SemanticOverlapPrivateProjectorV1(token, {
      now: Date.parse(NOW),
    });
    expect(projector).not.toBeNull();
    if (!projector) return;
    projector.prepareMeaning(meaning);
    const candidate = projector.projectCandidate(fixture.graph.edges[0].uuid, 512 * 1024);
    expect(candidate).not.toBeNull();
    if (!candidate) return;
    expect(candidate.capacityExceeded).toBe(false);
    expect(candidate.compare(meaning)).toEqual(legacy.inspections[0]);

    const copiedToken = JSON.parse(JSON.stringify(token));
    expect(
      createLiteralV1SemanticOverlapPrivateProjectorV1(copiedToken, { now: Date.parse(NOW) }),
    ).toBeNull();
    expect(
      createLiteralV1SemanticOverlapPrivateProjectorV1({} as never, { now: Date.parse(NOW) }),
    ).toBeNull();
  });

  it('projects one old candidate once across many new meanings and reports bounded bytes', () => {
    const fixture = makeHumanFixture(NAMESPACE);
    const meanings = Array.from({ length: 32 }, () =>
      makeMeaning('I like concise explanations.', fixture.binding.subjectId),
    );
    const token = createCompositionalSnapshotIndexV3(fixture.graph, {
      namespace: NAMESPACE,
      subjectId: fixture.binding.subjectId,
    });
    const projector = createLiteralV1SemanticOverlapPrivateProjectorV1(token, {
      now: Date.parse(NOW),
    });
    expect(projector).not.toBeNull();
    if (!projector) return;

    const original = CompositionalParser.interpretCompositionalPreferencesV2;
    const parseSpy = jest
      .spyOn(CompositionalParser, 'interpretCompositionalPreferencesV2')
      .mockImplementation((input) => original(input));
    try {
      for (const meaning of meanings) projector.prepareMeaning(meaning);
      const candidate = projector.projectCandidate(fixture.graph.edges[0].uuid, 512 * 1024);
      expect(candidate).not.toBeNull();
      if (!candidate) return;
      expect(candidate.capacityExceeded).toBe(false);
      expect(candidate.inspectedBytes).toBeGreaterThan(0);
      for (const meaning of meanings) {
        expect(candidate.compare(meaning).projection).toBe('exact');
      }
      expect(parseSpy).toHaveBeenCalledTimes(1);
    } finally {
      parseSpy.mockRestore();
    }
  });

  it('marks a candidate incomplete when its first bounded projection exceeds the caller limit', () => {
    const fixture = makeHumanFixture(NAMESPACE);
    const token = createCompositionalSnapshotIndexV3(fixture.graph, {
      namespace: NAMESPACE,
      subjectId: fixture.binding.subjectId,
    });
    const projector = createLiteralV1SemanticOverlapPrivateProjectorV1(token, {
      now: Date.parse(NOW),
    });
    expect(projector).not.toBeNull();
    if (!projector) return;
    const candidate = projector.projectCandidate(fixture.graph.edges[0].uuid, 1);
    expect(candidate).toMatchObject({ capacityExceeded: true, inspectedBytes: 2 });
  });
});
