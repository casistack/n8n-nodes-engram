import { randomUUID } from 'crypto';
import { makeHumanFixture } from '../../helpers/automaticCommittedFixture';
import {
  makeAssistantIntentForCompositionalParent,
  makeCompositionalAssistantHumanParentFixture,
} from '../../helpers/compositionalAssistantParentFixture';
import {
  AutomaticAssistantCaptureIntentV2Schema,
  type AutomaticAssistantCaptureIntentV2,
} from '../../../src/schemas/AutomaticAssistantCapture.schema';
import { GraphDataSchema } from '../../../src/schemas';
import {
  AutomaticCaptureSourceOwnerV2Schema,
  hashAutomaticCaptureV2,
} from '../../../src/schemas/AutomaticCapture.schema';
import { AutomaticCaptureOperationV2Schema } from '../../../src/schemas/AutomaticCaptureOperation.schema';
import { assertAutomaticLedgerSourceIntegrity } from '../../../src/storage/AutomaticIdentity';
import { AutomaticCaptureTerminalReceiptV2Schema } from '../../../src/schemas/AutomaticCaptureReceipt.schema';
import {
  CompositionalAutomaticCaptureOperationV3Schema,
  CompositionalAutomaticCaptureTerminalReceiptV3Schema,
} from '../../../src/schemas/CompositionalAutomaticCaptureV3.schema';
import * as automaticCaptureCapacity from '../../../src/storage/AutomaticCaptureCapacity';
import {
  createAutomaticCaptureHandleRegistry,
  type PrivateOneUseAutomaticLeaseHandle,
} from '../../../src/storage/AutomaticCaptureHandles';
import {
  buildAssistantCaptureDescriptorV2,
  buildAssistantCaptureSourceV2,
  createAutomaticAssistantCaptureAuthorizationRegistry,
  prepareAssistantCaptureBeginV2,
  prepareAssistantFinalCompletionV2,
  readAutomaticAssistantCaptureReplayV2,
  type PrivateAutomaticAssistantWriteAuthorizationV2,
} from '../../../src/storage/AutomaticAssistantCapture';
import {
  applyAutomaticBindingCommand,
  WRITE_OWNER_V2_ATTRIBUTE,
} from '../../../src/storage/AutomaticIdentity';

const NOW = '2026-10-25T13:00:00.000Z';

function makeIntent(
  parent: ReturnType<typeof makeHumanFixture>,
  overrides: Partial<AutomaticAssistantCaptureIntentV2> = {},
): AutomaticAssistantCaptureIntentV2 {
  const humanOwner = AutomaticAssistantCaptureIntentV2Schema.parse({
    version: 2,
    lifecycle: 'replaySafeV2',
    purpose: 'assistant_final_save',
    humanTurn: {
      namespace: parent.human.group_id,
      issuer: parent.humanIdentity.issuer,
      actorReference: parent.humanIdentity.actorReference,
      turn: parent.humanIdentity.turn,
      input: {
        content: parent.human.content,
        applicationOwnedWrapper: null,
        humanRegion: null,
        quoteRegions: [],
      },
    },
    finalAssistant: {
      content: 'The requested final answer.',
      sourceMessageId: 'synthetic-assistant-message',
      conversationId: 'synthetic-conversation',
      senderId: 'synthetic-assistant',
      senderName: 'Synthetic assistant',
      sourceWorkflowId: 'synthetic-producer',
      originalSourceExecutionId: 'synthetic-final-execution',
      sourceType: 'message',
      quotedMessageId: null,
      eventTime: { mode: 'first_capture' },
    },
    attemptIdHash: 'a'.repeat(64),
    invocationDeadlineMs: 30_000,
    ...overrides,
  });
  return humanOwner;
}

function authorize(
  parent = makeHumanFixture(),
  intent = makeIntent(parent),
  handleRegistry = createAutomaticCaptureHandleRegistry(),
) {
  const registry = createAutomaticAssistantCaptureAuthorizationRegistry(handleRegistry);
  const authorization = registry.authorize(intent, parent.graph, {
    storeHash: parent.humanIdentity.storeHash,
  });
  return { parent, intent, handleRegistry, registry, authorization };
}

function consumedAuthorization(
  parent = makeHumanFixture(),
  intent = makeIntent(parent),
  handleRegistry = createAutomaticCaptureHandleRegistry(),
) {
  const result = authorize(parent, intent, handleRegistry);
  if (!result.authorization) throw new Error('Expected a synthetic assistant authorization');
  const consumed = result.registry.consumeForBegin(result.authorization, intent);
  return { ...result, consumed };
}

function begin(setup = consumedAuthorization(), backendNow = NOW) {
  const scope = setup.handleRegistry.startBegin<'assistant_final_save'>('assistant_final_save');
  const sourceId = randomUUID();
  const operationId = randomUUID();
  const input = {
    intent: setup.intent,
    storeHash: setup.parent.humanIdentity.storeHash,
    backendNow,
    sourceId,
    operationId,
    previousEpisodeId: setup.parent.human.uuid,
    beginCallHash: scope.beginCallHash,
    leaseToken: scope.leaseToken,
  };
  const prepared = prepareAssistantCaptureBeginV2(
    setup.parent.graph,
    input,
    setup.registry,
    setup.consumed,
  );
  return { ...setup, scope, input, prepared };
}

function issueLeaseHandle(
  setup: ReturnType<typeof begin>,
): PrivateOneUseAutomaticLeaseHandle<'assistant_final_save'> {
  if (setup.prepared.kind !== 'prepared_claim')
    throw new Error('Expected a prepared assistant claim');
  const handle = setup.handleRegistry.recoverOrIssueInitial<'assistant_final_save'>(
    setup.scope.scope,
    setup.prepared.leaseFence,
  );
  if (!handle) throw new Error('Expected a private assistant lease handle');
  setup.registry.bindAssistantLease(setup.consumed, handle, setup.prepared.leaseFence);
  return handle;
}

function commitAssistant(setup: ReturnType<typeof begin>, terminalAt: string) {
  if (setup.prepared.kind !== 'prepared_claim') throw new Error('Expected claim');
  const handle = issueLeaseHandle(setup);
  const invocation = setup.handleRegistry.consumeForCompletion(handle, 'assistant_final_save');
  const completed = prepareAssistantFinalCompletionV2(
    setup.prepared.graph,
    setup.registry,
    handle,
    invocation,
    { storeHash: setup.parent.humanIdentity.storeHash, backendNow: terminalAt },
  );
  if (completed.kind !== 'prepared_commit') throw new Error('Expected assistant commit');
  return completed;
}

function independentBeginInput(
  setup: ReturnType<typeof begin>,
  intent: AutomaticAssistantCaptureIntentV2,
  backendNow: string,
) {
  const scope = setup.handleRegistry.startBegin<'assistant_final_save'>('assistant_final_save');
  return {
    scope,
    input: {
      ...setup.input,
      intent,
      backendNow,
      sourceId: randomUUID(),
      operationId: randomUUID(),
      beginCallHash: scope.beginCallHash,
      leaseToken: scope.leaseToken,
    },
  };
}

