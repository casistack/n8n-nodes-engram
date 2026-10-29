import { createHash } from 'crypto';
import { GraphologyStorage } from '../../../src/storage/GraphologyStorage';
import { Neo4jStorage } from '../../../src/storage/Neo4jStorage';
import {
  applyAutomaticBindingCommand,
  assertAutomaticBinding,
  automaticWriteOwnerIdempotencyKey,
  BINDINGS_ATTRIBUTE,
  findAutomaticBinding,
  prepareAutomaticImport,
  SOURCE_ENVELOPE_ATTRIBUTE,
  WRITE_OWNER_ATTRIBUTE,
} from '../../../src/storage/AutomaticIdentity';
import { captureEnvelope, compileAutomaticPolicy } from '../../../src/extraction/AutomaticEvidence';
import type { AutomaticBindingReference } from '../../../src/schemas/AutomaticMemory.schema';
import type { AutomaticBindingRecord } from '../../../src/schemas/AutomaticOperations.schema';
import type { CreateEpisodicNode, EntityNode, GraphData } from '../../../src/schemas';
import type { AutomaticWriteOwner } from '../../../src/schemas/AutomaticClaim.schema';

const NOW = '2026-10-24T12:00:00.000Z';
const NAMESPACE = 'account-1';
const ISSUER = 'trusted-workflow';
const ACTOR = 'verified-sender-42';
const POLICY = compileAutomaticPolicy({ profileId: 'conservative' });

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function acceptedAttributes(): Record<string, unknown> {
  return {
    engram_extraction: {
      version: 2,
      source: 'manual',
      confidence: null,
      review_status: 'accepted',
      threshold_decision: 'manually_reviewed',
      extracted_at: NOW,
      episode_uuids: [],
      reviewed_at: NOW,
      reviewed_by: 'operator-1',
    },
  };
}

async function addAcceptedSubject(storage: GraphologyStorage, name = 'Ada'): Promise<EntityNode> {
  return storage.addEntity({
    name,
    group_id: NAMESPACE,
    entity_type: 'person',
    attributes: acceptedAttributes(),
  });
}

async function createBinding(
  storage: GraphologyStorage,
  actorReference = ACTOR,
): Promise<{ subject: EntityNode; record: AutomaticBindingRecord }> {
  const subject = await addAcceptedSubject(storage);
  const record = await storage.automaticBindingCommand({
    action: 'create',
    namespace: NAMESPACE,
    issuer: ISSUER,
    actorReference,
    subjectId: subject.uuid,
    authorizedBy: 'operator-1',
    reason: 'Verified sender mapping',
  });
  return { subject, record };
}

function referenceOf(record: AutomaticBindingRecord): AutomaticBindingReference {
  return {
    bindingId: record.bindingId,
    revision: record.revision,
    subjectId: record.subjectId,
    fingerprint: record.fingerprint,
  };
}

function ownedHumanEpisode(
  record: AutomaticBindingRecord,
  options: { turn?: string; content?: string; referenceTime?: string; store?: string } = {},
): CreateEpisodicNode {
  const turn = options.turn ?? 'turn-1';
  const content = options.content ?? 'I prefer bullet points.';
  const reference = referenceOf(record);
  const envelopeResult = captureEnvelope(
    content,
    content,
    { namespace: NAMESPACE, issuer: ISSUER, actorReference: ACTOR },
    reference,
    false,
    POLICY,
  );
  if (!envelopeResult.ok) throw new Error(`Envelope capture failed: ${envelopeResult.reason}`);
  const owner: AutomaticWriteOwner = {
    version: 1,
    store: options.store ?? 'a'.repeat(64),
    namespace: NAMESPACE,
    turn,
    role: 'human',
    actor: ACTOR,
    issuer: ISSUER,
    binding: reference,
    policy: POLICY,
    contentHash: hash(content),
  };
  return {
    group_id: NAMESPACE,
    content,
    role: 'human',
    source_type: 'message',
    reference_time: options.referenceTime ?? NOW,
    source_message_id: `message-${turn}`,
    idempotency_key: automaticWriteOwnerIdempotencyKey(owner),
    conversation_id: 'conversation-1',
    sender_id: 'raw-sender-label',
    sender_name: 'Display label (not identity)',
    episode_kind: 'active_human',
    trust_level: 'trusted',
    review_status: 'accepted',
    attributes: {
      [SOURCE_ENVELOPE_ATTRIBUTE]: envelopeResult.envelope,
      [WRITE_OWNER_ATTRIBUTE]: owner,
    },
  };
}

