import type { IExecuteFunctions } from 'n8n-workflow';
import { z } from 'zod';
import {
  AutonomousPersonalNativeMemoryConfigV4OwnedDataSchema,
  type AutonomousPersonalNativeMemoryConfigV4,
} from '../schemas/AutonomousPersonalNativeMemoryConfigV4.schema';
import {
  AutonomousPersonalDescriptorV4InputOwnedDataSchema,
  compileAutonomousPersonalDescriptorV4,
} from '../schemas/AutonomousPersonalDescriptorV4.schema';
import {
  BoundedAutomaticCaptureJsonError,
  cloneBoundedAutomaticCaptureJson,
} from '../storage/BoundedAutomaticCaptureJson';
import { AutonomousPersonalMemoryHandoffLocatorV4OwnedDataSchema } from '../schemas/AutonomousPersonalMemoryHandoffV4.schema';
import { buildAutonomousPersonalProviderReferenceV4 } from './AutonomousPersonalCaptureNativeConfigV4';
import { readAutomaticRuntime } from './automaticMemory';
import { readNativeAutonomousPersonalExecutionBudgetV1 } from './autonomousPersonalExecutionBudget';
import { readNativeAutonomousPersonalStatementContextV1 } from './autonomousPersonalStatementContext';
import { readExtractionPolicy } from './advancedExtraction';
import {
  readReplaySafeMemoryNativeContext,
  readReplaySafeMemoryNamespace,
} from './replaySafeMemoryNative';
import { normalizeHttpBaseUrl } from './url';

export type AutonomousPersonalNativeMemoryConfigContextV4 = Pick<
  IExecuteFunctions,
  | 'getNode'
  | 'getNodeParameter'
  | 'getInputData'
  | 'getExecutionId'
  | 'getWorkflow'
  | 'getInstanceId'
  | 'getCredentials'
  | 'evaluateExpression'
>;

export type AutonomousPersonalNativeMemoryConfigFailureReasonV4 =
  | 'unsupported_configuration'
  | 'invalid_input'
  | 'capacity';

