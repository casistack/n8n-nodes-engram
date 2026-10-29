import { planAutonomousPersonalCaptureCompletionV4 } from '../../../src/storage/AutonomousPersonalCompletionPlanV4';
import { AutonomousPersonalCompletionPlanV4OwnedDataSchema } from '../../../src/schemas/AutonomousPersonalCompletionPlanV4.schema';
import { hashAutomaticCaptureV2 } from '../../../src/schemas/AutomaticCapture.schema';
import {
  appendManualLegacyPreferenceCandidatesV4,
  autonomousPersonalCompletionPlanFixtureV4,
  autonomousPersonalCompletionPlanNextStageV4,
  type AutonomousPersonalCompletionPlanFixtureV4,
} from '../../helpers/autonomousPersonalCompletionPlanV4';
import {
  getAutomaticClaimReadScope,
  reserveAutomaticClaimSnapshotBytes,
} from '../../../src/storage/AutomaticClaimReadScope';
import { AUTONOMOUS_PERSONAL_POLICY_V3_LIMITS } from '../../../src/schemas/AutonomousPersonalPolicyV3.schema';

type PlannedCompletion = Extract<
  ReturnType<typeof planAutonomousPersonalCaptureCompletionV4>,
  { kind: 'planned' }
>;

function appendPriorPlanRows(
  current: Pick<AutonomousPersonalCompletionPlanFixtureV4, 'graph' | 'budget'>,
  prior: PlannedCompletion,
): void {
  const originalBytes = Buffer.byteLength(JSON.stringify(current.graph), 'utf8');
  current.graph.automatic_operations_v1!.operations =
    current.graph.automatic_operations_v1!.operations.map((operation) =>
      operation.operationId === prior.operation.operationId
        ? structuredClone(prior.operation)
        : operation,
    );
  current.graph.entities.push(...structuredClone(prior.createEntities));
  current.graph.edges.push(...structuredClone(prior.createEdges));
  const addedBytes = Buffer.byteLength(JSON.stringify(current.graph), 'utf8') - originalBytes;
  if (!reserveAutomaticClaimSnapshotBytes(getAutomaticClaimReadScope(current.budget), addedBytes))
    throw new Error('Unable to reserve synthetic family4 rows');
}

function appendLegacyCandidatesAndReserve(
  current: Pick<AutonomousPersonalCompletionPlanFixtureV4, 'graph' | 'budget' | 'input'>,
  count: number,
): void {
  const originalBytes = Buffer.byteLength(JSON.stringify(current.graph), 'utf8');
  const identity = current.input.scope.context;
  appendManualLegacyPreferenceCandidatesV4(
    current.graph,
    identity.namespace,
    identity.binding.subjectId,
    count,
  );
  const addedBytes = Buffer.byteLength(JSON.stringify(current.graph), 'utf8') - originalBytes;
  if (!reserveAutomaticClaimSnapshotBytes(getAutomaticClaimReadScope(current.budget), addedBytes))
    throw new Error('Unable to reserve synthetic legacy candidates');
}

const sharedCounterTypedContent = [
  ...['English', 'Spanish', 'French', 'German', 'Italian', 'Portuguese', 'Dutch', 'Swedish'].map(
    (language) => `I prefer ${language}.`,
  ),
  'I prefer Markdown.',
  'I prefer JSON.',
  'I prefer tables.',
  'I prefer bullet points.',
  'I prefer numbered steps.',
  'I prefer fewer emojis.',
  'I prefer concise explanations.',
].join(' ');

const unrelatedStatementContent = [
  'I had a lovely weekend.',
  'I enjoyed a nice lunch.',
  'I moved the blue chair.',
  'I found the book I needed.',
  'I attended the meeting on Tuesday.',
  'I visited my sister.',
  'I started a new project.',
  'I watched a great film.',
].join(' ');

