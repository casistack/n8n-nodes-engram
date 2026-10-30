// Synthetic native n8n contract against the installed package artifact.
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');
const assert = require('assert/strict');
const { randomUUID, createHash } = require('crypto');
const { getNativeRuntimeIdentity } = require('./runtime.cjs');
const work = fs.mkdtempSync(path.join(require('os').tmpdir(), 'engram-native-contract-'));
const runtime = process.env.ENGRAM_N8N_RUNTIME;
assert.ok(runtime, 'Explicit n8n runtime required');
assert.ok(process.env.ENGRAM_TEST_PACKAGE, 'Explicit tested package required');
const nodes = path.join(work, 'user/.n8n/nodes');
fs.mkdirSync(nodes, { recursive: true });
execFileSync(
  'npm',
  ['install', '--no-audit', '--no-fund', '--prefix', nodes, process.env.ENGRAM_TEST_PACKAGE],
  { stdio: 'inherit' },
);
const root = path.join(nodes, 'node_modules/n8n-nodes-engram');
const cli = path.join(runtime, 'node_modules/n8n/bin/n8n');
const workflowId = 'engram017MemoryBatch';
const group = 'synthetic-native-memory-batch';
const content = 'I prefer concise explanations.';
const identities = [
  { actor: 'synthetic-memory-actor-a', turn: 'synthetic-memory-event-a' },
  { actor: 'synthetic-memory-actor-b', turn: 'synthetic-memory-event-b' },
];
const runtimeIdentity = getNativeRuntimeIdentity();
fs.mkdirSync(work, { recursive: true });
const storeDir = fs.mkdtempSync(path.join(work, 'store-'));
const storeFile = path.join(storeDir, `${workflowId}-engram.json`);
const env = {
  ...process.env,
  N8N_USER_FOLDER: path.join(work, 'user'),
  DB_TYPE: 'sqlite',
  DB_SQLITE_DATABASE: path.join(work, 'user/.n8n/database.sqlite'),
  N8N_ENCRYPTION_KEY: 'synthetic-local-memory-batch-encryption-key',
  N8N_CUSTOM_EXTENSIONS: '',
  N8N_DIAGNOSTICS_ENABLED: 'false',
  N8N_PERSONALIZATION_ENABLED: 'false',
  N8N_VERSION_NOTIFICATIONS_ENABLED: 'false',
  N8N_TEMPLATES_ENABLED: 'false',
  N8N_RUNNERS_ENABLED: 'false',
  N8N_LOG_LEVEL: 'warn',
  NODE_PATH: path.join(runtime, 'node_modules'),
};
const packageFile = path.join(
  env.N8N_USER_FOLDER,
  '.n8n/nodes/node_modules/n8n-nodes-engram/package.json',
);
assert.ok(
  fs.existsSync(packageFile),
  'Install the scoped artifact in this isolated user folder before running',
);
assert.equal(require(packageFile).version, require(path.join(root, 'package.json')).version);
const installedMemoryNode = path.join(
  path.dirname(packageFile),
  'dist/nodes/EngramMemory/EngramMemory.node.js',
);
const nodeHash = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const nativeMemoryNodeSha256 = nodeHash(installedMemoryNode);
assert.equal(
  nativeMemoryNodeSha256,
  nodeHash(path.join(root, 'dist/nodes/EngramMemory/EngramMemory.node.js')),
  'Install the same scoped build used to seed this proof',
);
const counts = { model: 0, extraction: 0, outbound: 0, stopped: 0 };
let n8nProcess;
let n8nLog;
let server;

function node(name, type, typeVersion, parameters, position, extra = {}) {
  return { id: randomUUID(), name, type, typeVersion, parameters, position, ...extra };
}
function connect(target, type = 'main') {
  return { node: target, type, index: 0 };
}
async function command(label, args) {
  const logFile = path.join(work, `${label}.log`);
  const log = fs.createWriteStream(logFile);
  const child = spawn(process.execPath, [cli, ...args], {
    cwd: work,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  const timer = setTimeout(() => child.kill('SIGTERM'), 90_000);
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', resolve);
  });
  clearTimeout(timer);
  await new Promise((resolve) => log.end(resolve));
  console.log(JSON.stringify({ stage: label, code, logFile }));
  assert.equal(code, 0, `Local ${label} failed; inspect its log`);
}
async function freePort() {
  const socket = http.createServer();
  await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}
