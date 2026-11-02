import { z } from 'zod';
import type { IExecuteFunctions } from 'n8n-workflow';
import { hashAutomaticCaptureV2 } from '../schemas/AutomaticCapture.schema';
import {
  AutonomousPersonalBeginV4RequestOwnedDataSchema,
  parseAutonomousPersonalBeginV4Input,
} from '../schemas/AutonomousPersonalBeginV4.schema';
import {
  AutonomousPersonalDescriptorV4InputOwnedDataSchema,
  compileAutonomousPersonalDescriptorV4,
} from '../schemas/AutonomousPersonalDescriptorV4.schema';
import { readAutomaticRuntime } from './automaticMemory';
import { readNativeAutonomousPersonalExecutionBudgetV1 } from './autonomousPersonalExecutionBudget';
import { readNativeAutonomousPersonalStatementContextV1 } from './autonomousPersonalStatementContext';
import { normalizeHttpBaseUrl } from './url';
import { AutonomousPersonalCaptureNativeContextV4OwnedDataSchema } from '../schemas/AutonomousPersonalCaptureBeginV4.schema';

type ProviderReferenceV4 = z.infer<
  typeof AutonomousPersonalDescriptorV4InputOwnedDataSchema.shape.providerReference
>;
export type AutonomousPersonalProviderReferenceV4 = ProviderReferenceV4;

export type AutonomousPersonalCaptureRuntimeProviderV4 =
  | {
      readonly kind: 'ready';
      readonly routeMatches: boolean;
      /** Ephemeral native-only values; callers must not retain or serialize them. */
      readonly apiKey: string | null;
      readonly baseUrl: string | null;
      readonly model: string | null;
      readonly temperature: ProviderReferenceV4['temperature'] | null;
      readonly configuredRequestLimit: number;
      readonly providerReference: ProviderReferenceV4 | null;
    }
  | { readonly kind: 'invalid' };

const WRAPPER_CONFIGURATION_DOMAIN = 'engram-native-human-wrapper-config-v1';
const PROVIDER_CONFIGURATION_DOMAIN = 'engram-autonomous-provider-configuration-v1';
const beginMode = 'existingStore';
const fixedRequestBytes = 262_144;
const fixedResponseBytes = 65_536;
const fixedTimeoutMs = 30_000;

/** Shared pure recipe for Admin and Memory provider-route DATA fingerprints. */
export function buildAutonomousPersonalProviderReferenceV4(input: {
  readonly routeId: unknown;
  readonly endpoint: string | null;
  readonly model: string;
  readonly configuredRequestLimit: unknown;
  readonly temperature: ProviderReferenceV4['temperature'];
}): ProviderReferenceV4 | null {
  if (input.endpoint === null) return null;
  const fingerprintProvider = {
    routeId: input.routeId,
    endpoint: input.endpoint,
    model: input.model,
    protocol: 'openai-compatible-json-v1' as const,
    structuredContractVersion: 1 as const,
    promptVersion: 1 as const,
    configuredRequestLimit: input.configuredRequestLimit,
    configuredTimeoutMs: fixedTimeoutMs,
    configuredRequestBytes: fixedRequestBytes,
    configuredResponseBytes: fixedResponseBytes,
    temperature: input.temperature,
    responseFormat: 'json_object' as const,
    outputTokenLimit: { mode: 'omit' as const },
  };
  const configurationFingerprint = hashAutomaticCaptureV2({
    domain: PROVIDER_CONFIGURATION_DOMAIN,
    provider: fingerprintProvider,
  });
  return AutonomousPersonalDescriptorV4InputOwnedDataSchema.shape.providerReference.parse({
    routeId: input.routeId,
    configurationFingerprint,
    protocol: 'openai-compatible-json-v1',
    configuredRequestLimit: input.configuredRequestLimit,
    configuredTimeoutMs: fixedTimeoutMs,
    configuredRequestBytes: fixedRequestBytes,
    configuredResponseBytes: fixedResponseBytes,
    temperature: input.temperature,
    responseFormat: 'json_object',
    outputTokenLimit: { mode: 'omit' },
  });
}

const configResultSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('ready'),
      request: AutonomousPersonalBeginV4RequestOwnedDataSchema,
      nativeContext: AutonomousPersonalCaptureNativeContextV4OwnedDataSchema,
    })
    .strict(),
  z.object({ kind: z.literal('unsupported_mode') }).strict(),
  z.object({ kind: z.literal('invalid_input') }).strict(),
]);

export type AutonomousPersonalCaptureNativeConfigV4 = z.infer<typeof configResultSchema>;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value as Record<string, unknown>).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function result(value: unknown): AutonomousPersonalCaptureNativeConfigV4 {
  return deepFreeze(configResultSchema.parse(value));
}

function getNodeParameter(ctx: IExecuteFunctions, index: number, name: string, fallback: unknown) {
  return ctx.getNodeParameter(name, index, fallback as string);
}

