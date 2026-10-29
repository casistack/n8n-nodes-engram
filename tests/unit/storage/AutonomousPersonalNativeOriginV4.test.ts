import { AutonomousPersonalNativeOriginV4OwnedDataSchema } from '../../../src/schemas/AutonomousPersonalNativeOriginV4.schema';
import { hashAutomaticCaptureV2 } from '../../../src/schemas/AutomaticCapture.schema';
import {
  AutonomousPersonalCompletionPlanV4InputOwnedDataSchema,
  type AutonomousPersonalCompletionPlanV4Input,
} from '../../../src/schemas/AutonomousPersonalCompletionPlanV4.schema';
import { AUTOMATIC_LEDGER_LIMITS } from '../../../src/schemas/AutomaticLedgerPrimitives.schema';
import { planAutonomousPersonalCaptureCompletionV4 } from '../../../src/storage/AutonomousPersonalCompletionPlanV4';
import { projectAutonomousPersonalNativeOriginV4 } from '../../../src/storage/AutonomousPersonalNativeOriginV4';
import {
  getAutomaticClaimReadScope,
  reserveAutomaticClaimSnapshotBytes,
} from '../../../src/storage/AutomaticClaimReadScope';
import {
  autonomousPersonalCompletionPlanFixtureV4,
  autonomousPersonalCompletionPlanNextStageV4,
  type AutonomousPersonalCompletionPlanFixtureV4,
} from '../../helpers/autonomousPersonalCompletionPlanV4';

type PlanStage = Pick<
  AutonomousPersonalCompletionPlanFixtureV4,
  'input' | 'graph' | 'response' | 'selection' | 'work' | 'check' | 'budget'
>;

function planFor(stage: PlanStage) {
  const plan = planAutonomousPersonalCaptureCompletionV4(
    stage.input,
    stage.graph,
    stage.response,
    stage.selection,
    stage.work,
    stage.check,
    stage.budget,
  );
  if (plan.kind !== 'planned') throw new Error(`Expected planned DATA, received ${plan.reason}`);
  return plan;
}

function inputFor(stage: PlanStage): AutonomousPersonalCompletionPlanV4Input {
  return AutonomousPersonalCompletionPlanV4InputOwnedDataSchema.parse(stage.input);
}