describe('Autonomous Personal Completion Plan V4', () => {
  it('returns a frozen all-or-none creation plan without mutating the actual graph', async () => {
    const fixture = await autonomousPersonalCompletionPlanFixtureV4();
    try {
      if (!fixture.selection) throw new Error('Expected a complete provider selection');
      const before = JSON.stringify(fixture.graph);
      const plan = planAutonomousPersonalCaptureCompletionV4(
        fixture.input,
        fixture.graph,
        fixture.response,
        fixture.selection,
        fixture.work,
        fixture.check,
        fixture.budget,
      );

      expect(plan.kind).toBe('planned');
      expect(AutonomousPersonalCompletionPlanV4OwnedDataSchema.parse(plan)).toEqual(plan);
      expect(JSON.stringify(fixture.graph)).toBe(before);
      expect(Object.isFrozen(plan)).toBe(true);
      if (plan.kind !== 'planned') throw new Error('Expected planned DATA');
      expect(plan.createEntities).toHaveLength(1);
      expect(plan.createEdges).toHaveLength(1);
      expect(plan.referenceGuards).toEqual([]);
      expect(plan.operation.state).toBe('committed');
      expect(plan.operation.terminalReceipt.kind).toBe('human_autonomous_capture_committed');
      expect(Object.isFrozen(plan.createEntities[0])).toBe(true);
      expect(Object.isFrozen(plan.createEdges[0])).toBe(true);
    } finally {
      await fixture.close();
    }
  });

  it('groups repeated complete meanings into one deterministic creator and occurrence references', async () => {
    const fixture = await autonomousPersonalCompletionPlanFixtureV4({
      content: 'I prefer concise explanations. I prefer concise explanations.',
    });
    try {
      if (!fixture.selection) throw new Error('Expected a complete provider selection');
      expect(fixture.selection.occurrences).toHaveLength(2);
      const plan = planAutonomousPersonalCaptureCompletionV4(
        fixture.input,
        fixture.graph,
        fixture.response,
        fixture.selection,
        fixture.work,
        fixture.check,
        fixture.budget,
      );

      expect(plan.kind).toBe('planned');
      if (plan.kind !== 'planned') throw new Error('Expected planned DATA');
      expect(plan.createEntities).toHaveLength(1);
      expect(plan.createEdges).toHaveLength(1);
      expect(plan.operation.terminalReceipt.kind).toBe('human_autonomous_capture_committed');
      if (plan.operation.terminalReceipt.kind !== 'human_autonomous_capture_committed')
        throw new Error('Expected occurrence receipt');
      const items = plan.operation.terminalReceipt.selection.items;
      expect(items).toHaveLength(2);
      expect(items[0]).toMatchObject({ effect: 'created', occurrenceIndex: 0 });
      expect(items[1]).toMatchObject({ effect: 'reference', occurrenceIndex: 1 });
      expect(items[0]!.claimId).toBe(items[1]!.claimId);
      expect(plan.referenceGuards).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  it('rejects a created occurrence receipt when its Claim3 pair is omitted', async () => {
    const fixture = await autonomousPersonalCompletionPlanFixtureV4();
    try {
      if (!fixture.selection) throw new Error('Expected a complete provider selection');
      const plan = planAutonomousPersonalCaptureCompletionV4(
        fixture.input,
        fixture.graph,
        fixture.response,
        fixture.selection,
        fixture.work,
        fixture.check,
        fixture.budget,
      );
      expect(plan.kind).toBe('planned');
      if (plan.kind !== 'planned') throw new Error('Expected planned DATA');
      expect(plan.createEdges).toHaveLength(1);

      const omittedPair = structuredClone(plan);
      omittedPair.createEntities = [];
      omittedPair.createEdges = [];
      expect(AutonomousPersonalCompletionPlanV4OwnedDataSchema.safeParse(omittedPair).success).toBe(
        false,
      );
    } finally {
      await fixture.close();
    }
  });

  it('enforces the frozen serialized planBytes ceiling', async () => {
    const fixture = await autonomousPersonalCompletionPlanFixtureV4();
    try {
      if (!fixture.selection) throw new Error('Expected a complete provider selection');
      const plan = planAutonomousPersonalCaptureCompletionV4(
        fixture.input,
        fixture.graph,
        fixture.response,
        fixture.selection,
        fixture.work,
        fixture.check,
        fixture.budget,
      );
      expect(plan.kind).toBe('planned');
      if (plan.kind !== 'planned') throw new Error('Expected planned DATA');
      expect(Buffer.byteLength(JSON.stringify(plan), 'utf8')).toBeLessThanOrEqual(
        AUTONOMOUS_PERSONAL_POLICY_V3_LIMITS.planBytes,
      );

      const oversized = structuredClone(plan);
      oversized.createEdges[0]!.fact = 'x'.repeat(AUTONOMOUS_PERSONAL_POLICY_V3_LIMITS.planBytes);
      const parsed = AutonomousPersonalCompletionPlanV4OwnedDataSchema.safeParse(oversized);
      expect(parsed.success).toBe(false);
      if (parsed.success) throw new Error('Expected the over-limit plan to be rejected');
      expect(parsed.error.issues.some((issue) => issue.message.includes('planBytes limit'))).toBe(
        true,
      );
    } finally {
      await fixture.close();
    }
  });

  it('falls back to a zero-prefix interpretation-capacity receipt above planBytes', async () => {
    const fixture = await autonomousPersonalCompletionPlanFixtureV4();
    try {
      if (!fixture.selection) throw new Error('Expected a complete provider selection');
      const originalByteLength = Buffer.byteLength.bind(Buffer);
      let forcedPlanByteLimit = false;
      const byteLengthSpy = jest
        .spyOn(Buffer, 'byteLength')
        .mockImplementation((value, encoding) => {
          if (
            !forcedPlanByteLimit &&
            typeof value === 'string' &&
            value.startsWith('{"kind":"planned"')
          ) {
            forcedPlanByteLimit = true;
            return AUTONOMOUS_PERSONAL_POLICY_V3_LIMITS.planBytes + 1;
          }
          return originalByteLength(value, encoding);
        });
      let plan: ReturnType<typeof planAutonomousPersonalCaptureCompletionV4>;
      try {
        plan = planAutonomousPersonalCaptureCompletionV4(
          fixture.input,
          fixture.graph,
          fixture.response,
          fixture.selection,
          fixture.work,
          fixture.check,
          fixture.budget,
        );
      } finally {
        byteLengthSpy.mockRestore();
      }

      expect(forcedPlanByteLimit).toBe(true);
      expect(plan.kind).toBe('planned');
      if (plan.kind !== 'planned') throw new Error('Expected a planned capacity fallback');
      expect(plan.createEntities).toEqual([]);
      expect(plan.createEdges).toEqual([]);
      expect(plan.referenceGuards).toEqual([]);
      expect(plan.operation.terminalReceipt.kind).toBe(
        'human_autonomous_source_deferred_committed',
      );
      if (plan.operation.terminalReceipt.kind !== 'human_autonomous_source_deferred_committed')
        throw new Error('Expected a deferred capacity receipt');
      expect(plan.operation.terminalReceipt.selection).toEqual({
        kind: 'source_only_deferred',
        reason: 'interpretation_capacity',
      });
      expect(AutonomousPersonalCompletionPlanV4OwnedDataSchema.safeParse(plan).success).toBe(true);
    } finally {
      await fixture.close();
    }
  });

  it('requires complete pre-existing reference guards with the exact receipt state', async () => {
    const content = 'I prefer concise explanations. I prefer concise explanations.';
    const first = await autonomousPersonalCompletionPlanFixtureV4({ content });
    try {
      if (!first.selection) throw new Error('Expected a complete first selection');
      const prior = planAutonomousPersonalCaptureCompletionV4(
        first.input,
        first.graph,
        first.response,
        first.selection,
        first.work,
        first.check,
        first.budget,
      );
      expect(prior.kind).toBe('planned');
      if (prior.kind !== 'planned') throw new Error('Expected prior planned DATA');
      await new Promise((resolve) => setTimeout(resolve, 10));
      const current = await autonomousPersonalCompletionPlanNextStageV4(first.store, first.seed, {
        content,
        turn: 'turn:reference-guard-joins',
      });
      try {
        const originalBytes = Buffer.byteLength(JSON.stringify(current.graph), 'utf8');
        current.graph.automatic_operations_v1!.operations =
          current.graph.automatic_operations_v1!.operations.map((operation) =>
            operation.operationId === prior.operation.operationId
              ? structuredClone(prior.operation)
              : operation,
          );
        current.graph.entities.push(...structuredClone(prior.createEntities));
        current.graph.edges.push(...structuredClone(prior.createEdges));
        const addedBytes = Buffer.byteLength(JSON.stringify(current.graph), 'utf8') - originalBytes;
        if (
          !reserveAutomaticClaimSnapshotBytes(
            getAutomaticClaimReadScope(current.budget),
            addedBytes,
          )
        )
          throw new Error('Unable to reserve synthetic creator rows');
        if (!current.selection) throw new Error('Expected a complete current selection');

        const plan = planAutonomousPersonalCaptureCompletionV4(
          current.input,
          current.graph,
          current.response,
          current.selection,
          current.work,
          current.check,
          current.budget,
        );
        expect(plan.kind).toBe('planned');
        if (plan.kind !== 'planned') throw new Error('Expected current planned DATA');
        expect(plan.referenceGuards).toHaveLength(1);
        expect(plan.referenceGuards[0]?.occurrenceIndexes).toEqual([0, 1]);
        expect(AutonomousPersonalCompletionPlanV4OwnedDataSchema.safeParse(plan).success).toBe(
          true,
        );

        const partialGuard = structuredClone(plan);
        partialGuard.referenceGuards[0]!.occurrenceIndexes = [0];
        expect(
          AutonomousPersonalCompletionPlanV4OwnedDataSchema.safeParse(partialGuard).success,
        ).toBe(false);

        const mismatchedReviewState = structuredClone(plan);
        mismatchedReviewState.referenceGuards[0]!.reviewState = 'proposed';
        expect(
          AutonomousPersonalCompletionPlanV4OwnedDataSchema.safeParse(mismatchedReviewState)
            .success,
        ).toBe(false);
      } finally {
        current.close();
      }
    } finally {
      await first.close();
    }
  });

  it('rejects a pre-existing guard attached to a claim created in the same plan', async () => {
    const fixture = await autonomousPersonalCompletionPlanFixtureV4({
      content: 'I prefer concise explanations. I prefer concise explanations.',
    });
    try {
      if (!fixture.selection) throw new Error('Expected a complete provider selection');
      const plan = planAutonomousPersonalCaptureCompletionV4(
        fixture.input,
        fixture.graph,
        fixture.response,
        fixture.selection,
        fixture.work,
        fixture.check,
        fixture.budget,
      );
      expect(plan.kind).toBe('planned');
      if (plan.kind !== 'planned') throw new Error('Expected planned DATA');
      if (plan.operation.terminalReceipt.kind !== 'human_autonomous_capture_committed')
        throw new Error('Expected occurrence receipt');
      const reference = plan.operation.terminalReceipt.selection.items.find(
        (item) => item.effect === 'reference',
      );
      if (!reference || reference.claimId === null) throw new Error('Expected same-plan reference');
      const edge = plan.createEdges.find((candidate) => candidate.uuid === reference.claimId);
      const entity = edge
        ? plan.createEntities.find((candidate) => candidate.uuid === edge.target_node_uuid)
        : undefined;
      const claim = edge?.attributes.engram_claim_v1 as { key: string } | undefined;
      if (!edge || !entity || !claim) throw new Error('Expected a created Claim3 pair');
      const forgedGuard = {
        claimId: edge.uuid,
        valueId: entity.uuid,
        sourceId: plan.operation.terminalReceipt.sourceId,
        operationId: plan.operation.operationId,
        key: claim.key,
        meaningHash: reference.meaningHash,
        reviewState: reference.state as 'accepted' | 'proposed' | 'rejected',
        occurrenceIndexes: [reference.occurrenceIndex],
        claimRowHash: '0'.repeat(64),
        valueRowHash: '0'.repeat(64),
        sourceRowHash: '0'.repeat(64),
        operationRowHash: '0'.repeat(64),
      };

      const guardedCreate = { ...plan, referenceGuards: [forgedGuard] };
      expect(AutonomousPersonalCompletionPlanV4OwnedDataSchema.safeParse(plan).success).toBe(true);
      expect(
        AutonomousPersonalCompletionPlanV4OwnedDataSchema.safeParse(guardedCreate).success,
      ).toBe(false);
    } finally {
      await fixture.close();
    }
  });

  it.each([
    'I prefer concise explanations. I prefer long explanations.',
    'I prefer long explanations. I prefer concise explanations.',
  ])(
    'withholds both possible-overlap creates symmetrically for source order %s',
    async (content) => {
      const fixture = await autonomousPersonalCompletionPlanFixtureV4({ content });
      try {
        if (!fixture.selection) throw new Error('Expected a complete provider selection');
        expect(fixture.selection.occurrences).toHaveLength(2);
        const plan = planAutonomousPersonalCaptureCompletionV4(
          fixture.input,
          fixture.graph,
          fixture.response,
          fixture.selection,
          fixture.work,
          fixture.check,
          fixture.budget,
        );

        expect(plan.kind).toBe('planned');
        if (plan.kind !== 'planned') throw new Error('Expected planned DATA');
        expect(plan.createEntities).toEqual([]);
        expect(plan.createEdges).toEqual([]);
        expect(plan.operation.terminalReceipt.kind).toBe('human_autonomous_capture_committed');
        if (plan.operation.terminalReceipt.kind !== 'human_autonomous_capture_committed')
          throw new Error('Expected occurrence receipt');
        expect(plan.operation.terminalReceipt.selection.items).toHaveLength(2);
        expect(plan.operation.terminalReceipt.selection.items.map((item) => item.reason)).toEqual([
          'possible_overlap',
          'possible_overlap',
        ]);
      } finally {
        await fixture.close();
      }
    },
  );

  it('creates proposed rows under reviewFirst without promoting them to accepted', async () => {
    const fixture = await autonomousPersonalCompletionPlanFixtureV4({ profile: 'reviewFirst' });
    try {
      if (!fixture.selection) throw new Error('Expected a complete provider selection');
      const plan = planAutonomousPersonalCaptureCompletionV4(
        fixture.input,
        fixture.graph,
        fixture.response,
        fixture.selection,
        fixture.work,
        fixture.check,
        fixture.budget,
      );

      expect(plan.kind).toBe('planned');
      if (plan.kind !== 'planned') throw new Error('Expected planned DATA');
      expect(plan.createEntities[0]?.attributes.engram_extraction).toMatchObject({
        review_status: 'proposed',
        threshold_decision: 'pending_review',
      });
      expect(plan.createEdges[0]?.attributes.engram_extraction).toMatchObject({
        review_status: 'proposed',
        threshold_decision: 'pending_review',
      });
      expect(plan.operation.terminalReceipt.kind).toBe('human_autonomous_capture_committed');
      if (plan.operation.terminalReceipt.kind !== 'human_autonomous_capture_committed')
        throw new Error('Expected occurrence receipt');
      expect(plan.operation.terminalReceipt.selection.items[0]).toMatchObject({
        state: 'proposed',
        effect: 'created',
        reason: 'profile_review_required',
      });
    } finally {
      await fixture.close();
    }
  });

  it('uses the exact no-dispatch policy verdict and creates no claim rows', async () => {
    const fixture = await autonomousPersonalCompletionPlanFixtureV4({
      profile: 'explicit',
      intent: 'disabled',
    });
    try {
      expect(fixture.input.outcome).toEqual({ kind: 'no_dispatch', reason: 'policy_not_selected' });
      const plan = planAutonomousPersonalCaptureCompletionV4(
        fixture.input,
        fixture.graph,
        null,
        null,
        fixture.work,
        fixture.check,
        fixture.budget,
      );

      expect(plan.kind).toBe('planned');
      if (plan.kind !== 'planned') throw new Error('Expected planned DATA');
      expect(plan.createEntities).toEqual([]);
      expect(plan.createEdges).toEqual([]);
      expect(plan.referenceGuards).toEqual([]);
      expect(plan.operation.terminalReceipt.kind).toBe('human_autonomous_source_verdict_committed');
      if (plan.operation.terminalReceipt.kind !== 'human_autonomous_source_verdict_committed')
        throw new Error('Expected source verdict');
      expect(plan.operation.terminalReceipt.selection).toEqual({
        kind: 'source_verdict',
        outcome: 'policy_not_selected',
      });
    } finally {
      await fixture.close();
    }
  });

  it.each([
    {
      content: '',
      reason: 'empty_source',
      receipt: { kind: 'human_autonomous_source_verdict_committed', outcome: 'known_no_memory' },
    },
    {
      content: 'I adore jazz. "unfinished',
      reason: 'source_indeterminate',
      receipt: { kind: 'human_autonomous_source_verdict_committed', outcome: 'unknown_source' },
    },
  ] as const)(
    'maps no-dispatch $reason to its source-only receipt',
    async ({ content, reason, receipt: expectedReceipt }) => {
      const fixture = await autonomousPersonalCompletionPlanFixtureV4({ content });
      try {
        expect(fixture.input.outcome).toEqual({ kind: 'no_dispatch', reason });
        const plan = planAutonomousPersonalCaptureCompletionV4(
          fixture.input,
          fixture.graph,
          null,
          null,
          fixture.work,
          fixture.check,
          fixture.budget,
        );
        expect(plan.kind).toBe('planned');
        if (plan.kind !== 'planned') throw new Error('Expected planned DATA');
        expect(plan.createEntities).toEqual([]);
        expect(plan.createEdges).toEqual([]);
        expect(plan.referenceGuards).toEqual([]);
        expect(plan.operation.terminalReceipt).toMatchObject({
          kind: expectedReceipt.kind,
          selection: { kind: 'source_verdict', outcome: expectedReceipt.outcome },
        });
      } finally {
        await fixture.close();
      }
    },
  );

  it('retains provider deferred reasons as zero-row source-only terminal candidates', async () => {
    const fixture = await autonomousPersonalCompletionPlanFixtureV4({ providerAuthFailure: true });
    try {
      expect(fixture.input.outcome).toEqual({ kind: 'deferred', reason: 'provider_auth' });
      const plan = planAutonomousPersonalCaptureCompletionV4(
        fixture.input,
        fixture.graph,
        null,
        null,
        fixture.work,
        fixture.check,
        fixture.budget,
      );

      expect(plan.kind).toBe('planned');
      if (plan.kind !== 'planned') throw new Error('Expected planned DATA');
      expect(plan.createEntities).toEqual([]);
      expect(plan.createEdges).toEqual([]);
      expect(plan.referenceGuards).toEqual([]);
      expect(plan.operation.terminalReceipt.kind).toBe(
        'human_autonomous_source_deferred_committed',
      );
      if (plan.operation.terminalReceipt.kind !== 'human_autonomous_source_deferred_committed')
        throw new Error('Expected deferred receipt');
      expect(plan.operation.terminalReceipt.selection).toEqual({
        kind: 'source_only_deferred',
        reason: 'provider_auth',
      });
    } finally {
      await fixture.close();
    }
  });

  it('rejects a changed retained selector report as whole no-write and preserves graph DATA', async () => {
    const fixture = await autonomousPersonalCompletionPlanFixtureV4();
    try {
      if (!fixture.selection) throw new Error('Expected a complete provider selection');
      const before = JSON.stringify(fixture.graph);
      const forged = structuredClone(fixture.selection);
      forged.occurrences[0]!.evidenceHash = '0'.repeat(64);
      const plan = planAutonomousPersonalCaptureCompletionV4(
        fixture.input,
        fixture.graph,
        fixture.response,
        forged,
        fixture.work,
        fixture.check,
        fixture.budget,
      );

      expect(plan).toEqual({ kind: 'no_write', reason: 'conflict' });
      expect(JSON.stringify(fixture.graph)).toBe(before);
    } finally {
      await fixture.close();
    }
  });

  it('maps a genuine source unit limit to zero-prefix interpretation-capacity fallback', async () => {
    const content = Array.from({ length: 33 }, (_, index) => `I prefer option ${index}.`).join(' ');
    const fixture = await autonomousPersonalCompletionPlanFixtureV4({ content });
    try {
      expect(fixture.input.outcome).toEqual({ kind: 'no_dispatch', reason: 'unit_count' });
      const plan = planAutonomousPersonalCaptureCompletionV4(
        fixture.input,
        fixture.graph,
        null,
        null,
        fixture.work,
        fixture.check,
        fixture.budget,
      );

      expect(plan.kind).toBe('planned');
      if (plan.kind !== 'planned') throw new Error('Expected planned DATA');
      expect(plan.createEntities).toEqual([]);
      expect(plan.createEdges).toEqual([]);
      expect(plan.referenceGuards).toEqual([]);
      expect(plan.operation.terminalReceipt.kind).toBe(
        'human_autonomous_source_deferred_committed',
      );
      if (plan.operation.terminalReceipt.kind !== 'human_autonomous_source_deferred_committed')
        throw new Error('Expected deferred receipt');
      expect(plan.operation.terminalReceipt.selection).toEqual({
        kind: 'source_only_deferred',
        reason: 'interpretation_capacity',
      });
    } finally {
      await fixture.close();
    }
  });

  it('maps a scanner resource stop to a zero-row interpretation-capacity receipt', async () => {
    const content = Array.from({ length: 8193 }, () => 'I').join(' ');
    const fixture = await autonomousPersonalCompletionPlanFixtureV4({ content });
    try {
      expect(fixture.input.outcome).toEqual({ kind: 'no_dispatch', reason: 'source_resource' });
      const plan = planAutonomousPersonalCaptureCompletionV4(
        fixture.input,
        fixture.graph,
        null,
        null,
        fixture.work,
        fixture.check,
        fixture.budget,
      );
      expect(plan.kind).toBe('planned');
      if (plan.kind !== 'planned') throw new Error('Expected planned DATA');
      expect(plan.createEntities).toEqual([]);
      expect(plan.createEdges).toEqual([]);
      expect(plan.referenceGuards).toEqual([]);
      expect(plan.operation.terminalReceipt.kind).toBe(
        'human_autonomous_source_deferred_committed',
      );
      if (plan.operation.terminalReceipt.kind !== 'human_autonomous_source_deferred_committed')
        throw new Error('Expected a deferred receipt');
      expect(plan.operation.terminalReceipt.selection).toEqual({
        kind: 'source_only_deferred',
        reason: 'interpretation_capacity',
      });
    } finally {
      await fixture.close();
    }
  });

  it('protects a cross-date untyped preference statement created under ReviewFirst', async () => {
    const literal = 'I had a lovely weekend.';
    const first = await autonomousPersonalCompletionPlanFixtureV4({
      content: literal,
      profile: 'reviewFirst',
    });
    try {
      if (!first.selection) throw new Error('Expected a complete ReviewFirst selection');
      const priorPlan = planAutonomousPersonalCaptureCompletionV4(
        first.input,
        first.graph,
        first.response,
        first.selection,
        first.work,
        first.check,
        first.budget,
      );
      expect(priorPlan.kind).toBe('planned');
      if (priorPlan.kind !== 'planned') throw new Error('Expected prior planned DATA');
      expect(priorPlan.createEdges).toHaveLength(1);
      expect(priorPlan.createEdges[0]?.attributes.engram_claim_v1).toMatchObject({
        kind: 'source_statement_record',
        interpretation: { category: 'preference' },
      });
      expect(priorPlan.createEdges[0]?.attributes.engram_extraction).toMatchObject({
        review_status: 'proposed',
      });

      await new Promise((resolve) => setTimeout(resolve, 10));
      const current = await autonomousPersonalCompletionPlanNextStageV4(first.store, first.seed, {
        content: literal,
        profile: 'conservative',
        executionId: 'execution:next',
        turn: 'turn:next',
      });
      try {
        const originalSnapshotBytes = Buffer.byteLength(JSON.stringify(current.graph), 'utf8');
        current.graph.automatic_operations_v1!.operations =
          current.graph.automatic_operations_v1!.operations.map((operation) =>
            operation.operationId === priorPlan.operation.operationId
              ? structuredClone(priorPlan.operation)
              : operation,
          );
        current.graph.entities.push(...structuredClone(priorPlan.createEntities));
        current.graph.edges.push(...structuredClone(priorPlan.createEdges));
        const addedBytes =
          Buffer.byteLength(JSON.stringify(current.graph), 'utf8') - originalSnapshotBytes;
        if (
          addedBytes > 0 &&
          !reserveAutomaticClaimSnapshotBytes(
            getAutomaticClaimReadScope(current.budget),
            addedBytes,
          )
        )
          throw new Error('Unable to reserve synthetic creator rows');

        if (!current.selection) throw new Error('Expected a complete conservative selection');
        const plan = planAutonomousPersonalCaptureCompletionV4(
          current.input,
          current.graph,
          current.response,
          current.selection,
          current.work,
          current.check,
          current.budget,
        );

        expect(plan.kind).toBe('planned');
        if (plan.kind !== 'planned') throw new Error('Expected current planned DATA');
        expect(plan.createEntities).toEqual([]);
        expect(plan.createEdges).toEqual([]);
        expect(plan.operation.terminalReceipt.kind).toBe('human_autonomous_capture_committed');
        if (plan.operation.terminalReceipt.kind !== 'human_autonomous_capture_committed')
          throw new Error('Expected occurrence receipt');
        expect(plan.operation.terminalReceipt.selection.items[0]).toMatchObject({
          state: 'not_selected',
          effect: 'none',
          reason: 'existing_ineligible',
        });
      } finally {
        current.close();
      }
    } finally {
      await first.close();
    }
  });

  it.each(['conservative', 'reviewFirst'] as const)(
    'preserves exact qualified %s references with direct whole-row guards',
    async (profile) => {
      const content = 'I prefer concise explanations.';
      const first = await autonomousPersonalCompletionPlanFixtureV4({ content, profile });
      try {
        if (!first.selection) throw new Error('Expected a complete first selection');
        const prior = planAutonomousPersonalCaptureCompletionV4(
          first.input,
          first.graph,
          first.response,
          first.selection,
          first.work,
          first.check,
          first.budget,
        );
        expect(prior.kind).toBe('planned');
        if (prior.kind !== 'planned') throw new Error('Expected prior planned DATA');
        expect(prior.createEdges).toHaveLength(1);

        await new Promise((resolve) => setTimeout(resolve, 10));
        const current = await autonomousPersonalCompletionPlanNextStageV4(first.store, first.seed, {
          content,
          profile: 'conservative',
          turn: `turn:exact-reference:${profile}`,
        });
        try {
          const originalBytes = Buffer.byteLength(JSON.stringify(current.graph), 'utf8');
          current.graph.automatic_operations_v1!.operations =
            current.graph.automatic_operations_v1!.operations.map((operation) =>
              operation.operationId === prior.operation.operationId
                ? structuredClone(prior.operation)
                : operation,
            );
          current.graph.entities.push(...structuredClone(prior.createEntities));
          current.graph.edges.push(...structuredClone(prior.createEdges));
          const addedBytes =
            Buffer.byteLength(JSON.stringify(current.graph), 'utf8') - originalBytes;
          if (
            !reserveAutomaticClaimSnapshotBytes(
              getAutomaticClaimReadScope(current.budget),
              addedBytes,
            )
          )
            throw new Error('Unable to reserve synthetic creator rows');

          if (!current.selection) throw new Error('Expected a complete current selection');
          const plan = planAutonomousPersonalCaptureCompletionV4(
            current.input,
            current.graph,
            current.response,
            current.selection,
            current.work,
            current.check,
            current.budget,
          );
          expect(plan.kind).toBe('planned');
          if (plan.kind !== 'planned') throw new Error('Expected current planned DATA');
          expect(plan.createEntities).toEqual([]);
          expect(plan.createEdges).toEqual([]);
          expect(plan.referenceGuards).toHaveLength(1);
          const guard = plan.referenceGuards[0]!;
          const claim = current.graph.edges.find((row) => row.uuid === guard.claimId)!;
          const value = current.graph.entities.find((row) => row.uuid === guard.valueId)!;
          const source = current.graph.episodes.find((row) => row.uuid === guard.sourceId)!;
          const operation = current.graph.automatic_operations_v1!.operations.find(
            (row) => row.operationId === guard.operationId,
          )!;
          expect(guard.claimRowHash).toBe(hashAutomaticCaptureV2(claim));
          expect(guard.valueRowHash).toBe(hashAutomaticCaptureV2(value));
          expect(guard.sourceRowHash).toBe(hashAutomaticCaptureV2(source));
          expect(guard.operationRowHash).toBe(hashAutomaticCaptureV2(operation));
          expect(plan.operation.terminalReceipt.kind).toBe('human_autonomous_capture_committed');
          if (plan.operation.terminalReceipt.kind !== 'human_autonomous_capture_committed')
            throw new Error('Expected occurrence receipt');
          expect(plan.operation.terminalReceipt.selection.items[0]).toMatchObject({
            state: profile === 'reviewFirst' ? 'proposed' : 'accepted',
            effect: 'reference',
            reason: profile === 'reviewFirst' ? 'existing_proposed' : 'existing_accepted',
          });
        } finally {
          current.close();
        }
      } finally {
        await first.close();
      }
    },
  );

  // Three real stage fixtures share one Jest timer; each retains its 5s work deadline.
  it('keeps overlapping exact references separate in the shared stored-relation cap', async () => {
    const first = await autonomousPersonalCompletionPlanFixtureV4({
      content: 'I prefer English.',
      profile: 'reviewFirst',
      turn: 'turn:reference-union:english',
    });
    try {
      if (!first.selection) throw new Error('Expected a complete English selection');
      const englishPlan = planAutonomousPersonalCaptureCompletionV4(
        first.input,
        first.graph,
        first.response,
        first.selection,
        first.work,
        first.check,
        first.budget,
      );
      expect(englishPlan.kind).toBe('planned');
      if (englishPlan.kind !== 'planned') throw new Error('Expected English planned DATA');
      expect(englishPlan.createEdges).toHaveLength(1);
      expect(englishPlan.operation.terminalReceipt.kind).toBe('human_autonomous_capture_committed');

      await new Promise((resolve) => setTimeout(resolve, 10));
      const frenchStage = await autonomousPersonalCompletionPlanNextStageV4(
        first.store,
        first.seed,
        {
          content: 'I prefer French.',
          turn: 'turn:reference-union:french',
        },
      );
      let frenchPlan: PlannedCompletion;
      try {
        if (!frenchStage.selection) throw new Error('Expected a complete French selection');
        const result = planAutonomousPersonalCaptureCompletionV4(
          frenchStage.input,
          frenchStage.graph,
          frenchStage.response,
          frenchStage.selection,
          frenchStage.work,
          frenchStage.check,
          frenchStage.budget,
        );
        expect(result.kind).toBe('planned');
        if (result.kind !== 'planned') throw new Error('Expected French planned DATA');
        expect(result.createEdges).toHaveLength(1);
        frenchPlan = result;
      } finally {
        frenchStage.close();
      }

      await new Promise((resolve) => setTimeout(resolve, 10));
      const current = await autonomousPersonalCompletionPlanNextStageV4(first.store, first.seed, {
        content: 'I prefer English. I prefer French.',
        turn: 'turn:reference-union:both',
      });
      try {
        appendPriorPlanRows(current, englishPlan);
        appendPriorPlanRows(current, frenchPlan);
        appendLegacyCandidatesAndReserve(current, 7);
        if (!current.selection) throw new Error('Expected complete two-language selection');
        expect(current.selection.occurrences).toHaveLength(2);
        const plan = planAutonomousPersonalCaptureCompletionV4(
          current.input,
          current.graph,
          current.response,
          current.selection,
          current.work,
          current.check,
          current.budget,
        );
        expect(plan.kind).toBe('planned');
        if (plan.kind !== 'planned') throw new Error('Expected both qualified references');
        expect(plan.createEntities).toEqual([]);
        expect(plan.createEdges).toEqual([]);
        expect(plan.referenceGuards).toHaveLength(2);
        expect(plan.referenceGuards.map((guard) => guard.reviewState)).toEqual([
          'proposed',
          'accepted',
        ]);
        expect(plan.operation.terminalReceipt.kind).toBe('human_autonomous_capture_committed');
        if (plan.operation.terminalReceipt.kind !== 'human_autonomous_capture_committed')
          throw new Error('Expected occurrence receipt');
        expect(plan.operation.terminalReceipt.selection.items).toMatchObject([
          { state: 'proposed', effect: 'reference', reason: 'existing_proposed' },
          { state: 'accepted', effect: 'reference', reason: 'existing_accepted' },
        ]);
      } finally {
        current.close();
      }
    } finally {
      await first.close();
    }
  }, 20_000);

  it('preserves a manually rejected exact reference and its review pair', async () => {
    const content = 'I prefer concise explanations.';
    const first = await autonomousPersonalCompletionPlanFixtureV4({ content });
    try {
      if (!first.selection) throw new Error('Expected a complete first selection');
      const prior = planAutonomousPersonalCaptureCompletionV4(
        first.input,
        first.graph,
        first.response,
        first.selection,
        first.work,
        first.check,
        first.budget,
      );
      expect(prior.kind).toBe('planned');
      if (prior.kind !== 'planned') throw new Error('Expected prior planned DATA');

      await new Promise((resolve) => setTimeout(resolve, 10));
      const current = await autonomousPersonalCompletionPlanNextStageV4(first.store, first.seed, {
        content,
        turn: 'turn:rejected-reference',
      });
      try {
        const originalBytes = Buffer.byteLength(JSON.stringify(current.graph), 'utf8');
        current.graph.automatic_operations_v1!.operations =
          current.graph.automatic_operations_v1!.operations.map((operation) =>
            operation.operationId === prior.operation.operationId
              ? structuredClone(prior.operation)
              : operation,
          );
        const reviewedAt = current.input.backendNow;
        const rejectedEntities = structuredClone(prior.createEntities);
        const rejectedEdges = structuredClone(prior.createEdges);
        for (const row of [...rejectedEntities, ...rejectedEdges]) {
          row.updated_at = reviewedAt;
          row.attributes.engram_extraction = {
            ...(row.attributes.engram_extraction as Record<string, unknown>),
            review_status: 'rejected',
            threshold_decision: 'manually_reviewed',
            reviewed_at: reviewedAt,
            reviewed_by: 'reviewer:fixture',
          };
        }
        current.graph.entities.push(...rejectedEntities);
        current.graph.edges.push(...rejectedEdges);
        const addedBytes = Buffer.byteLength(JSON.stringify(current.graph), 'utf8') - originalBytes;
        if (
          !reserveAutomaticClaimSnapshotBytes(
            getAutomaticClaimReadScope(current.budget),
            addedBytes,
          )
        )
          throw new Error('Unable to reserve synthetic rejected rows');

        if (!current.selection) throw new Error('Expected a complete current selection');
        const plan = planAutonomousPersonalCaptureCompletionV4(
          current.input,
          current.graph,
          current.response,
          current.selection,
          current.work,
          current.check,
          current.budget,
        );
        expect(plan.kind).toBe('planned');
        if (plan.kind !== 'planned') throw new Error('Expected current planned DATA');
        expect(plan.createEntities).toEqual([]);
        expect(plan.createEdges).toEqual([]);
        expect(plan.referenceGuards).toHaveLength(1);
        expect(plan.referenceGuards[0]?.reviewState).toBe('rejected');
        expect(plan.operation.terminalReceipt.kind).toBe('human_autonomous_capture_committed');
        if (plan.operation.terminalReceipt.kind !== 'human_autonomous_capture_committed')
          throw new Error('Expected occurrence receipt');
        expect(plan.operation.terminalReceipt.selection.items[0]).toMatchObject({
          state: 'rejected',
          effect: 'reference',
          reason: 'existing_rejected',
        });
      } finally {
        current.close();
      }
    } finally {
      await first.close();
    }
  });

  it('counts legacy relations for a qualified typed reference and stops above the old eight cap', async () => {
    const content = 'I prefer concise explanations.';
    const first = await autonomousPersonalCompletionPlanFixtureV4({
      content,
      profile: 'reviewFirst',
    });
    try {
      if (!first.selection) throw new Error('Expected a complete ReviewFirst selection');
      const prior = planAutonomousPersonalCaptureCompletionV4(
        first.input,
        first.graph,
        first.response,
        first.selection,
        first.work,
        first.check,
        first.budget,
      );
      expect(prior.kind).toBe('planned');
      if (prior.kind !== 'planned') throw new Error('Expected a prior planned creator');
      expect(prior.createEdges).toHaveLength(1);

      await new Promise((resolve) => setTimeout(resolve, 10));
      const current = await autonomousPersonalCompletionPlanNextStageV4(first.store, first.seed, {
        content,
        profile: 'conservative',
        turn: 'turn:reference-cap',
      });
      try {
        const originalBytes = Buffer.byteLength(JSON.stringify(current.graph), 'utf8');
        current.graph.automatic_operations_v1!.operations =
          current.graph.automatic_operations_v1!.operations.map((operation) =>
            operation.operationId === prior.operation.operationId
              ? structuredClone(prior.operation)
              : operation,
          );
        current.graph.entities.push(...structuredClone(prior.createEntities));
        current.graph.edges.push(...structuredClone(prior.createEdges));
        const identity = current.input.scope.context;
        appendManualLegacyPreferenceCandidatesV4(
          current.graph,
          identity.namespace,
          identity.binding.subjectId,
          9,
        );
        const addedBytes = Buffer.byteLength(JSON.stringify(current.graph), 'utf8') - originalBytes;
        if (
          !reserveAutomaticClaimSnapshotBytes(
            getAutomaticClaimReadScope(current.budget),
            addedBytes,
          )
        )
          throw new Error('Unable to reserve synthetic legacy rows');

        if (!current.selection) throw new Error('Expected a complete current selection');
        const plan = planAutonomousPersonalCaptureCompletionV4(
          current.input,
          current.graph,
          current.response,
          current.selection,
          current.work,
          current.check,
          current.budget,
        );
        expect(plan).toEqual({ kind: 'no_write', reason: 'inspection_incomplete' });
      } finally {
        current.close();
      }
    } finally {
      await first.close();
    }
  });

  it('allows the exact eight relevant legacy relations limit', async () => {
    const fixture = await autonomousPersonalCompletionPlanFixtureV4();
    try {
      const identity = fixture.input.scope.context;
      const beforeBytes = Buffer.byteLength(JSON.stringify(fixture.graph), 'utf8');
      appendManualLegacyPreferenceCandidatesV4(
        fixture.graph,
        identity.namespace,
        identity.binding.subjectId,
        8,
      );
      const addedBytes = Buffer.byteLength(JSON.stringify(fixture.graph), 'utf8') - beforeBytes;
      if (
        !reserveAutomaticClaimSnapshotBytes(getAutomaticClaimReadScope(fixture.budget), addedBytes)
      )
        throw new Error('Unable to reserve synthetic legacy candidates');

      if (!fixture.selection) throw new Error('Expected a complete provider selection');
      const plan = planAutonomousPersonalCaptureCompletionV4(
        fixture.input,
        fixture.graph,
        fixture.response,
        fixture.selection,
        fixture.work,
        fixture.check,
        fixture.budget,
      );
      expect(plan.kind).toBe('planned');
      if (plan.kind !== 'planned') throw new Error('Expected a complete planned result');
      expect(plan.createEntities).toEqual([]);
      expect(plan.createEdges).toEqual([]);
      expect(plan.operation.terminalReceipt.kind).toBe('human_autonomous_capture_committed');
      if (plan.operation.terminalReceipt.kind !== 'human_autonomous_capture_committed')
        throw new Error('Expected occurrence receipt');
      expect(plan.operation.terminalReceipt.selection.items[0]).toMatchObject({
        effect: 'none',
        reason: 'unknown_overlap_domain',
      });
    } finally {
      await fixture.close();
    }
  });

  it('keeps more than eight qualified family4 creators outside the legacy relation cap', async () => {
    const content = [
      'I had a lovely weekend.',
      'I enjoyed a nice lunch.',
      'I moved the blue chair.',
      'I found the book I needed.',
      'I attended the meeting on Tuesday.',
      'I visited my sister.',
      'I started a new project.',
      'I watched a great film.',
      'I cooked pasta for dinner.',
    ].join(' ');
    const first = await autonomousPersonalCompletionPlanFixtureV4({ content });
    try {
      if (!first.selection) throw new Error('Expected a complete first selection');
      const prior = planAutonomousPersonalCaptureCompletionV4(
        first.input,
        first.graph,
        first.response,
        first.selection,
        first.work,
        first.check,
        first.budget,
      );
      expect(prior.kind).toBe('planned');
      if (prior.kind !== 'planned') throw new Error('Expected a prior planned candidate');
      expect(prior.createEdges.length).toBeGreaterThan(8);

      await new Promise((resolve) => setTimeout(resolve, 10));
      const current = await autonomousPersonalCompletionPlanNextStageV4(first.store, first.seed, {
        content,
        profile: 'conservative',
        turn: 'turn:family4-cap',
      });
      try {
        const originalBytes = Buffer.byteLength(JSON.stringify(current.graph), 'utf8');
        current.graph.automatic_operations_v1!.operations =
          current.graph.automatic_operations_v1!.operations.map((operation) =>
            operation.operationId === prior.operation.operationId
              ? structuredClone(prior.operation)
              : operation,
          );
        current.graph.entities.push(...structuredClone(prior.createEntities));
        current.graph.edges.push(...structuredClone(prior.createEdges));
        const addedBytes = Buffer.byteLength(JSON.stringify(current.graph), 'utf8') - originalBytes;
        if (
          !reserveAutomaticClaimSnapshotBytes(
            getAutomaticClaimReadScope(current.budget),
            addedBytes,
          )
        )
          throw new Error('Unable to reserve synthetic family4 rows');

        if (!current.selection) throw new Error('Expected a complete current selection');
        const plan = planAutonomousPersonalCaptureCompletionV4(
          current.input,
          current.graph,
          current.response,
          current.selection,
          current.work,
          current.check,
          current.budget,
        );
        expect(plan.kind).toBe('planned');
        if (plan.kind !== 'planned') throw new Error('Expected current planned DATA');
        expect(plan.createEdges.length).toBeGreaterThan(8);
        expect(plan.referenceGuards).toEqual([]);
        expect(plan.operation.terminalReceipt.kind).toBe('human_autonomous_capture_committed');
        if (plan.operation.terminalReceipt.kind !== 'human_autonomous_capture_committed')
          throw new Error('Expected occurrence receipt');
      } finally {
        current.close();
      }
    } finally {
      await first.close();
    }
  });

  it('keeps the unchanged 128 legacy candidate ceiling after family4 classification', async () => {
    const fixture = await autonomousPersonalCompletionPlanFixtureV4();
    try {
      const beforeBytes = Buffer.byteLength(JSON.stringify(fixture.graph), 'utf8');
      const identity = fixture.input.scope.context;
      appendManualLegacyPreferenceCandidatesV4(
        fixture.graph,
        identity.namespace,
        identity.binding.subjectId,
        129,
      );
      const addedBytes = Buffer.byteLength(JSON.stringify(fixture.graph), 'utf8') - beforeBytes;
      if (
        !reserveAutomaticClaimSnapshotBytes(getAutomaticClaimReadScope(fixture.budget), addedBytes)
      )
        throw new Error('Unable to reserve synthetic legacy candidates');

      if (!fixture.selection) throw new Error('Expected a complete provider selection');
      const plan = planAutonomousPersonalCaptureCompletionV4(
        fixture.input,
        fixture.graph,
        fixture.response,
        fixture.selection,
        fixture.work,
        fixture.check,
        fixture.budget,
      );

      expect(plan).toEqual({ kind: 'no_write', reason: 'inspection_incomplete' });
    } finally {
      await fixture.close();
    }
  });

  it.each([
    { legacyCount: 120, expected: 'planned' },
    { legacyCount: 121, expected: 'inspection_incomplete' },
  ] as const)(
    'counts the 128 candidateProjections ceiling across eight family4 rows and $legacyCount legacy rows',
    async ({ legacyCount, expected }) => {
      const first = await autonomousPersonalCompletionPlanFixtureV4({
        content: unrelatedStatementContent,
      });
      try {
        if (!first.selection) throw new Error('Expected a complete first selection');
        const prior = planAutonomousPersonalCaptureCompletionV4(
          first.input,
          first.graph,
          first.response,
          first.selection,
          first.work,
          first.check,
          first.budget,
        );
        expect(prior.kind).toBe('planned');
        if (prior.kind !== 'planned') throw new Error('Expected prior planned DATA');
        expect(prior.createEdges).toHaveLength(8);

        await new Promise((resolve) => setTimeout(resolve, 10));
        const current = await autonomousPersonalCompletionPlanNextStageV4(first.store, first.seed, {
          content: 'I had a lovely weekend.',
          turn: `turn:mixed-candidates-${legacyCount}`,
        });
        try {
          appendPriorPlanRows(current, prior);
          appendLegacyCandidatesAndReserve(current, legacyCount);
          const identity = current.input.scope.context;
          const candidates = current.graph.edges.filter(
            (edge) =>
              edge.group_id === identity.namespace &&
              edge.source_node_uuid === identity.binding.subjectId &&
              (edge.name === 'PREFERS' ||
                Object.prototype.hasOwnProperty.call(edge.attributes, 'engram_claim_v1')),
          );
          expect(new Set(candidates.map((edge) => edge.uuid)).size).toBe(8 + legacyCount);
          if (!current.selection) throw new Error('Expected a complete current selection');
          const plan = planAutonomousPersonalCaptureCompletionV4(
            current.input,
            current.graph,
            current.response,
            current.selection,
            current.work,
            current.check,
            current.budget,
          );
          if (expected === 'inspection_incomplete') {
            expect(plan).toEqual({ kind: 'no_write', reason: expected });
          } else {
            expect(plan.kind).toBe(expected);
            if (plan.kind !== 'planned') throw new Error('Expected a bounded planned statement');
            expect(plan.createEdges).toHaveLength(1);
            expect(plan.referenceGuards).toEqual([]);
          }
        } finally {
          current.close();
        }
      } finally {
        await first.close();
      }
    },
  );

  it.each([
    { legacyCount: 7, expected: 'planned' },
    { legacyCount: 8, expected: 'inspection_incomplete' },
  ] as const)(
    'unions the eight per-meaning stored relation limit across a qualified reference and $legacyCount legacy rows',
    async ({ legacyCount, expected }) => {
      const first = await autonomousPersonalCompletionPlanFixtureV4({
        content: 'I prefer concise explanations.',
      });
      try {
        if (!first.selection) throw new Error('Expected a complete first selection');
        const prior = planAutonomousPersonalCaptureCompletionV4(
          first.input,
          first.graph,
          first.response,
          first.selection,
          first.work,
          first.check,
          first.budget,
        );
        expect(prior.kind).toBe('planned');
        if (prior.kind !== 'planned') throw new Error('Expected prior planned DATA');
        expect(prior.createEdges).toHaveLength(1);

        await new Promise((resolve) => setTimeout(resolve, 10));
        const repeatedContent = 'I prefer concise explanations. I prefer concise explanations.';
        const current = await autonomousPersonalCompletionPlanNextStageV4(first.store, first.seed, {
          content: repeatedContent,
          turn: `turn:mixed-relations-${legacyCount}`,
        });
        try {
          appendPriorPlanRows(current, prior);
          appendLegacyCandidatesAndReserve(current, legacyCount);
          if (!current.selection) throw new Error('Expected a complete current selection');
          expect(current.selection.occurrences).toHaveLength(2);
          const plan = planAutonomousPersonalCaptureCompletionV4(
            current.input,
            current.graph,
            current.response,
            current.selection,
            current.work,
            current.check,
            current.budget,
          );
          if (expected === 'inspection_incomplete') {
            expect(plan).toEqual({ kind: 'no_write', reason: expected });
          } else {
            expect(plan.kind).toBe(expected);
            if (plan.kind !== 'planned') throw new Error('Expected a complete reference plan');
            expect(plan.createEdges).toEqual([]);
            expect(plan.referenceGuards).toHaveLength(1);
            expect(plan.referenceGuards[0]?.occurrenceIndexes).toEqual([0, 1]);
            expect(plan.operation.terminalReceipt.kind).toBe('human_autonomous_capture_committed');
            if (plan.operation.terminalReceipt.kind !== 'human_autonomous_capture_committed')
              throw new Error('Expected occurrence receipt');
            expect(plan.operation.terminalReceipt.selection.items).toMatchObject([
              { effect: 'reference', claimId: prior.createEdges[0]?.uuid },
              { effect: 'reference', claimId: prior.createEdges[0]?.uuid },
            ]);
          }
        } finally {
          current.close();
        }
      } finally {
        await first.close();
      }
    },
  );

  it('allows exactly 128 shared conflicts across typed incoming pairs and unknown legacy relations', async () => {
    const fixture = await autonomousPersonalCompletionPlanFixtureV4({
      content: sharedCounterTypedContent,
    });
    try {
      expect(fixture.selection?.occurrences).toHaveLength(15);
      appendLegacyCandidatesAndReserve(fixture, 6);
      const plan = planAutonomousPersonalCaptureCompletionV4(
        fixture.input,
        fixture.graph,
        fixture.response,
        fixture.selection,
        fixture.work,
        fixture.check,
        fixture.budget,
      );
      expect(plan.kind).toBe('planned');
      if (plan.kind !== 'planned') throw new Error('Expected the exact-limit planned result');
      expect(plan.createEdges).toEqual([]);
      expect(plan.referenceGuards).toEqual([]);
      expect(plan.operation.terminalReceipt.kind).toBe('human_autonomous_capture_committed');
      if (plan.operation.terminalReceipt.kind !== 'human_autonomous_capture_committed')
        throw new Error('Expected occurrence receipt');
      expect(plan.operation.terminalReceipt.selection.items).toHaveLength(15);
      expect(
        plan.operation.terminalReceipt.selection.items.every((item) => item.effect === 'none'),
      ).toBe(true);
    } finally {
      await fixture.close();
    }
  });

  it('stops at 129 shared conflicts when a qualified reference adds the final stored relation', async () => {
    const first = await autonomousPersonalCompletionPlanFixtureV4({
      content: 'I prefer fewer emojis.',
    });
    try {
      if (!first.selection) throw new Error('Expected a complete emoji selection');
      const prior = planAutonomousPersonalCaptureCompletionV4(
        first.input,
        first.graph,
        first.response,
        first.selection,
        first.work,
        first.check,
        first.budget,
      );
      expect(prior.kind).toBe('planned');
      if (prior.kind !== 'planned') throw new Error('Expected prior planned DATA');
      expect(prior.createEdges).toHaveLength(1);

      await new Promise((resolve) => setTimeout(resolve, 10));
      const current = await autonomousPersonalCompletionPlanNextStageV4(first.store, first.seed, {
        content: sharedCounterTypedContent,
        turn: 'turn:shared-conflicts-129',
      });
      try {
        appendPriorPlanRows(current, prior);
        appendLegacyCandidatesAndReserve(current, 6);
        expect(current.selection?.occurrences).toHaveLength(15);
        const plan = planAutonomousPersonalCaptureCompletionV4(
          current.input,
          current.graph,
          current.response,
          current.selection,
          current.work,
          current.check,
          current.budget,
        );
        expect(plan).toEqual({ kind: 'no_write', reason: 'inspection_incomplete' });
      } finally {
        current.close();
      }
    } finally {
      await first.close();
    }
  });

  it('counts exact-literal dated family4 statement relations without typed-fact comparisons', async () => {
    const literal = 'I had a lovely weekend.';
    const first = await autonomousPersonalCompletionPlanFixtureV4({
      content: literal,
      turn: 'turn:statement-relations:0',
    });
    const priorPlans: PlannedCompletion[] = [];
    try {
      if (!first.selection) throw new Error('Expected a complete first statement selection');
      const initialPlan = planAutonomousPersonalCaptureCompletionV4(
        first.input,
        first.graph,
        first.response,
        first.selection,
        first.work,
        first.check,
        first.budget,
      );
      expect(initialPlan.kind).toBe('planned');
      if (initialPlan.kind !== 'planned') throw new Error('Expected initial planned DATA');
      expect(initialPlan.createEdges).toHaveLength(1);
      priorPlans.push(initialPlan);

      let finalPlan: ReturnType<typeof planAutonomousPersonalCaptureCompletionV4> | undefined;
      let finalStage:
        | Awaited<ReturnType<typeof autonomousPersonalCompletionPlanNextStageV4>>
        | undefined;
      for (let stageIndex = 1; stageIndex <= 9; stageIndex += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        const stage = await autonomousPersonalCompletionPlanNextStageV4(first.store, first.seed, {
          content: literal,
          turn: `turn:statement-relations:${stageIndex}`,
        });
        expect(priorPlans).toHaveLength(stageIndex);
        for (const prior of priorPlans) appendPriorPlanRows(stage, prior);
        if (!stage.selection) throw new Error('Expected a complete current statement selection');
        const result = planAutonomousPersonalCaptureCompletionV4(
          stage.input,
          stage.graph,
          stage.response,
          stage.selection,
          stage.work,
          stage.check,
          stage.budget,
        );
        if (stageIndex <= 8) {
          expect(result.kind).toBe('planned');
          if (result.kind !== 'planned') throw new Error('Expected a dated statement creation');
          expect(result.createEdges).toHaveLength(1);
          priorPlans.push(result);
          stage.close();
        } else {
          finalPlan = result;
          finalStage = stage;
        }
      }
      if (!finalPlan || !finalStage) throw new Error('Expected a final statement plan');
      try {
        expect(finalPlan).toEqual({ kind: 'no_write', reason: 'inspection_incomplete' });
      } finally {
        finalStage.close();
      }
    } finally {
      await first.close();
    }
  }, 60_000);

  it('uses one legacy read scope and budget object across planner replans', async () => {
    const fixture = await autonomousPersonalCompletionPlanFixtureV4();
    try {
      const identity = fixture.input.scope.context;
      const beforeBytes = Buffer.byteLength(JSON.stringify(fixture.graph), 'utf8');
      appendManualLegacyPreferenceCandidatesV4(
        fixture.graph,
        identity.namespace,
        identity.binding.subjectId,
        1,
      );
      const addedBytes = Buffer.byteLength(JSON.stringify(fixture.graph), 'utf8') - beforeBytes;
      if (
        !reserveAutomaticClaimSnapshotBytes(getAutomaticClaimReadScope(fixture.budget), addedBytes)
      )
        throw new Error('Unable to reserve synthetic legacy candidate');
      const originalScope = getAutomaticClaimReadScope(fixture.budget);
      fixture.budget.remaining = 4;
      if (!fixture.selection) throw new Error('Expected a complete provider selection');

      const firstPlan = planAutonomousPersonalCaptureCompletionV4(
        fixture.input,
        fixture.graph,
        fixture.response,
        fixture.selection,
        fixture.work,
        fixture.check,
        fixture.budget,
      );
      expect(firstPlan.kind).toBe('planned');
      expect(fixture.budget.remaining).toBe(0);
      expect(getAutomaticClaimReadScope(fixture.budget)).toBe(originalScope);

      const secondPlan = planAutonomousPersonalCaptureCompletionV4(
        fixture.input,
        fixture.graph,
        fixture.response,
        fixture.selection,
        fixture.work,
        fixture.check,
        fixture.budget,
      );
      expect(secondPlan).toEqual({ kind: 'no_write', reason: 'budget_exhausted' });
      expect(getAutomaticClaimReadScope(fixture.budget)).toBe(originalScope);
    } finally {
      await fixture.close();
    }
  });
});
