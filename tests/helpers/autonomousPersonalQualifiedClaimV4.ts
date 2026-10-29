import * as fs from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { GraphologyStorage } from '../../src/storage/GraphologyStorage';
import { dispatchNativeAutonomousPersonalCaptureV4 } from '../../src/storage/AutonomousPersonalCaptureHandlesV4';
import {
  nativeAutonomousPersonalCaptureContext,
  seedAutonomousPersonalCaptureSubject,
} from './autonomousPersonalCaptureBackend';
import {
  AutonomousPersonalSourceProducerV4OwnedDataSchema,
  compileAutonomousPersonalSourceTupleV4,
  reconstructAutonomousPersonalStoredSourceIdentityV4,
} from '../../src/schemas/AutonomousPersonalSourceV4.schema';
import { compileAutonomousPersonalSourceScanV1 } from '../../src/schemas/AutonomousPersonalSourceScanV1.schema';
import { compileAutonomousPersonalTypedSyntaxV1 } from '../../src/extraction/AutonomousPersonalTypedSyntaxV1';
import { compileAutonomousPersonalEvidenceSelectionV1 } from '../../src/extraction/AutonomousPersonalEvidenceSelectionV1';
import {
  hashAutonomousPersonalSourceUnitIdV1,
  AutonomousPersonalValueMarkerV3OwnedDataSchema,
} from '../../src/schemas/AutonomousPersonalClaimV3.schema';
import { buildAutonomousPersonalClaimCandidateV1 } from '../../src/extraction/AutonomousPersonalClaimCandidateV1';
import { deriveAutonomousPersonalRecordIdsV1 } from '../../src/storage/AutonomousPersonalRecordIdsV1';
import {
  AutonomousPersonalOperationV4OwnedDataSchema,
  AutonomousPersonalReceiptV4OwnedDataSchema,
} from '../../src/schemas/AutonomousPersonalOperationV4.schema';
import { ExtractionMetadataV2Schema } from '../../src/schemas/ExtractionMetadata.schema';
import { EntityNodeSchema } from '../../src/schemas/EntityNode.schema';
import { EntityEdgeSchema } from '../../src/schemas/EntityEdge.schema';
import type { GraphData } from '../../src/schemas';