export class AutonomousPersonalNativeMemoryConfigV4Error extends Error {
  constructor(readonly reason: AutonomousPersonalNativeMemoryConfigFailureReasonV4) {
    super(`Engram native Memory config: ${reason}`);
    this.name = 'AutonomousPersonalNativeMemoryConfigV4Error';
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value as Record<string, unknown>).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function getParameter(
  ctx: AutonomousPersonalNativeMemoryConfigContextV4,
  itemIndex: number,
  name: string,
  fallback: unknown,
): unknown {
  return ctx.getNodeParameter(name, itemIndex, fallback as string);
}

function readTemperature(
  get: (name: string, fallback: unknown) => unknown,
): z.infer<
  typeof AutonomousPersonalDescriptorV4InputOwnedDataSchema.shape.providerReference.shape.temperature
> {
  const mode = get('extractionTemperatureMode', 'legacy');
  const candidate = mode === 'custom' ? { mode, value: get('extractionTemperature', 0) } : { mode };
  return AutonomousPersonalDescriptorV4InputOwnedDataSchema.shape.providerReference.shape.temperature.parse(
    candidate,
  );
}

function deepCloneAndParse(value: unknown): AutonomousPersonalNativeMemoryConfigV4 {
  try {
    const owned = cloneBoundedAutomaticCaptureJson<unknown>(value, 'beginRequest');
    return deepFreeze(AutonomousPersonalNativeMemoryConfigV4OwnedDataSchema.parse(owned));
  } catch (error) {
    if (error instanceof BoundedAutomaticCaptureJsonError) {
      throw new AutonomousPersonalNativeMemoryConfigV4Error(
        error.reason === 'bytes' || error.reason === 'nodes' || error.reason === 'depth'
          ? 'capacity'
          : 'invalid_input',
      );
    }
    throw new AutonomousPersonalNativeMemoryConfigV4Error('invalid_input');
  }
}

/** Read strict Memory-native DATA without retaining ctx or credential values. */
export async function readAutonomousPersonalNativeMemoryConfigV4(
  ctx: AutonomousPersonalNativeMemoryConfigContextV4,
  itemIndex: number,
  storeHashValue: unknown,
): Promise<AutonomousPersonalNativeMemoryConfigV4> {
  if (!ctx || typeof ctx !== 'object') {
    throw new AutonomousPersonalNativeMemoryConfigV4Error('unsupported_configuration');
  }

  try {
    // The existing native helper owns fixed Memory node/version, stop-on-error,
    // one-main-item and native execution admission. This cast preserves the
    // minimal SupplyData-compatible surface used by both fixed readers.
    const executionContext = ctx as IExecuteFunctions;
    const nativeAdmission = readReplaySafeMemoryNativeContext(executionContext, itemIndex);
    if (!nativeAdmission) {
      throw new AutonomousPersonalNativeMemoryConfigV4Error('unsupported_configuration');
    }
    if (getParameter(ctx, itemIndex, 'extractionExecution', 'synchronous') !== 'synchronous') {
      throw new AutonomousPersonalNativeMemoryConfigV4Error('unsupported_configuration');
    }

    const storeHash =
      AutonomousPersonalMemoryHandoffLocatorV4OwnedDataSchema.shape.storeHash.parse(storeHashValue);
    const namespace = readReplaySafeMemoryNamespace(executionContext, itemIndex);
    const parameters = new Map<string, unknown>();
    const get = (name: string, fallback: unknown) => {
      if (!parameters.has(name)) parameters.set(name, getParameter(ctx, itemIndex, name, fallback));
      return parameters.get(name);
    };
    const wrapperMode = get('automaticWrapper', 'disabled');
    const intentMode = get('automaticIntent', 'disabled');
    if (
      (wrapperMode !== 'disabled' && wrapperMode !== 'enabled') ||
      (intentMode !== 'disabled' && intentMode !== 'enabled')
    ) {
      throw new AutonomousPersonalNativeMemoryConfigV4Error('invalid_input');
    }
    const automatic = readAutomaticRuntime(get, namespace, storeHash);
    if (!automatic || !automatic.capturedSourceId) {
      throw new AutonomousPersonalNativeMemoryConfigV4Error('unsupported_configuration');
    }

    const queryValue = get('currentHumanQuery', '');
    const currentHumanQuery =
      AutonomousPersonalNativeMemoryConfigV4OwnedDataSchema.shape.currentHumanQuery.parse(
        queryValue,
      );
    const policy = readExtractionPolicy(get);
    if (policy.mode !== 'bounded') {
      throw new AutonomousPersonalNativeMemoryConfigV4Error('unsupported_configuration');
    }

    const wrapperEnabled = automatic.actor.applicationOwnedWrapper === true;
    const humanRegion = automatic.actor.humanRegion;
    const rawHumanContent = automatic.rawHumanContent;
    let sourceMapping: unknown;
    if (wrapperEnabled) {
      if (!humanRegion || rawHumanContent === undefined || rawHumanContent !== currentHumanQuery) {
        throw new AutonomousPersonalNativeMemoryConfigV4Error('invalid_input');
      }
      sourceMapping = {
        mode: 'application_region',
        humanRegion: { start: humanRegion.start, end: humanRegion.end },
      };
    } else {
      if (rawHumanContent !== undefined && rawHumanContent !== currentHumanQuery) {
        throw new AutonomousPersonalNativeMemoryConfigV4Error('invalid_input');
      }
      sourceMapping = { mode: 'full_body' };
    }

    const routeId = get('extractionRouteId', '');
    const model = get('extractionModel', '');
    if (typeof model !== 'string' || model.trim().length === 0) {
      throw new AutonomousPersonalNativeMemoryConfigV4Error('unsupported_configuration');
    }
    let credentials: unknown;
    try {
      credentials = await ctx.getCredentials('engramExtractionApi');
    } catch {
      throw new AutonomousPersonalNativeMemoryConfigV4Error('unsupported_configuration');
    }

    let configuredBaseUrl: string | null = null;
    if (credentials && typeof credentials === 'object') {
      const credentialData = credentials as { baseUrl?: unknown };
      if (typeof credentialData.baseUrl === 'string') {
        configuredBaseUrl = cloneBoundedAutomaticCaptureJson<{ baseUrl: string }>(
          { baseUrl: credentialData.baseUrl },
          'beginRequest',
        ).baseUrl;
      }
    }
    let endpoint: string | null = null;
    if (configuredBaseUrl !== null) {
      endpoint = normalizeHttpBaseUrl(configuredBaseUrl, 'Extraction endpoint');
      const parsedUrl = new URL(endpoint);
      if (parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash) {
        throw new AutonomousPersonalNativeMemoryConfigV4Error('unsupported_configuration');
      }
    }

    const configuredRequestLimit = get('extractionRequestLimit', 32);
    const temperature = readTemperature(get);
    const providerInput = cloneBoundedAutomaticCaptureJson<{
      routeId: unknown;
      endpoint: string | null;
      model: string;
      configuredRequestLimit: unknown;
      temperature: typeof temperature;
    }>({ routeId, endpoint, model, configuredRequestLimit, temperature }, 'beginRequest');
    const providerReference = buildAutonomousPersonalProviderReferenceV4(providerInput);
    if (!providerReference) {
      throw new AutonomousPersonalNativeMemoryConfigV4Error('unsupported_configuration');
    }

    const executionBudget = readNativeAutonomousPersonalExecutionBudgetV1(
      ctx.getNode().parameters,
      get,
    );
    const statementContext = readNativeAutonomousPersonalStatementContextV1(
      ctx.getNode().parameters,
    );
    const native = {
      instance: ctx.getInstanceId(),
      workflow: ctx.getWorkflow().id ?? null,
      execution: ctx.getExecutionId(),
    };
    const candidate = {
      version: 4,
      native,
      storeHash,
      namespace,
      issuer: automatic.actor.issuer,
      actorReference: automatic.actor.actorReference,
      turn: automatic.turnId,
      sourceId: automatic.capturedSourceId,
      profileId: automatic.profileId,
      explicitIntent: automatic.explicitIntent,
      currentHumanQuery,
      ...(rawHumanContent === undefined ? {} : { rawHumanContent }),
      sourceMapping,
      quoteRegions: [],
      invocationDeadlineMs: policy.deadline_ms,
      providerReference,
      ...(executionBudget === undefined ? {} : { executionBudget }),
      ...(statementContext === undefined ? {} : { statementContext }),
    };
    const config = deepCloneAndParse(candidate);

    compileAutonomousPersonalDescriptorV4({
      profileId: config.profileId,
      requestedTrustLevel: 'standard',
      intentSetting: config.explicitIntent,
      invocationDeadlineMs: config.invocationDeadlineMs,
      providerReference: config.providerReference,
      ...(config.executionBudget === undefined ? {} : { executionBudget: config.executionBudget }),
      ...(config.statementContext === undefined
        ? {}
        : { statementContext: config.statementContext }),
    });
    return config;
  } catch (error) {
    if (error instanceof AutonomousPersonalNativeMemoryConfigV4Error) throw error;
    if (error instanceof BoundedAutomaticCaptureJsonError) {
      throw new AutonomousPersonalNativeMemoryConfigV4Error(
        error.reason === 'bytes' || error.reason === 'nodes' || error.reason === 'depth'
          ? 'capacity'
          : 'invalid_input',
      );
    }
    const reason =
      error instanceof Error &&
      error.message === 'Engram replay-safe memory: unsupported_configuration'
        ? 'unsupported_configuration'
        : 'invalid_input';
    throw new AutonomousPersonalNativeMemoryConfigV4Error(reason);
  }
}
