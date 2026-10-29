import { z } from 'zod';

export const CompositionalBundleDecisionCodeV3Schema = z.enum([
  'eligible_create',
  'profile_review_required',
  'explicit_intent_required',
  'existing_accepted',
  'existing_proposed',
  'existing_rejected',
  'existing_ineligible',
  'legacy_reuse_not_authorized',
  'possible_overlap',
  'unknown_overlap_domain',
]);
export type CompositionalBundleDecisionCodeV3 = z.infer<
  typeof CompositionalBundleDecisionCodeV3Schema
>;
