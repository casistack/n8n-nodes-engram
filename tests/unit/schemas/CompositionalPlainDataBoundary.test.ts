import { CompositionalAutomaticCaptureBeginRequestV3Schema } from '../../../src/schemas/CompositionalAutomaticCaptureV3.schema';
import { CompositionalCaptureReadRequestV3Schema } from '../../../src/schemas/CompositionalAutomaticCaptureLifecycleV3.schema';
import { CompositionalRetrievalSnapshotV3Schema } from '../../../src/schemas/CompositionalRetrievalSnapshotV3.schema';

describe('compositional plain-data boundaries', () => {
  test.each(['name', 'prototype'] as const)(
    'rejects fake native constructor %s accessors without invoking them',
    (property) => {
      let calls = 0;
      const prototype = Object.create(null) as Record<string, unknown>;
      const constructor = () => undefined;
      Object.defineProperty(constructor, 'name', { value: 'Object', configurable: true });
      Object.defineProperty(constructor, property, {
        get: () => {
          calls += 1;
          return property === 'name' ? 'Object' : prototype;
        },
      });
      Object.defineProperty(prototype, 'constructor', { value: constructor });
      const input = Object.create(prototype) as Record<string, unknown>;

      expect(CompositionalAutomaticCaptureBeginRequestV3Schema.safeParse(input).success).toBe(
        false,
      );
      expect(CompositionalCaptureReadRequestV3Schema.safeParse(input).success).toBe(false);
      expect(CompositionalRetrievalSnapshotV3Schema.parse(input)).toEqual({
        status: 'invalid',
        reason: 'invalid_snapshot',
      });
      expect(calls).toBe(0);
    },
  );
});
