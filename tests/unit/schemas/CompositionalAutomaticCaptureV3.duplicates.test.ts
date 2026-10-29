import { createHash } from 'crypto';
import { GraphDataSchema } from '../../../src/schemas';
import { makeHumanFixture } from '../../helpers/automaticCommittedFixture';
import { AutomaticWriteOwnerSchema } from '../../../src/schemas/AutomaticClaim.schema';
import { buildCompositionalHumanCaptureSourceV3 } from '../../../src/storage/CompositionalAutomaticCaptureSourceV3';
import {
  CompositionalAutomaticCaptureTerminalReceiptV3Schema,
  CompositionalAutomaticCaptureOperationV3Schema,
  CompositionalAutomaticCaptureSourceEnvelopeV2Schema,
  compositionalCaptureBundleHashV3,
  compositionalCaptureMeaningHashV3,
  compositionalCapturePredicateDependenciesV3,
  type CompositionalAutomaticBundleReceiptItemV3,
} from '../../../src/schemas/CompositionalAutomaticCaptureV3.schema';
import { COMPOSITIONAL_PREFERENCE_V2_DESCRIPTOR } from '../../../src/schemas/CompositionalPreferenceV2.schema';
import { interpretCompositionalPreferencesV2 } from '../../../src/extraction/CompositionalPreferenceV2Parser';
import { projectCompositionalPreferenceV2Meaning } from '../../../src/extraction/CompositionalPreferenceV2Meaning';

const TIME = '2026-10-25T18:00:00.000Z';
const SOURCE = '11111111-1111-4111-8111-111111111111';
const OPERATION = '22222222-2222-4222-8222-222222222222';
const CLAIM = '33333333-3333-4333-8333-333333333333';
const sha = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function sourceFixture(
  content = 'I like JSON. I like JSON.',
  old = makeHumanFixture('duplicate-receipt-fixture'),
) {
  const owner = AutomaticWriteOwnerSchema.parse(old.human.attributes.engram_write_owner_v1);
  const graph = GraphDataSchema.parse({
    version: '2.0',
    exported_at: TIME,
    group_id: old.human.group_id,
    entities: old.graph.entities.filter((entity) => entity.uuid === old.binding.subjectId),
    edges: [],
    episodes: [],
  });
  return buildCompositionalHumanCaptureSourceV3(graph, {
    sourceId: SOURCE,
    storeHash: 'b'.repeat(64),
    capturedAt: TIME,
    previousEpisodeId: null,
    request: {
      version: 3,
      lifecycle: 'replaySafeV2',
      purpose: 'human_turn_memory',
      preferenceInterpreter: 'compositionalV2',
      namespace: old.human.group_id,
      issuer: owner.issuer,
      actorReference: owner.actor,
      turn: 'synthetic-duplicate-source',
      attemptIdHash: sha('attempt'),
      settings: {
        profileId: 'conservative',
        requestedTrustLevel: 'standard',
        intentSetting: false,
        invocationDeadlineMs: 10000,
      },
      source: {
        content,
        sourceMessageId: null,
        conversationId: null,
        senderId: null,
        senderName: null,
        sourceWorkflowId: null,
        originalSourceExecutionId: null,
        sourceType: 'message',
        quotedMessageId: null,
        eventTime: { mode: 'first_capture' },
        applicationOwnedWrapper: null,
        humanRegion: null,
        quoteRegions: [],
      },
    },
  });
}

function actualRepeatedItems(built: ReturnType<typeof sourceFixture>) {
  const wrapper = CompositionalAutomaticCaptureSourceEnvelopeV2Schema.parse(
    built.episode.attributes.engram_source_envelope_v2,
  );
  const { policy, version, ...mapping } = wrapper.sourceEnvelope;
  expect(policy.version).toBe(2);
  expect(version).toBe(2);
  // Syntactic view only; no literal policy or V1 owned source is manufactured.
  const result = interpretCompositionalPreferencesV2({
    descriptor: COMPOSITIONAL_PREFERENCE_V2_DESCRIPTOR,
    rawContent: built.episode.content,
    mappedContent: built.episode.content,
    envelope: { ...mapping, version: 1 },
  });
  expect(result.coverage).toBe('complete');
  expect(result.bundles).toHaveLength(2);
  return result.bundles.map((bundle, bundleIndex): CompositionalAutomaticBundleReceiptItemV3 => {
    const projection = projectCompositionalPreferenceV2Meaning({
      preference: { ...result, bundles: [bundle] },
      namespace: built.identity.namespace,
      subjectId: built.identity.binding.subjectId,
    });
    if (!projection.ok) throw new Error('Expected structural one-bundle projection');
    return {
      bundleIndex,
      bundleHash: compositionalCaptureBundleHashV3(bundle),
      meaningHash: compositionalCaptureMeaningHashV3(projection.meaning),
      state: bundleIndex === 0 ? 'accepted' : 'unchanged',
      persisted: true,
      mutation: bundleIndex === 0 ? 'created' : 'none',
      claimId: CLAIM,
      predicateDependencies: compositionalCapturePredicateDependenciesV3(projection.meaning),
    };
  });
}

