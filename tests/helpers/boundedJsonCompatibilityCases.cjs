'use strict';
// Descriptor/value compatibility corpus retained from the bounded JSON contract.
const vm = require('node:vm');
const { types: utilTypes } = require('node:util');
module.exports = function createBoundedJsonCompatibilitySuite(original, variant) {
  const V = { original, variant };
  // ---------------------------------------------------------------- (a) output comparison: two independent JSON-valued results
  // Used ONLY for values returned by clone() (plain JSON data), never for raw inputs. Compares prototype identity, own-key
  // sequence, every descriptor, extensibility/sealed/frozen state and Object.is on primitives. Never invokes accessors.
  function deepDiff(a, b, limit = 20) {
    const diffs = [],
      seen = new WeakMap();
    const note = (p, why) => {
      if (diffs.length < limit) diffs.push(p + ': ' + why);
    };
    const walk = (x, y, p, depth) => {
      if (diffs.length >= limit) return;
      if (depth > 300) return note(p, 'depth guard');
      if (typeof x !== typeof y) return note(p, 'typeof ' + typeof x + ' vs ' + typeof y);
      if (x === null || y === null || (typeof x !== 'object' && typeof x !== 'function')) {
        if (!Object.is(x, y)) note(p, 'primitive differs (' + typeof x + ', ' + typeof y + ')');
        return;
      }
      if (seen.has(x)) {
        if (seen.get(x) !== y) note(p, 'shape of shared/cyclic references differs');
        return;
      }
      seen.set(x, y);
      if (Object.getPrototypeOf(x) !== Object.getPrototypeOf(y))
        return note(p, 'prototype differs');
      if (Array.isArray(x) !== Array.isArray(y)) return note(p, 'array-ness differs');
      if (
        Object.isExtensible(x) !== Object.isExtensible(y) ||
        Object.isSealed(x) !== Object.isSealed(y) ||
        Object.isFrozen(x) !== Object.isFrozen(y)
      )
        note(p, 'extensible/sealed/frozen differs');
      const kx = Reflect.ownKeys(x).map(String),
        ky = Reflect.ownKeys(y).map(String);
      if (kx.length !== ky.length || kx.some((k, i) => k !== ky[i]))
        return note(p, 'own key sequence differs');
      for (const k of Reflect.ownKeys(x)) {
        const dx = Object.getOwnPropertyDescriptor(x, k),
          dy = Object.getOwnPropertyDescriptor(y, k);
        const q = p + '[' + JSON.stringify(String(k)) + ']';
        if (!dy) return note(q, 'missing descriptor');
        for (const f of ['enumerable', 'writable', 'configurable'])
          if (dx[f] !== dy[f]) note(q, f + ' differs');
        if (
          'value' in dx !== 'value' in dy ||
          typeof dx.get !== typeof dy.get ||
          typeof dx.set !== typeof dy.set
        ) {
          note(q, 'descriptor kind differs');
          continue;
        }
        if ('value' in dx) walk(dx.value, dy.value, q, depth + 1);
      }
    };
    walk(a, b, '$', 0);
    return diffs;
  }

  // ---------------------------------------------------------------- (b) input baseline: reference-identity snapshot of ONE input
  // Captured before a clone call and again after it, from the SAME input object, then compared. It never rebuilds an input and never
  // compares two make() results, so a fresh Symbol / fresh class prototype per make() cannot cause a false mutation report.
  // Unsupported leaves (symbols, functions, bigint, undefined, ...) are recorded and compared BY IDENTITY (Object.is). Object nodes
  // record: the object reference itself, DFS id (order of discovery), prototype reference, extensible/sealed/frozen flags, the exact
  // own-key sequence (symbols by identity) and for each key the descriptor flags plus either the child snapshot (data property) or the
  // get/set function identities (accessor; NEVER invoked). Proxies are recorded by identity only and are not traversed (no traps run).
  // Date time value and Map size are recorded through brand-checked builtins.
  function snapshot(root) {
    const ids = new Map();
    let next = 0;
    const mapSize = Object.getOwnPropertyDescriptor(Map.prototype, 'size').get;
    const walk = (v) => {
      if (typeof v === 'function') return { k: 'f', v };
      if (v === null || typeof v !== 'object') return { k: 'p', v };
      if (ids.has(v)) return { k: 'ref', id: ids.get(v) };
      const id = next++;
      ids.set(v, id);
      if (utilTypes.isProxy(v)) return { k: 'proxy', id, v };
      const node = {
        k: 'o',
        id,
        v,
        proto: Object.getPrototypeOf(v),
        ext: Object.isExtensible(v),
        sealed: Object.isSealed(v),
        frozen: Object.isFrozen(v),
        date: utilTypes.isDate(v) ? Date.prototype.getTime.call(v) : undefined,
        mapSize: utilTypes.isMap(v) ? mapSize.call(v) : undefined,
        keys: [],
        descs: [],
      };
      for (const key of Reflect.ownKeys(v)) {
        const d = Object.getOwnPropertyDescriptor(v, key);
        node.keys.push(key);
        node.descs.push(
          'value' in d
            ? {
                e: d.enumerable,
                w: d.writable,
                c: d.configurable,
                data: true,
                child: walk(d.value),
              }
            : { e: d.enumerable, c: d.configurable, data: false, get: d.get, set: d.set },
        );
      }
      return node;
    };
    return walk(root);
  }
  function snapDiff(a, b, limit = 10) {
    const diffs = [];
    const note = (p, why) => {
      if (diffs.length < limit) diffs.push(p + ': ' + why);
    };
    const walk = (x, y, p) => {
      if (diffs.length >= limit) return;
      if (x.k !== y.k) return note(p, 'node kind ' + x.k + ' vs ' + y.k);
      if (x.k === 'p' || x.k === 'f') {
        if (!Object.is(x.v, y.v)) note(p, 'leaf identity/value changed');
        return;
      }
      if (x.k === 'ref') {
        if (x.id !== y.id) note(p, 'shared/cyclic reference target changed');
        return;
      }
      if (x.id !== y.id || x.v !== y.v)
        return note(p, 'object identity or discovery order changed');
      if (x.k === 'proxy') return;
      if (x.proto !== y.proto) note(p, 'prototype changed');
      if (x.ext !== y.ext || x.sealed !== y.sealed || x.frozen !== y.frozen)
        note(p, 'extensible/sealed/frozen changed');
      if (!Object.is(x.date, y.date) || x.mapSize !== y.mapSize)
        note(p, 'Date value / Map size changed');
      if (x.keys.length !== y.keys.length || x.keys.some((k, i) => k !== y.keys[i]))
        return note(p, 'own key sequence changed');
      for (let i = 0; i < x.keys.length; i++) {
        const dx = x.descs[i],
          dy = y.descs[i],
          q = p + '[' + JSON.stringify(String(x.keys[i])) + ']';
        if (dx.data !== dy.data || dx.e !== dy.e || dx.c !== dy.c || dx.w !== dy.w) {
          note(q, 'descriptor flags/kind changed');
          continue;
        }
        if (dx.data) walk(dx.child, dy.child, q);
        else if (dx.get !== dy.get || dx.set !== dy.set)
          note(q, 'accessor function identity changed');
      }
    };
    walk(a, b, '$');
    return diffs;
  }
  // Proves the detector is not vacuous: every listed mutation must be reported, an untouched control must not be.
  function detectorSelfTest() {
    class K {}
    const sym = Symbol('s');
    const mk = () => {
      const o = JSON.parse('{"__proto__":{"x":1},"a":{"b":[1,2]},"c":3}');
      o.s = sym;
      o.inst = new K();
      return o;
    };
    const mutations = {
      'add key': (o) => {
        o.zz = 1;
      },
      'change value': (o) => {
        o.a.b[0] = 9;
      },
      'delete key': (o) => {
        delete o.a.b;
      },
      'reorder keys': (o) => {
        const v = o.a;
        delete o.a;
        o.a = v;
      },
      'redefine flags': (o) => {
        Object.defineProperty(o, 'c', { enumerable: false });
      },
      'freeze nested': (o) => {
        Object.freeze(o.a);
      },
      'change prototype': (o) => {
        Object.setPrototypeOf(o.inst, null);
      },
      'swap symbol leaf': (o) => {
        o.s = Symbol('s');
      },
      'swap class instance': (o) => {
        o.inst = new K();
      },
      'array push': (o) => {
        o.a.b.push(3);
      },
      'mutate value under own __proto__': (o) => {
        Object.getOwnPropertyDescriptor(o, '__proto__').value.x = 2;
      },
      'replace accessor': (o) => {
        Object.defineProperty(o, 'g', {
          get() {
            return 1;
          },
          enumerable: true,
          configurable: true,
        });
      },
    };
    const undetected = [];
    const control = mk();
    if (snapDiff(snapshot(control), snapshot(control)).length !== 0)
      undetected.push('control reported a difference');
    const acc = mk();
    Object.defineProperty(acc, 'g', {
      get() {
        return 0;
      },
      enumerable: true,
      configurable: true,
    });
    const before = snapshot(acc);
    Object.defineProperty(acc, 'g', {
      get() {
        return 1;
      },
      enumerable: true,
      configurable: true,
    });
    if (snapDiff(before, snapshot(acc)).length === 0) undetected.push('accessor function swap');
    for (const [name, mutate] of Object.entries(mutations)) {
      const o = mk();
      const b = snapshot(o);
      mutate(o);
      if (snapDiff(b, snapshot(o)).length === 0) undetected.push(name);
    }
    return {
      ok: undetected.length === 0,
      mutations_checked: Object.keys(mutations).length + 2,
      undetected,
    };
  }

  const errSig = (e) => ({
    isError: e instanceof Error,
    ctor: e?.constructor?.name ?? null,
    name: typeof e?.name === 'string' ? e.name : null,
    reason: e?.reason ?? null,
    message: typeof e?.message === 'string' ? e.message : null,
    ownKeys: e && typeof e === 'object' ? Reflect.ownKeys(e).map(String).sort() : [],
  });
  function run(mod, make, bound) {
    const input = make();
    const before = snapshot(input);
    let r;
    try {
      r = { ok: true, value: mod.cloneBoundedAutomaticCaptureJson(input, bound) };
    } catch (e) {
      r = { ok: false, err: errSig(e) };
    }
    r.mutation = snapDiff(before, snapshot(input));
    return r;
  }
  function compareCase(name, bound, make) {
    // original and variant each get their own make() result; each input is checked only against its own pre-call baseline.
    const o = run(V.original, make, bound),
      v = run(V.variant, make, bound),
      problems = [];
    if (o.ok !== v.ok)
      problems.push(
        'outcome differs: original ' +
          (o.ok ? 'ok' : o.err.reason + '/' + o.err.ctor) +
          ' variant ' +
          (v.ok ? 'ok' : v.err.reason + '/' + v.err.ctor),
      );
    else if (o.ok) problems.push(...deepDiff(o.value, v.value));
    else if (JSON.stringify(o.err) !== JSON.stringify(v.err))
      problems.push(
        'first error differs: ' + JSON.stringify(o.err) + ' vs ' + JSON.stringify(v.err),
      );
    for (const d of o.mutation) problems.push('input mutated by original: ' + d);
    for (const d of v.mutation) problems.push('input mutated by variant: ' + d);
    return {
      name,
      ok: problems.length === 0,
      outcome: o.ok ? 'ok' : (o.err.reason ?? o.err.name),
      problems,
    };
  }

  // ---------------------------------------------------------------- deterministic generators
  function rng(s) {
    let a = s >>> 0;
    return () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const SPECIAL_KEYS = [
    '__proto__',
    'constructor',
    'prototype',
    'hasOwnProperty',
    'toString',
    'valueOf',
    '__defineGetter__',
    '__lookupSetter__',
    'length',
    'then',
    '0',
    '1',
    '2',
    '10',
    '4294967294',
    '4294967295',
    '4294967296',
    '-1',
    '01',
    '',
    '\u0000',
    'a\u0000b',
    'é',
    'é',
    '日本',
    '😀',
    '\ud800',
    '\udc00',
    'a b',
    '"q"',
    'b\\s',
    ' ',
  ];
  const STRINGS = [
    '',
    'a',
    'hello world',
    '\u0000',
    'x\u0000y',
    'é',
    '日本語',
    '😀',
    '\ud800',
    'a\udc00b',
    '"quoted"',
    'back\\slash',
    '\u0001\u001f',
    '  ',
    'line\nbreak\ttab',
  ];
  const setOwn = (o, k, v) => {
    Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
    return o;
  };
  function genValue(r, depth, invalidRate) {
    if (invalidRate && r() < invalidRate) {
      const bad = [
        undefined,
        NaN,
        Infinity,
        1n,
        () => 1,
        Symbol('s'),
        new Date(0),
        new Map(),
        (() => {
          const o = {};
          Object.defineProperty(o, 'g', {
            get() {
              return 1;
            },
            enumerable: true,
          });
          return o;
        })(),
        new Proxy({}, {}),
        (() => {
          const o = {};
          o.self = o;
          return o;
        })(),
        setOwn({}, 'toJSON', 1),
        new (class K {})(),
      ];
      return bad[Math.floor(r() * bad.length)];
    }
    const t = r();
    if (depth > 5 || t < 0.35) {
      const u = r();
      if (u < 0.3) return STRINGS[Math.floor(r() * STRINGS.length)];
      if (u < 0.5) return Math.floor(r() * 2e9) - 1e9;
      if (u < 0.6) return [0.5, -0.0, 1e21, 1.7976931348623157e308, 5e-324][Math.floor(r() * 5)];
      if (u < 0.7) return r() < 0.5;
      if (u < 0.8) return null;
      return 'k' + Math.floor(r() * 1e6);
    }
    if (t < 0.55)
      return Array.from({ length: Math.floor(r() * 5) }, () => genValue(r, depth + 1, invalidRate));
    const o = {},
      n = Math.floor(r() * 6);
    for (let i = 0; i < n; i++) {
      const k =
        r() < 0.4
          ? SPECIAL_KEYS[Math.floor(r() * SPECIAL_KEYS.length)]
          : 'k' + Math.floor(r() * 50);
      setOwn(o, k, genValue(r, depth + 1, invalidRate));
    }
    return o;
  }
  function nestedObjects(d) {
    let v = null;
    for (let i = 0; i < d; i++) v = { a: v };
    return v;
  }
  function nestedArrays(d) {
    let v = null;
    for (let i = 0; i < d; i++) v = [v];
    return v;
  }
  const J = (s) => () => JSON.parse(s);
  const deepFreeze = (v) => {
    if (v && typeof v === 'object' && !Object.isFrozen(v)) {
      for (const c of Object.values(v)) deepFreeze(c);
      Object.freeze(v);
    }
    return v;
  };
  const graphOf = (extra) => () => ({
    version: '2.0',
    exported_at: '2026-01-01T00:00:00.000Z',
    entities: [{ uuid: 'e', attributes: extra() }],
    edges: [],
    episodes: [],
  });

  // ---------------------------------------------------------------- fixed corpus (valid + invalid + boundaries)
  // Every case, including proxies, accessors, symbols, cycles and class instances, now gets the identity-snapshot mutation check.
  function corpus() {
    const C = [];
    const add = (name, bound, make) => C.push({ name, bound, make });
    const B = 'beginRequest';
    add('plain nested', B, J('{"a":{"b":[1,2,{"c":"d"}],"e":null,"f":true}}'));
    add('own __proto__ (object value)', B, J('{"__proto__":{"x":1},"y":2}'));
    add('own __proto__ (primitive value)', B, J('{"__proto__":7}'));
    add('nested own __proto__ in array', B, J('[{"__proto__":{"__proto__":{"z":1}}}]'));
    add(
      'constructor/prototype keys',
      B,
      J('{"constructor":{"prototype":{"y":2}},"prototype":{"constructor":1}}'),
    );
    add(
      'Object.prototype method names',
      B,
      J(
        '{"hasOwnProperty":1,"toString":"x","valueOf":null,"__defineGetter__":2,"__lookupSetter__":3,"isPrototypeOf":4}',
      ),
    );
    add(
      'integer-like keys ordering',
      B,
      J(
        '{"b":1,"2":2,"a":3,"1":4,"10":5,"4294967295":6,"4294967294":7,"4294967296":8,"-1":9,"01":10}',
      ),
    );
    add(
      'empty/NUL/unicode keys',
      B,
      J(
        '{"":1,"\\u0000":2,"a\\u0000b":3,"é":4,"e\\u0301":5,"日本":6,"😀":7,"\\ud800":8,"\\udc00":9}',
      ),
    );
    add(
      'NUL/unicode/lone-surrogate values',
      B,
      J('["\\u0000","x\\u0000y","\\ud800","a\\udc00b","😀","\\u2028\\u2029"]'),
    );
    add('-0 and extreme numbers', B, J('[-0,0,1e21,5e-324,1.7976931348623157e308,-1]'));
    add('length/then keys', B, J('{"length":3,"then":{"x":1}}'));
    add('shared (DAG) reference, not a cycle', B, () => {
      const s = { x: 1 };
      return { a: s, b: s };
    });
    add('null-prototype input', B, () => {
      const o = Object.create(null);
      o.a = { b: 1 };
      return o;
    });
    add('foreign-realm input', B, () => vm.runInNewContext('({a:{b:[1,2]},c:"d"})'));
    add('deep-frozen input', B, () => deepFreeze({ a: { b: [1, { c: 2 }] }, d: 'e' }));
    add('frozen with __proto__ key', B, () => deepFreeze(JSON.parse('{"__proto__":{"x":[1]}}')));
    add('sealed and non-extensible inputs', B, () => {
      const o = { a: { b: 1 }, c: [1] };
      Object.seal(o.a);
      Object.preventExtensions(o.c);
      return Object.preventExtensions(o);
    });
    add(
      'graph bound ok',
      'graph',
      graphOf(() => ({ n: { __proto__: null, k: 1 }, list: [{ a: 1 }] })),
    );
    add('graph bound missing arrays', 'graph', () => ({ version: '2.0' }));
    add('graph bound non-plain array', 'graph', () => ({
      entities: [],
      edges: [],
      episodes: Object.assign([], { x: 1 }),
    }));
    // error classes and first-error order
    add('undefined value', B, () => ({ a: undefined }));
    add('NaN', B, () => [NaN]);
    add('Infinity', B, () => [Infinity]);
    add('-Infinity', B, () => [-Infinity]);
    add('bigint', B, () => ({ a: 1n }));
    add('function', B, () => ({ a: () => 1 }));
    add('symbol value', B, () => ({ a: Symbol('s') }));
    add('Date', B, () => ({ a: new Date(0) }));
    add('Map', B, () => ({ a: new Map([[1, 2]]) }));
    add(
      'class instance',
      B,
      () =>
        new (class K {
          a = 1;
        })(),
    );
    add('class instance nested', B, () => ({ a: { b: new (class K2 {})() } }));
    add('accessor property', B, () => {
      const o = {};
      Object.defineProperty(o, 'g', {
        get() {
          return 1;
        },
        enumerable: true,
      });
      return o;
    });
    add('setter-only property', B, () => {
      const o = {};
      Object.defineProperty(o, 's', { set() {}, enumerable: true });
      return o;
    });
    add('non-enumerable property', B, () => {
      const o = { a: 1 };
      Object.defineProperty(o, 'h', { value: 2, enumerable: false });
      return o;
    });
    add('symbol key', B, () => ({ a: 1, [Symbol('k')]: 2 }));
    add('toJSON key', B, () => setOwn({}, 'toJSON', 1));
    add('proxy object', B, () => new Proxy({ a: 1 }, {}));
    add('proxy array', B, () => new Proxy([1], {}));
    add('nested proxy', B, () => ({ a: { b: new Proxy({}, {}) } }));
    add('cycle', B, () => {
      const o = { a: {} };
      o.a.back = o;
      return o;
    });
    add('sparse array', B, () => [1, , 3]);
    add('array with extra key', B, () => Object.assign([1], { x: 1 }));
    add('array element getter', B, () => {
      const a = [1];
      Object.defineProperty(a, '0', {
        get() {
          return 1;
        },
        enumerable: true,
      });
      return a;
    });
    add('first error: earlier key wins (undefined before NaN)', B, () => ({
      a: { b: undefined },
      c: NaN,
    }));
    add('first error: earlier key wins (NaN before undefined)', B, () => ({
      a: { b: NaN },
      c: undefined,
    }));
    add('child error after cloned siblings', B, () => ({
      ok1: { deep: [1, 2, 3] },
      ok2: 'x',
      bad: { z: undefined },
      never: 1,
    }));
    add('toJSON after valid keys', B, () => {
      const o = { a: 1, b: { c: 2 } };
      setOwn(o, 'toJSON', 1);
      return o;
    });
    // boundaries (module bounds: beginRequest 512 KiB/16384 nodes/depth 32; policyData 16 KiB/1024 nodes/depth 16)
    // {"a":"x"*L}: 2 + 3 + 1 + (L+2) = L+8 bytes, so L=524280 is exactly at maxBytes.
    for (const L of [524288 - 9, 524288 - 8, 524288 - 7])
      add('beginRequest bytes L=' + L, B, () => ({ a: 'x'.repeat(L) }));
    for (const d of [30, 31, 32, 33, 34])
      add('beginRequest object depth ' + d, B, () => nestedObjects(d));
    for (const d of [15, 16, 17, 18])
      add('policyData array depth ' + d, 'policyData', () => nestedArrays(d));
    for (const k of [509, 510, 511, 512, 513])
      add('policyData nodes (array of ' + k + ' nulls)', 'policyData', () =>
        new Array(k).fill(null),
      );
    for (const L of [2728, 2729, 2730, 2731])
      add('policyData control-char bytes L=' + L, 'policyData', () => ({ a: '\u0001'.repeat(L) }));
    for (const L of [2728, 2729, 2730, 2731])
      add('policyData lone-surrogate bytes L=' + L, 'policyData', () => ({
        a: '\ud800'.repeat(L),
      }));
    // {"k"*n:null}: 2 + (n+2) + 1 + 4 = n+9 bytes, so n=16375 is exactly at maxBytes (16384) and n=16376 is one over.
    for (const n of [16374, 16375, 16376])
      add('policyData single-key bytes n=' + n, 'policyData', () =>
        setOwn({}, 'k'.repeat(n), null),
      );
    return C;
  }

  return { corpus, compareCase, detectorSelfTest, snapshot, snapDiff, rng, genValue };
};
