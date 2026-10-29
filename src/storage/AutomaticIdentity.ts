import { createHash } from 'crypto';
import { z } from 'zod';
import {
  AutomaticBindingAuditSchema,
  AutomaticBindingCommandSchema,
  AutomaticBindingRecordSchema,
  type AutomaticBindingCommand,
  type AutomaticBindingRecord,
} from '../schemas/AutomaticOperations.schema';
import {
  AutomaticBindingReferenceSchema,
  AutomaticSourceEnvelopeSchema,
  type AutomaticSourceEnvelope,
} from '../schemas/AutomaticMemory.schema';
import {
  AutomaticWriteOwnerSchema,
  type AutomaticWriteOwner,
} from '../schemas/AutomaticClaim.schema';
import { extractionMetadataFromAttributes } from '../schemas/ExtractionMetadata.schema';
import type { EntityNode } from '../schemas/EntityNode.schema';
import type { CreateEpisodicNode, EpisodicNode } from '../schemas/EpisodicNode.schema';
import type { GraphData } from '../schemas/GraphData.schema';
import {
  AutomaticOperationIdentitySchema,
  type AutomaticLedger,
  type AutomaticOperationIdentity,
  type StoredAutomaticOperation,
} from '../schemas/AutomaticLedger.schema';
import { captureEnvelope, compileAutomaticPolicy } from '../extraction/AutomaticEvidence';
import {
  COMPOSITIONAL_CAPTURE_V3_OWNER_ATTRIBUTE,
  COMPOSITIONAL_CAPTURE_V2_ENVELOPE_ATTRIBUTE,
  CompositionalAutomaticCaptureSourceOwnerV3Schema,
  reconcileCompositionalCaptureOperationIdentityV3,
} from '../schemas/CompositionalAutomaticCaptureV3.schema';
import {
  validateCompositionalAutomaticSourceTupleV3,
  reconstructCompositionalAutomaticSourceIdentityV3,
} from './CompositionalAutomaticCaptureSourceTupleV3';
import {
  AUTONOMOUS_CAPTURE_V4_OWNER_ATTRIBUTE,
  AUTONOMOUS_CAPTURE_V3_ENVELOPE_ATTRIBUTE,
  reconstructAutonomousPersonalStoredSourceV4,
  reconstructAutonomousPersonalStoredSourceIdentityV4,
} from '../schemas/AutonomousPersonalSourceV4.schema';
import { hashAutonomousPersonalDescriptorV4 } from '../schemas/AutonomousPersonalDescriptorV4.schema';
import {
  AutomaticCaptureSourceOwnerV2Schema,
  AutomaticCaptureSourceOwnerStoredV2Schema,
  AutomaticOperationDescriptorV2Schema,
  AutomaticOperationIdentityV2Schema,
  hashAutomaticCaptureV2,
  type AutomaticOperationDescriptorV2,
  type AutomaticOperationIdentityV2,
} from '../schemas/AutomaticCapture.schema';

export const BINDINGS_ATTRIBUTE = 'engram_actor_bindings_v1';
export const SOURCE_ENVELOPE_ATTRIBUTE = 'engram_source_envelope_v1';
export const WRITE_OWNER_ATTRIBUTE = 'engram_write_owner_v1';
export const WRITE_OWNER_V2_ATTRIBUTE = 'engram_write_owner_v2';
export const WRITE_OWNER_V3_ATTRIBUTE = COMPOSITIONAL_CAPTURE_V3_OWNER_ATTRIBUTE;
export const SOURCE_ENVELOPE_V2_ATTRIBUTE = COMPOSITIONAL_CAPTURE_V2_ENVELOPE_ATTRIBUTE;
export const WRITE_OWNER_V4_ATTRIBUTE = AUTONOMOUS_CAPTURE_V4_OWNER_ATTRIBUTE;
export const SOURCE_ENVELOPE_V3_ATTRIBUTE = AUTONOMOUS_CAPTURE_V3_ENVELOPE_ATTRIBUTE;
const PROTECTED_EPISODE_ATTRIBUTES = [
  SOURCE_ENVELOPE_ATTRIBUTE,
  WRITE_OWNER_ATTRIBUTE,
  WRITE_OWNER_V2_ATTRIBUTE,
  WRITE_OWNER_V3_ATTRIBUTE,
  SOURCE_ENVELOPE_V2_ATTRIBUTE,
  WRITE_OWNER_V4_ATTRIBUTE,
  SOURCE_ENVELOPE_V3_ATTRIBUTE,
] as const;

const MAX_BINDINGS_PER_SUBJECT = 32;
const MAX_BINDING_AUDIT = 20;
const MAX_REVISION = 2147483647;
const StrictBindingRecordSchema = AutomaticBindingRecordSchema.extend({
  audit: z.array(AutomaticBindingAuditSchema.strict()).min(1).max(MAX_BINDING_AUDIT),
}).strict();
const StrictSubjectBindingsSchema = z
  .array(StrictBindingRecordSchema)
  .max(MAX_BINDINGS_PER_SUBJECT);

function fail(code: string): never {
  throw new Error(`Engram automatic memory: ${code}`);
}

function hasOwn(value: unknown, key: string): boolean {
  return (
    value !== null && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, key)
  );
}

function cloneJson<T>(value: T): T {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    fail('invalid_protected_metadata');
  }
  if (serialized === undefined) fail('invalid_protected_metadata');
  try {
    return JSON.parse(serialized) as T;
  } catch {
    fail('invalid_protected_metadata');
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value as Record<string, unknown>).forEach((nested) => deepFreeze(nested));
    Object.freeze(value);
  }
  return value;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function automaticWriteOwnerIdempotencyKey(
  owner: Pick<AutomaticWriteOwner, 'turn' | 'role'>,
): string {
  return `automatic:${sha256(owner.turn)}:${owner.role}`;
}

/** Detached immutable copy for storage caches and returned graph snapshots. */
export function immutableAutomaticLedgerSnapshot(ledger: AutomaticLedger): AutomaticLedger {
  return deepFreeze(cloneJson(ledger));
}

function bindingFingerprint(record: Omit<AutomaticBindingRecord, 'fingerprint'>): string {
  return createHash('sha256')
    .update(
      canonical({
        version: record.version,
        bindingId: record.bindingId,
        namespace: record.namespace,
        issuer: record.issuer,
        actorReference: record.actorReference,
        subjectId: record.subjectId,
        revision: record.revision,
        state: record.state,
        audit: record.audit,
      }),
      'utf8',
    )
    .digest('hex');
}

function sameCompiledPolicy(value: unknown): boolean {
  if (!value || typeof value !== 'object' || !('profileId' in value)) return false;
  try {
    const raw = value as Record<string, unknown>;
    const expected = compileAutomaticPolicy({ profileId: raw.profileId as never });
    return canonical(raw) === canonical(expected);
  } catch {
    return false;
  }
}

function identityKey(
  record: Pick<AutomaticBindingRecord, 'namespace' | 'issuer' | 'actorReference'>,
): string {
  return canonical([record.namespace, record.issuer, record.actorReference]);
}

function readEntityBindings(entity: EntityNode, check?: () => void): AutomaticBindingRecord[] {
  if (!hasOwn(entity.attributes, BINDINGS_ATTRIBUTE)) return [];
  const parsed = StrictSubjectBindingsSchema.safeParse(entity.attributes[BINDINGS_ATTRIBUTE]);
  if (!parsed.success || parsed.data.length === 0) fail('invalid_binding_metadata');
  const ids = new Set<string>();
  const identities = new Set<string>();
  for (const record of parsed.data) {
    check?.();
    if (record.subjectId !== entity.uuid || record.namespace !== entity.group_id) {
      fail('invalid_binding_metadata');
    }
    if (record.fingerprint !== bindingFingerprint(record)) fail('invalid_binding_metadata');
    if (ids.has(record.bindingId) || identities.has(identityKey(record))) fail('duplicate_binding');
    ids.add(record.bindingId);
    identities.add(identityKey(record));
  }
  return parsed.data;
}

interface LocatedBinding {
  entity: EntityNode;
  record: AutomaticBindingRecord;
}