function receipt(
  built: ReturnType<typeof sourceFixture>,
  items: CompositionalAutomaticBundleReceiptItemV3[],
) {
  const accepted = items.filter(
    (item) => item.persisted && (item.state === 'accepted' || item.state === 'unchanged'),
  ).length;
  return {
    version: 3,
    kind: 'human_compositional_capture_committed',
    operationId: OPERATION,
    sourceId: SOURCE,
    sourceHash: built.identity.sourceHash,
    descriptorHash: built.descriptorHash,
    policyFingerprint: built.descriptor.policy.fingerprint,
    terminalAt: TIME,
    interpretationCoverage: 'complete',
    acceptedCoverage: accepted === 0 ? 'none' : accepted === items.length ? 'all' : 'partial',
    reasons: [],
    selection: { kind: 'bundles', items },
  };
}

function operation(built: ReturnType<typeof sourceFixture>, terminalReceipt: unknown) {
  return {
    version: 3,
    operationId: OPERATION,
    identity: built.identity,
    descriptor: built.descriptor,
    createdAt: TIME,
    lastObservedAt: TIME,
    attempts: Array.from({ length: 32 }, (_, index) => ({
      attemptHash: sha(`attempt-${index}`),
      at: TIME,
      disposition: 'in_progress',
    })),
    overflowCount: 0,
    auditTruncated: true,
    beginCallHash: sha('begin'),
    retryCount: 0,
    state: 'committed',
    generation: 1,
    terminalReceipt,
    completionCallHash: sha('completion'),
  };
}

