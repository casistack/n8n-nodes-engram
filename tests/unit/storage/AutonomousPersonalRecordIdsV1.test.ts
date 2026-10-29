import { deriveAutonomousPersonalRecordIdsV1 } from '../../../src/storage/AutonomousPersonalRecordIdsV1';

const input = {
  namespace: 'synthetic:memory',
  subjectId: '10000000-0000-4000-8000-000000000003',
  key: 'a'.repeat(64),
};

it.each([
  [
    'synthetic:memory',
    '90902ac9-f9c4-5b66-9c5f-5710fda76382',
    '695cb572-747e-5943-97ea-2e5f549e19c7',
  ],
  [
    ' synthetic:memory ',
    'a447c388-c4e5-5171-8107-fe661a70e62d',
    'eac311c8-902b-53f0-816e-b7438fb505a9',
  ],
  ['synthetic:🧭', '371303d2-e218-5869-9c4c-b07cdba2a74c', '657e0de4-6365-5268-8c0d-6062483e2241'],
])('preserves the approved UUIDv5 vector for %s', (namespace, claimId, valueId) => {
  const value = deriveAutonomousPersonalRecordIdsV1({ ...input, namespace });
  expect(value).toEqual({ claimId, valueId });
  expect(Object.isFrozen(value)).toBe(true);
});

it('keeps namespace, subject and meaning keys isolated without mutation', () => {
  const original = { ...input };
  const results = [
    input,
    { ...input, namespace: 'synthetic:other' },
    { ...input, subjectId: '10000000-0000-4000-8000-000000000004' },
    { ...input, key: 'b'.repeat(64) },
  ].flatMap((value) => Object.values(deriveAutonomousPersonalRecordIdsV1(value)));
  expect(new Set(results).size).toBe(8);
  expect(input).toEqual(original);
  expect(
    deriveAutonomousPersonalRecordIdsV1({
      key: input.key,
      subjectId: input.subjectId,
      namespace: input.namespace,
    }),
  ).toEqual(deriveAutonomousPersonalRecordIdsV1(input));
});

it.each([
  null,
  { ...input, namespace: ' ' },
  { ...input, namespace: '\ud800' },
  { ...input, namespace: 'x'.repeat(129) },
  { ...input, subjectId: 'not-a-uuid' },
  { ...input, key: 'x'.repeat(64) },
  { ...input, domain: 'engram-compositional-claim-row-v2' },
  { ...input, should_process: true },
])('rejects malformed or extra DATA with one redacted error (%#)', (value) => {
  expect(() => deriveAutonomousPersonalRecordIdsV1(value)).toThrow(
    'invalid_autonomous_personal_record_ids_data',
  );
});

it('owns unknown input without observing getters or Proxy traps', () => {
  const getter = jest.fn(() => input.namespace);
  const withGetter = Object.defineProperty({ ...input }, 'namespace', { get: getter });
  expect(() => deriveAutonomousPersonalRecordIdsV1(withGetter)).toThrow();
  expect(getter).not.toHaveBeenCalled();
  const trap = jest.fn(() => {
    throw new Error('Do not observe arbitrary code');
  });
  expect(() =>
    deriveAutonomousPersonalRecordIdsV1(
      new Proxy({}, { get: trap, ownKeys: trap, getPrototypeOf: trap }),
    ),
  ).toThrow();
  expect(trap).not.toHaveBeenCalled();
});
