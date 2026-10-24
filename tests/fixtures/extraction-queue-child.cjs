// Fresh-process fault fixture. Synthetic state only; never used by the package runtime.
const fs = require('fs');
const path = require('path');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) =>
  module._compile(
    ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2019,
        esModuleInterop: true,
      },
      fileName: filename,
    }).outputText,
    filename,
  );
const root = path.resolve(__dirname, '../..');
const { createStorage } = require(path.join(root, 'src/storage/StorageFactory.ts'));
const { processExtractionJobs, prepareExtraction } = require(
  path.join(root, 'src/extraction/DurableExtraction.ts'),
);
const { QueueLimitsSchema } = require(path.join(root, 'src/schemas/index.ts'));
const { queueBinding } = require(path.join(root, 'src/extraction/DurableExtraction.ts'));
const config = JSON.parse(process.env.ENGRAM_FAULT_CONFIG);
const settings = {
  llm: {
    apiKey: 'synthetic-test',
    baseUrl: 'https://provider.test',
    model: 'fixed',
    temperature: { mode: 'providerDefault' },
  },
  policy: { mode: 'bounded', quality: 'durableTemporal' },
  types: ['person', 'concept'],
  threshold: { autoAcceptThreshold: 0.85, rejectBelowThreshold: 0.3 },
};
const storage = createStorage(config.storage);
const binding = queueBinding('fault-test', settings);
const checkpoint = async (point) => {
  process.send?.({ checkpoint: point });
  await new Promise((resolve) => process.once('message', resolve));
};
let insideCommit = false;
global.fetch = async (_url, request) => {
  if (config.phase === 'provider') await checkpoint('provider');
  const body = JSON.parse(request.body);
  const sources = JSON.parse(body.messages[1].content);
  const human = sources.find((source) => source.role === 'human');
  const evidence = [{ source_id: human.source_id, start: 0, end: human.content.length }];
  const result = {
    entities: [
      {
        id: 'a',
        name: 'Alder',
        entity_type: 'person',
        category: 'durable_fact',
        confidence: 0.99,
        evidence,
      },
      {
        id: 'c',
        name: 'Cobalt',
        entity_type: 'concept',
        category: 'preference',
        confidence: 0.99,
        evidence,
      },
    ],
    relationships: [
      {
        source_id: 'a',
        target_id: 'c',
        name: 'FAVORITE_COLOR',
        fact: 'Alder favorite color is cobalt',
        category: 'preference',
        confidence: 0.99,
        evidence,
      },
    ],
  };
  return new Response(
    JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }),
  );
};
(async () => {
  await storage.initialize();
  if (config.phase === 'before_append') await checkpoint('before_append');
  if (['before_append', 'after_append'].includes(config.phase)) {
    await storage.appendEpisodesWithExtraction(
      config.inputs,
      [0, 1],
      binding,
      QueueLimitsSchema.parse({}),
    );
    if (config.phase === 'after_append') await checkpoint('after_append');
  } else if (['claim', 'compete'].includes(config.phase)) {
    if (config.phase === 'compete') await checkpoint('ready');
    const result = await storage.extractionQueueCommand({
      action: 'claim',
      group_id: config.group,
      binding,
      lease_ms: 5000,
    });
    if (config.phase === 'claim') await checkpoint('claim');
    process.send?.({ claimed: result.job?.uuid ?? null });
  } else if (config.phase === 'stage') {
    const job = (
      await storage.extractionQueueCommand({
        action: 'claim',
        group_id: config.group,
        binding,
        lease_ms: 5000,
      })
    ).job;
    const snapshot = await storage.readExtractionSnapshot(config.group);
    const sources = job.sources.map((source) => {
      const episode = snapshot.episodes.find((ep) => ep.uuid === source.uuid);
      return { ...episode, episode_uuid: episode.uuid };
    });
    const plan = await prepareExtraction(storage, config.group, sources, settings);
    await storage.extractionQueueCommand({
      action: 'stage',
      group_id: config.group,
      job_uuid: job.uuid,
      token: job.lease_token,
      generation: job.generation,
      plan,
    });
    await checkpoint('stage');
  } else {
    const command = storage.extractionQueueCommand.bind(storage);
    storage.extractionQueueCommand = async (input) => {
      const request = input.action === 'claim' ? { ...input, lease_ms: 5000 } : input;
      if (input.action === 'commit') insideCommit = true;
      const result = await command(request);
      if (input.action === 'commit' && config.phase === 'after_commit')
        await checkpoint('after_commit');
      insideCommit = false;
      return result;
    };
    if (config.phase === 'before_commit') {
      if (config.storage.backend === 'embedded') {
        const rename = fs.promises.rename.bind(fs.promises);
        fs.promises.rename = async (from, to) => {
          if (insideCommit && to === config.storage.persistPath) await checkpoint('before_commit');
          return rename(from, to);
        };
      } else {
        const write = storage.writeExtractionDiff.bind(storage);
        storage.writeExtractionDiff = async (...args) => {
          await write(...args);
          if (insideCommit) await checkpoint('before_commit');
        };
      }
    }
    const result = await processExtractionJobs(storage, config.group, 'fault-test', settings, 1, {
      lease_ms: 5000,
      heartbeat_ms: 100,
    });
    process.send?.({ result });
  }
  await storage.close();
  process.send?.({ done: true });
})()
  .catch((error) => {
    process.send?.({ error: String(error.message) });
    process.exitCode = 1;
  })
  .finally(() => {
    process.disconnect?.();
  });