function allBindings(graph: GraphData, check?: () => void): LocatedBinding[] {
  const records: LocatedBinding[] = [];
  const bindingIds = new Set<string>();
  const identities = new Set<string>();
  for (const entity of graph.entities) {
    check?.();
    for (const record of readEntityBindings(entity, check)) {
      const key = identityKey(record);
      if (bindingIds.has(record.bindingId) || identities.has(key)) fail('duplicate_binding');
      bindingIds.add(record.bindingId);
      identities.add(key);
      records.push({ entity, record });
    }
  }
  return records;
}

/** Read-only whole-registry validation before private indexed projections. */
export function assertAutomaticBindingRegistryIntegrity(
  graph: GraphData,
  check?: () => void,
): void {
  allBindings(graph, check);
}

function immutableRecord(record: AutomaticBindingRecord): AutomaticBindingRecord {
  return deepFreeze(cloneJson(record));
}

export function findAutomaticBinding(
  graph: GraphData,
  namespace: string,
  issuer: string,
  actorReference: string,
  check?: () => void,
): AutomaticBindingRecord | null {
  const matches = allBindings(graph, check).filter(
    ({ record }) =>
      record.namespace === namespace &&
      record.issuer === issuer &&
      record.actorReference === actorReference,
  );
  if (matches.length > 1) fail('duplicate_binding');
  return matches[0] ? immutableRecord(matches[0].record) : null;
}

function findEntity(graph: GraphData, uuid: string, check?: () => void): EntityNode | undefined {
  for (const entity of graph.entities) {
    check?.();
    if (entity.uuid === uuid) return entity;
  }
  return undefined;
}

function assertAcceptedSubject(
  entity: EntityNode | undefined,
  namespace: string,
  check?: () => void,
): EntityNode {
  if (!entity) fail('subject_not_found');
  if (entity.group_id !== namespace) fail('namespace_mismatch');
  readEntityBindings(entity, check);
  if (extractionMetadataFromAttributes(entity.attributes)?.review_status !== 'accepted') {
    fail('subject_not_accepted');
  }
  return entity;
}

function assertBindingSubject(entity: EntityNode | undefined, namespace: string): EntityNode {
  if (!entity) fail('subject_not_found');
  if (entity.group_id !== namespace) fail('namespace_mismatch');
  readEntityBindings(entity);
  return entity;
}

export function assertAutomaticBindingIdentity(
  graph: GraphData,
  namespace: string,
  issuer: string,
  actorReference: string,
  bindingRef: unknown,
  check?: () => void,
): EntityNode {
  const parsedRef = AutomaticBindingReferenceSchema.safeParse(bindingRef);
  if (!parsedRef.success) fail('binding_changed');
  const record = findAutomaticBinding(graph, namespace, issuer, actorReference, check);
  if (!record) fail('missing_binding');
  if (
    record.state !== 'active' ||
    record.bindingId !== parsedRef.data.bindingId ||
    record.revision !== parsedRef.data.revision ||
    record.subjectId !== parsedRef.data.subjectId ||
    record.fingerprint !== parsedRef.data.fingerprint
  ) {
    fail(record.state === 'revoked' ? 'binding_revoked' : 'binding_changed');
  }
  const entity = assertAcceptedSubject(
    findEntity(graph, record.subjectId, check),
    namespace,
    check,
  );
  return protectAutomaticEntity(entity);
}

export function assertAutomaticBinding(
  graph: GraphData,
  envelope: AutomaticSourceEnvelope,
  check?: () => void,
): EntityNode {
  const parsed = AutomaticSourceEnvelopeSchema.safeParse(envelope);
  if (!parsed.success) fail('invalid_envelope');
  return assertAutomaticBindingIdentity(
    graph,
    parsed.data.namespace,
    parsed.data.issuer,
    parsed.data.actorReference,
    parsed.data.bindingRef,
    check,
  );
}

function setEntityBindings(entity: EntityNode, bindings: AutomaticBindingRecord[]): void {
  const attributes = { ...entity.attributes };
  if (bindings.length === 0) delete attributes[BINDINGS_ATTRIBUTE];
  else attributes[BINDINGS_ATTRIBUTE] = cloneJson(bindings);
  entity.attributes = attributes;
}

function locateBinding(graph: GraphData, bindingId: string): LocatedBinding {
  const matches = allBindings(graph).filter(({ record }) => record.bindingId === bindingId);
  if (matches.length === 0) fail('binding_not_found');
  if (matches.length > 1) fail('duplicate_binding');
  return matches[0];
}

function appendAudit(
  record: AutomaticBindingRecord,
  audit: AutomaticBindingRecord['audit'][number],
): AutomaticBindingRecord['audit'] {
  if (record.audit.length >= MAX_BINDING_AUDIT) fail('audit_capacity');
  if (record.revision >= MAX_REVISION) fail('revision_capacity');
  return [...record.audit, audit];
}

function withFingerprint(
  record: Omit<AutomaticBindingRecord, 'fingerprint'>,
): AutomaticBindingRecord {
  return StrictBindingRecordSchema.parse({ ...record, fingerprint: bindingFingerprint(record) });
}

export function applyAutomaticBindingCommand(
  graph: GraphData,
  command: AutomaticBindingCommand,
  bindingId: string,
  now: string,
): AutomaticBindingRecord {
  const parsedCommand = AutomaticBindingCommandSchema.parse(command);
  if (!z.string().uuid().safeParse(bindingId).success) fail('invalid_binding_id');
  if (!z.string().datetime().safeParse(now).success) fail('invalid_timestamp');
  const located = allBindings(graph);

  if (parsedCommand.action === 'create') {
    const target = assertAcceptedSubject(
      findEntity(graph, parsedCommand.subjectId),
      parsedCommand.namespace,
    );
    if (
      located.some(
        ({ record }) =>
          record.namespace === parsedCommand.namespace &&
          record.issuer === parsedCommand.issuer &&
          record.actorReference === parsedCommand.actorReference,
      )
    ) {
      fail('duplicate_binding');
    }
    if (located.some(({ record }) => record.bindingId === bindingId)) fail('duplicate_binding');
    const current = readEntityBindings(target);
    if (current.length >= MAX_BINDINGS_PER_SUBJECT) fail('binding_capacity');
    const audit = [
      AutomaticBindingAuditSchema.strict().parse({
        action: 'create',
        authorizedBy: parsedCommand.authorizedBy,
        reason: parsedCommand.reason,
        at: now,
      }),
    ];
    const record = withFingerprint({
      version: 1,
      bindingId,
      namespace: parsedCommand.namespace,
      issuer: parsedCommand.issuer,
      actorReference: parsedCommand.actorReference,
      subjectId: parsedCommand.subjectId,
      revision: 1,
      state: 'active',
      audit,
    });
    setEntityBindings(target, [...current, record]);
    return immutableRecord(record);
  }

  const { entity: source, record: current } = locateBinding(graph, parsedCommand.bindingId);
  if (current.namespace !== parsedCommand.namespace) fail('namespace_mismatch');
  if (current.revision !== parsedCommand.expectedRevision) fail('binding_changed');
  if (current.state !== 'active') fail('binding_revoked');
  const currentSubject = assertBindingSubject(source, current.namespace);

  if (parsedCommand.action === 'revoke') {
    const audit = appendAudit(current, {
      action: 'revoke',
      authorizedBy: parsedCommand.authorizedBy,
      reason: parsedCommand.reason,
      at: now,
    });
    const updated = withFingerprint({
      ...current,
      revision: current.revision + 1,
      state: 'revoked',
      audit,
    });
    const bindings = readEntityBindings(currentSubject).map((record) =>
      record.bindingId === current.bindingId ? updated : record,
    );
    setEntityBindings(currentSubject, bindings);
    return immutableRecord(updated);
  }

  const target = assertAcceptedSubject(
    findEntity(graph, parsedCommand.subjectId),
    current.namespace,
  );
  const sourceBindings = readEntityBindings(currentSubject);
  const targetBindings =
    currentSubject.uuid === target.uuid ? sourceBindings : readEntityBindings(target);
  if (currentSubject.uuid !== target.uuid && targetBindings.length >= MAX_BINDINGS_PER_SUBJECT) {
    fail('binding_capacity');
  }
  const audit = appendAudit(current, {
    action: 'reassign',
    authorizedBy: parsedCommand.authorizedBy,
    reason: parsedCommand.reason,
    at: now,
    previousSubjectId: current.subjectId,
  });
  const updated = withFingerprint({
    ...current,
    subjectId: target.uuid,
    revision: current.revision + 1,
    audit,
  });
  if (currentSubject.uuid === target.uuid) {
    setEntityBindings(
      currentSubject,
      sourceBindings.map((record) => (record.bindingId === current.bindingId ? updated : record)),
    );
  } else {
    setEntityBindings(
      currentSubject,
      sourceBindings.filter((record) => record.bindingId !== current.bindingId),
    );
    setEntityBindings(target, [...targetBindings, updated]);
  }
  return immutableRecord(updated);
}