function graphWithEntity(entity: EntityNode): GraphData {
  return {
    version: '2.0',
    exported_at: NOW,
    entities: [entity],
    edges: [],
    episodes: [],
  };
}

describe('Graphology automatic identity bindings', () => {
  let storage: GraphologyStorage;

  beforeEach(async () => {
    storage = new GraphologyStorage();
    await storage.initialize();
  });

  afterEach(async () => {
    await storage.close();
  });

  it('serializes competing creates and refuses revoked identity reuse', async () => {
    const subject = await addAcceptedSubject(storage);
    const command = {
      action: 'create' as const,
      namespace: NAMESPACE,
      issuer: ISSUER,
      actorReference: ACTOR,
      subjectId: subject.uuid,
      authorizedBy: 'operator-1',
      reason: 'Verified sender mapping',
    };
    const results = await Promise.allSettled([
      storage.automaticBindingCommand(command),
      storage.automaticBindingCommand(command),
    ]);
    expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((item) => item.status === 'rejected')).toHaveLength(1);
    const created = findAutomaticBinding(await storage.exportGraph(), NAMESPACE, ISSUER, ACTOR)!;
    expect(created.state).toBe('active');

    const revoked = await storage.automaticBindingCommand({
      action: 'revoke',
      namespace: NAMESPACE,
      bindingId: created.bindingId,
      expectedRevision: created.revision,
      authorizedBy: 'operator-1',
      reason: 'Sender access ended',
    });
    expect(revoked.state).toBe('revoked');
    await expect(storage.automaticBindingCommand(command)).rejects.toThrow('duplicate_binding');
    await expect(
      storage.automaticBindingCommand({
        action: 'reassign',
        namespace: NAMESPACE,
        bindingId: created.bindingId,
        expectedRevision: created.revision,
        subjectId: subject.uuid,
        authorizedBy: 'operator-1',
        reason: 'Stale revision attempt',
      }),
    ).rejects.toThrow('binding_changed');
  });

  it('enforces 32 bindings per subject and a fixed 20-entry audit cap', async () => {
    const subjectA = await addAcceptedSubject(storage, 'Ada');
    for (let index = 0; index < 32; index += 1) {
      await storage.automaticBindingCommand({
        action: 'create',
        namespace: NAMESPACE,
        issuer: ISSUER,
        actorReference: `sender-${index}`,
        subjectId: subjectA.uuid,
        authorizedBy: 'operator-1',
        reason: 'Verified sender mapping',
      });
    }
    await expect(
      storage.automaticBindingCommand({
        action: 'create',
        namespace: NAMESPACE,
        issuer: ISSUER,
        actorReference: 'sender-over-cap',
        subjectId: subjectA.uuid,
        authorizedBy: 'operator-1',
        reason: 'Verified sender mapping',
      }),
    ).rejects.toThrow('binding_capacity');

    const subjectAuditA = await addAcceptedSubject(storage, 'Audit A');
    const subjectAuditB = await addAcceptedSubject(storage, 'Audit B');
    const created = await storage.automaticBindingCommand({
      action: 'create',
      namespace: NAMESPACE,
      issuer: ISSUER,
      actorReference: 'audit-cap-sender',
      subjectId: subjectAuditA.uuid,
      authorizedBy: 'operator-1',
      reason: 'Verified sender mapping',
    });
    let latest = created;
    for (let index = 0; index < 19; index += 1) {
      latest = await storage.automaticBindingCommand({
        action: 'reassign',
        namespace: NAMESPACE,
        bindingId: latest.bindingId,
        expectedRevision: latest.revision,
        subjectId: index % 2 === 0 ? subjectAuditB.uuid : subjectAuditA.uuid,
        authorizedBy: 'operator-1',
        reason: `Reassignment ${index + 1}`,
      });
    }
    expect(latest.audit).toHaveLength(20);
    await expect(
      storage.automaticBindingCommand({
        action: 'reassign',
        namespace: NAMESPACE,
        bindingId: latest.bindingId,
        expectedRevision: latest.revision,
        subjectId: subjectAuditA.uuid,
        authorizedBy: 'operator-1',
        reason: 'Audit cap reached',
      }),
    ).rejects.toThrow('audit_capacity');
  });

  it('requires an accepted subject and rejects stale or forged references', async () => {
    const subject = await storage.addEntity({
      name: 'Unreviewed',
      group_id: NAMESPACE,
      entity_type: 'person',
    });
    await expect(
      storage.automaticBindingCommand({
        action: 'create',
        namespace: NAMESPACE,
        issuer: ISSUER,
        actorReference: ACTOR,
        subjectId: subject.uuid,
        authorizedBy: 'operator-1',
        reason: 'Unreviewed subject',
      }),
    ).rejects.toThrow('subject_not_accepted');

    const { record } = await createBinding(storage);
    const content = 'I prefer bullet points.';
    const envelopeResult = captureEnvelope(
      content,
      content,
      { namespace: NAMESPACE, issuer: ISSUER, actorReference: ACTOR },
      referenceOf(record),
      false,
      POLICY,
    );
    if (!envelopeResult.ok) throw new Error(envelopeResult.reason);
    const graph = await storage.exportGraph();
    expect(assertAutomaticBinding(graph, envelopeResult.envelope).uuid).toBe(record.subjectId);
    expect(() =>
      assertAutomaticBinding(graph, {
        ...envelopeResult.envelope,
        bindingRef: { ...envelopeResult.envelope.bindingRef, revision: record.revision + 1 },
      }),
    ).toThrow('binding_changed');
  });

  it('allows revoking or reassigning after the source subject loses accepted status', async () => {
    const { subject, record: revokeRecord } = await createBinding(storage, 'revoke-after-review');
    const reassignRecord = await storage.automaticBindingCommand({
      action: 'create',
      namespace: NAMESPACE,
      issuer: ISSUER,
      actorReference: 'reassign-after-review',
      subjectId: subject.uuid,
      authorizedBy: 'operator-1',
      reason: 'Verified sender mapping',
    });
    const target = await addAcceptedSubject(storage, 'Accepted target');
    const unacceptedTarget = await storage.addEntity({
      name: 'Unaccepted target',
      group_id: NAMESPACE,
      entity_type: 'person',
    });
    const rejectedAttributes = {
      ...subject.attributes,
      engram_extraction: {
        ...(subject.attributes.engram_extraction as Record<string, unknown>),
        review_status: 'rejected',
      },
    };
    await storage.updateEntity(subject.uuid, { attributes: rejectedAttributes });

    await expect(
      storage.automaticBindingCommand({
        action: 'reassign',
        namespace: NAMESPACE,
        bindingId: reassignRecord.bindingId,
        expectedRevision: reassignRecord.revision,
        subjectId: unacceptedTarget.uuid,
        authorizedBy: 'operator-1',
        reason: 'Attempt to assign to unreviewed target',
      }),
    ).rejects.toThrow('subject_not_accepted');
    const revoked = await storage.automaticBindingCommand({
      action: 'revoke',
      namespace: NAMESPACE,
      bindingId: revokeRecord.bindingId,
      expectedRevision: revokeRecord.revision,
      authorizedBy: 'operator-1',
      reason: 'Revoke after source review changed',
    });
    expect(revoked.state).toBe('revoked');

    const reassigned = await storage.automaticBindingCommand({
      action: 'reassign',
      namespace: NAMESPACE,
      bindingId: reassignRecord.bindingId,
      expectedRevision: reassignRecord.revision,
      subjectId: target.uuid,
      authorizedBy: 'operator-1',
      reason: 'Move to accepted target',
    });
    expect(reassigned.subjectId).toBe(target.uuid);
    expect(reassigned.state).toBe('active');
  });

  it('honors cooperative cancellation while scanning entities and bindings', async () => {
    const { record } = await createBinding(storage);
    const graph = await storage.exportGraph();
    let checks = 0;
    expect(() =>
      findAutomaticBinding(graph, NAMESPACE, ISSUER, ACTOR, () => {
        checks += 1;
        if (checks === 2) throw new Error('deadline exceeded');
      }),
    ).toThrow('deadline exceeded');
    expect(checks).toBe(2);
    expect(findAutomaticBinding(graph, NAMESPACE, ISSUER, ACTOR)?.bindingId).toBe(record.bindingId);
  });

  it('stops iterating incident edges when the bounded lookup reaches its cap', async () => {
    const source = await storage.addEntity({
      name: 'High degree source',
      group_id: NAMESPACE,
      entity_type: 'person',
    });
    const target = await storage.addEntity({
      name: 'High degree target',
      group_id: NAMESPACE,
      entity_type: 'person',
    });
    for (let index = 0; index < 300; index += 1) {
      const forward = index % 2 === 0;
      await storage.addEdge({
        group_id: NAMESPACE,
        source_node_uuid: forward ? source.uuid : target.uuid,
        target_node_uuid: forward ? target.uuid : source.uuid,
        name: 'RELATED',
        fact: `Synthetic high-degree edge ${index}`,
      });
    }

    type Entry = {
      attributes: { type: string; data?: unknown };
      source: string;
      target: string;
    };
    const graph = (
      storage as unknown as {
        graph: { edgeEntries: (node: string) => IterableIterator<Entry> };
      }
    ).graph;
    const original = graph.edgeEntries.bind(graph);
    let visited = 0;
    const iteratorSpy = jest.spyOn(graph, 'edgeEntries').mockImplementation((node) => {
      const entries = original(node);
      return (function* () {
        for (const entry of entries) {
          visited += 1;
          yield entry;
        }
      })();
    });

    try {
      const bounded = await storage.getEdgesBetween(source.uuid, target.uuid, 129);
      expect(bounded).toHaveLength(129);
      expect(visited).toBe(129);
    } finally {
      iteratorSpy.mockRestore();
    }
  });

  it('prevents generic writes, updates, imports, and reads from changing or exposing binding records', async () => {
    const { subject, record } = await createBinding(storage);
    await expect(
      storage.addEntity({
        name: 'Forged',
        group_id: NAMESPACE,
        attributes: { [BINDINGS_ATTRIBUTE]: [record] },
      }),
    ).rejects.toThrow('reserved_attribute');
    await expect(storage.updateEntity(subject.uuid, { group_id: 'other-group' })).rejects.toThrow(
      'bound_subject_group_move_forbidden',
    );
    await expect(
      storage.updateEntity(subject.uuid, {
        attributes: { ...subject.attributes, [BINDINGS_ATTRIBUTE]: [] },
      }),
    ).rejects.toThrow('reserved_attribute');
    await expect(storage.deleteEntity(subject.uuid)).rejects.toThrow(
      'bound_subject_delete_forbidden',
    );

    const fetched = (await storage.getEntity(subject.uuid))!;
    expect(Object.isFrozen(fetched)).toBe(true);
    expect(Object.isFrozen(fetched.attributes)).toBe(true);
    const before = JSON.stringify(fetched.attributes[BINDINGS_ATTRIBUTE]);
    Reflect.set(
      (fetched.attributes[BINDINGS_ATTRIBUTE] as unknown[])[0] as object,
      'state',
      'revoked',
    );
    expect(
      JSON.stringify((await storage.getEntity(subject.uuid))!.attributes[BINDINGS_ATTRIBUTE]),
    ).toBe(before);

    const graph = JSON.parse(JSON.stringify(await storage.exportGraph())) as GraphData;
    const tampered = graph.entities[0];
    const invalid = tampered.attributes[BINDINGS_ATTRIBUTE] as AutomaticBindingRecord[];
    invalid[0].fingerprint = 'f'.repeat(64);
    expect(() => findAutomaticBinding(graph, NAMESPACE, ISSUER, ACTOR)).toThrow(
      'invalid_binding_metadata',
    );

    const validGraph = JSON.parse(JSON.stringify(await storage.exportGraph())) as GraphData;
    applyAutomaticBindingCommand(
      validGraph,
      {
        action: 'revoke',
        namespace: NAMESPACE,
        bindingId: record.bindingId,
        expectedRevision: record.revision,
        authorizedBy: 'operator-1',
        reason: 'Import mismatch fixture',
      },
      record.bindingId,
      NOW,
    );
    await expect(storage.importGraph(validGraph)).rejects.toThrow('binding_metadata_immutable');

    const restored = new GraphologyStorage();
    await restored.initialize();
    await expect(restored.importGraph(await storage.exportGraph())).rejects.toThrow(
      'binding_restore_unsupported',
    );
    await restored.close();
  });
});