function decode(execution) {
  return typeof execution.data.data === 'string'
    ? require(path.join(runtime, 'node_modules/flatted')).parse(execution.data.data)
    : execution.data.data;
}

(async () => {
  server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 1_048_576) {
        req.destroy();
        return;
      }
    }
    if (req.url === '/outbound') counts.outbound++;
    else if (req.url === '/stopped') counts.stopped++;
    else if (req.url.startsWith('/extraction')) counts.extraction++;
    else if (req.url === '/agent/v1/chat/completions') counts.model++;
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: {
          message: 'This local recorder must never be called',
          type: 'synthetic_negative_gate',
        },
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const local = `http://127.0.0.1:${server.address().port}`;
  const { GraphologyStorage } = require(path.join(root, 'dist/storage/GraphologyStorage'));
  const storage = new GraphologyStorage(storeFile);
  await storage.initialize();
  const subjects = [];
  const now = new Date().toISOString();
  for (const identity of identities) {
    const subject = await storage.addEntity({
      group_id: group,
      name: `Synthetic reviewed ${identity.actor}`,
      entity_type: 'person',
      summary: '',
      attributes: {
        engram_extraction: {
          version: 2,
          source: 'manual',
          confidence: null,
          review_status: 'accepted',
          threshold_decision: 'manually_reviewed',
          extracted_at: now,
          episode_uuids: [],
          reviewed_at: now,
          reviewed_by: 'synthetic-operator',
        },
      },
    });
    await storage.automaticBindingCommand({
      action: 'create',
      namespace: group,
      issuer: 'synthetic-app',
      actorReference: identity.actor,
      subjectId: subject.uuid,
      authorizedBy: 'synthetic-operator',
      reason: 'Synthetic independent actor batch proof',
    });
    subjects.push(subject.uuid);
  }
  await storage.close();

  // Dummy local-only model credential: never a production/provider credential.
  // Capture and Memory have no extraction credentials; their static early guard
  // must run before expression resolution, providers or final saving.
  const agentCredential = {
    id: 'syntheticMemoryBatchAgent017',
    name: 'Synthetic batch recorder',
    type: 'openAiApi',
    data: { apiKey: 'synthetic-only', url: `${local}/agent/v1` },
  };
  const credentialFile = path.join(work, 'credentials.json');
  fs.writeFileSync(credentialFile, JSON.stringify([agentCredential]), { mode: 0o600 });
  const automatic = {
    automaticCaptureLifecycle: 'replaySafeV2',
    automaticMemoryProfile: 'conservative',
    automaticIssuer: 'synthetic-app',
    automaticIntent: 'disabled',
    automaticWrapper: 'disabled',
  };
  const workflow = {
    id: workflowId,
    name: 'Synthetic Memory multi-actor batch denial',
    active: false,
    settings: { executionOrder: 'v1' },
    nodes: [
      node('Start', 'n8n-nodes-base.manualTrigger', 1, {}, [0, 0]),
      node(
        'Batch',
        'n8n-nodes-base.code',
        2,
        {
          jsCode: `return ${JSON.stringify(identities.map((identity, inputIndex) => ({ json: { ...identity, input: content, inputIndex } })))};`,
        },
        [160, 0],
      ),
      node(
        'Capture',
        'n8n-nodes-engram.engramAdmin',
        3,
        {
          ...automatic,
          backend: 'embedded',
          resource: 'automaticMemory',
          operation: 'captureHuman',
          customStoragePath: storeDir,
          automaticWorkflowId: workflowId,
          automaticNamespace: group,
          automaticActor: '={{ $json.actor }}',
          automaticTurn: '={{ $json.turn }}',
          automaticInput: '={{ $json.input }}',
          automaticExecution: 'synchronous',
          advancedExtractionPolicy: 'bounded',
          knowledgeSelection: 'durableTemporal',
        },
        [340, 0],
      ),
      node(
        'Agent',
        '@n8n/n8n-nodes-langchain.agent',
        3.1,
        { promptType: 'define', text: content, options: {} },
        [560, 0],
      ),
      node(
        'Model',
        '@n8n/n8n-nodes-langchain.lmChatOpenAi',
        1.3,
        {
          model: { __rl: true, mode: 'id', value: 'synthetic-batch-recorder' },
          responsesApiEnabled: false,
          options: { temperature: 0, maxRetries: 0 },
        },
        [460, 240],
        { credentials: { openAiApi: { id: agentCredential.id, name: agentCredential.name } } },
      ),
      node(
        'Memory',
        'n8n-nodes-engram.engramMemory',
        3,
        {
          ...automatic,
          backend: 'embedded',
          customStoragePath: storeDir,
          sessionIdType: 'customKey',
          sessionKey: group,
          automaticActor: '={{ $("Batch").item.json.actor }}',
          automaticTurn: '={{ $("Batch").item.json.turn }}',
          automaticCapturedSource: '={{ $("Capture").item.json.sourceId }}',
          currentHumanQuery: content,
          retentionType: 'forever',
          enableExtraction: 'enabled',
          extractionModel: '',
          advancedExtractionPolicy: 'bounded',
          knowledgeSelection: 'durableTemporal',
          extractionExecution: 'synchronous',
          enableEmbeddings: 'disabled',
          extractAi: 'disabled',
          extractSystemTool: 'disabled',
          historyFilter: 'provenance',
          messageWritePolicy: 'finalTurns',
          storeToolAudit: 'enabled',
          contextWindowLength: 10,
        },
        [660, 240],
      ),
      node(
        'Recording outbound',
        'n8n-nodes-base.httpRequest',
        4.2,
        { method: 'POST', url: `${local}/outbound`, options: {} },
        [800, 0],
      ),
      node(
        'Recording stopped',
        'n8n-nodes-base.httpRequest',
        4.2,
        { method: 'POST', url: `${local}/stopped`, options: {} },
        [560, -180],
      ),
    ],
    connections: {
      Start: { main: [[connect('Batch')]] },
      Batch: { main: [[connect('Capture')]] },
      Capture: { main: [[connect('Agent')], [connect('Recording stopped')]] },
      Model: { ai_languageModel: [[connect('Agent', 'ai_languageModel')]] },
      Memory: { ai_memory: [[connect('Agent', 'ai_memory')]] },
      Agent: { main: [[connect('Recording outbound')]] },
    },
  };
  const workflowFile = path.join(work, 'workflow.json');
  fs.writeFileSync(workflowFile, JSON.stringify([workflow]));
  await command('import-credentials', ['import:credentials', `--input=${credentialFile}`]);
  await command('import-workflow', ['import:workflow', `--input=${workflowFile}`]);
  const port = await freePort();
  const brokerPort = await freePort();
  const app = `http://127.0.0.1:${port}`;
  n8nLog = fs.createWriteStream(path.join(work, 'server.log'));
  n8nProcess = spawn(process.execPath, [cli, 'start'], {
    cwd: work,
    env: {
      ...env,
      N8N_PORT: String(port),
      N8N_HOST: '127.0.0.1',
      N8N_LISTEN_ADDRESS: '127.0.0.1',
      N8N_RUNNERS_BROKER_PORT: String(brokerPort),
      N8N_SECURE_COOKIE: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  n8nProcess.stdout.pipe(n8nLog, { end: false });
  n8nProcess.stderr.pipe(n8nLog, { end: false });
  let ready = false;
  for (let i = 0; i < 120; i++) {
    try {
      ready =
        (await fetch(`${app}/healthz/readiness`)).ok && (await fetch(`${app}/rest/settings`)).ok;
    } catch {}
    if (ready) break;
    if (n8nProcess.exitCode !== null) throw new Error('Isolated n8n exited; inspect server.log');
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.equal(ready, true);
  const owner = {
    email: 'synthetic-memory-batch@example.invalid',
    firstName: 'Synthetic',
    lastName: 'Batch',
    password: 'SyntheticMemory017!LocalOnly',
  };
  let auth = await fetch(`${app}/rest/owner/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(owner),
  });
  if (!auth.ok)
    auth = await fetch(`${app}/rest/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emailOrLdapLoginId: owner.email, password: owner.password }),
    });
  assert.equal(auth.ok, true, 'Synthetic local owner authentication failed');
  const cookie = auth.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  assert.ok(cookie);
  const launched = await fetch(`${app}/rest/workflows/${workflowId}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ triggerToStartFrom: { name: 'Start' } }),
  });
  const launch = await launched.json();
  fs.writeFileSync(path.join(work, 'batch-launch.json'), JSON.stringify(launch, null, 2));
  assert.equal(launched.ok, true);
  const executionId = launch.data.executionId;
  assert.ok(executionId);
  let execution;
  for (let i = 0; i < 240; i++) {
    const response = await fetch(`${app}/rest/executions/${executionId}`, {
      headers: { Cookie: cookie },
    });
    const result = await response.json();
    if (['success', 'error', 'canceled', 'crashed'].includes(result.data?.status)) {
      execution = result;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.ok(execution, 'Timed out waiting for batch');
  fs.writeFileSync(path.join(work, 'batch-result.json'), JSON.stringify(execution, null, 2));
  assert.equal(execution.data.status, 'error', 'Multi-actor Memory batch must fail closed');
  const decoded = decode(execution);
  assert.match(
    JSON.stringify(decoded),
    /single_event_required/u,
    'Failure must be Memory parent-cardinality guard, not credential/model failure',
  );
  const capture = decoded.resultData.runData.Capture[0].data.main;
  assert.equal(capture[0].length, 2);
  assert.equal(capture[1].length, 0);
  assert.deepEqual(
    capture[0].map((item) => item.pairedItem),
    [{ item: 0 }, { item: 1 }],
  );
  assert.ok(capture[0].every((item) => item.json.should_process === true));
  const graphBytes = fs.readFileSync(storeFile);
  const graph = JSON.parse(graphBytes);
  const humans = graph.episodes.filter((episode) => episode.role === 'human');
  assert.equal(humans.length, 2);
  assert.equal(new Set(humans.map((episode) => episode.uuid)).size, 2);
  assert.ok(humans.every((episode) => episode.content === content));
  assert.deepEqual(
    humans.map((episode) => episode.attributes.engram_write_owner_v2.actorReference).sort(),
    identities.map((identity) => identity.actor).sort(),
  );
  assert.deepEqual(
    humans.map((episode) => episode.attributes.engram_write_owner_v2.turn).sort(),
    identities.map((identity) => identity.turn).sort(),
  );
  assert.deepEqual(
    capture[0].map((item) => item.json.sourceId).sort(),
    humans.map((episode) => episode.uuid).sort(),
  );
  assert.deepEqual(
    graph.edges.map((edge) => edge.source_node_uuid).sort(),
    subjects.slice().sort(),
  );
  assert.ok(
    graph.edges.every((edge) => edge.attributes.engram_extraction.review_status === 'accepted'),
  );
  assert.equal(graph.episodes.filter((episode) => episode.role === 'ai').length, 0);
  assert.equal(
    graph.episodes.filter((episode) => episode.attributes.engram_audit === true).length,
    0,
  );
  assert.equal(
    graph.automatic_operations_v1.operations.filter(
      (op) => op.identity.purpose === 'assistant_final_save',
    ).length,
    0,
  );
  assert.deepEqual(counts, { model: 0, extraction: 0, outbound: 0, stopped: 0 });
  const proof = {
    ...runtimeIdentity,
    nativeMemoryNodeSha256,
    scope: 'actual native Memory multi-parent fail-closed gate',
    actorCount: 2,
    identicalHumanText: true,
    captureProceedItems: 2,
    capturePairedItems: capture[0].map((item) => item.pairedItem),
    error: 'single_event_required',
    counts,
    humanSources: humans.map((episode) => ({
      uuid: episode.uuid,
      actor: episode.attributes.engram_write_owner_v2.actorReference,
      turn: episode.attributes.engram_write_owner_v2.turn,
    })),
    assistantSources: 0,
    auditSources: 0,
    storeSha256: createHash('sha256').update(graphBytes).digest('hex'),
  };
  fs.writeFileSync(path.join(work, 'proof.json'), JSON.stringify(proof, null, 2));
  console.log(JSON.stringify(proof));
})()
  .catch((error) => {
    console.error(error.stack);
    process.exitCode = 1;
  })
  .finally(() => {
    server?.close();
    if (n8nProcess && n8nProcess.exitCode === null) n8nProcess.kill('SIGTERM');
    n8nProcess?.once('exit', () => n8nLog?.end());
  });