export function assertNoAutomaticBindingAttribute(attributes?: Record<string, unknown>): void {
  if (hasOwn(attributes, BINDINGS_ATTRIBUTE)) fail('reserved_attribute');
}

export function assertNoAutomaticBindingMutation(
  incomingAttributes: Record<string, unknown> | undefined,
  existingAttributes: Record<string, unknown> | undefined,
): void {
  const incomingHas = hasOwn(incomingAttributes, BINDINGS_ATTRIBUTE);
  const existingHas = hasOwn(existingAttributes, BINDINGS_ATTRIBUTE);
  if (incomingHas !== existingHas) fail('binding_metadata_immutable');
  if (
    incomingHas &&
    canonical(incomingAttributes?.[BINDINGS_ATTRIBUTE]) !==
      canonical(existingAttributes?.[BINDINGS_ATTRIBUTE])
  ) {
    fail('binding_metadata_immutable');
  }
}

export function automaticEntityHasBindings(entity: EntityNode): boolean {
  const bindings = readEntityBindings(entity);
  return bindings.length > 0;
}

export function assertAutomaticEntityDeleteAllowed(entity: EntityNode): void {
  if (automaticEntityHasBindings(entity)) fail('bound_subject_delete_forbidden');
}

export function prepareAutomaticEntityUpdate(
  existing: EntityNode,
  updates: Partial<EntityNode>,
): Partial<EntityNode> {
  const existingBindings = readEntityBindings(existing);
  const hasStored = hasOwn(existing.attributes, BINDINGS_ATTRIBUTE);
  if (
    existingBindings.length &&
    updates.group_id !== undefined &&
    updates.group_id !== existing.group_id
  ) {
    fail('bound_subject_group_move_forbidden');
  }
  if (updates.attributes === undefined) return updates;
  const hasIncoming = hasOwn(updates.attributes, BINDINGS_ATTRIBUTE);
  if (!hasStored && hasIncoming) fail('reserved_attribute');
  if (!hasStored) return updates;
  if (
    hasIncoming &&
    canonical(updates.attributes?.[BINDINGS_ATTRIBUTE]) !==
      canonical(existing.attributes[BINDINGS_ATTRIBUTE])
  ) {
    fail('reserved_attribute');
  }
  return {
    ...updates,
    attributes: {
      ...(updates.attributes ?? {}),
      [BINDINGS_ATTRIBUTE]: cloneJson(existing.attributes[BINDINGS_ATTRIBUTE]),
    },
  };
}

export function protectAutomaticEntity(entity: EntityNode): EntityNode {
  if (!hasOwn(entity.attributes, BINDINGS_ATTRIBUTE)) return entity;
  readEntityBindings(entity);
  return deepFreeze(cloneJson(entity));
}

function isOwnedEpisode(episode: { attributes?: Record<string, unknown> }): boolean {
  return Object.keys(episode.attributes ?? {}).some(
    (key) => key.startsWith('engram_write_owner_v') || key.startsWith('engram_source_envelope_v'),
  );
}

/** Presence protects a source even when its operation/receipt cannot be recovered. */
export function hasAutonomousSourceOwnership(episode: {
  attributes?: Record<string, unknown>;
}): boolean {
  return (
    hasOwn(episode.attributes, WRITE_OWNER_V4_ATTRIBUTE) ||
    hasOwn(episode.attributes, SOURCE_ENVELOPE_V3_ATTRIBUTE)
  );
}

function assertKnownEpisodeOwnerVersions(attributes: Record<string, unknown>): void {
  for (const key of Object.keys(attributes)) {
    if (
      (key.startsWith('engram_write_owner_v') || key.startsWith('engram_source_envelope_v')) &&
      !PROTECTED_EPISODE_ATTRIBUTES.some((known) => known === key)
    ) {
      fail('invalid_write_owner');
    }
  }
}

function policyMatches(value: unknown): boolean {
  return sameCompiledPolicy(value);
}

