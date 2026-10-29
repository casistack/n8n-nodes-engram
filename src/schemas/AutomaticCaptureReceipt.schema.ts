import { z } from 'zod';
import { AutomaticReceiptReasonSchema, AutomaticReceiptSchema } from './AutomaticClaim.schema';
import { compileAutomaticPolicy } from '../extraction/AutomaticEvidence';

// Keep schema loading independent of the queue/graph runtime and its barrel exports.
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

/** Structural evidence only; a parsed receipt never grants processing authority. */
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const common = {
  version: z.literal(2),
  operationId: z.string().uuid(),
  sourceId: z.string().uuid(),
  sourceHash: hash,
  descriptorHash: hash,
  terminalAt: z.string().datetime(),
};
const coverage = z.enum(['all', 'partial', 'none', 'unknown']);
const failedReasons = new Set([
  'clause_too_long',
  'object_too_long',
  'too_many_claims',
  'capacity',
  'invalid_envelope',
  'content_mismatch',
  'incomplete_mapping',
  'source_changed',
  'binding_changed',
  'missing_binding',
  'interrupted',
]);
const noFactReasons = new Set(['no_preference_clause', 'not_selected']);
const unknownMeaningReasons = new Set([
  'quoted_content',
  'unsupported_grammar',
  'unsupported_topic',
  'sensitive_topic',
  'mixed_clauses',
  'question',
  'hypothetical',
  'instruction',
  'third_party',
  'explicit_intent_required',
]);
const dependency = z
  .object({
    sourceId: z.string().uuid(),
    dependencyHash: hash,
    itemIndex: z.number().int().min(0).max(31),
    claimId: z.string().uuid().optional(),
    state: z.enum(['accepted', 'proposed', 'rejected', 'deferred', 'not_selected', 'unchanged']),
    persisted: z.boolean(),
    reasons: z.array(AutomaticReceiptReasonSchema).max(8),
  })
  .strict();

const human = z
  .object({
    ...common,
    kind: z.literal('human_capture_committed'),
    receiptInspectionComplete: z.boolean(),
    interpretationCoverage: z.enum(['complete', 'partial', 'none', 'unknown']),
    acceptedCoverage: coverage,
    dependencies: z.array(dependency).min(1).max(32),
    receipt: AutomaticReceiptSchema,
  })
  .strict();
const assistant = z
  .object({ ...common, kind: z.literal('assistant_final_saved'), persisted: z.literal(true) })
  .strict();
const cancelled = z
  .object({ ...common, kind: z.literal('cancelled'), acceptedCoverage: z.literal('none') })
  .strict();

export const AutomaticCaptureTerminalReceiptV2Schema = z
  .discriminatedUnion('kind', [human, assistant, cancelled])
  .superRefine((value, context) => {
    const invalid = (message: string) => context.addIssue({ code: z.ZodIssueCode.custom, message });
    if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 16 * 1024) {
      invalid('Automatic capture terminal receipt exceeds 16 KiB');
    }
    if (value.kind !== 'human_capture_committed') return;
    const receipt = value.receipt;
    if (
      !receipt.persisted ||
      receipt.commitAt !== value.terminalAt ||
      receipt.sourceIds.length !== 1 ||
      receipt.sourceIds[0] !== value.sourceId ||
      !value.receiptInspectionComplete ||
      value.receiptInspectionComplete !== receipt.coverageComplete ||
      receipt.policy.profileId === 'existing' ||
      canonical(receipt.policy) !==
        canonical(compileAutomaticPolicy({ profileId: receipt.policy.profileId }))
    ) {
      invalid('Human receipt must bind the committed source, time and compiled policy');
    }
    if (receipt.items.length === 0 || value.dependencies.length !== receipt.items.length) {
      invalid('Human receipt dependencies must cover every item');
    }
    const indices = new Set<number>();
    const claims = new Set<string>();
    const claimStates = new Set(['accepted', 'unchanged', 'proposed', 'rejected']);
    for (const item of receipt.items) {
      if (item.mutation === 'pending' || item.reasons.some((reason) => failedReasons.has(reason))) {
        invalid('Failed or unfinished work cannot be a committed human receipt');
      }
      if (claimStates.has(item.state)) {
        if (!item.persisted || !item.claimId) {
          invalid('Stored claim states require persisted claim evidence');
        }
        if (
          (item.state === 'accepted' && item.mutation !== 'created') ||
          (item.state === 'unchanged' && item.mutation !== 'none')
        ) {
          invalid('Accepted claim state must match the actual mutation');
        }
      } else if (item.persisted || item.mutation !== 'none' || item.claimId) {
        invalid('Unstored claim states cannot claim a persisted mutation or claim ID');
      }
    }
    const claimItems = receipt.items.filter((item) => claimStates.has(item.state));
    if (claimItems.length > 0) {
      if (
        value.interpretationCoverage !== 'complete' ||
        claimItems.length !== receipt.items.length
      ) {
        invalid('Literal claim receipts require complete supported interpretation');
      }
    } else {
      const reasons = receipt.items.flatMap((item) => item.reasons);
      if (
        reasons.length === 0 ||
        receipt.items.some((item) => item.state !== 'not_selected') ||
        reasons.some((reason) => !noFactReasons.has(reason) && !unknownMeaningReasons.has(reason))
      ) {
        invalid('No-claim terminal receipt requires a known semantic no-selection reason');
      }
      const expectedInterpretation = reasons.every((reason) => noFactReasons.has(reason))
        ? 'none'
        : 'unknown';
      if (value.interpretationCoverage !== expectedInterpretation) {
        invalid('No-claim interpretation coverage must preserve semantic uncertainty');
      }
    }
    for (const dep of value.dependencies) {
      const item = receipt.items[dep.itemIndex];
      if (
        indices.has(dep.itemIndex) ||
        dep.sourceId !== value.sourceId ||
        !item ||
        dep.claimId !== item.claimId ||
        dep.state !== item.state ||
        dep.persisted !== item.persisted ||
        canonical(dep.reasons) !== canonical(item.reasons)
      ) {
        invalid('Human receipt dependencies must bijectively match items');
      }
      indices.add(dep.itemIndex);
      if (dep.claimId) {
        if (claims.has(dep.claimId)) invalid('Human receipt cannot repeat a claim ID');
        claims.add(dep.claimId);
      }
    }
    const accepted = receipt.items.filter(
      (item) => item.persisted && ['accepted', 'unchanged'].includes(item.state),
    );
    const expected =
      accepted.length === 0 ? 'none' : accepted.length === receipt.items.length ? 'all' : 'partial';
    if (value.acceptedCoverage !== expected) {
      invalid('Accepted coverage must follow persisted item states');
    }
    if (accepted.some((item) => !item.claimId)) {
      invalid('Persisted accepted evidence requires a claim ID');
    }
  });

export type AutomaticCaptureTerminalReceiptV2 = z.infer<
  typeof AutomaticCaptureTerminalReceiptV2Schema
>;
