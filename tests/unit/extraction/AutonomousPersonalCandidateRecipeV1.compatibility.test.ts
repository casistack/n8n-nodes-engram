import { readFileSync } from 'fs';
import { join } from 'path';
import { compileAutonomousPersonalEvidenceSelectionV1 } from '../../../src/extraction/AutonomousPersonalEvidenceSelectionV1';

const fixtures = JSON.parse(
  readFileSync(
    join(__dirname, '../../fixtures/compatibility/autonomous-evidence-selection-v1.json'),
    'utf8',
  ),
) as Array<{ label: string; input: unknown; response: unknown; expected: unknown }>;

describe('autonomous evidence selection v1 compatibility', () => {
  it.each(fixtures)(
    'preserves complete serialized selection: $label',
    ({ input, response, expected }) => {
      const result = compileAutonomousPersonalEvidenceSelectionV1(input, response, {
        absoluteMonotonicDeadlineMs: performance.now() + 30_000,
        signal: new AbortController().signal,
      });
      expect(JSON.stringify(result)).toBe(JSON.stringify(expected));
    },
  );
});