function validateEpisodeProtectedAttributes<T extends CreateEpisodicNode | EpisodicNode>(
  episode: T,
): T {
  const attributes = episode.attributes ?? {};
  assertKnownEpisodeOwnerVersions(attributes);
  if (
    hasOwn(attributes, WRITE_OWNER_V4_ATTRIBUTE) ||
    hasOwn(attributes, SOURCE_ENVELOPE_V3_ATTRIBUTE)
  ) {
    const reconstructed = reconstructAutonomousPersonalStoredSourceV4(episode);
    return { ...episode, attributes: reconstructed.source.attributes };
  }
  const hasEnvelope = hasOwn(attributes, SOURCE_ENVELOPE_ATTRIBUTE);
  const hasOwner = hasOwn(attributes, WRITE_OWNER_ATTRIBUTE);
  const hasV2Owner = hasOwn(attributes, WRITE_OWNER_V2_ATTRIBUTE);
  if (
    hasOwn(attributes, WRITE_OWNER_V3_ATTRIBUTE) ||
    hasOwn(attributes, SOURCE_ENVELOPE_V2_ATTRIBUTE)
  ) {
    const tuple = validateCompositionalAutomaticSourceTupleV3(episode);
    return { ...episode, attributes: tuple.source.attributes };
  }
  if (!hasEnvelope && !hasOwner && !hasV2Owner) return episode;
  if (hasEnvelope && !hasOwner) fail('invalid_write_owner');

  const copiedAttributes = cloneJson(attributes);
  let envelope: AutomaticSourceEnvelope | undefined;
  if (hasEnvelope) {
    const parsedEnvelope = AutomaticSourceEnvelopeSchema.safeParse(
      copiedAttributes[SOURCE_ENVELOPE_ATTRIBUTE],
    );
    if (!parsedEnvelope.success) fail('invalid_source_envelope');
    envelope = parsedEnvelope.data;
    const mapping = envelope.mappings.length === 1 ? envelope.mappings[0] : undefined;
    const rawStart = mapping?.rawStart ?? -1;
    const rawEnd = mapping?.rawEnd ?? -1;
    const mappedText =
      rawStart >= 0 && rawEnd <= episode.content.length
        ? episode.content.slice(rawStart, rawEnd)
        : '';
    let mappedTextWellFormed = true;
    for (let index = 0; index < mappedText.length; index += 1) {
      const code = mappedText.charCodeAt(index);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = mappedText.charCodeAt(index + 1);
        if (!(next >= 0xdc00 && next <= 0xdfff)) {
          mappedTextWellFormed = false;
          break;
        }
        index += 1;
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        mappedTextWellFormed = false;
        break;
      }
    }
    if (
      !mapping ||
      envelope.contentHash !== sha256(mappedText) ||
      envelope.rawContentHash !== sha256(episode.content) ||
      mapping.contentStart !== 0 ||
      mapping.contentEnd !== mappedText.length ||
      mapping.rawStart !== envelope.humanRegion.start ||
      mapping.rawEnd !== envelope.humanRegion.end ||
      !mappedTextWellFormed ||
      (envelope.mappingAuthority === 'whole_source' &&
        (mapping.rawStart !== 0 || mapping.rawEnd !== episode.content.length)) ||
      envelope.namespace !== episode.group_id ||
      episode.role !== 'human'
    ) {
      fail('invalid_source_envelope');
    }
    copiedAttributes[SOURCE_ENVELOPE_ATTRIBUTE] = cloneJson(envelope);
  }

  if (hasOwner) {
    const parsedOwner = AutomaticWriteOwnerSchema.safeParse(
      copiedAttributes[WRITE_OWNER_ATTRIBUTE],
    );
    if (!parsedOwner.success) fail('invalid_write_owner');
    const owner = parsedOwner.data;
    if (
      !policyMatches(owner.policy) ||
      owner.policy.profileId === 'existing' ||
      owner.policy.policyId !== 'literal-preferences'
    ) {
      fail('invalid_write_owner');
    }
    if (owner.contentHash !== sha256(episode.content) || owner.namespace !== episode.group_id) {
      fail('invalid_write_owner');
    }
    if (episode.idempotency_key !== automaticWriteOwnerIdempotencyKey(owner)) {
      fail('invalid_write_owner');
    }
    if (
      (owner.role === 'human' && episode.role !== 'human') ||
      (owner.role === 'assistant' && episode.role !== 'ai')
    ) {
      fail('invalid_write_owner');
    }
    if (owner.role === 'human' && owner.binding !== null && !envelope) fail('invalid_write_owner');
    if (
      envelope &&
      (owner.actor !== envelope.actorReference ||
        owner.issuer !== envelope.issuer ||
        owner.binding === null ||
        canonical(owner.binding) !== canonical(envelope.bindingRef) ||
        canonical(owner.policy) !== canonical(envelope.policy))
    ) {
      fail('invalid_write_owner');
    }
    copiedAttributes[WRITE_OWNER_ATTRIBUTE] = cloneJson(owner);
  }
  if (hasV2Owner) {
    const parsed = AutomaticCaptureSourceOwnerStoredV2Schema.safeParse(
      copiedAttributes[WRITE_OWNER_V2_ATTRIBUTE],
    );
    if (!parsed.success) fail('invalid_write_owner');
    const owner = parsed.data;
    if (
      episode.content.length === 0 ||
      episode.content.length > 65_536 ||
      Buffer.byteLength(episode.content, 'utf8') > 65_536 ||
      (episode.source_type ?? 'message') !== 'message' ||
      owner.namespace !== episode.group_id ||
      owner.sourceContentHash !== sha256(episode.content) ||
      episode.idempotency_key !== automaticWriteOwnerIdempotencyKey(owner)
    ) {
      fail('invalid_write_owner');
    }
    for (let index = 0; index < episode.content.length; index++) {
      const unit = episode.content.charCodeAt(index);
      if (unit >= 0xd800 && unit <= 0xdbff) {
        const next = episode.content.charCodeAt(++index);
        if (!(next >= 0xdc00 && next <= 0xdfff)) fail('invalid_write_owner');
      } else if (unit >= 0xdc00 && unit <= 0xdfff) fail('invalid_write_owner');
    }
    if (owner.purpose === 'human_turn_memory') {
      if (
        !hasOwner ||
        !envelope ||
        episode.role !== 'human' ||
        episode.episode_kind !== 'active_human'
      )
        fail('invalid_write_owner');
      const legacy = AutomaticWriteOwnerSchema.parse(copiedAttributes[WRITE_OWNER_ATTRIBUTE]);
      if (
        owner.storeHash !== legacy.store ||
        owner.turn !== legacy.turn ||
        owner.issuer !== legacy.issuer ||
        owner.actorReference !== legacy.actor ||
        canonical(owner.binding) !== canonical(legacy.binding) ||
        canonical(owner.policy) !== canonical(legacy.policy) ||
        owner.intentEvidence !== envelope.explicitIntent
      ) {
        fail('invalid_write_owner');
      }
      const captured = captureEnvelope(
        episode.content.slice(envelope.humanRegion.start, envelope.humanRegion.end),
        episode.content,
        {
          namespace: owner.namespace,
          issuer: owner.issuer,
          actorReference: owner.actorReference,
          quoteRegions: envelope.quoteRegions,
          ...(envelope.mappingAuthority === 'application_region'
            ? { applicationOwnedWrapper: true as const, humanRegion: envelope.humanRegion }
            : {}),
        },
        owner.binding,
        owner.intentSetting,
        owner.policy,
      );
      if (!captured.ok || canonical(captured.envelope) !== canonical(envelope))
        fail('invalid_write_owner');
    } else if (
      hasOwner ||
      hasEnvelope ||
      episode.role !== 'ai' ||
      episode.episode_kind !== 'assistant_reply'
    ) {
      fail('invalid_write_owner');
    }
    const stableProducerHash = hashAutomaticCaptureV2({
      source_workflow_id: episode.source_workflow_id ?? null,
      source_message_id: episode.source_message_id ?? null,
      conversation_id: episode.conversation_id ?? null,
      sender_id: episode.sender_id ?? null,
      source_type: episode.source_type ?? 'message',
      episode_kind: episode.episode_kind,
      quoted_message_id: episode.quoted_message_id ?? null,
    });
    const referenceTime = Date.parse(episode.reference_time);
    if (!Number.isFinite(referenceTime)) fail('invalid_write_owner');
    const eventTimeHash = hashAutomaticCaptureV2({
      mode: owner.eventTimeMode,
      normalizedReferenceTime: new Date(referenceTime).toISOString(),
    });
    if (owner.stableProducerHash !== stableProducerHash || owner.eventTimeHash !== eventTimeHash)
      fail('invalid_write_owner');
    copiedAttributes[WRITE_OWNER_V2_ATTRIBUTE] = cloneJson(owner);
  }
  return { ...episode, attributes: copiedAttributes };
}

export function prepareAutomaticEpisodeInput<T extends CreateEpisodicNode | EpisodicNode>(
  episode: T,
): T {
  return validateEpisodeProtectedAttributes(episode);
}

/** Derive immutable ledger identity only from an already stored, validated owner source. */
export function automaticOperationIdentityForOwnedSource(
  episode: EpisodicNode,
  expectedOwner: AutomaticWriteOwner,
): AutomaticOperationIdentity {
  const validated = prepareAutomaticEpisodeInput(episode);
  if (
    hasOwn(validated.attributes, WRITE_OWNER_V2_ATTRIBUTE) ||
    hasOwn(validated.attributes, WRITE_OWNER_V3_ATTRIBUTE) ||
    hasOwn(validated.attributes, WRITE_OWNER_V4_ATTRIBUTE)
  )
    fail('unsupported_capture_version');
  if (!hasOwn(validated.attributes, WRITE_OWNER_ATTRIBUTE)) fail('legacy_source_not_owned');
  const owner = AutomaticWriteOwnerSchema.parse(validated.attributes[WRITE_OWNER_ATTRIBUTE]);
  const parsedExpectedOwner = AutomaticWriteOwnerSchema.parse(expectedOwner);
  if (canonical(owner) !== canonical(parsedExpectedOwner)) fail('owned_source_mismatch');

  const sourceAttributes = { ...validated.attributes };
  // Queue ownership is operational state; it is not part of the immutable source payload.
  delete sourceAttributes.engram_extraction_queue_v1;
  const sourceFields = Object.fromEntries(
    Object.entries({ ...validated, attributes: sourceAttributes }).filter(
      ([key]) => key !== 'updated_at',
    ),
  );
  const sourceHash = sha256(canonical(sourceFields));
  const envelope = hasOwn(validated.attributes, SOURCE_ENVELOPE_ATTRIBUTE)
    ? validated.attributes[SOURCE_ENVELOPE_ATTRIBUTE]
    : null;
  // Preserve the original producer provenance even if an operator later reviews or
  // changes mutable trust, confidence, or display metadata on the stored episode.
  const producerProvenance = {
    uuid: validated.uuid,
    group_id: validated.group_id,
    role: validated.role,
    source_type: validated.source_type,
    episode_kind: validated.episode_kind,
    reference_time: validated.reference_time,
    previous_episode_uuid: validated.previous_episode_uuid,
    source_message_id: validated.source_message_id,
    idempotency_key: validated.idempotency_key,
    conversation_id: validated.conversation_id,
    sender_id: validated.sender_id,
    source_workflow_id: validated.source_workflow_id,
    source_execution_id: validated.source_execution_id,
    quoted_message_id: validated.quoted_message_id,
  };

  return AutomaticOperationIdentitySchema.parse({
    storeHash: owner.store,
    namespace: owner.namespace,
    issuer: owner.issuer,
    actorReference: owner.actor,
    turn: owner.turn,
    role: owner.role,
    sourceId: validated.uuid,
    sourceHash,
    originalProducerHash: sha256(canonical({ owner, envelope, producerProvenance })),
    binding: owner.binding,
  });
}

/** Reuse the captured full-source fingerprint after mutable review-state changes. */
export function reconcileAutomaticOperationIdentity(
  observed: AutomaticOperationIdentity,
  captured: AutomaticOperationIdentity,
): AutomaticOperationIdentity | null {
  const observedImmutable = Object.fromEntries(
    Object.entries(observed).filter(([key]) => key !== 'sourceHash'),
  );
  const capturedImmutable = Object.fromEntries(
    Object.entries(captured).filter(([key]) => key !== 'sourceHash'),
  );
  if (canonical(observedImmutable) !== canonical(capturedImmutable)) return null;
  return AutomaticOperationIdentitySchema.parse({ ...observed, sourceHash: captured.sourceHash });
}

