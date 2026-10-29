import * as fs from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
const { verify } = require('../../ci/assert-backend-results.cjs');
const { run } = require('../../ci/package-manifest.cjs');

function backendResult() {
  const directory = path.join(__dirname, '../../integration');
  const files = fs.readdirSync(directory).filter((name) => name.endsWith('.neo4j.test.ts'));
  return {
    success: true,
    numFailedTests: 0,
    testResults: [
      ...files,
      'automatic-claim-read.test.ts',
      'automatic-ledger-mixed-preservation.test.ts',
      'automatic-ledger-preservation.test.ts',
      'automatic-ledger-v4-preservation.test.ts',
      'automatic-memory-backends.test.ts',
      'durable-memory.test.ts',
      'extraction-queue.test.ts',
      'extraction-queue-crash.test.ts',
      'storage-backends.test.ts',
    ].map((name) => ({
      name: path.join(directory, name),
      assertionResults: [{ status: 'passed', fullName: 'Neo4j contract' }],
    })),
  };
}
describe('mandatory regression evidence guards', () => {
  test('requires every backend suite, including mixed-backend coverage', () => {
    const result = backendResult();
    expect(() => verify(result)).not.toThrow();
    result.testResults.pop();
    expect(() => verify(result)).toThrow('Missing mixed backend');
  });
  test('rejects skipped mandatory backend cases and missing suites', () => {
    const result = backendResult();
    result.testResults[0].assertionResults[0].status = 'pending';
    expect(() => verify(result)).toThrow('Unexpected unexecuted');
    result.testResults.shift();
    expect(() => verify(result)).toThrow('Missing backend suite');
  });
  test('requires executed V4 preservation contracts on the actual backend', () => {
    const result = backendResult();
    const index = result.testResults.findIndex(
      (suite) => path.basename(suite.name) === 'automatic-ledger-v4-preservation.test.ts',
    );
    result.testResults[index].assertionResults[0].status = 'pending';
    expect(() => verify(result)).toThrow('Unexpected unexecuted');
    result.testResults.splice(index, 1);
    expect(() => verify(result)).toThrow(
      'Missing mixed backend cases: automatic-ledger-v4-preservation.test.ts',
    );
  });
  test('allows only the specifically named optional credentialed provider case', () => {
    const result = backendResult();
    result.testResults.push({
      name: 'json-mode-live.test.ts',
      assertionResults: [
        {
          status: 'pending',
          fullName:
            'optional official-provider JSON comparison contract accepts the shipped trusted instruction with provider-default temperature',
        },
      ],
    });
    expect(() => verify(result)).not.toThrow();
    result.testResults[result.testResults.length - 1].assertionResults[0].fullName =
      'new unexecuted contract';
    expect(() => verify(result)).toThrow('Unexpected unexecuted');
  });
  test('rejects an altered artifact, source manifest or lock digest', () => {
    const directory = fs.mkdtempSync(path.join(tmpdir(), 'engram-artifact-guard-'));
    try {
      fs.mkdirSync(path.join(directory, 'package'));
      fs.writeFileSync(
        path.join(directory, 'package/package.json'),
        JSON.stringify({
          name: 'n8n-nodes-engram',
          version: require('../../../package.json').version,
        }),
      );
      execFileSync('tar', [
        '-czf',
        path.join(directory, 'artifact.tgz'),
        '-C',
        directory,
        'package',
      ]);
      run('create', directory);
      expect(() => run('verify', directory)).not.toThrow();
      const manifestPath = path.join(directory, 'package-manifest.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      for (const field of ['sourceSha', 'lockSha256', 'sha256']) {
        fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, [field]: '0'.repeat(64) }));
        expect(() => run('verify', directory)).toThrow();
      }
      fs.writeFileSync(manifestPath, JSON.stringify(manifest));
      fs.appendFileSync(path.join(directory, 'artifact.tgz'), 'tampered');
      expect(() => run('verify', directory)).toThrow();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
