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
import { compileAutomaticPolicy } from '../extraction/AutomaticEvidence';

export const BINDINGS_ATTRIBUTE = 'engram_actor_bindings_v1';
export const SOURCE_ENVELOPE_ATTRIBUTE = 'engram_source_envelope_v1';
export const WRITE_OWNER_ATTRIBUTE = 'engram_write_owner_v1';

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
  return (
    hasOwn(episode.attributes, SOURCE_ENVELOPE_ATTRIBUTE) ||
    hasOwn(episode.attributes, WRITE_OWNER_ATTRIBUTE)
  );
}

function policyMatches(value: unknown): boolean {
  return sameCompiledPolicy(value);
}

function validateEpisodeProtectedAttributes<T extends CreateEpisodicNode | EpisodicNode>(
  episode: T,
): T {
  const attributes = episode.attributes ?? {};
  const hasEnvelope = hasOwn(attributes, SOURCE_ENVELOPE_ATTRIBUTE);
  const hasOwner = hasOwn(attributes, WRITE_OWNER_ATTRIBUTE);
  if (!hasEnvelope && !hasOwner) return episode;
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
  return { ...episode, attributes: copiedAttributes };
}

export function prepareAutomaticEpisodeInput<T extends CreateEpisodicNode | EpisodicNode>(
  episode: T,
): T {
  return validateEpisodeProtectedAttributes(episode);
}

export function assertAutomaticEpisodeTrustedPath(
  episode: CreateEpisodicNode | EpisodicNode,
  trustedPath: boolean,
): void {
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
  'source_execution_id',
  'quoted_message_id',
  'trust_level',
  'confidence',
];
const EPISODE_IMPORT_FIELDS: Array<EpisodeSourceField | 'reference_time'> = [
  ...EPISODE_REPLAY_FIELDS,
  'reference_time',
];

function assertSameEpisodeSource(
  existing: EpisodicNode,
  incoming: CreateEpisodicNode | EpisodicNode,
): void {
  for (const field of EPISODE_REPLAY_FIELDS) {
    if (canonical(existing[field]) !== canonical(incoming[field])) fail('owned_source_mismatch');
  }
  const incomingAttributes = incoming.attributes ?? {};
  for (const key of [SOURCE_ENVELOPE_ATTRIBUTE, WRITE_OWNER_ATTRIBUTE]) {
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
  const hasIncomingReserved =
    hasOwn(updates.attributes, SOURCE_ENVELOPE_ATTRIBUTE) ||
    hasOwn(updates.attributes, WRITE_OWNER_ATTRIBUTE);
  if (!hasExistingOwner && hasIncomingReserved) fail('reserved_attribute');
  if (!hasExistingOwner) return updates;
  prepareAutomaticEpisodeInput(existing);
  if (updates.content !== undefined && updates.content !== existing.content)
    fail('owned_source_immutable');
  const attributes = updates.attributes;
  if (!attributes) return updates;
  for (const key of [SOURCE_ENVELOPE_ATTRIBUTE, WRITE_OWNER_ATTRIBUTE]) {
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
    for (const key of [SOURCE_ENVELOPE_ATTRIBUTE, WRITE_OWNER_ATTRIBUTE]) {
      if (
        hasOwn(validatedIncoming.attributes, key) &&
        canonical(validatedIncoming.attributes[key]) !== canonical(current.attributes[key])
      ) {
        fail('owned_source_import_forbidden');
      }
    }
    return protectAutomaticEpisode({
      ...validatedIncoming,
      attributes: {
        ...validatedIncoming.attributes,
        ...(hasOwn(current.attributes, SOURCE_ENVELOPE_ATTRIBUTE)
          ? {
              [SOURCE_ENVELOPE_ATTRIBUTE]: cloneJson(current.attributes[SOURCE_ENVELOPE_ATTRIBUTE]),
            }
          : {}),
        ...(hasOwn(current.attributes, WRITE_OWNER_ATTRIBUTE)
          ? { [WRITE_OWNER_ATTRIBUTE]: cloneJson(current.attributes[WRITE_OWNER_ATTRIBUTE]) }
          : {}),
      },
    });
  });
  return { ...incoming, entities, episodes };
}