function deriveAutomaticCaptureOperationIdentityForOwnedSource(
  episode: EpisodicNode,
  suppliedDescriptor: AutomaticOperationDescriptorV2,
  allowStoredV4AssistantReference = false,
): AutomaticOperationIdentityV2 {
  const validated = prepareAutomaticEpisodeInput(episode);
  if (
    hasOwn(validated.attributes, WRITE_OWNER_V3_ATTRIBUTE) ||
    hasAutonomousSourceOwnership(validated)
  )
    fail('unsupported_capture_version');
  const owner = (
    allowStoredV4AssistantReference
      ? AutomaticCaptureSourceOwnerStoredV2Schema
      : AutomaticCaptureSourceOwnerV2Schema
  ).parse(validated.attributes[WRITE_OWNER_V2_ATTRIBUTE]);
  const descriptor = AutomaticOperationDescriptorV2Schema.parse(suppliedDescriptor);
  if (
    owner.purpose !== descriptor.purpose ||
    owner.settingsHash !== descriptor.settingsHash ||
    owner.requestedTrustLevel !== descriptor.requestedTrustLevel ||
    owner.intentSetting !== descriptor.intentSetting ||
    canonical(owner.policy) !== canonical(descriptor.policy) ||
    canonical(owner.assistantWriteAuthority) !== canonical(descriptor.assistantWriteAuthority)
  ) {
    fail('invalid_source_owner');
  }
  const sourceAttributes = { ...validated.attributes };
  delete sourceAttributes.engram_extraction_queue_v1;
  const sourceFields = Object.fromEntries(
    Object.entries({ ...validated, attributes: sourceAttributes }).filter(
      ([key]) => key !== 'updated_at',
    ),
  );
  const immutableProducerProvenance = {
    uuid: validated.uuid,
    group_id: validated.group_id,
    content: validated.content,
    role: validated.role,
    source_type: validated.source_type,
    episode_kind: validated.episode_kind,
    reference_time: validated.reference_time,
    previous_episode_uuid: validated.previous_episode_uuid,
    source_message_id: validated.source_message_id,
    idempotency_key: validated.idempotency_key,
    conversation_id: validated.conversation_id,
    sender_id: validated.sender_id,
    source_workflow_id: validated.source_workflow_id,
    source_execution_id: validated.source_execution_id,
    quoted_message_id: validated.quoted_message_id,
    created_at: validated.created_at,
  };
  const requestedAuthorityHash = hashAutomaticCaptureV2({
    lifecycle: owner.lifecycle,
    storeHash: owner.storeHash,
    namespace: owner.namespace,
    issuer: owner.issuer,
    actorReference: owner.actorReference,
    turn: owner.turn,
    role: owner.role,
    purpose: owner.purpose,
    sourceId: validated.uuid,
    sourceContentHash: owner.sourceContentHash,
    stableProducerHash: owner.stableProducerHash,
    eventTimeMode: owner.eventTimeMode,
    eventTimeHash: owner.eventTimeHash,
    settingsHash: owner.settingsHash,
    binding: owner.binding,
  });
  return AutomaticOperationIdentityV2Schema.parse({
    lifecycle: owner.lifecycle,
    storeHash: owner.storeHash,
    namespace: owner.namespace,
    issuer: owner.issuer,
    actorReference: owner.actorReference,
    turn: owner.turn,
    role: owner.role,
    purpose: owner.purpose,
    binding: owner.binding,
    sourceId: validated.uuid,
    sourceHash: sha256(canonical(sourceFields)),
    originalProducerHash: hashAutomaticCaptureV2({
      v2Owner: owner,
      exactV1OwnerOrNull: validated.attributes[WRITE_OWNER_ATTRIBUTE] ?? null,
      exactV1EnvelopeOrNull: validated.attributes[SOURCE_ENVELOPE_ATTRIBUTE] ?? null,
      immutableProducerProvenance,
    }),
    stableProducerHash: owner.stableProducerHash,
    requestedAuthorityHash,
  });
}

/** Derive v2 hashes from a native validated record; this is not a write capability. */
export function automaticCaptureOperationIdentityForOwnedSource(
  episode: EpisodicNode,
  suppliedDescriptor: AutomaticOperationDescriptorV2,
): AutomaticOperationIdentityV2 {
  return deriveAutomaticCaptureOperationIdentityForOwnedSource(episode, suppliedDescriptor);
}

/** Explicit stored-assistant identity DATA. This grants no native invocation or write authority. */
export function autonomousPersonalAssistantOperationIdentityV4(
  episode: EpisodicNode,
  suppliedDescriptor: AutomaticOperationDescriptorV2,
): AutomaticOperationIdentityV2 {
  const owner = AutomaticCaptureSourceOwnerStoredV2Schema.parse(
    episode.attributes[WRITE_OWNER_V2_ATTRIBUTE],
  );
  const descriptor = AutomaticOperationDescriptorV2Schema.parse(suppliedDescriptor);
  if (
    owner.purpose !== 'assistant_final_save' ||
    owner.assistantWriteAuthority.kind !== 'owned_human_turn_v4' ||
    descriptor.purpose !== 'assistant_final_save' ||
    descriptor.assistantWriteAuthority.kind !== 'owned_human_turn_v4'
  )
    fail('unsupported_capture_version');
  return deriveAutomaticCaptureOperationIdentityForOwnedSource(episode, descriptor, true);
}

/** Preserve the original full-source hash after explicitly mutable review/display updates. */
export function reconcileAutomaticCaptureOperationIdentity(
  observed: AutomaticOperationIdentityV2,
  captured: AutomaticOperationIdentityV2,
): AutomaticOperationIdentityV2 | null {
  const immutable = (value: AutomaticOperationIdentityV2) =>
    Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'sourceHash'));
  if (canonical(immutable(observed)) !== canonical(immutable(captured))) return null;
  return AutomaticOperationIdentityV2Schema.parse({ ...observed, sourceHash: captured.sourceHash });
}

/** Reject deletion of an operation source or either adjacent source-chain episode. */
export function assertNoAutomaticOperationChainImpact(
  ledger: AutomaticLedger | undefined,
  episodes: EpisodicNode[],
  deletingSourceIds: string[],
  namespace?: string,
): void {
  if (deletingSourceIds.length === 0) return;
  const deleting = new Set(deletingSourceIds);
  const episodesById = new Map(episodes.map((episode) => [episode.uuid, episode]));
  const deletingPredecessors = new Set(
    episodes
      .filter((episode) => deleting.has(episode.uuid) && episode.previous_episode_uuid)
      .map((episode) => episode.previous_episode_uuid!),
  );
  const protectedSources = episodes.filter(
    (episode) =>
      (namespace === undefined || episode.group_id === namespace) &&
      hasAutonomousSourceOwnership(episode),
  );
  for (const source of protectedSources) {
    if (
      deleting.has(source.uuid) ||
      (source.previous_episode_uuid && deleting.has(source.previous_episode_uuid)) ||
      deletingPredecessors.has(source.uuid)
    )
      fail('source_delete_forbidden');
  }
  for (const operation of ledger?.operations ?? []) {
    if (namespace !== undefined && operation.identity.namespace !== namespace) continue;
    const source = episodesById.get(operation.identity.sourceId);
    if (!source) fail('invalid_source_reference');
    if (
      deleting.has(source.uuid) ||
      (source.previous_episode_uuid && deleting.has(source.previous_episode_uuid)) ||
      deletingPredecessors.has(source.uuid)
    ) {
      fail('source_delete_forbidden');
    }
  }
}