describe('V3 duplicate bundle receipt uniform states (structure only, no persistence authority)', () => {
  test.each(['accepted', 'proposed', 'rejected', 'not_selected'] as const)(
    'retains every repeated occurrence without promoting %s',
    (state) => {
      const built = sourceFixture();
      const originals = actualRepeatedItems(built);
      const items = originals.map((item, index) => {
        const copy = clone(item);
        copy.state = state === 'accepted' ? (index === 0 ? 'accepted' : 'unchanged') : state;
        copy.mutation =
          state === 'not_selected' || state === 'rejected' || index !== 0 ? 'none' : 'created';
        if (state === 'not_selected') {
          copy.persisted = false;
          delete copy.claimId;
        }
        return copy;
      });
      const parsed = CompositionalAutomaticCaptureTerminalReceiptV3Schema.parse(
        receipt(built, items),
      );
      if (
        parsed.kind !== 'human_compositional_capture_committed' ||
        parsed.selection.kind !== 'bundles'
      )
        throw new Error('Expected bundle receipt');
      expect(parsed.acceptedCoverage).toBe(state === 'accepted' ? 'all' : 'none');
      expect(parsed.selection.items).toHaveLength(2);
      expect(parsed.selection.items.map((item) => item.bundleIndex)).toEqual([0, 1]);
      expect(parsed.selection.items[0].bundleHash).not.toBe(parsed.selection.items[1].bundleHash);
      expect(parsed.selection.items.map((item) => item.bundleHash)).toEqual(
        originals.map((item) => item.bundleHash),
      );
      expect(parsed.selection.items.map((item) => item.predicateDependencies)).toEqual(
        originals.map((item) => item.predicateDependencies),
      );
      expect(parsed.selection.items[0].meaningHash).toBe(parsed.selection.items[1].meaningHash);
      expect(parsed.selection.items[1].state).toBe(state === 'accepted' ? 'unchanged' : state);
      expect(parsed.selection.items[1].mutation).toBe('none');
    },
  );

  test.each(['unchanged', 'proposed', 'rejected'] as const)(
    'permits already persisted uniform %s duplicates with zero mutations',
    (state) => {
      const built = sourceFixture();
      const items = actualRepeatedItems(built).map((item) => ({
        ...item,
        state,
        mutation: 'none' as const,
      }));
      expect(
        CompositionalAutomaticCaptureTerminalReceiptV3Schema.safeParse(receipt(built, items))
          .success,
      ).toBe(true);
    },
  );

  test.each(['proposed', 'rejected'] as const)(
    'rejects two creations even when duplicate %s states are uniform',
    (state) => {
      const built = sourceFixture();
      const items = actualRepeatedItems(built).map((item) => ({
        ...item,
        state,
        mutation: 'created' as const,
      }));
      expect(
        CompositionalAutomaticCaptureTerminalReceiptV3Schema.safeParse(receipt(built, items))
          .success,
      ).toBe(false);
    },
  );

  test.each([
    ['proposed', 'unchanged'],
    ['rejected', 'unchanged'],
    ['accepted', 'proposed'],
    ['accepted', 'rejected'],
    ['proposed', 'rejected'],
  ] as const)('rejects promotion/mixed review %s -> %s for one meaning', (first, second) => {
    const built = sourceFixture();
    const items = actualRepeatedItems(built);
    items[0].state = first;
    items[1].state = second;
    expect(
      CompositionalAutomaticCaptureTerminalReceiptV3Schema.safeParse(receipt(built, items)).success,
    ).toBe(false);
  });

  test.each([
    'different_id',
    'two_creations',
    'mixed_persistence',
    'mixed_not_selected_review',
    'same_id_different_meaning',
    'missing_dependency',
    'missing_index',
    'false_accepted_coverage',
  ] as const)('rejects malformed duplicate group %s', (change) => {
    const built = sourceFixture();
    const items = actualRepeatedItems(built);
    if (change === 'different_id') items[1].claimId = '44444444-4444-4444-8444-444444444444';
    if (change === 'two_creations') {
      items[1].state = 'accepted';
      items[1].mutation = 'created';
    }
    if (change === 'mixed_persistence') {
      items[1].state = 'not_selected';
      items[1].persisted = false;
      delete items[1].claimId;
    }
    if (change === 'mixed_not_selected_review') {
      for (const item of items) {
        item.persisted = false;
        item.mutation = 'none';
        delete item.claimId;
      }
      items[0].state = 'not_selected';
      items[1].state = 'proposed';
    }
    if (change === 'same_id_different_meaning') items[1].meaningHash = sha('different-meaning');
    if (change === 'missing_dependency') items[1].predicateDependencies = [];
    if (change === 'missing_index') items[1].bundleIndex = 2;
    const candidate = receipt(built, items);
    if (change === 'false_accepted_coverage') {
      for (const item of items) {
        item.state = 'proposed';
        item.mutation = 'none';
      }
      candidate.acceptedCoverage = 'all';
    }
    expect(CompositionalAutomaticCaptureTerminalReceiptV3Schema.safeParse(candidate).success).toBe(
      false,
    );
  });

  test.each([
    ['accepted', false],
    ['proposed', false],
    ['rejected', false],
    ['not_selected', false],
    ['accepted', true],
    ['proposed', true],
    ['rejected', true],
    ['not_selected', true],
  ] as const)(
    'bounds structural32 repeated %s receipts/operations, reasons=%s without changing caps',
    (state, withReasons) => {
      // Capacity proof only: schema-valid receipt items are not an interpreter
      // witness. This does NOT assert that a 32-bundle AST fits its separate cap.
      const old = makeHumanFixture('duplicate-receipt-fixture');
      const built = sourceFixture(Array(32).fill('I like JSON.').join(' '), old);
      const sample = actualRepeatedItems(sourceFixture(undefined, old))[0];
      const items = Array.from(
        { length: 32 },
        (_, index): CompositionalAutomaticBundleReceiptItemV3 => {
          const item = {
            ...clone(sample),
            bundleIndex: index,
            bundleHash: sha(`source-occurrence-${index}`),
            state:
              state === 'accepted'
                ? index === 0
                  ? ('accepted' as const)
                  : ('unchanged' as const)
                : state,
            mutation:
              index === 0 && state !== 'not_selected' && state !== 'rejected'
                ? ('created' as const)
                : ('none' as const),
          };
          if (state === 'not_selected') {
            item.persisted = false;
            delete item.claimId;
          }
          if (withReasons)
            item.reason =
              state === 'accepted'
                ? index === 0
                  ? 'eligible_create'
                  : 'existing_accepted'
                : state === 'proposed'
                  ? index === 0
                    ? 'profile_review_required'
                    : 'existing_proposed'
                  : state === 'rejected'
                    ? 'existing_rejected'
                    : 'legacy_reuse_not_authorized';
          return item;
        },
      );
      const candidate = {
        ...receipt(built, items),
        reasons: Array(16).fill('ambiguous_attachment'),
      };
      const parsed = CompositionalAutomaticCaptureTerminalReceiptV3Schema.parse(candidate);
      const op = CompositionalAutomaticCaptureOperationV3Schema.parse(operation(built, parsed));
      expect(Buffer.byteLength(JSON.stringify(parsed))).toBeLessThanOrEqual(16 * 1024);
      expect(Buffer.byteLength(JSON.stringify(op))).toBeLessThanOrEqual(32 * 1024);
      expect(parsed.acceptedCoverage).toBe(state === 'accepted' ? 'all' : 'none');
      expect(
        CompositionalAutomaticCaptureTerminalReceiptV3Schema.safeParse({
          ...candidate,
          selection: { kind: 'bundles', items: [...items, { ...items[0], bundleIndex: 32 }] },
        }).success,
      ).toBe(false);
    },
  );
});
