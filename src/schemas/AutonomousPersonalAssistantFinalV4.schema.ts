import { z } from 'zod';
import {
  AutomaticAssistantDescriptorSettingsV2Schema,
  AutomaticAssistantFinalSourceIntentV2Schema,
  AutomaticAssistantFinalWriterResultV2Schema,
} from './AutomaticAssistantCapture.schema';
import { AssistantWriteAuthorityReferenceV4Schema } from './AssistantWriteAuthorityReferenceV4.schema';
import { AutonomousPersonalNativeMemoryConfigV4OwnedDataSchema } from './AutonomousPersonalNativeMemoryConfigV4.schema';
import { MemoryProcessingAttemptHashSchema } from './ReplaySafeMemory.schema';
import { AutonomousPersonalNativeOriginV4OwnedDataSchema } from './AutonomousPersonalNativeOriginV4.schema';
import { GraphDataSchema } from './GraphData.schema';
import { AutomaticCaptureTerminalReceiptV2Schema } from './AutomaticCaptureReceipt.schema';
import { cloneBoundedAutomaticCaptureJson } from '../storage/BoundedAutomaticCaptureJson';

const humanObservation = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('configured_query') }).strict(),
  z
    .object({
      kind: z.literal('message'),
      content: AutomaticAssistantFinalSourceIntentV2Schema.shape.content,
    })
    .strict(),
]);

/** Final-message DATA only. Source identity and authority come from the private invocation. */
export const AutonomousPersonalAssistantFinalIntentV4OwnedDataSchema = z
  .object({
    version: z.literal(4),
    purpose: z.literal('assistant_final_save'),
    humanObservation,
    finalAssistant: AutomaticAssistantFinalSourceIntentV2Schema,
    memoryAttemptHash: MemoryProcessingAttemptHashSchema,
    invocationDeadlineMs: z.number().int().min(100).max(120_000),
  })
  .strict()
  .superRefine((intent, context) => {
    // Bound lengths before scanning, including when an underlying field is already invalid.
    if (
      intent.finalAssistant.content.length > 65_536 ||
      (intent.humanObservation.kind === 'message' &&
        intent.humanObservation.content.length > 65_536)
    )
      return;
    if (
      intent.finalAssistant.content.trim().length === 0 ||
      (intent.humanObservation.kind === 'message' &&
        intent.humanObservation.content.trim().length === 0)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'A final turn requires nonblank message content',
      });
    }
  });
export type AutonomousPersonalAssistantFinalIntentV4 = z.infer<
  typeof AutonomousPersonalAssistantFinalIntentV4OwnedDataSchema
>;

/** A current native observation is nonsecret DATA, never a substitute for genuine lineage. */
export const AutonomousPersonalAssistantNativeSnapshotV4OwnedDataSchema = z
  .object({
    config: AutonomousPersonalNativeMemoryConfigV4OwnedDataSchema,
    memoryAttemptHash: MemoryProcessingAttemptHashSchema,
  })
  .strict();
export type AutonomousPersonalAssistantNativeSnapshotV4 = z.infer<
  typeof AutonomousPersonalAssistantNativeSnapshotV4OwnedDataSchema
>;

/** Dedicated settings builder input; the old V2 settings parser remains unchanged. */
export const AutonomousPersonalAssistantDescriptorSettingsV4Schema =
  AutomaticAssistantDescriptorSettingsV2Schema.omit({ assistantWriteAuthority: true })
    .extend({ assistantWriteAuthority: AssistantWriteAuthorityReferenceV4Schema })
    .strict();
export type AutonomousPersonalAssistantDescriptorSettingsV4 = z.infer<
  typeof AutonomousPersonalAssistantDescriptorSettingsV4Schema
>;