async function readProviderRouteAndCredential(ctx: IExecuteFunctions, index: number) {
  const get = (name: string, fallback: unknown) => getNodeParameter(ctx, index, name, fallback);
  let credentials: unknown;
  let credentialLookupSucceeded = true;
  try {
    credentials = await ctx.getCredentials('engramExtractionApi');
  } catch {
    credentialLookupSucceeded = false;
  }

  let apiKey: string | null = null;
  let baseUrl: string | null = null;
  if (credentials && typeof credentials === 'object') {
    const data = credentials as { apiKey?: unknown; baseUrl?: unknown };
    if (typeof data.apiKey === 'string' && data.apiKey.trim().length > 0) apiKey = data.apiKey;
    if (typeof data.baseUrl === 'string') baseUrl = data.baseUrl;
  }
  if (!credentialLookupSucceeded) baseUrl = null;

  const routeId = get('extractionRouteId', '');
  const model = get('queueModel', '');
  const temperatureMode = get('queueTemperatureMode', 'legacy');
  const temperatureInput =
    temperatureMode === 'custom'
      ? { mode: temperatureMode, value: get('queueTemperature', 0) }
      : { mode: temperatureMode };
  const temperature =
    AutonomousPersonalDescriptorV4InputOwnedDataSchema.shape.providerReference.shape.temperature.parse(
      temperatureInput,
    );
  const configuredRequestLimit = get('extractionRequestLimit', 32);
  if (typeof model !== 'string' || model.trim().length === 0) throw new Error('invalid_model');
  let normalizedBaseUrl: string | null = null;
  if (baseUrl !== null) {
    normalizedBaseUrl = normalizeHttpBaseUrl(baseUrl, 'Extraction endpoint');
    const parsedUrl = new URL(normalizedBaseUrl);
    if (parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash) {
      throw new Error('invalid_endpoint');
    }
  }

  const providerReference = buildAutonomousPersonalProviderReferenceV4({
    routeId,
    endpoint: normalizedBaseUrl,
    model,
    configuredRequestLimit,
    temperature,
  });

  return {
    apiKey,
    baseUrl: normalizedBaseUrl,
    model,
    temperature,
    configuredRequestLimit,
    providerReference,
  };
}

async function getProviderReference(
  ctx: IExecuteFunctions,
  index: number,
  allowMissingApiKey = false,
) {
  const current = await readProviderRouteAndCredential(ctx, index);
  if ((!allowMissingApiKey && !current.apiKey) || !current.providerReference) {
    throw new Error('invalid_credentials');
  }
  return current.providerReference;
}

/** Reread only the fixed provider route and ephemeral credential before backend preflight. */
export async function readNativeAutonomousPersonalCaptureRuntimeProviderV4(
  ctx: IExecuteFunctions,
  expected: ProviderReferenceV4,
): Promise<AutonomousPersonalCaptureRuntimeProviderV4> {
  try {
    const current = await readProviderRouteAndCredential(ctx, 0);
    if (!current.providerReference || !current.baseUrl) return { kind: 'invalid' };
    return {
      kind: 'ready',
      routeMatches:
        current.providerReference.configurationFingerprint === expected.configurationFingerprint,
      apiKey: current.apiKey,
      baseUrl: current.baseUrl,
      model: current.model,
      temperature: current.temperature,
      configuredRequestLimit: Number(current.configuredRequestLimit),
      providerReference: current.providerReference,
    };
  } catch {
    return { kind: 'invalid' };
  }
}

/** Read the one fixed Admin v3 source/config mapping. This returns DATA only. */
export async function readNativeAutonomousPersonalCaptureConfigV4(
  ctx: IExecuteFunctions,
): Promise<AutonomousPersonalCaptureNativeConfigV4> {
  return readNativeAutonomousPersonalCaptureConfigInternalV4(ctx, false);
}

/** A1-only reader: a known route may be recorded without a usable API key. */
export async function readNativeAutonomousPersonalCaptureProviderConfigV4(
  ctx: IExecuteFunctions,
): Promise<AutonomousPersonalCaptureNativeConfigV4> {
  return readNativeAutonomousPersonalCaptureConfigInternalV4(ctx, true);
}

