import type { INodeProperties } from 'n8n-workflow';
import { ExtractionPolicySchema } from '../schemas';

export const advancedExtractionProperties: INodeProperties[] = [
  {
    displayName: 'Entity Resolution',
    name: 'advancedExtractionPolicy',
    type: 'options',
    default: 'legacy',
    options: [
      { name: 'Legacy', value: 'legacy' },
      { name: 'Bounded', value: 'bounded' },
    ],
    description: 'Bound model comparisons and stage changes before applying them',
    displayOptions: { show: { '@version': [2] } },
  },
  {
    displayName: 'Knowledge Selection',
    name: 'knowledgeSelection',
    type: 'options',
    default: 'legacy',
    options: [
      { name: 'Legacy', value: 'legacy' },
      { name: 'Durable and Temporal', value: 'durableTemporal' },
    ],
    description: 'Keep transient requests out of durable graph knowledge',
    displayOptions: { show: { '@version': [2], advancedExtractionPolicy: ['bounded'] } },
  },
  {
    displayName: 'Fuzzy Comparison Limit',
    name: 'fuzzyComparisonLimit',
    type: 'number',
    default: 16,
    typeOptions: { minValue: 0, maxValue: 128 },
    description: 'Maximum fuzzy identity comparisons per extraction',
    displayOptions: { show: { '@version': [2], advancedExtractionPolicy: ['bounded'] } },
  },
  {
    displayName: 'Candidate Shortlist Size',
    name: 'candidateShortlistSize',
    type: 'number',
    default: 8,
    typeOptions: { minValue: 1, maxValue: 64 },
    description: 'Maximum identity candidates compared for each extracted entity',
    displayOptions: { show: { '@version': [2], advancedExtractionPolicy: ['bounded'] } },
  },
  {
    displayName: 'Extraction Request Limit',
    name: 'extractionRequestLimit',
    type: 'number',
    default: 32,
    typeOptions: { minValue: 1, maxValue: 256 },
    description: 'Maximum model and embedding requests per extraction',
    displayOptions: { show: { '@version': [2], advancedExtractionPolicy: ['bounded'] } },
  },
  {
    displayName: 'Extraction Deadline (Milliseconds)',
    name: 'extractionDeadlineMs',
    type: 'number',
    default: 30000,
    typeOptions: { minValue: 100, maxValue: 120000 },
    description: 'Shared deadline for bounded extraction requests',
    displayOptions: { show: { '@version': [2], advancedExtractionPolicy: ['bounded'] } },
  },
  {
    displayName: 'Source Timezone',
    name: 'extractionTimezone',
    type: 'string',
    default: '',
    description: 'Explicit source timezone; leave empty when unknown',
    displayOptions: { show: { '@version': [2], advancedExtractionPolicy: ['bounded'] } },
  },
];
export function readExtractionPolicy(get: (name: string, fallback: unknown) => unknown) {
  return ExtractionPolicySchema.parse({
    mode: get('advancedExtractionPolicy', 'legacy'),
    quality: get('knowledgeSelection', 'legacy'),
    shortlist: get('candidateShortlistSize', 8),
    fuzzy_calls: get('fuzzyComparisonLimit', 16),
    max_calls: get('extractionRequestLimit', 32),
    deadline_ms: get('extractionDeadlineMs', 30000),
    timezone: get('extractionTimezone', '') || undefined,
  });
}