/** Owned planner observations; parsing these cannot issue a native invocation. */
export const AutonomousPersonalAssistantFinalPlanDataV4OwnedDataSchema = z
  .object({
    origin: AutonomousPersonalNativeOriginV4OwnedDataSchema,
    nativeSnapshot: AutonomousPersonalAssistantNativeSnapshotV4OwnedDataSchema,
    intent: AutonomousPersonalAssistantFinalIntentV4OwnedDataSchema,
    sourceId: z.string().uuid(),
    operationId: z.string().uuid(),
    beginCallHash: z.string().regex(/^[a-f0-9]{64}$/u),
    completionCallHash: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict()
  .superRefine((data, context) => {
    const origin = data.origin;
    const cfg = data.nativeSnapshot.config;
    if (
      new Set([
        data.sourceId,
        data.operationId,
        origin.identity.sourceId,
        origin.terminalReceipt.operationId,
      ]).size !== 4 ||
      data.nativeSnapshot.memoryAttemptHash !== data.intent.memoryAttemptHash ||
      cfg.invocationDeadlineMs !== data.intent.invocationDeadlineMs ||
      cfg.native.instance !== origin.instance ||
      cfg.native.workflow !== origin.workflow ||
      cfg.native.execution !== origin.execution ||
      cfg.storeHash !== origin.identity.storeHash ||
      cfg.namespace !== origin.identity.namespace ||
      cfg.issuer !== origin.identity.issuer ||
      cfg.actorReference !== origin.identity.actorReference ||
      cfg.turn !== origin.identity.turn ||
      cfg.sourceId !== origin.identity.sourceId
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Inconsistent assistant planner DATA',
      });
  });
export type AutonomousPersonalAssistantFinalPlanDataV4 = z.infer<
  typeof AutonomousPersonalAssistantFinalPlanDataV4OwnedDataSchema
>;

const assistantReceipt = AutomaticCaptureTerminalReceiptV2Schema.refine(
  (receipt) => receipt.kind === 'assistant_final_saved',
);
const decisionReason =
  AutomaticAssistantFinalWriterResultV2Schema.innerType().options[2].shape.reason;

/** A complete candidate is still DATA; only a backend can confirm its durable commit. */
export const AutonomousPersonalAssistantFinalPreparationV4OwnedDataSchema = z.discriminatedUnion(
  'kind',
  [
    z
      .object({
        kind: z.literal('candidate'),
        graph: GraphDataSchema,
        terminalReceipt: assistantReceipt,
      })
      .strict(),
    z.object({ kind: z.literal('replay'), terminalReceipt: assistantReceipt }).strict(),
    z.object({ kind: z.literal('decision'), reason: decisionReason }).strict(),
  ],
);
export type AutonomousPersonalAssistantFinalPreparationV4 = z.infer<
  typeof AutonomousPersonalAssistantFinalPreparationV4OwnedDataSchema
>;

/** Exact same-call observation only; reconciliation cannot return a candidate or trigger a write. */
export const AutonomousPersonalAssistantFinalReconciliationV4OwnedDataSchema = z.discriminatedUnion(
  'kind',
  [
    z.object({ kind: z.literal('matched'), terminalReceipt: assistantReceipt }).strict(),
    z.object({ kind: z.literal('unconfirmed') }).strict(),
  ],
);
export type AutonomousPersonalAssistantFinalReconciliationV4 = z.infer<
  typeof AutonomousPersonalAssistantFinalReconciliationV4OwnedDataSchema
>;

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Own bounded untrusted intent before validation. This facade grants no write permission. */
export const AutonomousPersonalAssistantFinalIntentV4Schema = Object.freeze({
  parse(value: unknown): AutonomousPersonalAssistantFinalIntentV4 {
    try {
      return freeze(
        AutonomousPersonalAssistantFinalIntentV4OwnedDataSchema.parse(
          cloneBoundedAutomaticCaptureJson(value, 'assistantIntent'),
        ),
      );
    } catch {
      throw Object.freeze(new Error('invalid_autonomous_assistant_final_intent'));
    }
  },
});