/** Check native ledger source linkage without treating mutable review/trust fields as source identity. */
export function assertAutomaticLedgerSourceIntegrity(
  graph: GraphData,
  codeOwnedCheck?: () => void,
): void {
  const checkedWork = <T>(work: () => T): T => {
    codeOwnedCheck?.();
    let result!: T;
    let failed = false;
    let failure: unknown;
    try {
      result = work();
    } catch (error) {
      failed = true;
      failure = error;
    }
    codeOwnedCheck?.();
    if (failed) throw failure;
    return result;
  };
  const attemptCheckedWork = <T>(
    work: () => T,
  ): { readonly ok: true; readonly value: T } | { readonly ok: false } => {
    codeOwnedCheck?.();
    let value!: T;
    let failed = false;
    try {
      value = work();
    } catch {
      failed = true;
    }
    codeOwnedCheck?.();
    return failed ? { ok: false } : { ok: true, value };
  };

  codeOwnedCheck?.();
  const ledger = graph.automatic_operations_v1 as AutomaticLedger | undefined;
  let hasV4 = false;
  codeOwnedCheck?.();
  for (let index = 0; index < graph.episodes.length; index += 1) {
    codeOwnedCheck?.();
    if (!(index in graph.episodes)) continue;
    const episode = graph.episodes[index]!;
    if (hasAutonomousSourceOwnership(episode)) {
      hasV4 = true;
      break;
    }
  }
  codeOwnedCheck?.();
  if (!hasV4 && ledger) {
    codeOwnedCheck?.();
    for (let index = 0; index < ledger.operations.length; index += 1) {
      codeOwnedCheck?.();
      if (!(index in ledger.operations)) continue;
      const operation = ledger.operations[index]!;
      if (operation.version === 4) {
        hasV4 = true;
        break;
      }
    }
    codeOwnedCheck?.();
  }
  if (hasV4) {
    const identifiers = new Set<string>();
    codeOwnedCheck?.();
    for (const record of graph.entities) {
      codeOwnedCheck?.();
      if (identifiers.has(record.uuid)) fail('duplicate_global_id');
      identifiers.add(record.uuid);
    }
    codeOwnedCheck?.();
    for (const record of graph.edges) {
      codeOwnedCheck?.();
      if (identifiers.has(record.uuid)) fail('duplicate_global_id');
      identifiers.add(record.uuid);
    }
    codeOwnedCheck?.();
    for (const episode of graph.episodes) {
      codeOwnedCheck?.();
      if (identifiers.has(episode.uuid)) fail('duplicate_global_id');
      identifiers.add(episode.uuid);
    }
    codeOwnedCheck?.();
    for (const operation of ledger?.operations ?? []) {
      codeOwnedCheck?.();
      if (identifiers.has(operation.operationId)) fail('duplicate_global_id');
      identifiers.add(operation.operationId);
    }
    codeOwnedCheck?.();
  }
  const episodes = new Map<string, (typeof graph.episodes)[number]>();
  codeOwnedCheck?.();
  for (const episode of graph.episodes) {
    codeOwnedCheck?.();
    episodes.set(episode.uuid, episode);
  }
  codeOwnedCheck?.();
  const entities = new Map<string, (typeof graph.entities)[number]>();
  codeOwnedCheck?.();
  for (const entity of graph.entities) {
    codeOwnedCheck?.();
    entities.set(entity.uuid, entity);
  }
  codeOwnedCheck?.();
  const operationsBySource = new Map<string, StoredAutomaticOperation>();
  codeOwnedCheck?.();
  for (const operation of ledger?.operations ?? []) {
    codeOwnedCheck?.();
    operationsBySource.set(operation.identity.sourceId, operation);
  }
  codeOwnedCheck?.();
  for (const episode of graph.episodes) {
    codeOwnedCheck?.();
    assertKnownEpisodeOwnerVersions(episode.attributes);
    if (hasAutonomousSourceOwnership(episode)) {
      const reconstructed = checkedWork(() => reconstructAutonomousPersonalStoredSourceV4(episode));
      const owner = reconstructed.tuple.owner;
      if (entities.get(owner.binding.subjectId)?.group_id !== owner.namespace)
        fail('invalid_source_reference');
      if (episode.previous_episode_uuid) {
        const previous = episodes.get(episode.previous_episode_uuid);
        if (!previous || previous.group_id !== episode.group_id) fail('invalid_source_reference');
      }
      continue;
    }
    if (
      hasOwn(episode.attributes, WRITE_OWNER_V3_ATTRIBUTE) ||
      hasOwn(episode.attributes, SOURCE_ENVELOPE_V2_ATTRIBUTE)
    ) {
      const tuple = checkedWork(() => validateCompositionalAutomaticSourceTupleV3(episode));
      if (entities.get(tuple.owner.binding.subjectId)?.group_id !== tuple.owner.namespace)
        fail('invalid_source_reference');
      continue;
    }
    if (!hasOwn(episode.attributes, WRITE_OWNER_V2_ATTRIBUTE)) continue;
    checkedWork(() => prepareAutomaticEpisodeInput(episode));
    const owner = checkedWork(() =>
      AutomaticCaptureSourceOwnerStoredV2Schema.parse(episode.attributes[WRITE_OWNER_V2_ATTRIBUTE]),
    );
    if (
      owner.purpose === 'human_turn_memory' &&
      entities.get(owner.binding.subjectId)?.group_id !== owner.namespace
    ) {
      fail('invalid_source_reference');
    }
    if (owner.purpose === 'assistant_final_save') {
      const authority = owner.assistantWriteAuthority;
      const human = operationsBySource.get(authority.sourceId);
      const humanEpisode = episodes.get(authority.sourceId);
      const matchesV4Parent =
        authority.kind === 'owned_human_turn_v4' &&
        authority.parentFamily === 'autonomous-personal-v1' &&
        human?.version === 4 &&
        human.state === 'committed' &&
        human.descriptor.purpose === 'human_turn_memory' &&
        human.identity.role === 'human' &&
        human.identity.purpose === 'human_turn_memory' &&
        human.operationId === authority.parentOperationId &&
        human.identity.storeHash === owner.storeHash &&
        human.identity.namespace === owner.namespace &&
        human.identity.issuer === owner.issuer &&
        human.identity.actorReference === owner.actorReference &&
        human.identity.turn === owner.turn &&
        human.identity.sourceId === authority.sourceId &&
        human.identity.sourceHash === authority.sourceHash &&
        human.identity.descriptorHash === authority.descriptorHash &&
        human.identity.requestedAuthorityHash === authority.requestedAuthorityHash &&
        humanEpisode !== undefined &&
        humanEpisode.role === 'human' &&
        humanEpisode.group_id === owner.namespace &&
        hasAutonomousSourceOwnership(humanEpisode) &&
        (() => {
          const reconstructed = attemptCheckedWork(() => {
            const sourceIdentity = reconstructAutonomousPersonalStoredSourceIdentityV4({
              source: humanEpisode,
              descriptor: human.descriptor,
            });
            return {
              identityMatches:
                canonical(sourceIdentity.tuple.identity) === canonical(human.identity),
              descriptorHash: hashAutonomousPersonalDescriptorV4(human.descriptor),
            };
          });
          const receipt = human.terminalReceipt;
          return (
            reconstructed.ok &&
            reconstructed.value.identityMatches &&
            reconstructed.value.descriptorHash === authority.descriptorHash &&
            (receipt.kind === 'human_autonomous_capture_committed' ||
              receipt.kind === 'human_autonomous_source_deferred_committed' ||
              receipt.kind === 'human_autonomous_source_verdict_committed') &&
            receipt.operationId === authority.parentOperationId &&
            receipt.operationId === human.operationId &&
            receipt.sourceId === authority.sourceId &&
            receipt.sourceHash === authority.sourceHash &&
            receipt.descriptorHash === authority.descriptorHash
          );
        })();
      const matchesV2OrV3Parent =
        authority.kind === 'owned_human_turn' &&
        ((human?.version === 2 &&
          human.identity.purpose === 'human_turn_memory' &&
          human.state === 'committed' &&
          human.terminalReceipt.kind === 'human_capture_committed' &&
          human.identity.storeHash === owner.storeHash &&
          human.identity.namespace === owner.namespace &&
          human.identity.issuer === owner.issuer &&
          human.identity.actorReference === owner.actorReference &&
          human.identity.turn === owner.turn &&
          human.identity.sourceHash === authority.sourceHash &&
          hashAutomaticCaptureV2(human.descriptor) === authority.descriptorHash &&
          human.identity.requestedAuthorityHash === authority.requestedAuthorityHash) ||
          (human?.version === 3 &&
            human.identity.purpose === 'human_turn_memory' &&
            human.state === 'committed' &&
            (human.terminalReceipt.kind === 'human_compositional_capture_committed' ||
              human.terminalReceipt.kind === 'human_compositional_source_verdict_committed') &&
            human.identity.storeHash === owner.storeHash &&
            human.identity.namespace === owner.namespace &&
            human.identity.issuer === owner.issuer &&
            human.identity.actorReference === owner.actorReference &&
            human.identity.turn === owner.turn &&
            human.identity.sourceHash === authority.sourceHash &&
            human.identity.descriptorHash === authority.descriptorHash &&
            human.identity.requestedAuthorityHash === authority.requestedAuthorityHash));
      const matchesCommittedHuman = matchesV4Parent || matchesV2OrV3Parent;
      if (!matchesCommittedHuman) {
        fail('invalid_source_reference');
      }
    }
  }
  codeOwnedCheck?.();
  if (!ledger) return;
  for (const operation of ledger.operations) {
    codeOwnedCheck?.();
    const episode = episodes.get(operation.identity.sourceId);
    if (
      !episode ||
      episode.group_id !== operation.identity.namespace ||
      (operation.identity.role === 'human' && episode.role !== 'human') ||
      (operation.identity.role === 'assistant' && episode.role !== 'ai')
    ) {
      fail('invalid_source_reference');
    }

    if (operation.version === 4) {
      const result = attemptCheckedWork(() => {
        const reconstructed = reconstructAutonomousPersonalStoredSourceIdentityV4({
          source: episode,
          descriptor: operation.descriptor,
        });
        return canonical(reconstructed.tuple.identity) === canonical(operation.identity);
      });
      if (!result.ok || !result.value) {
        fail('invalid_source_owner');
      }
      continue;
    }
    if (operation.version === 3) {
      const result = attemptCheckedWork(() => {
        const observed = reconstructCompositionalAutomaticSourceIdentityV3(
          episode,
          operation.descriptor,
        );
        return Boolean(
          reconcileCompositionalCaptureOperationIdentityV3(observed.identity, operation.identity),
        );
      });
      if (!result.ok || !result.value) {
        fail('invalid_source_owner');
      }
      continue;
    }
    if (operation.version === 2) {
      const result = attemptCheckedWork(() =>
        operation.descriptor.purpose === 'assistant_final_save' &&
        operation.descriptor.assistantWriteAuthority.kind === 'owned_human_turn_v4'
          ? deriveAutomaticCaptureOperationIdentityForOwnedSource(
              episode,
              operation.descriptor,
              true,
            )
          : automaticCaptureOperationIdentityForOwnedSource(episode, operation.descriptor),
      );
      if (!result.ok) {
        fail('invalid_source_owner');
      }
      const observed: AutomaticOperationIdentityV2 = result.value;
      if (!reconcileAutomaticCaptureOperationIdentity(observed, operation.identity))
        fail('invalid_source_owner');
      continue;
    }

    const result = attemptCheckedWork(() => {
      const owner = AutomaticWriteOwnerSchema.parse(episode.attributes[WRITE_OWNER_ATTRIBUTE]);
      const sourceIdentity = automaticOperationIdentityForOwnedSource(episode, owner);
      return { owner, sourceIdentity };
    });
    if (!result.ok) {
      fail('invalid_source_owner');
    }
    const { owner, sourceIdentity } = result.value;
    if (
      operation.identity.storeHash !== owner.store ||
      operation.identity.namespace !== owner.namespace ||
      operation.identity.issuer !== owner.issuer ||
      operation.identity.actorReference !== owner.actor ||
      operation.identity.turn !== owner.turn ||
      operation.identity.role !== owner.role ||
      canonical(operation.identity.binding) !== canonical(owner.binding) ||
      operation.identity.originalProducerHash !== sourceIdentity.originalProducerHash ||
      (operation.descriptor && canonical(operation.descriptor.policy) !== canonical(owner.policy))
    ) {
      fail('invalid_source_owner');
    }
  }
  codeOwnedCheck?.();
}