describe('assistant-final standalone capture contracts', () => {
  it('mints an opaque one-use authorization only from the exact committed human input and active binding', () => {
    const parent = makeHumanFixture();
    const intent = makeIntent(parent);
    const setup = authorize(parent, intent);
    expect(setup.authorization).not.toBeNull();
    expect(Object.keys(setup.authorization!)).toEqual([]);
    expect(Object.isFrozen(setup.authorization)).toBe(true);
    const consumed = setup.registry.consumeForBegin(setup.authorization!, intent);
    expect(Object.keys(consumed)).toEqual([]);
    expect(Object.isFrozen(consumed)).toBe(true);
    expect(() => setup.registry.consumeForBegin(setup.authorization!, intent)).toThrow(
      'invalid_authorization',
    );
  });

  it('rejects changed human text, mapping, quote spans, actor, store, or noncommitted parent', () => {
    const parent = makeHumanFixture('assistant-auth-binding');
    const base = makeIntent(parent);
    const registry = createAutomaticAssistantCaptureAuthorizationRegistry(
      createAutomaticCaptureHandleRegistry(),
    );
    expect(
      registry.authorize(
        {
          ...base,
          humanTurn: {
            ...base.humanTurn,
            input: { ...base.humanTurn.input, content: 'different' },
          },
        },
        parent.graph,
        { storeHash: parent.humanIdentity.storeHash },
      ),
    ).toBeNull();
    expect(
      registry.authorize(
        {
          ...base,
          humanTurn: {
            ...base.humanTurn,
            input: {
              ...base.humanTurn.input,
              applicationOwnedWrapper: true,
              humanRegion: { start: 1, end: base.humanTurn.input.content.length },
            },
          },
        },
        parent.graph,
        { storeHash: parent.humanIdentity.storeHash },
      ),
    ).toBeNull();
    expect(
      registry.authorize(
        {
          ...base,
          humanTurn: {
            ...base.humanTurn,
            input: { ...base.humanTurn.input, quoteRegions: [{ start: 0, end: 1 }] },
          },
        },
        parent.graph,
        { storeHash: parent.humanIdentity.storeHash },
      ),
    ).toBeNull();
    expect(registry.authorize(base, parent.graph, { storeHash: 'f'.repeat(64) })).toBeNull();
    expect(
      registry.authorize(
        { ...base, humanTurn: { ...base.humanTurn, actorReference: 'other-actor' } },
        parent.graph,
        { storeHash: parent.humanIdentity.storeHash },
      ),
    ).toBeNull();

    const noncommitted = structuredClone(parent.graph);
    const operation = noncommitted.automatic_operations_v1!.operations[0];
    if (operation.version !== 2 || operation.state !== 'committed') throw new Error('Bad fixture');
    const { terminalReceipt: _receipt, completionCallHash: _call, ...common } = operation;
    void _receipt;
    void _call;
    noncommitted.automatic_operations_v1!.operations[0] = AutomaticCaptureOperationV2Schema.parse({
      ...common,
      state: 'captured',
      generation: 0,
    });
    expect(
      registry.authorize(base, noncommitted, { storeHash: parent.humanIdentity.storeHash }),
    ).toBeNull();
  });

  it('accepts a redundant full-body wrapper mapping exactly as the stored whole-source envelope', () => {
    const parent = makeHumanFixture('assistant-auth-full-body');
    const base = makeIntent(parent);
    const intent = AutomaticAssistantCaptureIntentV2Schema.parse({
      ...base,
      humanTurn: {
        ...base.humanTurn,
        input: {
          ...base.humanTurn.input,
          applicationOwnedWrapper: true,
          humanRegion: { start: 0, end: base.humanTurn.input.content.length },
        },
      },
    });
    expect(authorize(parent, intent).authorization).not.toBeNull();
  });

  it.each(['accepted_bundle', 'proposed_bundle', 'source_verdict'] as const)(
    'authorizes a write-only assistant final from a committed V3 %s human parent',
    (kind) => {
      const parent = makeCompositionalAssistantHumanParentFixture(kind);
      const intent = makeAssistantIntentForCompositionalParent(parent);
      const handles = createAutomaticCaptureHandleRegistry();
      const registry = createAutomaticAssistantCaptureAuthorizationRegistry(handles);
      const authorization = registry.authorize(intent, parent.graph, {
        storeHash: parent.storeHash,
      });
      expect(authorization).not.toBeNull();
      if (!authorization) throw new Error('Expected private V3-parent authorization');

      const consumed = registry.consumeForBegin(authorization, intent);
      const descriptor = buildAssistantCaptureDescriptorV2(registry, consumed, intent);
      expect(descriptor.descriptor.assistantWriteAuthority).toEqual({
        kind: 'owned_human_turn',
        sourceId: parent.operation.identity.sourceId,
        sourceHash: parent.operation.identity.sourceHash,
        descriptorHash: parent.operation.identity.descriptorHash,
        requestedAuthorityHash: parent.operation.identity.requestedAuthorityHash,
      });

      const built = buildAssistantCaptureSourceV2(
        parent.graph,
        {
          intent,
          sourceId: randomUUID(),
          storeHash: parent.storeHash,
          capturedAt: NOW,
          previousEpisodeId: parent.source.uuid,
        },
        registry,
        consumed,
      );
      expect(built.episode).toMatchObject({
        group_id: parent.source.group_id,
        role: 'ai',
        episode_kind: 'assistant_reply',
        trust_level: 'unverified',
        review_status: 'proposed',
        source_execution_id: intent.finalAssistant.originalSourceExecutionId,
      });
      expect(built.episode.attributes).toHaveProperty('engram_write_owner_v2');
      expect(built.episode.attributes).not.toHaveProperty('engram_write_owner_v1');
      expect(built.episode.attributes).not.toHaveProperty('engram_source_envelope_v1');
      const assistantOperation = AutomaticCaptureOperationV2Schema.parse({
        version: 2,
        operationId: randomUUID(),
        identity: built.identity,
        descriptor: built.descriptor,
        createdAt: NOW,
        lastObservedAt: NOW,
        attempts: [],
        overflowCount: 0,
        beginCallHash: 'e'.repeat(64),
        retryCount: 0,
        state: 'captured',
        generation: 0,
      });
      const linked = GraphDataSchema.parse({
        ...parent.graph,
        episodes: [...parent.graph.episodes, built.episode],
        automatic_operations_v1: {
          version: 1,
          operations: [parent.operation, assistantOperation],
        },
      });
      expect(() => assertAutomaticLedgerSourceIntegrity(linked)).not.toThrow();
      expect(parent.graph.episodes.find((episode) => episode.uuid === parent.source.uuid)).toEqual(
        parent.source,
      );
      expect(parent.graph.automatic_operations_v1?.operations).toEqual([parent.operation]);
    },
  );

  it('keeps mutable V3 trust outside historical identity while denying fresh authorization', () => {
    const parent = makeCompositionalAssistantHumanParentFixture('source_verdict');
    const intent = makeAssistantIntentForCompositionalParent(parent);
    const handles = createAutomaticCaptureHandleRegistry();
    const registry = createAutomaticAssistantCaptureAuthorizationRegistry(handles);
    expect(
      registry.authorize(intent, parent.graph, { storeHash: parent.storeHash }),
    ).not.toBeNull();

    const changedGraph = structuredClone(parent.graph);
    const source = changedGraph.episodes.find((episode) => episode.uuid === parent.source.uuid);
    if (!source) throw new Error('Missing V3 source');
    source.trust_level = source.trust_level === 'trusted' ? 'standard' : 'trusted';
    const validatedGraph = GraphDataSchema.parse(changedGraph);

    expect(() => assertAutomaticLedgerSourceIntegrity(validatedGraph)).not.toThrow();
    expect(registry.authorize(intent, validatedGraph, { storeHash: parent.storeHash })).toBeNull();
  });

  it.each(['accepted_bundle', 'source_verdict'] as const)(
    'rejects changed actor, store, raw content, mapping, and quote data for a V3 %s parent',
    (kind) => {
      const parent = makeCompositionalAssistantHumanParentFixture(kind);
      const base = makeAssistantIntentForCompositionalParent(parent);
      const changedInput = (input: typeof base.humanTurn.input) => ({
        ...base,
        humanTurn: { ...base.humanTurn, input },
      });
      const cases = [
        { ...base, humanTurn: { ...base.humanTurn, actorReference: 'another-actor' } },
        { ...base, humanTurn: { ...base.humanTurn, issuer: 'another-issuer' } },
        { ...base, humanTurn: { ...base.humanTurn, turn: 'another-turn' } },
        { ...base, humanTurn: { ...base.humanTurn, namespace: 'another-namespace' } },
        changedInput({ ...base.humanTurn.input, content: `${base.humanTurn.input.content}!` }),
        changedInput({
          ...base.humanTurn.input,
          applicationOwnedWrapper: true,
          humanRegion: { start: 1, end: base.humanTurn.input.content.length },
        }),
        changedInput({
          ...base.humanTurn.input,
          quoteRegions: [{ start: 0, end: 1 }],
        }),
      ];
      for (const intent of cases) {
        const registry = createAutomaticAssistantCaptureAuthorizationRegistry(
          createAutomaticCaptureHandleRegistry(),
        );
        expect(
          registry.authorize(intent, parent.graph, { storeHash: parent.storeHash }),
        ).toBeNull();
      }
      const wrongRole = structuredClone(parent.graph);
      const source = wrongRole.episodes.find((episode) => episode.uuid === parent.source.uuid);
      if (!source) throw new Error('Missing V3 parent source');
      source.role = 'ai';
      const roleRegistry = createAutomaticAssistantCaptureAuthorizationRegistry(
        createAutomaticCaptureHandleRegistry(),
      );
      expect(roleRegistry.authorize(base, wrongRole, { storeHash: parent.storeHash })).toBeNull();
      const registry = createAutomaticAssistantCaptureAuthorizationRegistry(
        createAutomaticCaptureHandleRegistry(),
      );
      expect(registry.authorize(base, parent.graph, { storeHash: 'f'.repeat(64) })).toBeNull();
    },
  );

  it('does not treat V3 captured, cancelled, or source-only parents as assistant authority', () => {
    const parent = makeCompositionalAssistantHumanParentFixture('source_verdict');
    const intent = makeAssistantIntentForCompositionalParent(parent);
    const operation = parent.operation;
    const { terminalReceipt: _receipt, completionCallHash: _completion, ...common } = operation;
    void _receipt;
    void _completion;
    const captured = GraphDataSchema.parse({
      ...parent.graph,
      automatic_operations_v1: {
        version: 1,
        operations: [
          CompositionalAutomaticCaptureOperationV3Schema.parse({
            ...common,
            state: 'captured',
            generation: 0,
          }),
        ],
      },
    });
    const registry = createAutomaticAssistantCaptureAuthorizationRegistry(
      createAutomaticCaptureHandleRegistry(),
    );
    expect(registry.authorize(intent, captured, { storeHash: parent.storeHash })).toBeNull();

    const cancelledReceipt = CompositionalAutomaticCaptureTerminalReceiptV3Schema.parse({
      version: 3,
      kind: 'cancelled',
      operationId: operation.operationId,
      sourceId: operation.identity.sourceId,
      sourceHash: operation.identity.sourceHash,
      descriptorHash: operation.identity.descriptorHash,
      policyFingerprint: operation.descriptor.policy.fingerprint,
      terminalAt: operation.lastObservedAt,
      acceptedCoverage: 'none',
    });
    const cancelled = GraphDataSchema.parse({
      ...parent.graph,
      automatic_operations_v1: {
        version: 1,
        operations: [
          CompositionalAutomaticCaptureOperationV3Schema.parse({
            ...common,
            state: 'cancelled',
            generation: operation.generation,
            terminalReceipt: cancelledReceipt,
          }),
        ],
      },
    });
    expect(registry.authorize(intent, cancelled, { storeHash: parent.storeHash })).toBeNull();

    const withoutOperation = GraphDataSchema.parse({
      ...parent.graph,
      automatic_operations_v1: { version: 1, operations: [] },
    });
    expect(
      registry.authorize(intent, withoutOperation, { storeHash: parent.storeHash }),
    ).toBeNull();
  });

  it('accepts both maximum control-escaped assistant intent strings under its dedicated bound', () => {
    const prefix = '\u0001'.repeat(65_490);
    const parent = makeHumanFixture('assistant-max-intent', prefix);
    const base = makeIntent(parent);
    const intent = AutomaticAssistantCaptureIntentV2Schema.parse({
      ...base,
      humanTurn: {
        ...base.humanTurn,
        input: {
          ...base.humanTurn.input,
          applicationOwnedWrapper: true,
          humanRegion: { start: prefix.length, end: parent.human.content.length },
        },
      },
      finalAssistant: {
        ...base.finalAssistant,
        content: '\u0002'.repeat(65_536),
      },
    });
    const registry = createAutomaticAssistantCaptureAuthorizationRegistry(
      createAutomaticCaptureHandleRegistry(),
    );
    expect(
      registry.authorize(intent, parent.graph, { storeHash: parent.humanIdentity.storeHash }),
    ).not.toBeNull();

    expect(
      registry.authorize({ ...intent, unexpected: '\u0003'.repeat(180_000) }, parent.graph, {
        storeHash: parent.humanIdentity.storeHash,
      }),
    ).toBeNull();
  });

  it('reconstructs the exact application-owned human region before authorizing the final writer', () => {
    const prefix = 'Application context: ';
    const parent = makeHumanFixture('assistant-auth-wrapped', prefix);
    const base = makeIntent(parent);
    const intent = AutomaticAssistantCaptureIntentV2Schema.parse({
      ...base,
      humanTurn: {
        ...base.humanTurn,
        input: {
          ...base.humanTurn.input,
          applicationOwnedWrapper: true,
          humanRegion: { start: prefix.length, end: base.humanTurn.input.content.length },
        },
      },
    });
    expect(authorize(parent, intent).authorization).not.toBeNull();
  });

  it('keeps authorization one-use and rejects copied or cross-registry tokens', () => {
    const parent = makeHumanFixture('assistant-auth-instance');
    const intent = makeIntent(parent);
    const first = authorize(parent, intent);
    const second = authorize(parent, intent);
    if (!first.authorization || !second.authorization) throw new Error('Expected tokens');
    const forged = Object.freeze(
      Object.create(null),
    ) as PrivateAutomaticAssistantWriteAuthorizationV2;
    expect(() => first.registry.consumeForBegin(forged, intent)).toThrow('invalid_authorization');
    expect(() => second.registry.consumeForBegin(first.authorization!, intent)).toThrow(
      'invalid_authorization',
    );
    const consumed = first.registry.consumeForBegin(first.authorization, intent);
    expect(() => first.registry.consumeForBegin(first.authorization!, intent)).toThrow(
      'invalid_authorization',
    );
    expect(() => buildAssistantCaptureDescriptorV2(second.registry, consumed, intent)).toThrow(
      'invalid_authorization',
    );
    expect(() =>
      buildAssistantCaptureDescriptorV2(first.registry, consumed, {
        ...intent,
        attemptIdHash: 'b'.repeat(64),
      }),
    ).toThrow('invalid_authorization');
  });

  it('rejects a forged consumed authorization before parsing caller graph or input', () => {
    const registry = createAutomaticAssistantCaptureAuthorizationRegistry(
      createAutomaticCaptureHandleRegistry(),
    );
    let workChecks = 0;
    const prepared = prepareAssistantCaptureBeginV2(
      {},
      {},
      registry,
      {} as Parameters<typeof prepareAssistantCaptureBeginV2>[3],
      () => {
        workChecks += 1;
      },
    );
    expect(prepared).toEqual({ kind: 'decision', decision: { kind: 'invalid_input' } });
    expect(workChecks).toBe(1);
  });

  it('builds a fixed descriptor and assistant-only source tied to the human operation', () => {
    const setup = consumedAuthorization();
    const builtDescriptor = buildAssistantCaptureDescriptorV2(
      setup.registry,
      setup.consumed,
      setup.intent,
    );
    expect(builtDescriptor.descriptor).toMatchObject({
      purpose: 'assistant_final_save',
      interpreterId: 'assistant-final-write-v1',
      grammarVersion: null,
      lexiconVersion: null,
      policy: null,
      requestedTrustLevel: null,
    });
    expect(builtDescriptor.descriptor.assistantWriteAuthority).toEqual({
      kind: 'owned_human_turn',
      sourceId: setup.parent.human.uuid,
      sourceHash: setup.parent.humanIdentity.sourceHash,
      descriptorHash: hashAutomaticCaptureV2(setup.parent.humanDescriptor),
      requestedAuthorityHash: setup.parent.humanIdentity.requestedAuthorityHash,
    });
    const built = buildAssistantCaptureSourceV2(
      setup.parent.graph,
      {
        intent: setup.intent,
        sourceId: randomUUID(),
        storeHash: setup.parent.humanIdentity.storeHash,
        capturedAt: NOW,
        previousEpisodeId: setup.parent.human.uuid,
      },
      setup.registry,
      setup.consumed,
    );
    expect(built.episode).toMatchObject({
      role: 'ai',
      episode_kind: 'assistant_reply',
      content: setup.intent.finalAssistant.content,
      source_execution_id: 'synthetic-final-execution',
      trust_level: 'unverified',
      review_status: 'proposed',
    });
    expect(Object.keys(built.episode.attributes)).toEqual([WRITE_OWNER_V2_ATTRIBUTE]);
    expect(
      AutomaticCaptureSourceOwnerV2Schema.parse(built.episode.attributes[WRITE_OWNER_V2_ATTRIBUTE]),
    ).toMatchObject({
      role: 'assistant',
      purpose: 'assistant_final_save',
      binding: null,
      policy: null,
      assistantWriteAuthority: builtDescriptor.descriptor.assistantWriteAuthority,
    });
    const graphWithSource = GraphDataSchema.parse({
      ...setup.parent.graph,
      episodes: [...setup.parent.graph.episodes, built.episode],
    });
    expect(graphWithSource.episodes).toHaveLength(setup.parent.graph.episodes.length + 1);
    expect(setup.parent.graph.episodes).toHaveLength(1);
  });

  it('prepares one atomic initial source and lease, then recognizes only the same callback invocation', () => {
    const setup = begin();
    expect(setup.prepared.kind).toBe('prepared_claim');
    if (setup.prepared.kind !== 'prepared_claim') return;
    expect(setup.prepared.writeRequired).toBe(true);
    expect(setup.prepared.graph.episodes).toHaveLength(setup.parent.graph.episodes.length + 1);
    expect(setup.prepared.operation).toMatchObject({
      state: 'leased',
      generation: 1,
      retryCount: 0,
      lease: { claimKind: 'initial', token: setup.input.leaseToken },
    });
    expect(setup.prepared).not.toHaveProperty('should_process');
    const retry = prepareAssistantCaptureBeginV2(
      setup.prepared.graph,
      { ...setup.input, backendNow: '2026-10-25T13:00:01.000Z' },
      setup.registry,
      setup.consumed,
    );
    expect(retry).toMatchObject({ kind: 'prepared_claim', writeRequired: false });
    const alteredCall = prepareAssistantCaptureBeginV2(
      setup.prepared.graph,
      { ...setup.input, operationId: randomUUID() },
      setup.registry,
      setup.consumed,
    );
    expect(alteredCall).toEqual({ kind: 'decision', decision: { kind: 'invalid_input' } });
    expect(setup.parent.graph.episodes).toHaveLength(1);
  });

  it('rechecks the actual parent binding at begin and denies a revoked authorization without mutation', () => {
    const setup = consumedAuthorization();
    const graph = structuredClone(setup.parent.graph);
    const subject = graph.entities.find((entity) => entity.uuid === setup.parent.binding.subjectId);
    if (!subject) throw new Error('Missing binding subject');
    const storedBindings = subject.attributes.engram_actor_bindings_v1 as Array<{
      bindingId: string;
      revision: number;
    }>;
    applyAutomaticBindingCommand(
      graph,
      {
        action: 'revoke',
        namespace: setup.parent.human.group_id,
        bindingId: storedBindings[0].bindingId,
        expectedRevision: storedBindings[0].revision,
        authorizedBy: 'synthetic-reviewer',
        reason: 'Synthetic revocation before assistant begin',
      },
      randomUUID(),
      NOW,
    );
    const scope = setup.handleRegistry.startBegin<'assistant_final_save'>('assistant_final_save');
    const result = prepareAssistantCaptureBeginV2(
      graph,
      {
        intent: setup.intent,
        storeHash: setup.parent.humanIdentity.storeHash,
        backendNow: NOW,
        sourceId: randomUUID(),
        operationId: randomUUID(),
        previousEpisodeId: setup.parent.human.uuid,
        beginCallHash: scope.beginCallHash,
        leaseToken: scope.leaseToken,
      },
      setup.registry,
      setup.consumed,
    );
    expect(result).toEqual({ kind: 'decision', decision: { kind: 'authority_changed' } });
    expect(graph.episodes).toHaveLength(setup.parent.graph.episodes.length);
    expect(graph.automatic_operations_v1).toEqual(setup.parent.graph.automatic_operations_v1);
  });

  it('returns fixed conflict/replay outcomes and never reuses an assistant lease for another call', () => {
    const setup = begin();
    if (setup.prepared.kind !== 'prepared_claim') throw new Error('Expected claim');
    const secondAuth = authorize(setup.parent, setup.intent, setup.handleRegistry);
    if (!secondAuth.authorization) throw new Error('Expected second authorization');
    const secondConsumed = secondAuth.registry.consumeForBegin(
      secondAuth.authorization,
      setup.intent,
    );
    const secondScope =
      setup.handleRegistry.startBegin<'assistant_final_save'>('assistant_final_save');
    const second = prepareAssistantCaptureBeginV2(
      setup.prepared.graph,
      {
        ...setup.input,
        beginCallHash: secondScope.beginCallHash,
        leaseToken: secondScope.leaseToken,
        operationId: randomUUID(),
        sourceId: randomUUID(),
      },
      secondAuth.registry,
      secondConsumed,
    );
    expect(second).toEqual({ kind: 'decision', decision: { kind: 'in_progress' } });

    const committed = structuredClone(setup.prepared.graph);
    const op = committed.automatic_operations_v1!.operations.at(-1)!;
    if (op.version !== 2 || op.state !== 'leased') throw new Error('Expected assistant lease');
    const { lease: _lease, ...base } = op;
    void _lease;
    const receipt = AutomaticCaptureTerminalReceiptV2Schema.parse({
      version: 2,
      kind: 'assistant_final_saved',
      operationId: op.operationId,
      sourceId: op.identity.sourceId,
      sourceHash: op.identity.sourceHash,
      descriptorHash: hashAutomaticCaptureV2(op.descriptor),
      terminalAt: '2026-10-25T13:00:01.000Z',
      persisted: true,
    });
    committed.automatic_operations_v1!.operations[
      committed.automatic_operations_v1!.operations.length - 1
    ] = AutomaticCaptureOperationV2Schema.parse({
      ...base,
      state: 'committed',
      lastObservedAt: receipt.terminalAt,
      completionCallHash: 'f'.repeat(64),
      terminalReceipt: receipt,
    });
    const replay = prepareAssistantCaptureBeginV2(
      committed,
      { ...setup.input, backendNow: '2026-10-25T13:00:02.000Z' },
      setup.registry,
      setup.consumed,
    );
    expect(replay).toEqual({
      kind: 'prepared_replay',
      graph: committed,
      terminalReceipt: receipt,
      currentAuthority: 'active',
      auditWriteRequired: false,
    });
  });

  it('prepares a durable attempt audit for an independent committed replay without changing its receipt or source', () => {
    const setup = begin();
    const committed = commitAssistant(setup, '2026-10-25T13:00:01.000Z');
    const intent = AutomaticAssistantCaptureIntentV2Schema.parse({
      ...setup.intent,
      attemptIdHash: 'b'.repeat(64),
    });
    const registry = createAutomaticAssistantCaptureAuthorizationRegistry(setup.handleRegistry);
    const authorization = registry.authorize(intent, committed.graph, {
      storeHash: setup.parent.humanIdentity.storeHash,
    });
    if (!authorization) throw new Error('Expected active replay authorization');
    const consumed = registry.consumeForBegin(authorization, intent);
    const { input } = independentBeginInput(setup, intent, '2026-10-25T13:00:02.000Z');

    const replay = prepareAssistantCaptureBeginV2(committed.graph, input, registry, consumed);
    expect(replay).toMatchObject({
      kind: 'prepared_replay',
      terminalReceipt: committed.terminalReceipt,
      currentAuthority: 'active',
      auditWriteRequired: true,
    });
    if (replay.kind !== 'prepared_replay') throw new Error('Expected replay');
    expect(replay.graph.episodes).toEqual(committed.graph.episodes);
    const replayOperation = replay.graph.automatic_operations_v1!.operations.find(
      (operation) => operation.operationId === committed.operation.operationId,
    );
    expect(replayOperation).toMatchObject({
      state: 'committed',
      terminalReceipt: committed.terminalReceipt,
      attempts: [
        expect.any(Object),
        {
          attemptHash: intent.attemptIdHash,
          at: input.backendNow,
          disposition: 'committed_replay',
        },
      ],
    });
  });

  it('records a distinct active in-progress attempt as a prepared ledger-only decision', () => {
    const setup = begin();
    if (setup.prepared.kind !== 'prepared_claim') throw new Error('Expected claim');
    const initialOperationId = setup.prepared.operation.operationId;
    const intent = AutomaticAssistantCaptureIntentV2Schema.parse({
      ...setup.intent,
      attemptIdHash: 'c'.repeat(64),
    });
    const registry = createAutomaticAssistantCaptureAuthorizationRegistry(setup.handleRegistry);
    const authorization = registry.authorize(intent, setup.prepared.graph, {
      storeHash: setup.parent.humanIdentity.storeHash,
    });
    if (!authorization) throw new Error('Expected active in-progress authorization');
    const consumed = registry.consumeForBegin(authorization, intent);
    const { input } = independentBeginInput(setup, intent, '2026-10-25T13:00:01.000Z');

    const result = prepareAssistantCaptureBeginV2(setup.prepared.graph, input, registry, consumed);
    expect(result).toMatchObject({
      kind: 'prepared_decision',
      decision: { kind: 'in_progress' },
    });
    if (result.kind !== 'prepared_decision') throw new Error('Expected prepared audit');
    expect(result.graph.episodes).toEqual(setup.prepared.graph.episodes);
    const operation = result.graph.automatic_operations_v1!.operations.find(
      (stored) => stored.operationId === initialOperationId,
    );
    expect(operation?.version === 2 ? operation.attempts.at(-1) : null).toEqual({
      attemptHash: intent.attemptIdHash,
      at: input.backendNow,
      disposition: 'in_progress',
    });
  });

  it('marks attempt truncation once at the fixed audit cap and then reads through without another write', () => {
    const setup = begin();
    const committed = commitAssistant(setup, '2026-10-25T13:00:01.000Z');
    const fullAuditGraph = structuredClone(committed.graph);
    const assistantOperation = fullAuditGraph.automatic_operations_v1!.operations.find(
      (operation) => operation.operationId === committed.operation.operationId,
    );
    if (assistantOperation?.version !== 2 || assistantOperation.state !== 'committed')
      throw new Error('Expected committed assistant operation');
    const attempts = Array.from({ length: 32 }, (_, index) => ({
      attemptHash:
        index === 0
          ? setup.intent.attemptIdHash
          : `${'0'.repeat(62)}${index.toString(16).padStart(2, '0')}`,
      at: NOW,
      disposition: index === 0 ? ('claim_won' as const) : ('in_progress' as const),
    }));
    fullAuditGraph.automatic_operations_v1!.operations =
      fullAuditGraph.automatic_operations_v1!.operations.map((operation) =>
        operation.operationId === assistantOperation.operationId
          ? AutomaticCaptureOperationV2Schema.parse({
              ...assistantOperation,
              attempts,
              auditTruncated: false,
            })
          : operation,
      );

    const firstIntent = AutomaticAssistantCaptureIntentV2Schema.parse({
      ...setup.intent,
      attemptIdHash: 'b'.repeat(64),
    });
    const firstRegistry = createAutomaticAssistantCaptureAuthorizationRegistry(
      setup.handleRegistry,
    );
    const firstAuthorization = firstRegistry.authorize(firstIntent, fullAuditGraph, {
      storeHash: setup.parent.humanIdentity.storeHash,
    });
    if (!firstAuthorization) throw new Error('Expected active replay authorization');
    const firstConsumed = firstRegistry.consumeForBegin(firstAuthorization, firstIntent);
    const firstCall = independentBeginInput(setup, firstIntent, '2026-10-25T13:00:02.000Z');
    const truncated = prepareAssistantCaptureBeginV2(
      fullAuditGraph,
      firstCall.input,
      firstRegistry,
      firstConsumed,
    );
    expect(truncated).toMatchObject({ kind: 'prepared_replay', auditWriteRequired: true });
    if (truncated.kind !== 'prepared_replay') throw new Error('Expected truncated replay');
    const truncatedOperation = truncated.graph.automatic_operations_v1!.operations.find(
      (operation) => operation.operationId === assistantOperation.operationId,
    );
    expect(truncatedOperation).toMatchObject({ attempts: { length: 32 }, auditTruncated: true });
    expect(truncated.terminalReceipt).toEqual(committed.terminalReceipt);

    const nextIntent = AutomaticAssistantCaptureIntentV2Schema.parse({
      ...setup.intent,
      attemptIdHash: 'c'.repeat(64),
    });
    const nextRegistry = createAutomaticAssistantCaptureAuthorizationRegistry(setup.handleRegistry);
    const nextAuthorization = nextRegistry.authorize(nextIntent, truncated.graph, {
      storeHash: setup.parent.humanIdentity.storeHash,
    });
    if (!nextAuthorization) throw new Error('Expected active read-through authorization');
    const nextConsumed = nextRegistry.consumeForBegin(nextAuthorization, nextIntent);
    const nextCall = independentBeginInput(setup, nextIntent, '2026-10-25T13:00:03.000Z');
    const readThrough = prepareAssistantCaptureBeginV2(
      truncated.graph,
      nextCall.input,
      nextRegistry,
      nextConsumed,
    );
    expect(readThrough).toMatchObject({
      kind: 'prepared_replay',
      terminalReceipt: committed.terminalReceipt,
      auditWriteRequired: false,
    });
  });

  it('reads the actual committed receipt when the full ledger candidate rejects another audit attempt', () => {
    const setup = begin();
    const committed = commitAssistant(setup, '2026-10-25T13:00:01.000Z');
    const intent = AutomaticAssistantCaptureIntentV2Schema.parse({
      ...setup.intent,
      attemptIdHash: 'd'.repeat(64),
    });
    const registry = createAutomaticAssistantCaptureAuthorizationRegistry(setup.handleRegistry);
    const authorization = registry.authorize(intent, committed.graph, {
      storeHash: setup.parent.humanIdentity.storeHash,
    });
    if (!authorization) throw new Error('Expected active replay authorization');
    const consumed = registry.consumeForBegin(authorization, intent);
    const { input } = independentBeginInput(setup, intent, '2026-10-25T13:00:02.000Z');

    const capacity = jest
      .spyOn(automaticCaptureCapacity, 'validateAutomaticCaptureCandidate')
      .mockReturnValue(null);
    let replay: ReturnType<typeof prepareAssistantCaptureBeginV2>;
    try {
      replay = prepareAssistantCaptureBeginV2(committed.graph, input, registry, consumed);
    } finally {
      capacity.mockRestore();
    }
    expect(replay!).toMatchObject({
      kind: 'prepared_replay',
      graph: committed.graph,
      terminalReceipt: committed.terminalReceipt,
      auditWriteRequired: false,
    });
  });

  it('audits expired assistant work as unsupported without advertising a resume API', () => {
    const setup = begin();
    if (setup.prepared.kind !== 'prepared_claim') throw new Error('Expected claim');
    const operationId = setup.prepared.operation.operationId;
    const leaseExpiresAt = setup.prepared.operation.lease.expiresAt;
    const intent = AutomaticAssistantCaptureIntentV2Schema.parse({
      ...setup.intent,
      attemptIdHash: 'f'.repeat(64),
    });
    const registry = createAutomaticAssistantCaptureAuthorizationRegistry(setup.handleRegistry);
    const authorization = registry.authorize(intent, setup.prepared.graph, {
      storeHash: setup.parent.humanIdentity.storeHash,
    });
    if (!authorization) throw new Error('Expected active expired-work authorization');
    const consumed = registry.consumeForBegin(authorization, intent);
    const expiredAt = new Date(Date.parse(leaseExpiresAt) + 1).toISOString();
    const { input } = independentBeginInput(setup, intent, expiredAt);
    const result = prepareAssistantCaptureBeginV2(setup.prepared.graph, input, registry, consumed);

    expect(result).toMatchObject({
      kind: 'prepared_decision',
      decision: { kind: 'unsupported_mode' },
    });
    if (result.kind !== 'prepared_decision') throw new Error('Expected prepared attempt audit');
    const operation = result.graph.automatic_operations_v1!.operations.find(
      (stored) => stored.operationId === operationId,
    );
    expect(operation?.version === 2 ? operation.attempts.at(-1) : null).toEqual({
      attemptHash: intent.attemptIdHash,
      at: input.backendNow,
      disposition: 'unsupported_mode',
    });
  });

  it('audits an exact cancelled assistant replay without changing its terminal receipt', () => {
    const setup = begin();
    if (setup.prepared.kind !== 'prepared_claim') throw new Error('Expected claim');
    const cancelledGraph = structuredClone(setup.prepared.graph);
    const assistantOperation = setup.prepared.operation;
    const { lease: _lease, ...base } = assistantOperation;
    void _lease;
    const terminalAt = '2026-10-25T13:00:01.000Z';
    const receipt = AutomaticCaptureTerminalReceiptV2Schema.parse({
      version: 2,
      kind: 'cancelled',
      operationId: assistantOperation.operationId,
      sourceId: assistantOperation.identity.sourceId,
      sourceHash: assistantOperation.identity.sourceHash,
      descriptorHash: hashAutomaticCaptureV2(assistantOperation.descriptor),
      terminalAt,
      acceptedCoverage: 'none',
    });
    cancelledGraph.automatic_operations_v1!.operations =
      cancelledGraph.automatic_operations_v1!.operations.map((operation) =>
        operation.operationId === assistantOperation.operationId
          ? AutomaticCaptureOperationV2Schema.parse({
              ...base,
              state: 'cancelled',
              lastObservedAt: terminalAt,
              terminalReceipt: receipt,
            })
          : operation,
      );

    const intent = AutomaticAssistantCaptureIntentV2Schema.parse({
      ...setup.intent,
      attemptIdHash: 'e'.repeat(64),
    });
    const registry = createAutomaticAssistantCaptureAuthorizationRegistry(setup.handleRegistry);
    const authorization = registry.authorize(intent, cancelledGraph, {
      storeHash: setup.parent.humanIdentity.storeHash,
    });
    if (!authorization) throw new Error('Expected active cancelled replay authorization');
    const consumed = registry.consumeForBegin(authorization, intent);
    const { input } = independentBeginInput(setup, intent, '2026-10-25T13:00:02.000Z');
    const result = prepareAssistantCaptureBeginV2(cancelledGraph, input, registry, consumed);

    expect(result).toMatchObject({
      kind: 'prepared_decision',
      decision: { kind: 'cancelled_replay' },
    });
    if (result.kind !== 'prepared_decision') throw new Error('Expected prepared audit');
    const updated = result.graph.automatic_operations_v1!.operations.find(
      (operation) => operation.operationId === assistantOperation.operationId,
    );
    expect(updated).toMatchObject({
      state: 'cancelled',
      terminalReceipt: receipt,
      attempts: [
        expect.any(Object),
        {
          attemptHash: intent.attemptIdHash,
          at: input.backendNow,
          disposition: 'cancelled_replay',
        },
      ],
    });
  });

  it('rejects assistant lease recovery when backend time regresses behind that operation', () => {
    const setup = begin(consumedAuthorization(), '2026-10-25T13:01:00.000Z');
    if (setup.prepared.kind !== 'prepared_claim') throw new Error('Expected claim');

    const regressed = prepareAssistantCaptureBeginV2(
      setup.prepared.graph,
      { ...setup.input, backendNow: '2026-10-25T13:00:59.999Z' },
      setup.registry,
      setup.consumed,
    );
    expect(regressed).toEqual({ kind: 'decision', decision: { kind: 'clock_regression' } });
  });

  it('treats a changed final body for the same assistant turn as a fixed conflict', () => {
    const setup = begin();
    if (setup.prepared.kind !== 'prepared_claim') throw new Error('Expected claim');
    const changedIntent = AutomaticAssistantCaptureIntentV2Schema.parse({
      ...setup.intent,
      finalAssistant: {
        ...setup.intent.finalAssistant,
        content: 'A different final answer.',
      },
    });
    const changedRegistry = createAutomaticAssistantCaptureAuthorizationRegistry(
      setup.handleRegistry,
    );
    const authorization = changedRegistry.authorize(changedIntent, setup.parent.graph, {
      storeHash: setup.parent.humanIdentity.storeHash,
    });
    if (!authorization)
      throw new Error('Expected changed source to remain bound to the human turn');
    const consumed = changedRegistry.consumeForBegin(authorization, changedIntent);
    const scope = setup.handleRegistry.startBegin<'assistant_final_save'>('assistant_final_save');
    const changed = prepareAssistantCaptureBeginV2(
      setup.prepared.graph,
      {
        ...setup.input,
        intent: changedIntent,
        beginCallHash: scope.beginCallHash,
        leaseToken: scope.leaseToken,
        operationId: randomUUID(),
        sourceId: randomUUID(),
      },
      changedRegistry,
      consumed,
    );
    expect(changed).toEqual({ kind: 'decision', decision: { kind: 'conflict' } });
  });

  it('commits only a write-only receipt and returns the same receipt for exact callback acknowledgment recovery', () => {
    const setup = begin();
    if (setup.prepared.kind !== 'prepared_claim') throw new Error('Expected claim');
    const handle = issueLeaseHandle(setup);
    expect(setup.registry.authorizationForAssistantLease(handle)).toBe(setup.consumed);
    const consumedInvocation = setup.handleRegistry.consumeForCompletion(
      handle,
      'assistant_final_save',
    );
    const completed = prepareAssistantFinalCompletionV2(
      setup.prepared.graph,
      setup.registry,
      handle,
      consumedInvocation,
      {
        storeHash: setup.parent.humanIdentity.storeHash,
        backendNow: '2026-10-25T13:00:01.000Z',
      },
    );
    expect(completed).toMatchObject({ kind: 'prepared_commit' });
    if (completed.kind !== 'prepared_commit') return;
    expect(completed.terminalReceipt).toMatchObject({
      kind: 'assistant_final_saved',
      persisted: true,
      sourceId: setup.prepared.operation.identity.sourceId,
      sourceHash: setup.prepared.operation.identity.sourceHash,
    });
    expect(completed.operation.state).toBe('committed');
    expect(completed.graph.entities).toEqual(setup.prepared.graph.entities);
    expect(completed.graph.edges).toEqual(setup.prepared.graph.edges);
    expect(completed.graph.episodes).toEqual(setup.prepared.graph.episodes);
    expect(completed.operation.terminalReceipt).toEqual(completed.terminalReceipt);
    expect(completed.operation).not.toHaveProperty('lease');

    const acknowledgmentRecovery = prepareAssistantFinalCompletionV2(
      completed.graph,
      setup.registry,
      handle,
      consumedInvocation,
      {
        storeHash: setup.parent.humanIdentity.storeHash,
        backendNow: '2026-10-25T13:00:02.000Z',
      },
    );
    expect(acknowledgmentRecovery).toEqual({
      kind: 'ack_recovered',
      terminalReceipt: completed.terminalReceipt,
      currentAuthority: 'active',
    });
    expect(acknowledgmentRecovery).not.toHaveProperty('eligibleFirstCommit');
  });

  it('rejects completion after binding revocation and retains historical receipt only on exact ack recovery', () => {
    const setup = begin();
    if (setup.prepared.kind !== 'prepared_claim') throw new Error('Expected claim');
    const handle = issueLeaseHandle(setup);
    const invocation = setup.handleRegistry.consumeForCompletion(handle, 'assistant_final_save');
    const revoked = structuredClone(setup.prepared.graph);
    const bindingOwner = revoked.entities.find(
      (entity) => entity.uuid === setup.parent.binding.subjectId,
    );
    if (!bindingOwner) throw new Error('Missing binding subject');
    const bindings = bindingOwner.attributes.engram_actor_bindings_v1 as Array<{
      bindingId: string;
      revision: number;
    }>;
    const bindingRecord = bindings[0];
    applyAutomaticBindingCommand(
      revoked,
      {
        action: 'revoke',
        namespace: setup.parent.human.group_id,
        bindingId: bindingRecord.bindingId,
        expectedRevision: bindingRecord.revision,
        authorizedBy: 'synthetic-reviewer',
        reason: 'Synthetic revocation before assistant completion',
      },
      randomUUID(),
      '2026-10-25T13:00:01.000Z',
    );
    const denied = prepareAssistantFinalCompletionV2(revoked, setup.registry, handle, invocation, {
      storeHash: setup.parent.humanIdentity.storeHash,
      backendNow: '2026-10-25T13:00:02.000Z',
    });
    expect(denied).toEqual({ kind: 'decision', reason: 'authority_changed' });
    expect(setup.prepared.graph.automatic_operations_v1!.operations.at(-1)).toMatchObject({
      state: 'leased',
    });

    const committedSetup = begin();
    if (committedSetup.prepared.kind !== 'prepared_claim') throw new Error('Expected claim');
    const committedHandle = issueLeaseHandle(committedSetup);
    const committedInvocation = committedSetup.handleRegistry.consumeForCompletion(
      committedHandle,
      'assistant_final_save',
    );
    const committed = prepareAssistantFinalCompletionV2(
      committedSetup.prepared.graph,
      committedSetup.registry,
      committedHandle,
      committedInvocation,
      {
        storeHash: committedSetup.parent.humanIdentity.storeHash,
        backendNow: '2026-10-25T13:00:01.000Z',
      },
    );
    if (committed.kind !== 'prepared_commit') throw new Error('Expected assistant commit');
    const revokedAfterCommit = structuredClone(committed.graph);
    const subject = revokedAfterCommit.entities.find(
      (entity) => entity.uuid === committedSetup.parent.binding.subjectId,
    );
    if (!subject) throw new Error('Missing binding subject');
    const storedBindings = subject.attributes.engram_actor_bindings_v1 as Array<{
      bindingId: string;
      revision: number;
    }>;
    applyAutomaticBindingCommand(
      revokedAfterCommit,
      {
        action: 'revoke',
        namespace: committedSetup.parent.human.group_id,
        bindingId: storedBindings[0].bindingId,
        expectedRevision: storedBindings[0].revision,
        authorizedBy: 'synthetic-reviewer',
        reason: 'Synthetic revocation after assistant commit',
      },
      randomUUID(),
      '2026-10-25T13:00:02.000Z',
    );
    expect(
      prepareAssistantFinalCompletionV2(
        revokedAfterCommit,
        committedSetup.registry,
        committedHandle,
        committedInvocation,
        {
          storeHash: committedSetup.parent.humanIdentity.storeHash,
          backendNow: '2026-10-25T13:00:03.000Z',
        },
      ),
    ).toEqual({
      kind: 'ack_recovered',
      terminalReceipt: committed.terminalReceipt,
      currentAuthority: 'revoked',
    });
  });

  it('reads only the actual historical receipt after revocation without creating any capability', () => {
    const setup = begin();
    if (setup.prepared.kind !== 'prepared_claim') throw new Error('Expected claim');
    const handle = issueLeaseHandle(setup);
    const invocation = setup.handleRegistry.consumeForCompletion(handle, 'assistant_final_save');
    const committed = prepareAssistantFinalCompletionV2(
      setup.prepared.graph,
      setup.registry,
      handle,
      invocation,
      {
        storeHash: setup.parent.humanIdentity.storeHash,
        backendNow: '2026-10-25T13:00:01.000Z',
      },
    );
    if (committed.kind !== 'prepared_commit') throw new Error('Expected assistant commit');

    const revoked = structuredClone(committed.graph);
    const subject = revoked.entities.find(
      (entity) => entity.uuid === setup.parent.binding.subjectId,
    );
    if (!subject) throw new Error('Missing binding subject');
    const bindings = subject.attributes.engram_actor_bindings_v1 as Array<{
      bindingId: string;
      revision: number;
    }>;
    applyAutomaticBindingCommand(
      revoked,
      {
        action: 'revoke',
        namespace: setup.parent.human.group_id,
        bindingId: bindings[0].bindingId,
        expectedRevision: bindings[0].revision,
        authorizedBy: 'synthetic-reviewer',
        reason: 'Synthetic revocation before historical receipt inspection',
      },
      randomUUID(),
      '2026-10-25T13:00:02.000Z',
    );

    const inspected = readAutomaticAssistantCaptureReplayV2(revoked, setup.intent, {
      storeHash: setup.parent.humanIdentity.storeHash,
    });
    expect(inspected).toEqual({
      kind: 'committed_replay',
      terminalReceipt: committed.terminalReceipt,
      currentAuthority: 'revoked',
      eligibleFirstCommit: false,
    });
    expect(
      revoked.automatic_operations_v1!.operations.find(
        (operation) => operation.identity.role === 'assistant',
      ),
    ).toMatchObject({ attempts: committed.operation.attempts ?? [] });
    expect(
      readAutomaticAssistantCaptureReplayV2(
        revoked,
        { ...setup.intent, attemptIdHash: 'b'.repeat(64) },
        { storeHash: setup.parent.humanIdentity.storeHash },
      ),
    ).toEqual(inspected);
    expect(
      readAutomaticAssistantCaptureReplayV2(
        revoked,
        {
          ...setup.intent,
          finalAssistant: {
            ...setup.intent.finalAssistant,
            content: 'A different final answer.',
          },
        },
        { storeHash: setup.parent.humanIdentity.storeHash },
      ),
    ).toEqual({ kind: 'decision', reason: 'conflict', eligibleFirstCommit: false });
    expect(
      setup.registry.authorize(setup.intent, revoked, {
        storeHash: setup.parent.humanIdentity.storeHash,
      }),
    ).toBeNull();

    expect(() =>
      setup.registry.consumeForBegin(
        inspected as unknown as PrivateAutomaticAssistantWriteAuthorizationV2,
        setup.intent,
      ),
    ).toThrow('invalid_authorization');
    expect(
      prepareAssistantCaptureBeginV2(
        revoked,
        setup.input,
        setup.registry,
        inspected as unknown as Parameters<typeof prepareAssistantCaptureBeginV2>[3],
      ),
    ).toEqual({ kind: 'decision', decision: { kind: 'invalid_input' } });
    expect(
      prepareAssistantFinalCompletionV2(
        revoked,
        setup.registry,
        {} as Parameters<typeof prepareAssistantFinalCompletionV2>[2],
        inspected as unknown as Parameters<typeof prepareAssistantFinalCompletionV2>[3],
        {
          storeHash: setup.parent.humanIdentity.storeHash,
          backendNow: '2026-10-25T13:00:03.000Z',
        },
      ),
    ).toEqual({ kind: 'decision', reason: 'invalid_handle' });
  });
});
