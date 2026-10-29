import { makeHumanFixture } from '../../helpers/automaticCommittedFixture';
import { parseLosslessAutomaticCaptureGraph } from '../../../src/storage/LosslessAutomaticCaptureGraph';

describe('lossless validation for new capture graph writes', () => {
  it('retains exact ordinary and mixed-ledger record values in detached data', () => {
    const { graph } = makeHumanFixture();
    const result = parseLosslessAutomaticCaptureGraph(graph);
    expect(result).toEqual(graph);
    result.entities[0].name = 'Synthetic detached mutation';
    expect(graph.entities[0].name).not.toBe(result.entities[0].name);
  });
  it.each(['entities', 'edges', 'episodes'] as const)(
    'rejects normalization of an own special attribute on %s',
    (key) => {
      const { graph } = makeHumanFixture();
      const attrs = JSON.parse(
        '{"__proto__":{"synthetic":"preserve"},"ordinary":"also preserve"}',
      ) as Record<string, unknown>;
      graph[key][0].attributes = { ...graph[key][0].attributes, ...attrs };
      const before = JSON.stringify(graph);
      expect(Object.prototype.hasOwnProperty.call(graph[key][0].attributes, '__proto__')).toBe(
        true,
      );
      expect(() => parseLosslessAutomaticCaptureGraph(graph)).toThrow('record_normalization');
      expect(JSON.stringify(graph)).toBe(before);
    },
  );
  it('does not reject safely retained nested special-key data', () => {
    const { graph } = makeHumanFixture();
    graph.entities[0].attributes.synthetic_nested = JSON.parse(
      '{"__proto__":{"value":"retained data"}}',
    );
    expect(parseLosslessAutomaticCaptureGraph(graph)).toEqual(graph);
  });
  it('rejects root metadata loss and unknown root removal without rewriting either', () => {
    const { graph } = makeHumanFixture();
    const metadata = { ...graph, metadata: JSON.parse('{"__proto__":{"synthetic":"preserve"}}') };
    const before = JSON.stringify(metadata);
    expect(() => parseLosslessAutomaticCaptureGraph(metadata)).toThrow('record_normalization');
    expect(JSON.stringify(metadata)).toBe(before);
    expect(() =>
      parseLosslessAutomaticCaptureGraph({
        ...graph,
        synthetic_unknown_root: { value: 'preserve' },
      }),
    ).toThrow('record_normalization');
  });
});
