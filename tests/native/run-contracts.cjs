const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const directory = path.resolve(process.argv[2]);
const files = fs.readdirSync(directory).filter((file) => file.endsWith('.tgz'));
assert.equal(files.length, 1, 'One tested package required');
assert.ok(process.env.ENGRAM_N8N_RUNTIME, 'Explicit n8n runtime required');
assert.equal(
  require(path.join(process.env.ENGRAM_N8N_RUNTIME, 'node_modules/n8n/package.json')).version,
  '2.12.3',
);
for (const [test, ...args] of [
  ['normal'],
  ['normal', 'autonomous'],
  ['tool'],
  ['tool', 'autonomous'],
  ['batch'],
  ['parent', 'missing'],
  ['parent', 'revoked'],
]) {
  execFileSync(process.execPath, [path.join(__dirname, `${test}.cjs`), ...args], {
    env: { ...process.env, ENGRAM_TEST_PACKAGE: path.join(directory, files[0]) },
    stdio: 'inherit',
    timeout: 8 * 60 * 1000,
  });
}
