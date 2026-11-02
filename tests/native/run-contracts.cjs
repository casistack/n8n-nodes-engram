const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const { DEFAULT_N8N_VERSION, getNativeRuntimeIdentity } = require('./runtime.cjs');
const directory = path.resolve(process.argv[2]);
const files = fs.readdirSync(directory).filter((file) => file.endsWith('.tgz'));
assert.equal(files.length, 1, 'One tested package required');
const expectedVersion = Object.hasOwn(process.env, 'ENGRAM_EXPECTED_N8N_VERSION')
  ? process.env.ENGRAM_EXPECTED_N8N_VERSION
  : DEFAULT_N8N_VERSION;
const childEnv = {
  ...process.env,
  ENGRAM_EXPECTED_N8N_VERSION: expectedVersion,
  ENGRAM_TEST_PACKAGE: path.join(directory, files[0]),
};
const identity = getNativeRuntimeIdentity({ env: childEnv });
console.log(JSON.stringify({ stage: 'native-runtime', ...identity }));
for (const [test, ...args] of [
  ['normal'],
  ['normal', 'autonomous'],
  ['normal', 'autonomous', 'configured'],
  ['normal', 'autonomous', 'configured', 'contextual'],
  ['tool'],
  ['tool', 'autonomous'],
  ['tool', 'autonomous', 'configured'],
  ['batch'],
  ['parent', 'missing'],
  ['parent', 'revoked'],
]) {
  execFileSync(process.execPath, [path.join(__dirname, `${test}.cjs`), ...args], {
    env: childEnv,
    stdio: 'inherit',
    timeout: 8 * 60 * 1000,
  });
}
