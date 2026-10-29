import { CompositionalAutomaticCaptureBeginRequestV3Schema } from '../../../src/schemas/CompositionalAutomaticCaptureV3.schema';
import {
  CompositionalCaptureAdminFenceRequestV3Schema,
  CompositionalCaptureBeginMethodRequestV3Schema,
  CompositionalCaptureCancelResultV3Schema,
  CompositionalCaptureCancelledObservationV3Schema,
  CompositionalCaptureCommittedObservationV3Schema,
  CompositionalCaptureLeaseFenceV3Schema,
  CompositionalCaptureNonPermitDecisionV3Schema,
  CompositionalCaptureNonPermitResultV3Schema,
  CompositionalCapturePublicResultV3Schema,
  CompositionalCaptureReadRequestV3Schema,
  CompositionalCaptureReadResultV3Schema,
} from '../../../src/schemas/CompositionalAutomaticCaptureLifecycleV3.schema';
import { CompositionalCaptureNamespaceV3Schema } from '../../../src/schemas/CompositionalCaptureNamespaceV3.schema';

const uuidAt = (index: number) => `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
const hash = (digit: string) => digit.repeat(64);
const timestamp = '2026-10-25T12:00:00.000Z';

function requestFixture() {
  return CompositionalAutomaticCaptureBeginRequestV3Schema.parse({
    version: 3,
    lifecycle: 'replaySafeV2',
    purpose: 'human_turn_memory',
    preferenceInterpreter: 'compositionalV2',
    namespace: 'v3-lifecycle-test',
    issuer: 'synthetic-app',
    actorReference: 'synthetic-actor',
    turn: 'turn-v3-lifecycle-test',
    settings: {
      profileId: 'conservative',
      requestedTrustLevel: 'standard',
      intentSetting: false,
      invocationDeadlineMs: 10_000,
    },
    source: {
      content: 'I prefer concise explanations.',
      sourceMessageId: 'message-v3-lifecycle',
      conversationId: 'conversation-v3-lifecycle',
      senderId: 'synthetic-actor',
      senderName: 'Synthetic Human',
      sourceWorkflowId: 'synthetic-workflow',
      originalSourceExecutionId: 'synthetic-source-execution',
      sourceType: 'message',
      quotedMessageId: null,
      eventTime: { mode: 'first_capture' },
      applicationOwnedWrapper: null,
      humanRegion: null,
      quoteRegions: [],
    },
    attemptIdHash: hash('a'),
  });
}

function fenceFixture() {
  return {
    version: 3,
    purpose: 'human_turn_memory',
    operationId: uuidAt(1),
    sourceId: uuidAt(2),
    descriptorHash: hash('1'),
    identityHash: hash('2'),
    sourceHash: hash('3'),
    envelopeHash: hash('4'),
    beginCallHash: hash('5'),
    state: 'leased',
    generation: 1,
    token: uuidAt(3),
    claimKind: 'initial',
    retryCount: 0,
    planTimestamp: timestamp,
  };
}

function sourceVerdictReceipt() {
  return {
    version: 3,
    kind: 'human_compositional_source_verdict_committed',
    operationId: uuidAt(1),
    sourceId: uuidAt(2),
    sourceHash: hash('3'),
    descriptorHash: hash('1'),
    policyFingerprint: hash('4'),
    terminalAt: timestamp,
    reasons: [],
    interpretationCoverage: 'none',
    selection: {
      kind: 'source_verdict',
      verdict: 'no_supported_preference_detected',
      interpreterResultHash: hash('5'),
    },
    acceptedCoverage: 'none',
  };
}

function cancelledReceipt() {
  return {
    version: 3,
    kind: 'cancelled',
    operationId: uuidAt(1),
    sourceId: uuidAt(2),
    sourceHash: hash('3'),
    descriptorHash: hash('1'),
    policyFingerprint: hash('4'),
    terminalAt: timestamp,
    acceptedCoverage: 'none',
  };
}

describe('compositional capture V3 lifecycle schemas', () => {
  it('accepts the exact V3 existing-store begin method request', () => {
    expect(
      CompositionalCaptureBeginMethodRequestV3Schema.parse({
        request: requestFixture(),
        mode: 'existingStore',
      }),
    ).toMatchObject({ mode: 'existingStore', request: { version: 3 } });
  });

  it('rejects defaulted or legacy begin modes and caller-selected policy/hash fields', () => {
    const base = requestFixture();
    expect(
      CompositionalCaptureBeginMethodRequestV3Schema.safeParse({ request: base, mode: 'legacy' })
        .success,
    ).toBe(false);
    expect(
      CompositionalCaptureBeginMethodRequestV3Schema.safeParse({ request: base }).success,
    ).toBe(false);
    expect(
      CompositionalCaptureBeginMethodRequestV3Schema.safeParse({
        request: { ...base, policy: { autoAccept: true }, descriptorHash: hash('6') },
        mode: 'existingStore',
      }).success,
    ).toBe(false);
  });

  it('rejects accessors without executing them and accepts detached plain objects', () => {
    let getterCalls = 0;
    const request = requestFixture();
    const accessor = Object.defineProperty({ mode: 'existingStore' }, 'request', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return request;
      },
    });
    expect(CompositionalCaptureBeginMethodRequestV3Schema.safeParse(accessor).success).toBe(false);
    expect(getterCalls).toBe(0);
    expect(
      CompositionalCaptureBeginMethodRequestV3Schema.safeParse(
        structuredClone({ request, mode: 'existingStore' }),
      ).success,
    ).toBe(true);
  });

  it('accepts an initial generation-one fence with exact retry-field presence', () => {
    expect(CompositionalCaptureLeaseFenceV3Schema.safeParse(fenceFixture()).success).toBe(true);
  });

  it('accepts a resumed V3 fence with generation and retained retry history', () => {
    expect(
      CompositionalCaptureLeaseFenceV3Schema.safeParse({
        ...fenceFixture(),
        generation: 2,
        token: uuidAt(4),
        claimKind: 'resume',
        retryCount: 2,
        lastRetryCallHash: hash('6'),
      }).success,
    ).toBe(true);
  });

  it.each([
    ['V2 version', { version: 2 }],
    ['assistant purpose', { purpose: 'assistant_final_save' }],
    ['nonleased state', { state: 'committed' }],
    ['initial wrong generation', { generation: 2 }],
    ['resume wrong generation', { claimKind: 'resume' }],
    ['missing retry hash', { retryCount: 1 }],
    ['extra retry hash', { lastRetryCallHash: hash('6') }],
    ['unknown field', { shouldProcess: true }],
  ])('rejects a fence with %s', (_label, changes) => {
    expect(
      CompositionalCaptureLeaseFenceV3Schema.safeParse({ ...fenceFixture(), ...changes }).success,
    ).toBe(false);
  });

  it('rejects noncanonical hash, operation ID, or oversized fence string input', () => {
    expect(
      CompositionalCaptureLeaseFenceV3Schema.safeParse({ ...fenceFixture(), identityHash: 'x' })
        .success,
    ).toBe(false);
    expect(
      CompositionalCaptureLeaseFenceV3Schema.safeParse({ ...fenceFixture(), operationId: 'not-id' })
        .success,
    ).toBe(false);
    expect(
      CompositionalCaptureLeaseFenceV3Schema.safeParse({
        ...fenceFixture(),
        identityHash: 'x'.repeat(100_000),
      }).success,
    ).toBe(false);
  });

  it('accepts a strict human locator and rejects foreign role, version, IDs, and hashes', () => {
    const locator = {
      version: 3,
      namespace: 'v3-lifecycle-test',
      issuer: 'synthetic-app',
      actorReference: 'synthetic-actor',
      turn: 'turn-v3-lifecycle-test',
      role: 'human',
    };
    expect(CompositionalCaptureReadRequestV3Schema.safeParse(locator).success).toBe(true);
    for (const invalid of [
      { ...locator, version: 2 },
      { ...locator, role: 'assistant' },
      { ...locator, sourceId: uuidAt(2) },
      { ...locator, identityHash: hash('1') },
      { ...locator, namespace: '   ' },
    ]) {
      expect(CompositionalCaptureReadRequestV3Schema.safeParse(invalid).success).toBe(false);
    }
  });

  it('preserves exact V3 namespace whitespace while rejecting blank or malformed values', () => {
    const exactNamespace = ' v3-lifecycle-test ';
    expect(CompositionalCaptureNamespaceV3Schema.parse(exactNamespace)).toBe(exactNamespace);
    expect(
      CompositionalCaptureReadRequestV3Schema.safeParse({
        version: 3,
        namespace: exactNamespace,
        issuer: 'synthetic-app',
        actorReference: 'synthetic-actor',
        turn: 'turn-v3-lifecycle-test',
        role: 'human',
      }).success,
    ).toBe(true);
    expect(CompositionalCaptureNamespaceV3Schema.safeParse('   ').success).toBe(false);
    expect(CompositionalCaptureNamespaceV3Schema.safeParse('\ud800').success).toBe(false);
    expect(CompositionalCaptureNamespaceV3Schema.safeParse('x'.repeat(129)).success).toBe(false);
  });

  it('requires an opaque attempt hash and generation for operator controls', () => {
    const request = {
      version: 3,
      namespace: 'v3-lifecycle-test',
      issuer: 'synthetic-app',
      actorReference: 'synthetic-actor',
      turn: 'turn-v3-lifecycle-test',
      role: 'human',
      expectedGeneration: 1,
      attemptIdHash: hash('a'),
    };
    expect(CompositionalCaptureAdminFenceRequestV3Schema.safeParse(request).success).toBe(true);
    expect(
      CompositionalCaptureAdminFenceRequestV3Schema.safeParse({
        ...request,
        attemptIdHash: 'raw-execution-id',
      }).success,
    ).toBe(false);
    expect(
      CompositionalCaptureAdminFenceRequestV3Schema.safeParse({
        ...request,
        operationId: uuidAt(1),
      }).success,
    ).toBe(false);
  });

  it('rejects private locator accessors before executing them', () => {
    let getterCalls = 0;
    const request = Object.defineProperty(
      {
        version: 3,
        issuer: 'synthetic-app',
        actorReference: 'synthetic-actor',
        turn: 'turn-v3-lifecycle-test',
        role: 'human',
      },
      'namespace',
      {
        enumerable: true,
        get() {
          getterCalls += 1;
          return 'v3-lifecycle-test';
        },
      },
    );
    expect(CompositionalCaptureReadRequestV3Schema.safeParse(request).success).toBe(false);
    expect(getterCalls).toBe(0);
  });

  it('accepts fixed nonpermit decisions and rejects unknown or true permission fields', () => {
    expect(
      CompositionalCaptureNonPermitDecisionV3Schema.safeParse({
        kind: 'in_progress',
        eligibleFirstCommit: false,
      }).success,
    ).toBe(true);
    for (const invalid of [
      { kind: 'in_progress', eligibleFirstCommit: true },
      { kind: 'in_progress', should_process: true },
      { kind: 'unreviewed_status', eligibleFirstCommit: false },
      { kind: 'conflict', eligibleFirstCommit: false, operationId: uuidAt(1) },
    ]) {
      expect(CompositionalCaptureNonPermitDecisionV3Schema.safeParse(invalid).success).toBe(false);
    }
  });

  it('accepts a historical committed observation only with an actual V3 receipt and false eligibility', () => {
    const result = {
      kind: 'committed',
      invocation: 'committed_replay',
      terminalReceipt: sourceVerdictReceipt(),
      currentAuthority: 'revoked',
      eligibleFirstCommit: false,
    };
    expect(CompositionalCaptureCommittedObservationV3Schema.safeParse(result).success).toBe(true);
    expect(CompositionalCaptureReadResultV3Schema.safeParse(result).success).toBe(true);
    expect(
      CompositionalCaptureCommittedObservationV3Schema.safeParse({
        ...result,
        eligibleFirstCommit: true,
      }).success,
    ).toBe(false);
    expect(
      CompositionalCaptureReadResultV3Schema.safeParse({
        ...result,
        invocation: 'initial_owner',
      }).success,
    ).toBe(false);
    expect(
      CompositionalCaptureReadResultV3Schema.safeParse({
        kind: 'committed_replay',
        eligibleFirstCommit: false,
      }).success,
    ).toBe(false);
  });

  it('accepts cancellation as a terminal false result and rejects wrong receipt kinds', () => {
    const result = {
      kind: 'cancelled',
      terminalReceipt: cancelledReceipt(),
      eligibleFirstCommit: false,
    };
    expect(CompositionalCaptureCancelledObservationV3Schema.safeParse(result).success).toBe(true);
    expect(CompositionalCaptureCancelResultV3Schema.safeParse(result).success).toBe(true);
    expect(
      CompositionalCaptureCancelResultV3Schema.safeParse({
        ...result,
        terminalReceipt: sourceVerdictReceipt(),
      }).success,
    ).toBe(false);
    expect(
      CompositionalCaptureNonPermitResultV3Schema.safeParse({
        ...result,
        eligibleFirstCommit: true,
      }).success,
    ).toBe(false);
    expect(CompositionalCapturePublicResultV3Schema.safeParse(result).success).toBe(true);
    expect(
      CompositionalCapturePublicResultV3Schema.safeParse({
        ...result,
        eligibleFirstCommit: true,
      }).success,
    ).toBe(false);
  });

  it('does not accept structural claimed, resumed, handle, or true-result records', () => {
    for (const forged of [
      { kind: 'claimed', sourceId: uuidAt(2), operationId: uuidAt(1), leaseHandle: {} },
      { kind: 'resumed', generation: 2, leaseHandle: {} },
      {
        kind: 'committed',
        invocation: 'initial_owner',
        terminalReceipt: sourceVerdictReceipt(),
        currentAuthority: 'active',
        eligibleFirstCommit: true,
      },
    ]) {
      expect(CompositionalCaptureNonPermitResultV3Schema.safeParse(forged).success).toBe(false);
    }
  });
});
