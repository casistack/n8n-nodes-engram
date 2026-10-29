import { PreparedCompositionalBundleDecisionV3Schema } from '../schemas/CompositionalMaterializationPreparedV3.schema';
import type { CompositionalBundleDecisionCodeV3 } from '../schemas/CompositionalBundleDecisionCodeV3.schema';
import { cloneBoundedAutomaticCaptureJson } from './BoundedAutomaticCaptureJson';

/** Primary diagnostic only. It grants no acceptance, persistence or write authority. */
export function primaryCompositionalBundleReceiptReasonV3(
  value: unknown,
): CompositionalBundleDecisionCodeV3 {
  const item = PreparedCompositionalBundleDecisionV3Schema.parse(
    cloneBoundedAutomaticCaptureJson(value, 'beginRequest'),
  );
  switch (item.decision) {
    case 'create_accepted':
      return 'eligible_create';
    case 'create_proposed':
      return 'profile_review_required';
    case 'reference_accepted':
      return 'existing_accepted';
    case 'reference_proposed':
      return 'existing_proposed';
    case 'reference_rejected':
      return 'existing_rejected';
    case 'reference_prepared':
      return item.intendedReview === 'accepted' ? 'existing_accepted' : 'existing_proposed';
    case 'not_selected': {
      const priority: readonly CompositionalBundleDecisionCodeV3[] = [
        'explicit_intent_required',
        'existing_ineligible',
        'legacy_reuse_not_authorized',
        'possible_overlap',
        'unknown_overlap_domain',
      ];
      const reason = priority.find((code) => item.codes.includes(code));
      if (!reason) throw new Error('Engram compositional capture: invalid_selection_reason');
      return reason;
    }
  }
}
