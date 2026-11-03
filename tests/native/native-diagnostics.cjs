const assert = require('node:assert/strict');
const path = require('node:path');

module.exports = function verifyNativeDiagnostics({ runData, enabled, root, content }) {
  const { NativeMemoryObservabilityV1Schema } = require(
    path.join(root, 'dist/schemas/NativeMemoryObservabilityV1.schema'),
  );
  const capture = runData.Capture[0].data.main
    .flat()
    .find((item) => item.json.status === 'captured').json;
  const memory = (runData.Memory ?? [])
    .flatMap((run) => (run.data?.ai_memory ?? []).flat())
    .map((item) => item.json);
  const relevant = memory.filter((item) =>
    ['loadMemoryVariables', 'addMessages', 'saveContext'].includes(item.action),
  );
  if (!enabled) {
    assert.equal(Object.hasOwn(capture, 'native_diagnostics_v1'), false);
    assert(relevant.every((item) => !Object.hasOwn(item, 'native_diagnostics_v1')));
    return;
  }
  const captureSidecar = NativeMemoryObservabilityV1Schema.parse(capture.native_diagnostics_v1);
  assert.equal(captureSidecar.purpose, 'capture');
  assert.equal(captureSidecar.native_requests.attempted, 1);
  assert.equal(captureSidecar.native_requests.completed, 1);
  assert.equal(captureSidecar.native_requests.usage_missing, 1);
  assert.equal(captureSidecar.native_requests.input_tokens, null);
  assert.equal(captureSidecar.observer_errors, 0);
  assert(relevant.some((item) => item.action === 'loadMemoryVariables'));
  assert(relevant.some((item) => ['addMessages', 'saveContext'].includes(item.action)));
  for (const item of relevant) {
    const diagnostic = NativeMemoryObservabilityV1Schema.parse(item.native_diagnostics_v1);
    assert.equal(diagnostic.purpose, item.action === 'loadMemoryVariables' ? 'load' : 'save');
    assert.equal(diagnostic.native_requests, null);
    assert.equal(JSON.stringify(diagnostic).includes(content), false);
  }
};