export function assertAutomaticEpisodeTrustedPath(
  episode: CreateEpisodicNode | EpisodicNode,
  trustedPath: boolean,
): void {
  assertKnownEpisodeOwnerVersions(episode.attributes ?? {});
  // The legacy trusted boolean is never a replay-safe v2 creation capability.
  if (
    hasOwn(episode.attributes, WRITE_OWNER_V2_ATTRIBUTE) ||
    hasOwn(episode.attributes, WRITE_OWNER_V3_ATTRIBUTE) ||
    hasOwn(episode.attributes, SOURCE_ENVELOPE_V2_ATTRIBUTE) ||
    hasAutonomousSourceOwnership(episode)
  )
    fail('trusted_capture_writer_required');
  if (!trustedPath && isOwnedEpisode(episode)) fail('trusted_writer_required');
}

type EpisodeSourceField =
  | 'group_id'
  | 'content'
  | 'role'
  | 'source_type'
  | 'episode_kind'
  | 'source_message_id'
  | 'idempotency_key'
  | 'conversation_id'
  | 'sender_id'
  | 'sender_name'
  | 'source_workflow_id'
  | 'source_execution_id'
  | 'quoted_message_id'
  | 'trust_level'
  | 'confidence';
const EPISODE_REPLAY_FIELDS: EpisodeSourceField[] = [
  'group_id',
  'content',
  'role',
  'source_type',
  'episode_kind',
  'source_message_id',
  'idempotency_key',
  'conversation_id',
  'sender_id',
  'sender_name',
  'source_workflow_id',
  'quoted_message_id',
  'trust_level',
  'confidence',
];
// Redelivery may run in another execution; the original stored execution stays immutable.
// Import invariants are independent so replay's attempt-field exclusions cannot weaken them.
const EPISODE_IMPORT_FIELDS: Array<Exclude<keyof EpisodicNode, 'attributes'>> = [
  'uuid',
  'group_id',
  'content',
  'role',
  'source_type',
  'episode_kind',
  'source_message_id',
  'idempotency_key',
  'conversation_id',
  'sender_id',
  'sender_name',
  'source_workflow_id',
  'source_execution_id',
  'quoted_message_id',
  'trust_level',
  'confidence',
  'review_status',
  'reference_time',
  'previous_episode_uuid',
  'created_at',
  'updated_at',
];

function assertSameEpisodeSource(
  existing: EpisodicNode,
  incoming: CreateEpisodicNode | EpisodicNode,
): void {
  // New-family producer provenance is already separated from delivery attempts.
  // Keep its explicit original execution immutable; legacy replay compatibility
  // retains its independently reviewed exclusion.
  if (
    (hasOwn(existing.attributes, WRITE_OWNER_V3_ATTRIBUTE) ||
      hasAutonomousSourceOwnership(existing)) &&
    existing.source_execution_id !== incoming.source_execution_id
  )
    fail('owned_source_mismatch');
  for (const field of EPISODE_REPLAY_FIELDS) {
    if (canonical(existing[field]) !== canonical(incoming[field])) fail('owned_source_mismatch');
  }
  const incomingAttributes = incoming.attributes ?? {};
  for (const key of PROTECTED_EPISODE_ATTRIBUTES) {
    const incomingHas = hasOwn(incomingAttributes, key);
    const existingHas = hasOwn(existing.attributes, key);
    if (incomingHas !== existingHas) fail('owned_source_mismatch');
    if (incomingHas && canonical(incomingAttributes[key]) !== canonical(existing.attributes[key])) {
      fail('owned_source_mismatch');
    }
  }
}

export function assertOwnedEpisodeReplay(
  existing: EpisodicNode,
  incoming: CreateEpisodicNode | EpisodicNode,
): void {
  const hasExistingOwner = isOwnedEpisode(existing);
  const hasIncomingOwner = isOwnedEpisode(incoming);
  if (!hasExistingOwner && !hasIncomingOwner) return;
  prepareAutomaticEpisodeInput(existing);
  prepareAutomaticEpisodeInput(incoming);
  if (!hasExistingOwner || !hasIncomingOwner) fail('owned_source_mismatch');
  assertSameEpisodeSource(existing, incoming);
}

export function prepareAutomaticEpisodeUpdate<
  T extends { content?: string; attributes?: Record<string, unknown> },
