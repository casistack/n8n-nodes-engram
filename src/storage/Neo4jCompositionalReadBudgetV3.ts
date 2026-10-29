import { Integer } from 'neo4j-driver';
import { types } from 'util';
import {
  canUseAutomaticClaimReadScope,
  getAutomaticClaimReadScopeRemaining,
  reserveAutomaticClaimSnapshotBytes,
  type AutomaticClaimReadScope,
} from './AutomaticClaimReadScope';

/** Charges native properties before any attribute decoding or serialization. */
export function createNeo4jCompositionalReadChargeV3(
  scope: AutomaticClaimReadScope,
  check: () => void,
): (value: unknown) => void {
  let failed = false;
  let failure: unknown;
  let nodes = 0;
  const guard = () => {
    if (failed) throw failure;
    check();
    if (!canUseAutomaticClaimReadScope(scope))
      throw new Error('Engram compositional capture: budget_exhausted');
  };
  return (value: unknown) => {
    try {
      guard();
      const remaining = getAutomaticClaimReadScopeRemaining(scope);
      if (!remaining) throw new Error('Engram compositional capture: budget_exhausted');
      let bytes = 0;
      const add = (amount: number) => {
        bytes += amount;
        if (bytes > remaining.snapshotBytesRemaining)
          throw new Error('Engram compositional capture: snapshot_limit');
      };
      const string = (text: string) => {
        // UTF-16 length is a lower bound; reject before scanning or allocating.
        if (text.length > remaining.snapshotBytesRemaining - bytes)
          throw new Error('Engram compositional capture: snapshot_limit');
        add(2);
        for (let i = 0; i < text.length; i++) {
          if ((i & 255) === 0) guard();
          const code = text.charCodeAt(i);
          if (code === 34 || code === 92) add(2);
          else if (code < 32) add([8, 9, 10, 12, 13].includes(code) ? 2 : 6);
          else if (code >= 0xd800 && code <= 0xdbff) {
            const next = text.charCodeAt(i + 1);
            if (next >= 0xdc00 && next <= 0xdfff) {
              add(4);
              i++;
            } else add(6);
          } else if (code >= 0xdc00 && code <= 0xdfff) add(6);
          else add(code < 128 ? 1 : code < 2048 ? 2 : 3);
        }
      };
      const active = new WeakSet<object>();
      const visit = (item: unknown, depth: number): void => {
        guard();
        if (++nodes > 8_000_000 || depth > 64)
          throw new Error('Engram compositional capture: snapshot_limit');
        if (item === null) {
          add(4);
          return;
        }
        if (typeof item === 'string') {
          string(item);
          return;
        }
        if (typeof item === 'boolean') {
          add(item ? 4 : 5);
          return;
        }
        if (typeof item === 'number' && Number.isFinite(item)) {
          add(String(item).length);
          return;
        }
        if (typeof item !== 'object' || types.isProxy(item) || active.has(item))
          throw new Error('Engram compositional capture: invalid_native_record');
        // Driver isInt reads a discriminator property. Inspect exact native
        // representation instead, then convert a reconstructed trusted value.
        if (Object.getPrototypeOf(item) === Integer.prototype) {
          const keys = Reflect.ownKeys(item);
          const low = Object.getOwnPropertyDescriptor(item, 'low');
          const high = Object.getOwnPropertyDescriptor(item, 'high');
          if (
            keys.length !== 2 ||
            !keys.includes('low') ||
            !keys.includes('high') ||
            !low ||
            !high ||
            !('value' in low) ||
            !('value' in high) ||
            !Number.isInteger(low.value) ||
            !Number.isInteger(high.value) ||
            low.value < -2147483648 ||
            low.value > 2147483647 ||
            high.value < -2147483648 ||
            high.value > 2147483647
          )
            throw new Error('Engram compositional capture: invalid_native_record');
          add(Integer.prototype.toString.call(new Integer(low.value, high.value)).length);
          return;
        }
        active.add(item);
        if (Array.isArray(item)) {
          add(2);
          for (let i = 0; i < item.length; i++) {
            guard();
            const property = Object.getOwnPropertyDescriptor(item, String(i));
            if (!property || !('value' in property))
              throw new Error('Engram compositional capture: invalid_native_record');
            if (i) add(1);
            visit(property.value, depth + 1);
          }
        } else {
          const prototype = Object.getPrototypeOf(item);
          if (prototype !== Object.prototype && prototype !== null)
            throw new Error('Engram compositional capture: invalid_native_record');
          add(2);
          let first = true;
          for (const key of Reflect.ownKeys(item)) {
            guard();
            if (typeof key !== 'string')
              throw new Error('Engram compositional capture: invalid_native_record');
            const property = Object.getOwnPropertyDescriptor(item, key);
            if (!property || !property.enumerable || !('value' in property))
              throw new Error('Engram compositional capture: invalid_native_record');
            if (!first) add(1);
            first = false;
            string(key);
            add(1);
            visit(property.value, depth + 1);
          }
        }
        active.delete(item);
      };
      visit(value, 0);
      guard();
      if (!reserveAutomaticClaimSnapshotBytes(scope, bytes))
        throw new Error('Engram compositional capture: budget_exhausted');
      guard();
    } catch (error) {
      failed = true;
      failure = error;
      throw error;
    }
  };
}
