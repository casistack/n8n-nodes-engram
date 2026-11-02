import type { IExecuteFunctions, INodeProperties, IDataObject } from 'n8n-workflow';
import type { IGraphStorage } from '../storage/IGraphStorage';
import {
  automaticMemoryProperties,
  readAutomaticRuntime,
  readAutomaticPolicy,
} from './automaticMemory';
import { AutomaticBindingCommandSchema } from '../schemas/AutomaticOperations.schema';
import { captureHumanMemory } from '../memory/AutomaticCapture';
import { readExtractionPolicy } from './advancedExtraction';
import { ExtractionTemperatureSchema } from '../schemas';
import { findAutomaticBinding, assertAutomaticBindingIdentity } from '../storage/AutomaticIdentity';
import { captureReplaySafeHumanMemory } from '../memory/ReplaySafeCapture';
import { readReplaySafeHumanCaptureRequest } from './replaySafeAutomaticAdmin';
import { executeAutonomousPersonalAdminV4 } from './autonomousPersonalAdmin';
import { readNativeAutonomousPersonalExecutionBudgetV1 } from './autonomousPersonalExecutionBudget';
import { readNativeAutonomousPersonalStatementContextV1 } from './autonomousPersonalStatementContext';
import { compileAutonomousPersonalPolicyV3 } from '../schemas/AutonomousPersonalPolicyV3.schema';

const show = { resource: ['automaticMemory'], '@version': [3] };
export const automaticAdminProperties: INodeProperties[] = [
  {
    displayName: 'Capture Lifecycle',
    name: 'automaticCaptureLifecycle',
    type: 'options',
    noDataExpression: true,
    default: 'legacy',
    options: [
      { name: 'Existing', value: 'legacy' },
      { name: 'Replay Safe', value: 'replaySafeV2' },
    ],
    displayOptions: { show: { '@version': [3] } },
    description:
      'Replay Safe requires synchronous durable human capture and separate Proceed/Stopped outputs. Select Existing before using another operation.',
  },
  ...[
    ['Original Producer Workflow ID', 'automaticOriginalWorkflow'],
    ['Original Producer Execution ID', 'automaticOriginalExecution'],
  ].map(
    ([displayName, name]): INodeProperties => ({
      displayName,
      name,
      type: 'string',
      default: '',
      displayOptions: {
        show: { ...show, operation: ['captureHuman'], automaticCaptureLifecycle: ['replaySafeV2'] },
      },
      description:
        'Optional immutable original producer provenance. Leave empty when unknown; never map the current processing execution.',
    }),
  ),
  {
    displayName: 'Operation',
    name: 'operation',
    type: 'options',
    noDataExpression: true,
    default: 'captureHuman',
    displayOptions: { show },
    options: [
      { name: 'Capture Human Memory', value: 'captureHuman', action: 'Capture human memory' },
      { name: 'Preview Memory Policy', value: 'previewAutomatic', action: 'Preview memory policy' },
      {
        name: 'Create Verified Actor Binding',
        value: 'bindActor',
        action: 'Create verified actor binding',
      },
      { name: 'Reassign Actor Binding', value: 'reassignActor', action: 'Reassign actor binding' },
      { name: 'Revoke Actor Binding', value: 'revokeActor', action: 'Revoke actor binding' },
    ],
  },
  {
    displayName: 'Memory Namespace',
    name: 'automaticNamespace',
    type: 'string',
    default: '',
    displayOptions: { show },
    description: 'Exact existing session namespace, including intentional spaces',
  },
  {
    displayName: 'Memory Workflow ID',
    name: 'automaticWorkflowId',
    type: 'string',
    default: '',
    displayOptions: { show: { ...show, backend: ['embedded'] } },
    description:
      'Workflow that owns the memory store, including when this Admin node is in another workflow',
  },
  ...automaticMemoryProperties.map((property) => ({
    ...property,
    displayOptions: { show: { ...property.displayOptions?.show, resource: ['automaticMemory'] } },
  })),
  {
    displayName: 'Formatted Human Input',
    name: 'automaticInput',
    type: 'string',
    default: '',
    displayOptions: { show: { ...show, operation: ['captureHuman'] } },
    description: 'Exact human input the agent will receive; raw content mapping must match',
  },
  {
    displayName: 'Extraction Execution',
    name: 'automaticExecution',
    type: 'options',
    default: 'synchronous',
    options: [
      { name: 'Synchronous', value: 'synchronous' },
      { name: 'Durable Queue', value: 'durable' },
    ],
    displayOptions: { show: { ...show, operation: ['captureHuman'] } },
    description: 'Queue mode requires a separately deployed matching worker',
  },
  ...[
    ['Verified Actor Issuer', 'bindingIssuer'],
    ['Verified Actor Reference', 'bindingActor'],
    ['Accepted Subject UUID', 'bindingSubject'],
    ['Binding UUID', 'bindingId'],
    ['Authorized By', 'bindingAuthorizedBy'],
    ['Review Reason', 'bindingReason'],
  ].map(
    ([displayName, name]): INodeProperties => ({
      displayName,
      name,
      type: 'string',
      default: '',
      displayOptions: {
        show: { ...show, operation: ['bindActor', 'reassignActor', 'revokeActor'] },
      },
    }),
  ),
  {
    displayName: 'Expected Binding Revision',
    name: 'bindingRevision',
    type: 'number',
    default: 1,
    typeOptions: { minValue: 1, maxValue: 2147483647 },
    displayOptions: { show: { ...show, operation: ['reassignActor', 'revokeActor'] } },
  },
];

