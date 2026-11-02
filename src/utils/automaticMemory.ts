import type { INodeProperties } from 'n8n-workflow';
import { AutomaticRuntimeSchema } from '../schemas/AutomaticRuntime.schema';
import { compileAutomaticPolicy } from '../extraction/AutomaticEvidence';
import { AUTOMATIC_EXECUTION_BUDGET_NATIVE_DEFAULTS as budgetDefaults } from './autonomousPersonalExecutionBudget';
import { AUTONOMOUS_PERSONAL_EXECUTION_BUDGET_V1_BOUNDS as budgetBounds } from '../schemas/AutonomousPersonalExecutionBudgetV1.schema';

export const automaticProfileProperty: INodeProperties = {
  displayName: 'Memory Behaviour',
  name: 'automaticMemoryProfile',
  type: 'options',
  default: 'existing',
  options: [
    {
      name: 'Existing / Custom',
      value: 'existing',
      description: 'Preserve the configured extraction behaviour',
    },
    {
      name: 'Conservative Automatic',
      value: 'conservative',
      description:
        'Automatically retain supported source-grounded personal memory from verified human sources',
    },
    {
      name: 'Explicit Requests Only',
      value: 'explicit',
      description: 'Require trusted save intent in addition to supported human evidence',
    },
    {
      name: 'Review First',
      value: 'reviewFirst',
      description: 'Propose supported preferences for operator review',
    },
  ],
  displayOptions: { show: { '@version': [3] } },
  description:
    'The interpretation setting determines supported claims. Existing saved workflows keep their current interpretation; unselected statements remain in conversation history.',
};
const show = {
  '@version': [3],
  automaticMemoryProfile: ['conservative', 'explicit', 'reviewFirst'],
};
const autonomousBudgetShow = {
  ...show,
  automaticPreferenceInterpreter: ['autonomousPersonalV1'],
};
const configuredBudgetShow = {
  ...autonomousBudgetShow,
  automaticExecutionBudgetMode: ['configuredV1'],
};

export const automaticExecutionBudgetProperties: INodeProperties[] = [
  {
    displayName: 'Capture Budget Policy',
    name: 'automaticExecutionBudgetMode',
    type: 'options',
    noDataExpression: true,
    default: 'legacy',
    options: [
      { name: 'Existing Limits', value: 'legacy' },
      { name: 'Configured Budgets (V1)', value: 'configuredV1' },
    ],
    displayOptions: { show: autonomousBudgetShow },
    description:
      'Existing Limits preserves saved behaviour, including five-second internal limits. Configured Budgets shares the extraction deadline across capture stages. Set the same policy on Capture and Memory; existing events retain their original policy.',
  },
  ...(['completion', 'syntax'] as const).flatMap((stage): INodeProperties[] => {
    const completion = stage === 'completion';
    const label = completion ? 'Completion' : 'Processing';
    const prefix = completion ? 'automaticCompletionBudget' : 'automaticSyntaxBudget';
    return [
      {
        displayName: `${label} Budget`,
        name: `${prefix}Mode`,
        type: 'options',
        noDataExpression: true,
        default: completion ? budgetDefaults.completionMode : budgetDefaults.syntaxMode,
        options: [
          { name: 'Use Remaining Extraction Deadline', value: 'inheritOverall' },
          { name: 'Explicit Limit', value: 'limited' },
        ],
        displayOptions: { show: configuredBudgetShow },
        description: completion
          ? 'Maximum completion time, always bounded by the original extraction deadline and ownership lease'
          : 'Cumulative synchronous processing allowance across capture; provider and storage waits use the extraction deadline',
      },
      {
        displayName: `${label} Limit (Milliseconds)`,
        name: `${prefix}Ms`,
        type: 'number',
        noDataExpression: true,
        default: completion ? budgetDefaults.completionLimitedMs : budgetDefaults.syntaxLimitedMs,
        typeOptions: {
          minValue: budgetBounds.stageLimitMs.min,
          maxValue: budgetBounds.stageLimitMs.max,
        },
        displayOptions: { show: { ...configuredBudgetShow, [`${prefix}Mode`]: ['limited'] } },
        description:
          'An explicit allowance cannot extend the original extraction deadline or ownership lease',
      },
    ];
  }),
  {
    displayName: 'Finalization Reserve',
    name: 'automaticFinalizationReserveMode',
    type: 'options',
    noDataExpression: true,
    default: budgetDefaults.reserveMode,
    options: [
      { name: 'Automatic', value: 'automatic' },
      { name: 'Fixed', value: 'fixed' },
    ],
    displayOptions: { show: configuredBudgetShow },
    description:
      'Time reserved from provider requests for finalization within the extraction deadline',
  },
  {
    displayName: 'Finalization Reserve (Milliseconds)',
    name: 'automaticFinalizationReserveMs',
    type: 'number',
    noDataExpression: true,
    default: budgetDefaults.reserveFixedMs,
    typeOptions: {
      minValue: budgetBounds.fixedReserveMs.min,
      maxValue: budgetBounds.fixedReserveMs.max,
    },
    displayOptions: {
      show: { ...configuredBudgetShow, automaticFinalizationReserveMode: ['fixed'] },
    },
    description:
      'Must be smaller than the configured extraction deadline; never extends an ownership lease',
  },
];

