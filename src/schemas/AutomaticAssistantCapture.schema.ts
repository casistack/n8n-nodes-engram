import { z } from 'zod';
import { GraphDataSchema } from './GraphData.schema';
import {
  AutomaticCaptureBeginRequestV2Schema,
  AutomaticCaptureEventTimeV2Schema,
  AutomaticCaptureRegionV2Schema,
  AutomaticOperationDescriptorV2Schema,
  AutomaticOperationIdentityV2Schema,
  AssistantWriteAuthorityReferenceV2Schema,
  hashAutomaticCaptureV2,
  type AutomaticCaptureBeginRequestV2,
  type AutomaticCaptureSourceOwnerV2,
  type AutomaticOperationIdentityV2,
} from './AutomaticCapture.schema';
import { AutomaticCaptureOperationV2Schema } from './AutomaticCaptureOperation.schema';
import { AutomaticCaptureTerminalReceiptV2Schema } from './AutomaticCaptureReceipt.schema';
import {
  AutomaticCaptureBeginDecisionV2Schema,
  AutomaticCaptureBeginRequestV2Schema as BeginRequestSchema,
} from './AutomaticCaptureApi.schema';
import { AutomaticCaptureLeaseFenceV2Schema } from '../storage/AutomaticCaptureHandles';
import { EpisodicNodeSchema } from './EpisodicNode.schema';

const hash64 = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z.string().uuid();
const nonBlank = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => value.trim().length > 0);

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

const boundedContent = z
  .string()
  .min(1)
  .superRefine((value, context) => {
    if (value.length > 65_536) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Source content exceeds 65,536 UTF-16 code units',
      });
      return;
    }
    if (!isWellFormedUnicode(value)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Source content has invalid Unicode',
      });
      return;
    }
    if (Buffer.byteLength(value, 'utf8') > 65_536) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Source content exceeds 65,536 UTF-8 bytes',
      });
    }
  });