export async function executeAutomaticAdmin(
  ctx: IExecuteFunctions,
  storage: IGraphStorage,
  operation: string,
  i: number,
  storeIdentity: string,
  safeCapture = false,
): Promise<IDataObject> {
  if ((ctx.getNode().typeVersion ?? 1) < 3) throw new Error('Automatic memory requires Admin v3');
  const get = (name: string, fallback: unknown) =>
    ctx.getNodeParameter(name, i, fallback as string);
  const namespace = get('automaticNamespace', '') as string;
  const configuredLifecycle = ctx.getNode().parameters?.automaticCaptureLifecycle;
  const autonomousPersonal =
    ctx.getNode().parameters?.automaticPreferenceInterpreter === 'autonomousPersonalV1';
  if (operation === 'captureHuman' && autonomousPersonal) {
    if (!safeCapture || configuredLifecycle !== 'replaySafeV2' || i !== 0)
      throw new Error('Engram automatic capture: unsupported_mode');
    return (await executeAutonomousPersonalAdminV4(ctx, storage)) as unknown as IDataObject;
  }
  if (
    operation === 'captureHuman' &&
    configuredLifecycle !== undefined &&
    configuredLifecycle !== 'legacy'
  ) {
    if (!safeCapture) throw new Error('Engram automatic capture: unsupported_mode');
    return (await captureReplaySafeHumanMemory(
      storage,
      readReplaySafeHumanCaptureRequest(ctx, i),
    )) as unknown as IDataObject;
  }
  if (operation === 'previewAutomatic') {
    const policy = readAutomaticPolicy(get);
    const executionBudget = autonomousPersonal
      ? readNativeAutonomousPersonalExecutionBudgetV1(ctx.getNode().parameters, get)
      : undefined;
    const statementContext = autonomousPersonal
      ? readNativeAutonomousPersonalStatementContextV1(ctx.getNode().parameters)
      : undefined;
    let identityReady = false;
    if (storage.readExtractionSnapshot && namespace) {
      const graph = await storage.readExtractionSnapshot(namespace);
      try {
        const binding = findAutomaticBinding(
          graph,
          namespace,
          get('automaticIssuer', '') as string,
          get('automaticActor', '') as string,
        );
        if (binding) {
          assertAutomaticBindingIdentity(graph, namespace, binding.issuer, binding.actorReference, {
            bindingId: binding.bindingId,
            revision: binding.revision,
            subjectId: binding.subjectId,
            fingerprint: binding.fingerprint,
          });
          identityReady = true;
        }
      } catch {
        identityReady = false;
      }
    }
    return {
      operation,
      effectivePolicy: autonomousPersonal
        ? compileAutonomousPersonalPolicyV3({ profileId: policy.profileId })
        : policy,
      ...(autonomousPersonal
        ? {
            interpreter: 'autonomousPersonalV1',
            interpreterSupported: policy.profileId !== 'reviewFirst',
            executionRequirement: 'synchronous_replay_safe',
          }
        : {}),
      ...(executionBudget === undefined ? {} : { executionBudget }),
      ...(statementContext === undefined ? {} : { statementContext }),
      limits: readExtractionPolicy(get),
      identityReady,
      supportedClaims: autonomousPersonal
        ? [
            'source-grounded personal preferences with preserved qualifiers and ordering',
            'attributed dated personal statements when structured meaning cannot be verified',
          ]
        : ['literal first-person language, explanation, format and presentation preferences'],
      unsupportedClaims: autonomousPersonal
        ? [
            'automatic identity creation or alias merging',
            'unverified model inferences or sensitive inferred facts',
            'Review First and background extraction with this interpreter',
          ]
        : [
            'automatic identity creation or alias merging',
            'sensitive inferred facts',
            'free-form paraphrases or temporal commitments',
          ],
      extractionCredentialsRequired: true,
      workerReadiness: 'not_checked',
      mutation: false,
    } as unknown as IDataObject;
  }
  if (operation !== 'captureHuman') {
    if (!storage.automaticBindingCommand) throw new Error('Engram automatic: unsupported_storage');
    const action =
      operation === 'bindActor'
        ? 'create'
        : operation === 'reassignActor'
          ? 'reassign'
          : operation === 'revokeActor'
            ? 'revoke'
            : null;
    if (!action) throw new Error('Engram automatic: unsupported_operation');
    const command = AutomaticBindingCommandSchema.parse({
      action,
      namespace,
      authorizedBy: get('bindingAuthorizedBy', ''),
      reason: get('bindingReason', ''),
      ...(action === 'create'
        ? {
            issuer: get('bindingIssuer', ''),
            actorReference: get('bindingActor', ''),
            subjectId: get('bindingSubject', ''),
          }
        : {
            bindingId: get('bindingId', ''),
            expectedRevision: get('bindingRevision', 1),
            ...(action === 'reassign' ? { subjectId: get('bindingSubject', '') } : {}),
          }),
    });
    const record = await storage.automaticBindingCommand(command);
    return {
      operation,
      bindingId: record.bindingId,
      revision: record.revision,
      state: record.state,
      subjectId: record.subjectId,
    };
  }
  const automaticMemory = readAutomaticRuntime(get, namespace, storeIdentity);
  if (!automaticMemory) throw new Error('Capture requires an automatic profile');
  const credentials = await ctx.getCredentials('engramExtractionApi');
  const mode = get('queueTemperatureMode', 'legacy');
  const policy = readExtractionPolicy(get);
  const result = await captureHumanMemory(
    {
      storage,
      groupId: namespace,
      automaticMemory,
      policy: { finalTurnWrites: true, historyFilter: 'provenance' },
      episodeMetadata: {
        source_message_id: automaticMemory.turnId,
        conversation_id: namespace,
        sender_id: automaticMemory.actor.actorReference,
        source_workflow_id: ctx.getWorkflow().id ?? null,
        source_execution_id: ctx.getExecutionId(),
        trust_level: 'standard',
        review_status: 'accepted',
      },
      enableExtraction: true,
      extractionPolicy: policy,
      extractAi: false,
      extractSystemTool: false,
      extractionExecution: get('automaticExecution', 'synchronous') as 'synchronous' | 'durable',
      extractionRouteId: get('extractionRouteId', '') as string,
      llmConfig: {
        apiKey: credentials.apiKey as string,
        baseUrl: credentials.baseUrl as string,
        model: get('queueModel', '') as string,
        temperature: ExtractionTemperatureSchema.parse(
          mode === 'custom' ? { mode, value: get('queueTemperature', 0) } : { mode },
        ),
      },
      extractionThresholdPolicy: {
        autoAcceptThreshold: get('queueAutoAccept', 0.85) as number,
        rejectBelowThreshold: get('queueRejectBelow', 0.3) as number,
      },
      entityTypes: (
        get('queueEntityTypes', 'person, organization, location, concept, event') as string
      )
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
      ...(get('queueEmbeddings', 'disabled') === 'enabled'
        ? {
            embeddingConfig: {
              apiKey: credentials.apiKey as string,
              baseUrl: credentials.baseUrl as string,
              model: get('queueEmbeddingModel', '') as string,
            },
          }
        : {}),
    },
    get('automaticInput', '') as string,
    { executionId: ctx.getExecutionId() ?? null },
  );
  return { ...result, effectivePolicy: readAutomaticPolicy(get) } as unknown as IDataObject;
}