export const automaticStatementContextProperties: INodeProperties[] = [
  {
    displayName: 'Context-Qualified Statements (V1)',
    name: 'automaticStatementContextMode',
    type: 'options',
    noDataExpression: true,
    default: 'off',
    options: [
      { name: 'Off (Existing Behaviour)', value: 'off' },
      { name: 'Keep Literal When/Whenever Statements (V1)', value: 'contextQualifiedV1' },
    ],
    displayOptions: { show: autonomousBudgetShow },
    description:
      'Off preserves saved behaviour. On also keeps a first-person statement that has one when/whenever clause as an attributed literal record marked context-qualified; the condition is never asserted as true, and if/might/maybe style statements stay withheld. Set the same policy on Capture and Memory; existing events retain their original policy and a different policy conflicts instead of rewriting them.',
  },
];

export const automaticMemoryProperties: INodeProperties[] = [
  automaticProfileProperty,
  ...automaticExecutionBudgetProperties,
  ...automaticStatementContextProperties,
  {
    displayName: 'Automatic Memory Interpretation',
    name: 'automaticPreferenceInterpreter',
    type: 'options',
    noDataExpression: true,
    default: 'literalV1',
    options: [
      {
        name: 'Literal Preferences (Existing)',
        value: 'literalV1',
        description: 'Keep the existing supported preference grammar',
      },
      {
        name: 'Autonomous Personal Memory',
        value: 'autonomousPersonalV1',
        description: 'Interpret source-grounded personal claims with bounded model assistance',
      },
    ],
    displayOptions: { show },
    description:
      'Autonomous Personal Memory requires Replay Safe capture, a verified actor binding and synchronous execution. Review First is not supported by this interpreter. Selecting it does not migrate existing records or activate a queue worker.',
  },
  {
    displayName: 'Verified Actor Issuer',
    name: 'automaticIssuer',
    type: 'string',
    default: '',
    displayOptions: { show },
    description: 'Trusted application identity issuer used in an existing actor binding',
  },
  {
    displayName: 'Verified Actor Reference',
    name: 'automaticActor',
    type: 'string',
    default: '',
    displayOptions: { show },
    description:
      'Stable application actor reference attested by an operator; display names are insufficient',
  },
  {
    displayName: 'Current Turn ID',
    name: 'automaticTurn',
    type: 'string',
    default: '',
    displayOptions: { show },
    description:
      'Stable unique input-event identifier for replay-safe human and final-assistant writes',
  },
  {
    displayName: 'Raw Current Human Content',
    name: 'automaticRawHuman',
    type: 'string',
    default: '',
    displayOptions: { show },
    description:
      'Complete unformatted human message. Leave empty only if agent input is already the complete human message.',
  },
  {
    displayName: 'Application-Owned Display Wrapper',
    name: 'automaticWrapper',
    type: 'options',
    default: 'disabled',
    options: [
      { name: 'Disabled', value: 'disabled' },
      { name: 'Enabled', value: 'enabled' },
    ],
    displayOptions: { show },
    description:
      'Attest that text outside the exact human region is application-owned display metadata, never quoted or reported human context',
  },
  {
    displayName: 'Human Region Start',
    name: 'automaticRegionStart',
    type: 'number',
    default: 0,
    typeOptions: { minValue: 0, maxValue: 65536 },
    displayOptions: { show: { ...show, automaticWrapper: ['enabled'] } },
    description: 'UTF-16 start offset of complete raw human content in formatted agent input',
  },
  {
    displayName: 'Human Region End',
    name: 'automaticRegionEnd',
    type: 'number',
    default: 0,
    typeOptions: { minValue: 1, maxValue: 65536 },
    displayOptions: { show: { ...show, automaticWrapper: ['enabled'] } },
    description: 'Exclusive UTF-16 end offset in formatted agent input',
  },
  {
    displayName: 'Trusted Save Intent',
    name: 'automaticIntent',
    type: 'options',
    default: 'disabled',
    options: [
      { name: 'Disabled', value: 'disabled' },
      { name: 'Enabled', value: 'enabled' },
    ],
    displayOptions: { show },
    description: 'Application-authorized save request; never map from model output or quoted text',
  },
  {
    displayName: 'Captured Human Source ID',
    name: 'automaticCapturedSource',
    type: 'string',
    default: '',
    displayOptions: { show },
    description:
      'Optional source UUID returned by Capture Human Memory before the agent; prevents duplicate human writes and extraction',
  },
];
export function readAutomaticPolicy(get: (name: string, fallback: unknown) => unknown) {
  return compileAutomaticPolicy({
    profileId: get('automaticMemoryProfile', 'existing') as 'existing',
  });
}
export function readAutomaticRuntime(
  get: (name: string, fallback: unknown) => unknown,
  namespace: string,
  storeIdentity: string,
) {
  const policy = readAutomaticPolicy(get);
  if (policy.profileId === 'existing') return undefined;
  const wrapper = get('automaticWrapper', 'disabled') === 'enabled';
  return AutomaticRuntimeSchema.parse({
    profileId: policy.profileId,
    storeIdentity,
    turnId: get('automaticTurn', ''),
    actor: {
      namespace,
      issuer: get('automaticIssuer', ''),
      actorReference: get('automaticActor', ''),
      ...(wrapper
        ? {
            applicationOwnedWrapper: true,
            humanRegion: {
              start: get('automaticRegionStart', 0),
              end: get('automaticRegionEnd', 0),
            },
          }
        : {}),
    },
    rawHumanContent: get('automaticRawHuman', '') || undefined,
    explicitIntent: get('automaticIntent', 'disabled') === 'enabled',
    capturedSourceId: get('automaticCapturedSource', '') || undefined,
  });
}
