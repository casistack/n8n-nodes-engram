const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const digest = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sha = () => execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
function packageMetadata(file) {
  return JSON.parse(
    execFileSync('tar', ['-xOf', file, 'package/package.json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 512 * 1024,
    }),
  );
}
function run(mode, directory) {
  const files = fs.readdirSync(directory).filter((file) => file.endsWith('.tgz'));
  assert.equal(files.length, 1, 'Exactly one package artifact required');
  const file = files[0];
  const metadata = packageMetadata(path.join(directory, file));
  assert.equal(metadata.name, 'n8n-nodes-engram');
  const expected = {
    version: 1,
    sourceSha: sha(),
    packageVersion: require('../../package.json').version,
    lockSha256: digest(path.resolve('package-lock.json')),
    file,
    sha256: digest(path.join(directory, file)),
  };
  assert.equal(metadata.version, expected.packageVersion);
  if (process.env.GITHUB_SHA) assert.equal(expected.sourceSha, process.env.GITHUB_SHA);
  if (process.env.RELEASE_TAG) assert.equal(process.env.RELEASE_TAG, `v${metadata.version}`);
  const manifestPath = path.join(directory, 'package-manifest.json');
  if (mode === 'create') fs.writeFileSync(manifestPath, JSON.stringify(expected, null, 2) + '\n');
  else if (mode === 'verify') assert.deepEqual(JSON.parse(fs.readFileSync(manifestPath)), expected);
  else throw new Error('Expected create or verify');
}
module.exports = { run };
if (require.main === module) run(process.argv[2], process.argv[3] ?? '.');
