// Proposed stage path: tests/unit/storage/RootGroupAnnotationContract.test.ts
// Contract: root group_id is a scoped-export annotation, NOT a per-row namespace. The failed
// grouped native-preservation probe stays red elsewhere; nothing here relabels or replaces it.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GraphologyStorage, EngramStorageLoadFailedError } from '../../../src/storage/GraphologyStorage';
import { parseLosslessAutomaticCaptureGraph } from '../../../src/storage/LosslessAutomaticCaptureGraph';
import { GraphDataSchema, type GraphData } from '../../../src/schemas';

const EXPORTED_AT = '2026-11-05T00:00:00.000Z';
const emptyGraph = (extra: Record<string, unknown>): Record<string, unknown> => ({
	version: '2.0',
	exported_at: EXPORTED_AT,
	entities: [],
	edges: [],
	episodes: [],
	...extra,
});
const snapshot = (value: unknown): string => JSON.stringify(value);

describe('Root group_id annotation contract (scoped export)', () => {
	let tempDir: string;
	const open: GraphologyStorage[] = [];

	const track = async (persistPath?: string): Promise<GraphologyStorage> => {
		const storage = new GraphologyStorage(persistPath);
		open.push(storage);
		await storage.initialize();
		return storage;
	};

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'root-group-contract-'));
	});

	afterEach(async () => {
		await Promise.all(open.splice(0).map((storage) => storage.close()));
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it('scoped export filters rows and sets root group_id; unowned import keeps row namespace and persists no root group_id', async () => {
		const source = await track();
		const inGroup = await source.addEntity({ name: 'Alpha', group_id: 'g', entity_type: 'person' });
		const other = await source.addEntity({ name: 'Beta', group_id: 'h', entity_type: 'person' });

		const exported = await source.exportGraph('g');
		expect(exported.group_id).toBe('g');
		expect(exported.entities.map((e) => e.uuid)).toEqual([inGroup.uuid]);
		expect(exported.entities.map((e) => e.uuid)).not.toContain(other.uuid);
		expect((await source.exportGraph()).group_id).toBeUndefined();

		const target = path.join(tempDir, 'fresh.json');
		const fresh = await track(target);
		await fresh.importGraph(JSON.parse(snapshot(exported)) as GraphData);
		await fresh.close();

		const persisted = JSON.parse(fs.readFileSync(target, 'utf-8')) as Record<string, unknown> & {
			entities: Array<{ uuid: string; group_id: string }>;
		};
		expect(Object.keys(persisted)).not.toContain('group_id');
		expect(persisted.entities.map((e) => [e.uuid, e.group_id])).toEqual([[inGroup.uuid, 'g']]);
	});

	it.each([[123], [null], [{ ns: 'g' }], [['g']], [true]])(
		'non-string root group_id %j fails GraphData and lossless parse; input unchanged',
		(bad) => {
			const input = emptyGraph({ group_id: bad });
			const before = snapshot(input);
			expect(GraphDataSchema.safeParse(input).success).toBe(false);
			expect(() => parseLosslessAutomaticCaptureGraph(input)).toThrow();
			expect(snapshot(input)).toBe(before);
		},
	);

	it('accepts empty-string root group_id as an annotation and does not rewrite row namespaces', async () => {
		const input = emptyGraph({ group_id: '' });
		const before = snapshot(input);
		expect(GraphDataSchema.parse(input).group_id).toBe('');
		expect(parseLosslessAutomaticCaptureGraph(input).group_id).toBe('');
		expect(snapshot(input)).toBe(before);

		const storage = await track();
		const row = await storage.addEntity({ name: 'Gamma', group_id: 'row-ns', entity_type: 'person' });
		const annotated = JSON.parse(snapshot(await storage.exportGraph('row-ns'))) as GraphData;
		const destination = await track();
		await destination.importGraph({ ...annotated, group_id: '' });
		expect((await destination.getEntity(row.uuid))?.group_id).toBe('row-ns');
		expect((await destination.getEntity(row.uuid))?.uuid).toBe(row.uuid);
	});

	it('known root group_id plus unknown root key fails lossless instead of silently dropping the unknown field', () => {
		const input = emptyGraph({ group_id: 'g', synthetic_unknown_root: { keep: true } });
		const before = snapshot(input);
		// Source error (LosslessAutomaticCaptureGraph.ts:219): plain Error, not a ZodError.
		expect(() => parseLosslessAutomaticCaptureGraph(input)).toThrow(
			'Engram automatic capture: record_normalization',
		);
		expect(snapshot(input)).toBe(before);
	});

	it('malformed JSON physical store fails initialize, leaves bytes unchanged and never acknowledges an empty store', async () => {
		const target = path.join(tempDir, 'broken.json');
		const source = '{"version":"2.0","group_id":"g","entities":[';
		fs.writeFileSync(target, source, 'utf-8');

		const storage = new GraphologyStorage(target);
		open.push(storage);
		await expect(storage.initialize()).rejects.toThrow('Failed to load or migrate embedded storage');
		await expect(storage.exportGraph()).rejects.toBeInstanceOf(EngramStorageLoadFailedError);
		await storage.close();

		expect(fs.readFileSync(target, 'utf-8')).toBe(source);
		expect(fs.existsSync(`${target}.lock`)).toBe(false);
	});
});
