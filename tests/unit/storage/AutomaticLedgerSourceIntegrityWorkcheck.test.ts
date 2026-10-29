import {
  hasAutonomousSourceOwnership,
  assertAutomaticLedgerSourceIntegrity,
  WRITE_OWNER_V4_ATTRIBUTE,
} from '../../../src/storage/AutomaticIdentity';
import type { GraphData } from '../../../src/schemas';
import { autonomousPersonalQualifiedClaimFixtureV4 } from '../../helpers/autonomousPersonalQualifiedClaimV4';

const uuidAt = (value: number) => `f0000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;

let validGraph: GraphData;

beforeAll(async () => {
  const fixture = await autonomousPersonalQualifiedClaimFixtureV4();
  validGraph = fixture.graph;
});

function copyValidGraph(): GraphData {
  return structuredClone(validGraph);
}

function caughtValue(action: () => void): { didThrow: boolean; error: unknown } {
  try {
    action();
    return { didThrow: false, error: undefined };
  } catch (error) {
    return { didThrow: true, error };
  }
}

describe('assertAutomaticLedgerSourceIntegrity cooperative work checks', () => {
  it('preserves valid V4 linkage and leaves graph DATA unchanged with or without a no-op check', () => {
    const graph = copyValidGraph();
    const before = JSON.stringify(graph);

    expect(() => assertAutomaticLedgerSourceIntegrity(graph)).not.toThrow();
    expect(() => assertAutomaticLedgerSourceIntegrity(graph, () => {})).not.toThrow();
    expect(JSON.stringify(graph)).toBe(before);
  });

  it('stops a long source-presence scan and propagates the exact checker error', () => {
    const graph = copyValidGraph();
    const sourceIndex = graph.episodes.findIndex((episode) =>
      hasAutonomousSourceOwnership(episode),
    );
    expect(sourceIndex).toBeGreaterThanOrEqual(0);
    const source = graph.episodes[sourceIndex]!;
    const nonAutonomous = graph.episodes.filter(
      (episode) => !hasAutonomousSourceOwnership(episode),
    );
    let attributeReads = 0;
    const scanRows = Array.from({ length: 5_000 }, (_, index) => {
      const episode = { uuid: uuidAt(10_000 + index), group_id: 'synthetic-large-scan' } as Record<
        string,
        unknown
      >;
      Object.defineProperty(episode, 'attributes', {
        enumerable: true,
        get() {
          attributeReads += 1;
          return {};
        },
      });
      return episode;
    });
    graph.episodes = [...scanRows, ...nonAutonomous, source] as unknown as GraphData['episodes'];
    const sourceBefore = JSON.stringify(source);
    const abort = new Error('source work deadline reached');
    let checks = 0;
    const result = caughtValue(() =>
      assertAutomaticLedgerSourceIntegrity(graph, () => {
        checks += 1;
        if (checks === 40) throw abort;
      }),
    );

    expect(result).toEqual({ didThrow: true, error: abort });
    expect(attributeReads).toBeGreaterThan(0);
    expect(attributeReads).toBeLessThan(scanRows.length);
    expect(JSON.stringify(source)).toBe(sourceBefore);
    expect(graph.episodes).toHaveLength(scanRows.length + nonAutonomous.length + 1);
  });

  it('stops the global ID scan before inspecting the remainder of a large entity list', () => {
    const graph = copyValidGraph();
    let uuidReads = 0;
    const largeEntities = Array.from({ length: 5_000 }, (_, index) => {
      const entity = { group_id: 'synthetic-large-id-scan' } as Record<string, unknown>;
      Object.defineProperty(entity, 'uuid', {
        enumerable: true,
        get() {
          uuidReads += 1;
          return uuidAt(20_000 + index);
        },
      });
      return entity;
    });
    graph.entities = [...(largeEntities as unknown as GraphData['entities']), ...graph.entities];
    const entityCount = graph.entities.length;
    const abort = new Error('global ID work deadline reached');
    let checks = 0;
    const result = caughtValue(() =>
      assertAutomaticLedgerSourceIntegrity(graph, () => {
        checks += 1;
        if (checks === 40) throw abort;
      }),
    );

    expect(result).toEqual({ didThrow: true, error: abort });
    expect(uuidReads).toBeGreaterThan(0);
    expect(uuidReads).toBeLessThan(largeEntities.length);
    expect(graph.entities).toHaveLength(entityCount);
    expect(graph.episodes.some((episode) => WRITE_OWNER_V4_ATTRIBUTE in episode.attributes)).toBe(
      true,
    );
  });

  it('checks each linked operation reconstruction outside its error-remapping catch', () => {
    const graph = copyValidGraph();
    const template = graph.automatic_operations_v1!.operations.find(
      (operation) => operation.version === 4,
    );
    if (!template || template.version !== 4) throw new Error('Expected a committed V4 fixture');

    let firstDescriptorReads = 0;
    let secondDescriptorReads = 0;
    const first = { ...template, operationId: uuidAt(30_000) };
    Object.defineProperty(first, 'descriptor', {
      enumerable: true,
      get() {
        firstDescriptorReads += 1;
        return template.descriptor;
      },
    });
    const second = { ...template, operationId: uuidAt(30_001) };
    Object.defineProperty(second, 'descriptor', {
      enumerable: true,
      get() {
        secondDescriptorReads += 1;
        return template.descriptor;
      },
    });
    graph.automatic_operations_v1!.operations = [
      first,
      second,
      ...Array.from({ length: 1_000 }, (_, index) => ({
        ...template,
        operationId: uuidAt(31_000 + index),
      })),
    ];

    const abort = new Error('operation linkage deadline reached');
    const result = caughtValue(() =>
      assertAutomaticLedgerSourceIntegrity(graph, () => {
        if (firstDescriptorReads > 0) throw abort;
      }),
    );

    expect(result).toEqual({ didThrow: true, error: abort });
    expect(firstDescriptorReads).toBe(1);
    expect(secondDescriptorReads).toBe(0);
  });

  it('propagates an explicitly thrown undefined value without replacing it', () => {
    const result = caughtValue(() =>
      assertAutomaticLedgerSourceIntegrity(validGraph, () => {
        throw undefined;
      }),
    );
    expect(result).toEqual({ didThrow: true, error: undefined });
  });
});
