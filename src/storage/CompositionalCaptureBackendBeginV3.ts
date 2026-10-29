import { performance } from 'perf_hooks';
import { cloneBoundedAutomaticCaptureJson } from './BoundedAutomaticCaptureJson';
import { CompositionalCaptureBeginMethodRequestV3Schema } from '../schemas/CompositionalAutomaticCaptureLifecycleV3.schema';
import { buildCompositionalAutomaticDescriptorForRequestV3 } from '../schemas/CompositionalAutomaticCaptureV3.schema';
import type { CompositionalAutomaticCaptureHandleRegistryV3 } from './CompositionalAutomaticCaptureHandlesV3';
import type { CompositionalCaptureBackendBeginSetupV3 } from '../schemas/CompositionalCaptureBackendBeginV3.schema';
import type { EpisodicNode } from '../schemas/EpisodicNode.schema';

/** Linear scan over already owned, validated backend snapshots. */
export function selectCompositionalCaptureNewSourceV3(
  before: readonly EpisodicNode[],
  after: readonly EpisodicNode[],
  expectedId: string,
  check: () => void,
): EpisodicNode {
  const ids = new Set<string>();
  for (const source of before) {
    check();
    ids.add(source.uuid);
  }
  let added: EpisodicNode | undefined;
  for (const source of after) {
    check();
    if (ids.has(source.uuid)) continue;
    if (added || source.uuid !== expectedId)
      throw new Error('Engram compositional capture: invalid_candidate');
    added = source;
  }
  check();
  if (!added) throw new Error('Engram compositional capture: invalid_candidate');
  return added;
}

/** Code-owned adapter setup only; no storage access or processing permission. */
export function startCompositionalBackendBeginV3(
  input: unknown,
  registry: CompositionalAutomaticCaptureHandleRegistryV3,
  methodStartedAt: number,
): CompositionalCaptureBackendBeginSetupV3 {
  try {
    const { request } = CompositionalCaptureBeginMethodRequestV3Schema.parse(
      cloneBoundedAutomaticCaptureJson(input, 'beginRequest'),
    );
    const { descriptor } = buildCompositionalAutomaticDescriptorForRequestV3(request);
    const deadlineAt = methodStartedAt + descriptor.invocationDeadlineMs;
    const remainingMs = Math.floor(deadlineAt - performance.now());
    if (remainingMs < 1)
      return {
        kind: 'decision' as const,
        decision: { kind: 'budget_exhausted' as const, eligibleFirstCommit: false as const },
      };
    const begin = registry.startInitialBegin(request.attemptIdHash, descriptor, { remainingMs });
    const check = () => {
      if (performance.now() >= deadlineAt)
        throw new Error('Engram compositional capture: budget_exhausted');
      registry.readInitialBeginScope(begin.scope);
    };
    check();
    return { kind: 'ready' as const, request, begin, check };
  } catch (error) {
    return {
      kind: 'decision' as const,
      decision: {
        kind:
          error instanceof Error &&
          error.message === 'Engram compositional capture: budget_exhausted'
            ? ('budget_exhausted' as const)
            : ('invalid_input' as const),
        eligibleFirstCommit: false as const,
      },
    };
  }
}