/** Pure creator DATA fixture. Its constructed terminal is not a backend commit/origin proof. */
export async function autonomousPersonalQualifiedClaimFixtureV4(
  options: {
    content?: string;
    prefix?: string;
    profile?: 'conservative' | 'explicit' | 'reviewFirst';
    referenceTime?: string;
  } = {},
) {
  const directory = fs.mkdtempSync(join(tmpdir(), 'engram-qualified-creator-'));
  const store = new GraphologyStorage(join(directory, 'store.json'));
  try {
    await store.initialize();
    const seed = await seedAutonomousPersonalCaptureSubject(store);
    const human = options.content ?? 'I prefer concise explanations.';
    const prefix = options.prefix ?? '';
    const profile = options.profile ?? 'conservative';
    const admitted = await dispatchNativeAutonomousPersonalCaptureV4(
      nativeAutonomousPersonalCaptureContext(seed, {
        content: prefix + human,
        extraParameters: {
          automaticMemoryProfile: profile,
          automaticIntent: profile === 'explicit' ? 'enabled' : 'disabled',
        },
      }),
      store,
    );
    if (admitted.kind !== 'claimed') throw new Error('Expected synthetic initial source');
    const graph = JSON.parse(JSON.stringify(await store.exportGraph())) as GraphData;
    if (graph.group_id === undefined) delete graph.group_id;
    const source = graph.episodes.find((row) => row.uuid === admitted.sourceId)!;
    const operation = graph.automatic_operations_v1!.operations.find(
      (row) => row.operationId === admitted.operationId,
    )!;
    if (operation.version !== 4 || operation.state !== 'leased')
      throw new Error('Expected leased4');
    const descriptor = operation.descriptor;
    const original = reconstructAutonomousPersonalStoredSourceIdentityV4({ source, descriptor });
    const owner = original.tuple.owner;
    const mapping = prefix
      ? {
          mode: 'application_region' as const,
          humanRegion: { start: prefix.length, end: source.content.length },
          applicationWrapper: { configurationFingerprint: 'e'.repeat(64) },
        }
      : { mode: 'full_body' as const };
    const producer = AutonomousPersonalSourceProducerV4OwnedDataSchema.parse(
      Object.fromEntries(
        Object.keys(AutonomousPersonalSourceProducerV4OwnedDataSchema.shape).map((key) => [
          key,
          (source as unknown as Record<string, unknown>)[key],
        ]),
      ),
    );
    producer.reference_time = options.referenceTime ?? '2026-04-01T09:00:00.000Z';
    const tuple = compileAutonomousPersonalSourceTupleV4({
      scope: {
        storeHash: owner.storeHash,
        namespace: owner.namespace,
        issuer: owner.issuer,
        actorReference: owner.actorReference,
        turn: owner.turn,
        binding: owner.binding,
      },
      descriptor,
      producer,
      eventTimeMode: 'explicit',
      mapping,
      quoteRegions: [],
    });
    source.reference_time = producer.reference_time;
    source.attributes.engram_write_owner_v4 = tuple.owner;
    source.attributes.engram_source_envelope_v3 = tuple.envelope;
    const work = () => ({
      absoluteMonotonicDeadlineMs: performance.now() + 30_000,
      signal: new AbortController().signal,
    });
    const scan = compileAutonomousPersonalSourceScanV1({
      rawContent: source.content,
      mapping,
      quoteRegions: [],
    });
    const syntax = compileAutonomousPersonalTypedSyntaxV1(
      {
        rawContent: source.content,
        mapping,
        quoteRegions: [],
        syntaxScope: {
          namespace: owner.namespace,
          issuer: owner.issuer,
          actorReference: owner.actorReference,
          binding: owner.binding,
        },
      },
      work(),
    );
    if (scan.status !== 'complete' || scan.units.length !== 1 || syntax.status !== 'complete')
      throw new Error('Fixture requires one complete unit');
    const unit = scan.units[0]!;
    const typed = syntax.units[0]!;
    const bundle = typed.kind === 'typed' ? typed.preference.bundles[0]! : null;
    const kind = bundle ? 'typed_preference' : 'source_statement_record';
    const category = bundle ? 'preference' : 'work_role';
    const unitId = hashAutonomousPersonalSourceUnitIdV1({
      rawContentHash: scan.rawContentHash,
      unitIndex: 0,
      parentRawSpan: unit.rawSpan,
      parentMappedSpan: unit.mappedSpan,
    });
    const response = {
      version: 1,
      units: [{ unitId, category, risk: 'ordinary', usefulness: 'personal_memory', downgrade: [] }],
    };
    const selection = compileAutonomousPersonalEvidenceSelectionV1(
      { source, descriptor },
      response,
      work(),
    );
    if (selection.status !== 'complete' || selection.occurrences.length !== 1)
      throw new Error('Expected one source candidate');
    const reference = selection.occurrences[0]!;
    const candidate = buildAutonomousPersonalClaimCandidateV1({
      sourceId: owner.sourceId,
      contentHash: owner.contentHash,
      descriptorHash: owner.descriptorHash,
      namespace: owner.namespace,
      subjectId: owner.binding.subjectId,
      sourceHash: tuple.identity.sourceHash,
      policy: descriptor.policy,
      sourceEventTime: new Date(Date.parse(source.reference_time)).toISOString(),
      unitId,
      unitIndex: 0,
      kind,
      category,
      literal: source.content.slice(reference.rawSpan.start, reference.rawSpan.end),
      rawSpan: reference.rawSpan,
      mappedSpan: reference.mappedSpan,
      bundle,
    });
    if (candidate.kind !== 'candidate') throw new Error('Expected complete Claim3 DATA');
    const ids = deriveAutonomousPersonalRecordIdsV1({
      namespace: owner.namespace,
      subjectId: owner.binding.subjectId,
      key: candidate.claim.key,
    });
    const createdAt = operation.lease.renewedAt;
    const terminalAt = new Date(
      Math.max(Date.parse(createdAt) + 1000, Date.parse(operation.lastObservedAt) + 1),
    ).toISOString();
    const backendNow = new Date(Date.parse(terminalAt) + 1000).toISOString();
    const state = profile === 'reviewFirst' ? 'proposed' : 'accepted';
    const metadata = ExtractionMetadataV2Schema.parse({
      version: 2,
      source: 'policy',
      confidence: null,
      review_status: state,
      threshold_decision: state === 'accepted' ? 'auto_accepted' : 'pending_review',
      extracted_at: createdAt,
      episode_uuids: [source.uuid],
      reviewed_at: null,
      reviewed_by: null,
    });
    const marker = AutonomousPersonalValueMarkerV3OwnedDataSchema.parse({
      version: 3,
      family: 'autonomous-personal-v1',
      kind,
      key: candidate.claim.key,
      namespace: owner.namespace,
      subjectId: owner.binding.subjectId,
    });
    const value = EntityNodeSchema.parse({
      uuid: ids.valueId,
      group_id: owner.namespace,
      name: candidate.claim.evidence.literal,
      summary: '',
      entity_type: 'autonomous_personal_value',
      name_embedding: null,
      attributes: { engram_literal_v1: marker, engram_extraction: metadata },
      created_at: createdAt,
      updated_at: createdAt,
    });
    const edge = EntityEdgeSchema.parse({
      uuid: ids.claimId,
      group_id: owner.namespace,
      source_node_uuid: owner.binding.subjectId,
      target_node_uuid: value.uuid,
      name: bundle ? 'PREFERS' : 'STATED',
      fact: candidate.claim.evidence.literal,
      fact_embedding: null,
      episodes: [source.uuid],
      valid_at: null,
      invalid_at: null,
      expired_at: null,
      attributes: { engram_claim_v1: candidate.claim, engram_extraction: metadata },
      created_at: createdAt,
      updated_at: createdAt,
    });
    const receipt = AutonomousPersonalReceiptV4OwnedDataSchema.parse({
      version: 4,
      operationId: operation.operationId,
      sourceId: source.uuid,
      sourceHash: tuple.identity.sourceHash,
      descriptorHash: owner.descriptorHash,
      policyFingerprint: descriptor.policy.fingerprint,
      terminalAt,
      kind: 'human_autonomous_capture_committed',
      interpretationCoverage: selection.sourceCoverage.status,
      acceptedCoverage: state === 'accepted' ? 'all' : 'none',
      acceptanceSemantics: 'per_item_kind_v1',
      sourceCoverage: selection.sourceCoverage,
      selection: {
        kind: 'occurrences',
        items: [
          {
            occurrenceIndex: 0,
            kind,
            evidenceHash: reference.evidenceHash,
            meaningHash: reference.meaningHash,
            dependencies: reference.dependencies,
            state,
            effect: 'created',
            claimId: edge.uuid,
            reason: state === 'accepted' ? 'eligible_create' : 'profile_review_required',
          },
        ],
      },
    });
    const { lease: _lease, ...operationWithoutLease } = operation;
    const committed = AutonomousPersonalOperationV4OwnedDataSchema.parse({
      ...operationWithoutLease,
      identity: tuple.identity,
      state: 'committed',
      lastObservedAt: terminalAt,
      terminalReceipt: receipt,
      completionCallHash: 'c'.repeat(64),
    });
    graph.automatic_operations_v1!.operations = [committed];
    graph.entities.push(value);
    graph.edges.push(edge);
    // Detach the constructed DATA just like a serialized snapshot. Returned
    // row references point into it; paired metadata has no shared JS aliases.
    const detached = JSON.parse(JSON.stringify(graph)) as GraphData;
    const savedOperation = detached.automatic_operations_v1!.operations[0]!;
    if (
      savedOperation.version !== 4 ||
      savedOperation.state !== 'committed' ||
      savedOperation.terminalReceipt.kind !== 'human_autonomous_capture_committed'
    ) {
      throw new Error('Expected constructed creator DATA');
    }
    return {
      graph: detached,
      source: detached.episodes.find((row) => row.uuid === source.uuid)!,
      subject: detached.entities.find((row) => row.uuid === owner.binding.subjectId)!,
      value: detached.entities.find((row) => row.uuid === value.uuid)!,
      edge: detached.edges.find((row) => row.uuid === edge.uuid)!,
      operation: savedOperation,
      receipt: savedOperation.terminalReceipt,
      candidate,
      request: {
        storeHash: owner.storeHash,
        namespace: owner.namespace,
        edgeId: edge.uuid,
        backendNow,
      },
      createdAt,
      terminalAt,
      backendNow,
    };
  } finally {
    await store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

export type AutonomousPersonalQualifiedClaimFixtureV4 = Awaited<
  ReturnType<typeof autonomousPersonalQualifiedClaimFixtureV4>
>;