>(existing: EpisodicNode, updates: T): T {
  const hasExistingOwner = isOwnedEpisode(existing);
  assertKnownEpisodeOwnerVersions(updates.attributes ?? {});
  const hasIncomingReserved = PROTECTED_EPISODE_ATTRIBUTES.some((key) =>
    hasOwn(updates.attributes, key),
  );
  if (!hasExistingOwner && hasIncomingReserved) fail('reserved_attribute');
  if (!hasExistingOwner) return updates;
  prepareAutomaticEpisodeInput(existing);
  if (updates.content !== undefined && updates.content !== existing.content)
    fail('owned_source_immutable');
  const attributes = updates.attributes;
  if (!attributes) return updates;
  for (const key of PROTECTED_EPISODE_ATTRIBUTES) {
    if (
      hasOwn(attributes, key) &&
      canonical(attributes[key]) !== canonical(existing.attributes[key])
    ) {
      fail('owned_source_immutable');
    }
  }
  return {
    ...updates,
    attributes: {
      ...attributes,
      ...(hasOwn(existing.attributes, SOURCE_ENVELOPE_ATTRIBUTE)
        ? { [SOURCE_ENVELOPE_ATTRIBUTE]: cloneJson(existing.attributes[SOURCE_ENVELOPE_ATTRIBUTE]) }
        : {}),
      ...(hasOwn(existing.attributes, WRITE_OWNER_ATTRIBUTE)
        ? { [WRITE_OWNER_ATTRIBUTE]: cloneJson(existing.attributes[WRITE_OWNER_ATTRIBUTE]) }
        : {}),
      ...(hasOwn(existing.attributes, WRITE_OWNER_V2_ATTRIBUTE)
        ? { [WRITE_OWNER_V2_ATTRIBUTE]: cloneJson(existing.attributes[WRITE_OWNER_V2_ATTRIBUTE]) }
        : {}),
      ...(hasOwn(existing.attributes, WRITE_OWNER_V3_ATTRIBUTE)
        ? { [WRITE_OWNER_V3_ATTRIBUTE]: cloneJson(existing.attributes[WRITE_OWNER_V3_ATTRIBUTE]) }
        : {}),
      ...(hasOwn(existing.attributes, SOURCE_ENVELOPE_V2_ATTRIBUTE)
        ? {
            [SOURCE_ENVELOPE_V2_ATTRIBUTE]: cloneJson(
              existing.attributes[SOURCE_ENVELOPE_V2_ATTRIBUTE],
            ),
          }
        : {}),
      ...(hasOwn(existing.attributes, WRITE_OWNER_V4_ATTRIBUTE)
        ? { [WRITE_OWNER_V4_ATTRIBUTE]: cloneJson(existing.attributes[WRITE_OWNER_V4_ATTRIBUTE]) }
        : {}),
      ...(hasOwn(existing.attributes, SOURCE_ENVELOPE_V3_ATTRIBUTE)
        ? {
            [SOURCE_ENVELOPE_V3_ATTRIBUTE]: cloneJson(
              existing.attributes[SOURCE_ENVELOPE_V3_ATTRIBUTE],
            ),
          }
        : {}),
    },
  };
}

export function protectAutomaticEpisode(episode: EpisodicNode): EpisodicNode {
  if (!isOwnedEpisode(episode)) return episode;
  prepareAutomaticEpisodeInput(episode);
  return deepFreeze(cloneJson(episode));
}

export function assertAutomaticEpisodeBinding(
  graph: GraphData,
  episode: CreateEpisodicNode | EpisodicNode,
): void {
  const parsed = validateEpisodeProtectedAttributes(episode);
  const attributes = parsed.attributes ?? {};
  if (hasAutonomousSourceOwnership(parsed)) fail('unsupported_capture_version');
  if (hasOwn(attributes, WRITE_OWNER_V3_ATTRIBUTE)) {
    const owner = CompositionalAutomaticCaptureSourceOwnerV3Schema.parse(
      attributes[WRITE_OWNER_V3_ATTRIBUTE],
    );
    assertAutomaticBindingIdentity(
      graph,
      owner.namespace,
      owner.issuer,
      owner.actorReference,
      owner.binding,
    );
    return;
  }
  const envelope = hasOwn(attributes, SOURCE_ENVELOPE_ATTRIBUTE)
    ? (attributes[SOURCE_ENVELOPE_ATTRIBUTE] as AutomaticSourceEnvelope)
    : undefined;
  const owner = hasOwn(attributes, WRITE_OWNER_ATTRIBUTE)
    ? (attributes[WRITE_OWNER_ATTRIBUTE] as AutomaticWriteOwner)
    : undefined;
  if (envelope) assertAutomaticBinding(graph, envelope);
  if (owner?.binding) {
    assertAutomaticBindingIdentity(
      graph,
      owner.namespace,
      owner.issuer,
      owner.actor,
      owner.binding,
    );
  }
}

export function prepareAutomaticImport(incoming: GraphData, existing: GraphData): GraphData {
  allBindings(existing);
  allBindings(incoming);
  const existingEntities = new Map(existing.entities.map((entity) => [entity.uuid, entity]));
  const entities = incoming.entities.map((entity) => {
    const current = existingEntities.get(entity.uuid);
    const incomingHas = hasOwn(entity.attributes, BINDINGS_ATTRIBUTE);
    if (!current) {
      if (incomingHas) fail('binding_restore_unsupported');
      return entity;
    }
    const currentHas = hasOwn(current.attributes, BINDINGS_ATTRIBUTE);
    if (!currentHas) {
      if (incomingHas) fail('binding_restore_unsupported');
      return entity;
    }
    const currentBindings = readEntityBindings(current);
    if (currentBindings.length && entity.group_id !== current.group_id) {
      fail('bound_subject_group_move_forbidden');
    }
    if (
      incomingHas &&
      canonical(entity.attributes[BINDINGS_ATTRIBUTE]) !==
        canonical(current.attributes[BINDINGS_ATTRIBUTE])
    ) {
      fail('binding_metadata_immutable');
    }
    return {
      ...entity,
      attributes: {
        ...entity.attributes,
        [BINDINGS_ATTRIBUTE]: cloneJson(current.attributes[BINDINGS_ATTRIBUTE]),
      },
    };
  });

  const existingEpisodes = new Map(existing.episodes.map((episode) => [episode.uuid, episode]));
  const episodes = incoming.episodes.map((episode) => {
    const validatedIncoming = prepareAutomaticEpisodeInput(episode);
    const current = existingEpisodes.get(episode.uuid);
    if (
      hasOwn(validatedIncoming.attributes, WRITE_OWNER_V2_ATTRIBUTE) ||
      hasOwn(current?.attributes, WRITE_OWNER_V2_ATTRIBUTE) ||
      hasOwn(validatedIncoming.attributes, WRITE_OWNER_V3_ATTRIBUTE) ||
      hasOwn(current?.attributes, WRITE_OWNER_V3_ATTRIBUTE) ||
      hasAutonomousSourceOwnership(validatedIncoming) ||
      (current !== undefined && hasAutonomousSourceOwnership(current))
    ) {
      fail('owned_source_import_forbidden');
    }
    if (!current) {
      if (isOwnedEpisode(validatedIncoming)) fail('owned_source_import_forbidden');
      return protectAutomaticEpisode(validatedIncoming);
    }
    if (!isOwnedEpisode(current)) {
      if (isOwnedEpisode(validatedIncoming)) fail('owned_source_import_forbidden');
      return protectAutomaticEpisode(validatedIncoming);
    }
    prepareAutomaticEpisodeInput(current);
    for (const field of EPISODE_IMPORT_FIELDS) {
      if (canonical(current[field]) !== canonical(validatedIncoming[field]))
        fail('owned_source_import_forbidden');
    }
    for (const key of PROTECTED_EPISODE_ATTRIBUTES) {
      if (
        hasOwn(validatedIncoming.attributes, key) &&
        canonical(validatedIncoming.attributes[key]) !== canonical(current.attributes[key])
      ) {
        fail('owned_source_import_forbidden');
      }
    }
    const attributes = {
      ...validatedIncoming.attributes,
      ...(hasOwn(current.attributes, SOURCE_ENVELOPE_ATTRIBUTE)
        ? {
            [SOURCE_ENVELOPE_ATTRIBUTE]: cloneJson(current.attributes[SOURCE_ENVELOPE_ATTRIBUTE]),
          }
        : {}),
      ...(hasOwn(current.attributes, WRITE_OWNER_ATTRIBUTE)
        ? { [WRITE_OWNER_ATTRIBUTE]: cloneJson(current.attributes[WRITE_OWNER_ATTRIBUTE]) }
        : {}),
    };
    if (canonical(attributes) !== canonical(current.attributes)) {
      fail('owned_source_import_forbidden');
    }
    return protectAutomaticEpisode({ ...validatedIncoming, attributes });
  });
  return { ...incoming, entities, episodes };
}