const boundedNullableString = (label: string) =>
  z
    .string()
    .min(1)
    .max(512)
    .superRefine((value, context) => {
      if (value.length > 512) return;
      if (!isWellFormedUnicode(value)) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: `${label} has invalid Unicode` });
        return;
      }
      if (value.trim().length === 0 || value.trim() !== value) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${label} must use the stored trimmed form`,
        });
      }
    })
    .nullable();

const nullableIdentifier = boundedNullableString('Producer identifier');
const nullableDisplay = boundedNullableString('Producer display value');

/**
 * Exact raw human turn currently being answered. The locator selects one human
 * turn; source IDs and hashes are derived only from its stored owner/operation.
 */
export const AutomaticAssistantHumanTurnIntentV2Schema = z
  .object({
    namespace: nonBlank(128),
    issuer: nonBlank(256),
    actorReference: nonBlank(512),
    turn: nonBlank(512),
    input: z
      .object({
        content: boundedContent,
        applicationOwnedWrapper: z.literal(true).nullable(),
        humanRegion: AutomaticCaptureRegionV2Schema.nullable(),
        quoteRegions: z.array(AutomaticCaptureRegionV2Schema).max(32),
      })
      .strict(),
  })
  .strict();

/** Immutable producer data for the final AI message; processing IDs are never fields here. */
export const AutomaticAssistantFinalSourceIntentV2Schema = z
  .object({
    content: boundedContent,
    sourceMessageId: nullableIdentifier,
    conversationId: nullableIdentifier,
    senderId: nullableIdentifier,
    senderName: nullableDisplay,
    sourceWorkflowId: nullableIdentifier,
    originalSourceExecutionId: nullableIdentifier,
    sourceType: z.literal('message'),
    quotedMessageId: nullableIdentifier,
    eventTime: AutomaticCaptureEventTimeV2Schema,
  })
  .strict();

/**
 * Strict internal final-writer intent. It contains no descriptor, policy,
 * store/source hash, binding, operation/source ID, token, or authority object.
 */
export const AutomaticAssistantCaptureIntentV2Schema = z
  .object({
    version: z.literal(2),
    lifecycle: z.literal('replaySafeV2'),
    purpose: z.literal('assistant_final_save'),
    humanTurn: AutomaticAssistantHumanTurnIntentV2Schema,
    finalAssistant: AutomaticAssistantFinalSourceIntentV2Schema,
    attemptIdHash: hash64,
    invocationDeadlineMs: z.number().int().min(100).max(120_000),
  })
  .strict()
  .superRefine((intent, context) => {
    const mappingProbe: AutomaticCaptureBeginRequestV2 = {
      version: 2,
      lifecycle: 'replaySafeV2',
      purpose: 'human_turn_memory',
      namespace: intent.humanTurn.namespace,
      issuer: intent.humanTurn.issuer,
      actorReference: intent.humanTurn.actorReference,
      turn: intent.humanTurn.turn,
      settings: {
        profileId: 'conservative',
        requestedTrustLevel: 'standard',
        intentSetting: false,
        invocationDeadlineMs: intent.invocationDeadlineMs,
      },
      source: {
        content: intent.humanTurn.input.content,
        sourceMessageId: null,
        conversationId: null,
        senderId: null,
        senderName: null,
        sourceWorkflowId: null,
        originalSourceExecutionId: null,
        sourceType: 'message',
        quotedMessageId: null,
        eventTime: { mode: 'first_capture' },
        applicationOwnedWrapper: intent.humanTurn.input.applicationOwnedWrapper,
        humanRegion: intent.humanTurn.input.humanRegion,
        quoteRegions: intent.humanTurn.input.quoteRegions,
      },
      attemptIdHash: intent.attemptIdHash,
    };
    const humanValid = AutomaticCaptureBeginRequestV2Schema.safeParse(mappingProbe);
    if (!humanValid.success) {
      for (const issue of humanValid.error.issues) {
        const path =
          issue.path[0] === 'source' ? ['humanTurn', 'input', ...issue.path.slice(1)] : issue.path;
        context.addIssue({ code: z.ZodIssueCode.custom, path, message: issue.message });
      }
    }

    const assistantProbe = BeginRequestSchema.safeParse({
      version: 2,
      lifecycle: 'replaySafeV2',
      purpose: 'assistant_final_save',
      namespace: intent.humanTurn.namespace,
      issuer: intent.humanTurn.issuer,
      actorReference: intent.humanTurn.actorReference,
      turn: intent.humanTurn.turn,
      settings: {
        profileId: null,
        requestedTrustLevel: null,
        intentSetting: null,
        invocationDeadlineMs: intent.invocationDeadlineMs,
      },
      source: {
        ...intent.finalAssistant,
        applicationOwnedWrapper: null,
        humanRegion: null,
        quoteRegions: [],
      },
      attemptIdHash: intent.attemptIdHash,
    });
    if (!assistantProbe.success) {
      for (const issue of assistantProbe.error.issues) {
        const path =
          issue.path[0] === 'source' ? ['finalAssistant', ...issue.path.slice(1)] : issue.path;
        context.addIssue({ code: z.ZodIssueCode.custom, path, message: issue.message });
      }
    }
  });
export type AutomaticAssistantCaptureIntentV2 = z.infer<
  typeof AutomaticAssistantCaptureIntentV2Schema
>;
export type AutomaticAssistantCaptureIntentV2Input = z.input<
  typeof AutomaticAssistantCaptureIntentV2Schema
>;

const settingsFields = {
  lifecycle: z.literal('replaySafeV2'),
  purpose: z.literal('assistant_final_save'),
  interpreterId: z.literal('assistant-final-write-v1'),
  semanticVersion: z.literal(1),
  grammarVersion: z.null(),
  lexiconVersion: z.null(),
  requestedTrustLevel: z.null(),
  intentSetting: z.null(),
  invocationDeadlineMs: z.number().int().min(100).max(120_000),
  policy: z.null(),
  assistantWriteAuthority: AssistantWriteAuthorityReferenceV2Schema,
};

export const AutomaticAssistantDescriptorSettingsV2Schema = z.object(settingsFields).strict();
export type AutomaticAssistantDescriptorSettingsV2 = z.infer<
  typeof AutomaticAssistantDescriptorSettingsV2Schema
>;

export const AutomaticAssistantDescriptorBuildResultV2Schema = z
  .object({
    descriptor: AutomaticOperationDescriptorV2Schema,
    descriptorHash: hash64,
  })
  .strict()
  .superRefine((result, context) => {
    if (
      result.descriptor.purpose !== 'assistant_final_save' ||
      result.descriptorHash !== hashAutomaticCaptureV2(result.descriptor)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Invalid assistant descriptor hash',
      });
    }
  });
export type AutomaticAssistantDescriptorBuildResultV2 = z.infer<
  typeof AutomaticAssistantDescriptorBuildResultV2Schema
>;

export const AutomaticAssistantSourceBuildV2Schema = z
  .object({
    intent: AutomaticAssistantCaptureIntentV2Schema,
    sourceId: uuid,
    storeHash: hash64,
    capturedAt: z.string().datetime(),
    previousEpisodeId: uuid.nullable(),
  })
  .strict();
export type AutomaticAssistantSourceBuildV2 = z.infer<typeof AutomaticAssistantSourceBuildV2Schema>;

export const AutomaticAssistantBuiltSourceV2Schema = z
  .object({
    episode: EpisodicNodeSchema,
    descriptor: AutomaticOperationDescriptorV2Schema,
    descriptorHash: hash64,
    identity: AutomaticOperationIdentityV2Schema,
  })
  .strict()
  .superRefine((built, context) => {
    if (
      built.descriptor.purpose !== 'assistant_final_save' ||
      built.identity.purpose !== 'assistant_final_save' ||
      built.identity.role !== 'assistant' ||
      built.episode.role !== 'ai' ||
      built.episode.episode_kind !== 'assistant_reply'
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Assistant source build must use the write-only assistant role',
      });
    }
  });
export type AutomaticAssistantBuiltSourceV2 = z.infer<typeof AutomaticAssistantBuiltSourceV2Schema>;

const assistantCommittedOperation = AutomaticCaptureOperationV2Schema.refine(
  (
    operation,
  ): operation is Extract<
    z.infer<typeof AutomaticCaptureOperationV2Schema>,
    { state: 'committed' }
  > => operation.state === 'committed' && operation.identity.purpose === 'assistant_final_save',
);
const assistantLeasedOperation = AutomaticCaptureOperationV2Schema.refine(
  (
    operation,
  ): operation is Extract<z.infer<typeof AutomaticCaptureOperationV2Schema>, { state: 'leased' }> =>
    operation.state === 'leased' && operation.identity.purpose === 'assistant_final_save',
);
const assistantReceipt = AutomaticCaptureTerminalReceiptV2Schema.refine(
  (receipt) => receipt.kind === 'assistant_final_saved',
);

export const AutomaticAssistantCaptureBeginInputV2Schema = z
  .object({
    intent: AutomaticAssistantCaptureIntentV2Schema,
    storeHash: hash64,
    backendNow: z.string().datetime(),
    sourceId: uuid,
    operationId: uuid,
    previousEpisodeId: uuid.nullable(),
    beginCallHash: hash64,
    leaseToken: uuid,
  })
  .strict();
export type AutomaticAssistantCaptureBeginInputV2 = z.infer<
  typeof AutomaticAssistantCaptureBeginInputV2Schema
>;

export const AutomaticAssistantCaptureBeginPreparationV2Schema = z.union([
  z
    .object({
      kind: z.literal('prepared_claim'),
      graph: GraphDataSchema,
      operation: assistantLeasedOperation,
      leaseFence: AutomaticCaptureLeaseFenceV2Schema,
      writeRequired: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('prepared_replay'),
      graph: GraphDataSchema,
      terminalReceipt: assistantReceipt,
      currentAuthority: z.enum(['active', 'changed', 'revoked', 'unknown']),
      auditWriteRequired: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('prepared_decision'),
      graph: GraphDataSchema,
      decision: AutomaticCaptureBeginDecisionV2Schema,
    })
    .strict(),
  z
    .object({ kind: z.literal('decision'), decision: AutomaticCaptureBeginDecisionV2Schema })
    .strict(),
]);
export type AutomaticAssistantCaptureBeginPreparationV2 = z.infer<
  typeof AutomaticAssistantCaptureBeginPreparationV2Schema
>;

export const AutomaticAssistantCaptureCompletionContextV2Schema = z
  .object({ storeHash: hash64, backendNow: z.string().datetime() })
  .strict();
export type AutomaticAssistantCaptureCompletionContextV2 = z.infer<
  typeof AutomaticAssistantCaptureCompletionContextV2Schema
>;

export const AutomaticAssistantCompletionInvocationV2Schema = z
  .object({
    purpose: z.literal('assistant_final_save'),
    boundFence: AutomaticCaptureLeaseFenceV2Schema,
    completionCallHash: hash64,
    retryIssueCallHash: z.null(),
  })
  .strict();
export type AutomaticAssistantCompletionInvocationV2 = z.infer<
  typeof AutomaticAssistantCompletionInvocationV2Schema
>;

export const AutomaticAssistantCaptureCompletionPreparationV2Schema = z.union([
  z
    .object({
      kind: z.literal('prepared_commit'),
      graph: GraphDataSchema,
      operation: assistantCommittedOperation,
      terminalReceipt: assistantReceipt,
    })
    .strict(),
  z
    .object({
      kind: z.literal('ack_recovered'),
      terminalReceipt: assistantReceipt,
      currentAuthority: z.enum(['active', 'changed', 'revoked', 'unknown']),
    })
    .strict(),
  z
    .object({
      kind: z.literal('decision'),
      reason: z.enum([
        'invalid_handle',
        'invalid_input',
        'fenced',
        'authority_changed',
        'clock_regression',
        'capacity',
      ]),
    })
    .strict(),
]);
export type AutomaticAssistantCaptureCompletionPreparationV2 = z.infer<
  typeof AutomaticAssistantCaptureCompletionPreparationV2Schema
>;

export const AutomaticAssistantFinalWriterResultV2Schema = z
  .union([
    z
      .object({
        kind: z.literal('committed'),
        invocation: z.enum(['initial_owner', 'same_call_ack_recovered']),
        terminalReceipt: assistantReceipt,
        currentAuthority: z.enum(['active', 'changed', 'revoked', 'unknown']),
        eligibleFirstCommit: z.literal(false),
      })
      .strict(),
    z
      .object({
        kind: z.literal('committed_replay'),
        terminalReceipt: assistantReceipt,
        currentAuthority: z.enum(['active', 'changed', 'revoked', 'unknown']),
        eligibleFirstCommit: z.literal(false),
      })
      .strict(),
    z
      .object({
        kind: z.literal('decision'),
        reason: z.enum([
          'invalid_handle',
          'invalid_input',
          'fenced',
          'authority_changed',
          'clock_regression',
          'capacity',
          'unsupported_mode',
          'conflict',
          'in_progress',
          'cancelled_replay',
          'legacy_unconfirmed',
          'source_only_unconfirmed',
          'storage_error',
          'acknowledgement_unknown',
          'budget_exhausted',
          'interrupted',
        ]),
        eligibleFirstCommit: z.literal(false),
      })
      .strict(),
  ])
  .superRefine((result, context) => {
    if (
      result.kind === 'committed' &&
      result.invocation === 'initial_owner' &&
      result.currentAuthority !== 'active'
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'A fresh assistant save requires active parent authority',
        path: ['currentAuthority'],
      });
    }
  });
export type AutomaticAssistantFinalWriterResultV2 = z.infer<
  typeof AutomaticAssistantFinalWriterResultV2Schema
>;

export const AutomaticAssistantCaptureAuthorizationContextV2Schema = z
  .object({ storeHash: hash64 })
  .strict();

export const AutomaticAssistantCaptureAuthorizationDataV2Schema = z
  .object({
    intent: AutomaticAssistantCaptureIntentV2Schema,
    intentHash: hash64,
    storeHash: hash64,
    humanOperationId: uuid,
    humanIdentityHash: hash64,
    humanAuthority: AssistantWriteAuthorityReferenceV2Schema,
  })
  .strict();
export type AutomaticAssistantCaptureAuthorizationDataV2 = z.infer<
  typeof AutomaticAssistantCaptureAuthorizationDataV2Schema
>;

// These inferred aliases keep the source-of-truth schemas available to storage code.
export type AutomaticAssistantOperationIdentityV2 = AutomaticOperationIdentityV2;
export type AutomaticAssistantSourceOwnerV2 = AutomaticCaptureSourceOwnerV2;
