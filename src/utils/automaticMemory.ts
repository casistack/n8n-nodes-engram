import type { INodeProperties } from 'n8n-workflow';
import { AutomaticRuntimeSchema } from '../schemas/AutomaticRuntime.schema';
import { compileAutomaticPolicy } from '../extraction/AutomaticEvidence';

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
export const automaticMemoryProperties: INodeProperties[] = [
  automaticProfileProperty,
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