async function readNativeAutonomousPersonalCaptureConfigInternalV4(
  ctx: IExecuteFunctions,
  allowMissingApiKey: boolean,
): Promise<AutonomousPersonalCaptureNativeConfigV4> {
  try {
    const node = ctx.getNode();
    if (
      node.type !== 'n8n-nodes-engram.engramAdmin' ||
      node.typeVersion !== 3 ||
      node.parameters.resource !== 'automaticMemory' ||
      node.parameters.operation !== 'captureHuman' ||
      node.parameters.automaticCaptureLifecycle !== 'replaySafeV2' ||
      node.parameters.automaticPreferenceInterpreter !== 'autonomousPersonalV1' ||
      (node.continueOnFail !== undefined && node.continueOnFail !== false) ||
      (node.onError !== undefined && node.onError !== 'stopWorkflow')
    ) {
      return result({ kind: 'unsupported_mode' });
    }
    if (
      ctx.getInputData(0).length !== 1 ||
      getNodeParameter(ctx, 0, 'automaticExecution', 'synchronous') !== 'synchronous'
    ) {
      return result({ kind: 'unsupported_mode' });
    }

    const parameters = new Map<string, unknown>();
    const get = (name: string, fallback: unknown) => {
      if (!parameters.has(name)) parameters.set(name, getNodeParameter(ctx, 0, name, fallback));
      return parameters.get(name);
    };
    const wrapperMode = get('automaticWrapper', 'disabled');
    const intentMode = get('automaticIntent', 'disabled');
    const rawHuman = get('automaticRawHuman', '');
    const originalWorkflow = get('automaticOriginalWorkflow', '');
    if (
      (wrapperMode !== 'disabled' && wrapperMode !== 'enabled') ||
      (intentMode !== 'disabled' && intentMode !== 'enabled') ||
      (rawHuman !== undefined && typeof rawHuman !== 'string') ||
      (originalWorkflow !== undefined &&
        originalWorkflow !== null &&
        typeof originalWorkflow !== 'string')
    ) {
      return result({ kind: 'invalid_input' });
    }
    const originalExecution = get('automaticOriginalExecution', '');
    const capturedSource = get('automaticCapturedSource', '');
    if (
      typeof originalExecution !== 'string' ||
      originalExecution.length !== 0 ||
      typeof capturedSource !== 'string' ||
      capturedSource.length !== 0
    ) {
      return result({ kind: 'invalid_input' });
    }

    const namespace = get('automaticNamespace', '') as string;
    const runtime = readAutomaticRuntime(get, namespace, '0'.repeat(64));
    if (!runtime) return result({ kind: 'invalid_input' });

    const rawContent = get('automaticInput', '');
    if (typeof rawContent !== 'string') return result({ kind: 'invalid_input' });
    const rawHumanContent = rawHuman === '' ? undefined : rawHuman;
    const humanRegion = runtime.actor.humanRegion;
    const wrapperEnabled = runtime.actor.applicationOwnedWrapper === true;
    if (wrapperEnabled && (!humanRegion || rawHumanContent === undefined)) {
      return result({ kind: 'invalid_input' });
    }
    const body = humanRegion ? rawContent.slice(humanRegion.start, humanRegion.end) : rawContent;
    if (rawHumanContent !== undefined && rawHumanContent !== body) {
      return result({ kind: 'invalid_input' });
    }

    const providerReference = await getProviderReference(ctx, 0, allowMissingApiKey);
    const invocationDeadlineMs = get('extractionDeadlineMs', 30_000);
    const executionBudget = readNativeAutonomousPersonalExecutionBudgetV1(node.parameters, get);
    const statementContext = readNativeAutonomousPersonalStatementContextV1(node.parameters);
    const requestSettings = AutonomousPersonalDescriptorV4InputOwnedDataSchema.parse({
      profileId: runtime.profileId,
      requestedTrustLevel: 'standard',
      intentSetting: runtime.explicitIntent,
      invocationDeadlineMs,
      providerReference,
      ...(executionBudget === undefined ? {} : { executionBudget }),
      ...(statementContext === undefined ? {} : { statementContext }),
    });
    // Legacy path stays unchanged; configured settings must also compile (reserve vs allowance).
    if (executionBudget !== undefined || statementContext !== undefined) {
      compileAutonomousPersonalDescriptorV4(requestSettings);
    }

    const mapping = wrapperEnabled
      ? {
          mode: 'application_region' as const,
          humanRegion,
          applicationWrapper: {
            configurationFingerprint: hashAutomaticCaptureV2({
              domain: WRAPPER_CONFIGURATION_DOMAIN,
              configuration: {
                nodeType: 'n8n-nodes-engram.engramAdmin',
                nodeVersion: 3,
                resource: 'automaticMemory',
                operation: 'captureHuman',
                wrapperMode: 'enabled',
                regionEncoding: 'utf16',
              },
            }),
          },
        }
      : { mode: 'full_body' as const };

    const workflow = ctx.getWorkflow().id ?? null;
    const execution = ctx.getExecutionId();
    const instance = ctx.getInstanceId();
    const input = {
      mode: beginMode,
      request: {
        version: 4,
        lifecycle: 'replaySafeV2',
        purpose: 'human_turn_memory',
        interpretationFamily: 'autonomous-personal-v1',
        namespace,
        issuer: runtime.actor.issuer,
        actorReference: runtime.actor.actorReference,
        turn: runtime.turnId,
        settings: requestSettings,
        source: {
          content: rawContent,
          sourceMessageId: null,
          conversationId: null,
          senderId: null,
          sourceWorkflowId:
            originalWorkflow === '' || originalWorkflow === undefined ? null : originalWorkflow,
          quotedMessageId: null,
          sourceType: 'message',
          eventTime: { mode: 'first_capture' },
          mapping,
          quoteRegions: [],
        },
      },
    };
    const parsed = parseAutonomousPersonalBeginV4Input(input);
    if (parsed.kind !== 'ready') return result({ kind: 'invalid_input' });

    return result({
      kind: 'ready',
      request: parsed.request,
      nativeContext: { instance, workflow, execution },
    });
  } catch (error) {
    return result({
      kind:
        error instanceof Error && error.message === 'Engram automatic capture: unsupported_mode'
          ? 'unsupported_mode'
          : 'invalid_input',
    });
  }
}
