// Synthetic native n8n contract against the installed package artifact.
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');
const assert = require('assert/strict');
const { isDeepStrictEqual } = require('util');
const { randomUUID, createHash } = require('crypto');
const { readExecutionData } = require('./execution-data.cjs');
const { getNativeRuntimeIdentity } = require('./runtime.cjs');
const work = fs.mkdtempSync(path.join(require('os').tmpdir(), 'engram-native-contract-'));
const runtime = process.env.ENGRAM_N8N_RUNTIME;
assert.ok(runtime, 'Explicit n8n runtime required');
assert.ok(process.env.ENGRAM_TEST_PACKAGE, 'Explicit tested package required');
const runtimeIdentity = getNativeRuntimeIdentity();
const nodes = path.join(work, 'user/.n8n/nodes');
fs.mkdirSync(nodes, { recursive: true });
execFileSync(
  'npm',
  ['install', '--no-audit', '--no-fund', '--prefix', nodes, process.env.ENGRAM_TEST_PACKAGE],
  { stdio: 'inherit' },
);
const root = path.join(nodes, 'node_modules/n8n-nodes-engram');
const cli = path.join(runtime, 'node_modules/n8n/bin/n8n');
const group = 'synthetic-native-memory';
const workflowId = 'engram017Memory';
const autonomous = process.argv[2] === 'autonomous';
const configuredBudget = process.argv[3] === 'configured';
const contextual = process.argv[4] === 'contextual';
assert.ok(
  !contextual || (autonomous && configuredBudget),
  'Context policy requires configured autonomous case',
);
assert.ok(!configuredBudget || autonomous, 'Configured budgets require autonomous mode');
const content = autonomous
  ? contextual
    ? 'When you explain technical things to me, I prefer plain British English and one practical example before the technical terminology.'
    : 'I prefer explanations in plain British English, with one practical example before any technical terminology.'
  : 'I prefer concise explanations.';
const displayPrefix = '[Synthetic speaker]\n';
const displaySuffix = '\n[End of human message]';
const formattedContent = autonomous ? displayPrefix + content + displaySuffix : content;
fs.mkdirSync(work, { recursive: true });
const storeDir = fs.mkdtempSync(path.join(work, 'store-'));
const storeFile = path.join(storeDir, `${workflowId}-engram.json`);
fs.mkdirSync(storeDir, { recursive: true });
const env = {
  ...process.env,
  N8N_USER_FOLDER: path.join(work, 'user'),
  DB_TYPE: 'sqlite',
  DB_SQLITE_DATABASE: path.join(work, 'user/.n8n/database.sqlite'),
  N8N_CUSTOM_EXTENSIONS: '',
  N8N_ENCRYPTION_KEY: 'synthetic-local-plan017-encryption-key',
  N8N_DIAGNOSTICS_ENABLED: 'false',
  N8N_PERSONALIZATION_ENABLED: 'false',
  N8N_VERSION_NOTIFICATIONS_ENABLED: 'false',
  N8N_TEMPLATES_ENABLED: 'false',
  N8N_RUNNERS_ENABLED: 'false',
  N8N_LOG_LEVEL: 'warn',
  NODE_PATH: path.join(runtime, 'node_modules'),
};
async function command(label, args) {
  const logFile = path.join(work, `${label}.log`);
  const output = fs.createWriteStream(logFile);
  const child = spawn(process.execPath, [cli, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(output, { end: false });
  child.stderr.pipe(output, { end: false });
  const timer = setTimeout(() => child.kill('SIGTERM'), 90_000);
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', resolve);
  });
  clearTimeout(timer);
  await new Promise((resolve) => output.end(resolve));
  console.log(JSON.stringify({ stage: label, code, logFile }));
  return { code, text: fs.readFileSync(logFile, 'utf8') };
}
function node(name, type, typeVersion, parameters, position, extra = {}) {
  return { id: randomUUID(), name, type, typeVersion, parameters, position, ...extra };
}
function connect(target, type = 'main') {
  return { node: target, type, index: 0 };
}
const counts = { model: 0, extraction: 0, outbound: 0, stopped: 0 };
let requestContainsGraph = false;
let acceptedClaimsBeforeAgent = 0;
let lastAgentMessages = [];
let graphOnlyRecall = false;
let fallbackCompatibilityVerified = false;
let n8nProcess;
let n8nLog;
async function freePort() {
  const socket = http.createServer();
  await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}
