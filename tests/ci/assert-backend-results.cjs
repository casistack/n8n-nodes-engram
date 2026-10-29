const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
function verify(result) {
  assert.equal(result.success, true, 'Backend run must succeed');
  assert.equal(result.numFailedTests, 0);
  for (const suite of result.testResults) {
    for (const test of suite.assertionResults) {
      if (test.status === 'passed') continue;
      assert.ok(
        path.basename(suite.name) === 'json-mode-live.test.ts' &&
          test.status === 'pending' &&
          test.fullName ===
            'optional official-provider JSON comparison contract accepts the shipped trusted instruction with provider-default temperature',
        `Unexpected unexecuted or failed case: ${test.fullName}`,
      );
    }
  }
  const required = fs
    .readdirSync(path.join(__dirname, '../integration'))
    .filter((file) => file.endsWith('.neo4j.test.ts'));
  assert.ok(required.length > 0);
  for (const file of required) {
    const suite = result.testResults.find((item) => path.basename(item.name) === file);
    assert.ok(suite, `Missing backend suite: ${file}`);
    assert.ok(suite.assertionResults.length > 0, `Empty backend suite: ${file}`);
    assert.ok(
      suite.assertionResults.every((test) => test.status === 'passed'),
      `Skipped or failed backend case: ${file}`,
    );
  }
  for (const file of [
    'automatic-claim-read.test.ts',
    'automatic-ledger-mixed-preservation.test.ts',
    'automatic-ledger-preservation.test.ts',
    'automatic-ledger-v4-preservation.test.ts',
    'automatic-memory-backends.test.ts',
    'durable-memory.test.ts',
    'extraction-queue.test.ts',
    'extraction-queue-crash.test.ts',
    'storage-backends.test.ts',
  ]) {
    const suite = result.testResults.find((item) => path.basename(item.name) === file);
    assert.ok(
      suite?.assertionResults.some((test) => /neo4j/i.test(test.fullName)),
      `Missing mixed backend cases: ${file}`,
    );
    assert.ok(
      suite.assertionResults.every((test) => test.status === 'passed'),
      `Skipped or failed mixed backend case: ${file}`,
    );
  }
}
module.exports = { verify };
if (require.main === module) verify(JSON.parse(fs.readFileSync(process.argv[2], 'utf8')));