describe('Autonomous Personal Native Origin V4', () => {
  it('projects a strict occurrence origin without authority fields', async () => {
    const fixture = await autonomousPersonalCompletionPlanFixtureV4();
    try {
      const plan = planFor(fixture);
      const input = inputFor(fixture);
      expect(plan.operation.terminalReceipt.kind).toBe('human_autonomous_capture_committed');
      const origin = projectAutonomousPersonalNativeOriginV4(input, plan, () => {});

      expect(AutonomousPersonalNativeOriginV4OwnedDataSchema.parse(origin)).toEqual(origin);
      expect(Object.keys(origin).sort()).toEqual(
        [
          'version',
          'identity',
          'instance',
          'workflow',
          'execution',
          'attemptHash',
          'completionCallHash',
          'terminalReceipt',
        ].sort(),
      );
      expect(origin.identity).toEqual(plan.operation.identity);
      expect(origin.terminalReceipt).toEqual(plan.operation.terminalReceipt);
      expect(origin.instance).toBe(input.scope.context.instance);
      expect(origin.workflow).toBe(input.scope.context.workflow);
      expect(origin.execution).toBe(input.scope.context.execution);
      expect(origin.attemptHash).toBe(input.scope.attemptHash);
      expect(origin.completionCallHash).toBe(input.completionCallHash);
      expect(Object.isFrozen(origin)).toBe(true);
      expect(Object.isFrozen(origin.identity)).toBe(true);
      expect(Object.isFrozen(origin.terminalReceipt)).toBe(true);

      const baseReceipt = plan.operation.terminalReceipt;
      const cancelledReceipt = {
        version: 4,
        kind: 'cancelled',
        operationId: baseReceipt.operationId,
        sourceId: baseReceipt.sourceId,
        sourceHash: baseReceipt.sourceHash,
        descriptorHash: baseReceipt.descriptorHash,
        policyFingerprint: baseReceipt.policyFingerprint,
        terminalAt: baseReceipt.terminalAt,
        acceptedCoverage: 'none',
      };
      expect(
        AutonomousPersonalNativeOriginV4OwnedDataSchema.safeParse({
          ...origin,
          terminalReceipt: cancelledReceipt,
        }).success,
      ).toBe(false);
      expect(
        AutonomousPersonalNativeOriginV4OwnedDataSchema.safeParse({
          ...origin,
          nativeProof: true,
        }).success,
      ).toBe(false);
    } finally {
      await fixture.close();
    }
  });

  it('projects a committed provider deferral and preserves its reason join', async () => {
    const fixture = await autonomousPersonalCompletionPlanFixtureV4({ providerAuthFailure: true });
    try {
      const plan = planFor(fixture);
      const input = inputFor(fixture);
      expect(fixture.input.outcome).toEqual({ kind: 'deferred', reason: 'provider_auth' });
      expect(plan.operation.terminalReceipt.kind).toBe(
        'human_autonomous_source_deferred_committed',
      );
      const origin = projectAutonomousPersonalNativeOriginV4(input, plan, () => {});
      expect(origin.terminalReceipt.kind).toBe('human_autonomous_source_deferred_committed');

      const detachedInput = structuredClone(input);
      if (detachedInput.outcome.kind !== 'deferred') throw new Error('Expected deferred input');
      detachedInput.outcome.reason = 'provider_network';
      expect(() => projectAutonomousPersonalNativeOriginV4(detachedInput, plan, () => {})).toThrow(
        'Engram autonomous personal native origin: conflict',
      );
    } finally {
      await fixture.close();
    }
  });

  it('projects a committed source verdict and preserves the verdict mapping', async () => {
    const fixture = await autonomousPersonalCompletionPlanFixtureV4({
      profile: 'explicit',
      intent: 'disabled',
    });
    try {
      const plan = planFor(fixture);
      const input = inputFor(fixture);
      expect(fixture.input.outcome).toEqual({ kind: 'no_dispatch', reason: 'policy_not_selected' });
      expect(plan.operation.terminalReceipt.kind).toBe('human_autonomous_source_verdict_committed');
      const origin = projectAutonomousPersonalNativeOriginV4(input, plan, () => {});
      expect(origin.terminalReceipt.kind).toBe('human_autonomous_source_verdict_committed');

      const detachedInput = structuredClone(input);
      if (detachedInput.outcome.kind !== 'no_dispatch')
        throw new Error('Expected no-dispatch input');
      detachedInput.outcome.reason = 'source_indeterminate';
      expect(() => projectAutonomousPersonalNativeOriginV4(detachedInput, plan, () => {})).toThrow(
        'Engram autonomous personal native origin: conflict',
      );
    } finally {
      await fixture.close();
    }
  });

  it('rejects strict unknown, getter-backed, proxy, and foreign-scope input safely', async () => {
    const fixture = await autonomousPersonalCompletionPlanFixtureV4();
    try {
      const plan = planFor(fixture);
      const input = inputFor(fixture);
      const unknownInput = {
        ...structuredClone(input),
        callerProof: true,
      } as unknown as AutonomousPersonalCompletionPlanV4Input;
      expect(() => projectAutonomousPersonalNativeOriginV4(unknownInput, plan, () => {})).toThrow(
        'Engram autonomous personal native origin: invalid_input',
      );

      let getterCalls = 0;
      const getterInput = Object.defineProperty({}, 'scope', {
        enumerable: true,
        get() {
          getterCalls += 1;
          throw new Error('getter_must_not_run');
        },
      }) as AutonomousPersonalCompletionPlanV4Input;
      expect(() => projectAutonomousPersonalNativeOriginV4(getterInput, plan, () => {})).toThrow(
        'Engram autonomous personal native origin: invalid_input',
      );
      expect(getterCalls).toBe(0);

      let proxyTraps = 0;
      const proxyPlan = new Proxy(plan, {
        get() {
          proxyTraps += 1;
          throw new Error('proxy_must_not_run');
        },
      });
      expect(() => projectAutonomousPersonalNativeOriginV4(input, proxyPlan, () => {})).toThrow(
        'Engram autonomous personal native origin: invalid_input',
      );
      expect(proxyTraps).toBe(0);

      const other = await autonomousPersonalCompletionPlanNextStageV4(fixture.store, fixture.seed, {
        content: 'I prefer tables.',
        turn: 'synthetic:native-origin-foreign-scope',
      });
      try {
        const foreignPlan = planFor(other);
        expect(() =>
          projectAutonomousPersonalNativeOriginV4(input, foreignPlan, other.check),
        ).toThrow('Engram autonomous personal native origin: conflict');
      } finally {
        other.close();
      }
    } finally {
      await fixture.close();
    }
  });

  it('preserves the original check failure through the final return check', async () => {
    const fixture = await autonomousPersonalCompletionPlanFixtureV4();
    try {
      const plan = planFor(fixture);
      const input = inputFor(fixture);
      let expectedChecks = 0;
      projectAutonomousPersonalNativeOriginV4(input, plan, () => {
        expectedChecks += 1;
      });
      expect(expectedChecks).toBeGreaterThan(1);

      const originalFailure = new Error('synthetic_original_check_failure');
      let observedChecks = 0;
      let thrown: unknown;
      try {
        projectAutonomousPersonalNativeOriginV4(input, plan, () => {
          observedChecks += 1;
          if (observedChecks === expectedChecks) throw originalFailure;
        });
      } catch (error) {
        thrown = error;
      }
      expect(observedChecks).toBe(expectedChecks);
      expect(thrown).toBe(originalFailure);
    } finally {
      await fixture.close();
    }
  });

  it('retains the candidate allowance for a truncated completion audit', async () => {
    const fixture = await autonomousPersonalCompletionPlanFixtureV4();
    try {
      const leased = fixture.graph.automatic_operations_v1!.operations.find(
        (operation) => operation.operationId === fixture.input.scope.operationId,
      );
      if (leased?.version !== 4 || leased.state !== 'leased') {
        throw new Error('Expected the current leased Operation4');
      }
      const originalBytes = Buffer.byteLength(JSON.stringify(fixture.graph), 'utf8');
      leased.lastObservedAt = fixture.input.backendNow;
      for (let index = 1; index < AUTOMATIC_LEDGER_LIMITS.attemptsPerOperation; index += 1) {
        leased.attempts.push({
          attemptHash: hashAutomaticCaptureV2({
            domain: 'synthetic-completion-graph-audit-suffix',
            operationId: leased.operationId,
            index,
          }),
          at: fixture.input.backendNow,
          disposition: 'lease_renewed',
        });
      }
      const addedBytes = Buffer.byteLength(JSON.stringify(fixture.graph), 'utf8') - originalBytes;
      if (
        !reserveAutomaticClaimSnapshotBytes(getAutomaticClaimReadScope(fixture.budget), addedBytes)
      ) {
        throw new Error('Unable to reserve synthetic audit suffix bytes');
      }

      const plan = planFor(fixture);
      const input = inputFor(fixture);
      expect(plan.operation.auditTruncated).toBe(true);
      expect(
        plan.operation.attempts.some(
          (attempt) => attempt.attemptHash === fixture.input.audit.attemptIdHash,
        ),
      ).toBe(false);
      expect(() =>
        projectAutonomousPersonalNativeOriginV4(input, plan, fixture.check),
      ).not.toThrow();
    } finally {
      await fixture.close();
    }
  });
});
