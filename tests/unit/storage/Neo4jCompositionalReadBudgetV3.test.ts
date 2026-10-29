import neo4j from 'neo4j-driver';
import { createNeo4jCompositionalReadChargeV3 } from '../../../src/storage/Neo4jCompositionalReadBudgetV3';
import {
  getAutomaticClaimReadScope,
  getAutomaticClaimReadScopeRemaining,
  reserveAutomaticClaimSnapshotBytes,
} from '../../../src/storage/AutomaticClaimReadScope';

const setup = (check = () => {}) => {
  const scope = getAutomaticClaimReadScope({ remaining: 512, deferred: 0 });
  return { scope, charge: createNeo4jCompositionalReadChargeV3(scope, check) };
};

describe('Neo4j V3 native read materialization budget', () => {
  it('charges exact JSON bytes for raw scalar/array properties without serializing them', () => {
    const { scope, charge } = setup();
    const value = { attributes: '"\\\n\u0000é漢😀\ud800', flags: [true, false, null, 1.25] };
    const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
    const before = getAutomaticClaimReadScopeRemaining(scope)!.snapshotBytesRemaining;
    const serialize = jest.spyOn(JSON, 'stringify').mockImplementation(() => {
      throw new Error('Native properties must not be serialized');
    });
    try {
      charge(value);
    } finally {
      serialize.mockRestore();
    }
    expect(getAutomaticClaimReadScopeRemaining(scope)!.snapshotBytesRemaining).toBe(before - bytes);
  });

  it('uses the same shared byte budget across rows and acknowledgement readers', () => {
    const { scope, charge } = setup();
    const before = getAutomaticClaimReadScopeRemaining(scope)!.snapshotBytesRemaining;
    charge({ content: 'synthetic' });
    const readback = createNeo4jCompositionalReadChargeV3(scope, () => {});
    readback({ content: 'synthetic' });
    expect(getAutomaticClaimReadScopeRemaining(scope)!.snapshotBytesRemaining).toBe(
      before - 2 * Buffer.byteLength('{"content":"synthetic"}'),
    );
  });

  it('rejects an oversized raw string before serialization or attribute decoding', () => {
    const { scope, charge } = setup();
    expect(reserveAutomaticClaimSnapshotBytes(scope, 100 * 1024 * 1024 - 16)).toBe(true);
    const serialize = jest.spyOn(JSON, 'stringify').mockImplementation(() => {
      throw new Error('must not serialize');
    });
    try {
      expect(() => charge('x'.repeat(32))).toThrow('snapshot_limit');
    } finally {
      serialize.mockRestore();
    }
    expect(() => charge(null)).toThrow('snapshot_limit');
  });

  it('never invokes native-property getters or proxy traps', () => {
    for (const kind of ['getter', 'proxy'] as const) {
      const { charge } = setup();
      let traps = 0;
      const value =
        kind === 'getter'
          ? Object.defineProperty({}, 'attributes', { enumerable: true, get: () => ++traps })
          : new Proxy(
              {},
              {
                get: () => ++traps,
                getPrototypeOf: () => {
                  ++traps;
                  return null;
                },
              },
            );
      expect(() => charge(value)).toThrow('invalid_native_record');
      expect(traps).toBe(0);
    }
  });

  it('preserves cancellation identity and latches it before later records', () => {
    const aborted = new Error('synthetic abort');
    let calls = 0;
    const { charge } = setup(() => {
      if (++calls === 4) throw aborted;
    });
    expect(() => charge({ text: 'synthetic' })).toThrow(aborted);
    const seen = calls;
    expect(() => charge({ text: 'later' })).toThrow(aborted);
    expect(calls).toBe(seen);
  });

  it('charges bounded native integers without JSON.stringify/toJSON', () => {
    const { scope, charge } = setup();
    const before = getAutomaticClaimReadScopeRemaining(scope)!.snapshotBytesRemaining;
    charge(neo4j.int('9223372036854775807'));
    expect(getAutomaticClaimReadScopeRemaining(scope)!.snapshotBytesRemaining).toBe(before - 19);
  });

  it('never evaluates integer discriminators or supplied conversion methods', () => {
    let traps = 0;
    const discriminator = Object.defineProperty({}, '__isInteger__', {
      enumerable: true,
      get: () => ++traps,
    });
    const forged = {
      __isInteger__: true,
      toString: () => {
        ++traps;
        return '0';
      },
    };
    const overridden = neo4j.int(1);
    Object.defineProperty(overridden, 'toString', {
      get: () => {
        ++traps;
        return () => '0';
      },
    });
    for (const value of [discriminator, forged, overridden]) {
      const { charge } = setup();
      expect(() => charge(value)).toThrow('invalid_native_record');
    }
    expect(traps).toBe(0);
  });
});
