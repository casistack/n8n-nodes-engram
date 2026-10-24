import { fork, type ChildProcess } from 'child_process';
import { mkdtemp, rm, utimes } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { setTimeout as delay } from 'timers/promises';
import { GraphologyStorage } from '../../src/storage/GraphologyStorage';
import { Neo4jStorage } from '../../src/storage/Neo4jStorage';
import type { IGraphStorage } from '../../src/storage/IGraphStorage';
import { QueueLimitsSchema } from '../../src/schemas';
import { queueBinding } from '../../src/extraction/DurableExtraction';
import { jobs } from '../../src/extraction/QueueState';
jest.setTimeout(30000);
const settings = {
  llm: {
    apiKey: 'synthetic-test',
    baseUrl: 'https://provider.test',
    model: 'fixed',
    temperature: { mode: 'providerDefault' as const },
  },
  policy: { mode: 'bounded' as const, quality: 'durableTemporal' as const },
  types: ['person', 'concept'],
  threshold: { autoAcceptThreshold: 0.85, rejectBelowThreshold: 0.3 },
};
const binding = queueBinding('fault-test', settings);
const fixture = join(__dirname, '../fixtures/extraction-queue-child.cjs');
function suite(name: string, neo4j = false) {
  describe(name, () => {
    let storage: IGraphStorage, dir: string, group: string, persistPath: string;
    let children: ChildProcess[] = [];
    const connection = () =>
      neo4j
        ? {
            backend: 'neo4j',
            uri: process.env.NEO4J_TEST_URI!,
            username: 'neo4j',
            password: process.env.NEO4J_TEST_PASSWORD ?? 'engram-local-test',
          }
        : { backend: 'embedded', persistPath };
    const create = () =>
      neo4j
        ? new Neo4jStorage(
            process.env.NEO4J_TEST_URI!,
            'neo4j',
            process.env.NEO4J_TEST_PASSWORD ?? 'engram-local-test',
          )
        : new GraphologyStorage(persistPath);
    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'engram-crash-'));
      persistPath = join(dir, 'memory.json');
      group = `crash-${randomUUID()}`;
      storage = create();
      await storage.initialize();
      children = [];
    });
    afterEach(async () => {
      for (const child of children)
        if (child.exitCode === null && child.signalCode === null) {
          const exited = new Promise((resolve) => child.once('exit', resolve));
          child.kill('SIGKILL');
          await exited;
        }
      if (!neo4j) await utimes(persistPath + '.lock', new Date(0), new Date(0)).catch(() => {});
      await storage.clearGroup(group, { allowQueued: true });
      await storage.close();
      await rm(dir, { recursive: true, force: true });
    });
    const inputs = () => [
      {
        group_id: group,
        content: 'Alder favorite color is cobalt.',
        role: 'human' as const,
        episode_kind: 'active_human' as const,
        trust_level: 'standard' as const,
        review_status: 'accepted' as const,
        idempotency_key: 'human',
        reference_time: '2026-10-24T12:00:00Z',
      },
      {
        group_id: group,
        content: 'Noted.',
        role: 'ai' as const,
        episode_kind: 'assistant_reply' as const,
        idempotency_key: 'assistant',
        reference_time: '2026-10-24T12:00:00Z',
      },
    ];
    async function enqueue() {
      await storage.appendEpisodesWithExtraction!(
        inputs(),
        [0, 1],
        binding,
        QueueLimitsSchema.parse({}),
      );
    }
    function start(phase: string) {
      const child = fork(fixture, [], {
        env: {
          ...process.env,
          ENGRAM_FAULT_CONFIG: JSON.stringify({
            phase,
            group,
            storage: connection(),
            inputs: inputs(),
          }),
        },
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      });
      children.push(child);
      return child;
    }
    async function reached(child: ChildProcess, point?: string): Promise<any> {
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          cleanup();
          reject(new Error(`Child checkpoint timeout: ${point ?? 'done'}`));
        }, 20000);
        const receive = (message: any) => {
          if (message.error) {
            cleanup();
            reject(new Error(message.error));
          } else if (point ? message.checkpoint === point : message.done) {
            cleanup();
            resolve(message);
          }
        };
        const exit = (code: number | null) => {
          cleanup();
          reject(new Error(`Child exited early: ${code}`));
        };
        const cleanup = () => {
          clearTimeout(timeout);
          child.off('message', receive);
          child.off('exit', exit);
        };
        child.on('message', receive);
        child.on('exit', exit);
      });
    }
    async function kill(child: ChildProcess) {
      const exit = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGKILL');
      await exit;
      if (!neo4j) await utimes(persistPath + '.lock', new Date(0), new Date(0)).catch(() => {});
    }
    async function complete() {
      const child = start('complete');
      await reached(child);
    }
    it('grants a single lease to two competing fresh OS processes', async () => {
      await enqueue();
      const workers = [start('compete'), start('compete')];
      await Promise.all(workers.map((child) => reached(child, 'ready')));
      const claims = workers.map(
        (child) =>
          new Promise<string | null>((resolve, reject) => {
            child.on('message', (message: any) => {
              if (message.error) reject(new Error(message.error));
              if ('claimed' in message) resolve(message.claimed);
            });
            child.once('exit', (code) => {
              if (code) reject(new Error(`Worker exit ${code}`));
            });
          }),
      );
      for (const worker of workers) worker.send({ proceed: true });
      const result = await Promise.all(claims);
      expect(result.filter(Boolean)).toHaveLength(1);
      const snapshot = await storage.readExtractionSnapshot!(group);
      expect(jobs(snapshot)).toHaveLength(1);
      expect(jobs(snapshot)[0].claims).toBe(1);
    });
    it.each(['before_append', 'after_append'])(
      'atomic enqueue survives process kill at %s',
      async (phase) => {
        const child = start(phase);
        await reached(child, phase);
        await kill(child);
        const fresh = create();
        await fresh.initialize();
        try {
          const snapshot = await fresh.readExtractionSnapshot!(group);
          expect(snapshot.episodes).toHaveLength(phase === 'before_append' ? 0 : 2);
          expect(jobs(snapshot)).toHaveLength(phase === 'before_append' ? 0 : 1);
        } finally {
          await fresh.close();
        }
      },
    );
    it.each(['claim', 'provider', 'stage', 'before_commit', 'after_commit'])(
      'recovers a fresh worker after kill at %s with one logical graph mutation',
      async (phase) => {
        await enqueue();
        const before = await storage.readExtractionSnapshot!(group);
        const sourceIds = before.episodes.map((ep) => ep.uuid).sort();
        const child = start(phase);
        await reached(child, phase);
        await kill(child);
        // Advance beyond the real 5s test lease; dead-file-lock staleness is separately simulated after SIGKILL.
        await delay(5100);
        await complete();
        const snapshot = await storage.readExtractionSnapshot!(group);
        expect(snapshot.episodes.map((ep) => ep.uuid).sort()).toEqual(sourceIds);
        expect(snapshot.entities).toHaveLength(2);
        expect(snapshot.edges).toHaveLength(1);
        expect(jobs(snapshot)).toHaveLength(1);
        expect(jobs(snapshot)[0].state).toBe('completed');
        for (const old of before.episodes) {
          const next = snapshot.episodes.find((ep) => ep.uuid === old.uuid)!;
          const withoutQueue = (ep: typeof old) => ({
            ...ep,
            attributes: Object.fromEntries(
              Object.entries(ep.attributes).filter(([key]) => key !== 'engram_extraction_queue_v1'),
            ),
          });
          expect(withoutQueue(next)).toEqual(withoutQueue(old));
        }
        const ids = snapshot.entities.map((entity) => entity.uuid).sort();
        await complete();
        expect(
          (await storage.readExtractionSnapshot!(group)).entities
            .map((entity) => entity.uuid)
            .sort(),
        ).toEqual(ids);
      },
    );
  });
}
suite('embedded fresh-process queue recovery');
if (process.env.NEO4J_TEST_URI) suite('Neo4j fresh-process queue recovery', true);