describe('owned automatic source episodes', () => {
  let storage: GraphologyStorage;

  beforeEach(async () => {
    storage = new GraphologyStorage();
    await storage.initialize();
  });

  afterEach(async () => {
    await storage.close();
  });

  it.each(['human', 'assistant'] as const)(
    'reuses an owned %s event across executions while preserving strict import provenance',
    async (role) => {
      const { record } = await createBinding(storage);
      const input = ownedHumanEpisode(record);
      input.source_workflow_id = 'synthetic-producer';
      input.source_execution_id = 'synthetic-attempt-one';
      if (role === 'assistant') {
        const content = 'Synthetic final response.';
        const owner = {
          ...(input.attributes![WRITE_OWNER_ATTRIBUTE] as AutomaticWriteOwner),
          role: 'assistant' as const,
          contentHash: hash(content),
        };
        input.role = 'ai';
        input.content = content;
        input.episode_kind = 'assistant_reply';
        input.sender_id = null;
        input.sender_name = null;
        input.idempotency_key = automaticWriteOwnerIdempotencyKey(owner);
        input.attributes = { [WRITE_OWNER_ATTRIBUTE]: owner };
      }
      const first = (await storage.appendAutomaticEpisodes([input]))[0];
      const original = JSON.parse(JSON.stringify(first.episode));
      const replay = (
        await storage.appendAutomaticEpisodes([
          { ...input, source_execution_id: 'synthetic-attempt-two' },
        ])
      )[0];
      expect(replay.created).toBe(false);
      expect(replay.episode).toEqual(original);
      expect(replay.episode.source_execution_id).toBe('synthetic-attempt-one');
      expect((await storage.exportGraph()).episodes).toHaveLength(1);

      const graph = await storage.exportGraph();
      const changed = JSON.parse(JSON.stringify(graph)) as GraphData;
      changed.episodes[0].source_execution_id = 'synthetic-attempt-two';
      expect(() => prepareAutomaticImport(changed, graph)).toThrow('owned_source_import_forbidden');
    },
  );

  it('uses the typed path, verifies the binding in-lock, and keeps exact retries idempotent', async () => {
    const { record } = await createBinding(storage);
    const input = ownedHumanEpisode(record);
    await expect(storage.appendEpisode(input)).rejects.toThrow('trusted_writer_required');

    const appended = await storage.appendAutomaticEpisodes([input]);
    expect(appended[0].created).toBe(true);
    expect(Object.isFrozen(appended[0].episode)).toBe(true);
    const source = (await storage.getEpisode(appended[0].episode.uuid))!;
    expect(Object.isFrozen(source.attributes[WRITE_OWNER_ATTRIBUTE])).toBe(true);

    const retry = await storage.appendAutomaticEpisodes([
      { ...input, reference_time: '2026-10-25T12:00:00.000Z' },
    ]);
    expect(retry[0].created).toBe(false);
    expect(retry[0].episode.reference_time).toBe(NOW);

    const changedOwner = {
      ...(input.attributes?.[WRITE_OWNER_ATTRIBUTE] as AutomaticWriteOwner),
      store: 'b'.repeat(64),
    };
    await expect(
      storage.appendAutomaticEpisodes([
        { ...input, attributes: { ...input.attributes, [WRITE_OWNER_ATTRIBUTE]: changedOwner } },
      ]),
    ).rejects.toThrow('owned_source_mismatch');
    await expect(
      storage.updateEpisode(source.uuid, { content: 'I prefer tables.' }),
    ).rejects.toThrow('owned_source_immutable');

    const fetched = (await storage.getEpisode(source.uuid))!;
    const before = JSON.stringify(fetched.attributes[WRITE_OWNER_ATTRIBUTE]);
    Reflect.set(fetched.attributes[WRITE_OWNER_ATTRIBUTE] as object, 'actor', 'forged-sender');
    expect(
      JSON.stringify((await storage.getEpisode(source.uuid))!.attributes[WRITE_OWNER_ATTRIBUTE]),
    ).toBe(before);

    const emptyGraph: GraphData = {
      version: '2.0',
      exported_at: NOW,
      entities: [],
      edges: [],
      episodes: [],
    };
    expect(() => prepareAutomaticImport({ ...emptyGraph, episodes: [source] }, emptyGraph)).toThrow(
      'owned_source_import_forbidden',
    );
  });

  it('checks attested raw wrappers and allows unbound human ownership only without an envelope', async () => {
    const { record } = await createBinding(storage);
    const wrappedInput = ownedHumanEpisode(record, { turn: 'wrapped-turn' });
    const humanContent = wrappedInput.content;
    const rawContent = `User message: ${humanContent}\nRendered by application`;
    const rawStart = rawContent.indexOf(humanContent);
    const rawEnd = rawStart + humanContent.length;
    const captured = captureEnvelope(
      humanContent,
      rawContent,
      {
        namespace: NAMESPACE,
        issuer: ISSUER,
        actorReference: ACTOR,
        applicationOwnedWrapper: true,
        humanRegion: { start: rawStart, end: rawEnd },
      },
      referenceOf(record),
      false,
      POLICY,
    );
    if (!captured.ok) throw new Error(captured.reason);
    const originalOwner = wrappedInput.attributes![WRITE_OWNER_ATTRIBUTE] as AutomaticWriteOwner;
    wrappedInput.content = rawContent;
    wrappedInput.attributes![SOURCE_ENVELOPE_ATTRIBUTE] = captured.envelope;
    wrappedInput.attributes![WRITE_OWNER_ATTRIBUTE] = {
      ...originalOwner,
      contentHash: hash(rawContent),
    };
    const wrappedResult = await storage.appendAutomaticEpisodes([wrappedInput]);
    expect(wrappedResult[0].created).toBe(true);
    expect(captured.envelope.rawContentHash).toBe(hash(rawContent));
    expect(wrappedResult[0].episode.sender_id).not.toBe(ACTOR);

    const unboundInput = ownedHumanEpisode(record, { turn: 'unbound-turn' });
    const unboundOwner = unboundInput.attributes![WRITE_OWNER_ATTRIBUTE] as AutomaticWriteOwner;
    delete unboundInput.attributes![SOURCE_ENVELOPE_ATTRIBUTE];
    unboundInput.attributes![WRITE_OWNER_ATTRIBUTE] = { ...unboundOwner, binding: null };
    const unboundResult = await storage.appendAutomaticEpisodes([unboundInput]);
    expect(unboundResult[0].created).toBe(true);

    const invalidPair = ownedHumanEpisode(record, { turn: 'invalid-null-binding-turn' });
    const invalidOwner = invalidPair.attributes![WRITE_OWNER_ATTRIBUTE] as AutomaticWriteOwner;
    invalidPair.attributes![WRITE_OWNER_ATTRIBUTE] = { ...invalidOwner, binding: null };
    await expect(storage.appendAutomaticEpisodes([invalidPair])).rejects.toThrow(
      'invalid_write_owner',
    );
  });

  it('rejects an owned source when its current binding was revoked', async () => {
    const { record } = await createBinding(storage);
    const input = ownedHumanEpisode(record);
    await storage.automaticBindingCommand({
      action: 'revoke',
      namespace: NAMESPACE,
      bindingId: record.bindingId,
      expectedRevision: record.revision,
      authorizedBy: 'operator-1',
      reason: 'Revoked before capture commit',
    });
    await expect(storage.appendAutomaticEpisodes([input])).rejects.toThrow('binding_revoked');
  });
});