const server = http.createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  if (req.url === '/stopped') {
    counts.stopped++;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end('{}');
  }
  if (req.url === '/outbound') {
    counts.outbound++;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ recorded: true }));
  }
  if (req.url.startsWith('/extraction')) {
    counts.extraction++;
    if (autonomous) {
      const body = JSON.parse(raw);
      assert.equal(Object.hasOwn(body, 'temperature'), false);
      assert.equal(body.response_format.type, 'json_object');
      assert.match(body.messages.find((message) => message.role === 'system').content, /json/i);
      const input = JSON.parse(body.messages.find((message) => message.role === 'user').content);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  version: 1,
                  units: input.units.map(({ unitId }) => ({
                    unitId,
                    category: 'preference',
                    risk: 'ordinary',
                    usefulness: 'personal_memory',
                    downgrade: [],
                  })),
                }),
              },
            },
          ],
        }),
      );
    }
    res.writeHead(500);
    return res.end('Unexpected synthetic extraction request');
  }
  if (req.url === '/agent/v1/chat/completions') {
    counts.model++;
    const body = JSON.parse(raw);
    lastAgentMessages = body.messages;
    requestContainsGraph ||= body.messages.some(
      (message) =>
        message.role === 'system' &&
        String(message.content).includes('Relevant knowledge from memory:'),
    );
    acceptedClaimsBeforeAgent = JSON.parse(fs.readFileSync(storeFile, 'utf8')).edges.filter(
      (edge) =>
        edge.attributes?.engram_claim_v1 &&
        edge.attributes?.engram_extraction?.review_status === 'accepted',
    ).length;
    const base = { id: 'synthetic-completion', model: 'synthetic-agent', created: 1 };
    if (body.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(
        `data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'Synthetic final response.' }, finish_reason: null }] })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`,
      );
      return res.end('data: [DONE]\n\n');
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(
      JSON.stringify({
        ...base,
        object: 'chat.completion',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'Synthetic final response.' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );
  }
  res.writeHead(404);
  res.end('{}');
});
(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const { GraphologyStorage } = require(path.join(root, 'dist/storage/GraphologyStorage'));
  const storage = new GraphologyStorage(storeFile);
  await storage.initialize();
  assert.equal(await storage.getEpisodeCount(group), 0, 'Use a fresh synthetic store');
  const now = new Date().toISOString();
  const subject = await storage.addEntity({
    group_id: group,
    name: 'Synthetic native subject',
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
    actorReference: 'synthetic-actor',
    subjectId: subject.uuid,
    authorizedBy: 'synthetic-operator',
    reason: 'Synthetic native regression',
  });
  await storage.close();
  const extractionCredential = {
    id: 'syntheticExtraction017',
    name: 'Synthetic extraction',
    type: 'engramExtractionApi',
    data: { apiKey: 'synthetic-only', baseUrl: `${url}/extraction/v1` },
  };
  const agentCredential = {
    id: 'syntheticAgent017',
    name: 'Synthetic agent',
    type: 'openAiApi',
    data: { apiKey: 'synthetic-only', url: `${url}/agent/v1` },
  };
  const credentialsFile = path.join(work, 'credentials.json');
  fs.writeFileSync(credentialsFile, JSON.stringify([extractionCredential, agentCredential]), {
    mode: 0o600,
  });
  const automatic = {
    ...(autonomous ? { automaticPreferenceInterpreter: 'autonomousPersonalV1' } : {}),
    ...(configuredBudget
      ? {
          automaticExecutionBudgetMode: 'configuredV1',
        }
      : {}),
    ...(contextual ? { automaticStatementContextMode: 'contextQualifiedV1' } : {}),
    automaticCaptureLifecycle: 'replaySafeV2',
    automaticMemoryProfile: 'conservative',
    automaticIssuer: 'synthetic-app',
    automaticActor: 'synthetic-actor',
    automaticTurn: 'synthetic-event-017',
    automaticIntent: 'disabled',
    automaticWrapper: autonomous ? 'enabled' : 'disabled',
    ...(autonomous
      ? {
          automaticRawHuman: content,
          automaticRegionStart: displayPrefix.length,
          automaticRegionEnd: displayPrefix.length + content.length,
        }
      : {}),
  };
  const workflow = {
    id: workflowId,
    name: 'Synthetic native captured Memory proof',
    active: false,
    settings: { executionOrder: 'v1' },
    nodes: [
      node('Start', 'n8n-nodes-base.manualTrigger', 1, {}, [0, 0]),
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
          automaticInput: formattedContent,
          automaticExecution: 'synchronous',
          advancedExtractionPolicy: 'bounded',
          knowledgeSelection: 'durableTemporal',
          queueModel: 'synthetic-extraction',
          ...(autonomous
            ? {
                queueTemperatureMode: 'providerDefault',
                extractionRouteId: 'synthetic-native-autonomous-route',
              }
            : {}),
        },
        [200, 0],
        {
          credentials: {
            engramExtractionApi: { id: extractionCredential.id, name: extractionCredential.name },
          },
        },
      ),
      node(
        'Agent',
        '@n8n/n8n-nodes-langchain.agent',
        3.1,
        { promptType: 'define', text: formattedContent, options: {} },
        [450, 0],
      ),
      node(
        'Model',
        '@n8n/n8n-nodes-langchain.lmChatOpenAi',
        1.3,
        {
          model: { __rl: true, mode: 'id', value: 'synthetic-agent' },
          responsesApiEnabled: false,
          options: { temperature: 0, maxRetries: 0 },
        },
        [350, 220],
        { credentials: { openAiApi: { id: agentCredential.id, name: agentCredential.name } } },
      ),
      node(
        'Memory',
        'n8n-nodes-engram.engramMemory',
        3,
        {
          ...automatic,
          automaticCapturedSource: '={{ $("Capture").item.json.sourceId }}',
          backend: 'embedded',
          customStoragePath: storeDir,
          sessionIdType: 'customKey',
          sessionKey: group,
          enableExtraction: 'disabled',
          extractionModel: 'synthetic-extraction',
          ...(autonomous
            ? {
                extractionTemperatureMode: 'providerDefault',
                extractionRouteId: 'synthetic-native-autonomous-route',
              }
            : {}),
          advancedExtractionPolicy: 'bounded',
          knowledgeSelection: 'durableTemporal',
          extractionExecution: 'synchronous',
          enableEmbeddings: 'disabled',
          extractAi: 'disabled',
          extractSystemTool: 'disabled',
          historyFilter: 'provenance',
          messageWritePolicy: 'finalTurns',
          storeToolAudit: 'enabled',
          currentHumanQuery: content,
          contextWindowLength: 10,
        },
        [550, 220],
        {
          credentials: {
            engramExtractionApi: { id: extractionCredential.id, name: extractionCredential.name },
          },
        },
      ),
      node(
        'Recording stopped',
        'n8n-nodes-base.httpRequest',
        4.2,
        { method: 'POST', url: `${url}/stopped`, options: {} },
        [700, 160],
      ),
      node(
        'Recording outbound',
        'n8n-nodes-base.httpRequest',
        4.2,
        {
          method: 'POST',
          url: `${url}/outbound`,
          sendBody: true,
          specifyBody: 'json',
          jsonBody: '={{ { reply: $json.output } }}',
          options: {},
        },
        [700, 0],
      ),
    ],
    connections: {
      Start: { main: [[connect('Capture')]] },
      Capture: { main: [[connect('Agent')], [connect('Recording stopped')]] },
      Model: { ai_languageModel: [[connect('Agent', 'ai_languageModel')]] },
      Memory: { ai_memory: [[connect('Agent', 'ai_memory')]] },
      Agent: { main: [[connect('Recording outbound')]] },
    },
  };
  const workflowFile = path.join(work, 'workflow.json');
  fs.writeFileSync(workflowFile, JSON.stringify([workflow]));
  const creds = await command('import-credentials', [
    'import:credentials',
    `--input=${credentialsFile}`,
  ]);
  assert.equal(creds.code, 0);
  const imported = await command('import-workflow', ['import:workflow', `--input=${workflowFile}`]);
  assert.equal(imported.code, 0);
  const port = await freePort();
  const brokerPort = await freePort();
  const app = `http://127.0.0.1:${port}`;
  n8nLog = fs.createWriteStream(path.join(work, 'server.log'));
  n8nProcess = spawn(process.execPath, [cli, 'start'], {
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
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      ready =
        (await fetch(`${app}/healthz/readiness`)).ok && (await fetch(`${app}/rest/settings`)).ok;
    } catch {}
    if (ready) break;
    if (n8nProcess.exitCode !== null)
      throw new Error('Temporary n8n server exited; inspect server.log');
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.equal(ready, true);
  const owner = {
    email: 'synthetic017@example.invalid',
    firstName: 'Synthetic',
    lastName: 'Tester',
    password: 'Synthetic017!LocalOnly',
  };
  let auth = await fetch(`${app}/rest/owner/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(owner),
  });
  if (!auth.ok) {
    const problem = await auth.json();
    console.log(
      JSON.stringify({ stage: 'owner-setup', status: auth.status, message: problem.message }),
    );
    auth = await fetch(`${app}/rest/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emailOrLdapLoginId: owner.email, password: owner.password }),
    });
  }
  if (!auth.ok) {
    const problem = await auth.json();
    console.log(
      JSON.stringify({ stage: 'owner-login', status: auth.status, message: problem.message }),
    );
  }
  assert.equal(auth.ok, true, 'Synthetic owner authentication failed');
  const cookie = auth.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  assert.ok(cookie);
  async function execute(label) {
    const launched = await fetch(`${app}/rest/workflows/${workflowId}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ triggerToStartFrom: { name: 'Start' } }),
    });
    const launch = await launched.json();
    fs.writeFileSync(path.join(work, `${label}-launch.json`), JSON.stringify(launch, null, 2));
    assert.equal(launched.ok, true, `Launch failed; see ${label}-launch.json`);
    const executionId = launch.data.executionId;
    assert.ok(executionId);
    for (let attempt = 0; attempt < 240; attempt++) {
      const response = await fetch(`${app}/rest/executions/${executionId}`, {
        headers: { Cookie: cookie },
      });
      const result = await response.json();
      if (['success', 'error', 'canceled', 'crashed'].includes(result.data?.status)) {
        fs.writeFileSync(path.join(work, `${label}-result.json`), JSON.stringify(result, null, 2));
        console.log(JSON.stringify({ stage: label, status: result.data.status, executionId }));
        return result;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`Timed out waiting for ${label}`);
  }
  const first = await execute('first-execution');
  assert.equal(first.data.status, 'success');
  assert.equal(counts.outbound, 1);
  assert.equal(counts.extraction, autonomous ? 1 : 0);
  assert.equal(acceptedClaimsBeforeAgent, 1);
  const firstBytes = fs.readFileSync(storeFile);
  const firstGraph = JSON.parse(firstBytes);
  if (autonomous) {
    const humanOperation = firstGraph.automatic_operations_v1.operations.find(
      (operation) => operation.version === 4 && operation.identity.role === 'human',
    );
    assert.ok(humanOperation, 'A persisted native human operation is required');
    if (configuredBudget) {
      assert.deepEqual(
        humanOperation.descriptor.executionBudget,
        {
          semantics: 'configured',
          version: 1,
          completion: { mode: 'inheritOverall' },
          syntax: { mode: 'inheritOverall' },
          finalizationReserve: { mode: 'automatic' },
        },
        'The persisted operation must bind the configured budget policy',
      );
    } else assert.equal(Object.hasOwn(humanOperation.descriptor, 'executionBudget'), false);
  }

  const second = await execute('redelivery-execution');
  assert.equal(second.data.status, 'success');
  if (autonomous) {
    const replayCapture = readExecutionData(second, runtime).resultData.runData.Capture[0].data
      .main[1][0].json;
    assert.equal(replayCapture.status, 'replay');
    assert.equal(replayCapture.should_process, false);
    assert.equal(
      replayCapture.sourceId,
      firstGraph.episodes.find((episode) => episode.role === 'human').uuid,
    );
  } else assert.match(JSON.stringify(second), /committed_replay/);
  assert.equal(counts.stopped, 1);
  assert.equal(counts.outbound, 1);
  assert.equal(counts.model, 1);
  assert.equal(counts.extraction, autonomous ? 1 : 0);
  if (autonomous) {
    assert.equal(requestContainsGraph, true, 'The agent must receive actual graph context');
    const claim = firstGraph.edges.find((edge) => edge.attributes?.engram_claim_v1?.version === 3);
    assert.ok(claim, 'Accepted Claim3 must be persisted');
    assert.equal(claim.attributes.engram_extraction.review_status, 'accepted');
  }
  const secondGraph = JSON.parse(fs.readFileSync(storeFile));
  for (const field of ['entities', 'edges', 'episodes'])
    assert.deepEqual(secondGraph[field], firstGraph[field]);
  assert.equal(firstGraph.episodes.filter((e) => e.role === 'human').length, 1);
  assert.equal(firstGraph.episodes.filter((e) => e.role === 'ai').length, 1);
  assert.equal(
    firstGraph.automatic_operations_v1.operations.filter(
      (op) =>
        op.identity.role === 'assistant' &&
        op.state === 'committed' &&
        op.terminalReceipt.kind === 'assistant_final_saved',
    ).length,
    1,
  );
  if (autonomous) {
    const question = 'What are my preferences?';
    for (const entry of workflow.nodes) {
      if (entry.name === 'Capture' || entry.name === 'Memory') {
        entry.parameters.automaticTurn = 'synthetic-event-017-recall';
        entry.parameters.automaticMemoryProfile = 'explicit';
        entry.parameters.automaticRawHuman = question;
        entry.parameters.automaticRegionEnd = displayPrefix.length + question.length;
      }
      if (entry.name === 'Capture')
        entry.parameters.automaticInput = displayPrefix + question + displaySuffix;
      if (entry.name === 'Agent') entry.parameters.text = displayPrefix + question + displaySuffix;
      if (entry.name === 'Memory') {
        entry.parameters.currentHumanQuery = question;
        entry.parameters.contextWindowLength = 1;
      }
    }
    const changed = await fetch(`${app}/rest/workflows/${workflowId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        name: workflow.name,
        nodes: workflow.nodes,
        connections: workflow.connections,
        settings: workflow.settings,
      }),
    });
    assert.equal(changed.ok, true, 'Synthetic recall workflow update must succeed');
    const recalled = await execute('graph-only-recall');
    assert.equal(recalled.data.status, 'success');
    assert.equal(counts.extraction, 1, 'Recall must not re-extract the earlier preference');
    assert.equal(counts.model, 2);
    assert.equal(counts.outbound, 2);
    const claim = firstGraph.edges.find((edge) => edge.attributes?.engram_claim_v1?.version === 3);
    if (!contextual) {
      const meaning = claim.attributes.engram_claim_v1.meaning;
      assert.ok(meaning, 'The compound preference must retain verified structured meaning');
      const graphMessages = lastAgentMessages.filter(
        (message) =>
          message.role === 'system' &&
          String(message.content).includes('Relevant knowledge from memory:'),
      );
      assert.ok(
        graphMessages.some((message) => String(message.content).includes(JSON.stringify(meaning))),
        'Graph-only context must contain the complete persisted preference meaning',
      );
    } else {
      assert.equal(claim.attributes.engram_claim_v1.kind, 'source_statement_record');
      assert.equal(claim.attributes.engram_claim_v1.qualification, 'context_conditional_v1');
      assert.ok(
        lastAgentMessages.some(
          (message) =>
            message.role === 'system' &&
            String(message.content).includes('context-qualified') &&
            String(message.content).includes(content),
        ),
        'Graph-only recall must preserve qualified literal',
      );
    }
    for (const message of lastAgentMessages.filter((entry) => entry.role !== 'system')) {
      assert.ok(
        !String(message.content).includes('British English'),
        'Preference source must be outside recent conversation',
      );
      assert.ok(
        !String(message.content).includes('practical example before'),
        'Compound assertion must come from graph context',
      );
    }
    const recalledGraph = JSON.parse(fs.readFileSync(storeFile));
    for (const field of ['entities', 'edges'])
      assert.deepEqual(recalledGraph[field], firstGraph[field]);
    for (const episode of firstGraph.episodes)
      assert.deepEqual(
        recalledGraph.episodes.find((row) => row.uuid === episode.uuid),
        episode,
      );
    assert.equal(recalledGraph.episodes.filter((episode) => episode.role === 'human').length, 2);
    assert.equal(recalledGraph.episodes.filter((episode) => episode.role === 'ai').length, 2);
    graphOnlyRecall = true;
    if (configuredBudget) {
      // Ordinary Existing/Custom v3 writer: no Capture branch or captured-source ownership.
      const fallbackGroup = 'synthetic-native-fallback';
      const fallbackText = 'Hello';
      const fallbackNodes = workflow.nodes
        .filter((entry) => ['Start', 'Agent', 'Model', 'Memory'].includes(entry.name))
        .map((entry) => {
          const copy = { ...entry, parameters: { ...entry.parameters }, id: randomUUID() };
          if (entry.name === 'Agent')
            copy.parameters = { promptType: 'define', text: fallbackText, options: {} };
          if (entry.name === 'Memory') {
            copy.parameters = {
              backend: 'embedded',
              customStoragePath: storeDir,
              sessionIdType: 'customKey',
              sessionKey: fallbackGroup,
              automaticMemoryProfile: 'existing',
              automaticCaptureLifecycle: 'legacy',
              enableExtraction: 'disabled',
              enableEmbeddings: 'disabled',
              extractAi: 'disabled',
              extractSystemTool: 'disabled',
              historyFilter: 'provenance',
              messageWritePolicy: 'finalTurns',
              storeToolAudit: 'enabled',
              currentHumanQuery: fallbackText,
              contextWindowLength: 10,
            };
          }
          return copy;
        });
      assert.equal(fallbackNodes.length, 4);
      assert.equal(fallbackNodes.find((entry) => entry.name === 'Agent').typeVersion, 3.1);
      const fallbackConnections = {
        Start: { main: [[connect('Agent')]] },
        Model: { ai_languageModel: [[connect('Agent', 'ai_languageModel')]] },
        Memory: { ai_memory: [[connect('Agent', 'ai_memory')]] },
      };
      const fallbackChanged = await fetch(`${app}/rest/workflows/${workflowId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({
          name: workflow.name,
          nodes: fallbackNodes,
          connections: fallbackConnections,
          settings: workflow.settings,
        }),
      });
      assert.equal(fallbackChanged.ok, true, 'Synthetic fallback workflow update must succeed');
      const before = JSON.parse(fs.readFileSync(storeFile));
      const countsBefore = { ...counts };
      const fallback = await execute('fallback-agent');
      assert.equal(fallback.data.status, 'success');
      const fallbackRuns = readExecutionData(fallback, runtime).resultData.runData;
      assert.ok(fallbackRuns.Agent?.[0], 'Fallback AI Agent must run');
      assert.ok(fallbackRuns.Model?.[0], 'Fallback chat model must run');
      assert.equal(fallbackRuns.Capture, undefined, 'Fallback must not invoke Capture');
      assert.equal(counts.model, countsBefore.model + 1);
      assert.equal(counts.extraction, countsBefore.extraction);
      assert.equal(counts.outbound, countsBefore.outbound);
      assert.equal(counts.stopped, countsBefore.stopped);
      assert.ok(
        lastAgentMessages.some((message) => String(message.content).includes(fallbackText)),
        'Fallback agent must receive the current message',
      );
      const after = JSON.parse(fs.readFileSync(storeFile));
      const containsRow = (rows, row) =>
        rows.some((candidate) => isDeepStrictEqual(candidate, row));
      for (const field of ['entities', 'edges', 'episodes']) {
        for (const row of before[field]) {
          assert.ok(containsRow(after[field], row), `Original ${field} row changed`);
        }
      }
      assert.deepEqual(
        after.automatic_operations_v1,
        before.automatic_operations_v1,
        'Ledger unchanged',
      );
      assert.deepEqual(after.metadata, before.metadata, 'Storage epoch unchanged');
      assert.equal(after.version, before.version, 'Storage version unchanged');
      assert.ok(
        lastAgentMessages.every((message) => !String(message.content).includes('British')),
        'Other namespace memory must remain inaccessible',
      );
      const inGroup = (rows, id) => rows.filter((row) => row.group_id === id);
      assert.deepEqual(inGroup(after.entities, group), inGroup(before.entities, group));
      assert.deepEqual(inGroup(after.edges, group), inGroup(before.edges, group));
      assert.deepEqual(inGroup(after.episodes, group), inGroup(before.episodes, group));
      const fallbackEpisodes = inGroup(after.episodes, fallbackGroup);
      assert.equal(fallbackEpisodes.filter((episode) => episode.role === 'human').length, 1);
      assert.equal(fallbackEpisodes.filter((episode) => episode.role === 'ai').length, 1);
      assert.equal(fallbackEpisodes.length, 2);
      assert.ok(
        fallbackEpisodes.some((episode) => String(episode.content).includes(fallbackText)),
        'Fallback human turn must be saved',
      );
      assert.ok(
        fallbackEpisodes.some((episode) =>
          String(episode.content).includes('Synthetic final response.'),
        ),
        'Fallback final answer must be saved',
      );
      const acceptedClaims = (graph) =>
        graph.edges.filter(
          (edge) =>
            edge.attributes?.engram_claim_v1 &&
            edge.attributes?.engram_extraction?.review_status === 'accepted',
        );
      assert.equal(acceptedClaims(after).length, acceptedClaims(before).length);
      assert.ok(containsRow(after.edges, claim), 'Original accepted claim must remain');
      const humanOperations = (graph) =>
        graph.automatic_operations_v1.operations.filter(
          (operation) => operation.version === 4 && operation.identity.role === 'human',
        );
      assert.equal(humanOperations(after).length, humanOperations(before).length);
      fallbackCompatibilityVerified = true;
    }
  }
  const proof = {
    ...runtimeIdentity,
    workflowVersion: 3,
    agentVersion: 3.1,
    interpreter: autonomous ? 'autonomousPersonalV1' : 'literalV1',
    configuredBudget,
    contextual,
    counts,
    requestContainsGraph,
    acceptedClaimsBeforeAgent,
    graphOnlyRecall,
    fallbackCompatibilityVerified,
    crossExecutionStopped: true,
    originalRecordsUnchangedAfterRedelivery: true,
    storeSha256BeforeRedelivery: createHash('sha256').update(firstBytes).digest('hex'),
  };
  fs.writeFileSync(path.join(work, 'proof.json'), JSON.stringify(proof, null, 2));
  console.log(JSON.stringify(proof));
})()
  .catch((error) => {
    console.error(error.stack);
    process.exitCode = 1;
  })
  .finally(() => {
    server.close();
    if (n8nProcess && n8nProcess.exitCode === null) n8nProcess.kill('SIGTERM');
    n8nProcess?.once('exit', () => n8nLog?.end());
  });
