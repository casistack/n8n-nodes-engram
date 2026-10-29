const assert = require('node:assert/strict');
const path = require('node:path');
const { createRequire } = require('node:module');

function readExecutionData(result, runtime) {
  const data = result?.data?.data;
  if (typeof data === 'string') {
    // Use the pinned host's serializer, not a substring match on its encoded data.
    const hostRequire = createRequire(path.join(runtime, 'node_modules/n8n/package.json'));
    return hostRequire('flatted').parse(data);
  }
  assert.ok(data && typeof data === 'object', 'Execution data must be present');
  return data;
}

module.exports = { readExecutionData };