describe('Neo4j automatic identity transaction wiring', () => {
  const entity: EntityNode = {
    uuid: '913da84d-ec2c-4c1f-8d4b-a49829887d3e',
    name: 'Ada',
    group_id: NAMESPACE,
    summary: '',
    entity_type: 'person',
    name_embedding: null,
    attributes: acceptedAttributes(),
    created_at: NOW,
    updated_at: NOW,
  };

  it('places the bounded Neo4j edge limit after both direction matches and preserves the unbounded query', async () => {
    const storage = new Neo4jStorage('bolt://localhost:7687', 'neo4j', 'unused');
    const internals = storage as unknown as {
      getSession: () => {
        executeRead: (
          work: (tx: {
            run: (
              query: string,
              params?: Record<string, unknown>,
            ) => Promise<{ records: unknown[] }>;
          }) => Promise<unknown>,
        ) => Promise<unknown>;
        close: () => Promise<void>;
      };
    };
    const queries: Array<{ query: string; params?: Record<string, unknown> }> = [];
    internals.getSession = () => ({
      executeRead: async (work) =>
        work({
          run: async (query, params) => {
            queries.push({ query, params });
            return { records: [] };
          },
        }),
      close: async () => {},
    });

    await storage.getEdgesBetween(entity.uuid, 'b48dd694-49d2-4113-94a1-c667c996f50f', 129);
    const limited = queries[0];
    expect(limited.query).toMatch(/CALL\s*\{[\s\S]*UNION[\s\S]*\}\s*RETURN r\s*LIMIT \$limit/);
    expect(limited.query.match(/MATCH \(s:Entity/g)).toHaveLength(2);
    expect((limited.params?.limit as { toNumber: () => number }).toNumber()).toBe(129);

    await storage.getEdgesBetween(entity.uuid, 'b48dd694-49d2-4113-94a1-c667c996f50f');
    expect(queries[1].query).not.toContain('CALL {');
    expect(queries[1].query).not.toContain('LIMIT $limit');
  });

  it('takes the common writer lock before reads/writes and keeps command IDs stable across callback retries', async () => {
    const storage = new Neo4jStorage('bolt://localhost:7687', 'neo4j', 'unused');
    const internals = storage as unknown as {
      initialized: boolean;
      getSession: () => {
        executeWrite: (
          work: (tx: {
            run: (
              query: string,
              params?: Record<string, unknown>,
            ) => Promise<{ records: unknown[] }>;
          }) => Promise<unknown>,
        ) => Promise<unknown>;
        close: () => Promise<void>;
      };
    };
    internals.initialized = true;
    const attempts: string[][] = [];
    const writeIds: string[] = [];
    internals.getSession = () => ({
      executeWrite: async (work) => {
        let output: unknown;
        for (let retry = 0; retry < 2; retry += 1) {
          const events: string[] = [];
          attempts.push(events);
          const tx = {
            run: async (query: string, params: Record<string, unknown> = {}) => {
              events.push(query);
              if (query.includes('RETURN lock.autonomous_source_format_v4 AS format'))
                return { records: [{ get: () => null }] };
              if (query.includes('SET e += $props')) {
                const props = params.props as Record<string, unknown>;
                const storedAttributes = JSON.parse(props.attributes as string) as Record<
                  string,
                  unknown
                >;
                const stored = storedAttributes[BINDINGS_ATTRIBUTE] as AutomaticBindingRecord[];
                writeIds.push(stored[0].bindingId);
                return { records: [] };
              }
              if (query.includes('RETURN e LIMIT 100001')) {
                return {
                  records: [
                    {
                      get: () => ({
                        properties: { ...entity, attributes: JSON.stringify(entity.attributes) },
                      }),
                    },
                  ],
                };
              }
              return { records: [] };
            },
          };
          output = await work(tx);
        }
        return output;
      },
      close: async () => {},
    });

    const result = await storage.automaticBindingCommand({
      action: 'create',
      namespace: NAMESPACE,
      issuer: ISSUER,
      actorReference: ACTOR,
      subjectId: entity.uuid,
      authorizedBy: 'operator-1',
      reason: 'Verified sender mapping',
    });
    expect(result.bindingId).toBeDefined();
    expect(writeIds).toEqual([result.bindingId, result.bindingId]);
    expect(attempts).toHaveLength(2);
    for (const events of attempts) {
      expect(events[0]).toContain("MERGE (lock:EngramStoreLock {id: 'extraction-v1'})");
      const formatIndexes = events
        .map((query, index) =>
          query.includes('RETURN lock.autonomous_source_format_v4 AS format') ? index : -1,
        )
        .filter((index) => index >= 0);
      expect(formatIndexes).toHaveLength(3);
      expect(formatIndexes[0]).toBe(1);
      const readIndex = events.findIndex((query) => query.includes('RETURN e LIMIT 100001'));
      const writeIndex = events.findIndex((query) => query.includes('SET e += $props'));
      expect(readIndex).toBeGreaterThan(formatIndexes[0]);
      expect(formatIndexes[1]).toBeGreaterThan(formatIndexes[0]);
      expect(formatIndexes[1]).toBeLessThan(readIndex);
      expect(writeIndex).toBeGreaterThan(readIndex);
      expect(formatIndexes[2]).toBeGreaterThan(writeIndex);
      expect(events.some((query) => query.includes('episode_char_total'))).toBe(false);
      expect(events.some((query) => query.includes('RETURN ep.attributes AS attributes'))).toBe(
        false,
      );
    }
  });

  it('keeps binding metadata during generic attribute updates and rejects attempts to replace it', async () => {
    const storage = new Neo4jStorage('bolt://localhost:7687', 'neo4j', 'unused');
    const existingGraph = graphWithEntity(entity);
    const record = applyAutomaticBindingCommand(
      existingGraph,
      {
        action: 'create',
        namespace: NAMESPACE,
        issuer: ISSUER,
        actorReference: ACTOR,
        subjectId: entity.uuid,
        authorizedBy: 'operator-1',
        reason: 'Verified sender mapping',
      },
      'f61ef62c-6fe1-40c6-a95a-00ea405e1e6c',
      NOW,
    );
    const boundEntity = existingGraph.entities[0];
    const internals = storage as unknown as {
      initialized: boolean;
      getSession: () => {
        executeWrite: (
          work: (tx: {
            run: (
              query: string,
              params?: Record<string, unknown>,
            ) => Promise<{ records: unknown[] }>;
          }) => Promise<unknown>,
        ) => Promise<unknown>;
        close: () => Promise<void>;
      };
    };
    internals.initialized = true;
    let storedAttributes = JSON.stringify(boundEntity.attributes);
    let updateParams: Record<string, unknown> | undefined;
    const transactions: string[][] = [];
    internals.getSession = () => ({
      executeWrite: async (work) => {
        const events: string[] = [];
        transactions.push(events);
        const tx = {
          run: async (query: string, params: Record<string, unknown> = {}) => {
            events.push(query);
            if (query.includes('RETURN lock.autonomous_source_format_v4 AS format'))
              return { records: [{ get: () => null }] };
            if (query.includes('RETURN e') && query.includes('uuid:$uuid')) {
              return {
                records: [
                  { get: () => ({ properties: { ...boundEntity, attributes: storedAttributes } }) },
                ],
              };
            }
            if (query.includes('SET e.updated_at')) {
              updateParams = params;
              storedAttributes = params.attributes as string;
              return {
                records: [
                  { get: () => ({ properties: { ...boundEntity, attributes: storedAttributes } }) },
                ],
              };
            }
            return { records: [] };
          },
        };
        return work(tx);
      },
      close: async () => {},
    });

    const updated = await storage.updateEntity(entity.uuid, { attributes: { label: 'profile' } });
    const firstTransaction = transactions[0];
    const formatIndexes = firstTransaction
      .map((query, index) =>
        query.includes('RETURN lock.autonomous_source_format_v4 AS format') ? index : -1,
      )
      .filter((index) => index >= 0);
    const readIndex = firstTransaction.findIndex(
      (query) => query.includes('RETURN e') && query.includes('uuid:$uuid'),
    );
    const writeIndex = firstTransaction.findIndex((query) => query.includes('SET e.updated_at'));
    expect(firstTransaction[0]).toContain("MERGE (lock:EngramStoreLock {id: 'extraction-v1'})");
    expect(formatIndexes).toHaveLength(2);
    expect(formatIndexes[0]).toBe(1);
    expect(readIndex).toBeGreaterThan(formatIndexes[0]);
    expect(writeIndex).toBeGreaterThan(readIndex);
    expect(formatIndexes[1]).toBeGreaterThan(writeIndex);
    expect(firstTransaction.some((query) => query.includes('episode_char_total'))).toBe(false);
    expect(JSON.parse(updateParams!.attributes as string)[BINDINGS_ATTRIBUTE]).toEqual(
      boundEntity.attributes[BINDINGS_ATTRIBUTE],
    );
    expect(updated.attributes[BINDINGS_ATTRIBUTE]).toEqual(
      boundEntity.attributes[BINDINGS_ATTRIBUTE],
    );
    expect(record.bindingId).toBe(
      (updated.attributes[BINDINGS_ATTRIBUTE] as AutomaticBindingRecord[])[0].bindingId,
    );

    await expect(
      storage.updateEntity(entity.uuid, {
        attributes: {
          ...updated.attributes,
          [BINDINGS_ATTRIBUTE]: [],
        },
      }),
    ).rejects.toThrow('reserved_attribute');
  });
});
